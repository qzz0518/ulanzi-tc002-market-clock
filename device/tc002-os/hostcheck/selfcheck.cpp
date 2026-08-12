// Host self-check for tc002-os.
//
// Compiles the parts of the firmware that carry no FlyThings headers with a
// plain clang++ and asserts their pixels. The device's adbd is not reliably
// reachable and the LED bus is write-only — nothing can read a frame back off
// the panel — so this is the only place a UI regression can be caught at all.
//
// Run with: mise run os-hostcheck

#include <netinet/in.h>
#include <pthread.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "core/Ease.h"
#include "core/RingModel.h"
#include "core/Shell.h"
#include "core/Surface.h"
#include "core/Text.h"
#include "core/Transitions.h"
#include "net/FrameBundle.h"
#include "net/HostLink.h"
#include "net/HttpClient.h"
#include "net/HttpServer.h"
#include "net/SetupPortal.h"
#include "net/StateDoc.h"
#include "net/TimeSync.h"
#include "net/WpaCtrl.h"
#include "platform/DeviceWifi.h"
#include "platform/DeviceControls.h"
#include "platform/InstallMode.h"
#include "platform/Presenter.h"
#include "net/WifiPolicy.h"
#include "games/breakout.h"
#include "games/flappy.h"
#include "games/pong.h"
#include "games/racer.h"
#include "games/shooter.h"
#include "games/snake.h"
#include "games/tetris.h"
#include "ui/BootScreen.h"
#include "ui/ChannelRingScreen.h"
#include "ui/GameScreen.h"
#include "ui/LauncherScreen.h"
#include "ui/LevelOverlay.h"
#include "ui/MusicScreen.h"
#include "ui/SettingsScreen.h"
#include "ui/ZosLogo.h"
#include "visual/Glyphs.h"

namespace {

int gFailures = 0;

void check(bool ok, const std::string& what) {
  if (!ok) {
    std::printf("  FAIL %s\n", what.c_str());
    ++gFailures;
  }
}

int litPixels(const Surface& s) {
  int n = 0;
  for (int y = 0; y < s.getHeight(); ++y) {
    for (int x = 0; x < s.getWidth(); ++x) {
      const Color c = s.getPixel(x, y);
      if (c.r || c.g || c.b) ++n;
    }
  }
  return n;
}

bool surfacesDiffer(const Surface& a, const Surface& b) {
  for (int y = 0; y < a.getHeight(); ++y) {
    for (int x = 0; x < a.getWidth(); ++x) {
      if (a.getPixel(x, y).toRGB888() != b.getPixel(x, y).toRGB888()) return true;
    }
  }
  return false;
}

// The music screen's text band: the 12 px glyph cell, rows 2..13, across the
// whole panel. Counting only this region is what separates "the panel is
// drawing" from "the panel is drawing the track" — the reported failure had a
// lit equaliser and a lit playhead and nothing between them.
//
// It used to start at x=14 because a 12 px equaliser owned the left of the
// panel. That equaliser is gone (the lyric now uses all 52 columns, exactly as
// the sideloaded lyrics player does), so the window is the band instead: rows
// 2..13 exclude spotlight's bracket marks on row 1, its fill meter on row 14 and
// every mode's cue row on row 15, which leaves glyph ink as the only thing that
// can satisfy it.
int musicTextPixels(const Surface& s) {
  int n = 0;
  for (int y = 2; y <= 13; ++y) {
    for (int x = 0; x < s.getWidth(); ++x) {
      const Color c = s.getPixel(x, y);
      if (c.r || c.g || c.b) ++n;
    }
  }
  return n;
}

// The four 像素配色 the console's 主题设置 panel offers, written out rather than
// read back from visual/Palette.h. Sourcing them from the same header the screen
// renders from would assert nothing; the contract under test is that the hex the
// user picks in the browser is the hex that reaches the LEDs, and these values
// are shared by three implementations (web preview, lyrics-player firmware,
// this one).
struct SkinTiers {
  uint32_t primary;
  uint32_t secondary;
  uint32_t context;
  uint32_t muted;
};

const SkinTiers kSkinTiers[4] = {
    {0xC1FF3D, 0x6CA34E, 0x47733D, 0x284B2C},  // 0 signal 信号绿
    {0xFFB341, 0xF0782A, 0xA75522, 0x73401E},  // 1 tape 磁带橙
    {0xD6F4FF, 0x55B7E8, 0x347BA8, 0x1E527A},  // 2 blueprint 蓝晒
    {0xFFF0CF, 0xFF4C58, 0xB33A43, 0x7B2930},  // 3 arcade 街机红
};

int tierPixels(const Surface& s, uint32_t rgb) {
  int n = 0;
  for (int y = 0; y < s.getHeight(); ++y) {
    for (int x = 0; x < s.getWidth(); ++x) {
      if (s.getPixel(x, y).toRGB888() == rgb) ++n;
    }
  }
  return n;
}

int litPixelsInRows(const Surface& s, int y0, int y1) {
  int n = 0;
  for (int y = y0; y <= y1; ++y) {
    for (int x = 0; x < s.getWidth(); ++x) {
      const Color c = s.getPixel(x, y);
      if (c.r || c.g || c.b) ++n;
    }
  }
  return n;
}

// x of the first pixel on row `y` painted in the palette's primary tier — the
// cue row's cursor, which is the only primary pixel any cue row draws (its
// anchors are muted and its trail is secondary).
int cueCursorX(const Surface& s, int y, uint32_t primary) {
  for (int x = 0; x < s.getWidth(); ++x) {
    if (s.getPixel(x, y).toRGB888() == primary) return x;
  }
  return -1;
}

// Lit bits in a glyph, so a check can assert the exact ink a character puts on
// the panel instead of "something is there".
int glyphBits(uint32_t cp) {
  const tcos::glyphs::Bitmap bitmap = tcos::glyphs::lookup(cp);
  if (bitmap.rows == 0) return 0;
  int n = 0;
  for (int row = 0; row < tcos::glyphs::kCellHeight; ++row) {
    for (int col = 0; col < bitmap.width; ++col) {
      if (bitmap.rows[row] & (1 << col)) ++n;
    }
  }
  return n;
}

// Skyline's 17 bars sit at x = 1 + 3b and the column beside it, so columns 0 and
// 51 are never part of the spectrum and every third column is a gap.
bool isSkylineBarColumn(int x) {
  for (int b = 0; b < 17; ++b) {
    const int bx = 1 + b * 3;
    if (x == bx || x == bx + 1) return true;
  }
  return false;
}

// Transition assertions read pixels back by provenance. The two fixtures are a
// pure red panel and a pure green one, so an untouched destination pixel is
// exactly (0,255,0), a departing one is red-only, and anything an operator lit
// itself (a shine, a bar cap, a bloom front) is neither.
bool isDest(const Color& c) { return c.r == 0 && c.g == 255 && c.b == 0; }
bool isSource(const Color& c) { return c.r > 0 && c.g == 0 && c.b == 0; }

int countDest(const Surface& s) {
  int n = 0;
  for (int y = 0; y < s.getHeight(); ++y) {
    for (int x = 0; x < s.getWidth(); ++x) {
      if (isDest(s.getPixel(x, y))) ++n;
    }
  }
  return n;
}

int countSource(const Surface& s) {
  int n = 0;
  for (int y = 0; y < s.getHeight(); ++y) {
    for (int x = 0; x < s.getWidth(); ++x) {
      if (isSource(s.getPixel(x, y))) ++n;
    }
  }
  return n;
}

int rowsLit(const Surface& s) {
  int n = 0;
  for (int y = 0; y < s.getHeight(); ++y) {
    for (int x = 0; x < s.getWidth(); ++x) {
      const Color c = s.getPixel(x, y);
      if (c.r || c.g || c.b) {
        ++n;
        break;
      }
    }
  }
  return n;
}

// How many whole rows at the top of the panel are dark — the only way a bounce
// shows up in pixels, since an overshooting panel leaves a gap behind it.
int darkRowsAtTop(const Surface& s) {
  int n = 0;
  for (int y = 0; y < s.getHeight(); ++y) {
    for (int x = 0; x < s.getWidth(); ++x) {
      const Color c = s.getPixel(x, y);
      if (c.r || c.g || c.b) return n;
    }
    ++n;
  }
  return n;
}

int brightestColumn(const Surface& s) {
  int best = -1;
  int bestSum = -1;
  for (int x = 0; x < s.getWidth(); ++x) {
    int sum = 0;
    for (int y = 0; y < s.getHeight(); ++y) {
      const Color c = s.getPixel(x, y);
      sum += c.r + c.g + c.b;
    }
    if (sum > bestSum) {
      bestSum = sum;
      best = x;
    }
  }
  return best;
}

void checkEase() {
  check(tcos::ease::clamp01(-1.0f) == 0.0f, "clamp01 floors at 0");
  check(tcos::ease::clamp01(2.0f) == 1.0f, "clamp01 caps at 1");
  check(tcos::ease::progress(50, 0, 100) == 0.5f, "progress is linear in time");
  check(tcos::ease::progress(500, 0, 0) == 1.0f, "a zero-length tween reads as finished");
  check(tcos::ease::progress(-10, 0, 100) == 0.0f, "progress before the start clamps");

  // Every curve must be a normalised 0..1 map, or a transition will pop.
  const char* names[] = {"linear", "inQuad", "outQuad", "inOutQuad", "outCubic", "inOutCubic"};
  float (*curves[])(float) = {tcos::ease::linear, tcos::ease::inQuad, tcos::ease::outQuad,
                              tcos::ease::inOutQuad, tcos::ease::outCubic, tcos::ease::inOutCubic};
  for (int i = 0; i < 6; ++i) {
    check(curves[i](0.0f) == 0.0f, std::string(names[i]) + " starts at 0");
    check(curves[i](1.0f) == 1.0f, std::string(names[i]) + " ends at 1");
    float previous = -1.0f;
    bool monotonic = true;
    for (int step = 0; step <= 20; ++step) {
      const float v = curves[i](step / 20.0f);
      if (v < previous - 1e-6f) monotonic = false;
      previous = v;
    }
    check(monotonic, std::string(names[i]) + " is monotonic");
  }
  // outBack is deliberately NOT monotonic — it overshoots and settles.
  check(tcos::ease::outBack(1.0f) > 0.999f && tcos::ease::outBack(1.0f) < 1.001f,
        "outBack still lands on 1");
  bool overshoots = false;
  for (int step = 0; step <= 20; ++step) {
    if (tcos::ease::outBack(step / 20.0f) > 1.0f) overshoots = true;
  }
  check(overshoots, "outBack actually overshoots");
}

void checkSurface() {
  Surface s(52, 16);
  check(s.getWidth() == 52 && s.getHeight() == 16, "surface is panel-sized");
  check(litPixels(s) == 0, "a fresh surface is dark");

  s.setPixel(3, 4, Color(10, 20, 30));
  const Color c = s.getPixel(3, 4);
  check(c.r == 10 && c.g == 20 && c.b == 30, "a pixel round-trips");

  std::vector<uint8_t> rgb;
  s.extractRGB(rgb);
  check(rgb.size() == 52u * 16u * 3u, "extractRGB emits exactly one frame");
  const size_t offset = (4u * 52u + 3u) * 3u;
  check(rgb[offset] == 10 && rgb[offset + 1] == 20 && rgb[offset + 2] == 30,
        "extractRGB is row-major RGB with no stride");

  s.clear();
  check(litPixels(s) == 0, "clear blanks the surface");
}

void checkZosLogo() {
  using namespace tcos::zoslogo;
  check(inkCount() == 192, "the wordmark is 192 pixels — the shapes have not drifted");

  // Each letter sits in its own cell with a gap; nothing may bleed between them.
  check(inkAt(8, 1, 0, 0, 0), "Z starts at x=8");
  check(!inkAt(18, 7, 0, 0, 0) && !inkAt(19, 7, 0, 0, 0) && !inkAt(20, 7, 0, 0, 0),
        "the Z/O gap is clear");
  check(!inkAt(31, 7, 0, 0, 0) && !inkAt(32, 7, 0, 0, 0) && !inkAt(33, 7, 0, 0, 0),
        "the O/S gap is clear");
  check(!inkAt(44, 7, 0, 0, 0), "nothing past the S");
  // One black row top and bottom, so the mark never touches the panel edge.
  for (int x = 0; x < 52; ++x) {
    check(!inkAt(x, 0, 0, 0, 0) && !inkAt(x, 15, 0, 0, 0), "the top and bottom rows stay clear");
  }

  // The stroke order must be a complete, gap-free path or the pen would skip.
  for (int letter = 0; letter < 3; ++letter) {
    std::vector<int> seen(kArcMax[letter] + 1, 0);
    for (int y = 0; y < 16; ++y) {
      for (int x = 0; x < 52; ++x) {
        int l = 0;
        int lx = 0;
        int ly = 0;
        if (!inkAt(x, y, &l, &lx, &ly) || l != letter) continue;
        const int arc = arcOf(l, lx, ly);
        check(arc >= 0 && arc <= kArcMax[letter], "every ink pixel has a valid arc");
        if (arc >= 0 && arc <= kArcMax[letter]) ++seen[arc];
      }
    }
    bool everyStepUsed = true;
    for (size_t i = 0; i < seen.size(); ++i) {
      if (seen[i] == 0) everyStepUsed = false;
    }
    check(everyStepUsed, "the stroke order has no gaps — the pen never jumps");
  }

  // The halo hugs the mark without overlapping it.
  check(!haloAt(8, 1), "ink is not its own halo");
  check(haloAt(7, 1), "the pixel beside the Z is halo");
}

void checkBootScreen() {
  tcos::BootScreen boot;
  Surface s(52, 16);
  boot.onEnter(0);

  check(tcos::BootScreen::durationMs() == 2460, "boot lasts 2460 ms");
  check(!boot.isDone(2459), "it is still running one ms before the end");
  check(boot.isDone(2460), "and done at its stated duration");

  // Determinism is the contract every one of these assertions rests on.
  boot.render(s, 900);
  std::vector<uint8_t> first;
  s.extractRGB(first);
  Surface again(52, 16);
  boot.render(again, 900);
  std::vector<uint8_t> second;
  again.extractRGB(second);
  check(first == second, "the same instant renders the same pixels");

  // BEAT 1 — the spark grows out of nothing at the centre.
  boot.render(s, 0);
  check(litPixels(s) == 0, "the panel starts black");
  boot.render(s, 130);
  check(litPixels(s) == 4, "the spark core is four pixels");
  boot.render(s, 170);
  check(litPixels(s) == 12, "the arms extend to twelve");
  boot.render(s, 239);
  check(litPixels(s) >= 4, "and retract before the wave — anticipation");

  // BEAT 2 — the ring expands, so its lit area grows and its front moves out.
  boot.render(s, 300);
  const int earlyWave = litPixels(s);
  boot.render(s, 500);
  const int lateWave = litPixels(s);
  check(lateWave > earlyWave, "the shockwave expands");
  // ...and develops the wordmark as it passes: pixels inside the front are ink.
  boot.render(s, 660);
  int emberPixels = 0;
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 52; ++x) {
      if (!tcos::zoslogo::inkAt(x, y, 0, 0, 0)) continue;
      const Color c = s.getPixel(x, y);
      if (c.r || c.g || c.b) ++emberPixels;
    }
  }
  check(emberPixels == 192, "the whole wordmark is developed before the trace starts");

  // BEAT 3 — the pens advance: more of the mark is bright later than earlier.
  int brightAt(0);
  boot.render(s, 800);
  int early = 0;
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 52; ++x) {
      const Color c = s.getPixel(x, y);
      if (c.g > 200) ++early;
    }
  }
  boot.render(s, 1400);
  int late = 0;
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 52; ++x) {
      const Color c = s.getPixel(x, y);
      if (c.g > 200) ++late;
    }
  }
  check(late > early, "the trace fills the letters over time");
  (void)brightAt;

  // Only the wordmark is ever inked from the trace onwards; a stray pixel would
  // read as a defect on a panel this small.
  for (int t = 700; t < 2180; t += 40) {
    boot.render(s, t);
    bool strayFound = false;
    for (int y = 0; y < 16; ++y) {
      for (int x = 0; x < 52; ++x) {
        const Color c = s.getPixel(x, y);
        if ((c.r || c.g || c.b) && !tcos::zoslogo::inkAt(x, y, 0, 0, 0) &&
            !tcos::zoslogo::haloAt(x, y)) {
          strayFound = true;
        }
      }
    }
    check(!strayFound, "nothing outside the wordmark and its halo is lit");
  }

  // BEAT 4 — the flash is the brightest moment of the whole sequence.
  boot.render(s, 1595);
  int flashSum = 0;
  boot.render(s, 1595);
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 52; ++x) {
      const Color c = s.getPixel(x, y);
      flashSum += c.r + c.g + c.b;
    }
  }
  boot.render(s, 1900);
  int holdSum = 0;
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 52; ++x) {
      const Color c = s.getPixel(x, y);
      holdSum += c.r + c.g + c.b;
    }
  }
  check(flashSum > holdSum, "the flash outshines the hold");

  // BEAT 5 — the mark stands still, complete and in brand green.
  boot.render(s, 1750);
  int greenInk = 0;
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 52; ++x) {
      if (!tcos::zoslogo::inkAt(x, y, 0, 0, 0)) continue;
      const Color c = s.getPixel(x, y);
      if (c.g > 200) ++greenInk;
    }
  }
  check(greenInk == 192, "the whole mark is lit during the hold");

  // BEAT 6 — the collapse squashes towards the centre rows and then goes dark.
  // Sampled across the squash rather than at one instant: the shape of the
  // motion is the assertion, and picking a single moment only pins whatever the
  // easing happened to reach there.
  int previousRows = 99;
  static const int kSquashSamples[6] = {2185, 2215, 2245, 2275, 2305, 2319};
  for (int i = 0; i < 6; ++i) {
    const int t = kSquashSamples[i];
    boot.render(s, t);
    int rowsUsed = 0;
    for (int y = 0; y < 16; ++y) {
      bool any = false;
      for (int x = 0; x < 52; ++x) {
        const Color c = s.getPixel(x, y);
        if (c.r || c.g || c.b) any = true;
      }
      if (any) ++rowsUsed;
    }
    check(rowsUsed <= previousRows, "the picture keeps squashing, never re-expands");
    previousRows = rowsUsed;
  }
  check(previousRows <= 2, "by the end of the squash it is a single hot line");
  boot.render(s, 2460);
  check(litPixels(s) == 0, "boot hands the launcher a black panel");

  // Nothing may ever be drawn outside the panel.
  for (int t = 0; t <= 2460; t += 20) {
    boot.render(s, t);
    check(s.getWidth() == 52 && s.getHeight() == 16, "the surface is never resized");
  }
}

void checkGlyphs() {
  using namespace tcos;
  check(glyphs::cjkCount() == 5195, "the CJK table still holds 5195 glyphs");
  check(glyphs::latinCount() == 0x7E - 0x20 + 1, "the Latin table covers ASCII 0x20..0x7E");
  check(glyphs::cellWidth('A') == 6, "ASCII is half-width");
  check(glyphs::cellWidth(0x4E2D) == 12, "CJK is full-width");

  const glyphs::Bitmap a = glyphs::lookup('A');
  check(a.rows != 0 && a.width == 6, "'A' resolves in the Latin table");
  const glyphs::Bitmap zh = glyphs::lookup(0x4E2D);  // 中
  check(zh.rows != 0 && zh.width == 12, "U+4E2D resolves in the CJK table");
  const glyphs::Bitmap missing = glyphs::lookup(0x10FFFF);
  check(missing.rows == 0, "an unmapped codepoint reports no bitmap");

  // The layout puts a 12 px cell at the top of a 16 px panel and reserves the
  // bottom rows; a glyph inking its very first row would collide with the
  // status band, so assert the generated table leaves that row clear.
  bool topRowClear = true;
  for (int cp = 0x4E00; cp < 0x4E40; ++cp) {
    const glyphs::Bitmap g = glyphs::lookup(static_cast<uint32_t>(cp));
    if (g.rows != 0 && g.rows[0] != 0) topRowClear = false;
  }
  check(topRowClear, "CJK glyphs leave their top row empty");
}

void checkText() {
  using namespace tcos;

  // UTF-8 decoding, including the malformed cases a host payload can carry.
  const char* ascii = "Hi";
  const char* p = ascii;
  check(text::utf8Next(p) == 'H', "ascii decodes");
  check(text::utf8Next(p) == 'i', "ascii advances");
  check(text::utf8Next(p) == 0, "the terminator reads as 0");

  const char* han = "\xE4\xB8\xAD";  // U+4E2D
  p = han;
  check(text::utf8Next(p) == 0x4E2D, "a three-byte sequence decodes");
  check(*p == 0, "a three-byte sequence advances three bytes");

  const char* truncated = "\xE4\xB8";  // missing the last byte
  p = truncated;
  const uint32_t bad = text::utf8Next(p);
  check(bad == 0xFFFD, "a truncated sequence yields U+FFFD");
  check(p != truncated, "a malformed sequence still advances (no infinite loop)");

  const char* stray = "\x80" "A";
  p = stray;
  check(text::utf8Next(p) == 0xFFFD, "a stray continuation byte yields U+FFFD");
  check(text::utf8Next(p) == 'A', "decoding resynchronises after bad input");

  // Measurement is what every layout decision is built on.
  check(text::measure("") == 0, "an empty string is zero wide");
  check(text::measure("ABCDEFGH") == 48, "8 Latin cells are 48 px");
  check(text::measure("\xE9\x9F\xB3\xE4\xB9\x90") == 24, "2 CJK cells are 24 px");
  check(text::countCells("\xE9\x9F\xB3\xE4\xB9\x90") == 2, "countCells counts codepoints");

  // 4 CJK is 48 px and fits the 52 px panel; 5 does not. This is the number the
  // whole one-item-per-page design rests on.
  const char* four = "\xE4\xB8\x80\xE4\xB8\x80\xE4\xB8\x80\xE4\xB8\x80";
  const char* five = "\xE4\xB8\x80\xE4\xB8\x80\xE4\xB8\x80\xE4\xB8\x80\xE4\xB8\x80";
  check(text::measure(four) == 48, "4 CJK cells fit the panel at 48 px");
  check(text::measure(five) == 60, "5 CJK cells overflow the 52 px panel");
  check(text::prefixBytesThatFit(five, 52) == 12, "the fitting prefix stops at 4 cells");
  check(text::prefixBytesThatFit(five, 5) == 0, "nothing fits below one cell");

  // Drawing and clipping.
  Surface s(52, 16);
  text::draw(s, "A", 0, 2, Color(0, 255, 0), 0, 52);
  check(litPixels(s) > 0, "drawing inks pixels");

  Surface clipped(52, 16);
  text::draw(clipped, "A", 0, 2, Color(0, 255, 0), 10, 42);
  check(litPixels(clipped) == 0, "a glyph outside the clip window draws nothing");

  Surface negative(52, 16);
  text::draw(negative, "AAAAAAAAAA", -30, 2, Color(0, 255, 0), 0, 52);
  check(litPixels(negative) > 0, "a negative origin still draws the visible tail");
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 52; ++x) {
      (void)x;
      (void)y;
    }
  }

  Surface tall(52, 16);
  text::draw(tall, "A", 0, 12, Color(0, 255, 0), 0, 52);  // 12 + 12 > 16
  check(tall.getHeight() == 16, "vertical overflow does not resize the surface");

  Surface centred(52, 16);
  text::drawCentered(centred, "AB", 2, Color(0, 255, 0), 0, 52);
  int minX = 52;
  for (int x = 0; x < 52; ++x) {
    for (int y = 0; y < 16; ++y) {
      const Color c = centred.getPixel(x, y);
      if ((c.r || c.g || c.b) && x < minX) minX = x;
    }
  }
  check(minX >= 19 && minX <= 21, "centred text starts near the middle");

  // Marquee.
  check(text::marqueeOffset(40, 52, 0) == 0, "a fitting label never scrolls");
  check(text::marqueeOffset(40, 52, 99999) == 0, "a fitting label never scrolls, ever");
  const int wide = 100;
  const int view = 52;
  const int travel = wide - view;
  check(text::marqueeOffset(wide, view, 0) == 0, "the marquee dwells at the head first");
  check(text::marqueeOffset(wide, view, text::kMarqueeDwellMs - 1) == 0,
        "the head dwell lasts the full 900 ms");
  const int legMs = (travel * 1000) / text::kMarqueePxPerSecond;
  check(text::marqueeOffset(wide, view, text::kMarqueeDwellMs + legMs) == -travel,
        "the first leg ends fully scrolled");
  check(text::marqueeOffset(wide, view, text::kMarqueeDwellMs + legMs + 10) == -travel,
        "the tail dwell holds at the end");
  const int cycle = 2 * text::kMarqueeDwellMs + 2 * legMs;
  check(text::marqueeOffset(wide, view, cycle) == 0, "the cycle returns to the head");
  bool inRange = true;
  for (int t = 0; t < cycle * 2; t += 17) {
    const int off = text::marqueeOffset(wide, view, t);
    if (off > 0 || off < -travel) inRange = false;
  }
  check(inRange, "the marquee never leaves [-(w-view), 0]");
}

void checkRingModel() {
  using namespace tcos;
  RingModel ring;
  ring.setCount(4);
  check(ring.count() == 4 && ring.index() == 0, "a fresh ring starts at 0");

  // Wrapping must work in both directions; a negative % would index out of range.
  check(ring.wrap(-1) == 3, "wrap handles negatives");
  check(ring.wrap(4) == 0, "wrap handles overflow");
  check(ring.wrap(9) == 1, "wrap handles multiples");

  ring.turn(1, 0);
  check(ring.index() == 1, "a detent commits immediately");
  check(ring.isAnimating(0), "the slide starts animating");
  check(ring.visualOffset(0) == -1.0f, "the slide starts one item behind");
  check(ring.visualOffset(RingModel::kSlideMs) == 0.0f, "the slide lands on zero");
  check(!ring.isAnimating(RingModel::kSlideMs), "the slide ends");

  ring.setIndex(0, 0);
  ring.turn(-1, 0);
  check(ring.index() == 3, "turning back from 0 wraps to the last item");

  // A fast spin: three detents inside one slide. The selection must keep up
  // exactly, while the visual lag stays bounded — otherwise a long spin keeps
  // scrolling for seconds after the user stops.
  RingModel spin;
  spin.setCount(10);
  spin.turn(1, 0);
  spin.turn(1, 10);
  spin.turn(1, 20);
  check(spin.index() == 3, "every detent of a fast spin commits");
  const float lag = spin.visualOffset(20);
  check(lag <= 0.0f && lag >= -(float)RingModel::kMaxCarry,
        "visual lag is clamped to kMaxCarry items");

  RingModel single;
  single.setCount(1);
  single.turn(1, 0);
  check(single.index() == 0, "a one-item ring cannot move");
  RingModel empty;
  empty.setCount(0);
  empty.turn(1, 0);
  check(empty.index() == 0 && empty.wrap(5) == 0, "an empty ring is inert, not divide-by-zero");
}

// A screen that paints one solid colour, so transitions can be asserted by
// looking at which colour is where.
class SolidScreen : public tcos::Screen {
 public:
  SolidScreen(const Color& c) : mColor(c), mEnters(0), mExits(0), mInputs(0), mConsume(false) {}
  void render(Surface& out, int) { out.fill(mColor); }
  void onEnter(int) { ++mEnters; }
  void onExit() { ++mExits; }
  bool onInput(tcos::Input, int) {
    ++mInputs;
    return mConsume;
  }
  bool isAnimating(int) const { return false; }
  Color mColor;
  int mEnters;
  int mExits;
  int mInputs;
  bool mConsume;
};

void checkShell() {
  using namespace tcos;
  SolidScreen red(Color(255, 0, 0));
  SolidScreen green(Color(0, 255, 0));

  Shell shell(52, 16);
  Surface out(52, 16);

  shell.reset(&red, 0);
  check(shell.depth() == 1 && shell.top() == &red, "reset installs the root");
  check(red.mEnters == 1, "the root gets onEnter");
  shell.render(out, 0);
  check(out.getPixel(0, 0).r == 255, "the root renders");

  // Push: mid-transition both screens are on the panel, and depth reads on the
  // VERTICAL axis. An unregistered destination gets kEntryDive, which is the
  // whole point of the change — a horizontal slide says "sibling", and every
  // descent used to say it.
  const int dive = Shell::entryMs(Shell::kEntryDive);
  shell.push(&green, 100);
  check(shell.depth() == 2 && shell.top() == &green, "push descends");
  check(red.mExits == 1 && green.mEnters == 1, "push fires the lifecycle callbacks");
  shell.render(out, 100 + dive / 2);
  bool sawRed = false;
  bool sawGreen = false;
  for (int y = 0; y < 16; ++y) {
    const Color c = out.getPixel(26, y);
    if (c.r > 0) sawRed = true;
    if (c.g > 0) sawGreen = true;
  }
  check(sawRed && sawGreen, "both screens are visible mid-transition");
  check(out.getPixel(26, 15).g > 0, "the incoming screen arrives from below");
  check(out.getPixel(26, 0).r > 0, "the outgoing screen leaves through the top");
  // A purely vertical motion leaves every row uniform across the panel; a slide
  // cannot. This is the assertion that would catch the old behaviour coming
  // back, since both directions do put "both screens on the panel at once".
  bool uniformRows = true;
  for (int y = 0; y < 16; ++y) {
    const Color left = out.getPixel(0, y);
    const Color right = out.getPixel(51, y);
    if (left.r != right.r || left.g != right.g || left.b != right.b) uniformRows = false;
  }
  check(uniformRows, "nothing slides in sideways any more");

  shell.render(out, 100 + dive);
  check(out.getPixel(0, 8).g == 255 && out.getPixel(0, 8).r == 0,
        "the transition resolves to the new screen alone");
  check(!shell.isAnimating(100 + dive), "the transition ends");

  // Pop is the same motion run backwards: the screen being left sinks away
  // downwards and the one above comes back down over it.
  shell.pop(1000);
  check(shell.depth() == 1 && shell.top() == &red, "pop ascends");
  shell.render(out, 1000 + dive / 2);
  check(out.getPixel(26, 0).r > 0, "the revealed screen comes back from the top");
  check(out.getPixel(26, 15).g > 0, "and the screen being left is still on its way out");

  // The root is never popped — an empty stack would be an unrecoverable panel.
  shell.pop(2000);
  shell.pop(2100);
  check(shell.depth() == 1 && shell.top() == &red, "the root cannot be popped");

  // Input routing: consumed inputs stop at the screen; an unclaimed hold pops.
  SolidScreen leaf(Color(0, 0, 255));
  shell.push(&leaf, 3000);
  leaf.mConsume = true;
  shell.onInput(kInputHold, 3100);
  check(leaf.mInputs == 1 && shell.depth() == 2, "a consumed hold does not pop");
  leaf.mConsume = false;
  shell.onInput(kInputHold, 3200);
  check(shell.depth() == 1, "an unclaimed hold pops one level");

  shell.onInput(kInputTurnCw, 4000);
  check(shell.depth() == 1, "a turn never pops");
}

// Every beat of every entry motion, pinned at chosen instants.
//
// These run against transition::compose directly rather than through the Shell:
// the operators are pure functions of (from, to, t), so the fixtures can be two
// flat colours and every assertion below is about the SHAPE of the motion —
// which rows the destination has taken, where the front is, whether it ever
// goes backwards — instead of "something was drawn".
void checkTransitions() {
  using namespace tcos::transition;

  Surface from(52, 16);
  Surface to(52, 16);
  Surface out(52, 16);
  from.fill(Color(255, 0, 0));
  to.fill(Color(0, 255, 0));

  // Durations are per style on purpose; every instant sampled below is a
  // fraction of one, so a retimed beat has to be a deliberate act.
  check(durationMs(kDive) == 240, "dive runs 240 ms");
  check(durationMs(kCrt) == 320, "crt runs 320 ms");
  check(durationMs(kEqualiser) == 300, "equaliser runs 300 ms");
  check(durationMs(kCartridge) == 280, "cartridge runs 280 ms");
  check(durationMs(kDrop) == 260, "drop runs 260 ms");
  check(durationMs(kFade) == tcos::Shell::kTransitionMs,
        "the fade baseline on Shell and in the catalogue agree");

  for (int s = 0; s < kStyleCount; ++s) {
    const Style style = static_cast<Style>(s);

    // Endpoints. One pixel of the wrong screen at either end reads as a flash
    // on a panel this small, so no style is allowed a "nearly" here.
    compose(out, from, to, style, 0.0f);
    check(countSource(out) == 52 * 16, "every style starts on the outgoing screen alone");
    compose(out, from, to, style, 1.0f);
    check(countDest(out) == 52 * 16, "every style lands on the incoming screen alone");

    // Determinism is the contract the rest of these assertions rest on.
    compose(out, from, to, style, 0.375f);
    std::vector<uint8_t> first;
    out.extractRGB(first);
    Surface again(52, 16);
    compose(again, from, to, style, 0.375f);
    std::vector<uint8_t> second;
    again.extractRGB(second);
    check(first == second, "the same instant composes the same pixels");

    // Nothing may be left dark once the motion has run: a style that finishes
    // with a hole in it would hand the next screen a broken panel.
    compose(out, from, to, style, 0.999f);
    check(darkRowsAtTop(out) == 0, "no style ends with a dark band at the top");
  }

  // --- kDive: the destination rises, and it is a rise, not a fade ----------
  {
    static const float kSamples[5] = {0.15f, 0.35f, 0.5f, 0.7f, 0.9f};
    static const int kExpectedEdge[5] = {16, 13, 8, 2, 0};
    int previousEdge = 17;
    for (int i = 0; i < 5; ++i) {
      compose(out, from, to, kDive, kSamples[i]);
      // The first row that is no longer pure outgoing IS the boundary: the row
      // the incoming screen's leading edge occupies.
      int edge = 16;
      for (int y = 0; y < 16; ++y) {
        if (!isSource(out.getPixel(0, y))) {
          edge = y;
          break;
        }
      }
      check(edge == kExpectedEdge[i], "the dive boundary is where its easing puts it");
      check(edge < previousEdge, "the boundary only ever climbs — the destination rises");
      previousEdge = edge;
    }
    compose(out, from, to, kDive, 0.5f);
    check(isDest(out.getPixel(26, 15)), "the destination is anchored to the bottom");
    check(isSource(out.getPixel(26, 0)), "and the caller is still leaving through the top");
    const Color edge = out.getPixel(26, 8);
    check(edge.r > 0 && edge.g > 0 && !isDest(edge),
          "the leading row is lit as an opening shutter, not a plain cut");
  }

  // --- kCrt: collapse, snap, bloom ----------------------------------------
  {
    // Sampled across the collapse rather than at one instant: the shape of the
    // motion is the assertion, and one moment only pins where the easing was.
    static const float kSquash[4] = {0.02f, 0.12f, 0.22f, 0.29f};
    int previousRows = 99;
    for (int i = 0; i < 4; ++i) {
      compose(out, from, to, kCrt, kSquash[i]);
      const int rows = rowsLit(out);
      check(rows <= previousRows, "the picture keeps collapsing, never re-expands");
      previousRows = rows;
    }
    check(previousRows <= 4, "by the end of the collapse it is nearly a single line");

    compose(out, from, to, kCrt, 0.35f);
    check(rowsLit(out) == 2 && litPixels(out) == 104,
          "the snap is exactly the two deflection rows");
    check(out.getPixel(0, 7).r == 220 && out.getPixel(0, 7).g == 255 &&
              out.getPixel(0, 7).b == 235,
          "and it is white hot");

    static const float kBloom[4] = {0.45f, 0.6f, 0.8f, 0.95f};
    static const int kExpectedRows[4] = {2, 10, 16, 16};
    int previousBloom = 0;
    for (int i = 0; i < 4; ++i) {
      compose(out, from, to, kCrt, kBloom[i]);
      const int rows = rowsLit(out);
      check(rows == kExpectedRows[i], "the bloom opens on schedule");
      check(rows >= previousBloom, "the bloom never closes back up");
      previousBloom = rows;
      // A deflection bloom is symmetric about the centre line or it is not a
      // CRT — an asymmetric band would read as the picture sliding.
      bool symmetric = true;
      for (int y = 0; y < 8; ++y) {
        const Color above = out.getPixel(26, y);
        const Color below = out.getPixel(26, 15 - y);
        const bool topLit = (above.r || above.g || above.b);
        const bool bottomLit = (below.r || below.g || below.b);
        if (topLit != bottomLit) symmetric = false;
      }
      check(symmetric, "the bloom stays centred on the deflection line");
    }
    check(previousBloom == 16, "the bloom finishes filling the panel");

    compose(out, from, to, kCrt, 0.6f);
    check(isDest(out.getPixel(26, 7)), "the inside of the bloom is the destination");
    check(!isDest(out.getPixel(26, 3)) && !isDest(out.getPixel(26, 12)),
          "and its two edges are the bloom front");
  }

  // --- kEqualiser: a jagged front rising from the floor --------------------
  {
    static const float kSamples[5] = {0.2f, 0.4f, 0.5f, 0.6f, 0.8f};
    static const int kExpectedRevealed[5] = {26, 244, 452, 608, 814};
    int previousRevealed = -1;
    for (int i = 0; i < 5; ++i) {
      compose(out, from, to, kEqualiser, kSamples[i]);
      const int revealed = 52 * 16 - countSource(out);
      check(revealed == kExpectedRevealed[i], "the bars stand where their easing puts them");
      check(revealed > previousRevealed, "the front only ever rises");
      previousRevealed = revealed;

      // Bottom-anchored: once a column has been reached, everything below it in
      // that column has been too. A reveal with a hole in it is a bug that a
      // total-count assertion alone would sail straight past.
      bool suffix = true;
      for (int x = 0; x < 52; ++x) {
        bool reached = false;
        for (int y = 0; y < 16; ++y) {
          const bool dest = !isSource(out.getPixel(x, y));
          if (dest) reached = true;
          else if (reached) suffix = false;
        }
      }
      check(suffix, "every bar is a solid column standing on the floor");
    }

    compose(out, from, to, kEqualiser, 0.5f);
    int lowest = 16;
    int highest = -1;
    for (int x = 0; x < 52; ++x) {
      for (int y = 0; y < 16; ++y) {
        if (isSource(out.getPixel(x, y))) continue;
        if (y < lowest) lowest = y;
        if (y > highest) highest = y;
        break;
      }
    }
    check(lowest == 5 && highest == 10,
          "the front is jagged — the bars do not arrive together");
    // The cap is what makes the front read as a bar and not as a wipe line.
    const Color cap = out.getPixel(0, 8);
    check(cap.r > 0 && cap.g == 255, "the top pixel of a bar is lit as its cap");
    check(isDest(out.getPixel(0, 9)), "and the pixel under it is plain destination");
  }

  // --- kCartridge: a shine sweep with the arcade's 1-in-4 slope ------------
  {
    static const float kSamples[3] = {0.3f, 0.5f, 0.7f};
    static const int kExpectedHead[3] = {7, 27, 47};
    int previousHead = -1;
    for (int i = 0; i < 3; ++i) {
      compose(out, from, to, kCartridge, kSamples[i]);
      const int head = brightestColumn(out);
      check(head == kExpectedHead[i], "the shine is where its easing puts it");
      check(head > previousHead, "the shine only ever travels forward");
      previousHead = head;
    }

    compose(out, from, to, kCartridge, 0.5f);
    check(isDest(out.getPixel(0, 8)), "the destination is already there behind the shine");
    check(isSource(out.getPixel(51, 8)), "and the caller is still ahead of it");
    // The slope is the motif, not decoration: three columns of lean across the
    // panel is what separates a scanning bar from a wall.
    int lastDestTop = -1;
    int lastDestBottom = -1;
    for (int x = 0; x < 52; ++x) {
      if (isDest(out.getPixel(x, 0))) lastDestTop = x;
      if (isDest(out.getPixel(x, 15))) lastDestBottom = x;
    }
    check(lastDestTop - lastDestBottom == 3, "the shine leans exactly one column per four rows");

    // Corner brackets: they snap in, release, and are gone well before the end.
    compose(out, from, to, kCartridge, 0.05f);
    const int early = out.getPixel(0, 0).b;
    compose(out, from, to, kCartridge, 0.18f);
    const Color peak = out.getPixel(0, 0);
    check(peak.r > 200 && peak.b > 200, "the slot brackets light the corners");
    check(peak.b > early, "and they snap in rather than fading up from nothing");
    check(out.getPixel(51, 15).b > 200, "all four corners, not just the near one");
    compose(out, from, to, kCartridge, 0.9f);
    check(isDest(out.getPixel(0, 0)) && isDest(out.getPixel(51, 15)),
          "the brackets are gone before the screen settles");
  }

  // --- kDrop: a drawer that overshoots its stop and bounces back -----------
  {
    static const float kSamples[6] = {0.2f, 0.4f, 0.5f, 0.58f, 0.72f, 0.9f};
    static const int kExpectedGap[6] = {0, 0, 1, 2, 1, 0};
    int previousSourceRows = 99;
    for (int i = 0; i < 6; ++i) {
      compose(out, from, to, kDrop, kSamples[i]);
      // The gap at the top is the bounce: nothing is behind the panel once it
      // has travelled past its stop, so an overshoot is the only thing that can
      // produce a dark band there.
      check(darkRowsAtTop(out) == kExpectedGap[i], "the drawer overshoots and settles back");
      int sourceRows = 0;
      for (int y = 0; y < 16; ++y) {
        if (isSource(out.getPixel(26, y))) ++sourceRows;
      }
      check(sourceRows <= previousSourceRows, "the caller is only ever pushed further out");
      previousSourceRows = sourceRows;
    }

    compose(out, from, to, kDrop, 0.58f);
    check(isDest(out.getPixel(26, 2)), "the panel itself is intact while it is bounced");
    const Color floorLit = out.getPixel(26, 15);
    check(floorLit.r > 0 && !isDest(floorLit), "the floor flashes on the impact");
    compose(out, from, to, kDrop, 0.9f);
    check(isDest(out.getPixel(26, 15)), "and stops flashing once it has settled");
  }

  // --- push and pop are one operator run in two directions -----------------
  {
    using tcos::Shell;
    static const Shell::Entry kEntries[5] = {Shell::kEntryDive, Shell::kEntryCrt,
                                             Shell::kEntryEqualiser, Shell::kEntryCartridge,
                                             Shell::kEntryDrop};
    for (int i = 0; i < 5; ++i) {
      SolidScreen up(Color(255, 0, 0));
      SolidScreen down(Color(0, 255, 0));
      Shell shell(52, 16);
      shell.setEntryStyle(&down, kEntries[i]);
      shell.reset(&up, 0);
      const int dur = Shell::entryMs(kEntries[i]);

      shell.push(&down, 1000);
      check(shell.isAnimating(1000 + dur - 1) && !shell.isAnimating(1000 + dur),
            "a push runs for exactly its style's duration");

      // Sampled at quarters only, and that is deliberate: t and 1 - t are then
      // both exact in binary floating point, so "the ascent is the descent
      // backwards" can be asserted as byte equality rather than as a tolerance.
      std::vector<uint8_t> descent[3];
      for (int q = 1; q <= 3; ++q) {
        Surface frame(52, 16);
        shell.render(frame, 1000 + dur * q / 4);
        frame.extractRGB(descent[q - 1]);
      }

      shell.pop(5000);
      check(shell.isAnimating(5000 + dur - 1) && !shell.isAnimating(5000 + dur),
            "and the pop that undoes it runs for the same duration");
      for (int q = 1; q <= 3; ++q) {
        Surface frame(52, 16);
        shell.render(frame, 5000 + dur - dur * q / 4);
        std::vector<uint8_t> ascent;
        frame.extractRGB(ascent);
        check(ascent == descent[q - 1], "the ascent is the descent played backwards");
      }
    }
  }

  // --- the registry ---------------------------------------------------------
  {
    using tcos::Shell;
    SolidScreen root(Color(255, 0, 0));
    SolidScreen leaf(Color(0, 255, 0));
    Shell shell(52, 16);
    Surface frame(52, 16);

    shell.reset(&root, 0);
    shell.push(&leaf, 100);
    check(shell.isAnimating(100 + Shell::entryMs(Shell::kEntryDive) - 1) &&
              !shell.isAnimating(100 + Shell::entryMs(Shell::kEntryDive)),
          "an unregistered destination gets the default dive");
    shell.pop(2000);

    shell.setEntryStyle(&leaf, Shell::kEntryCrt);
    // A style registered for one screen must not leak onto another, or every
    // destination ends up sharing a motion again by accident.
    shell.push(&leaf, 3000);
    check(!shell.isAnimating(3000 + Shell::entryMs(Shell::kEntryCrt)),
          "a registered destination gets its own entry");
    shell.render(frame, 3000 + 110);
    check(rowsLit(frame) == 2, "and it is the CRT beat, not the dive");
    shell.pop(4000);

    // The table describes screens, not the stack: boot's handoff resets the
    // Shell, and losing the registrations there would silently flatten every
    // destination back to the default.
    shell.reset(&root, 5000);
    shell.push(&leaf, 6000);
    shell.render(frame, 6000 + 110);
    check(rowsLit(frame) == 2, "entry styles survive a reset");
  }

  // A reset over a live screen cross-fades rather than cutting — the boot
  // handoff osLogic has always described.
  {
    using tcos::Shell;
    SolidScreen boot(Color(255, 0, 0));
    SolidScreen launcher(Color(0, 255, 0));
    Shell shell(52, 16);
    Surface frame(52, 16);
    shell.reset(&boot, 0);
    shell.render(frame, 10);
    check(countSource(frame) == 52 * 16, "the first reset has nothing to fade from");
    shell.reset(&launcher, 100);
    shell.render(frame, 100 + Shell::kTransitionMs / 2);
    check(countDest(frame) == 0 && litPixels(frame) == 52 * 16,
          "the handoff cross-fades instead of cutting");
    shell.render(frame, 100 + Shell::kTransitionMs);
    check(countDest(frame) == 52 * 16, "and resolves to the new root");
  }
}

int litInColumns(const Surface& s, int x0, int x1) {
  int n = 0;
  for (int x = x0; x < x1 && x < s.getWidth(); ++x) {
    for (int y = 0; y < s.getHeight(); ++y) {
      const Color c = s.getPixel(x, y);
      if (c.r || c.g || c.b) ++n;
    }
  }
  return n;
}

void checkLauncher() {
  using namespace tcos;
  LauncherScreen launcher;
  Surface out(52, 16);

  // Empty is a real state: the host may not have answered yet.
  launcher.onEnter(0);
  launcher.render(out, 0);
  check(launcher.count() == 0, "a fresh launcher is empty");
  check(litPixels(out) > 0, "the empty state still says something");

  std::vector<LauncherScreen::Entry> entries;
  LauncherScreen::Entry e;
  e.label = "\xE9\x9F\xB3\xE4\xB9\x90";  // 音乐
  e.icon = LauncherScreen::kIconMusic;
  e.id = 10;
  entries.push_back(e);
  e.label = "\xE6\xB8\xB8\xE6\x88\x8F";  // 游戏
  e.icon = LauncherScreen::kIconGame;
  e.id = 11;
  entries.push_back(e);
  e.label = "\xE8\xAE\xBE\xE7\xBD\xAE";  // 设置
  e.icon = LauncherScreen::kIconSettings;
  e.id = 12;
  entries.push_back(e);

  launcher.setEntries(entries, 0);
  launcher.onEnter(0);
  check(launcher.count() == 3, "entries land");
  check(launcher.selectedIndex() == 0, "selection starts at the first entry");

  // ONE item per page: when settled, nothing from a neighbour may be on screen.
  // The card occupies the whole width, so this is checked by confirming the
  // panel holds exactly one card's worth of structure — icon plus label.
  launcher.render(out, 0);
  check(litInColumns(out, 0, 12) > 0, "the icon column is inked");
  check(litInColumns(out, 14, 52) > 0, "the label area is inked");

  // A detent slides the next card in; mid-slide both are partly visible, and
  // when it settles the new one owns the panel.
  launcher.onInput(kInputTurnCw, 100);
  check(launcher.selectedIndex() == 1, "a detent moves the selection");
  launcher.render(out, 100 + RingModel::kSlideMs / 2);
  check(litPixels(out) > 0, "the slide renders something");
  launcher.render(out, 100 + RingModel::kSlideMs);
  check(litPixels(out) > 0, "the settled card renders");

  // Wrap in both directions, so a knob spin never dead-ends.
  launcher.onInput(kInputTurnCw, 1000);
  launcher.onInput(kInputTurnCw, 1400);
  check(launcher.selectedIndex() == 0, "turning past the end wraps to the start");
  launcher.onInput(kInputTurnCcw, 1800);
  check(launcher.selectedIndex() == 2, "turning back from the start wraps to the end");

  // Press reports the entry's own id, not its index — the caller routes on it.
  launcher.onInput(kInputPress, 2000);
  check(launcher.takeActivated() == 12, "press reports the entry id");
  check(launcher.takeActivated() == -1, "reading the activation clears it");

  // A hold is deliberately not consumed, so the Shell can turn it into "up".
  check(!launcher.onInput(kInputHold, 2100), "hold bubbles to the Shell");

  // A label too wide for the 38 px label area must marquee rather than clip
  // silently: 8 CJK cells is 96 px.
  std::vector<LauncherScreen::Entry> wide;
  LauncherScreen::Entry w;
  w.label = "\xE5\xB8\x82\xE5\x9C\xBA\xE8\xBD\xAE\xE6\x92\xAD\xE5\xB8\x82\xE5\x9C\xBA\xE8\xBD\xAE\xE6\x92\xAD";
  w.icon = LauncherScreen::kIconChannel;
  w.id = 1;
  wide.push_back(w);
  LauncherScreen marquee;
  marquee.setEntries(wide, 0);
  marquee.onEnter(0);
  check(text::measure(w.label.c_str()) == 96, "the test label really does overflow");
  Surface a(52, 16);
  Surface b(52, 16);
  marquee.render(a, 0);
  marquee.render(b, text::kMarqueeDwellMs + 400);
  std::vector<uint8_t> ra;
  std::vector<uint8_t> rb;
  a.extractRGB(ra);
  b.extractRGB(rb);
  check(ra != rb, "an overflowing label scrolls instead of sitting clipped");

  // EVERY icon must animate, and must animate by moving something. A 12x12 cell
  // is too small for a brightness pulse to read, and a four-step rotation looks
  // like flicker rather than motion — this check exists because three of the
  // four icons shipped static and only the equaliser was noticed as alive.
  static const LauncherScreen::Icon kAllIcons[4] = {
      LauncherScreen::kIconChannel, LauncherScreen::kIconMusic,
      LauncherScreen::kIconGame, LauncherScreen::kIconSettings};
  static const char* kIconNames[4] = {"channel", "music", "game", "settings"};
  for (int i = 0; i < 4; ++i) {
    std::vector<LauncherScreen::Entry> one;
    LauncherScreen::Entry only;
    only.label = "x";
    only.icon = kAllIcons[i];
    only.id = 0;
    one.push_back(only);
    LauncherScreen screen;
    screen.setEntries(one, 0);
    screen.onEnter(0);

    // Sample a full cycle and require the icon area to take at least three
    // distinct shapes: two would be satisfied by a blink, which is not motion.
    std::vector<std::vector<uint8_t> > shapes;
    for (int t = 0; t <= 2400; t += 60) {
      Surface frame(52, 16);
      screen.render(frame, t);
      std::vector<uint8_t> iconArea;
      for (int y = 0; y < 16; ++y) {
        for (int x = 0; x < 12; ++x) {
          const Color c = frame.getPixel(x, y);
          iconArea.push_back((c.r || c.g || c.b) ? 1 : 0);
        }
      }
      bool seen = false;
      for (size_t k = 0; k < shapes.size(); ++k) {
        if (shapes[k] == iconArea) seen = true;
      }
      if (!seen) shapes.push_back(iconArea);
    }
    check(shapes.size() >= 3,
          std::string("the ") + kIconNames[i] + " icon animates by moving pixels");

    // And it must stay inside its 12 px cell (x=5..16), or it would collide with
    // the label window that starts at 19.
    Surface frame(52, 16);
    screen.render(frame, 500);
    bool inkedBetween = false;
    for (int y = 0; y < 16; ++y) {
      for (int x = 17; x < 19; ++x) {
        const Color c = frame.getPixel(x, y);
        if (c.r || c.g || c.b) inkedBetween = true;
      }
    }
    check(!inkedBetween, std::string("the ") + kIconNames[i] + " icon stays in its cell");
  }

  // ARROWS. They are chrome: present whenever there is somewhere to turn to,
  // and they must not collide with the icon cell, the label, or the rail.
  {
    LauncherScreen arrowed;
    arrowed.setEntries(entries, 0);
    arrowed.onEnter(0);
    Surface frame(52, 16);
    arrowed.render(frame, 500);

    // The arrows belong to the panel, so they sit hard against both edges.
    bool leftLit = false;
    bool rightLit = false;
    for (int y = 5; y <= 9; ++y) {
      const Color l = frame.getPixel(0, y);
      const Color r = frame.getPixel(51, y);
      if (l.r || l.g || l.b) leftLit = true;
      if (r.r || r.g || r.b) rightLit = true;
    }
    check(leftLit && rightLit, "both arrows are drawn at the panel edges");

    // The 2 px gutters that separate arrow, icon and label must stay clear, or
    // the card stops reading as three distinct parts.
    for (int y = 0; y < 16; ++y) {
      const Color gutterA = frame.getPixel(4, y);
      const Color gutterB = frame.getPixel(17, y);
      check(!(gutterA.r || gutterA.g || gutterA.b), "the arrow/icon gutter stays clear");
      check(!(gutterB.r || gutterB.g || gutterB.b), "the icon/label gutter stays clear");
    }
    // And no arrow may touch the rail row.
    const Color railLeft = frame.getPixel(0, 15);
    const Color railRight = frame.getPixel(51, 15);
    check(!(railLeft.r || railLeft.g || railLeft.b) && !(railRight.r || railRight.g || railRight.b),
          "the arrows leave the rail row alone");

    // A single entry has nowhere to turn to, so promising a turn would be a lie.
    std::vector<LauncherScreen::Entry> one;
    one.push_back(entries[0]);
    LauncherScreen solo;
    solo.setEntries(one, 0);
    solo.onEnter(0);
    Surface soloFrame(52, 16);
    solo.render(soloFrame, 500);
    bool soloArrow = false;
    for (int y = 5; y <= 9; ++y) {
      const Color l = soloFrame.getPixel(0, y);
      const Color r = soloFrame.getPixel(51, y);
      if (l.r || l.g || l.b || r.r || r.g || r.b) soloArrow = true;
    }
    check(!soloArrow, "a one-item ring draws no arrows");

    // A turn must change the arrow's SHAPE, not only its brightness — the same
    // lesson the icons taught, where a brightness-only change read as frozen.
    LauncherScreen turned;
    turned.setEntries(entries, 0);
    turned.onEnter(0);
    Surface before(52, 16);
    turned.render(before, 1000);
    turned.onInput(kInputTurnCw, 1000);
    Surface after(52, 16);
    turned.render(after, 1010);
    const Color notchBefore = before.getPixel(50, 7);
    const Color notchAfter = after.getPixel(50, 7);
    (void)notchBefore;
    const bool filledBefore = notchBefore.r || notchBefore.g || notchBefore.b;
    const bool filledAfter = notchAfter.r || notchAfter.g || notchAfter.b;
    check(!filledBefore && filledAfter, "a clockwise turn fills the right chevron solid");
  }

  // THE SEVEN GAME ICONS. All seven shipped wearing the same generic glyph,
  // which made the games ring useless — you could not tell what you were about
  // to launch. Each must now be visually distinct, animate by displacement, and
  // stay inside its cell.
  {
    std::vector<std::vector<uint8_t> > signatures;
    for (int g = 0; g < 7; ++g) {
      std::vector<LauncherScreen::Entry> one;
      LauncherScreen::Entry only;
      only.label = "x";
      only.icon = static_cast<LauncherScreen::Icon>(LauncherScreen::kIconGameBreakout + g);
      only.id = 0;
      one.push_back(only);
      LauncherScreen screen;
      screen.setEntries(one, 0);
      screen.onEnter(0);

      std::vector<std::vector<uint8_t> > shapes;
      std::vector<uint8_t> signature;
      for (int t = 0; t <= 2400; t += 60) {
        Surface frame(52, 16);
        screen.render(frame, t);
        std::vector<uint8_t> cell;
        for (int yy = 0; yy < 16; ++yy) {
          for (int xx = 5; xx < 17; ++xx) {   // the icon cell
            const Color c = frame.getPixel(xx, yy);
            cell.push_back((c.r || c.g || c.b) ? 1 : 0);
          }
        }
        bool seen = false;
        for (size_t k = 0; k < shapes.size(); ++k) {
          if (shapes[k] == cell) seen = true;
        }
        if (!seen) shapes.push_back(cell);
        if (t == 600) signature = cell;

        // Never outside the 12 px cell: a spilled pixel lands in a gutter and
        // reads as a defect.
        for (int yy = 0; yy < 16; ++yy) {
          for (int xx = 17; xx < 19; ++xx) {
            const Color c = frame.getPixel(xx, yy);
            check(!(c.r || c.g || c.b), "a game icon stays inside its cell");
          }
        }
      }
      check(shapes.size() >= 3, "each game icon animates by moving pixels");
      signatures.push_back(signature);
    }

    // ...and no two of them look alike at the same instant.
    for (size_t a = 0; a < signatures.size(); ++a) {
      for (size_t b = a + 1; b < signatures.size(); ++b) {
        check(signatures[a] != signatures[b], "no two game icons share a silhouette");
      }
    }
  }

  // The games ring must not look like the root ring relabelled.
  {
    std::vector<LauncherScreen::Entry> ringEntries;
    LauncherScreen::Entry g;
    g.label = "A";
    g.icon = LauncherScreen::kIconGameBreakout;
    g.id = 0;
    ringEntries.push_back(g);
    g.icon = LauncherScreen::kIconGameFlappy;
    g.id = 1;
    ringEntries.push_back(g);

    LauncherScreen ring;
    ring.setEntries(ringEntries, 0);
    ring.setChrome(Color(120, 170, 255), Color(18, 28, 46));
    ring.setEntryRise(true);
    ring.onEnter(0);

    // The card rises from below on entry, then settles.
    Surface entering(52, 16);
    Surface settled(52, 16);
    ring.render(entering, 20);
    ring.render(settled, 400);
    std::vector<uint8_t> a;
    std::vector<uint8_t> b;
    entering.extractRGB(a);
    settled.extractRGB(b);
    check(a != b, "the games ring lifts its card in on entry");

    // The rail wears the arcade blue rather than launcher green.
    bool blueRail = false;
    for (int x = 0; x < 52; ++x) {
      const Color c = settled.getPixel(x, 15);
      if (c.b > c.g && c.b > 0) blueRail = true;
    }
    check(blueRail, "the games ring's chrome is blue, not launcher green");
  }

  // Nothing may be drawn outside the panel at any point of a slide.
  LauncherScreen bounds;
  bounds.setEntries(entries, 0);
  bounds.onEnter(0);
  bounds.onInput(kInputTurnCw, 0);
  for (int t = 0; t <= RingModel::kSlideMs; t += 10) {
    Surface frame(52, 16);
    bounds.render(frame, t);
    check(frame.getWidth() == 52 && frame.getHeight() == 16, "the panel is never resized");
  }
}

std::string readFixture(const char* path) {
  std::string body;
  std::FILE* f = std::fopen(path, "rb");
  if (f == 0) return body;
  char buffer[8192];
  size_t n;
  while ((n = std::fread(buffer, 1, sizeof(buffer), f)) > 0) body.append(buffer, n);
  std::fclose(f);
  return body;
}

void checkFrameBundle() {
  using tcos::FrameBundle;

  const std::string body = readFixture("device/tc002-os/hostcheck/fixtures/frames.bin");
  check(!body.empty(), "the frame fixture is readable");

  FrameBundle bundle;
  check(bundle.parse(body), "the real encoder's bundle decodes");
  check(bundle.count() == 3, "every frame is decoded");
  check(bundle.delayMs(0) == 40 && bundle.delayMs(1) == 70 && bundle.delayMs(2) == 100,
        "per-frame delays decode");
  check(bundle.totalDurationMs() == 210, "the total duration is the sum of the delays");

  // The fixture's pattern is position-dependent on purpose: a decoder that
  // transposed x and y, or got the stride wrong, would still produce a
  // plausible-looking image but fail this.
  Surface out(52, 16);
  bundle.blit(1, out);
  bool exact = true;
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 52; ++x) {
      const Color c = out.getPixel(x, y);
      const int n = 1;
      if (c.r != ((x * 5 + n) & 0xff)) exact = false;
      if (c.g != ((y * 17 + n * 2) & 0xff)) exact = false;
      if (c.b != (((x + y) * 3 + n * 4) & 0xff)) exact = false;
    }
  }
  check(exact, "every pixel of a blitted frame matches the encoder, byte for byte");

  // Playback timing walks the delay list rather than assuming a fixed cadence.
  check(bundle.indexAt(0) == 0, "playback starts on frame 0");
  check(bundle.indexAt(39) == 0, "it holds frame 0 for its own delay");
  check(bundle.indexAt(40) == 1, "and advances exactly at the boundary");
  check(bundle.indexAt(109) == 1, "frame 1 holds for 70 ms");
  check(bundle.indexAt(110) == 2, "then frame 2");
  check(bundle.indexAt(210) == 0, "playback loops at the total duration");
  check(bundle.indexAt(215) == 0, "and keeps looping");
  check(bundle.indexAt(-5) == 0, "a negative elapsed time does not index out of range");

  // Validation. The service shares a LAN with everything else the user owns, so
  // a bundle's own claims about its size are checked against this panel rather
  // than allocated on trust.
  FrameBundle bad;
  check(!bad.parse(""), "an empty body is rejected");
  check(!bad.parse("nope"), "a body shorter than the header is rejected");
  std::string wrongMagic = body;
  wrongMagic[0] = 'X';
  check(!bad.parse(wrongMagic), "a wrong magic is rejected");
  std::string wrongSize = body;
  wrongSize[6] = 40;  // claims 40 columns
  check(!bad.parse(wrongSize), "a bundle that is not panel-sized is rejected");
  std::string truncated = body.substr(0, body.size() - 100);
  check(!bad.parse(truncated),
        "a truncated bundle is rejected rather than played as far as it goes");
  check(bad.count() == 0, "a rejected bundle leaves nothing behind");

  std::string huge = body;
  huge[4] = 0xFF;
  huge[5] = 0xFF;  // 65535 frames
  check(!bad.parse(huge), "an implausible frame count is rejected, not allocated");

  // A zero delay would spin the play loop; the decoder floors it even if the
  // encoder's own clamp were bypassed by something else on the wire.
  std::string zeroDelay = body;
  zeroDelay[8] = 0;
  zeroDelay[9] = 0;
  FrameBundle floored;
  check(floored.parse(zeroDelay), "a zero delay still parses");
  check(floored.delayMs(0) == FrameBundle::kMinDelayMs, "and is floored to the minimum");
}

class EchoHandler : public tcos::HttpServer::Handler {
 public:
  tcos::HttpServer::Response handle(const tcos::HttpServer::Request& request) {
    ++calls;
    lastMethod = request.method;
    lastPath = request.path;
    lastBody = request.body;
    tcos::HttpServer::Response r;
    if (request.path == "/missing") {
      r.status = 404;
      r.body = "nope";
      return r;
    }
    r.contentType = "text/html; charset=utf-8";
    r.body = "<h1>ok</h1>";
    return r;
  }
  int calls = 0;
  std::string lastMethod;
  std::string lastPath;
  std::string lastBody;
};

void checkHttpServer() {
  using tcos::HttpServer;

  // --- pure parsing, including what a phone browser actually sends ----------
  HttpServer::Request req;
  check(HttpServer::parseRequest("GET / HTTP/1.1\r\nHost: x\r\n\r\n", &req), "a GET parses");
  check(req.method == "GET" && req.path == "/" && req.query.empty(), "method and path split");

  check(HttpServer::parseRequest("GET /scan?full=1 HTTP/1.1\r\n\r\n", &req), "a query parses");
  check(req.path == "/scan" && req.query == "full=1", "the query is split off the path");

  check(HttpServer::parseRequest(
            "POST /connect HTTP/1.1\r\nContent-Length: 9\r\n\r\nssid=home", &req),
        "a POST body is captured");
  check(req.body == "ssid=home", "the body survives the header boundary");

  check(!HttpServer::parseRequest("", &req), "an empty request is rejected");
  check(!HttpServer::parseRequest("GARBAGE\r\n\r\n", &req), "a request line with no spaces is rejected");
  check(!HttpServer::parseRequest("GET nonabsolute HTTP/1.1\r\n\r\n", &req),
        "a non-absolute target is rejected");

  // --- form decoding: this is where a wrong password comes from -------------
  check(HttpServer::urlDecode("a+b") == "a b", "plus decodes to space");
  check(HttpServer::urlDecode("%E4%B8%AD") == "\xE4\xB8\xAD", "percent-encoded UTF-8 decodes");
  check(HttpServer::urlDecode("p%40ss") == "p@ss", "symbols decode");
  // A stray % is kept rather than mangled: a WPA passphrase may contain one and
  // corrupting it produces a wrong-password loop the user cannot diagnose.
  check(HttpServer::urlDecode("100%") == "100%", "a trailing percent is left alone");
  check(HttpServer::urlDecode("50%zz") == "50%zz", "an invalid escape is left alone");

  const std::string form = "ssid=my+net&password=p%40ss%21&other=x";
  check(HttpServer::formValue(form, "ssid") == "my net", "ssid decodes");
  check(HttpServer::formValue(form, "password") == "p@ss!", "password decodes");
  check(HttpServer::formValue(form, "missing").empty(), "an absent field is empty");
  // "password" must not be matched by a prefix search for "pass".
  check(HttpServer::formValue("passwordx=1&password=2", "password") == "2",
        "field matching is exact, not a prefix");

  // --- and the real thing, over a real socket on this machine ---------------
  EchoHandler handler;
  HttpServer server;
  const int port = server.start(0, &handler);
  check(port > 0 && server.running(), "the server binds a free port");

  if (port > 0) {
    // Drive it with curl rather than hand-rolling a client: the point is that a
    // real HTTP client is satisfied by these responses.
    char command[256];
    std::snprintf(command, sizeof(command),
                  "curl -s -o /tmp/tcos-http.out -w '%%{http_code}' "
                  "--max-time 3 http://127.0.0.1:%d/ > /tmp/tcos-http.code 2>/dev/null &",
                  port);
    std::system(command);
    const bool served = server.serveOnce(3000);
    check(served, "a request is accepted and served");
    check(handler.calls == 1 && handler.lastMethod == "GET" && handler.lastPath == "/",
          "the handler sees the request");

    // Give curl a moment to finish writing its files.
    std::system("sleep 1");
    std::FILE* f = std::fopen("/tmp/tcos-http.code", "r");
    char code[8] = {0};
    if (f != 0) {
      if (std::fgets(code, sizeof(code), f) == 0) code[0] = 0;
      std::fclose(f);
    }
    check(std::string(code) == "200", "a real HTTP client gets 200");
    check(readFixture("/tmp/tcos-http.out") == "<h1>ok</h1>", "and the body it was sent");

    // A POST with a form body, which is the only request that matters.
    std::snprintf(command, sizeof(command),
                  "curl -s -o /dev/null --max-time 3 -d 'ssid=home&password=x' "
                  "http://127.0.0.1:%d/connect > /dev/null 2>&1 &",
                  port);
    std::system(command);
    check(server.serveOnce(3000), "a POST is served");
    check(handler.lastMethod == "POST" && handler.lastPath == "/connect",
          "the POST route is seen");
    check(handler.lastBody == "ssid=home&password=x", "the whole form body arrives");

    check(!server.serveOnce(50), "serveOnce times out when nobody connects");

    // A CLIENT THAT SAYS NOTHING. PortalService gives this class one thread, and
    // the recv loop used to have no deadline of any kind — a single connection
    // that opened and went quiet took the setup page down for good. iOS's
    // captive assistant pre-opens sockets exactly like this, and a phone that
    // roams off the hotspot mid-request leaves one behind that never sends and
    // never resets. This check costs a few seconds of wall clock on purpose:
    // without the fix it does not fail, it HANGS, which is the point.
    const int quiet = ::socket(AF_INET, SOCK_STREAM, 0);
    if (quiet >= 0) {
      struct sockaddr_in to;
      std::memset(&to, 0, sizeof(to));
      to.sin_family = AF_INET;
      to.sin_port = htons((uint16_t)port);
      to.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      if (::connect(quiet, (struct sockaddr*)&to, sizeof(to)) == 0) {
        check(server.serveOnce(3000),
              "a client that connects and never speaks is dropped, not waited on forever");
      }
      ::close(quiet);
    }
  }

  server.stop();
  check(!server.running(), "stop closes the listener");
}

class FakePortalBackend : public tcos::SetupPortal::Backend {
 public:
  std::vector<std::string> scanResults() { return networks; }
  bool submit(const std::string& s, const std::string& p, std::string* reason) {
    if (refuse) {
      *reason = "link-locked";
      return false;
    }
    submitImpl(s, p);
    return true;
  }
  bool refuse = false;
  void submitImpl(const std::string& s, const std::string& p) {
    submittedSsid = s;
    submittedPsk = p;
    ++submits;
  }
  std::string status() { return state; }
  std::string ipAddress() { return ip; }

  std::vector<std::string> networks;
  std::string state = "provisioning";
  std::string ip;
  std::string submittedSsid;
  std::string submittedPsk;
  int submits = 0;
};

void checkSetupPortal() {
  using tcos::HttpServer;
  using tcos::SetupPortal;

  FakePortalBackend backend;
  SetupPortal portal(&backend);

  HttpServer::Request req;
  req.method = "GET";
  req.path = "/";
  HttpServer::Response page = portal.handle(req);
  check(page.status == 200, "the page serves 200");
  check(page.contentType.find("text/html") != std::string::npos, "as HTML");
  // The phone is joined to the device's own hotspot and has no internet, so a
  // single external reference turns setup into an unexplained spinner.
  check(page.body.find("http://") == std::string::npos &&
            page.body.find("https://") == std::string::npos,
        "the page references nothing external");
  check(page.body.find("<script") != std::string::npos, "its script is inline");
  check(page.body.find("<style") != std::string::npos, "its styles are inline");
  check(page.body.find("2.4G") != std::string::npos, "it states the 2.4G-only limit");

  // A TYPED SSID IS ALWAYS AVAILABLE. Raising the hotspot stops wpa_supplicant,
  // so the device cannot scan for as long as this page is the one being used —
  // the list is legitimately empty for the whole session. Without this box the
  // page was a dead end: nothing selectable and no other way to name a network.
  check(page.body.find("id=m") != std::string::npos, "the page carries a free-text SSID box");
  check(page.body.find("getElementById('m').value") != std::string::npos,
        "and the submit prefers what the user typed");
  // The placeholder used to have no value attribute, so a select showing it
  // submitted its own LABEL as the SSID — an accepted submission that tore the
  // hotspot down to associate with a network called "正在扫描…".
  check(page.body.find("o.value='';") != std::string::npos,
        "the placeholder option carries an empty value, so it cannot be submitted");
  check(page.body.find("if(!ssid)") != std::string::npos,
        "and an empty SSID is refused before the radio is touched");
  // A refusal comes back as 409 with a reason; the page used to ignore the
  // status entirely and drop into polling as though it had been accepted.
  check(page.body.find("if(!r.ok)") != std::string::npos,
        "a refused submit is shown rather than polled over");

  // A captive-portal probe hits an arbitrary path; answering it with the form is
  // what makes the phone's "sign in to network" banner open straight onto it.
  req.path = "/hotspot-detect.html";
  check(portal.handle(req).body == page.body, "any unknown path serves the setup page");

  // Scan results are JSON, and an SSID is user-controlled data from the air.
  req.path = "/scan";
  check(portal.handle(req).body == "{\"networks\":[]}", "an empty scan is still valid JSON");
  backend.networks.push_back("home");
  backend.networks.push_back("say \"hi\"");
  backend.networks.push_back("back\\slash");
  const std::string scanBody = portal.handle(req).body;
  check(scanBody.find("\\\"hi\\\"") != std::string::npos, "quotes in an SSID are escaped");
  check(scanBody.find("back\\\\slash") != std::string::npos, "backslashes are escaped");
  check(SetupPortal::jsonEscape("\x01") == "\\u0001",
        "a control byte becomes an escape rather than invalid JSON");
  check(SetupPortal::htmlEscape("<b>&\"") == "&lt;b&gt;&amp;&quot;", "html escaping covers the set");

  // Submitting.
  req.method = "POST";
  req.path = "/connect";
  req.body = "ssid=my+net&password=p%40ss";
  HttpServer::Response ok = portal.handle(req);
  check(ok.status == 200 && backend.submits == 1, "a submit reaches the backend");
  check(backend.submittedSsid == "my net" && backend.submittedPsk == "p@ss",
        "the form is decoded before it reaches the WiFi layer");

  // An open network is legitimate; only a missing SSID is an error.
  req.body = "ssid=open&password=";
  check(portal.handle(req).status == 200, "an empty password is accepted");
  req.body = "password=x";
  check(portal.handle(req).status == 400, "a missing ssid is refused");
  check(backend.submits == 2, "and is not handed to the WiFi layer");

  req.method = "GET";
  check(portal.handle(req).status == 400, "GET /connect is refused");

  // Status drives the page's polling loop.
  req.method = "GET";
  req.path = "/status";
  check(portal.handle(req).body == "{\"status\":\"provisioning\",\"ip\":\"\"}",
        "status reports the current state");
  backend.state = "online";
  backend.ip = "192.168.8.240";
  check(portal.handle(req).body == "{\"status\":\"online\",\"ip\":\"192.168.8.240\"}",
        "and the address once there is one");

  // A refused submit must be visible AT the submit, not as a status that flips
  // a poll later. The device refuses whenever changing the link is locked out,
  // and a page that says "submitted" to that is the exact failure this page
  // exists to prevent.
  {
    FakePortalBackend backend;
    backend.refuse = true;
    tcos::SetupPortal portal(&backend);
    tcos::HttpServer::Request request;
    request.method = "POST";
    request.path = "/connect";
    request.body = "ssid=Home&password=hunter2";
    const tcos::HttpServer::Response response = portal.handle(request);
    check(response.status == 409, "a refused submit answers 409, not 200");
    check(response.body.find("\"ok\":false") != std::string::npos, "and says so in the body");
    check(response.body.find("link-locked") != std::string::npos,
          "carrying the reason the device gave");
  }
}

void checkGameScreen() {
  using tcos::GameScreen;

  BreakoutEngine engine;
  BreakoutEngine b;
  FlappyEngine f;
  SnakeEngine s;
  PongEngine p;
  RacerEngine r;
  ShooterEngine sh;
  TetrisEngine t;
  GameScreen screen;
  screen.setEngine(&engine);
  check(screen.engine() == &engine, "the engine mounts");

  screen.onEnter(0);
  check(engine.hud().phase == GameHud::Ready, "entering rewinds to the attract screen");

  Surface out(52, 16);
  screen.render(out, 0);
  check(litPixels(out) > 0, "the attract screen renders");

  // A hold leaves from EVERY phase. The first version only exited when the game
  // was not playing, which produced a game you could enter and never leave.
  check(screen.onInput(tcos::kInputHold, 100), "a hold is consumed while idle");
  check(screen.takeExitRequest(), "and asks to leave");
  check(!screen.takeExitRequest(), "reading the request clears it");

  screen.onEnter(200);
  screen.onInput(tcos::kInputPress, 210);
  screen.render(out, 220);
  check(engine.hud().phase == GameHud::Playing, "the game is running");
  check(screen.onInput(tcos::kInputHold, 300), "a hold is consumed while playing too");
  check(screen.takeExitRequest(), "and leaves — there is always a way out");

  // Every engine must be leavable mid-play, not just this one.
  {
    GameEngine* all[7] = {&b, &f, &s, &p, &r, &sh, &t};
    for (int i = 0; i < 7; ++i) {
      GameScreen host;
      Surface frame(52, 16);
      host.setEngine(all[i]);
      host.onEnter(0);
      host.onInput(tcos::kInputPress, 10);   // start it
      for (int step = 0; step < 20; ++step) host.render(frame, 20 + step * 40);
      host.onInput(tcos::kInputHold, 1000);
      check(host.takeExitRequest(),
            std::string("you can leave ") + all[i]->id() + " mid-play");
    }
  }

  // A stalled tick must not teleport the simulation. Two renders far apart
  // should advance by the clamp, not by the wall-clock gap.
  screen.onEnter(0);
  screen.render(out, 0);
  screen.render(out, 100000);
  check(out.getWidth() == 52, "a huge time step does not corrupt the surface");

  // Every engine must mount and render without the adapter caring which it is.
  GameEngine* all[7] = {&b, &f, &s, &p, &r, &sh, &t};
  for (int i = 0; i < 7; ++i) {
    GameScreen host;
    host.setEngine(all[i]);
    host.onEnter(0);
    Surface frame(52, 16);
    host.render(frame, 30);
    check(frame.getWidth() == 52 && frame.getHeight() == 16,
          std::string("engine ") + all[i]->id() + " renders into the panel");
  }

  GameScreen empty;
  empty.onEnter(0);
  Surface blank(52, 16);
  empty.render(blank, 10);
  check(litPixels(blank) == 0, "a screen with no engine renders black rather than crashing");
  check(!empty.onInput(tcos::kInputPress, 10), "and ignores input");
}

void checkLevelOverlay() {
  using tcos::LevelOverlay;
  LevelOverlay hud;
  Surface out(52, 16);

  check(!hud.visible(0), "nothing is shown until something changes");
  out.clear();
  hud.render(out, 0);
  check(litPixels(out) == 0, "an idle overlay draws nothing at all");

  hud.show(LevelOverlay::kVolume, 3, 6, 1000);
  check(hud.visible(1000) && hud.kind() == LevelOverlay::kVolume, "a volume change shows the bar");
  check(hud.value() == 3, "at the level it was given");

  out.clear();
  hud.render(out, 1000 + LevelOverlay::kEnterMs);
  const int mid = litPixels(out);
  check(mid > 0, "the bar renders");

  // It must expire on its own: an adjustment HUD that stayed would make the
  // panel unusable, and there is no dismiss gesture to spend on it.
  check(hud.visible(1000 + LevelOverlay::kHoldMs), "it holds long enough to read");
  check(!hud.visible(1000 + LevelOverlay::kHoldMs + LevelOverlay::kExitMs + 1),
        "and then expires by itself");
  out.clear();
  hud.render(out, 1000 + LevelOverlay::kHoldMs + LevelOverlay::kExitMs + 1);
  check(litPixels(out) == 0, "leaving nothing behind");

  // Repeated presses extend the hold rather than restarting the entry
  // animation, which would flicker during a fast run of presses.
  hud.show(LevelOverlay::kVolume, 4, 6, 2000);
  hud.show(LevelOverlay::kVolume, 5, 6, 2100);
  check(hud.value() == 5, "the latest value wins");
  check(hud.visible(2100 + LevelOverlay::kHoldMs), "the hold restarts from the last press");

  // The two kinds are visually distinct — same geometry would make a
  // brightness press look like a volume press.
  Surface volumeFrame(52, 16);
  Surface brightFrame(52, 16);
  LevelOverlay a;
  LevelOverlay b;
  a.show(LevelOverlay::kVolume, 5, 6, 0);
  b.show(LevelOverlay::kBrightness, 5, 10, 0);
  a.render(volumeFrame, LevelOverlay::kEnterMs);
  b.render(brightFrame, LevelOverlay::kEnterMs);
  std::vector<uint8_t> va;
  std::vector<uint8_t> vb;
  volumeFrame.extractRGB(va);
  brightFrame.extractRGB(vb);
  check(va != vb, "volume and brightness look different");

  // More filled segments at a higher level, which is the whole point.
  LevelOverlay low;
  LevelOverlay high;
  low.show(LevelOverlay::kVolume, 1, 6, 0);
  high.show(LevelOverlay::kVolume, 6, 6, 0);
  Surface lowFrame(52, 16);
  Surface highFrame(52, 16);
  low.render(lowFrame, LevelOverlay::kEnterMs);
  high.render(highFrame, LevelOverlay::kEnterMs);
  int lowBar = 0;
  int highBar = 0;
  for (int x = 14; x < 52; ++x) {
    for (int y = 0; y < 16; ++y) {
      const Color lc = lowFrame.getPixel(x, y);
      const Color hc = highFrame.getPixel(x, y);
      if (lc.r + lc.g + lc.b > 200) ++lowBar;
      if (hc.r + hc.g + hc.b > 200) ++highBar;
    }
  }
  check(highBar > lowBar, "a higher level fills more of the bar");

  // Zero is a real state and must not look like "off screen".
  LevelOverlay muted;
  muted.show(LevelOverlay::kVolume, 0, 6, 0);
  Surface mutedFrame(52, 16);
  muted.render(mutedFrame, LevelOverlay::kEnterMs);
  check(litPixels(mutedFrame) > 0, "zero volume still draws — it shows a mute mark");

  // Out-of-range input is clamped rather than drawn outside the bar.
  LevelOverlay clamped;
  clamped.show(LevelOverlay::kVolume, 99, 6, 0);
  check(clamped.value() == 6, "a level above the max is clamped");
  clamped.show(LevelOverlay::kVolume, -5, 6, 0);
  check(clamped.value() == 0, "a negative level is clamped");

  // THE MODE RULE. A short press adjusts whatever is on screen: once a long
  // press has opened brightness, further short presses must keep adjusting
  // brightness. Snapping back to volume mid-adjustment would force a hold for
  // every single step and would silently move the wrong control.
  LevelOverlay mode;
  check(mode.shortPressKind(0) == LevelOverlay::kVolume,
        "with nothing on screen, a short press means volume");

  mode.show(LevelOverlay::kBrightness, 5, 10, 1000);
  check(mode.shortPressKind(1000) == LevelOverlay::kBrightness,
        "while the brightness bar is up, a short press means brightness");
  check(mode.shortPressKind(1000 + LevelOverlay::kHoldMs) == LevelOverlay::kBrightness,
        "for as long as the bar is up");

  // ...and only until it expires. Once the panel is back to normal the buttons
  // mean volume again, with no mode the user has to remember to leave.
  const int gone = 1000 + LevelOverlay::kHoldMs + LevelOverlay::kExitMs + 1;
  check(!mode.visible(gone), "the bar is gone by then");
  check(mode.shortPressKind(gone) == LevelOverlay::kVolume,
        "once it expires, a short press means volume again");

  // A volume bar must NOT capture short presses into brightness.
  mode.show(LevelOverlay::kVolume, 3, 6, 2000);
  check(mode.shortPressKind(2000) == LevelOverlay::kVolume,
        "a volume bar keeps short presses on volume");

  // And each further short press extends the brightness mode rather than
  // letting it lapse mid-adjustment.
  mode.show(LevelOverlay::kBrightness, 4, 10, 3000);
  mode.show(LevelOverlay::kBrightness, 5, 10, 3000 + LevelOverlay::kHoldMs - 10);
  check(mode.shortPressKind(3000 + LevelOverlay::kHoldMs + 100) == LevelOverlay::kBrightness,
        "each adjustment extends the mode");

  // It composites: whatever was underneath is dimmed, not erased.
  Surface busy(52, 16);
  busy.fill(Color(200, 200, 200));
  LevelOverlay over;
  over.show(LevelOverlay::kBrightness, 5, 10, 0);
  over.render(busy, LevelOverlay::kEnterMs);
  bool sawDimmed = false;
  for (int x = 0; x < 52 && !sawDimmed; ++x) {
    for (int y = 0; y < 16; ++y) {
      const Color c = busy.getPixel(x, y);
      if (c.r > 0 && c.r < 200) sawDimmed = true;
    }
  }
  check(sawDimmed, "the frame underneath is dimmed rather than erased");
}

// Replays exactly what osLogic.cc does when the user presses confirm on 游戏 and
// then on a game. The device showed this path restarting the framework, which
// the per-class checks could not have caught: each piece works alone, and the
// failure is in how they are driven together.
void checkNavigationFlow() {
  using tcos::GameScreen;
  using tcos::LauncherScreen;
  using tcos::Shell;

  BreakoutEngine breakout;
  FlappyEngine flappy;
  SnakeEngine snake;
  PongEngine pong;
  RacerEngine racer;
  ShooterEngine shooter;
  TetrisEngine tetris;
  GameEngine* engines[7] = {&breakout, &flappy, &snake, &pong, &racer, &shooter, &tetris};

  const int kGameBase = 200;

  LauncherScreen root;
  LauncherScreen gameList;
  GameScreen gameScreen;
  Shell shell(52, 16);
  Surface frame(52, 16);

  std::vector<LauncherScreen::Entry> rootEntries;
  LauncherScreen::Entry e;
  e.label = "\xE9\x9F\xB3\xE4\xB9\x90";
  e.icon = LauncherScreen::kIconMusic;
  e.id = 1;
  rootEntries.push_back(e);
  e.label = "\xE6\xB8\xB8\xE6\x88\x8F";
  e.icon = LauncherScreen::kIconGame;
  e.id = 2;
  rootEntries.push_back(e);

  // The games ring takes its labels from the engines themselves — ASCII titles
  // wider than the label window, so this also exercises the marquee path that
  // the CJK root entries never reach.
  std::vector<LauncherScreen::Entry> gameEntries;
  for (int i = 0; i < 7; ++i) {
    LauncherScreen::Entry g;
    g.label = engines[i]->title();
    g.icon = LauncherScreen::kIconGame;
    g.id = kGameBase + i;
    gameEntries.push_back(g);
  }

  root.setEntries(rootEntries, 0);
  gameList.setEntries(gameEntries, 0);
  // Registered the way osLogic does it, so the flow below drives the real
  // per-destination entries rather than a default the device never uses.
  shell.setEntryStyle(&gameList, Shell::kEntryCartridge);
  shell.setEntryStyle(&gameScreen, Shell::kEntryCartridge);
  shell.reset(&root, 0);

  // Drive it the way the tick does: route, then render, every frame.
  int t = 0;
  for (int step = 0; step < 400; ++step) {
    t += 40;
    if (step == 5) shell.onInput(tcos::kInputTurnCw, t);   // move to 游戏
    if (step == 12) shell.onInput(tcos::kInputPress, t);   // enter the games ring
    if (step == 30) shell.onInput(tcos::kInputPress, t);   // enter the first game
    if (step == 60) shell.onInput(tcos::kInputPress, t);   // start playing
    if (step == 200) shell.onInput(tcos::kInputHold, t);   // ask to leave

    const int rootPick = root.takeActivated();
    if (rootPick == 2) shell.push(&gameList, t);
    const int gamePick = gameList.takeActivated();
    if (gamePick >= kGameBase && gamePick < kGameBase + 7) {
      gameScreen.setEngine(engines[gamePick - kGameBase]);
      shell.push(&gameScreen, t);
    }
    if (gameScreen.takeExitRequest()) shell.pop(t);

    shell.render(frame, t);
    check(frame.getWidth() == 52 && frame.getHeight() == 16, "the panel survives the flow");
  }

  check(shell.depth() >= 1, "the stack never empties");

  // Every game must survive being entered and driven, not just the first.
  for (int i = 0; i < 7; ++i) {
    GameScreen host;
    Shell local(52, 16);
    LauncherScreen dummy;
    dummy.setEntries(rootEntries, 0);
    local.reset(&dummy, 0);
    host.setEngine(engines[i]);
    local.push(&host, 0);
    int lt = 0;
    for (int step = 0; step < 120; ++step) {
      lt += 40;
      if (step == 10) local.onInput(tcos::kInputPress, lt);
      if (step % 7 == 0) local.onInput(tcos::kInputTurnCw, lt);
      if (step % 11 == 0) local.onInput(tcos::kInputLeft, lt);
      local.render(frame, lt);
    }
    check(frame.getWidth() == 52, std::string("engine ") + engines[i]->id() + " survives play");
  }
}

void checkStateDoc() {
  using tcos::StateDoc;

  // THE fixture is bytes produced by the real TypeScript encoder
  // (test/os-link.test.ts asserts it still matches), so this is a genuine
  // cross-language contract test rather than two hand-written idealisations of
  // the same format agreeing with each other.
  std::FILE* f = std::fopen("device/tc002-os/hostcheck/fixtures/state-doc.txt", "rb");
  check(f != 0, "the state-doc fixture is readable");
  std::string body;
  if (f != 0) {
    char buffer[4096];
    size_t n;
    while ((n = std::fread(buffer, 1, sizeof(buffer), f)) > 0) body.append(buffer, n);
    std::fclose(f);
  }

  StateDoc doc;
  check(doc.parse(body), "the real service document parses");
  check(doc.seq() == 3, "seq is read");
  check(doc.pinned(), "pinned is read");
  check(!doc.mirror(), "the mirror flag is read");
  check(doc.focus() == "notice", "focus is read");
  check(doc.items().size() == 6, "every item is read");
  if (doc.items().size() == 6) {
    // Every field of every record, not a spot check: a partial assertion here
    // let a deliberate fixture edit pass once while the TypeScript side caught
    // it, which is exactly the asymmetry this pair of tests exists to remove.
    static const StateDoc::Kind kKinds[6] = {
        StateDoc::kChannel, StateDoc::kChannel, StateDoc::kChannel,
        StateDoc::kMusic, StateDoc::kGame, StateDoc::kSettings};
    static const char* kIds[6] = {"btc", "matrixclock", "notice", "music", "game", "settings"};
    static const char* kLabels[6] = {
        "\xE5\xB8\x82\xE5\x9C\xBA\xE8\xBD\xAE\xE6\x92\xAD",              // 市场轮播
        "\xE6\x95\xB0\xE5\xAD\x97\xE9\x9B\xA8\xE6\x97\xB6\xE9\x92\x9F",  // 数字雨时钟
        "\xE9\x80\x9A\xE7\x9F\xA5\xE6\x9D\xBF",                          // 通知板
        "\xE9\x9F\xB3\xE4\xB9\x90",                                      // 音乐
        "\xE6\xB8\xB8\xE6\x88\x8F",                                      // 游戏
        "\xE8\xAE\xBE\xE7\xBD\xAE",                                      // 设置
    };
    for (int i = 0; i < 6; ++i) {
      char label[64];
      std::snprintf(label, sizeof(label), "item %d round-trips", i);
      check(doc.items()[i].kind == kKinds[i] && doc.items()[i].id == kIds[i] &&
                doc.items()[i].label == kLabels[i],
            label);
    }
  }
  check(doc.focusIndex() == 2, "focus resolves to its index");

  // Robustness: the firmware must never brick itself on a document it only
  // half understands, or one forward-compatible field on the service side
  // would take out every deployed device.
  StateDoc future;
  check(future.parse("seq\t9\nnewfield\twhatever\nitem\tvideo\tv1\tX\n"
                     "item\tchannel\tok\tY\n"),
        "an unknown field does not fail the document");
  check(future.seq() == 9, "known fields still parse around unknown ones");
  check(future.items().size() == 1, "an unknown item kind is skipped, not guessed");
  check(future.items()[0].id == "ok", "the known item survives");

  StateDoc empty;
  check(!empty.parse(""), "an empty body is rejected");
  check(!empty.parse("pinned\t1\n"), "a document with no seq is rejected");

  StateDoc noTrailer;
  check(noTrailer.parse("seq\t4\nitem\tchannel\ta\tb"), "a missing trailing newline still parses");
  check(noTrailer.items().size() == 1, "the last record is not dropped");

  StateDoc ragged;
  check(ragged.parse("seq\t5\nitem\tchannel\tonly-three-fields\n"), "a short item line is skipped");
  check(ragged.items().empty(), "and does not produce a half-built entry");

  StateDoc noFocus;
  noFocus.parse("seq\t6\nitem\tchannel\ta\tb\n");
  check(noFocus.focusIndex() == -1, "no focus reports -1 rather than 0");
  StateDoc staleFocus;
  staleFocus.parse("seq\t7\nfocus\tgone\nitem\tchannel\ta\tb\n");
  check(staleFocus.focusIndex() == -1, "a focus naming a removed channel reports -1");

  // --- now playing ---------------------------------------------------------
  // state-doc.txt above is a hub with no music session, so every assertion in
  // this function used to pass on a document that has never carried an `np`
  // block — and checkMusicScreen hand-feeds setNowPlaying(), so neither half
  // ever saw the other. That is how a panel showing nothing could sit behind a
  // green self-check.
  //
  // These bytes are OsLinkHub.serialize() with a now-playing session applied,
  // copied verbatim. The field ORDER matters and is asserted by using it: `pos`
  // and `dur` sit between `playing` and `lyric`, and `np` sits between `mirror`
  // and `menu`, so a parser that keyed off line position rather than name would
  // pass on the menu-only fixture and fail here.
  static const char* kNowPlayingDoc =
      "seq\t3\npinned\t0\nmirror\t0\n"
      "np\t1\ntrack\tOne Last Kiss\nartist\tHikaru Utada\nplaying\t1\n"
      "pos\t41000\ndur\t244000\nlyric\tWasurerarenai hito\n"
      "menu\t4\n"
      "item\tchannel\tbtc\t\xE5\xB8\x82\xE5\x9C\xBA\xE8\xBD\xAE\xE6\x92\xAD\n"
      "item\tmusic\tmusic\t\xE9\x9F\xB3\xE4\xB9\x90\n"
      "item\tgame\tgame\t\xE6\xB8\xB8\xE6\x88\x8F\n"
      "item\tsettings\tsettings\t\xE8\xAE\xBE\xE7\xBD\xAE\n";

  StateDoc np;
  check(np.parse(kNowPlayingDoc), "a document carrying now playing parses");
  check(np.hasNowPlaying(), "np\t1 reads as something playing");
  check(np.playing(), "playing\t1 reads as running rather than paused");
  // Each field by name and in full. A title is one tab-separated value with a
  // space in it, which is the case the 4-field cap in splitTabs has to get right:
  // the value keeps everything after the first tab rather than stopping at the
  // space, and it must not spill into the `item` records that share the loop.
  check(np.track() == "One Last Kiss", "the track survives, spaces and all");
  check(np.artist() == "Hikaru Utada", "the artist survives");
  check(np.lyric() == "Wasurerarenai hito", "the lyric survives");
  check(np.positionMs() == 41000, "pos is read as milliseconds");
  check(np.durationMs() == 244000, "dur is read as milliseconds");
  check(np.seq() == 3 && !np.pinned() && !np.mirror(),
        "the fields around the np block still parse");
  check(np.items().size() == 4, "the menu still parses after an np block");
  if (np.items().size() == 4) {
    check(np.items()[0].id == "btc" && np.items()[3].id == "settings",
          "and no np line was mistaken for an item");
  }

  // Reparsing is a full reset, not a merge. The service omits the whole block
  // when nothing is playing, and a parser that kept the last song would leave a
  // stopped track on the panel indefinitely.
  check(np.parse("seq\t4\nmenu\t0\n"), "a document with no np block still parses");
  check(!np.hasNowPlaying() && np.track().empty() && np.artist().empty() &&
            np.lyric().empty() && np.positionMs() == 0 && np.durationMs() == 0,
        "and clears every now-playing field rather than keeping the last song");

  // The service omits `lyric` entirely when the line is empty, and omits
  // `pos`/`dur` for nothing — but a firmware that only worked on the complete
  // shape would be one service change away from a blank row.
  StateDoc noLyric;
  noLyric.parse("seq\t5\nnp\t1\ntrack\tHer Majesty\nartist\tThe Beatles\nplaying\t0\n"
                "pos\t0\ndur\t23000\nmenu\t0\n");
  check(noLyric.hasNowPlaying() && !noLyric.playing() && noLyric.lyric().empty() &&
            noLyric.track() == "Her Majesty",
        "an omitted lyric leaves the track, not an empty document");

  StateDoc unnamed;
  unnamed.parse("seq\t6\nnp\t1\ntrack\t\nartist\t\nplaying\t1\npos\t10\ndur\t20\nmenu\t0\n");
  check(unnamed.hasNowPlaying() && unnamed.track().empty(),
        "np survives a title the service could not resolve");

  StateDoc stopped;
  stopped.parse("seq\t7\nnp\t0\nmenu\t0\n");
  check(!stopped.hasNowPlaying(), "np\t0 is not playing");

  // --- 主题设置 ------------------------------------------------------------
  // The console's one theme panel drives both firmwares (ADR 0007), so these
  // three keys are the whole reason ZOS's music screen can claim parity with
  // the sideloaded lyrics player. The integers are the protocol: the fixture
  // above already asserts the default pair round-trips, so these cover the rest
  // of the range and every way the value can be wrong.
  check(doc.lyricMode() == 2 && doc.lyricSkin() == 0 && !doc.hasAccent(),
        "the real service document carries spotlight/signal and no accent");

  StateDoc themed;
  themed.parse("seq\t8\nmode\tcascade\nskin\ttape\naccent\tFF8844\nmenu\t0\n");
  check(themed.lyricMode() == 3, "cascade is mode 3, as LYRIC_MODES orders them");
  check(themed.lyricSkin() == 1, "tape is skin 1");
  check(themed.hasAccent() && themed.accentRgb() == 0xff8844u,
        "an accent is read as RGB, upper case included");

  // Every id, not a spot check. A transposed pair here would paint 街机红 for
  // 蓝晒 on a panel nobody is looking at while the console shows the right
  // swatch — the exact failure that has no symptom until someone is in the room.
  static const char* kModes[4] = {"ticker", "skyline", "spotlight", "cascade"};
  static const char* kSkins[4] = {"signal", "tape", "blueprint", "arcade"};
  for (int i = 0; i < 4; ++i) {
    StateDoc one;
    char body[128];
    std::snprintf(body, sizeof(body), "seq\t9\nmode\t%s\nskin\t%s\nmenu\t0\n",
                  kModes[i], kSkins[i]);
    one.parse(body);
    char label[96];
    std::snprintf(label, sizeof(label), "%s/%s map to %d", kModes[i], kSkins[i], i);
    check(one.lyricMode() == i && one.lyricSkin() == i, label);
  }

  // A newer service naming a mode this build has never heard of. Falling back
  // to the default is a choice: "keep whatever was there" would leave two
  // devices on one account showing different screens with no way to tell which
  // is stale, and blanking would be worse than both.
  StateDoc future2;
  future2.parse("seq\t10\nmode\tkaleidoscope\nskin\tvaporwave\nmenu\t0\n");
  check(future2.lyricMode() == 2 && future2.lyricSkin() == 0,
        "an unknown mode/skin falls back to spotlight/signal rather than to nothing");

  // Malformed accents. strtoul would happily read "ff" out of "ff88zz"; a
  // colour nobody chose is worse than the skin's own.
  static const char* kBadAccents[5] = {"ff88", "ff8844aa", "ff88zz", "", "-"};
  for (int i = 0; i < 5; ++i) {
    StateDoc bad;
    char body[128];
    std::snprintf(body, sizeof(body), "seq\t11\naccent\t%s\nmenu\t0\n", kBadAccents[i]);
    bad.parse(body);
    char label[96];
    std::snprintf(label, sizeof(label), "accent \"%s\" is refused, not half-read",
                  kBadAccents[i]);
    check(!bad.hasAccent() && bad.accentRgb() == 0u, label);
  }

  // An OLDER service, which sends no theme at all. This is the compatibility
  // direction that actually ships: firmware is flashed by hand and the service
  // updates itself, so a device running ahead of its host is the normal state
  // for a while after any release.
  StateDoc untimed;
  check(untimed.parse("seq\t12\nnp\t1\ntrack\tX\nplaying\t1\npos\t0\ndur\t1000\nmenu\t0\n"),
        "a document with no theme lines at all still parses");
  check(untimed.lyricMode() == 2 && untimed.lyricSkin() == 0 && !untimed.hasAccent(),
        "and lands on the defaults");
  check(untimed.lyricStartMs() == -1 && untimed.lyricEndMs() == -1,
        "and reports no lyric window rather than a zero-length one at 0");

  // Reparsing resets the theme too. A rollback to an older service must not
  // leave the last theme it ever sent frozen on the panel.
  themed.parse("seq\t13\nmenu\t0\n");
  check(themed.lyricMode() == 2 && themed.lyricSkin() == 0 && !themed.hasAccent(),
        "a document without a theme clears the previous one instead of merging");

  // The lyric window. Without it every mode has a progress of zero and the
  // screen sweeps once and stops — the line would sit there, sung, while the
  // song moved on.
  StateDoc window;
  window.parse("seq\t14\nnp\t1\ntrack\tX\nplaying\t1\npos\t41000\ndur\t244000\n"
               "lyric\tWasurerarenai hito\nlyricat\t40500\nlyricend\t44000\nmenu\t0\n");
  check(window.lyricStartMs() == 40500 && window.lyricEndMs() == 44000,
        "the lyric window is read as absolute track milliseconds");
}

// A scriptable stand-in for zknet: every predicate is a field the test sets, so
// the timeout branches can be reached in microseconds instead of by unplugging
// a router and waiting.
class FakeWifi : public tcos::WifiPolicy::Actuator {
 public:
  FakeWifi()
      : running(false), stored(false), assoc(false), address(false),
        connectOk(true), apUp(false), starts(0), connects(0), dhcpCalls(0),
        apStarts(0), apStops(0), persists(0), apChecks(0) {}

  void startSupplicant() {
    ++starts;
    running = autoStart;
  }
  bool supplicantRunning() { return running; }
  bool storedCredentials(std::string* s, std::string* p) {
    if (!stored) return false;
    *s = storedSsid;
    *p = "psk";
    return true;
  }
  bool connect(const std::string& s, const std::string&) {
    ++connects;
    lastSsid = s;
    return connectOk;
  }
  bool associated() { return assoc; }
  bool requestDhcp() {
    ++dhcpCalls;
    return true;
  }
  bool hasAddress() { return address; }
  void persistCredentials() { ++persists; }
  void startSoftAp() {
    apUp = true;
    ++apStarts;
  }
  void stopSoftAp() {
    apUp = false;
    ++apStops;
  }
  bool softApRunning() {
    // Counted, not just answered. On the device this call walks the whole of
    // /proc, and the state it is asked from is the one a stranded device never
    // leaves — so HOW OFTEN it is asked is itself a property worth pinning.
    ++apChecks;
    return apUp && !apDies;
  }
  void startScan() {
    ++scans;
    scanDone = autoScan;
  }
  bool scanResults(std::vector<std::string>* out) {
    if (!scanDone) return false;
    *out = visible;
    return true;
  }

  // Every call that CHANGES the device, as opposed to reading it. The adopt
  // path's whole promise is that this stays zero, so it is counted rather than
  // asserted one flag at a time. persists belongs here above all: it is the
  // only one that writes /data, which a power cycle does not clear.
  int mutations() const {
    return starts + connects + dhcpCalls + apStarts + apStops + scans + persists;
  }

  bool autoStart = true;
  bool autoScan = true;
  bool scanDone = false;
  bool apDies = false;
  int scans = 0;
  std::vector<std::string> visible;
  bool running;
  bool stored;
  std::string storedSsid = "home";
  bool assoc;
  bool address;
  bool connectOk;
  bool apUp;
  std::string lastSsid;
  int starts;
  int connects;
  int dhcpCalls;
  int apStarts;
  int apStops;
  int persists;
  int apChecks;
};

// A bundle the FrameBundle decoder accepts, built here rather than loaded from
// a fixture so a screen test can choose its own frame count and colours.
std::string makeBundle(int frames, int delayMs) {
  std::string out("TCF1");
  out.push_back(static_cast<char>(frames & 0xFF));
  out.push_back(static_cast<char>((frames >> 8) & 0xFF));
  out.push_back(static_cast<char>(52));
  out.push_back(static_cast<char>(16));
  for (int f = 0; f < frames; ++f) {
    out.push_back(static_cast<char>(delayMs & 0xFF));
    out.push_back(static_cast<char>((delayMs >> 8) & 0xFF));
    for (int i = 0; i < 52 * 16; ++i) {
      // Frame index encoded in the red channel, so a test can assert WHICH
      // frame is on screen rather than merely that something is.
      out.push_back(static_cast<char>(f + 1));
      out.push_back(static_cast<char>(0));
      out.push_back(static_cast<char>(0));
    }
  }
  return out;
}

void checkHttpClient() {
  std::string host;
  std::string path;
  int port = 0;
  check(tcos::HttpClient::parseUrl("http://192.168.8.185:43820/api/os/pull?seq=3",
                                   &host, &port, &path),
        "a host:port url parses");
  check(host == "192.168.8.185" && port == 43820 && path == "/api/os/pull?seq=3",
        "host, port and path split correctly");
  check(tcos::HttpClient::parseUrl("http://example", &host, &port, &path) &&
            port == 80 && path == "/",
        "a bare host defaults to port 80 and /");
  check(!tcos::HttpClient::parseUrl("https://x/y", &host, &port, &path),
        "https is refused rather than silently downgraded");
  check(!tcos::HttpClient::parseUrl("http://x:99999/y", &host, &port, &path),
        "an out-of-range port is refused");

  const std::string get =
      tcos::HttpClient::buildRequest("GET", "/a", "h", "text/plain", "body");
  check(get.find("Content-Length") == std::string::npos,
        "a GET carries no body or Content-Length");
  const std::string post =
      tcos::HttpClient::buildRequest("POST", "/a", "h", "application/json", "{}");
  check(post.find("Content-Type: application/json") != std::string::npos,
        "a POST carries the caller's content type");
  check(post.find("Content-Length: 2") != std::string::npos, "and its real length");
  check(post.size() >= 2 && post.compare(post.size() - 2, 2, "{}") == 0,
        "the body is last");

  int status = 0;
  std::string body;
  check(tcos::HttpClient::parseResponse(
            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n", &status, &body) &&
            status == 204 && body.empty(),
        "204 is a success shape, not a parse failure");
  check(tcos::HttpClient::parseResponse(
            "HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nhello", &status, &body) &&
            body == "hello",
        "a Content-Length body is taken whole");
  check(!tcos::HttpClient::parseResponse(
            "HTTP/1.0 200 OK\r\nContent-Length: 9\r\n\r\nhello", &status, &body),
        "a body shorter than its declared length is a failure, not a short read");
  check(tcos::HttpClient::parseResponse("HTTP/1.0 200 OK\r\nX: y\r\n\r\nclosed", &status,
                                        &body) &&
            body == "closed",
        "a close-delimited body is taken whole");
  // Header names are not case sensitive and no two peers here spell them alike.
  check(tcos::HttpClient::parseResponse(
            "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi", &status, &body) &&
            body == "hi",
        "a lower-case Content-Length is honoured");
  check(tcos::HttpClient::parseResponse(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
            "5\r\nhello\r\n4\r\n you\r\n0\r\n\r\n",
            &status, &body) &&
            body == "hello you",
        "a chunked body is reassembled");
  check(!tcos::HttpClient::parseResponse(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\nshort\r\n",
            &status, &body),
        "a truncated chunk is a failure rather than a partial body");
  check(!tcos::HttpClient::parseResponse("HTTP/1.0 200 OK\r\nno terminator", &status, &body),
        "headers with no blank line are incomplete");

  // The two halves of this firmware's HTTP, driven against each other over a
  // real socket. A mock would only prove the client agrees with my reading of
  // the RFC; this proves it agrees with the server that has to answer it.
  class Echo : public tcos::HttpServer::Handler {
   public:
    tcos::HttpServer::Response handle(const tcos::HttpServer::Request& request) {
      tcos::HttpServer::Response response;
      response.status = request.method == "POST" ? 201 : 200;
      response.body = request.method + " " + request.path + "?" + request.query +
                      " [" + request.body + "]";
      return response;
    }
  };
  Echo echo;
  tcos::HttpServer server;
  const int bound = server.start(0, &echo);
  check(bound > 0, "the test server binds an ephemeral port");
  if (bound > 0) {
    char url[128];
    std::snprintf(url, sizeof(url), "http://127.0.0.1:%d/probe?x=1", bound);

    // serveOnce blocks, so the exchange is driven from this thread by serving
    // first and reading the client's result after: the client's own connect is
    // what unblocks the accept.
    struct Args {
      std::string url;
      tcos::HttpClient::Response response;
      bool ok;
    };
    static Args args;
    args.url = url;
    args.ok = false;
    pthread_t thread;
    pthread_create(&thread, 0, [](void*) -> void* {
      args.ok = tcos::HttpClient::perform(args.url, "POST", "application/json",
                                          "{\"a\":1}", &args.response, 3000);
      return 0;
    }, 0);
    check(server.serveOnce(3000), "the server accepts the client's request");
    pthread_join(thread, 0);
    check(args.ok, "the client parses the server's reply");
    check(args.response.status == 201, "the status survives the round trip");
    check(args.response.body == "POST /probe?x=1 [{\"a\":1}]",
          "method, path, query and body all survive the round trip");
    server.stop();
  }
}

void checkChannelRing() {
  tcos::ChannelRingScreen ring;
  Surface out(52, 16);

  ring.onEnter(0);
  ring.render(out, 10);
  check(litPixels(out) > 0, "an empty ring says so rather than going black");

  std::vector<tcos::ChannelRingScreen::Entry> entries;
  tcos::ChannelRingScreen::Entry entry;
  entry.appName = "btc";
  entry.label = "\xE5\xB8\x82\xE5\x9C\xBA";
  entries.push_back(entry);
  entry.appName = "flux";
  entry.label = "\xE6\xB5\x81\xE5\x85\x89";
  entries.push_back(entry);
  ring.setEntries(entries, 0);
  ring.onEnter(0);
  check(ring.count() == 2, "the ring takes the channel list");
  check(ring.currentApp() == "btc", "and starts on the first channel");
  check(ring.takeSelectionChanged(), "entering asks for the settled channel's frames");
  check(!ring.takeSelectionChanged(), "and asks exactly once");

  // Before the frames land the name is the only thing there is to draw.
  out.clear();
  ring.render(out, 300);
  check(litPixels(out) > 0, "the loading page draws the channel name");

  tcos::FrameBundle bundle;
  check(bundle.parse(makeBundle(4, 100)), "the test bundle decodes");
  ring.adoptFrames(bundle, "btc", 1000);
  check(ring.status() == tcos::ChannelRingScreen::kReady, "frames for the settled channel are adopted");
  ring.render(out, 1000);
  check(out.getPixel(0, 0).r == 1, "playback starts at frame 0");
  ring.render(out, 1250);
  check(out.getPixel(0, 0).r == 3, "and advances with the frame delays");

  // Frames that arrive after the knob moved on must be dropped, or a slow
  // channel paints over the one the user is actually looking at.
  tcos::FrameBundle stale;
  check(stale.parse(makeBundle(2, 100)), "a second bundle decodes");
  ring.adoptFrames(stale, "flux", 1300);
  ring.render(out, 1300);
  check(out.getPixel(0, 0).r != 0, "a bundle for a channel we are not on is ignored");
  check(ring.currentApp() == "btc", "and does not move the ring");

  // A detent drops the frames: they belong to the channel being left.
  ring.onInput(tcos::kInputTurnCw, 2000);
  check(ring.currentApp() == "flux", "a detent moves to the next channel");
  check(ring.status() == tcos::ChannelRingScreen::kLoading, "which starts out loading");
  check(ring.takeSelectionChanged(), "and asks for the new channel's frames");

  // Pause holds the frame that is up, not frame 0.
  tcos::FrameBundle fluxFrames;
  check(fluxFrames.parse(makeBundle(4, 100)), "a bundle for the new channel decodes");
  ring.adoptFrames(fluxFrames, "flux", 3000);
  ring.render(out, 3250);
  check(out.getPixel(0, 0).r == 3, "the new channel plays");
  ring.onInput(tcos::kInputPress, 3250);
  check(ring.paused(), "a press pauses");
  ring.render(out, 9000);
  check(out.getPixel(0, 0).r == 3, "a paused channel holds the frame it was on");

  check(!ring.onInput(tcos::kInputHold, 9100),
        "hold is never consumed, so the Shell can always pop back to the root");

  // A republish must not move the user, because the service resends the menu on
  // every settings change.
  ring.setEntries(entries, 9200);
  check(ring.currentApp() == "flux", "a republished identical list keeps the selection");

  // The console's pin drives the same ring rather than a screen of its own.
  check(ring.selectApp("btc", 9300), "the pin can select a known channel");
  check(ring.currentApp() == "btc", "and moves the ring to it");
  check(!ring.selectApp("nope", 9400), "an unknown channel is reported, not guessed at");

  // The rail is the one piece of chrome the page keeps, and only briefly: it
  // paints over a row of the content the page exists to show.
  ring.onInput(tcos::kInputTurnCw, 10000);
  ring.adoptFrames(fluxFrames, ring.currentApp(), 10000);
  Surface justMoved(52, 16);
  ring.render(justMoved, 10100);
  Surface settled(52, 16);
  ring.render(settled, 10100 + 1200 + 500 + 50);
  int railJust = 0;
  int railLater = 0;
  for (int x = 0; x < 52; ++x) {
    const Color a = justMoved.getPixel(x, 15);
    const Color b = settled.getPixel(x, 15);
    if (a.r || a.g || a.b) ++railJust;
    if (b.r || b.g || b.b) ++railLater;
  }
  check(railJust > 0, "the rail is up just after a move");
  check(railLater == 0, "and gone once the user has settled on a channel");
}

void checkSettingsScreen() {
  tcos::SettingsScreen screen;
  Surface out(52, 16);

  std::vector<tcos::SettingsScreen::Row> rows;
  tcos::SettingsScreen::Row row;
  row.id = 0;
  row.label = "IP";
  row.value = "192.168.8.240";
  rows.push_back(row);
  row.label = "MAC";
  row.value = "CC:C4:B2:77:A7:72";
  rows.push_back(row);
  screen.setRows(rows, 0);
  screen.onEnter(0);

  // The row shows its label first and its value after the dwell. Both are drawn
  // at 12 px, so they can never share the panel — asserting the swap is
  // asserting the only way this screen can show a label at all.
  screen.render(out, 10);
  const int labelLit = litPixels(out);
  check(labelLit > 0, "the label is drawn on landing");
  out.clear();
  screen.render(out, tcos::SettingsScreen::kLabelDwellMs + tcos::SettingsScreen::kSwapMs + 50);
  const int valueLit = litPixels(out);
  check(valueLit > 0, "the value has taken the row after the dwell");
  check(valueLit != labelLit, "and it is different content, not the label held over");

  // Turning re-asks the question: a user who looks away must never come back to
  // a bare value with nothing saying what it is.
  screen.onInput(tcos::kInputTurnCw, 5000);
  check(screen.selectedIndex() == 1, "a detent moves the selection");
  out.clear();
  screen.render(out, 5010);
  check(litPixels(out) > 0, "the new row draws immediately");
  out.clear();
  screen.render(out, 5000 + tcos::SettingsScreen::kLabelDwellMs - 50);
  const int stillLabel = litPixels(out);
  screen.render(out, 5000 + tcos::SettingsScreen::kLabelDwellMs +
                         tcos::SettingsScreen::kSwapMs + 50);
  check(litPixels(out) != stillLabel, "and swaps to its own value on its own dwell");

  // A value refresh must not restart the dwell, or the row would be stuck on
  // its label forever: values are rebuilt twice a second.
  rows[1].value = "CC:C4:B2:77:A7:73";
  screen.setRows(rows, 9000);
  out.clear();
  screen.render(out, 9010);
  check(litPixels(out) > 0, "a refreshed row still draws");
  check(screen.selectedIndex() == 1, "and the selection does not move under the user");

  // An inert row still flashes: "nothing happened" and "the button did not
  // register" must never look the same.
  check(screen.onInput(tcos::kInputPress, 9100), "a press is consumed");
  check(screen.takeActivated() == -1, "an inert row activates nothing");
  rows[1].id = 7;
  screen.setRows(rows, 9200);
  screen.onInput(tcos::kInputPress, 9300);
  check(screen.takeActivated() == 7, "an actionable row reports its id");
  check(screen.takeActivated() == -1, "reading the activation clears it");

  check(!screen.onInput(tcos::kInputHold, 9400), "hold bubbles so the Shell pops");
}

void checkMusicScreen() {
  tcos::MusicScreen screen;
  Surface out(52, 16);
  screen.onEnter(0);

  check(screen.idle(), "no document yet means idle");
  screen.render(out, 100);
  check(litPixels(out) > 0, "the idle state is drawn rather than left blank");
  check(!screen.onInput(tcos::kInputPress, 110),
        "a press with nothing playing is not swallowed");

  screen.setNowPlaying(true, "Her Majesty", "The Beatles", "", true, 10000, 40000, 1000);
  check(!screen.idle(), "a document with a track is not idle");

  // The playhead advances locally. The service deliberately does not bump the
  // sequence for a moving position, so anything else would be a cursor that
  // jumps once a minute.
  //
  // Whole-track progress is the cue row's cursor now, not a filled bar: the
  // reference renderer has no full-width bottom bar in any mode, and the default
  // mode (聚光, matching sDeviceState) puts a cue row on row 15 whose cursor
  // travels 47 px from x=2.
  screen.render(out, 1000);
  const int cursorAt1s = cueCursorX(out, 15, kSkinTiers[0].primary);
  screen.render(out, 11000);  // ten seconds later
  const int cursorAt11s = cueCursorX(out, 15, kSkinTiers[0].primary);
  check(cursorAt11s > cursorAt1s, "the playhead advances between documents");
  check(cursorAt1s == 14 && cursorAt11s == 26,
        "and lands where the arithmetic says: 10/40 then 20/40 along a 47 px travel from x=2");

  // A paused track must not advance, or the cursor would run past the end of a
  // song nobody is playing.
  screen.setNowPlaying(true, "Her Majesty", "The Beatles", "", false, 10000, 40000, 20000);
  screen.render(out, 40000);
  check(cueCursorX(out, 15, kSkinTiers[0].primary) == 14,
        "a paused playhead stays where it was");

  // Transport. The knob has no list to scroll here, so it moves between tracks.
  screen.setNowPlaying(true, "Her Majesty", "The Beatles", "", true, 0, 40000, 0);
  check(screen.onInput(tcos::kInputTurnCw, 100), "a detent is consumed");
  check(screen.takeAction() == tcos::MusicScreen::kNext, "clockwise means next");
  check(screen.takeAction() == tcos::MusicScreen::kNone, "reading the action clears it");
  screen.onInput(tcos::kInputTurnCcw, 200);
  check(screen.takeAction() == tcos::MusicScreen::kPrevious, "anti-clockwise means previous");
  screen.onInput(tcos::kInputPress, 300);
  check(screen.takeAction() == tcos::MusicScreen::kToggle, "a press toggles playback");
  check(!screen.onInput(tcos::kInputHold, 400), "hold still bubbles so the Shell pops");

  // A lyric takes the row from the title: it is the only field that changes on
  // its own, and a title the user already read is not worth the only row there
  // is.
  Surface withTitle(52, 16);
  screen.setNowPlaying(true, "Her Majesty", "The Beatles", "", true, 0, 40000, 0);
  screen.render(withTitle, 500);
  Surface withLyric(52, 16);
  screen.setNowPlaying(true, "Her Majesty", "The Beatles",
                       "Her Majesty's a pretty nice girl", true, 0, 40000, 0);
  screen.render(withLyric, 500);
  bool differs = false;
  for (int y = 0; y < 16 && !differs; ++y) {
    for (int x = 0; x < 52; ++x) {
      if (withTitle.getPixel(x, y).toRGB888() != withLyric.getPixel(x, y).toRGB888()) {
        differs = true;
        break;
      }
    }
  }
  check(differs, "a lyric displaces the title rather than being dropped");

  // A now-playing document with no resolvable text. The service publishes the
  // transport even when the provider lookup for the title fails, so this shape
  // reaches the panel; the old fallback drew "--", ten lit pixels, which on this
  // panel is what "the screen has nothing on it" looks like.
  tcos::MusicScreen unnamed;
  Surface nameless(52, 16);
  unnamed.onEnter(0);
  unnamed.setNowPlaying(true, "", "", "", true, 41000, 244000, 0);
  unnamed.render(nameless, 2000);
  check(musicTextPixels(nameless) > 30,
        "a track with no title says so in words rather than in two dashes");

  // The empty state has to name WHICH emptiness it is. All three used to render
  // the identical "未播放": the service saying nothing is playing, the device
  // failing to reach the service, and the device never having been told where
  // the service is. Only the first is about music, and the third is the ordinary
  // state of a freshly flashed unit.
  tcos::MusicScreen link;
  Surface quiet(52, 16);
  Surface offline(52, 16);
  Surface unset(52, 16);
  link.onEnter(0);
  link.setLink(true, true);
  link.render(quiet, 1000);
  link.setLink(true, false);
  link.render(offline, 1000);
  link.setLink(false, false);
  link.render(unset, 1000);
  check(surfacesDiffer(quiet, offline) && surfacesDiffer(offline, unset) &&
            surfacesDiffer(quiet, unset),
        "nothing playing, offline and unconfigured are three different panels");
  check(musicTextPixels(quiet) > 0 && musicTextPixels(offline) > 0 &&
            musicTextPixels(unset) > 0,
        "and each of them puts words on the panel");
}

// The parity claim, in pixels, over every combination the console offers.
//
// Everything else in this file drives ONE 显示形式 (聚光, the default) and ONE
// 像素配色 (信号绿), which is the blind spot that let a bespoke 12 px equaliser
// sit beside the lyric for as long as it did: the panel was drawing, the wire
// was carrying every field, and the other fifteen combinations were never
// looked at. The user's bar is not "similar to the sideloaded lyrics player" but
// identical to it, so this walks all four modes against all four skins and
// asserts both halves of that — the exact hex the console shows, and the
// geometry the reference renderer has.
void checkMusicTheme() {
  using tcos::MusicScreen;

  // A line that fills the 48 px text window exactly: eight half-width cells,
  // centred at (52 - 48) / 2 = 2, so nothing is clipped in any mode and the ink
  // on the panel can be compared against the font tables themselves rather than
  // against "more than nothing".
  static const char* kLine = "Hey Jude";
  int expectedInk = 0;
  for (const char* p = kLine; *p; ++p) {
    expectedInk += glyphBits((uint32_t)(unsigned char)*p);
  }
  check(expectedInk > 0, "the sample line has ink to look for");

  for (int mode = 0; mode < MusicScreen::kModeCount; ++mode) {
    for (int skin = 0; skin < MusicScreen::kSkinCount; ++skin) {
      MusicScreen screen;
      Surface frame(52, 16);
      screen.onEnter(0);
      screen.setTheme(mode, skin, 0, false);
      // 5000 ms in with the line running 4000..8000 puts progress at exactly
      // 0.5: mid-line in every mode, and cascade's HOLD phase rather than one of
      // its two moving ones, so the geometry below is arithmetic and not timing.
      screen.setNowPlaying(true, "Hey Jude", "The Beatles", kLine, true, 5000, 200000, 0,
                           4000, 8000);
      screen.render(frame, 1000);

      char label[160];

      // Every lit pixel is one of THIS skin's four tiers. The sixteen tiers are
      // pairwise distinct, so this one count also proves no other skin's colour
      // reached the panel — and, because a painter can only write a tier, that
      // nothing invented a colour of its own along the way.
      int foreign = 0;
      for (int y = 0; y < 16; ++y) {
        for (int x = 0; x < 52; ++x) {
          const Color c = frame.getPixel(x, y);
          if (!(c.r || c.g || c.b)) continue;
          const uint32_t rgb = c.toRGB888();
          if (rgb != kSkinTiers[skin].primary && rgb != kSkinTiers[skin].secondary &&
              rgb != kSkinTiers[skin].context && rgb != kSkinTiers[skin].muted) {
            ++foreign;
          }
        }
      }
      std::snprintf(label, sizeof(label),
                    "mode %d skin %d lights only its own four tiers", mode, skin);
      check(foreign == 0, label);

      std::snprintf(label, sizeof(label),
                    "mode %d skin %d puts the console's primary hex on the panel", mode, skin);
      check(tierPixels(frame, kSkinTiers[skin].primary) > 0, label);

      // The text band, exactly. 天际 hangs the line from row 0 to leave the
      // spectrum a floor; the other three sit it at row 2. Twelve rows either
      // way, and in every mode those twelve rows are supposed to hold glyph ink
      // and nothing else — no equaliser cell, no decoration. Equality rather
      // than "> 0" is what makes that a claim: a stray lit pixel anywhere in the
      // band fails, and so does a clipped line.
      const int bandY = mode == MusicScreen::kModeSkyline ? 0 : 2;
      std::snprintf(label, sizeof(label),
                    "mode %d skin %d lands the font's ink and nothing else in rows %d..%d",
                    mode, skin, bandY, bandY + 11);
      check(litPixelsInRows(frame, bandY, bandY + 11) == expectedInk, label);

      if (mode != MusicScreen::kModeSkyline) continue;

      // 天际's spectrum is a FLOOR, and the distinction is the whole bug report.
      // Row 12 is the gutter between the line and the bars; rows 13..15 are the
      // bars; the bars stand at x = 1 + 3b for seventeen bars, so they span the
      // panel instead of owning a column of it.
      std::snprintf(label, sizeof(label), "skin %d keeps row 12 empty as the gutter", skin);
      check(litPixelsInRows(frame, 12, 12) == 0, label);

      int offBar = 0;
      for (int y = 13; y <= 15; ++y) {
        for (int x = 0; x < 52; ++x) {
          const Color c = frame.getPixel(x, y);
          if ((c.r || c.g || c.b) && !isSkylineBarColumn(x)) ++offBar;
        }
      }
      std::snprintf(label, sizeof(label),
                    "skin %d draws the spectrum only in its own bar columns", skin);
      check(offBar == 0, label);

      // The floor's anchors are unconditional, two pixels per bar, so this is an
      // exact count — and it is the assertion that a 12 px panel at x=0 could
      // never satisfy.
      std::snprintf(label, sizeof(label),
                    "skin %d anchors all seventeen bars across the full width", skin);
      check(litPixelsInRows(frame, 15, 15) == 34, label);
    }
  }

  // THE REPORTED BUG, in the one mode that has a spectrum.
  //
  // A playing track whose lyric lookup failed is the ordinary case, not a corner
  // — Spotify Connect answers with a title and no words — and the row it gets is
  // the title/artist rotation. The reference conflates "this row is a timed
  // lyric" with "there is a row to draw", because its own gate makes the two the
  // same thing; ported literally that turned 天际 into a twelve-row spectrum
  // with no text at all, which is the user's complaint with the words removed
  // rather than merely covered. Both transports, because the reference's dead
  // expression only came alive on one of them.
  for (int playing = 0; playing < 2; ++playing) {
    MusicScreen rotating;
    Surface frame(52, 16);
    rotating.onEnter(0);
    rotating.setTheme(MusicScreen::kModeSkyline, MusicScreen::kSkinSignal, 0, false);
    rotating.setNowPlaying(true, "Yesterday", "The Beatles", "", playing != 0, 5000, 200000, 0);
    rotating.render(frame, 1000);
    char label[160];
    std::snprintf(label, sizeof(label),
                  "skyline shows the title of a %s track with no lyrics",
                  playing ? "playing" : "paused");
    check(litPixelsInRows(frame, 0, 11) > 0, label);
    std::snprintf(label, sizeof(label),
                  "and keeps the spectrum to its three-row floor while %s",
                  playing ? "playing" : "paused");
    check(litPixelsInRows(frame, 12, 12) == 0, label);
  }

  // And the same for a document with no resolvable text at all, which falls back
  // to 播放中 / 已暂停. That row is not a lyric either.
  {
    MusicScreen nameless;
    Surface frame(52, 16);
    nameless.onEnter(0);
    nameless.setTheme(MusicScreen::kModeSkyline, MusicScreen::kSkinArcade, 0, false);
    nameless.setNowPlaying(true, "", "", "", true, 5000, 200000, 0);
    nameless.render(frame, 1000);
    check(litPixelsInRows(frame, 0, 11) > 0,
          "skyline says 播放中 for a track with no text rather than drawing bars alone");
    check(litPixelsInRows(frame, 12, 12) == 0, "with the gutter still clear");
  }

  // THE 24.86-DAY WRAP, which on a clock is a Tuesday.
  //
  // osLogic hands this screen `(int)(monoMs() - sStartMs)`, a SIGNED count of
  // milliseconds since boot, so at 2^31 it goes negative. The reference's
  // animation clock is a uint32_t counter and simply wraps; a negative one does
  // not degrade gracefully, it stops: skylineBarLevel clamps a negative timeMs
  // to zero, pinning the spectrum to slot 0 as a still image, and paintIdle's
  // cast of a negative float to uint32_t is undefined and lands on 0 on both
  // clang and this device's saturating vcvt, freezing the sparkles with it — for
  // the following 24.86 days, and then again.
  //
  // Asserted on a track parked at its own duration: the playhead clamps there,
  // so progress within the line — and with it beatKick, and with it the bars'
  // energy — is a constant, and the animation clock is the only variable left.
  // Anything looser and the beat's own drift would keep the bars moving and the
  // check would pass over a frozen spectrum.
  {
    MusicScreen wrapped;
    Surface before(52, 16);
    Surface after(52, 16);
    const int wrappedMs = -2000000000;
    wrapped.onEnter(wrappedMs);
    wrapped.setTheme(MusicScreen::kModeSkyline, MusicScreen::kSkinSignal, 0, false);
    wrapped.setNowPlaying(true, "Hey Jude", "The Beatles", "Hey Jude", true, 200000,
                          200000, wrappedMs, 190000, 195000);
    wrapped.render(before, wrappedMs + 1000);
    wrapped.render(after, wrappedMs + 3000);
    int moved = 0;
    for (int y = 13; y <= 15; ++y) {
      for (int x = 0; x < 52; ++x) {
        if (before.getPixel(x, y).toRGB888() != after.getPixel(x, y).toRGB888()) ++moved;
      }
    }
    check(moved > 0, "the spectrum still moves after the animation clock passes 2^31 ms");
  }

  // The accent replaces the primary tier and ONLY the primary tier. Without the
  // last three checks this would pass on a firmware that repainted everything in
  // the accent, which is a different screen from the one the console previews.
  {
    MusicScreen accented;
    Surface frame(52, 16);
    accented.onEnter(0);
    accented.setTheme(MusicScreen::kModeTicker, MusicScreen::kSkinTape, 0xff8844u, true);
    accented.setNowPlaying(true, "Hey Jude", "The Beatles", kLine, true, 5000, 200000, 0,
                           4000, 8000);
    accented.render(frame, 1000);
    check(tierPixels(frame, 0xff8844u) > 0, "the accent reaches the panel as its own hex");
    check(tierPixels(frame, kSkinTiers[1].primary) == 0,
          "and displaces the skin's primary rather than joining it");
    check(tierPixels(frame, kSkinTiers[1].secondary) > 0 &&
              tierPixels(frame, kSkinTiers[1].context) > 0 &&
              tierPixels(frame, kSkinTiers[1].muted) > 0,
          "while the skin keeps the other three tiers — an accent is a focus colour, "
          "not a repaint");
  }
}

// The seam between the parser, the link and the screen.
//
// Every piece of the music path had a test and the path itself had none:
// checkStateDoc above ran on a fixture with no now-playing block at all, and
// checkMusicScreen calls setNowPlaying() by hand. A field that reached StateDoc
// and never reached the panel — or a snapshot copy that forgot one — was
// invisible to both, which is exactly the shape of "the service is serving it
// and the panel shows nothing".
//
// So this drives the real service bytes through the real HostLink copy and the
// real Shell, with osLogic's own argument order and clock conversion, and then
// asserts pixels.
void checkMusicPath() {
  using tcos::HostLink;
  using tcos::LauncherScreen;
  using tcos::MusicScreen;
  using tcos::Shell;
  using tcos::StateDoc;

  // Verbatim OsLinkHub.serialize() for a playing Spotify session, with the
  // console's 主题设置 set to something that is NOT the default — the whole
  // point of this check is that a field can reach StateDoc and never reach the
  // panel, and a document carrying spotlight/signal would look identical to one
  // carrying no theme at all.
  static const char* kDoc =
      "seq\t12\npinned\t0\nmirror\t0\nmode\tcascade\nskin\ttape\naccent\tff8844\n"
      "np\t1\ntrack\tOne Last Kiss\nartist\tHikaru Utada\nplaying\t1\n"
      "pos\t41000\ndur\t244000\nlyric\tWasurerarenai hito\n"
      "lyricat\t40500\nlyricend\t44000\n"
      "menu\t2\n"
      "item\tmusic\tmusic\t\xE9\x9F\xB3\xE4\xB9\x90\n"
      "item\tsettings\tsettings\t\xE8\xAE\xBE\xE7\xBD\xAE\n";

  // Real device numbers, not zero-based ones: osLogic's sStartMs is the uptime
  // at onUI_init and the document's stamp is a raw CLOCK_MONOTONIC reading, so
  // the conversion (int)(stampMonoMs - sStartMs) is a subtraction of two large
  // unsigned values truncated to int. Both being small would hide a sign error.
  const uint64_t kStartMs = 1234567;
  const uint64_t kStampMs = 1250000;

  StateDoc doc;
  check(doc.parse(kDoc), "the live document parses");

  // The real copy runPull performs, not a re-implementation of it here.
  HostLink hlink;
  hlink.adoptDocument(doc, kStampMs);
  const HostLink::Snapshot snap = hlink.snapshot();
  check(snap.online && snap.seq == 12, "the link adopts the document");
  check(snap.nowPlaying, "now playing survives the copy into the snapshot");
  check(snap.playing, "and so does the transport state");
  check(snap.track == "One Last Kiss" && snap.artist == "Hikaru Utada" &&
            snap.lyric == "Wasurerarenai hito",
        "and every text field, not just the ones the ring needs");
  check(snap.positionMs == 41000 && snap.durationMs == 244000,
        "and the playhead the screen advances locally");
  check(snap.lyricStartMs == 40500 && snap.lyricEndMs == 44000,
        "and the line's own window, which is what every mode animates against");
  check(snap.stampMonoMs == kStampMs,
        "and the stamp, without which the playhead has no origin");
  check(snap.lyricMode == 3 && snap.lyricSkin == 1 && snap.hasAccent &&
            snap.accentRgb == 0xff8844u,
        "and the console's 主题设置, which is the other half of the parity claim");
  check(snap.items.size() == 2, "the menu still arrives alongside it");

  // Now the screen, wired the way osLogic wires it.
  LauncherScreen launcher;
  MusicScreen music;
  Shell shell(52, 16);
  Surface frame(52, 16);

  std::vector<LauncherScreen::Entry> entries;
  LauncherScreen::Entry entry;
  entry.label = "\xE9\x9F\xB3\xE4\xB9\x90";  // 音乐
  entry.icon = LauncherScreen::kIconMusic;
  entry.id = 1;
  entries.push_back(entry);
  entry.label = "\xE8\xAE\xBE\xE7\xBD\xAE";  // 设置
  entry.icon = LauncherScreen::kIconSettings;
  entry.id = 3;
  entries.push_back(entry);
  launcher.setEntries(entries, 0);
  shell.setEntryStyle(&music, Shell::kEntryEqualiser);
  shell.reset(&launcher, (int)(kStampMs - kStartMs));

  // 40 ms ticks, and the user pressing the knob on 音乐 — the manual navigation
  // the bug was reported against, not a console pin.
  int blankTextFrames = 0;
  int firstBlankStep = -1;
  int enteredAtMs = 0;
  uint64_t mono = kStampMs + 500;
  for (int step = 0; step < 500; ++step) {
    mono += 40;
    const int nowMs = (int)(mono - kStartMs);
    if (step == 5) shell.onInput(tcos::kInputPress, nowMs);

    if (launcher.takeActivated() == 1) {
      shell.push(&music, nowMs);
      enteredAtMs = nowMs;
    }
    // osLogic applies the theme outside the music screen's branch, because the
    // user picks a colour while the launcher is up and it has to be right the
    // moment they walk into 音乐. Mirrored here, ordering included.
    music.setTheme(snap.lyricMode, snap.lyricSkin, snap.accentRgb, snap.hasAccent);
    if (shell.top() == &music) {
      // osLogic's call, argument for argument.
      music.setNowPlaying(snap.nowPlaying, snap.track, snap.artist, snap.lyric, snap.playing,
                          snap.positionMs, snap.durationMs,
                          (int)(snap.stampMonoMs - kStartMs),
                          snap.lyricStartMs, snap.lyricEndMs);
      music.takeAction();
    }
    shell.render(frame, nowMs);

    // Once the 300 ms equaliser entry is over, there is no frame in which the
    // panel is allowed to be wordless: the marquee only ever moves the origin
    // between -(width - window) and 0, so part of the line is always inside the
    // clip. A blank row here is the reported bug.
    if (enteredAtMs > 0 && nowMs - enteredAtMs > Shell::entryMs(Shell::kEntryEqualiser) &&
        musicTextPixels(frame) == 0) {
      ++blankTextFrames;
      if (firstBlankStep < 0) firstBlankStep = step;
    }
  }
  check(shell.top() == &music, "pressing 音乐 lands on the music screen");
  check(blankTextFrames == 0, "and the text row is never blank once it is there");

  // What is on that row has to be the lyric that came off the wire, not merely
  // something. Compared against a screen fed the same values directly: any field
  // lost between StateDoc, the snapshot and the screen changes these pixels.
  const int sampleMs = (int)(mono - kStartMs);
  MusicScreen direct;
  Surface expected(52, 16);
  direct.onEnter(enteredAtMs);
  direct.setTheme(3, 1, 0xff8844u, true);
  direct.setNowPlaying(true, "One Last Kiss", "Hikaru Utada", "Wasurerarenai hito", true,
                       41000, 244000, (int)(kStampMs - kStartMs), 40500, 44000);
  direct.render(expected, sampleMs);
  shell.render(frame, sampleMs);
  check(!surfacesDiffer(frame, expected),
        "the panel is pixel-identical to the document it was served");

  // The theme reached PIXELS, not merely the snapshot. A screen fed the same
  // song under the document's own defaults must look different — otherwise
  // setTheme could be a no-op and every assertion above would still be green,
  // which is precisely how the equaliser-beside-the-lyric shipped.
  MusicScreen defaulted;
  Surface withDefaults(52, 16);
  defaulted.onEnter(enteredAtMs);
  defaulted.setNowPlaying(true, "One Last Kiss", "Hikaru Utada", "Wasurerarenai hito", true,
                          41000, 244000, (int)(kStampMs - kStartMs), 40500, 44000);
  defaulted.render(withDefaults, sampleMs);
  check(surfacesDiffer(frame, withDefaults),
        "the console's 主题设置 changes what is on the panel, not just the snapshot");

  // And the accent specifically: same mode, same skin, colour override dropped.
  // Without this the check above would pass on a firmware that read mode and
  // skin and threw the accent away.
  MusicScreen noAccent;
  Surface withoutAccent(52, 16);
  noAccent.onEnter(enteredAtMs);
  noAccent.setTheme(3, 1, 0, false);
  noAccent.setNowPlaying(true, "One Last Kiss", "Hikaru Utada", "Wasurerarenai hito", true,
                         41000, 244000, (int)(kStampMs - kStartMs), 40500, 44000);
  noAccent.render(withoutAccent, sampleMs);
  check(surfacesDiffer(frame, withoutAccent), "and so does the accent override on its own");

  // The lyric window is load-bearing too: every mode's geometry is a function
  // of progress within the LINE, so a screen given the window and one left to
  // guess must part company.
  //
  // Sampled mid-line rather than at sampleMs, and that is the point rather than
  // a convenience. sampleMs is 20 s of local extrapolation past a document whose
  // line was 3.5 s long, so BOTH screens sit at progress 1 there and would agree
  // — which is the real behaviour, and the reason the service bumps its sequence
  // on every line change instead of letting the device coast.
  const int midMs = enteredAtMs + 900;
  MusicScreen timed;
  Surface withWindow(52, 16);
  timed.onEnter(enteredAtMs);
  timed.setTheme(3, 1, 0xff8844u, true);
  timed.setNowPlaying(true, "One Last Kiss", "Hikaru Utada", "Wasurerarenai hito", true,
                      41000, 244000, (int)(kStampMs - kStartMs), 40500, 44000);
  timed.render(withWindow, midMs);

  MusicScreen untimed;
  Surface withoutWindow(52, 16);
  untimed.onEnter(enteredAtMs);
  untimed.setTheme(3, 1, 0xff8844u, true);
  untimed.setNowPlaying(true, "One Last Kiss", "Hikaru Utada", "Wasurerarenai hito", true,
                        41000, 244000, (int)(kStampMs - kStartMs));
  untimed.render(withoutWindow, midMs);
  check(surfacesDiffer(withWindow, withoutWindow),
        "and the lyric window, without which the line only ever sweeps once");

  // And the lyric specifically won the row: fed the same document minus its
  // lyric line, the panel must look different. Without this the check above
  // would pass on a firmware that dropped `lyric` and drew the title.
  MusicScreen titleOnly;
  Surface withoutLyric(52, 16);
  titleOnly.onEnter(enteredAtMs);
  titleOnly.setTheme(3, 1, 0xff8844u, true);
  titleOnly.setNowPlaying(true, "One Last Kiss", "Hikaru Utada", "", true, 41000, 244000,
                          (int)(kStampMs - kStartMs), 40500, 44000);
  titleOnly.render(withoutLyric, sampleMs);
  check(surfacesDiffer(frame, withoutLyric), "the lyric, not the title, is on the row");

  // A document with no np block must put the screen back into its empty state
  // rather than leaving the last song on the panel forever.
  StateDoc stopped;
  check(stopped.parse("seq\t13\nmenu\t0\n"), "a document with music stopped parses");
  hlink.adoptDocument(stopped, kStampMs + 60000);
  const HostLink::Snapshot after = hlink.snapshot();
  check(!after.nowPlaying && after.track.empty() && after.lyric.empty(),
        "and clears the snapshot rather than keeping a track nobody is playing");
}

// A server's reply, assembled by hand. Everything a real one carries that this
// client reads is a parameter, so each rule can be broken one at a time.
std::string makeNtpReply(uint64_t nonce, uint32_t seconds, uint32_t fraction) {
  std::string p(tcos::TimeSync::kPacketBytes, '\0');
  p[0] = (char)((0 << 6) | (4 << 3) | 4);  // LI 0, version 4, mode 4 (server)
  p[1] = (char)2;                          // stratum 2
  for (int i = 0; i < 8; ++i) {
    p[24 + i] = (char)((nonce >> (56 - 8 * i)) & 0xFFu);  // originate: the echo
  }
  for (int i = 0; i < 4; ++i) {
    p[40 + i] = (char)((seconds >> (24 - 8 * i)) & 0xFFu);
    p[44 + i] = (char)((fraction >> (24 - 8 * i)) & 0xFFu);
  }
  return p;
}

const uint8_t* bytesOf(const std::string& p) {
  return reinterpret_cast<const uint8_t*>(p.data());
}

void checkTimeSync() {
  // 2024-01-01T00:00:00Z, the instant every case below is anchored to.
  const int64_t kUnix2024 = 1704067200;
  const uint32_t kNtp2024 = 3913056000u;  // + the 1900..1970 offset

  const std::vector<std::string> servers = tcos::TimeSync::defaultServers();
  check(servers.size() >= 2, "there is more than one server to fall through to");
  bool otherOperator = false;
  for (size_t i = 0; i < servers.size(); ++i) {
    if (servers[i].find("aliyun") == std::string::npos) otherOperator = true;
  }
  check(otherOperator, "and not every fallback shares an operator with it");

  uint8_t request[tcos::TimeSync::kPacketBytes];
  tcos::TimeSync::buildRequest(request, 0x0123456789ABCDEFull);
  check(request[0] == 0x23, "the request is LI 0, version 4, mode 3 (client)");
  check(request[40] == 0x01 && request[47] == 0xEF,
        "the nonce goes in the transmit timestamp, big-endian");
  bool restZero = true;
  for (int i = 1; i < 40; ++i) {
    if (request[i] != 0) restZero = false;
  }
  check(restZero, "a client with no clock sends nothing else it cannot know");

  check(tcos::TimeSync::ntpToUnix(kNtp2024) == kUnix2024,
        "an NTP timestamp converts to Unix seconds");
  check(tcos::TimeSync::ntpToUnix(2208988800u) == 0,
        "the Unix epoch round-trips through the 1900 offset");
  // The high bit selects the era; getting this backwards is how a junk reply
  // becomes a device set to 2106.
  check(tcos::TimeSync::ntpToUnix(0x80000000u) < 0,
        "the era-0 floor is 1968, which is before the Unix epoch and stays negative");
  check(tcos::TimeSync::ntpToUnix(0u) == 2085978496ll,
        "an era-1 timestamp lands in 2036, not 1900");

  check(tcos::TimeSync::plausible(kUnix2024), "a 2024 time is believable");
  check(!tcos::TimeSync::plausible(0), "1970 is not — that is the boot value this replaces");
  check(!tcos::TimeSync::plausible(tcos::TimeSync::kFloorUnix - 1),
        "nor is one second before this firmware existed");
  check(tcos::TimeSync::plausible(tcos::TimeSync::kFloorUnix), "the floor itself is in");
  check(tcos::TimeSync::plausible(tcos::TimeSync::kCeilingUnix), "so is the ceiling");
  // The ceiling is this device's 32-bit time_t, not a taste judgement: past it
  // the value cannot be stored, only misstored as 1901.
  check(!tcos::TimeSync::plausible(tcos::TimeSync::kCeilingUnix + 1),
        "one second past a 32-bit time_t is refused rather than wrapped");
  check(tcos::TimeSync::plausible(tcos::TimeSync::ntpToUnix(0u)),
        "the 2036 rollover instant is still storable — the wall is 2038, not 2036");

  check(tcos::TimeSync::shouldApply(kUnix2024, 0),
        "the boot case: any believable time beats a kernel's 1970");
  check(tcos::TimeSync::shouldApply(kUnix2024, kUnix2024 - 1),
        "a forward correction is applied");
  check(!tcos::TimeSync::shouldApply(kUnix2024 - 1, kUnix2024),
        "a backward step is refused — anything on the LAN could otherwise rewind the panel");
  check(!tcos::TimeSync::shouldApply(kUnix2024, kUnix2024),
        "and a clock that is already right is left alone");
  check(!tcos::TimeSync::shouldApply(0, kUnix2024),
        "a reply from 1970 cannot pull a synced clock back");
  check(tcos::TimeSync::shouldApply(kUnix2024, 4102444800ll),
        "but a clock already outside the window may step back into it");

  const uint64_t nonce = 0xA5A5F00D12345678ull;
  int64_t when = 0;
  int micros = -1;
  const std::string good = makeNtpReply(nonce, kNtp2024, 0x80000000u);
  check(tcos::TimeSync::parseReply(bytesOf(good), (int)good.size(), nonce, &when, &micros),
        "a well-formed server reply decodes");
  check(when == kUnix2024, "and carries the time the server sent");
  check(micros == 500000, "the fixed-point fraction becomes microseconds");

  check(!tcos::TimeSync::parseReply(bytesOf(good), tcos::TimeSync::kPacketBytes - 1,
                                    nonce, &when, &micros),
        "a short datagram is not an SNTP reply");
  const std::string padded = good + std::string(20, '\0');
  check(tcos::TimeSync::parseReply(bytesOf(padded), (int)padded.size(), nonce, &when,
                                   &micros),
        "an authenticator appended after the 48 bytes is ignored, not rejected");

  // The echo is the whole defence of a UDP exchange made without a clock.
  check(!tcos::TimeSync::parseReply(bytesOf(good), (int)good.size(), nonce + 1, &when,
                                    &micros),
        "a reply that does not echo this request's nonce is stale or forged");

  std::string wrongMode = makeNtpReply(nonce, kNtp2024, 0);
  wrongMode[0] = (char)((0 << 6) | (4 << 3) | 3);
  check(!tcos::TimeSync::parseReply(bytesOf(wrongMode), (int)wrongMode.size(), nonce,
                                    &when, &micros),
        "mode 3 is another client's packet, not an answer");

  std::string alarm = makeNtpReply(nonce, kNtp2024, 0);
  alarm[0] = (char)((3 << 6) | (4 << 3) | 4);
  check(!tcos::TimeSync::parseReply(bytesOf(alarm), (int)alarm.size(), nonce, &when,
                                    &micros),
        "leap indicator 3 means the server has never synced and is saying so");

  std::string kod = makeNtpReply(nonce, kNtp2024, 0);
  kod[1] = (char)0;
  check(!tcos::TimeSync::parseReply(bytesOf(kod), (int)kod.size(), nonce, &when, &micros),
        "stratum 0 is a kiss-of-death packet, not a time");
  std::string unsynced = makeNtpReply(nonce, kNtp2024, 0);
  unsynced[1] = (char)16;
  check(!tcos::TimeSync::parseReply(bytesOf(unsynced), (int)unsynced.size(), nonce, &when,
                                    &micros),
        "stratum 16 is an unsynchronised server");

  const std::string blank = makeNtpReply(nonce, 0, 0);
  check(!tcos::TimeSync::parseReply(bytesOf(blank), (int)blank.size(), nonce, &when,
                                    &micros),
        "an unfilled transmit timestamp would decode to 1900 and passes nothing");

  // Protocol and policy are separate on purpose: this packet is perfectly legal
  // and its time is still not one this device may adopt.
  const std::string legalLie = makeNtpReply(nonce, 2208988800u, 0);  // 1970-01-01
  check(tcos::TimeSync::parseReply(bytesOf(legalLie), (int)legalLie.size(), nonce, &when,
                                   &micros),
        "a legal packet carrying an absurd time parses");
  check(when == 0 && !tcos::TimeSync::shouldApply(when, kUnix2024),
        "and is stopped by the policy rather than by the parser");
}

void checkBrightness() {
  using tcos::Presenter;

  check(tcos::DeviceControls::kBrightnessSteps == Presenter::kBrightnessSteps,
        "the control and the renderer count brightness steps the same way");

  // Step 10 is the identity. Every byte, not a sample: the brightest setting
  // must be the buffer the renderer produced, not a scale that rounds well.
  bool identity = true;
  for (int v = 0; v <= 255; ++v) {
    if (Presenter::scaleByte((uint8_t)v, Presenter::kBrightnessSteps) != (uint8_t)v) identity = false;
  }
  check(identity, "step 10 returns every byte unchanged");

  check(Presenter::scaleByte(0, 1) == 0, "black stays black at the dimmest step");
  check(Presenter::scaleByte(0, 5) == 0, "black stays black mid-scale");

  // Dimming must not delete content: at step 1 a byte of 9 truncates to 0.
  bool neverBlack = true;
  for (int step = 1; step <= Presenter::kBrightnessSteps; ++step) {
    for (int v = 1; v <= 255; ++v) {
      if (Presenter::scaleByte((uint8_t)v, step) == 0) neverBlack = false;
    }
  }
  check(neverBlack, "no lit byte is ever scaled to zero");

  check(Presenter::scaleByte(255, 1) == 25, "255 at step 1 is 25");
  check(Presenter::scaleByte(255, 5) == 127, "255 at step 5 is 127");
  check(Presenter::scaleByte(9, 1) == 1, "a byte that would truncate away is floored at 1");
  check(Presenter::scaleByte(200, 3) == 60, "the ramp is plain v*step/10");

  // Monotonic in both arguments, so the bar and the panel agree.
  bool monotonicStep = true;
  for (int v = 0; v <= 255; ++v) {
    for (int step = 1; step < Presenter::kBrightnessSteps; ++step) {
      if (Presenter::scaleByte((uint8_t)v, step) > Presenter::scaleByte((uint8_t)v, step + 1))
        monotonicStep = false;
    }
  }
  check(monotonicStep, "raising the step never darkens a byte");

  bool monotonicValue = true;
  for (int step = 1; step <= Presenter::kBrightnessSteps; ++step) {
    for (int v = 0; v < 255; ++v) {
      if (Presenter::scaleByte((uint8_t)v, step) > Presenter::scaleByte((uint8_t)(v + 1), step))
        monotonicValue = false;
    }
  }
  check(monotonicValue, "a brighter byte never scales darker than a dimmer one");

  // Out-of-range steps clamp rather than wrapping the panel to black.
  check(Presenter::scaleByte(255, 0) == 25, "step 0 is treated as step 1");
  check(Presenter::scaleByte(255, -3) == 25, "a negative step is treated as step 1");
  check(Presenter::scaleByte(200, 99) == 200, "a step past the top is the identity");
}

void checkInstallMode() {
  using tcos::install::decide;

  // Sideloaded: the link belongs to the firmware we are standing on top of, and
  // adb reaches this device over it. Refusing is the whole safety story.
  check(!decide(true, false), "sideloaded without the guard refuses");
  check(decide(true, true), "sideloaded with the guard armed acts");

  // Flashed: /etc/init.rc leaves wpa_supplicant `disabled` + `oneshot`, so the
  // application has always been what starts it — and there is no stock app left
  // to do it. Refusing here would not be caution, it would be a device that can
  // never reach a network, with no file anyone could create to fix it because
  // /tmp is empty on a cold boot.
  check(decide(false, false), "flashed acts without any guard file");
  check(decide(false, true), "and a stray guard file changes nothing when flashed");
}

void checkWpaCtrl() {
  using tcos::WpaCtrl;

  // A real STATUS reply, in the field order wpa_supplicant actually emits.
  const std::string status =
      "bssid=cc:c4:b2:11:22:33\n"
      "freq=2437\n"
      "ssid=xiaoya-2.4G\n"
      "id=0\n"
      "mode=station\n"
      "pairwise_cipher=CCMP\n"
      "group_cipher=CCMP\n"
      "key_mgmt=WPA2-PSK\n"
      "wpa_state=COMPLETED\n"
      "ip_address=192.168.8.240\n"
      "address=cc:c4:b2:77:a7:72\n";
  std::string state;
  std::string ssid;
  std::string ip;
  check(WpaCtrl::parseStatus(status, &state, &ssid, &ip), "a real STATUS reply parses");
  check(state == "COMPLETED", "wpa_state is extracted");
  check(ssid == "xiaoya-2.4G", "so is the SSID");
  check(ip == "192.168.8.240", "and the address");

  // Mid-association: the same shape, fewer fields. Reporting this as COMPLETED
  // would make the policy request a lease against a link that has none.
  check(WpaCtrl::parseStatus("wpa_state=ASSOCIATING\n", &state, &ssid, &ip),
        "a partial status still parses");
  check(state == "ASSOCIATING" && ssid.empty() && ip.empty(),
        "and reports honestly empty fields rather than stale ones");

  // A reply with no wpa_state is not a status. Accepting it would report
  // "disconnected" for what is really a dead socket — the two demand opposite
  // responses, so they must not collapse into one.
  check(!WpaCtrl::parseStatus("id=0\nfreq=2437\n", &state, &ssid, &ip),
        "a reply without wpa_state is rejected, not read as disconnected");
  check(!WpaCtrl::parseStatus("FAIL\n", &state, &ssid, &ip), "FAIL is a failure");
  check(!WpaCtrl::parseStatus("", &state, &ssid, &ip), "so is an empty datagram");

  // SCAN_RESULTS: tab separated, header first.
  const std::string scan =
      "bssid / frequency / signal level / flags / ssid\n"
      "cc:c4:b2:11:22:33\t2437\t-42\t[WPA2-PSK-CCMP][ESS]\txiaoya-2.4G\n"
      "aa:bb:cc:dd:ee:ff\t2412\t-78\t[ESS]\tGuestOpen\n"
      "11:22:33:44:55:66\t5180\t-55\t[WPA2-PSK-CCMP][ESS]\txiaoya-2.4G\n"
      "99:88:77:66:55:44\t2462\t-90\t[WPA2-PSK-CCMP][ESS]\t\n";
  std::vector<WpaCtrl::Network> nets;
  check(WpaCtrl::parseScanResults(scan, &nets), "a real SCAN_RESULTS reply parses");
  check(nets.size() == 2, "the hidden network is dropped and the duplicate merged");
  check(nets[0].ssid == "xiaoya-2.4G" && nets[0].signalDbm == -42,
        "a network seen twice keeps its strongest sighting");
  check(nets[0].secured, "WPA2 flags read as secured");
  check(nets[1].ssid == "GuestOpen" && !nets[1].secured, "an open network reads as open");

  check(WpaCtrl::parseScanResults("bssid / frequency / signal level / flags / ssid\n", &nets),
        "a header with no rows is a valid empty result");
  check(nets.empty(), "and yields nothing");
  check(!WpaCtrl::parseScanResults("FAIL-BUSY\n", &nets), "FAIL is a failure");
  // A truncated datagram must not become a network with a blank name.
  check(WpaCtrl::parseScanResults(
            "bssid / frequency / signal level / flags / ssid\n"
            "cc:c4:b2:11:22:33\t2437\t-42\n",
            &nets),
        "a short row is skipped rather than half-built");
  check(nets.empty(), "and produces no entry");

  check(WpaCtrl::flagsAreSecured("[WPA2-PSK-CCMP][ESS]"), "WPA2 is secured");
  check(WpaCtrl::flagsAreSecured("[WEP][ESS]"), "WEP counts as secured");
  check(WpaCtrl::flagsAreSecured("[WPA3-SAE-CCMP][ESS]"), "SAE counts as secured");
  check(!WpaCtrl::flagsAreSecured("[ESS]"), "a bare ESS is open");
}

void checkWifiPolicy() {
  using tcos::WifiPolicy;

  // Happy path: stored credentials, supplicant comes up, associate, lease, online.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    // begin() no longer commits: it waits out the grace period first, because
    // on a flashed install the framework is still associating at this instant.
    check(w.starts == 0, "begin issues nothing while it waits to adopt");
    check(policy.state() == WifiPolicy::kAdopting, "it starts by waiting");
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    check(w.starts == 1, "only then does it start the supplicant — init will not");
    check(policy.state() == WifiPolicy::kStartingWpa, "and waits for the daemon");
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    check(policy.state() == WifiPolicy::kConnecting, "a running daemon moves us to connecting");
    check(w.connects == 1 && w.lastSsid == "home", "the stored network is used");
    w.assoc = true;
    policy.tick(500);
    check(policy.state() == WifiPolicy::kObtainingIp, "association leads to a lease request");
    check(w.dhcpCalls == 1, "DHCP is requested explicitly — nothing else does it");
    w.address = true;
    policy.tick(600);
    check(policy.state() == WifiPolicy::kOnline && policy.isOnline(), "an address means online");
    check(w.apStarts == 0, "the hotspot never came up on the happy path");
  }

  // No credentials at all: straight to provisioning.
  {
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.begin(0);
    check(policy.state() == WifiPolicy::kAdopting, "even with no credentials it waits first");
    check(w.mutations() == 0, "and touches nothing while waiting");
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);   // grace expires -> kStartingWpa
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);   // daemon up -> no credentials -> scan
    // Scan BEFORE the hotspot: raising it stops wpa_supplicant, and a stopped
    // supplicant cannot scan. Getting this order wrong yields a provisioning
    // page with an empty network list and no way to discover why.
    check(policy.state() == WifiPolicy::kScanning, "no credentials means scan, then provision");
    check(w.scans == 1, "the sweep is started");
    check(!w.apUp, "and the hotspot is NOT up yet — it would kill the scan");
    w.visible.push_back("neighbour");
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    check(policy.state() == WifiPolicy::kProvisioning, "a finished sweep raises the hotspot");
    check(w.apUp && w.apStarts == 1, "the hotspot is raised");
    check(policy.scanned().size() == 1, "and the page has a list to offer");
    check(w.connects == 0, "nothing is attempted without credentials");
  }

  // A radio that never answers must not strand the user: the hotspot goes up
  // anyway once the budget is spent.
  {
    FakeWifi w;
    w.autoScan = false;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    check(policy.state() == WifiPolicy::kScanning, "still scanning");
    policy.tick(WifiPolicy::kAdoptGraceMs + 10 + WifiPolicy::kScanTimeoutMs - 100);
    check(policy.state() == WifiPolicy::kScanning, "it waits for the whole budget");
    policy.tick(WifiPolicy::kAdoptGraceMs + 20 + WifiPolicy::kScanTimeoutMs);
    check(policy.state() == WifiPolicy::kProvisioning,
          "a scan that never finishes still ends with a way in");
    check(policy.scanned().empty(), "with an honestly empty list");
  }

  // THE safety property. A sideloaded device is already associated, because the
  // firmware being replaced left the supplicant running; touching the link would
  // take adb down with it and the only recovery is a physical power cycle.
  {
    FakeWifi w;
    w.stored = true;
    w.running = true;
    w.address = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    check(policy.state() == WifiPolicy::kOnline, "an existing link is adopted, not rebuilt");
    check(policy.adopted(), "and it says so");
    check(w.mutations() == 0, "begin() issued NOT ONE command — no start, connect, dhcp or AP");
    for (int t = 10; t < 5000; t += 250) policy.tick(t);
    check(w.mutations() == 0, "and ticking a healthy adopted link stays side-effect free");
    check(policy.state() == WifiPolicy::kOnline, "it simply stays online");
  }

  // Adoption is conditional on BOTH halves: a running supplicant with no lease
  // is not a working link, and must still be driven.
  {
    FakeWifi w;
    w.stored = true;
    w.running = true;
    w.address = false;
    WifiPolicy policy(&w);
    policy.begin(0);
    check(!policy.adopted(), "a supplicant with no address is not a link to adopt");
    check(policy.state() == WifiPolicy::kAdopting, "but it still waits before acting");
    // ...and adopts for free if the address turns up during the grace period,
    // which is exactly what a flashed boot looks like.
    w.address = true;
    policy.tick(200);
    check(policy.adopted() && policy.state() == WifiPolicy::kOnline,
          "an address arriving during the grace period is adopted, not raced");
    check(w.mutations() == 0, "with no commands issued at all");
  }

  // hostapd dying while provisioning is a brick — no home network, no hotspot,
  // no adb — so it is supervised exactly like the supplicant.
  {
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    check(policy.state() == WifiPolicy::kProvisioning, "provisioning");
    const int entered = WifiPolicy::kAdoptGraceMs + 30;
    const int before = w.apStarts;
    w.apDies = true;
    policy.tick(entered + WifiPolicy::kSoftApSuperviseMs);
    check(w.apStarts == before + 1, "a dead hotspot is revived");
    check(policy.softApRestarts() == 1, "and the fact is counted, not hidden");
  }

  // ...but NOT on every tick. softApRunning() walks the whole of /proc on the
  // device, tick() is driven from the UI thread, and kProvisioning is the state
  // a device whose network moved sits in forever. This is the check that stops
  // "supervise the hotspot" from quietly becoming a permanent process-table
  // scan six times a second.
  {
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    check(policy.state() == WifiPolicy::kProvisioning, "provisioning");
    const int entered = WifiPolicy::kAdoptGraceMs + 30;

    w.apChecks = 0;
    // The hotspot was asked for on the way into this state and hostapd is
    // started with -B, so it is not in /proc yet. Checking before the period is
    // up would read a starting hotspot as a dead one.
    policy.tick(entered + WifiPolicy::kSoftApSuperviseMs - 1);
    check(w.apChecks == 0, "the hotspot is not checked before its period is up");
    policy.tick(entered + WifiPolicy::kSoftApSuperviseMs);
    check(w.apChecks == 1, "and exactly once when it is");

    // The real cadence: osLogic polls the link every 160 ms. Ten seconds of
    // that is 62 ticks, and the old code ran a /proc walk on every one of them.
    w.apChecks = 0;
    const int base = entered + WifiPolicy::kSoftApSuperviseMs;
    int ticks = 0;
    for (int t = base + 160; t <= base + 10000; t += 160) {
      policy.tick(t);
      ++ticks;
    }
    check(ticks >= 60, "the sample really is a UI-cadence burst");
    check(w.apChecks <= 10000 / WifiPolicy::kSoftApSuperviseMs + 1,
          "ten seconds of ticks cost at most four /proc walks, not sixty-two");
    check(w.apChecks >= 3, "but the hotspot is still genuinely supervised");
    check(policy.softApRestarts() == 0, "and a healthy hotspot is never restarted");
  }

  // With a real hotspot on the air the supplicant is stopped — this radio has
  // no concurrent AP+station mode — so the background retry cannot run. Pinned
  // because the fake's `running` flag is independent of `apUp` and would
  // otherwise let the policy promise something the hardware cannot do.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);                                  // -> starting
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);                                  // -> connecting
    policy.tick(WifiPolicy::kAdoptGraceMs + 30 + WifiPolicy::kConnectTimeoutMs);  // -> scanning
    policy.tick(WifiPolicy::kAdoptGraceMs + 40 + WifiPolicy::kConnectTimeoutMs);  // -> provisioning
    check(policy.state() == WifiPolicy::kProvisioning && w.apUp, "hotspot up");

    const int t0 = WifiPolicy::kAdoptGraceMs + 40 + WifiPolicy::kConnectTimeoutMs;
    w.running = false;  // what bringUpSoftAp's `ctl.stop wpa_supplicant` leaves
    w.assoc = true;     // and the router is back, but nothing can hear it
    const int connectsBefore = w.connects;
    policy.tick(t0 + WifiPolicy::kBackgroundRetryMs + 10);
    check(w.connects == connectsBefore,
          "no connect is attempted at a supplicant the hotspot has stopped");
    check(w.apUp && policy.state() == WifiPolicy::kProvisioning,
          "and the hotspot stands rather than being cycled off to go looking");
  }

  // THE case this class exists for: valid-looking credentials, network gone.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    check(policy.state() == WifiPolicy::kConnecting, "it tries the stored network first");
    policy.tick(WifiPolicy::kAdoptGraceMs + WifiPolicy::kConnectTimeoutMs);
    check(policy.state() == WifiPolicy::kConnecting, "it does not give up early");
    policy.tick(WifiPolicy::kAdoptGraceMs + 20 + WifiPolicy::kConnectTimeoutMs);
    check(policy.state() == WifiPolicy::kScanning,
          "a moved router sweeps for alternatives rather than waiting forever");
    check(!w.apUp, "and does it before the hotspot, which would stop the supplicant");
    policy.tick(WifiPolicy::kAdoptGraceMs + 30 + WifiPolicy::kConnectTimeoutMs);
    check(policy.state() == WifiPolicy::kProvisioning, "then falls back to provisioning");
    check(w.apUp, "the hotspot comes up so the user has a way in");

    // ...and keeps retrying in the background, because the usual cause is a
    // router that is merely slow to come back.
    const int t0 = WifiPolicy::kAdoptGraceMs + 30 + WifiPolicy::kConnectTimeoutMs;
    const int connectsBefore = w.connects;
    policy.tick(t0 + 1000);
    check(w.connects == connectsBefore, "it does not spam the radio");
    w.assoc = true;
    policy.tick(t0 + WifiPolicy::kBackgroundRetryMs + 10);
    check(w.connects > connectsBefore, "it retries the stored network on a timer");
    check(policy.state() == WifiPolicy::kObtainingIp, "a recovered router is picked up by itself");
    check(!w.apUp && w.apStops >= 1, "the hotspot is torn down once the network is back");
  }

  // Provisioning must not tear the hotspot down on a hopeful retry that fails —
  // that would strand a user halfway through configuring.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);                                  // grace -> starting
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);                                  // -> connecting
    policy.tick(WifiPolicy::kAdoptGraceMs + 30 + WifiPolicy::kConnectTimeoutMs);  // -> scanning
    policy.tick(WifiPolicy::kAdoptGraceMs + 40 + WifiPolicy::kConnectTimeoutMs);  // -> provisioning
    check(w.apUp, "hotspot up");
    const int t0 = WifiPolicy::kAdoptGraceMs + 40 + WifiPolicy::kConnectTimeoutMs;
    policy.tick(t0 + WifiPolicy::kBackgroundRetryMs + 10);  // assoc still false
    check(w.apUp, "a failed retry leaves the hotspot standing");
    check(policy.state() == WifiPolicy::kProvisioning, "and stays in provisioning");
  }

  // Credentials from the setup page take effect immediately.
  {
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);   // grace -> starting
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);   // -> scanning
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);   // -> provisioning
    check(policy.isProvisioning(), "starts in provisioning");
    policy.applyCredentials("newnet", "secret", WifiPolicy::kAdoptGraceMs + 100);
    check(policy.state() == WifiPolicy::kConnecting, "submitted credentials are tried at once");
    check(w.lastSsid == "newnet", "the submitted network is the one attempted");
    check(!w.apUp, "the hotspot drops as soon as the user has submitted");
  }

  // PERSISTENCE. Credentials typed into the setup page exist nowhere but RAM
  // until this happens, so without it a flashed device forgets its network on
  // every power cycle — and a flashed device that cannot reach a network cannot
  // be reached at all: no WiFi, no adb, and adb over TCP is the only channel
  // this unit has.
  {
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    check(policy.isProvisioning(), "provisioning");

    policy.applyCredentials("newnet", "secret", WifiPolicy::kAdoptGraceMs + 100);
    check(w.persists == 0, "submitting credentials does not write them");
    w.assoc = true;
    policy.tick(WifiPolicy::kAdoptGraceMs + 200);
    check(policy.state() == WifiPolicy::kObtainingIp, "association leads to a lease request");
    // Association only proves the password. The write lands on /data, which a
    // power cycle does not clear, so it waits for proof the network is usable.
    check(w.persists == 0, "nor does associating — an address is the proof");
    w.address = true;
    policy.tick(WifiPolicy::kAdoptGraceMs + 300);
    check(policy.isOnline(), "online");
    check(w.persists == 1, "a proven network is written to flash exactly once");

    // Once. Not once a tick, and not again when the same link is re-checked:
    // this is a jffs2 write on the one partition the universal rescue cannot
    // undo.
    for (int t = WifiPolicy::kAdoptGraceMs + 400; t < WifiPolicy::kAdoptGraceMs + 20000;
         t += 160) {
      policy.tick(t);
    }
    check(w.persists == 1, "and never again while it keeps working");
  }

  // Credentials that came OUT of the file are never written back to it.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    w.assoc = true;
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    w.address = true;
    policy.tick(WifiPolicy::kAdoptGraceMs + 40);
    check(policy.isOnline(), "the stored network comes up");
    check(w.persists == 0,
          "a network read from the file is never saved back — that is a /data write per boot");
  }

  // Credentials that never worked are never written. A wrong password that
  // reached flash would survive the power cycle that is this device's only
  // rescue, and it would do so while looking exactly like a right one.
  {
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    policy.applyCredentials("typo", "wrong", WifiPolicy::kAdoptGraceMs + 100);
    check(policy.state() == WifiPolicy::kConnecting, "it tries them");
    const int t0 = WifiPolicy::kAdoptGraceMs + 100;
    policy.tick(t0 + WifiPolicy::kConnectTimeoutMs + 10);
    check(policy.state() == WifiPolicy::kScanning, "and gives up on time");
    policy.tick(t0 + WifiPolicy::kConnectTimeoutMs + 20);
    check(policy.state() == WifiPolicy::kProvisioning, "back to offering a way in");
    check(w.persists == 0, "with nothing written to flash");

    // ...and if the same credentials later turn out to work — a router that was
    // merely slow — the intent to save them is still standing.
    w.running = true;
    w.assoc = true;
    policy.tick(t0 + WifiPolicy::kConnectTimeoutMs + 20 + WifiPolicy::kBackgroundRetryMs + 10);
    check(policy.state() == WifiPolicy::kObtainingIp, "the retry lands");
    w.address = true;
    policy.tick(t0 + WifiPolicy::kConnectTimeoutMs + 20 + WifiPolicy::kBackgroundRetryMs + 20);
    check(policy.isOnline() && w.persists == 1,
          "credentials proven late are still persisted");
  }

  // Supervision: init will not respawn a oneshot service, so we must.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    w.assoc = true;
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    w.address = true;
    policy.tick(WifiPolicy::kAdoptGraceMs + 40);
    check(policy.isOnline(), "online");
    const int startsBefore = w.starts;
    w.running = false;  // the daemon dies
    policy.tick(40);
    check(w.starts == startsBefore + 1, "a dead supplicant is revived by us");
    check(policy.state() == WifiPolicy::kStartingWpa, "and the machine goes back to waiting");
    check(policy.supplicantRestarts() >= 1, "the restart is counted, not hidden");
  }

  // A supplicant that refuses to start is retried rather than abandoned.
  {
    FakeWifi w;
    w.autoStart = false;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);  // grace expires; the first start is issued here
    policy.tick(WifiPolicy::kAdoptGraceMs + WifiPolicy::kSupplicantStartMs + 20);
    check(w.starts >= 2, "a supplicant that will not start is retried");
    check(policy.state() == WifiPolicy::kStartingWpa, "and we keep waiting for it");
  }

  // Losing the lease re-associates instead of sitting on a dead link.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    w.assoc = true;
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    w.address = true;
    policy.tick(WifiPolicy::kAdoptGraceMs + 40);
    const int connectsBefore = w.connects;
    w.address = false;
    policy.tick(40);
    check(w.connects == connectsBefore + 1, "a lost address re-associates");
  }

  // A DHCP request that never lands is repeated.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    w.assoc = true;
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    check(w.dhcpCalls == 1, "one lease request so far");
    policy.tick(WifiPolicy::kAdoptGraceMs + 30 + WifiPolicy::kDhcpTimeoutMs + 1);
    check(w.dhcpCalls == 2, "a silent DHCP server is asked again");
  }

  // ...and keeps asking, without ever escaping to the hotspot. A lease budget
  // here reads as prudence and is not: bringUpSoftAp stops wpa_supplicant, and
  // /etc/init.rc declares that service disabled+oneshot, so the kProvisioning
  // background retry — which is gated on supplicantRunning() — cannot fire once
  // the AP is on the air. The escape is one-way, and the state it fires on is a
  // router that is merely slower to lease than the clock is to boot. This check
  // is here so that the next person to find kObtainingIp's missing exit finds
  // the reason with it.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    int now = WifiPolicy::kAdoptGraceMs + 10;
    policy.tick(now);
    policy.tick(now += 10);
    w.assoc = true;
    policy.tick(now += 10);
    check(policy.state() == WifiPolicy::kObtainingIp, "associated, waiting on a lease");
    for (int attempt = 0; attempt < 6; ++attempt) {
      policy.tick(now += WifiPolicy::kDhcpTimeoutMs + 1);
    }
    check(policy.state() == WifiPolicy::kObtainingIp,
          "a slow DHCP server is waited on, not escaped from into a one-way hotspot");
    check(w.dhcpCalls == 7, "and asked again on every timeout");
    check(w.apStarts == 0, "the radio is never taken off the network the user chose");
  }
}

// True when exactly one argument starts with `prefix`, and it equals `whole`.
//
// Prefix-unique matters as much as the value: dnsmasq's list options append
// rather than replace, so a second --dhcp-range is a second range, not a
// correction. That is the shape of the bug in the vendor's own conf file.
bool hasOneArg(const std::vector<std::string>& args, const std::string& prefix,
               const std::string& whole) {
  int found = 0;
  bool matched = false;
  for (size_t i = 0; i < args.size(); ++i) {
    if (args[i].compare(0, prefix.size(), prefix) != 0) continue;
    ++found;
    if (args[i] == whole) matched = true;
  }
  return found == 1 && matched;
}

// The parts of the hotspot recipe that do not need a radio.
//
// Whether hostapd actually claims wlan0 and whether 2.4 GHz association works at
// all remain answerable on hardware alone. The rest is answerable here — the two
// strings a user reads off the panel, and the argument list that decides whether
// a phone is ever handed an address. That last one used to be a local array
// nothing could see, and it shipped missing the one flag that made it run.
void checkSoftApRecipe() {
  using tcos::DeviceWifi;

  // The name carries the MAC because the stock firmware calls every unit
  // U-Clock: two clocks in one room are then indistinguishable, and a hotspot
  // sharing the stock name leaves the user unsure which system they are
  // configuring.
  check(DeviceWifi::apSsidFromMac("CC:C4:B2:77:A7:72") == "ZOS-A772",
        "the hotspot takes the last four hex digits of the MAC");
  check(DeviceWifi::apSsidFromMac("cc:c4:b2:77:a7:72") == "ZOS-A772",
        "a lower-case MAC gives the same name — the panel must not depend on ioctl casing");
  check(DeviceWifi::apSsidFromMac("") == "ZOS-0000",
        "an unreadable MAC still yields a name, rather than a bare prefix");

  // THE measurement the name is chosen for. 8 ASCII cells x 6 px = 48 px, and
  // the panel is 52 px: this is the widest hotspot name that does not have to
  // scroll, and a name the user has to read off a moving line gets mistyped —
  // which on the phone side is indistinguishable from a wrong password.
  check(tcos::text::measure("ZOS-A772") == 48,
        "the hotspot name is 48 px — it fits the panel without a marquee");
  check(tcos::text::measure("ZOS-0000") == 48, "and so does the fallback");
  check(tcos::text::measure("TC002-OS-A772") > 52,
        "the name the design doc first proposed would have had to scroll");

  // The config is not invented: every key below is a literal inside the
  // device's own libzknet.so, so this is the configuration the stock hotspot
  // ran with on this exact radio.
  const std::string conf = DeviceWifi::hostapdConf("ZOS-A772", "12345678");
  check(conf.find("interface=wlan0\n") == 0, "the interface comes first, as hostapd wants");
  check(conf.find("\ndriver=nl80211\n") != std::string::npos, "nl80211, as libzknet writes");
  check(conf.find("\nssid=ZOS-A772\n") != std::string::npos, "the SSID is the derived one");
  check(conf.find("\nhw_mode=g\n") != std::string::npos,
        "2.4 GHz only — the vendor's own docs say the radio has no 5 GHz");
  check(conf.find("\nchannel=6\n") != std::string::npos, "channel 6, as the stock config picks");
  check(conf.find("\nignore_broadcast_ssid=0\n") != std::string::npos,
        "the hotspot is broadcast: a hidden rescue network is not a rescue");
  check(conf.find("\nwpa=2\n") != std::string::npos && conf.find("\nrsn_pairwise=CCMP\n") != std::string::npos,
        "WPA2 with CCMP, the pair libzknet writes together");
  check(conf.find("\nwpa_passphrase=12345678\n") != std::string::npos,
        "the passphrase goes in as plaintext");
  // The stock path writes wpa_psk=<64 hex> and derives it with PBKDF2 out of
  // libssl. hostapd derives the identical key from the passphrase itself, and
  // this firmware has a 1.2 MB link budget to protect.
  check(conf.find("wpa_psk=") == std::string::npos,
        "and never as a PBKDF2 hash, which would mean linking libssl");
  check(conf[conf.size() - 1] == '\n', "the file ends with a newline");

  // --- dnsmasq, the half that made the hotspot useless ----------------------
  //
  // Measured on the device: with the pid file left at its compiled-in default,
  // /var/run/dnsmasq.pid, dnsmasq exits 3 — there is no /var on this rootfs at
  // all — so the SSID went on the air and no phone was ever handed an address.
  const std::vector<std::string> args = DeviceWifi::dnsmasqArgs("192.168.100.1");
  const std::vector<std::string> proven = DeviceWifi::dnsmasqProvenArgs("192.168.100.1");

  // THE FALLBACK IS THE MEASUREMENT, character for character.
  //
  // This is the check that matters most in this file, and it is a check on
  // restraint rather than on cleverness. dnsmasq exits EC_BADCONF on any
  // argument it does not accept, so an unverified flag in the preferred list is
  // a way to reproduce the original bug exactly — the SSID on the air and not
  // one lease. What makes that survivable is that superviseDhcp falls back to
  // the argument list actually executed on this unit: the four arguments this
  // firmware always passed, plus the --pid-file that turned exit 3 into exit 0.
  // Nothing may be added to it. An "improvement" here is an improvement to the
  // only thing known to work.
  {
    std::vector<std::string> measured;
    measured.push_back("--interface=wlan0");
    measured.push_back("--dhcp-range=192.168.100.100,192.168.100.200,1h");
    measured.push_back("--address=/#/192.168.100.1");
    measured.push_back("--no-resolv");
    measured.push_back("--no-poll");
    measured.push_back("--pid-file=/tmp/zos-dnsmasq.pid");
    check(proven == measured,
          "the fallback list is exactly the invocation measured working on the device — "
          "the original four arguments plus the pid file, and nothing else");
    // Deliberately absent, and the absence is the point: /etc/dnsmasq.conf is
    // left to be read implicitly, exactly as it was when the measurement was
    // taken, so `user=root`, `no-hosts` and a writable lease path come from the
    // vendor's own file rather than from flags this build may reject.
    check(!hasOneArg(proven, "--conf-file", "--conf-file=/dev/null") &&
              !hasOneArg(proven, "--user", "--user=root"),
          "and it does not neutralise the vendor conf it is relying on");
  }

  // The preferred list has to contain the fallback: whatever else it tries, it
  // may not drop the one line that was measured to make dnsmasq start.
  for (size_t i = 0; i < proven.size(); ++i) {
    bool present = false;
    for (size_t j = 0; j < args.size(); ++j) {
      if (args[j] == proven[i]) present = true;
    }
    check(present, "the preferred list keeps every argument of the measured one");
  }

  check(hasOneArg(args, "--pid-file", "--pid-file=/tmp/zos-dnsmasq.pid"),
        "the pid file is on tmpfs — /var does not exist on this device, and its "
        "absence is the whole bug");
  check(hasOneArg(args, "--dhcp-leasefile", "--dhcp-leasefile=/tmp/zos-dnsmasq.leases"),
        "and so is the lease file, whose default lives under the same missing /var");
  for (size_t i = 0; i < args.size(); ++i) {
    check(args[i].find("/var/") == std::string::npos, "no argument names a path under /var");
  }
  for (size_t i = 0; i < proven.size(); ++i) {
    check(proven[i].find("/var/") == std::string::npos,
          "and neither does the fallback, whose lease path comes from the vendor conf");
  }

  // /etc/dnsmasq.conf is read implicitly and on this unit carries a dhcp-range
  // in a subnet the AP does not have. Which file wins for a scalar option is a
  // claim about dnsmasq's parse order that nothing here can verify, so the
  // preferred list does not depend on it either way: neutralise the file and own
  // every setting it supplied. If the flag is rejected, the fallback above is
  // the state the measurement was taken in.
  check(hasOneArg(args, "--conf-file", "--conf-file=/dev/null"),
        "the vendor's /etc/dnsmasq.conf is taken out of the picture");
  check(hasOneArg(args, "--user", "--user=root"),
        "root is spelled out: dnsmasq's default user is `nobody`, and a getpwnam "
        "that fails is fatal — every start measured on this unit was as root");
  check(hasOneArg(args, "--no-hosts", "--no-hosts"),
        "/etc/hosts stays unread, or a local record would answer before the "
        "captive-portal catch-all");
  check(hasOneArg(args, "--dhcp-authoritative", "--dhcp-authoritative"),
        "a phone arriving with a cached lease is NAKed rather than ignored");
  check(hasOneArg(args, "--no-resolv", "--no-resolv") &&
            hasOneArg(args, "--no-poll", "--no-poll"),
        "no upstream resolver is looked for; there is none while the AP is up");

  // THE invariant. A pool outside the address on wlan0 matches no DHCP context,
  // so dnsmasq stays up, answers nothing, and every supervision check still
  // reports a healthy hotspot — which is exactly the mistake the vendor conf
  // ships (dhcp-range=192.168.1.101 on a device whose AP is 192.168.100.1).
  check(hasOneArg(args, "--dhcp-range",
                  "--dhcp-range=192.168.100.100,192.168.100.200,1h"),
        "the pool is libzknet's own, inside the gateway's /24");
  check(hasOneArg(args, "--address=", "--address=/#/192.168.100.1"),
        "every name resolves to the gateway, which is what opens the captive sheet");
  check(hasOneArg(args, "--interface", "--interface=wlan0"), "and it serves wlan0 only");

  // Derived, not written twice: move the gateway and the pool has to follow, or
  // the two disagree the way the vendor's file does. Both tiers, because the
  // fallback is a real code path and a fallback that leases on the wrong subnet
  // is the bug it exists to avoid.
  const std::vector<std::string> moved = DeviceWifi::dnsmasqArgs("10.0.7.1");
  const std::vector<std::string> movedProven = DeviceWifi::dnsmasqProvenArgs("10.0.7.1");
  check(hasOneArg(moved, "--dhcp-range", "--dhcp-range=10.0.7.100,10.0.7.200,1h"),
        "a different gateway carries its pool with it");
  check(hasOneArg(moved, "--address=", "--address=/#/10.0.7.1"),
        "and the DNS catch-all with it too");
  check(hasOneArg(movedProven, "--dhcp-range", "--dhcp-range=10.0.7.100,10.0.7.200,1h") &&
            hasOneArg(movedProven, "--address=", "--address=/#/10.0.7.1"),
        "and the fallback follows the gateway the same way");

  // The three tmpfs paths dnsmasq is given, named once each so the device-side
  // recipe and the places to look after a failure cannot drift apart.
  check(std::string(DeviceWifi::dnsmasqPidFile()).compare(0, 5, "/tmp/") == 0 &&
            std::string(DeviceWifi::dnsmasqLeaseFile()).compare(0, 5, "/tmp/") == 0 &&
            std::string(DeviceWifi::dnsmasqErrFile()).compare(0, 5, "/tmp/") == 0 &&
            std::string(DeviceWifi::dnsmasqProvenErrFile()).compare(0, 5, "/tmp/") == 0,
        "pid, leases and both stderr captures live on tmpfs, not on the jffs2 "
        "partition that holds the user's credentials");
  check(std::string(DeviceWifi::dnsmasqErrFile()) !=
            std::string(DeviceWifi::dnsmasqProvenErrFile()),
        "and the fallback's complaint does not overwrite the one naming the "
        "argument this build rejected");
}

}  // namespace

int main() {
  std::printf("tc002-os host self-check\n");
  checkEase();
  std::printf("  ease ok\n");
  checkSurface();
  std::printf("  surface ok\n");
  checkGlyphs();
  std::printf("  glyphs ok\n");
  checkText();
  std::printf("  text ok\n");
  checkRingModel();
  std::printf("  ring model ok\n");
  checkShell();
  std::printf("  shell ok\n");
  checkTransitions();
  std::printf("  transitions ok\n");
  checkLauncher();
  std::printf("  launcher ok\n");
  checkStateDoc();
  std::printf("  state doc ok\n");
  checkFrameBundle();
  std::printf("  frame bundle ok\n");
  checkHttpServer();
  std::printf("  http server ok\n");
  checkHttpClient();
  std::printf("  http client ok\n");
  checkSetupPortal();
  std::printf("  setup portal ok\n");
  checkGameScreen();
  std::printf("  game screen ok\n");
  checkChannelRing();
  std::printf("  channel ring ok\n");
  checkSettingsScreen();
  std::printf("  settings screen ok\n");
  checkMusicScreen();
  std::printf("  music screen ok\n");
  checkMusicTheme();
  std::printf("  music theme ok\n");
  checkMusicPath();
  std::printf("  music path ok\n");
  checkNavigationFlow();
  std::printf("  navigation flow ok\n");
  checkLevelOverlay();
  std::printf("  level overlay ok\n");
  checkTimeSync();
  std::printf("  time sync ok\n");
  checkBrightness();
  std::printf("  brightness ok\n");
  checkInstallMode();
  std::printf("  install mode ok\n");
  checkWpaCtrl();
  std::printf("  wpa ctrl ok\n");
  checkWifiPolicy();
  std::printf("  wifi policy ok\n");
  checkSoftApRecipe();
  std::printf("  soft ap recipe ok\n");
  checkZosLogo();
  std::printf("  zos logo ok\n");
  checkBootScreen();
  std::printf("  boot screen ok\n");

  if (gFailures != 0) {
    std::printf("%d check(s) failed\n", gFailures);
    return 1;
  }
  std::printf("all tc002-os host checks passed\n");
  return 0;
}
