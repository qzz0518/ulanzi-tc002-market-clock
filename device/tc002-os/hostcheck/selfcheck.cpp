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
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "core/Ease.h"
#include "core/LyricTiming.h"
#include "core/RingModel.h"
#include "core/Shell.h"
#include "core/Surface.h"
#include "core/Text.h"
#include "core/Transitions.h"
#include "net/BleProtocol.h"
#include "net/BleProvisionSession.h"
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
#include "platform/ProvisionLog.h"
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
#include "ui/LevelControl.h"
#include "ui/LevelOverlay.h"
#include "ui/MusicScreen.h"
#include "ui/ProvisionScreen.h"
#include "ui/SettingsScreen.h"
#include "ui/SleepPolicy.h"
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

// Lit pixels inside a rectangle. Needed beside litPixelsInRows because 升降 puts
// its whole-track fill in column 51, outside the [2,50) text window — a check
// asking "is the line still on the panel" must not be satisfied by the fill bar.
int litPixelsInBox(const Surface& s, int x0, int x1, int y0, int y1) {
  int n = 0;
  for (int y = y0; y <= y1; ++y) {
    for (int x = x0; x <= x1; ++x) {
      const Color c = s.getPixel(x, y);
      if (c.r || c.g || c.b) ++n;
    }
  }
  return n;
}

// FNV-1a over every pixel of a frame. Only used to compare a frame against one
// rendered by a DIFFERENT BUILD, which is the one comparison no other helper here
// can make — see checkLyricLegacyFrames.
uint32_t frameHash(const Surface& s) {
  uint32_t h = 2166136261u;
  for (int y = 0; y < s.getHeight(); ++y) {
    for (int x = 0; x < s.getWidth(); ++x) {
      const uint32_t rgb = s.getPixel(x, y).toRGB888();
      for (int shift = 0; shift < 32; shift += 8) {
        h ^= (rgb >> shift) & 0xffu;
        h *= 16777619u;
      }
    }
  }
  return h;
}

// The nth codepoint of a UTF-8 string, so a check can name a glyph by its
// position in the line rather than by a hand-transcribed hex value.
uint32_t codepointAt(const char* utf8, int index) {
  const char* p = utf8;
  uint32_t cp = 0;
  for (int i = 0; i <= index && *p != 0; ++i) cp = tcos::text::utf8Next(p);
  return cp;
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

// Pixels of one palette tier inside a rectangle. The karaoke wipe lights exactly
// one glyph in the primary tier, so counting it over a mode's TEXT WINDOW is how
// a check can say WHICH character the panel thinks is being sung rather than
// merely that something is lit — but the window has to be the real one. Every
// mode also spends primary on chrome: the cue rows (excluded by the row band),
// skyline's tallest bar (likewise), and 升降's whole-track fill, which climbs
// column 51 THROUGH the text rows and is only excluded by the columns.
int tierPixelsInBox(const Surface& s, uint32_t rgb, int x0, int x1, int y0, int y1) {
  int n = 0;
  for (int y = y0; y <= y1; ++y) {
    for (int x = x0; x <= x1; ++x) {
      if (s.getPixel(x, y).toRGB888() == rgb) ++n;
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
  bool scanResultsAreCached() { return cached; }
  bool cached = false;
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
  check(portal.handle(req).body == "{\"networks\":[],\"cached\":false}",
        "an empty scan is still valid JSON");
  backend.networks.push_back("home");
  backend.networks.push_back("say \"hi\"");
  backend.networks.push_back("back\\slash");
  const std::string scanBody = portal.handle(req).body;
  check(scanBody.find("\\\"hi\\\"") != std::string::npos, "quotes in an SSID are escaped");
  check(scanBody.find("back\\\\slash") != std::string::npos, "backslashes are escaped");

  // A list served from the previous boot's cache says so, and the page turns
  // that into a visible 上次扫描 label: stale must not masquerade as live.
  check(scanBody.find("\"cached\":false") != std::string::npos,
        "a live list is marked live");
  backend.cached = true;
  check(portal.handle(req).body.find("\"cached\":true") != std::string::npos,
        "a cached list is marked cached");
  backend.cached = false;
  check(page.body.find("id=ch") != std::string::npos &&
            page.body.find("d.cached") != std::string::npos,
        "and the page carries the cache label plus the script that shows it");
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

// --- the console's volume/brightness path -----------------------------------
//
// Stand-in for DeviceControls, whose .cpp calls into the FlyThings audio
// manager and cannot be linked here. It is the ONLY thing standing in: the
// adjust/console rules below are ui/LevelControl.cpp itself, linked, not a copy
// of it — a mirrored copy passes happily while the original is wrong, which is
// what let the wrong-bar bug ship. The SCALES are the real ones too, taken from
// the header rather than from two literals, so a self-check cannot pass against
// a range the device does not have.
struct FakeControls : public tcos::LevelControls {
  int vol;
  int bri;

  FakeControls() : vol(3), bri(5) {}

  virtual int volume() const { return vol; }
  virtual int brightness() const { return bri; }

  static int clampTo(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
  virtual int nudgeVolume(int delta) {
    vol = clampTo(vol + delta, 0, tcos::DeviceControls::kVolumeMax);
    return vol;
  }
  virtual int nudgeBrightness(int delta) {
    // Floors at one step, exactly as the device does: zero would black the
    // panel out with no way to see the bar that turns it back up.
    bri = clampTo(bri + delta, 1, tcos::DeviceControls::kBrightnessSteps);
    return bri;
  }
};

// Parses a document the way the device does, so these cases exercise the real
// wire keys rather than a struct filled in by hand.
tcos::SettingsRequest settingsFromDoc(const char* body) {
  tcos::StateDoc doc;
  doc.parse(body);
  return doc.settings();
}

void checkConsoleSettings() {
  using tcos::LevelOverlay;
  using tcos::SettingsPlan;
  using tcos::SettingsRequest;

  // --- the wire keys -------------------------------------------------------
  // Byte-for-byte the settings block OsLinkHub.serialize() emits, in its order.
  // test/os-link.test.ts asserts the encoder still produces exactly this, so
  // the two halves of the contract are pinned from both sides.
  const SettingsRequest wire = settingsFromDoc(
      "seq\t12\npinned\t0\nmirror\t0\n"
      "setseq\t4\nsetvol\t4\nsetvolseq\t4\nsetbri\t7\nsetbriseq\t3\n"
      "menu\t0\n");
  check(wire.seq == 4 && wire.volume == 4 && wire.brightness == 7,
        "the settings block still parses as it always did");
  check(wire.volumeSeq == 4 && wire.brightnessSeq == 3,
        "and each level now carries the sequence it was last asked for at");
  // The keys share a prefix; an exact compare is the only thing keeping
  // `setvolseq` out of `setvol`, and a level that silently became a sequence
  // number would set the volume to 9 on a 0..6 scale.
  const SettingsRequest seqOnly =
      settingsFromDoc("seq\t1\nsetseq\t4\nsetvolseq\t4\nmenu\t0\n");
  check(seqOnly.volume == -1 && seqOnly.volumeSeq == 4,
        "setvolseq is not mistaken for setvol");

  // --- THE BUG -------------------------------------------------------------
  // Brightness was set once, long ago; the console now moves only the volume.
  // The document still carries both — it always will — so the old code ran the
  // brightness branch too: a zero-sized nudge that changed nothing, and a
  // brightness bar drawn straight over the volume one.
  {
    FakeControls controls;
    LevelOverlay hud;
    int applied = 8;
    const SettingsRequest volumeOnly = settingsFromDoc(
        "seq\t20\nsetseq\t9\nsetvol\t6\nsetvolseq\t9\nsetbri\t7\nsetbriseq\t1\nmenu\t0\n");
    tcos::applyConsoleSettings(volumeOnly, applied, controls, hud, 1000);
    check(controls.volume() == 6, "a console volume change reaches the mixer");
    check(controls.brightness() == 5,
          "and leaves brightness where the device had it, not where the console last asked");
    check(hud.visible(1000) && hud.kind() == LevelOverlay::kVolume,
          "a volume-only change shows the VOLUME bar");
    check(hud.value() == 6, "showing the level it just moved to");
    // The bar is a mode as well as a readout, so the wrong bar also aimed the
    // side buttons at the wrong control for the next 1.3 s.
    check(hud.shortPressKind(1000) == LevelOverlay::kVolume,
          "and leaves the side buttons on volume");
    tcos::applyShortPress(controls, hud, -1, 1050);
    check(controls.volume() == 5 && controls.brightness() == 5,
          "so a short press right after it steps the volume, not the brightness");

    // Re-polling the same document must change nothing: the document repeats
    // the request forever, and this is what lets the knob win afterwards.
    controls.vol = 2;
    tcos::applyConsoleSettings(volumeOnly, applied, controls, hud, 2000);
    check(controls.volume() == 2, "a repeated document does not re-apply the request");
  }

  // --- the service restarted -----------------------------------------------
  // The hub's sequences live in the Bun process and start again at 1 after
  // `bun start`, while the device is still up holding the last number it
  // applied. A LOWER sequence is therefore a new counter, not a replay; without
  // that the console's slider silently does nothing until it has been dragged
  // as many times as it was before the restart. Same rule as
  // applySleepRequest's, where it is load-bearing for a dark panel.
  {
    FakeControls controls;
    LevelOverlay hud;
    int applied = 9;
    const SettingsRequest afterRestart =
        settingsFromDoc("seq\t2\nsetseq\t1\nsetvol\t6\nsetvolseq\t1\nmenu\t0\n");
    check(tcos::applyConsoleSettings(afterRestart, applied, controls, hud, 1000),
          "a sequence that went backwards is adopted rather than refused");
    check(controls.volume() == 6, "so the console can still move the volume after a restart");
    controls.vol = 2;
    check(!tcos::applyConsoleSettings(afterRestart, applied, controls, hud, 2000),
          "and the replay guard is still armed at the new counter");
    check(controls.volume() == 2, "so the knob still wins");
  }

  // --- brightness only -----------------------------------------------------
  {
    FakeControls controls;
    LevelOverlay hud;
    int applied = 8;
    const SettingsRequest brightnessOnly = settingsFromDoc(
        "seq\t21\nsetseq\t9\nsetvol\t4\nsetvolseq\t2\nsetbri\t9\nsetbriseq\t9\nmenu\t0\n");
    tcos::applyConsoleSettings(brightnessOnly, applied, controls, hud, 1000);
    check(controls.brightness() == 9, "a console brightness change reaches the panel");
    check(controls.volume() == 3, "and leaves the volume alone");
    check(hud.visible(1000) && hud.kind() == LevelOverlay::kBrightness &&
              hud.value() == 9,
          "a brightness-only change shows the brightness bar");
    // Deliberate, and the same rule a long press already establishes: while a
    // brightness bar is up the user is in brightness, whoever raised it.
    check(hud.shortPressKind(1000) == LevelOverlay::kBrightness,
          "the bar arms the side buttons for brightness while it is up");
    tcos::applyShortPress(controls, hud, +1, 1050);
    check(controls.brightness() == 10 && controls.volume() == 3,
          "so a short press continues the brightness the console started");
    // ...and only until it expires. No mode the user has to remember to leave.
    const int gone = 1050 + LevelOverlay::kHoldMs + LevelOverlay::kExitMs + 1;
    tcos::applyShortPress(controls, hud, -1, gone);
    check(controls.volume() == 2 && controls.brightness() == 10,
          "once the bar lapses the side buttons are back on volume");
  }

  // --- both in one sequence ------------------------------------------------
  // One PUT naming both levels. Both are applied — dropping one would be a
  // worse bug than the one being fixed — and the single bar goes to VOLUME:
  // brightness is visible in every lit pixel while a muted speaker is not, and
  // volume is the only choice that does not silently arm the side buttons for
  // brightness.
  {
    FakeControls controls;
    LevelOverlay hud;
    int applied = 0;
    const SettingsRequest both = settingsFromDoc(
        "seq\t22\nsetseq\t4\nsetvol\t6\nsetvolseq\t4\nsetbri\t9\nsetbriseq\t4\nmenu\t0\n");
    tcos::applyConsoleSettings(both, applied, controls, hud, 1000);
    check(controls.volume() == 6 && controls.brightness() == 9,
          "both levels are applied when both moved at the same sequence");
    check(hud.kind() == LevelOverlay::kVolume && hud.value() == 6,
          "and the one bar shows volume");
    check(hud.shortPressKind(1000) == LevelOverlay::kVolume,
          "leaving the side buttons where they were");
  }

  // --- two writes the device read as one document --------------------------
  // The poll is free to coalesce: the console moved the volume at seq 5 and the
  // brightness at seq 6, and the device saw one document. Both must land — a
  // "which field moved" flag would have described one write and lost the other
  // — and the bar goes to the LATER one, the slider still under the finger.
  {
    FakeControls controls;
    LevelOverlay hud;
    int applied = 4;
    const SettingsRequest coalesced = settingsFromDoc(
        "seq\t23\nsetseq\t6\nsetvol\t1\nsetvolseq\t5\nsetbri\t2\nsetbriseq\t6\nmenu\t0\n");
    tcos::applyConsoleSettings(coalesced, applied, controls, hud, 1000);
    check(controls.volume() == 1 && controls.brightness() == 2,
          "a coalesced poll applies both requests rather than only the last");
    check(hud.kind() == LevelOverlay::kBrightness && hud.value() == 2,
          "and shows the more recent one");
  }

  // A level the console re-sends unchanged still raises its bar: the sequence
  // says the user moved the control, which is not the same question as whether
  // the number differs. Without this a slider dragged back to where it started
  // would give the console no feedback at all.
  {
    FakeControls controls;
    LevelOverlay hud;
    int applied = 8;
    const SettingsRequest same = settingsFromDoc(
        "seq\t24\nsetseq\t9\nsetvol\t3\nsetvolseq\t9\nsetbri\t7\nsetbriseq\t1\nmenu\t0\n");
    tcos::applyConsoleSettings(same, applied, controls, hud, 1000);
    check(controls.volume() == 3, "re-requesting the current level changes nothing");
    check(hud.visible(1000) && hud.kind() == LevelOverlay::kVolume,
          "but still answers the console with the volume bar");
  }

  // --- a document from an older service ------------------------------------
  // No per-field sequences at all. The VALUES must land exactly as they always
  // did — this is the shape every deployed document had — and the bar falls
  // back to the only signal left: which level actually differs from the
  // device's.
  {
    FakeControls controls;  // volume 3, brightness 5
    LevelOverlay hud;
    int applied = 2;
    const SettingsRequest legacy =
        settingsFromDoc("seq\t25\nsetseq\t3\nsetvol\t6\nsetbri\t5\nmenu\t0\n");
    check(legacy.volumeSeq == 0 && legacy.brightnessSeq == 0,
          "an older service sends no per-field sequence");
    tcos::applyConsoleSettings(legacy, applied, controls, hud, 1000);
    check(controls.volume() == 6 && controls.brightness() == 5,
          "an older service's document still applies both values");
    check(hud.kind() == LevelOverlay::kVolume && hud.value() == 6,
          "and the bar follows the level that actually moved");
  }
  {
    FakeControls controls;
    LevelOverlay hud;
    int applied = 2;
    tcos::applyConsoleSettings(
        settingsFromDoc("seq\t26\nsetseq\t3\nsetvol\t3\nsetbri\t9\nmenu\t0\n"),
        applied, controls, hud, 1000);
    check(controls.brightness() == 9 && hud.kind() == LevelOverlay::kBrightness,
          "the same, the other way round");
  }
  {
    // Both differ: the tie rule again, so the legacy and per-field paths never
    // disagree about which control owns the single bar.
    FakeControls controls;
    LevelOverlay hud;
    int applied = 2;
    tcos::applyConsoleSettings(
        settingsFromDoc("seq\t27\nsetseq\t3\nsetvol\t0\nsetbri\t1\nmenu\t0\n"),
        applied, controls, hud, 1000);
    check(controls.volume() == 0 && controls.brightness() == 1,
          "both legacy values are applied");
    check(hud.kind() == LevelOverlay::kVolume, "and volume takes the bar");
  }
  {
    // The one case the fallback cannot answer: a legacy service re-sending
    // levels the device already has. Nothing moved, so nothing is shown —
    // poorer feedback than the bug, but it names no control the user did not
    // touch, and it can only happen against a service older than this build.
    FakeControls controls;
    LevelOverlay hud;
    int applied = 2;
    tcos::applyConsoleSettings(
        settingsFromDoc("seq\t28\nsetseq\t3\nsetvol\t3\nsetbri\t5\nmenu\t0\n"),
        applied, controls, hud, 1000);
    check(!hud.visible(1000),
          "a legacy request for the levels already set raises no bar at all");
  }

  // --- the physical path, untouched ----------------------------------------
  // Nothing above may change what a button does. This is the button path on its
  // own, through the same adjustLevel the console now shares: short press is
  // volume, long press is brightness, and a raised brightness bar keeps further
  // short presses on brightness until it expires.
  {
    FakeControls controls;
    LevelOverlay hud;
    tcos::applyShortPress(controls, hud, +1, 1000);
    check(controls.volume() == 4 && controls.brightness() == 5,
          "a short press with nothing on screen is still volume");
    check(hud.kind() == LevelOverlay::kVolume, "and raises the volume bar");

    tcos::adjustLevel(controls, hud, true, +1, 1100);  // long press
    check(controls.brightness() == 6 && hud.kind() == LevelOverlay::kBrightness,
          "a long press is still brightness");
    tcos::applyShortPress(controls, hud, +1, 1150);
    check(controls.brightness() == 7 && controls.volume() == 4,
          "and further short presses stay in brightness while the bar is up");

    const int gone = 1150 + LevelOverlay::kHoldMs + LevelOverlay::kExitMs + 1;
    tcos::applyShortPress(controls, hud, -1, gone);
    check(controls.volume() == 3 && controls.brightness() == 7,
          "then fall back to volume once it lapses");
  }

  // A settings document the device has already acted on must not disturb the
  // buttons either: the user turns the volume down by hand, and the console's
  // stale request has to stay stale.
  {
    FakeControls controls;
    LevelOverlay hud;
    int applied = 0;
    const SettingsRequest request = settingsFromDoc(
        "seq\t29\nsetseq\t2\nsetvol\t6\nsetvolseq\t2\nsetbri\t8\nsetbriseq\t1\nmenu\t0\n");
    tcos::applyConsoleSettings(request, applied, controls, hud, 1000);
    check(controls.volume() == 6, "the console's request lands once");
    for (int poll = 0; poll < 5; ++poll) {
      tcos::applyShortPress(controls, hud, -1, 2000 + poll * 200);
      tcos::applyConsoleSettings(request, applied, controls, hud, 2000 + poll * 200);
    }
    check(controls.volume() == 1, "and the knob keeps winning on every poll after it");
  }

  // The plan is the whole decision, so state it directly too — a caller that
  // reads applyVolume/applyBrightness must never be told to move a level the
  // console did not name.
  {
    SettingsRequest absent;
    absent.seq = 4;
    absent.volume = 5;
    absent.volumeSeq = 4;  // brightness has never been set: -1, seq 0
    const SettingsPlan plan = tcos::planSettings(absent, 0, 3, 5);
    check(plan.applyVolume && !plan.applyBrightness &&
              plan.bar == SettingsPlan::kVolumeBar,
          "a level the console never set is never applied");
  }
  {
    SettingsRequest stale;
    stale.seq = 4;
    stale.volume = 5;
    stale.volumeSeq = 4;
    stale.brightness = 8;
    stale.brightnessSeq = 4;
    const SettingsPlan plan = tcos::planSettings(stale, 4, 3, 5);
    check(!plan.applyVolume && !plan.applyBrightness &&
              plan.bar == SettingsPlan::kNoBar,
          "a sequence that has not risen plans nothing");
  }
}

// 夜间息屏 — parses the wire block the way the device does.
tcos::SleepRequest sleepFromDoc(const char* body) {
  tcos::StateDoc doc;
  doc.parse(body);
  return doc.sleep();
}

// The inputs of a device that is inside its window, past its timeout, on a
// clock it synced a minute ago. Every case below starts here and changes one
// thing, so what each case is actually about is the line it edits.
tcos::SleepInputs sleepingInputs() {
  tcos::SleepInputs in;
  in.config.enabled = true;
  in.config.startMin = 1380;  // 23:00
  in.config.endMin = 420;     // 07:00
  in.config.idleMs = 300000;  // 5 分钟
  in.nowMs = 3600000;
  in.lastActivityMs = 3600000 - 300000;  // exactly at the timeout
  in.lastPresentMs = 3600000;
  in.lastPanelPercent = 100;
  in.clockSynced = true;
  in.clockAgeMs = 60000;
  in.minuteOfDay = 60;  // 01:00, inside 23:00→07:00
  in.forceAwake = false;
  return in;
}

void checkSleepPolicy() {
  using tcos::SleepConfig;
  using tcos::SleepDecision;
  using tcos::SleepInputs;
  using tcos::SleepRequest;

  // --- the window ----------------------------------------------------------
  // 23:00 → 07:00. Crossing midnight is the ORDINARY case, so it is the first
  // thing asserted rather than a trailing edge case.
  check(tcos::insideSleepWindow(1380, 1380, 420), "23:00 is inside 23:00→07:00");
  check(tcos::insideSleepWindow(1439, 1380, 420), "and so is the last minute before midnight");
  check(tcos::insideSleepWindow(0, 1380, 420), "and midnight itself, on the other side of the wrap");
  check(tcos::insideSleepWindow(419, 1380, 420), "and 06:59");
  check(!tcos::insideSleepWindow(420, 1380, 420),
        "07:00 is already morning — the end is EXCLUSIVE, so the panel comes back on the hour");
  check(!tcos::insideSleepWindow(421, 1380, 420), "and 07:01 is outside");
  check(!tcos::insideSleepWindow(1379, 1380, 420), "and 22:59 is not night yet");

  // A window that does not cross midnight still has to work.
  check(!tcos::insideSleepWindow(59, 60, 120), "01:00→02:00 excludes 00:59");
  check(tcos::insideSleepWindow(60, 60, 120), "includes its start");
  check(tcos::insideSleepWindow(119, 60, 120), "includes the minute before its end");
  check(!tcos::insideSleepWindow(120, 60, 120), "and excludes its end");

  // start == end is 全天, not a zero-length window. A zero-length window is
  // useless; an all-day screensaver is a thing someone would ask for.
  check(tcos::insideSleepWindow(0, 0, 0) && tcos::insideSleepWindow(720, 0, 0) &&
            tcos::insideSleepWindow(1439, 0, 0),
        "start == end means the whole day");

  // The case a `<=` on the end gets wrong: 23:00 → midnight.
  check(tcos::insideSleepWindow(1380, 1380, 0) && tcos::insideSleepWindow(1439, 1380, 0),
        "23:00→00:00 covers the last hour of the day");
  check(!tcos::insideSleepWindow(0, 1380, 0), "and stops AT midnight rather than one minute past");

  // Total for anything: a corrupt prefs value must not produce a window nobody
  // can reason about.
  check(tcos::insideSleepWindow(1440, 1380, 420) == tcos::insideSleepWindow(0, 1380, 420),
        "an out-of-range minute wraps rather than falling off the end");

  // --- localisation --------------------------------------------------------
  // UTC+8 crosses the date line every evening; this is the ordinary case here,
  // and it is why localtime() (which would return UTC on this tzdata-less
  // rootfs) is not used.
  check(tcos::localMinuteOfDay(17 * 3600, 480) == 60,
        "17:00 UTC is 01:00 the next day at UTC+8");
  check(tcos::localMinuteOfDay(0, 480) == 480, "the epoch is 08:00 local");
  check(tcos::localMinuteOfDay(23 * 3600 + 59 * 60, 480) == 479,
        "and 23:59 UTC is 07:59 local, one minute inside the morning");

  // --- the unsynced clock --------------------------------------------------
  // A device booted with the kernel's epoch reads 1970-01-01 00:00, which is
  // INSIDE 23:00→07:00. Without these four guards it blanks itself within
  // `idle` of every boot and the obvious recovery reproduces it exactly.
  {
    SleepInputs in = sleepingInputs();
    in.lastActivityMs = in.nowMs - 900000;  // long past the timeout
    check(tcos::decideSleep(in).asleep, "the baseline case really does sleep");

    in.clockSynced = false;
    const SleepDecision unsynced = tcos::decideSleep(in);
    check(unsynced.panelPercent == 100 && !unsynced.asleep,
          "a clock that has never synced never sleeps");

    in.clockSynced = true;
    in.clockAgeMs = -1;
    check(!tcos::decideSleep(in).asleep, "nor one whose sync has no monotonic stamp");

    in.clockAgeMs = tcos::kClockTrustMs + 1;
    check(!tcos::decideSleep(in).asleep, "nor one whose last sync is older than 26 h");

    in.clockAgeMs = tcos::kClockTrustMs - 1;
    check(tcos::decideSleep(in).asleep,
          "but a router reboot at 23:05 does not light the bedroom all night");
  }

  // --- the countdown and the fade ------------------------------------------
  {
    SleepInputs in = sleepingInputs();
    in.lastActivityMs = in.nowMs - (in.config.idleMs - 1);
    check(tcos::decideSleep(in).panelPercent == 100, "one millisecond short of the timeout is awake");

    in.lastActivityMs = in.nowMs - in.config.idleMs;
    const SleepDecision starting = tcos::decideSleep(in);
    check(starting.panelPercent > 0 && starting.panelPercent < 100,
          "the fade begins at the timeout, at neither extreme");
    check(!starting.asleep && !starting.swallowsInput,
          "and the panel is still visible, so input still acts");

    in.lastActivityMs = in.nowMs - (in.config.idleMs + tcos::kSleepFadeMs);
    const SleepDecision dark = tcos::decideSleep(in);
    check(dark.panelPercent == 0 && dark.asleep, "and reaches black at the end of the fade");

    // Monotonic, sampled across the whole ramp: a fade that brightened halfway
    // would read as a fault rather than as the panel going away.
    int previous = 101;
    bool monotonic = true;
    bool swallowMatches = true;
    for (int idle = 0; idle <= in.config.idleMs + tcos::kSleepFadeMs + 2000; idle += 50) {
      SleepInputs step = sleepingInputs();
      step.lastActivityMs = step.nowMs - idle;
      const SleepDecision d = tcos::decideSleep(step);
      if (d.panelPercent > previous) monotonic = false;
      previous = d.panelPercent;
      if (d.swallowsInput != (d.panelPercent == 0)) swallowMatches = false;
    }
    check(monotonic, "the panel never brightens on its way out");
    check(swallowMatches,
          "and input is swallowed exactly when the panel is black — never during the fade");
  }

  // --- everything uncertain resolves to a lit panel ------------------------
  {
    SleepInputs in = sleepingInputs();
    in.lastActivityMs = in.nowMs + 5000;  // the 24.8-day monotonic wrap
    check(tcos::decideSleep(in).panelPercent == 100, "a negative idle reads as just-used");

    in = sleepingInputs();
    in.lastActivityMs = in.nowMs - 900000;
    in.config.idleMs = 0;  // corrupt prefs
    check(tcos::decideSleep(in).panelPercent == 100,
          "a corrupt timeout of zero never sleeps rather than sleeping instantly");
    in.config.idleMs = -1;
    check(tcos::decideSleep(in).panelPercent == 100, "and neither does a negative one");

    in = sleepingInputs();
    in.lastActivityMs = in.nowMs - 900000;
    in.forceAwake = true;
    check(tcos::decideSleep(in).panelPercent == 100,
          "a pending low-battery shutdown outranks the window and the timeout");

    in = sleepingInputs();
    in.lastActivityMs = in.nowMs - 900000;
    in.config.enabled = false;
    bool alwaysLit = true;
    for (int minute = 0; minute < 1440; minute += 7) {
      in.minuteOfDay = minute;
      if (tcos::decideSleep(in).panelPercent != 100) alwaysLit = false;
    }
    check(alwaysLit, "disabled means lit at every minute of the day and any idle");
  }

  // --- the window closing wakes the panel with no user action --------------
  // The safety property that matters most: there is a guaranteed wall-clock
  // time at which the panel comes back by itself.
  {
    SleepInputs in = sleepingInputs();
    in.lastActivityMs = in.nowMs - 8 * 3600 * 1000;  // nobody has touched it all night
    in.minuteOfDay = 419;                            // 06:59
    check(tcos::decideSleep(in).asleep, "still dark at 06:59");
    in.minuteOfDay = 420;                            // 07:00
    const SleepDecision morning = tcos::decideSleep(in);
    check(morning.panelPercent == 100 && !morning.asleep,
          "and lit at 07:00 without anyone touching it");
    check(morning.repaintDue, "with a frame written on that very tick");
  }

  // --- the repaint contract ------------------------------------------------
  {
    SleepInputs in = sleepingInputs();
    in.lastActivityMs = in.nowMs - 900000;
    in.lastPanelPercent = 1;  // the last frame of the fade
    in.lastPresentMs = in.nowMs;
    check(tcos::decideSleep(in).repaintDue,
          "the FIRST black frame is written immediately, not up to a second later");

    in.lastPanelPercent = 0;
    in.lastPresentMs = in.nowMs - (tcos::kSleepRepaintMs - 1);
    check(!tcos::decideSleep(in).repaintDue, "a dark panel is not rewritten at 50 fps");
    in.lastPresentMs = in.nowMs - tcos::kSleepRepaintMs;
    check(tcos::decideSleep(in).repaintDue,
          "but it is rewritten once a second, so one failed SPI write cannot leave it lit");
  }
  {
    SleepInputs awake = sleepingInputs();
    awake.lastActivityMs = awake.nowMs;
    check(tcos::decideSleep(awake).repaintDue, "an awake tick always presents");
    SleepInputs fading = sleepingInputs();
    fading.lastActivityMs = fading.nowMs - (fading.config.idleMs + 300);
    check(tcos::decideSleep(fading).repaintDue, "and so does every tick of the fade");
  }

  // --- waking --------------------------------------------------------------
  {
    SleepInputs in = sleepingInputs();
    in.lastActivityMs = in.nowMs;  // the knob just moved
    in.lastPanelPercent = 0;
    const SleepDecision woken = tcos::decideSleep(in);
    check(woken.panelPercent == 100 && !woken.asleep && woken.repaintDue,
          "one input lights the panel on the SAME tick, with no fade-in to wait through");
    check(!woken.swallowsInput, "and the next input acts normally");
  }

  // --- "the console tab was left open all night" ---------------------------
  // Eight simulated hours in which nowMs advances, the panel is repainted, and
  // lastActivityMs never moves — which is exactly what a mirror poll produces,
  // because a mirror poll is not activity. If polling counted, this loop would
  // find the panel awake and the feature would be dead for the one person most
  // likely to have configured it.
  {
    SleepInputs in = sleepingInputs();
    // 23:00 → 09:30, so the whole simulated night stays inside the window and
    // this case is about the countdown alone. The window closing is asserted on
    // its own two blocks up.
    in.config.endMin = 570;
    in.nowMs = 0;
    in.lastActivityMs = 0;
    in.lastPresentMs = 0;
    in.lastPanelPercent = 100;
    int repaints = 0;
    int litTicks = 0;
    const int totalMs = 8 * 3600 * 1000;
    for (int t = 0; t <= totalMs; t += 20) {
      in.nowMs = t;
      // 01:00 plus the elapsed minutes, so the clock really does move through
      // the night with the loop.
      in.minuteOfDay = (60 + t / 60000) % 1440;
      const SleepDecision d = tcos::decideSleep(in);
      if (d.panelPercent != 0) ++litTicks;
      if (d.repaintDue) {
        ++repaints;
        in.lastPresentMs = t;
        in.lastPanelPercent = d.panelPercent;
      }
    }
    // Lit for the 5-minute timeout and the 600 ms fade, then never again.
    check(litTicks == (300000 + tcos::kSleepFadeMs) / 20,
          "the panel goes dark once and stays dark for eight hours");
    // One repaint per second after the ramp, plus the ramp's own every-tick
    // presents. Bounded rather than exact because the first black frame lands on
    // whichever 20 ms tick the fade ends on.
    const int darkMs = totalMs - 300000 - tcos::kSleepFadeMs;
    check(repaints >= litTicks + darkMs / 1000 &&
              repaints <= litTicks + darkMs / 1000 + 2,
          "and is rewritten about once a second while it is, never fifty times");
  }

  // --- the console request -------------------------------------------------
  {
    // Byte-for-byte the block OsLinkHub.serialize() emits, in its order.
    const SleepRequest wire = sleepFromDoc(
        "seq\t9\npinned\t0\nmirror\t0\n"
        "sleepseq\t4\nsleepon\t1\nsleepfrom\t1380\nsleeptill\t420\nsleepidle\t300\n"
        "menu\t0\n");
    check(wire.seq == 4 && wire.on == 1 && wire.startMin == 1380 && wire.endMin == 420 &&
              wire.idleSec == 300,
          "the sleep block parses off the wire");

    const SleepRequest absent = sleepFromDoc("seq\t1\nmenu\t0\n");
    check(absent.seq == 0 && absent.on == -1 && absent.startMin == -1 &&
              absent.endMin == -1 && absent.idleSec == -1,
          "and a document without one leaves every field unnamed");

    SleepConfig config;  // off, 23:00-07:00, 5 分钟
    int applied = 0;
    check(tcos::applySleepRequest(wire, applied, &config), "a rising sequence is adopted");
    check(applied == 4, "and moves the applied sequence");
    check(config.enabled && config.startMin == 1380 && config.endMin == 420 &&
              config.idleMs == 300000,
          "landing every field");

    // The document repeats the request on every poll forever; acting on it
    // again is what would make the device's own 设置 rows useless.
    config.enabled = false;
    check(!tcos::applySleepRequest(wire, applied, &config),
          "the same document is not acted on twice");
    check(!config.enabled, "so the knob keeps winning after the console has spoken");
  }
  {
    // A console that only flips the switch must not clear the window.
    SleepConfig config;
    config.startMin = 90;
    config.endMin = 200;
    config.idleMs = 600000;
    int applied = 0;
    const SleepRequest onlyOn = sleepFromDoc("seq\t1\nsleepseq\t2\nsleepon\t1\nmenu\t0\n");
    check(tcos::applySleepRequest(onlyOn, applied, &config), "an enable-only request applies");
    check(config.enabled && config.startMin == 90 && config.endMin == 200 &&
              config.idleMs == 600000,
          "and leaves the window and the timeout exactly as they were");
  }
  {
    // The device does not trust the wire, even though the service validates.
    SleepConfig config;
    int applied = 0;
    const SleepRequest silly = sleepFromDoc(
        "seq\t1\nsleepseq\t3\nsleepon\t1\nsleepfrom\t1440\nsleeptill\t99999\n"
        "sleepidle\t99999999\nmenu\t0\n");
    tcos::applySleepRequest(silly, applied, &config);
    check(config.startMin == 0, "an out-of-range start wraps rather than being stored raw");
    check(config.endMin == (99999 % 1440), "and so does an out-of-range end");
    check(config.idleMs == tcos::kMaxIdleMs, "and an absurd timeout is clamped, not overflowed");
  }
  {
    SleepConfig config;
    int applied = 7;
    const SleepRequest stale = sleepFromDoc("seq\t1\nsleepseq\t7\nsleepon\t1\nmenu\t0\n");
    check(!tcos::applySleepRequest(stale, applied, &config),
          "a sequence equal to the applied one does nothing");
    check(!config.enabled, "and the config is untouched");
  }
  {
    // THE SERVICE RESTARTED. The hub's sequence is plain instance state in the
    // Bun process — `bun run build` after any web/ change restarts it — so it
    // comes back at 1 while this device is still up holding the last number it
    // applied. Refusing everything below that high-water mark is what killed
    // the documented way back for a dark panel: `PUT /api/os/sleep
    // {enabled:false}` at 02:00 answers 200, reports `requested`, and does
    // nothing, five times over, with nothing anywhere saying so.
    SleepConfig config;
    config.enabled = true;
    int applied = 9;
    const SleepRequest restarted =
        sleepFromDoc("seq\t1\nsleepseq\t1\nsleepon\t0\nmenu\t0\n");
    check(tcos::applySleepRequest(restarted, applied, &config),
          "a sequence that went BACKWARDS is a restarted service, not a replay");
    check(!config.enabled, "so the remote escape hatch still lands");
    check(applied == 1, "and the device follows the new counter");
    // ...and the replay guard the sequence exists for is still armed: the
    // document repeats this request on every poll for as long as it stands.
    config.enabled = true;
    check(!tcos::applySleepRequest(restarted, applied, &config),
          "the same document is still not acted on twice");
    check(config.enabled, "so the knob keeps winning");
  }

  // --- sanitise ------------------------------------------------------------
  {
    SleepConfig raw;
    raw.startMin = -30;
    raw.endMin = 2880;
    raw.idleMs = 10;
    const SleepConfig safe = tcos::sanitizeSleepConfig(raw);
    check(safe.startMin == 1410 && safe.endMin == 0, "minutes wrap into the day");
    check(safe.idleMs == tcos::kMinIdleMs, "and a sub-30-second timeout is floored");
    raw.idleMs = 99999999;
    check(tcos::sanitizeSleepConfig(raw).idleMs == tcos::kMaxIdleMs, "as a huge one is capped");
  }

  // --- the fade is a Presenter concern, and the awake path is unchanged ----
  {
    using tcos::Presenter;
    bool identical = true;
    for (int step = 1; step <= Presenter::kBrightnessSteps; ++step) {
      for (int v = 0; v <= 255; ++v) {
        if (Presenter::dimByte((uint8_t)v, step, 100) != Presenter::scaleByte((uint8_t)v, step)) {
          identical = false;
        }
      }
    }
    check(identical, "at 100% the fade is byte-for-byte the frame the firmware always sent");

    bool black = true;
    for (int step = 1; step <= Presenter::kBrightnessSteps; ++step) {
      for (int v = 0; v <= 255; ++v) {
        if (Presenter::dimByte((uint8_t)v, step, 0) != 0) black = false;
      }
    }
    // NO floor of 1 here, unlike scaleByte: that floor stops dimming from
    // deleting content, whereas a fade's whole job is to reach black.
    check(black, "and at 0% every byte is zero, so the panel is genuinely dark");

    bool monotonic = true;
    for (int percent = 1; percent < 100; ++percent) {
      if (Presenter::dimByte(255, 10, percent) > Presenter::dimByte(255, 10, percent + 1)) {
        monotonic = false;
      }
    }
    check(monotonic, "and the ramp between them never brightens");
  }
}

// The two rows as the user actually reads them, so the panel text is asserted
// rather than eyeballed on hardware nobody can screenshot.
void checkSleepRows() {
  using tcos::SleepConfig;

  SleepConfig cfg;  // off, 23:00-07:00, 5 分钟
  check(tcos::formatSleepWindow(cfg, true) == "\xE5\x85\xB3\xE9\x97\xAD",
        "the row reads 关闭 while the feature is off");

  cfg.enabled = true;
  check(tcos::formatSleepWindow(cfg, true) == "23-07",
        "and 23-07 when on — hours only, because 23:00-07:00 is 66 px against a 50 px clip");
  // APPENDED, not substituted. Replacing the window rendered all four settings
  // identically on a clock that has not synced — which is every freshly flashed
  // unit before Wi-Fi, i.e. exactly the user who is poking at 设置 to see what
  // the row does. Four settings, one string, and no way to count presses back
  // to 关闭.
  check(tcos::formatSleepWindow(cfg, false) ==
            "23-07 \xE7\xAD\x89\xE5\xBE\x85\xE6\xA0\xA1\xE6\x97\xB6",
        "an untrusted clock says so BESIDE the window, not instead of it");
  {
    SleepConfig other = cfg;
    other.startMin = 1320;
    check(tcos::formatSleepWindow(other, false) != tcos::formatSleepWindow(cfg, false),
          "so two different windows never read the same on an unsynced clock");
  }

  cfg.startMin = 0;
  cfg.endMin = 0;
  check(tcos::formatSleepWindow(cfg, true) == "\xE5\x85\xA8\xE5\xA4\xA9",
        "start == end reads 全天 rather than as an empty window");

  cfg.startMin = 1410;  // 23:30
  cfg.endMin = 405;     // 06:45
  check(tcos::formatSleepWindow(cfg, true) == "23:30-06:45",
        "minutes appear only when an endpoint is off the hour, which only a console produces");

  SleepConfig idle;
  idle.idleMs = 300000;
  check(tcos::formatSleepIdle(idle) == "5\xE5\x88\x86\xE9\x92\x9F", "5分钟");
  idle.idleMs = 1800000;
  check(tcos::formatSleepIdle(idle) == "30\xE5\x88\x86\xE9\x92\x9F", "30分钟");
  idle.idleMs = 45000;
  check(tcos::formatSleepIdle(idle) == "45\xE7\xA7\x92",
        "a console-set 45 s says 45秒 rather than rounding to a minute it does not honour");

  // Every codepoint these rows can put on the panel has a glyph. A missing one
  // draws as a gap, which on a 52 px row is indistinguishable from a bug.
  {
    const char* strings[8] = {
      "\xE5\xA4\x9C\xE9\x97\xB4\xE6\x81\xAF\xE5\xB1\x8F",              // 夜间息屏
      "\xE6\x81\xAF\xE5\xB1\x8F\xE7\xAD\x89\xE5\xBE\x85",              // 息屏等待
      "\xE5\x85\xB3\xE9\x97\xAD",                                      // 关闭
      "\xE5\x85\xA8\xE5\xA4\xA9",                                      // 全天
      "23-07 \xE7\xAD\x89\xE5\xBE\x85\xE6\xA0\xA1\xE6\x97\xB6",        // 23-07 等待校时
      "5\xE5\x88\x86\xE9\x92\x9F",                                     // 5分钟
      "45\xE7\xA7\x92",                                                // 45秒
      "23:30-06:45",
    };
    bool covered = true;
    for (int i = 0; i < 8; ++i) {
      const char* p = strings[i];
      while (*p != '\0') {
        const uint32_t cp = tcos::text::utf8Next(p);
        if (tcos::glyphs::lookup(cp).rows == 0) covered = false;
      }
    }
    check(covered, "every glyph these two rows can draw is in the font");
  }

  // 夜间息屏 is four CJK cells, the widest a label can be on this panel — the
  // same geometry 夜间休眠 had, so this is a copy change and not a layout one.
  check(tcos::text::measure("\xE5\xA4\x9C\xE9\x97\xB4\xE6\x81\xAF\xE5\xB1\x8F") == 48,
        "the label is exactly 48 px, the four-cell maximum");
  check(tcos::text::measure("\xE6\x81\xAF\xE5\xB1\x8F\xE7\xAD\x89\xE5\xBE\x85") == 48,
        "and so is the second one");
  check(tcos::text::measure("23-07") <= 50, "and the value fits the row without a marquee");
  // The unsynced form does NOT fit, and that is the accepted trade: drawRow
  // marquees anything wider than the clip, and this is the abnormal state where
  // the user needs both halves of the answer.
  check(tcos::text::measure("23-07 \xE7\xAD\x89\xE5\xBE\x85\xE6\xA0\xA1\xE6\x97\xB6") > 50,
        "while the untrusted-clock form marquees, which is why it is not the normal one");

  // --- the cycles ----------------------------------------------------------
  {
    // 关闭 → 22-07 → 23-07 → 00-08 → 关闭. A full lap returns to where it
    // started, so a user who overshoots can keep pressing rather than needing a
    // second control to go back.
    SleepConfig at;  // off, 23:00-07:00
    SleepConfig walk = at;
    walk = tcos::cycleSleepWindow(walk);
    check(walk.enabled && walk.startMin == 1320 && walk.endMin == 420, "关闭 → 22-07");
    walk = tcos::cycleSleepWindow(walk);
    check(walk.startMin == 1380 && walk.endMin == 420, "22-07 → 23-07");
    walk = tcos::cycleSleepWindow(walk);
    check(walk.startMin == 0 && walk.endMin == 480, "23-07 → 00-08");
    walk = tcos::cycleSleepWindow(walk);
    check(!walk.enabled && walk.startMin == 0 && walk.endMin == 480,
          "00-08 → 关闭, which keeps the window it came from");
  }
  {
    // 全天 IS NOT ON THE KNOB, and this is the assertion that says so.
    //
    // It used to sit one detent past 00-08, so 关闭 → 22-07 → 23-07 → 00-08 →
    // 全天 → 关闭(全天) turned a night-sleep clock into an all-day screensaver in
    // two presses of a row a user was merely reading — and left 关闭 holding
    // 全天, so the next enable landed there too. 全天 is also the one mode with
    // no wall-clock moment at which the panel comes back by itself, which is the
    // safety property everything else here is built on. A console form can label
    // it and explain it; a 52 px row pressed to find out what it does cannot.
    SleepConfig walk;  // off, 23:00-07:00
    bool everWholeDay = false;
    for (int i = 0; i < 24; ++i) {
      walk = tcos::cycleSleepWindow(walk);
      if (walk.enabled && walk.startMin == walk.endMin) everWholeDay = true;
    }
    check(!everWholeDay, "no number of knob presses can reach 全天");
  }
  {
    // 关闭 KEEPS the window in the CONFIG rather than clearing it: telemetry
    // keeps reporting it and a console `{enabled:true}` restores it. It does not
    // mean the next press returns to it — this is a ring, and 22-07 is the next
    // stop. The two claims are easy to conflate, so both are pinned here.
    SleepConfig off;
    off.enabled = false;
    off.startMin = 1410;  // 23:30
    off.endMin = 405;     // 06:45
    const SleepConfig next = tcos::cycleSleepWindow(off);
    check(next.enabled && next.startMin == 1320 && next.endMin == 420,
          "from 关闭 the ring advances to 22-07");
  }
  {
    // THE PRESS THAT LEAVES A CONSOLE-SET WINDOW LANDS ON 关闭, WHICH KEEPS IT.
    //
    // The config holds one window, so whatever a press moves to is what replaces
    // it; the most a cycle row can promise is that the first press is
    // recoverable. It is: 关闭 keeps 23:30-06:45 in the config, telemetry still
    // reports it, and one console `{enabled:true}` brings it back. The custom
    // entry therefore sits LAST in the lap. Putting it first — where it was —
    // stepped straight over it onto 22-07 and destroyed a console setting on
    // press one; putting it first AND returning to it from 关闭 is a two-stop
    // ring with the presets unreachable.
    SleepConfig custom;
    custom.enabled = true;
    custom.startMin = 1410;
    custom.endMin = 405;
    SleepConfig walk = tcos::cycleSleepWindow(custom);
    check(!walk.enabled && walk.startMin == 1410 && walk.endMin == 405,
          "one press off a custom window turns it off WITHOUT throwing the window away");
    walk = tcos::cycleSleepWindow(walk);
    check(walk.enabled && walk.startMin == 1320 && walk.endMin == 420,
          "and the press after that starts the preset lap, in full view of the user");
    for (int i = 0; i < 2; ++i) walk = tcos::cycleSleepWindow(walk);
    check(walk.enabled && walk.startMin == 0 && walk.endMin == 480,
          "the presets still walk through from there");
    walk = tcos::cycleSleepWindow(walk);
    check(!walk.enabled, "and back off, so no lap is a dead end");
  }
  {
    // Every stop of every lap, from every starting point, is either 关闭 or a
    // window that ends at a different minute from the one it starts at. That is
    // the property the panel's guaranteed self-wake rests on, so it is asserted
    // over the whole reachable set rather than along one path.
    SleepConfig starts[4];
    starts[0] = SleepConfig();                       // the shipped default
    starts[1].enabled = true;                        // on, 23:00-07:00
    starts[2].enabled = true; starts[2].startMin = 1410; starts[2].endMin = 405;  // custom
    starts[3].enabled = true; starts[3].startMin = 0; starts[3].endMin = 0;       // 全天 by wire
    bool safe = true;
    for (int s = 0; s < 4; ++s) {
      SleepConfig walk = starts[s];
      for (int i = 0; i < 24; ++i) {
        walk = tcos::cycleSleepWindow(walk);
        if (walk.enabled && walk.startMin == walk.endMin) safe = false;
      }
    }
    check(safe,
          "even starting from a console-set 全天, the knob can only reach windows that end");
  }
  {
    // 1 → 3 → 5 → 10 → 30 分钟 → 1.
    SleepConfig at;
    at.idleMs = 60000;
    at = tcos::cycleSleepIdle(at);
    check(at.idleMs == 180000, "1分钟 → 3分钟");
    at = tcos::cycleSleepIdle(at);
    check(at.idleMs == 300000, "3分钟 → 5分钟");
    at = tcos::cycleSleepIdle(at);
    check(at.idleMs == 600000, "5分钟 → 10分钟");
    at = tcos::cycleSleepIdle(at);
    check(at.idleMs == 1800000, "10分钟 → 30分钟");
    at = tcos::cycleSleepIdle(at);
    check(at.idleMs == 60000, "30分钟 → 1分钟");
  }

  // --- the row shows what the press changed --------------------------------
  // Without revealValue a cycle row changes something invisible: the label is
  // still up for 1100 ms, the user presses again, and the setting jumps two.
  {
    tcos::SettingsScreen screen;
    Surface out(52, 16);
    std::vector<tcos::SettingsScreen::Row> rows;
    tcos::SettingsScreen::Row row;
    row.id = 2;
    row.label = "\xE5\xA4\x9C\xE9\x97\xB4\xE6\x81\xAF\xE5\xB1\x8F";  // 夜间息屏
    row.value = "23-07";
    rows.push_back(row);
    screen.setRows(rows, 0);
    screen.onEnter(0);

    out.clear();
    screen.render(out, 200);
    const int label = litPixels(out);

    // Same instant, without the reveal: still the label, for another second.
    out.clear();
    screen.render(out, 200 + tcos::SettingsScreen::kSwapMs + 10);
    check(litPixels(out) == label, "the dwell would otherwise hold the label past the press");

    screen.revealValue(200);
    out.clear();
    screen.render(out, 200 + tcos::SettingsScreen::kSwapMs + 10);
    check(litPixels(out) > 0 && litPixels(out) != label,
          "revealValue puts the new value on the row instead");
  }
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
    // The annotations, from the real encoder's bytes rather than from a
    // hand-written approximation of them. This is the half the hand-written
    // fixtures below cannot prove: that the service puts them where this parser
    // looks, in the order it emits them, with the ids it repeats.
    static const char* kRevs[6] = {"9f14c0b2ae31", "e90a8dc5b287", "0c33d18a7b45",
                                   "", "", ""};
    static const int kTtls[6] = {60000, 10000, 30000, 0, 0, 0};
    for (int i = 0; i < 6; ++i) {
      char label[64];
      std::snprintf(label, sizeof(label), "item %d's revision and ttl round-trip", i);
      check(doc.items()[i].rev == kRevs[i] && doc.items()[i].ttlMs == kTtls[i], label);
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

  // --- the annotations that make an edit visible ---------------------------
  // `rev` and `ttl` are separate keys rather than extra fields on `item`,
  // because this parser matches `item` on a strict arity of four: a fifth field
  // would drop every menu entry and take the channel ring with it.
  StateDoc annotated;
  check(annotated.parse("seq\t20\nmenu\t3\n"
                        "item\tchannel\tbtc\tA\n"
                        "rev\tbtc\tdeadbeef0001\n"
                        "ttl\tbtc\t30000\n"
                        "item\tchannel\tmatrixclock\tB\n"
                        "rev\tmatrixclock\te90a8dc5b287\n"
                        "ttl\tmatrixclock\t10000\n"
                        "item\tsettings\tsettings\tC\n"),
        "a document carrying revisions and ttls parses");
  check(annotated.items().size() == 3, "and the annotations are not mistaken for items");
  if (annotated.items().size() == 3) {
    check(annotated.items()[0].rev == "deadbeef0001" && annotated.items()[0].ttlMs == 30000,
          "the first channel's annotations land on the first channel");
    check(annotated.items()[1].rev == "e90a8dc5b287" && annotated.items()[1].ttlMs == 10000,
          "and the second's on the second — matched by id, not by position");
    check(annotated.items()[2].rev.empty() && annotated.items()[2].ttlMs == 0,
          "an item nobody annotated carries neither");
  }

  // Order independence, which is the entire reason each record repeats its id.
  StateDoc reordered;
  reordered.parse("seq\t21\nmenu\t2\nrev\tb\tsecond\nttl\ta\t30000\n"
                  "item\tchannel\ta\tA\nitem\tchannel\tb\tB\nrev\ta\tfirst\n");
  check(reordered.items().size() == 2 && reordered.items()[0].rev == "first" &&
            reordered.items()[0].ttlMs == 30000 && reordered.items()[1].rev == "second",
        "annotations find their item whatever order they arrive in");

  StateDoc orphan;
  orphan.parse("seq\t22\nmenu\t1\nitem\tchannel\ta\tA\nrev\tgone\tzzz\nttl\tgone\t9000\n");
  check(orphan.items().size() == 1 && orphan.items()[0].rev.empty(),
        "an annotation naming a channel this menu does not have is dropped");

  // The ttl floor. A refresh costs this device a whole frame bundle over the
  // radio that is also carrying the long poll, and the service caches a render
  // for 5 s — so a shorter ttl cannot produce a new pixel, it can only produce
  // a download loop.
  StateDoc floored;
  floored.parse("seq\t23\nmenu\t1\nitem\tchannel\ta\tA\nttl\ta\t1000\n");
  check(floored.items()[0].ttlMs == tcos::StateDoc::kMinTtlMs,
        "a ttl below the device's own floor is raised to it");
  StateDoc nonsense;
  nonsense.parse("seq\t24\nmenu\t2\nitem\tchannel\ta\tA\nttl\ta\t0\n"
                 "item\tchannel\tb\tB\nttl\tb\t-5\n");
  check(nonsense.items()[0].ttlMs == 0 && nonsense.items()[1].ttlMs == 0,
        "a zero or negative ttl reads as 'does not expire' rather than 'expire now'");

  // An OLDER service, which is the compatibility direction that actually ships:
  // the firmware is flashed by hand, the service updates itself.
  StateDoc legacy;
  legacy.parse("seq\t25\nmenu\t1\nitem\tchannel\tbtc\tA\n");
  check(legacy.items().size() == 1 && legacy.items()[0].rev.empty() &&
            legacy.items()[0].ttlMs == 0,
        "a menu with no rev/ttl lines yields exactly what it did before they existed");

  // --- the signature the channel ring is rebuilt on ------------------------
  // Keyed on kind/id/label alone this answered "nothing changed" to every
  // content edit ever made, which is where the news died before it reached the
  // ring at all.
  const std::string signatureA = tcos::menuSignature(annotated.items());
  StateDoc edited;
  edited.parse("seq\t26\nmenu\t3\n"
               "item\tchannel\tbtc\tA\n"
               "rev\tbtc\tdeadbeef0001\n"
               "ttl\tbtc\t30000\n"
               "item\tchannel\tmatrixclock\tB\n"
               "rev\tmatrixclock\t0000feed9999\n"   // the same channel, new pixels
               "ttl\tmatrixclock\t10000\n"
               "item\tsettings\tsettings\tC\n");
  check(tcos::menuSignature(edited.items()) != signatureA,
        "an edit that moves only a revision moves the signature");
  StateDoc republished;
  republished.parse("seq\t27\nmenu\t3\n"
                    "item\tchannel\tbtc\tA\n"
                    "rev\tbtc\tdeadbeef0001\n"
                    "ttl\tbtc\t30000\n"
                    "item\tchannel\tmatrixclock\tB\n"
                    "rev\tmatrixclock\te90a8dc5b287\n"
                    "ttl\tmatrixclock\t10000\n"
                    "item\tsettings\tsettings\tC\n");
  check(tcos::menuSignature(republished.items()) == signatureA,
        "and a republished identical menu does not — the ring is not rebuilt for a lyric");
  StateDoc retimed;
  retimed.parse("seq\t28\nmenu\t1\nitem\tchannel\tbtc\tA\nrev\tbtc\tdeadbeef0001\n"
                "ttl\tbtc\t45000\n");
  StateDoc sameButFaster;
  sameButFaster.parse("seq\t29\nmenu\t1\nitem\tchannel\tbtc\tA\nrev\tbtc\tdeadbeef0001\n"
                      "ttl\tbtc\t30000\n");
  check(tcos::menuSignature(retimed.items()) != tcos::menuSignature(sameButFaster.items()),
        "a changed refresh interval reaches the ring too — it is what times the next fetch");
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
    // Mirrors the REAL actuator's contract, including the half it got wrong
    // for a year: an empty list answers false — "not done yet" — never "done,
    // nothing there". The supplicant's cache is legitimately empty while the
    // sweep runs, and a fake that reported that as completion let the policy
    // tests stay green while the device raised its hotspot 160 ms in and
    // killed every real sweep. See DeviceWifi::scanSweepComplete.
    if (!scanDone) return false;
    if (visible.empty()) return false;
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
// `tint` goes in the GREEN channel, which is how a test says WHICH bundle is on
// the panel rather than which frame of one. That is the question the refresh
// path asks: two renders of the same channel differ only in their pixels.
std::string makeBundleTinted(int frames, int delayMs, int tint) {
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
      out.push_back(static_cast<char>(tint & 0xFF));
      out.push_back(static_cast<char>(0));
    }
  }
  return out;
}

std::string makeBundle(int frames, int delayMs) {
  return makeBundleTinted(frames, delayMs, 0);
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

  // Headers reach the caller, because /api/os/frames answers with the revision
  // it actually served. Without that the device can only record the revision
  // the state document happened to advertise when it decided to ask, and a save
  // landing in between costs a redundant ~900 KB round trip.
  tcos::HttpClient::Response annotated;
  check(tcos::HttpClient::parseResponse(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
            "X-Os-Rev: e90a8dc5b287\r\nContent-Length: 2\r\n\r\nok",
            &annotated.status, &annotated.body, &annotated.headers),
        "a response with headers parses");
  check(annotated.header("x-os-rev") == "e90a8dc5b287",
        "and the served revision is readable, whatever case the peer spelled it in");
  check(annotated.header("content-type") == "application/octet-stream",
        "so is any other header");
  check(annotated.header("x-absent").empty(), "an absent header is empty, not garbage");
  // "\r\nrev:" must not match inside "\r\nx-os-rev:", or a service that ever
  // sends both would hand the device the wrong one.
  check(annotated.header("rev").empty(), "a header name is not matched as another's tail");
  tcos::HttpClient::Response bare;
  check(tcos::HttpClient::parseResponse("HTTP/1.0 200 OK\r\nX: y\r\n\r\nb", &bare.status,
                                        &bare.body, &bare.headers),
        "a response from a service that sends no revision still parses");
  check(bare.header("x-os-rev").empty(),
        "and reports no revision rather than an invented one");

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
  check(ring.takeSelectionChanged(), "the first menu asks for the settled channel's frames");
  check(!ring.takeSelectionChanged(), "and asks exactly once");

  // Before the frames land the name is the only thing there is to draw.
  out.clear();
  ring.render(out, 300);
  check(litPixels(out) > 0, "the loading page draws the channel name");

  tcos::FrameBundle bundle;
  check(bundle.parse(makeBundle(4, 100)), "the test bundle decodes");
  ring.adoptFrames(bundle, "btc", "", 1000);
  check(ring.status() == tcos::ChannelRingScreen::kReady, "frames for the settled channel are adopted");
  ring.render(out, 1000);
  check(out.getPixel(0, 0).r == 1, "playback starts at frame 0");
  ring.render(out, 1250);
  check(out.getPixel(0, 0).r == 3, "and advances with the frame delays");

  // Frames that arrive after the knob moved on must be dropped, or a slow
  // channel paints over the one the user is actually looking at.
  tcos::FrameBundle stale;
  check(stale.parse(makeBundle(2, 100)), "a second bundle decodes");
  ring.adoptFrames(stale, "flux", "", 1300);
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
  ring.adoptFrames(fluxFrames, "flux", "", 3000);
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
  ring.adoptFrames(fluxFrames, ring.currentApp(), "", 10000);
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

// "我把字改了，预览更新了，机器没更新——得旋一下旋钮再旋回来。"
//
// The regression suite for that sentence, driven end to end: real service bytes
// through the real parser, the real menu-to-ring mapping, the real screen and
// the real link gate, in osLogic's own order. Every check below fails on the
// firmware as it stood, and each fails for its own independent reason — the
// document had no vocabulary for a changed render, the ring kept its frames
// through every republish, and the link could not be asked twice for one
// channel. Turning the knob away and back was the only gesture that got past
// all three, which is exactly why it was the workaround the user found.
void checkChannelRefreshPath() {
  using tcos::ChannelRingScreen;
  using tcos::HostLink;
  using tcos::StateDoc;

  // --- the link's gate -----------------------------------------------------
  // No threads: start() is never called, so nothing here opens a socket. What
  // is under test is which asks are allowed to reach the network at all.
  HostLink link;
  check(link.channelRequestCount() == 0, "a link nobody has asked anything of has no request");
  link.selectChannel("matrixclock", "e90a8dc5b287");
  check(link.channelRequestCount() == 1, "selecting a channel raises one request");
  link.selectChannel("matrixclock", "e90a8dc5b287");
  link.selectChannel("matrixclock", "e90a8dc5b287");
  check(link.channelRequestCount() == 1,
        "re-asking for content already asked for raises none — a screen may call this every tick");
  link.selectChannel("matrixclock", "0000feed9999");
  check(link.channelRequestCount() == 2,
        "the SAME channel at a new revision is a new request — the lock this whole change opens");
  link.selectChannel("btc", "0000feed9999");
  check(link.channelRequestCount() == 3, "and so is a different channel");
  link.refreshChannel("btc", "0000feed9999");
  check(link.channelRequestCount() == 4,
        "a forced refresh asks even though nothing about the channel moved");
  link.selectChannel("btc", "0000feed9999");
  check(link.channelRequestCount() == 4, "which does not make the next ordinary ask fire");
  // An older service sends no revision. Empty compares equal to empty, so such
  // a device keeps exactly the behaviour it has always had: one fetch per
  // channel change, and no content-driven refresh at all.
  HostLink legacyLink;
  legacyLink.selectChannel("btc", "");
  legacyLink.selectChannel("btc", "");
  check(legacyLink.channelRequestCount() == 1,
        "against an older service a re-select is still a no-op, exactly as before");

  // --- the document, the mapping and the screen ----------------------------
  // Verbatim OsLinkHub.serialize() shape, annotations included. `menu` is only
  // a hint and `settings` is in here because the mapping has to drop it.
  static const char* kDocA =
      "seq\t30\npinned\t0\nmirror\t0\nmode\tspotlight\nskin\tsignal\n"
      "menu\t2\n"
      "item\tchannel\tmatrixclock\t\xE6\x95\xB0\xE5\xAD\x97\xE9\x9B\xA8\xE6\x97\xB6\xE9\x92\x9F\n"
      "rev\tmatrixclock\te90a8dc5b287\n"
      "ttl\tmatrixclock\t10000\n"
      "item\tsettings\tsettings\t\xE8\xAE\xBE\xE7\xBD\xAE\n";
  // The same menu after the user recoloured the channel: same id, same label,
  // same position, same everything a pre-fix build could see.
  static const char* kDocB =
      "seq\t31\npinned\t0\nmirror\t0\nmode\tspotlight\nskin\tsignal\n"
      "menu\t2\n"
      "item\tchannel\tmatrixclock\t\xE6\x95\xB0\xE5\xAD\x97\xE9\x9B\xA8\xE6\x97\xB6\xE9\x92\x9F\n"
      "rev\tmatrixclock\t0000feed9999\n"
      "ttl\tmatrixclock\t10000\n"
      "item\tsettings\tsettings\t\xE8\xAE\xBE\xE7\xBD\xAE\n";

  StateDoc docA;
  StateDoc docB;
  check(docA.parse(kDocA) && docB.parse(kDocB), "both documents parse");
  const std::vector<ChannelRingScreen::Entry> menuA =
      ChannelRingScreen::channelEntries(docA.items());
  const std::vector<ChannelRingScreen::Entry> menuB =
      ChannelRingScreen::channelEntries(docB.items());
  check(menuA.size() == 1 && menuA[0].appName == "matrixclock" && menuA[0].ttlMs == 10000 &&
            menuA[0].rev == "e90a8dc5b287",
        "the mapping keeps the channels and everything the ring compares");

  ChannelRingScreen ring;
  Surface out(52, 16);
  ring.setEntries(menuA, 0);
  ring.onEnter(0);
  check(ring.takeSelectionChanged(), "the first menu asks for the settled channel");
  ring.takeRefreshDue(0);  // onEnter's own force, consumed the way the tick does

  tcos::FrameBundle green;
  check(green.parse(makeBundleTinted(2, 1000, 200)), "the first render decodes");
  ring.adoptFrames(green, "matrixclock", "e90a8dc5b287", 1000);
  ring.render(out, 1200);
  check(out.getPixel(0, 0).g == 200, "and is what the panel is showing");

  // 1. An UNCHANGED document must not re-fetch. A fix that re-asked on every
  //    poll would stall the device: this menu is republished on every settings
  //    change, and each fetch is up to ~900 KB over the radio that is also
  //    holding the long poll.
  ring.setEntries(menuA, 2000);
  check(!ring.takeSelectionChanged(), "a republished identical menu asks for nothing");
  check(!ring.takeRefreshDue(2000), "and does not count as staleness either");
  check(ring.status() == ChannelRingScreen::kReady, "the frames stay up");
  ring.render(out, 2200);
  check(out.getPixel(0, 0).g == 200, "and keep playing, uninterrupted");

  // 2. A CHANGED revision must invalidate, with no gesture from the user. This
  //    is the reported bug, in one assertion.
  ring.setEntries(menuB, 3000);
  check(ring.currentApp() == "matrixclock", "the user is not moved off their channel");
  check(ring.status() == ChannelRingScreen::kLoading, "but the stale frames are dropped");
  check(ring.takeSelectionChanged(), "and the new ones are asked for");
  // Both flags, the way the tick drains them: invalidate raises the forced one
  // too, precisely so a knob wiggle that nets out to zero cannot leave the ring
  // holding no frames and no outstanding request.
  check(ring.takeRefreshDue(3000), "invalidate arms a FORCED refresh, not only a selection");
  ring.render(out, 3100);
  check(out.getPixel(0, 0).g != 200, "the panel is no longer showing the old render");

  tcos::FrameBundle red;
  check(red.parse(makeBundleTinted(2, 1000, 90)), "the new render decodes");
  ring.adoptFrames(red, "matrixclock", "0000feed9999", 3500);
  ring.render(out, 3600);
  check(out.getPixel(0, 0).g == 90, "the edit is on the panel, knob untouched");
  // ...and having arrived, it is not asked for again.
  ring.setEntries(menuB, 4000);
  check(!ring.takeSelectionChanged() && !ring.takeRefreshDue(4000),
        "the menu that produced those frames does not invalidate them a second time");

  // 3. An EXPIRED ttl must re-fetch, because nothing else can advance a clock:
  //    大字天气钟 renders ten seconds of a time that is now in the past, and no
  //    revision moves while it recedes.
  check(!ring.takeRefreshDue(3500 + 9999), "a bundle inside its ttl is not stale");
  check(ring.takeRefreshDue(3500 + 10000), "and is the moment it passes it");
  check(!ring.takeRefreshDue(3500 + 10001),
        "asking again immediately gets nothing — the deadline is re-armed when it fires, "
        "so a service that cannot answer costs one attempt per ttl, not one per tick");
  check(ring.status() == ChannelRingScreen::kReady,
        "and the picture stays up while the refresh is in flight");
  ring.render(out, 3500 + 10100);
  check(out.getPixel(0, 0).g == 90, "showing the frames it still has, not a loading label");
  // The refresh landing restarts the ttl from the arrival, not from the ask.
  tcos::FrameBundle refreshed;
  check(refreshed.parse(makeBundleTinted(2, 1000, 140)), "the refreshed render decodes");
  ring.adoptFrames(refreshed, "matrixclock", "0000feed9999", 14000);
  ring.render(out, 14100);
  check(out.getPixel(0, 0).g == 140, "the clock advances without the user doing anything");
  check(!ring.takeRefreshDue(14000 + 9999) && ring.takeRefreshDue(14000 + 10000),
        "and the next expiry is measured from when these frames arrived");

  // A failed refresh must not blank a channel that is up. Before frames were
  // re-fetched on a ttl this could not happen — a fetch was only ever in flight
  // for a page with nothing on it — so a dropped packet would now trade a
  // working picture for 加载失败 on every hiccup.
  ring.setStatus(ChannelRingScreen::kFailed, 15000);
  check(ring.status() == ChannelRingScreen::kReady, "a failed refresh leaves the picture alone");
  ring.setStatus(ChannelRingScreen::kOffline, 15100);
  check(ring.status() == ChannelRingScreen::kReady, "and so does going offline");
  ring.render(out, 15200);
  check(out.getPixel(0, 0).g == 140, "the channel is still on the panel");

  // 4. An OLDER SERVICE — no rev, no ttl — must behave exactly as it does
  //    today. This is the direction that actually ships: the firmware is
  //    flashed by hand and the service updates itself.
  StateDoc old;
  check(old.parse("seq\t40\nmenu\t1\nitem\tchannel\tmatrixclock\tX\n"),
        "a document from before these keys parses");
  const std::vector<ChannelRingScreen::Entry> menuOld =
      ChannelRingScreen::channelEntries(old.items());
  ChannelRingScreen legacyRing;
  legacyRing.setEntries(menuOld, 0);
  legacyRing.onEnter(0);
  check(legacyRing.takeSelectionChanged(), "the first menu still asks");
  check(legacyRing.takeRefreshDue(0), "and entering the ring still forces a refresh");
  tcos::FrameBundle only;
  check(only.parse(makeBundleTinted(2, 1000, 60)), "its render decodes");
  legacyRing.adoptFrames(only, "matrixclock", "", 1000);
  legacyRing.setEntries(menuOld, 2000);
  check(!legacyRing.takeSelectionChanged(),
        "a republished menu with no revision never invalidates — an absent rev means "
        "'nothing to compare', not 'everything changed'");
  check(!legacyRing.takeRefreshDue(2000) && !legacyRing.takeRefreshDue(1000 * 60 * 60),
        "and with no ttl nothing ever expires, however long the device sits there");
  legacyRing.render(out, 1000 * 60 * 60);
  check(out.getPixel(0, 0).g == 60, "the frames it fetched once are the frames it keeps");

  // 5. A NET-ZERO knob wiggle, drained in one tick — the ring and the link
  //    together, in osLogic's own order.
  //
  //    Both input drains are per tick, not per input: the physical key queue is
  //    swapped whole into one pass and the console pad loop dispatches
  //    everything queued in the same pass, and TICK_MS is 40. So cw followed by
  //    ccw at the same nowMs is reachable by a fast spin. The ring throws its
  //    frames away and (app, rev) ends up exactly where it started, so a
  //    selection-keyed ask is declined — 加载中 forever, no request outstanding,
  //    and nothing that re-arms one until the user touches the knob again.
  {
    HostLink wiggleLink;
    ChannelRingScreen wiggle;
    wiggle.setEntries(menuB, 0);
    wiggle.onEnter(0);
    // The tick, as osLogic writes it: forced wins, and both flags are consumed.
    const bool moved0 = wiggle.takeSelectionChanged();
    if (wiggle.takeRefreshDue(0)) wiggleLink.refreshChannel(wiggle.currentApp(), wiggle.currentRev());
    else if (moved0) wiggleLink.selectChannel(wiggle.currentApp(), wiggle.currentRev());
    check(wiggleLink.channelRequestCount() == 1, "entering the ring asks once");

    tcos::FrameBundle first;
    check(first.parse(makeBundleTinted(2, 1000, 200)), "the render decodes");
    wiggle.adoptFrames(first, "matrixclock", "0000feed9999", 1000);
    check(wiggle.status() == ChannelRingScreen::kReady, "and is on the panel");

    // One tick, two inputs, net zero movement. There is only one channel in
    // this menu, so the ring cannot even end up somewhere else.
    wiggle.onInput(tcos::kInputTurnCw, 2000);
    wiggle.onInput(tcos::kInputTurnCcw, 2000);
    const bool moved1 = wiggle.takeSelectionChanged();
    if (wiggle.takeRefreshDue(2000)) wiggleLink.refreshChannel(wiggle.currentApp(), wiggle.currentRev());
    else if (moved1) wiggleLink.selectChannel(wiggle.currentApp(), wiggle.currentRev());
    check(wiggle.status() == ChannelRingScreen::kLoading, "the frames were discarded");
    check(wiggleLink.channelRequestCount() == 2,
          "and asked for again — a wiggle that nets out to nothing must not strand the page");

    // And nothing else re-arms it, which is why the ask above has to happen on
    // this tick: takeRefreshDue's ttl path requires kReady.
    check(!wiggle.takeRefreshDue(2000 + 1000 * 60 * 60),
          "there is no later rescue — a ttl cannot expire on a bundle that is not there");
  }
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

// ---- word-level lyric timing (ADR 0008) ------------------------------------
//
// The line every case below is built on, and it is not a hypothetical: 孤勇者's
// "谁说站在光里的才算英雄" is the line the ADR was measured on. It is sung from
// 110330 for 5.29 s and the next line does not begin until 128880, so the naive
// rule handed eleven glyphs an 18.55 s window — 1686 ms per character against the
// singer's actual 481. Every number here comes from the real encoder, run on the
// REAL yrc — the `GUYONGZHE` fixture at the head of test/lyric-timing.test.ts,
// which is verbatim from NetEase's `lyric_new` response for track 1901371647.
//
// Regenerate by running the service's own encoder over that string —
// parseYrc -> buildLyricLines -> lyricCells -> encodeLyricCells for the table,
// OsLinkHub.setNowPlaying + serialize() for the document. Nothing in this file
// may hand-write the table, and nothing may push an INVENTED yrc through the
// real encoder either: both produce a second idealisation of the format, and a
// self-check agreeing with one of those proves nothing about the wire. The shape
// of this particular line is the argument — its long note is the FINAL glyph
// (雄, 1280 ms, running right up to `lyricend`) and its opening 谁 is 350 ms, so
// a fixture whose durations decay from a slow start has the song backwards.
const char* const kWordLine =
    "\xE8\xB0\x81\xE8\xAF\xB4\xE7\xAB\x99\xE5\x9C\xA8\xE5\x85\x89\xE9\x87\x8C"
    "\xE7\x9A\x84\xE6\x89\x8D\xE7\xAE\x97\xE8\x8B\xB1\xE9\x9B\x84";  // 谁说站在光里的才算英雄
const char* const kWordTrack = "\xE5\xAD\xA4\xE5\x8B\x87\xE8\x80\x85";   // 孤勇者
const char* const kWordArtist = "\xE9\x99\x88\xE5\xA5\x95\xE8\xBF\x85";  // 陈奕迅

// The `lyricw` field of that document, on its own.
const char* const kWordTable =
    "0,350,350,250,600,460,1060,400,1460,400,1860,400,2260,640,2900,380,"
    "3280,390,3670,340,4010,1280";

const int kWordLineStartMs = 110330;
const int kWordSungEndMs = 115620;   // the last word's end — what `lyricend` now means
const int kWordUntilMs = 128880;     // the next line's start — the old meaning of `lyricend`
const int kWordGlyphs = 11;

// The proto-2 document, verbatim. `lyricend` is the sung end, `lyricuntil` is the
// display window, and `lyricw` is the per-glyph table — none of which a device
// reporting no `proto` is ever sent.
const char* const kWordDoc =
    "seq\t4\npinned\t0\nmirror\t0\nmode\tspotlight\nskin\tsignal\n"
    "np\t1\ntrack\t\xE5\xAD\xA4\xE5\x8B\x87\xE8\x80\x85\n"
    "artist\t\xE9\x99\x88\xE5\xA5\x95\xE8\xBF\x85\nplaying\t1\n"
    "pos\t112000\ndur\t260000\n"
    "lyric\t\xE8\xB0\x81\xE8\xAF\xB4\xE7\xAB\x99\xE5\x9C\xA8\xE5\x85\x89\xE9\x87\x8C"
    "\xE7\x9A\x84\xE6\x89\x8D\xE7\xAE\x97\xE8\x8B\xB1\xE9\x9B\x84\n"
    "lyricat\t110330\nlyricend\t115620\nlyricuntil\t128880\n"
    "lyricw\t0,350,350,250,600,460,1060,400,1460,400,1860,400,2260,640,2900,380,"
    "3280,390,3670,340,4010,1280\n"
    "menu\t2\n"
    "item\tmusic\tmusic\t\xE9\x9F\xB3\xE4\xB9\x90\n"
    "item\tsettings\tsettings\t\xE8\xAE\xBE\xE7\xBD\xAE\n";

// The SAME session as a device reporting no `proto` is served — also verbatim
// from the encoder. One key differs and it is the whole compatibility argument:
// `lyricend` carries 128880, the display window, because that is what an
// un-upgraded 升降 keys its exit ramp on.
const char* const kLegacyDoc =
    "seq\t3\npinned\t0\nmirror\t0\nmode\tspotlight\nskin\tsignal\n"
    "np\t1\ntrack\t\xE5\xAD\xA4\xE5\x8B\x87\xE8\x80\x85\n"
    "artist\t\xE9\x99\x88\xE5\xA5\x95\xE8\xBF\x85\nplaying\t1\n"
    "pos\t112000\ndur\t260000\n"
    "lyric\t\xE8\xB0\x81\xE8\xAF\xB4\xE7\xAB\x99\xE5\x9C\xA8\xE5\x85\x89\xE9\x87\x8C"
    "\xE7\x9A\x84\xE6\x89\x8D\xE7\xAE\x97\xE8\x8B\xB1\xE9\x9B\x84\n"
    "lyricat\t110330\nlyricend\t128880\n"
    "menu\t2\n"
    "item\tmusic\tmusic\t\xE9\x9F\xB3\xE4\xB9\x90\n"
    "item\tsettings\tsettings\t\xE8\xAE\xBE\xE7\xBD\xAE\n";

// The decode, the cursor, and the document keys that carry them.
void checkLyricTiming() {
  using tcos::LyricCell;
  using tcos::LyricCursor;
  using tcos::StateDoc;

  // --- the real table ------------------------------------------------------
  tcos::LyricCellTable cells;
  check(tcos::decodeLyricCells(kWordTable, kWordLineStartMs, &cells),
        "the service's own encodeLyricCells output decodes");
  check(cells.count == kWordGlyphs,
        "into exactly one cell per glyph of the line it belongs to");
  if (cells.count == kWordGlyphs) {
    // Every boundary, not a spot check: an offset read as a width (or the pair
    // read one field out of step) still produces a plausible-looking table.
    static const int kStarts[11] = {110330, 110680, 110930, 111390, 111790, 112190,
                                    112590, 113230, 113610, 114000, 114340};
    static const int kEnds[11] = {110680, 110930, 111390, 111790, 112190, 112590,
                                  113230, 113610, 114000, 114340, 115620};
    for (int i = 0; i < 11; ++i) {
      char label[80];
      std::snprintf(label, sizeof(label), "cell %d spans the milliseconds it was sung", i);
      check(cells.cells[i].startMs == kStarts[i] && cells.cells[i].endMs == kEnds[i],
            label);
    }
    check(cells.cells[10].endMs == kWordSungEndMs,
          "and the last cell ends exactly where `lyricend` says the singing did");
  }

  // --- everything malformed ------------------------------------------------
  // All of these leave the table EMPTY, which is the same shape as a track with
  // no word timings — so the panel sweeps evenly instead of lighting glyphs at
  // times nobody sang. A half-read table is the one failure invisible on a photo.
  static const char* const kBadTables[8] = {
      "0,100,200",      // odd count: one number was lost in flight
      "0,100,,200",     // an empty field
      "0,10x,20,30",    // a digit that is not one; atoi would read 10 and carry on
      "-5,100",         // a sign, which encodeLyricCells clamps away before writing
      "0,100,20 ,30",   // trailing space
      "0,100,",         // trailing separator
      " 0,100",         // leading space
      "0,1000000000000",  // a number no lyric can justify, and no int can hold
  };
  for (int i = 0; i < 8; ++i) {
    tcos::LyricCellTable bad;
    bad.count = 3;  // pre-filled, so "left empty" is a claim and not the default
    char label[96];
    std::snprintf(label, sizeof(label), "table \"%s\" is refused outright", kBadTables[i]);
    check(!tcos::decodeLyricCells(kBadTables[i], 1000, &bad) && bad.empty(), label);
  }
  {
    tcos::LyricCellTable none;
    check(!tcos::decodeLyricCells("", 1000, &none) && none.empty(),
          "an empty table is refused rather than decoded as zero cells");
    check(!tcos::decodeLyricCells("0,100", -1, &none) && none.empty(),
          "and so is a table with no `lyricat` to be relative to");
  }
  {
    // The ceiling, from both sides. 96 is MusicScreen's own kMaxCells; the
    // service clamps a label to 24, so anything near this is already malformed.
    std::string big;
    for (int i = 0; i < tcos::kMaxLyricCells; ++i) big += (i == 0 ? "0,10" : ",0,10");
    tcos::LyricCellTable at;
    check(tcos::decodeLyricCells(big, 0, &at) && at.count == tcos::kMaxLyricCells,
          "a table at the cell ceiling decodes");
    big += ",0,10";
    tcos::LyricCellTable over;
    check(!tcos::decodeLyricCells(big, 0, &over) && over.empty(),
          "one cell past it is refused rather than allowed to grow a vector");
  }

  // --- the cursor, on the real table ---------------------------------------
  // The index at several instants, each one chosen for what it proves.
  const LyricCell* table = cells.cells;
  struct Sample {
    int atMs;
    int index;
    const char* what;
  };
  static const Sample kSamples[7] = {
      {110330, 0, "the line's first millisecond is its first glyph"},
      {110679, 0, "the last millisecond of a cell still belongs to it"},
      {110680, 1, "and the next one belongs to the next"},
      {113000, 6, "mid-line the cursor is on the glyph being sung"},
      {114340, 10, "the final glyph starts exactly when its word does"},
      {114980, 10, "640 ms into that 1280 ms held note it is STILL that glyph"},
      {115619, 10, "and it holds until the singing stops"},
  };
  for (int i = 0; i < 7; ++i) {
    const LyricCursor cursor = tcos::lyricCursorAt(table, kWordGlyphs, kWordLineStartMs,
                                                   kWordSungEndMs, kWordGlyphs,
                                                   kSamples[i].atMs);
    check(cursor.index == kSamples[i].index && cursor.phase == tcos::kLyricSinging,
          kSamples[i].what);
  }
  {
    // Inside a cell the fraction runs across that cell's OWN span, which is the
    // whole point: 640 ms into 雄's 1280 ms note is half of THAT NOTE, where the
    // same instant is 4650/5290 — 88% — of the line.
    const LyricCursor cursor = tcos::lyricCursorAt(table, kWordGlyphs, kWordLineStartMs,
                                                   kWordSungEndMs, kWordGlyphs, 114980);
    check(cursor.index == 10 && cursor.frac > 0.49f && cursor.frac < 0.51f,
          "the fraction is measured inside the glyph, not across the line");
  }
  {
    // The even sweep over the same window reaches a DIFFERENT glyph at the same
    // instant, and the old 18.55 s window a different one again. That gap is the
    // defect: at 113000 the singer is on 的 and the naive panel is still on 说.
    const LyricCursor sweptSung = tcos::lyricCursorAt(0, 0, kWordLineStartMs,
                                                      kWordSungEndMs, kWordGlyphs, 113000);
    const LyricCursor sweptWindow = tcos::lyricCursorAt(0, 0, kWordLineStartMs,
                                                        kWordUntilMs, kWordGlyphs, 113000);
    check(sweptSung.index == 5, "an even sweep of the sung span lands a glyph late");
    check(sweptWindow.index == 1,
          "and an even sweep of the old display window lands five glyphs late");
  }

  // --- held ----------------------------------------------------------------
  for (int i = 0; i < 3; ++i) {
    const int atMs = kWordSungEndMs + i * 4000;  // the moment it ends, and deep into the break
    const LyricCursor cursor = tcos::lyricCursorAt(table, kWordGlyphs, kWordLineStartMs,
                                                   kWordSungEndMs, kWordGlyphs, atMs);
    char label[96];
    std::snprintf(label, sizeof(label), "%d ms past the last cell the line reads as held",
                  i * 4000);
    check(cursor.phase == tcos::kLyricHeld && cursor.index == kWordGlyphs - 1 &&
              cursor.frac == 1.f && cursor.progress == 1.f,
          label);
  }
  {
    const LyricCursor before = tcos::lyricCursorAt(table, kWordGlyphs, kWordLineStartMs,
                                                   kWordSungEndMs, kWordGlyphs, 110329);
    check(before.phase == tcos::kLyricPending && before.index == -1,
          "a playhead before the first word has no glyph, rather than glyph 0");
  }

  // --- a table that does not match the row ---------------------------------
  // Truncated together with the label service-side, so a mismatch means something
  // went wrong on the wire. Refused rather than trimmed: the two can only differ
  // by whole glyphs, and being one character out of step for a whole song is
  // worse than not walking the words at all.
  for (int delta = -1; delta <= 1; delta += 2) {
    const LyricCursor cursor = tcos::lyricCursorAt(table, kWordGlyphs, kWordLineStartMs,
                                                   kWordSungEndMs, kWordGlyphs + delta,
                                                   113000);
    const LyricCursor swept = tcos::lyricCursorAt(0, 0, kWordLineStartMs, kWordSungEndMs,
                                                  kWordGlyphs + delta, 113000);
    char label[112];
    std::snprintf(label, sizeof(label),
                  "a table %s than the row falls back to the even sweep",
                  delta < 0 ? "longer" : "shorter");
    check(cursor.index == swept.index && cursor.frac == swept.frac, label);
  }

  // --- gaps and whitespace -------------------------------------------------
  // Hand-built, because the corpus line above has neither: 1.2% of yrc words do
  // not butt up against their successor, and every line with a space has a
  // zero-width cell holding its index.
  {
    tcos::LyricCellTable gapped;
    // c0 lit, c1 a space, c2 lit, then a 300 ms gap, then c3 lit.
    check(tcos::decodeLyricCells("0,300,300,0,300,300,900,300", 1000, &gapped),
          "a table with a zero-width cell and a gap decodes");
    const LyricCell* g = gapped.cells;
    const int kEnd = 2200;
    check(tcos::lyricCursorAt(g, 4, 1000, kEnd, 4, 1300).index == 2,
          "the cursor steps over a whitespace cell rather than resting on it");
    const LyricCursor inGap = tcos::lyricCursorAt(g, 4, 1000, kEnd, 4, 1700);
    check(inGap.index == 2 && inGap.frac == 1.f && inGap.phase == tcos::kLyricSinging,
          "between two words it holds the glyph that just finished, and does not hold");
    check(tcos::lyricCursorAt(g, 4, 1000, kEnd, 4, 2200).phase == tcos::kLyricHeld,
          "and only reads as held once the last cell AND the line are over");
  }

  // --- the display window --------------------------------------------------
  check(tcos::lyricWindowProgress(kWordLineStartMs, kWordSungEndMs, kWordUntilMs,
                                  kWordSungEndMs) < 0.31f,
        "the display window is barely a third gone when the singing ends");
  check(tcos::lyricWindowProgress(kWordLineStartMs, kWordSungEndMs, kWordUntilMs,
                                  kWordUntilMs) == 1.f,
        "and reaches 1 exactly when the next line is due");
  check(tcos::lyricWindowProgress(kWordLineStartMs, kWordSungEndMs, -1, 113000) ==
            tcos::lyricWindowProgress(kWordLineStartMs, kWordSungEndMs, kWordSungEndMs,
                                      113000),
        "an absent `lyricuntil` means the window IS the sung span");

  // --- the document --------------------------------------------------------
  StateDoc doc;
  check(doc.parse(kWordDoc), "the proto-2 document parses");
  check(doc.lyricStartMs() == kWordLineStartMs && doc.lyricEndMs() == kWordSungEndMs,
        "`lyricend` is read as the SUNG end");
  check(doc.lyricUntilMs() == kWordUntilMs, "and `lyricuntil` as the display window");
  check(doc.lyricCells().count == cells.count,
        "and `lyricw` survives splitTabs' three-tab cap as one comma-separated field");
  if (doc.lyricCells().count == cells.count) {
    bool same = true;
    for (int i = 0; i < cells.count; ++i) {
      if (doc.lyricCells().cells[i].startMs != cells.cells[i].startMs ||
          doc.lyricCells().cells[i].endMs != cells.cells[i].endMs) {
        same = false;
      }
    }
    check(same, "with every cell landing on the same milliseconds the encoder wrote");
  }

  // The keys are order-independent, because nothing in the format promises
  // `lyricat` arrives before the table it scales. Same rule `rev`/`ttl` follow by
  // repeating their id.
  StateDoc reordered;
  reordered.parse("seq\t5\nnp\t1\ntrack\tX\nplaying\t1\npos\t0\ndur\t9\n"
                  "lyric\tab\nlyricw\t0,300,300,300\nlyricat\t1000\nlyricend\t1600\n"
                  "menu\t0\n");
  check(reordered.lyricCells().count == 2 && reordered.lyricCells().cells[0].startMs == 1000,
        "`lyricw` before `lyricat` still lands on the right milliseconds");

  // An OLDER service: neither key, which has to stay distinguishable from a zero.
  check(doc.parse(kLegacyDoc), "the legacy document parses");
  check(doc.lyricEndMs() == kWordUntilMs,
        "where `lyricend` still carries the display window, as that build's 升降 needs");
  check(doc.lyricUntilMs() == -1 && doc.lyricCells().empty(),
        "and the absence of the two new keys is the message, not a gap");

  // A malformed table must not take the rest of the document with it, and must
  // not leave half a table behind: the panel falls back to the even sweep.
  StateDoc broken;
  check(broken.parse("seq\t6\nnp\t1\ntrack\tX\nplaying\t1\npos\t0\ndur\t9\n"
                     "lyric\tab\nlyricat\t1000\nlyricend\t1600\nlyricw\t0,300,300\n"
                     "menu\t1\nitem\tmusic\tmusic\tM\n"),
        "a document with an odd-length table still parses");
  check(broken.lyricCells().empty(), "with no table rather than half of one");
  check(broken.lyricStartMs() == 1000 && broken.items().size() == 1,
        "and every other field intact");

  // Reparsing is a full reset. A track that goes from word-level to line-level —
  // a NetEase song followed by a Spotify one — must not keep the old table.
  broken.parse(kWordDoc);
  check(!broken.lyricCells().empty(), "a table arrives");
  broken.parse("seq\t7\nnp\t1\ntrack\tX\nplaying\t1\npos\t0\ndur\t9\nmenu\t0\n");
  check(broken.lyricCells().empty() && broken.lyricUntilMs() == -1,
        "and is dropped by the next document rather than outliving its line");
}

// The frames a device reporting no `proto` must still get, PINNED TO THE BUILD
// BEFORE THIS CHANGE.
//
// Every other check in this file asserts the new code against the new code, which
// cannot notice a rendering that moved. These hashes were produced by rendering
// ui/MusicScreen.cpp AS OF e5a543f — the last commit before word timings reached
// this firmware — against the same core/ and visual/ sources, so a difference
// here is a legacy frame that is no longer what it was. That matters more than
// anything else in this file: roughly four fifths
// of tracks have no word timings, and every device is served this encoding until
// it reports a `proto`.
//
// Regenerate only when a legacy frame is MEANT to change — check out the old
// MusicScreen, render the three shapes below, and paste the hashes.
void checkLyricLegacyFrames() {
  using tcos::MusicScreen;

  const int kStampMs = 4000;

  // 1. A legacy line window: `lyricend` is the next line's start, the old
  //    meaning, and neither new key is present.
  static const int kDeltas[7] = {0, 2000, 5000, 9000, 14000, 16550, 20000};
  static const uint32_t kWindowed[4][7] = {
      {0xbf51ae8bu, 0xae2ec251u, 0x8757c041u, 0x1a93d2c8u, 0x3096b10cu, 0x5d9f7eecu, 0x14926341u},
      {0x1d3fbf14u, 0x3a9862dau, 0xca99a7cau, 0x353c55bbu, 0x70c4f70au, 0x97a1c9fau, 0x98d37faau},
      {0xd80ea5b3u, 0xc0b44af2u, 0x85f540bdu, 0x5d5f5dbbu, 0x706a221cu, 0x79b3f6ebu, 0x435a40a7u},
      {0x7a5b4debu, 0x3727b46bu, 0x76a2bb47u, 0xffe5bccau, 0x8d0527fau, 0x92813d4du, 0x6a4a8249u},
  };
  for (int mode = 0; mode < MusicScreen::kModeCount; ++mode) {
    for (int i = 0; i < 7; ++i) {
      MusicScreen screen;
      Surface frame(52, 16);
      screen.onEnter(0);
      screen.setTheme(mode, MusicScreen::kSkinSignal, 0, false);
      screen.setNowPlaying(true, kWordTrack, kWordArtist, kWordLine, true, 112000, 260000,
                           kStampMs, kWordLineStartMs, kWordUntilMs);
      screen.render(frame, kStampMs + kDeltas[i]);
      char label[128];
      std::snprintf(label, sizeof(label),
                    "mode %d at +%d ms is the frame the pre-change build drew", mode,
                    kDeltas[i]);
      check(frameHash(frame) == kWindowed[mode][i], label);
    }
  }

  // 2. No window at all — `lyric` with no `lyricat`, which is the shape a service
  //    older still produces. The 4 s sweep runs off the moment the line changed.
  static const uint32_t kSwept[4][4] = {
      {0xde8b3ad2u, 0xc945101cu, 0x0a38cdf8u, 0x1c0d9103u},
      {0x433ae328u, 0xbde5c328u, 0x6d49d588u, 0xe4c7259du},
      {0x01abf30bu, 0x2ca45852u, 0xaf42f793u, 0x17794d2au},
      {0x3f44ebb5u, 0x4f919085u, 0xdd22d0cdu, 0xc7f36200u},
  };
  for (int mode = 0; mode < MusicScreen::kModeCount; ++mode) {
    for (int i = 0; i < 4; ++i) {
      MusicScreen screen;
      Surface frame(52, 16);
      screen.onEnter(0);
      screen.setTheme(mode, MusicScreen::kSkinBlueprint, 0, false);
      screen.setNowPlaying(true, kWordTrack, kWordArtist, kWordLine, true, 112000, 260000,
                          kStampMs);
      screen.render(frame, kStampMs + i * 1500);
      char label[128];
      std::snprintf(label, sizeof(label),
                    "mode %d untimed at +%d ms is unchanged", mode, i * 1500);
      check(frameHash(frame) == kSwept[mode][i], label);
    }
  }

  // 3. No lyric at all: the title/artist rotation, whose sweep is the rotation
  //    slot. It is not a sung row and must not acquire a cursor of its own — the
  //    accent is on so the palette override rides along.
  static const uint32_t kRotating[4][4] = {
      {0xf777e55eu, 0x874e4e8eu, 0x03dc585au, 0xcec15b66u},
      {0x3b4bc00du, 0xb3b7f345u, 0x0b373e01u, 0x81e42e05u},
      {0xddf7fbbau, 0x86c608a1u, 0x18c32ac6u, 0xf5ed2e8fu},
      {0xaf451f5eu, 0x89bb7516u, 0x7ebcea26u, 0x0f1ba5e6u},
  };
  for (int mode = 0; mode < MusicScreen::kModeCount; ++mode) {
    for (int i = 0; i < 4; ++i) {
      MusicScreen screen;
      Surface frame(52, 16);
      screen.onEnter(0);
      screen.setTheme(mode, MusicScreen::kSkinArcade, 0xff8844u, true);
      screen.setNowPlaying(true, kWordTrack, kWordArtist, "", true, 112000, 260000, kStampMs);
      screen.render(frame, kStampMs + i * 1700);
      char label[128];
      std::snprintf(label, sizeof(label),
                    "mode %d title rotation at +%d ms is unchanged", mode, i * 1700);
      check(frameHash(frame) == kRotating[mode][i], label);
    }
  }

  // And the fields' ABSENCE is what does it: the same line, explicitly told the
  // two clocks coincide and given no table, is the same picture. This is the
  // shape a proto-2 service produces for a line with no gap after it and no word
  // timings — most of the catalogue, most of the time.
  for (int mode = 0; mode < MusicScreen::kModeCount; ++mode) {
    MusicScreen absent;
    MusicScreen explicitly;
    Surface a(52, 16);
    Surface b(52, 16);
    absent.onEnter(0);
    explicitly.onEnter(0);
    absent.setTheme(mode, MusicScreen::kSkinSignal, 0, false);
    explicitly.setTheme(mode, MusicScreen::kSkinSignal, 0, false);
    absent.setNowPlaying(true, kWordTrack, kWordArtist, kWordLine, true, 112000, 260000,
                         kStampMs, kWordLineStartMs, kWordUntilMs);
    explicitly.setNowPlaying(true, kWordTrack, kWordArtist, kWordLine, true, 112000, 260000,
                             kStampMs, kWordLineStartMs, kWordUntilMs, -1, 0, 0);
    absent.render(a, kStampMs + 5000);
    explicitly.render(b, kStampMs + 5000);
    char label[112];
    std::snprintf(label, sizeof(label),
                  "mode %d is untouched by a document that carries neither new key", mode);
    check(!surfacesDiffer(a, b), label);
  }
}

// What the four 显示形式 do with a per-glyph table, in pixels, and the telemetry
// that makes the service send one at all.
void checkWordLyricScreen() {
  using tcos::HostLink;
  using tcos::MusicScreen;
  using tcos::StateDoc;

  // --- the capability report ----------------------------------------------
  // Without this the whole change is invisible: the service gates every new key
  // on `proto`, and a firmware that never sends one is served the legacy
  // encoding forever. Verified live on the user's unit as proto = 0.
  {
    HostLink::Report report;
    report.screen = "music";
    report.focus = "btc";
    report.wifi = "home-2g";
    report.ip = "192.168.8.240";
    report.uptimeMs = 987654321ull;
    report.freeKb = 812;
    report.batteryPercent = 88;
    report.flashed = true;
    const std::string body = HostLink::reportBody(report);
    check(body.find("\"proto\":2") != std::string::npos,
          "telemetry reports the document revision this build implements");
    check(StateDoc::kProtocol == 2,
          "and it is the 2 that OS_PROTO_LYRIC_WINDOW in src/os-link.ts gates on");
    check(!body.empty() && body[body.size() - 1] == '}',
          "the report is a complete JSON object");
    check(body.find("\"flashed\":true") != std::string::npos &&
              body.find("\"asleep\":false") != std::string::npos,
          "with every field that was already there still in it");

    // The truncation hazard, from the direction that used to bite. A silently cut
    // body is not degraded telemetry, it is a 400 — no battery, no 已息屏, and no
    // `proto`, so the device would drop back to the legacy encoding by way of a
    // buffer size. jsonEscape doubles a string of quotes, which is the worst case.
    HostLink::Report fat;
    fat.screen = std::string(64, '"');
    fat.focus = std::string(64, '\\');
    fat.wifi = std::string(64, '"');
    fat.ip = std::string(64, '"');
    fat.uptimeMs = 18446744073709551615ull;
    fat.freeKb = -2147483647;
    fat.supplicantRestarts = -2147483647;
    fat.sleepStartMin = -2147483647;
    fat.sleepEndMin = -2147483647;
    fat.sleepIdleSec = -2147483647;
    const std::string big = HostLink::reportBody(fat);
    check(!big.empty() && big[big.size() - 1] == '}',
          "and cannot be truncated by a hostile SSID, however long");
    check(big.find("\"proto\":2") != std::string::npos,
          "which is what keeps `proto` from being the field that falls off the end");
  }

  // --- the document, through the real parser and the real snapshot ---------
  StateDoc doc;
  check(doc.parse(kWordDoc), "the proto-2 document parses on the path the screen uses");
  HostLink link;
  link.adoptDocument(doc, 1250000ull);
  const HostLink::Snapshot snap = link.snapshot();
  check(snap.lyricUntilMs == kWordUntilMs && snap.lyricCells.count == kWordGlyphs,
        "and the held window and the table survive the copy into the snapshot");

  // Every screen below is fed through osLogic's own call, argument for argument,
  // so a field that reaches the snapshot and not the panel cannot hide.
  const int kStampMs = 4000;
  // playhead(now) = pos + (now - stamp), so this is the nowMs at a track time.
  const int kAt113000 = kStampMs + (113000 - snap.positionMs);
  const int kAt114500 = kStampMs + (114500 - snap.positionMs);
  const int kAt116000 = kStampMs + (116000 - snap.positionMs);
  const int kAt120000 = kStampMs + (120000 - snap.positionMs);

  // 的 is the seventh glyph and the one actually being sung at 113000 (its word
  // runs 112590..113230); 里 is the sixth, which is where an even sweep of the
  // same span puts the highlight.
  const uint32_t kSung = codepointAt(kWordLine, 6);
  const uint32_t kSwept = codepointAt(kWordLine, 5);
  check(glyphBits(kSung) != glyphBits(kSwept),
        "the two candidate glyphs differ in ink, so counting it can tell them apart");

  const uint32_t primary = kSkinTiers[0].primary;

  for (int mode = 0; mode < MusicScreen::kModeCount; ++mode) {
    // 天际 hangs its line from row 0 to leave the spectrum a floor; the other
    // three sit it at row 2. Either way the band is twelve rows of glyph ink and
    // excludes every cue row, the fill meter and the bars. The COLUMNS are each
    // mode's own clip — 聚光 bleeds off both edges, the other three hold the
    // [2,50) margin — which is also what keeps 升降's column-51 fill out of it.
    const int bandY = mode == MusicScreen::kModeSkyline ? 0 : 2;
    const int bandX0 = mode == MusicScreen::kModeSpotlight ? 0 : 2;
    const int bandX1 = mode == MusicScreen::kModeSpotlight ? 51 : 49;
    char label[160];

    MusicScreen walked;
    MusicScreen sweptScreen;
    Surface withCells(52, 16);
    Surface withoutCells(52, 16);
    walked.onEnter(0);
    sweptScreen.onEnter(0);
    walked.setTheme(mode, MusicScreen::kSkinSignal, 0, false);
    sweptScreen.setTheme(mode, MusicScreen::kSkinSignal, 0, false);
    walked.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true, snap.positionMs,
                         snap.durationMs, kStampMs, snap.lyricStartMs, snap.lyricEndMs,
                         snap.lyricUntilMs, snap.lyricCells.cells,
                         snap.lyricCells.count);
    // The same line and the same two windows, with the table withheld — the
    // line-level shape, which is ~80% of tracks.
    sweptScreen.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true,
                              snap.positionMs, snap.durationMs, kStampMs, snap.lyricStartMs,
                              snap.lyricEndMs, snap.lyricUntilMs);
    walked.render(withCells, kAt113000);
    sweptScreen.render(withoutCells, kAt113000);

    std::snprintf(label, sizeof(label),
                  "mode %d lights the glyph being SUNG at 113000, not the one an even "
                  "sweep would", mode);
    check(tierPixelsInBox(withCells, primary, bandX0, bandX1, bandY, bandY + 11) ==
              glyphBits(kSung),
          label);
    std::snprintf(label, sizeof(label),
                  "mode %d without a table still lights the swept glyph, unchanged", mode);
    check(tierPixelsInBox(withoutCells, primary, bandX0, bandX1, bandY, bandY + 11) ==
              glyphBits(kSwept),
          label);
    std::snprintf(label, sizeof(label), "mode %d therefore draws a different panel", mode);
    check(surfacesDiffer(withCells, withoutCells), label);

    // A mismatched table is refused, not trimmed: feeding one cell too few or too
    // many has to produce the frame the sweep produces, to the pixel.
    for (int delta = -1; delta <= 1; delta += 2) {
      MusicScreen ragged;
      Surface frame(52, 16);
      ragged.onEnter(0);
      ragged.setTheme(mode, MusicScreen::kSkinSignal, 0, false);
      ragged.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true, snap.positionMs,
                           snap.durationMs, kStampMs, snap.lyricStartMs, snap.lyricEndMs,
                           snap.lyricUntilMs, snap.lyricCells.cells, kWordGlyphs + delta);
      ragged.render(frame, kAt113000);
      std::snprintf(label, sizeof(label),
                    "mode %d falls back to the sweep on a table %s than the row", mode,
                    delta < 0 ? "shorter" : "longer");
      check(!surfacesDiffer(frame, withoutCells), label);
    }

    // --- sung out and holding ---------------------------------------------
    // 4.4 s past the last word, with 13 s of instrumental still to run. The line
    // stays up, complete, with no glyph left glowing — and the panel is not
    // frozen: the whole-track cue keeps moving under it.
    Surface held(52, 16);
    Surface laterHeld(52, 16);
    walked.render(held, kAt120000);
    walked.render(laterHeld, kAt120000 + 6000);
    std::snprintf(label, sizeof(label), "mode %d keeps the finished line on the panel", mode);
    check(litPixelsInRows(held, bandY, bandY + 11) > 0, label);
    std::snprintf(label, sizeof(label),
                  "mode %d stops lighting a focus glyph once the line is sung out", mode);
    check(tierPixelsInBox(held, primary, bandX0, bandX1, bandY, bandY + 11) == 0, label);
    std::snprintf(label, sizeof(label), "mode %d is still animating while it holds", mode);
    check(surfacesDiffer(held, laterHeld), label);
  }

  // --- 聚光 specifically ---------------------------------------------------
  // The mode this change is for: it locks the SUNG PIXEL COLUMN to x=26, a claim
  // no other mode makes about a single column, and `progress * textWidth` only
  // finds that column when time is spread evenly over the row.
  {
    MusicScreen spot;
    Surface frame(52, 16);
    spot.onEnter(0);
    spot.setTheme(MusicScreen::kModeSpotlight, MusicScreen::kSkinSignal, 0, false);
    spot.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true, snap.positionMs,
                       snap.durationMs, kStampMs, snap.lyricStartMs, snap.lyricEndMs,
                       snap.lyricUntilMs, snap.lyricCells.cells, snap.lyricCells.count);
    spot.render(frame, kAt113000);
    int lowest = 52;
    int highest = -1;
    for (int y = 2; y <= 13; ++y) {
      for (int x = 0; x < 52; ++x) {
        if (frame.getPixel(x, y).toRGB888() != kSkinTiers[0].primary) continue;
        if (x < lowest) lowest = x;
        if (x > highest) highest = x;
      }
    }
    check(lowest <= 26 && highest >= 26,
          "聚光 puts the glyph being sung across the panel's centre column");

    // The fill meter measures progress through THAT GLYPH, and the last note of
    // this line is where the two answers separate furthest. At 114500 the singer
    // is 160 ms into 雄's 1280 ms note — an eighth of it, two pixels of a twelve
    // pixel meter — while the LINE is 79% gone, which is what an even sweep of
    // the same instant reports (it lands in the ninth cell, two thirds through
    // it, and fills two thirds of the bar). A single number cannot be both.
    Surface late(52, 16);
    spot.render(late, kAt114500);
    const int meter = tierPixelsInBox(late, kSkinTiers[0].secondary, 0, 51, 14, 14);
    check(meter >= 1 && meter <= 3,
          "and a fill meter measuring how far into that glyph, not how far into the line");

    MusicScreen sweptSpot;
    Surface sweptLate(52, 16);
    sweptSpot.onEnter(0);
    sweptSpot.setTheme(MusicScreen::kModeSpotlight, MusicScreen::kSkinSignal, 0, false);
    sweptSpot.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true, snap.positionMs,
                            snap.durationMs, kStampMs, snap.lyricStartMs, snap.lyricEndMs,
                            snap.lyricUntilMs);
    sweptSpot.render(sweptLate, kAt114500);
    check(tierPixelsInBox(sweptLate, kSkinTiers[0].secondary, 0, 51, 14, 14) >= meter + 4,
          "where the line-level sweep of the same instant fills a visibly fuller bar");

    Surface heldFrame(52, 16);
    spot.render(heldFrame, kAt120000);
    check(tierPixelsInBox(heldFrame, kSkinTiers[0].secondary, 0, 51, 14, 14) == 0,
          "a finished line has no glyph in progress, so 聚光 draws no meter at all");
  }

  // --- 天际 specifically ---------------------------------------------------
  // The BEAT is the second place word timings land in this mode, and the hold is
  // where the choice shows. beatKick's per-glyph term is (1 - frac)^2, so a
  // cursor parked at the end of a cell — a gap between words, or the whole
  // instrumental after the last one — would sit at FULL scale and pin the
  // spectrum to maximum for thirteen seconds. There is nothing being sung to
  // snap to, so it falls back to the free-running pulse instead.
  {
    MusicScreen sungOut;
    MusicScreen pinned;
    Surface calm(52, 16);
    Surface loud(52, 16);
    sungOut.onEnter(0);
    pinned.onEnter(0);
    sungOut.setTheme(MusicScreen::kModeSkyline, MusicScreen::kSkinSignal, 0, false);
    pinned.setTheme(MusicScreen::kModeSkyline, MusicScreen::kSkinSignal, 0, false);
    sungOut.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true, snap.positionMs,
                          snap.durationMs, kStampMs, snap.lyricStartMs, snap.lyricEndMs,
                          snap.lyricUntilMs, snap.lyricCells.cells,
                          snap.lyricCells.count);
    // The same instant on the legacy encoding, where a line past its window keeps
    // the per-glyph term at 1 — which is what this build must NOT do once it can
    // tell "sung out" from "the next line is due".
    pinned.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true, snap.positionMs,
                         snap.durationMs, kStampMs, snap.lyricStartMs, snap.lyricEndMs);
    sungOut.render(calm, kAt120000);
    pinned.render(loud, kAt120000);
    bool barsDiffer = false;
    for (int y = 13; y <= 15 && !barsDiffer; ++y) {
      for (int x = 0; x < 52; ++x) {
        if (calm.getPixel(x, y).toRGB888() != loud.getPixel(x, y).toRGB888()) {
          barsDiffer = true;
          break;
        }
      }
    }
    check(barsDiffer, "天际's spectrum stops snapping on a glyph once there is none");

    // AND THE SAME HOLDS WITHOUT WORD TIMINGS, which is the shape four fifths of
    // tracks arrive in: `lyricuntil` present, `lyricw` absent. There the cursor
    // is the even sweep pinned at progress 1 for the whole hold, and
    // beatKick's per-glyph term is 1 - fract(1 * n) — exactly 1 for any glyph
    // count, i.e. the spectrum slammed to maximum for thirteen seconds, on the
    // commonest wire shape there is. A held line is a held line however the
    // service timed it, so this frame must be the tabled one to the pixel.
    MusicScreen wordless;
    Surface untimedHold(52, 16);
    wordless.onEnter(0);
    wordless.setTheme(MusicScreen::kModeSkyline, MusicScreen::kSkinSignal, 0, false);
    wordless.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true, snap.positionMs,
                           snap.durationMs, kStampMs, snap.lyricStartMs, snap.lyricEndMs,
                           snap.lyricUntilMs);
    wordless.render(untimedHold, kAt120000);
    check(!surfacesDiffer(untimedHold, calm),
          "and a proto-2 line with no word timings holds exactly like one with them");
  }

  // --- 升降 specifically ---------------------------------------------------
  // TWO CLOCKS. cascadeBandY's exit ramp reaches y = -16 at progress 1, so a
  // choreography keyed on the SUNG progress flies the line off the panel the
  // instant the voice stops — 13.3 s of black screen on this very line. The
  // window is what keeps it up; the karaoke wipe still finishes with the singer.
  {
    MusicScreen windowed;
    MusicScreen sungOnly;
    Surface up(52, 16);
    Surface gone(52, 16);
    windowed.onEnter(0);
    sungOnly.onEnter(0);
    windowed.setTheme(MusicScreen::kModeCascade, MusicScreen::kSkinSignal, 0, false);
    sungOnly.setTheme(MusicScreen::kModeCascade, MusicScreen::kSkinSignal, 0, false);
    windowed.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true, snap.positionMs,
                           snap.durationMs, kStampMs, snap.lyricStartMs, snap.lyricEndMs,
                           snap.lyricUntilMs, snap.lyricCells.cells,
                           snap.lyricCells.count);
    // The same line and the same table, with the held window withheld.
    sungOnly.setNowPlaying(true, snap.track, snap.artist, snap.lyric, true, snap.positionMs,
                           snap.durationMs, kStampMs, snap.lyricStartMs, snap.lyricEndMs,
                           -1, snap.lyricCells.cells, snap.lyricCells.count);
    windowed.render(up, kAt116000);
    sungOnly.render(gone, kAt116000);
    // Columns 2..49 only: 升降's whole-track fill lives in column 51 and would
    // satisfy a looser count on an empty panel.
    check(litPixelsInBox(up, 2, 49, 0, 15) > 0,
          "升降 holds the line on the panel through the instrumental after it");
    check(litPixelsInBox(gone, 2, 49, 0, 15) == 0,
          "and would have flown it off the top without `lyricuntil` — which is exactly "
          "what an un-upgraded build would do if the service tightened `lyricend` "
          "underneath it");
  }
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
    check(std::string(policy.provisionReason()) == "no-creds",
          "and the breadcrumb reason says this was a first boot, not a lost network");
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
    w.visible.push_back("neighbour");  // a finished sweep, so scanning ends at once
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
    w.visible.push_back("neighbour");
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
    w.visible.push_back("neighbour");
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
    w.visible.push_back("neighbour");
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
    check(std::string(policy.provisionReason()) == "connect-timeout",
          "the breadcrumb reason distinguishes lost credentials from a first boot");
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
    w.visible.push_back("neighbour");
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
    w.visible.push_back("neighbour");
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
    w.visible.push_back("neighbour");
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
    w.visible.push_back("neighbour");
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

  // FAULT 2, the regression block. The supplicant answers SCAN_RESULTS from
  // its cache instantly, and a fresh daemon's cache is empty — so "empty" must
  // read as "not done", or the policy leaves kScanning on its first 160 ms
  // tick, raises the hotspot, and the AP kills the real sweep. This is exactly
  // how the setup page's dropdown shipped empty for every first boot.
  {
    FakeWifi w;  // scanDone flips true immediately (autoScan), but visible is EMPTY
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    check(policy.state() == WifiPolicy::kScanning, "scanning");
    const int t0 = WifiPolicy::kAdoptGraceMs + 20;

    // The first tick after entry is where the old code already gave up.
    policy.tick(t0 + 160);
    check(policy.state() == WifiPolicy::kScanning,
          "an empty supplicant cache does not end the sweep on the first tick");
    check(!w.apUp, "and the hotspot stays down — raising it would kill the sweep");

    // While the sweep stays empty the SCAN is re-issued: the first one can be
    // eaten whole (FAIL-BUSY from a supplicant mid-start) and nobody else asks.
    const int scansBefore = w.scans;
    policy.tick(t0 + WifiPolicy::kScanRetryMs + 10);
    check(w.scans == scansBefore + 1, "an empty sweep is re-asked on the retry period");

    // The first NON-empty result ends the wait immediately — no full budget.
    w.visible.push_back("home");
    w.visible.push_back("neighbour");
    policy.tick(t0 + WifiPolicy::kScanRetryMs + 200);
    check(policy.state() == WifiPolicy::kProvisioning,
          "the first non-empty result raises the hotspot without waiting out the budget");
    check(policy.scanned().size() == 2, "with the full list for the page");
  }

  // ...and a radio whose cache STAYS empty still ends in a hotspot: the budget
  // is a bound, not a trap. The list is then honestly empty and the page's
  // typed-SSID box (plus the /data scan cache, on the device) is the fallback.
  {
    FakeWifi w;  // visible stays empty forever
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    const int t0 = WifiPolicy::kAdoptGraceMs + 20;
    policy.tick(t0 + WifiPolicy::kScanTimeoutMs - 100);
    check(policy.state() == WifiPolicy::kScanning, "still trying inside the budget");
    policy.tick(t0 + WifiPolicy::kScanTimeoutMs + 10);
    check(policy.state() == WifiPolicy::kProvisioning && w.apUp,
          "a sweep that never fills still ends with a way in");
    check(policy.scanned().empty(), "and an honestly empty list");
  }

  // The budget is sized for the radio, not for taste: two full 2.4 GHz sweeps
  // (2-4 s each) plus a FAIL-BUSY retry must fit, or the timeout re-creates the
  // empty-dropdown bug with extra steps.
  check(WifiPolicy::kScanTimeoutMs >= 12000,
        "the scan budget covers two full sweeps and a busy retry");
  check(WifiPolicy::kScanRetryMs * 2 < WifiPolicy::kScanTimeoutMs,
        "and the retry period fits at least twice inside it");
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

  // --- hostapd's argv: the vendor's entropy recipe, with a fallback ---------
  //
  // The preferred shape is libzknet's own — `-e /data/misc/wifi/entropy.bin`
  // with the file pre-seeded — because a headless box with no input devices
  // fills its kernel entropy pool at a crawl and a hostapd left to that pool
  // can refuse WPA handshakes. The fallback is the bare invocation this
  // firmware always used, the one that demonstrably puts the SSID on the air:
  // a build that rejects -e must cost one spawn, never the hotspot.
  {
    const std::vector<std::string> withEntropy = DeviceWifi::hostapdArgs(true);
    check(withEntropy.size() == 4 && withEntropy[0] == "-B" && withEntropy[1] == "-e" &&
              withEntropy[2] == DeviceWifi::entropyFile() &&
              withEntropy[3] == DeviceWifi::hostapdConfPath(),
          "hostapd's preferred argv is the vendor shape: -B -e <entropy> <conf>");
    const std::vector<std::string> plain = DeviceWifi::hostapdArgs(false);
    check(plain.size() == 2 && plain[0] == "-B" && plain[1] == DeviceWifi::hostapdConfPath(),
          "and the fallback is exactly the invocation that has always aired the SSID");
    check(std::string(DeviceWifi::entropyFile()) == "/data/misc/wifi/entropy.bin",
          "the entropy file is the vendor's own path, byte for byte");
  }

  // --- dnsmasq, the half that made the hotspot useless ----------------------
  //
  // Measured on the device: with the pid file left at its compiled-in default,
  // /var/run/dnsmasq.pid, dnsmasq exits 3 — there is no /var on this rootfs at
  // all — so the SSID went on the air and no phone was ever handed an address.
  // Three argument layers now, most capable first, best evidence last; each is
  // pinned here because none of them can be exercised without the radio.
  const std::vector<std::string> l1 = DeviceWifi::dnsmasqLayer1Args("192.168.100.1");
  const std::vector<std::string> l2 = DeviceWifi::dnsmasqLayer2Args("192.168.100.1");
  const std::vector<std::string> proven = DeviceWifi::dnsmasqProvenArgs("192.168.100.1");

  // THE LADDER'S ORDER is itself a fact: layer 1 is reasoned, layer 2 is the
  // vendor's binary-proven argv, layer 3 is the one invocation measured on
  // this exact unit. superviseDhcp walks this dispatch, so pinning it here
  // pins the runtime behaviour.
  check(DeviceWifi::kDnsmasqLayers == 3, "three layers, no more, no fewer");
  check(DeviceWifi::dnsmasqArgsForLayer(1, "192.168.100.1") == l1 &&
            DeviceWifi::dnsmasqArgsForLayer(2, "192.168.100.1") == l2 &&
            DeviceWifi::dnsmasqArgsForLayer(3, "192.168.100.1") == proven,
        "the dispatch runs reasoned, then vendor-proven, then device-measured");

  // LAYER 3 IS THE MEASUREMENT, character for character.
  //
  // This is the check that matters most in this file, and it is a check on
  // restraint rather than on cleverness. dnsmasq exits EC_BADCONF on any
  // argument it does not accept, so an unverified flag anywhere above it can
  // reproduce the original bug exactly — the SSID on the air and not one
  // lease. What makes that survivable is that the last rung is the argument
  // list actually executed on this unit: the four arguments this firmware
  // always passed, plus the --pid-file that turned exit 3 into exit 0.
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
          "layer 3 is exactly the invocation measured working on the device — "
          "the original four arguments plus the pid file, and nothing else");
    // Deliberately absent, and the absence is the point: /etc/dnsmasq.conf is
    // left to be read implicitly, exactly as it was when the measurement was
    // taken, so `user=root`, `no-hosts` and a writable lease path come from the
    // vendor's own file rather than from flags this build may reject.
    check(!hasOneArg(proven, "--conf-file", "--conf-file=/dev/null") &&
              !hasOneArg(proven, "--user", "--user=root"),
          "and it does not neutralise the vendor conf it is relying on");
  }

  // LAYER 2 IS THE VENDOR'S, character for character: the argv inside this
  // device's own libzknet.so (soft_ap_enable, the fork+execv branch), the
  // shape every stock unit of this platform family serves its production
  // hotspot with. Only the pool is derived instead of a second literal.
  {
    std::vector<std::string> vendor;
    vendor.push_back("--no-daemon");
    vendor.push_back("--no-resolv");
    vendor.push_back("--no-poll");
    vendor.push_back("--dhcp-range=192.168.100.100,192.168.100.200,1h");
    check(l2 == vendor,
          "layer 2 is libzknet's own argv verbatim, pool derived from the gateway");
  }

  // LAYER 1: the vendor's execution model with everything spelled out. The
  // foreground run is the deeper fix — a --no-daemon dnsmasq writes no pidfile
  // (the entire original failure class disappears), stays our own child (so
  // supervision is waitpid on a known pid, not a name walk that once claimed
  // init's dnsmasq as ours), and hands back its exit status when it dies.
  {
    check(hasOneArg(l1, "--no-daemon", "--no-daemon") &&
              hasOneArg(l2, "--no-daemon", "--no-daemon"),
        "layers 1 and 2 run dnsmasq in the foreground, the vendor's model");
    bool l1HasPidFile = false;
    for (size_t i = 0; i < l1.size(); ++i) {
      if (l1[i].compare(0, 10, "--pid-file") == 0) l1HasPidFile = true;
    }
    check(!l1HasPidFile,
          "a foreground dnsmasq writes no pidfile, so layer 1 passes none — the "
          "whole /var/run failure class cannot recur there");
    check(hasOneArg(l1, "--log-dhcp", "--log-dhcp"),
          "layer 1 logs every DISCOVER/OFFER into its /data capture — the file that "
          "separates 'phone never asked' from 'driver dropped the OFFER' from "
          "'no context matched'");
    check(hasOneArg(l1, "--conf-file", "--conf-file=/dev/null"),
          "the vendor's /etc/dnsmasq.conf is taken out of the picture");
    check(hasOneArg(l1, "--user", "--user=root"),
          "root is spelled out: dnsmasq's default user is `nobody`, and a getpwnam "
          "that fails is fatal — every start measured on this unit was as root");
    check(hasOneArg(l1, "--no-hosts", "--no-hosts"),
          "/etc/hosts stays unread, or a local record would answer before the "
          "captive-portal catch-all");
    check(hasOneArg(l1, "--dhcp-authoritative", "--dhcp-authoritative"),
          "a phone arriving with a cached lease is NAKed rather than ignored");
    check(hasOneArg(l1, "--no-resolv", "--no-resolv") &&
              hasOneArg(l1, "--no-poll", "--no-poll"),
          "no upstream resolver is looked for; there is none while the AP is up");
    check(hasOneArg(l1, "--dhcp-leasefile", "--dhcp-leasefile=/tmp/zos-dnsmasq.leases"),
          "the lease file is on tmpfs — rewritten per lease, and /data is the "
          "credentials partition");
  }

  // THE invariant, in every layer that names a pool. A pool outside the
  // address on wlan0 matches no DHCP context, so dnsmasq stays up, answers
  // nothing, and every supervision check still reports a healthy hotspot —
  // which is exactly the mistake the vendor conf ships (dhcp-range=192.168.1.101
  // on a device whose AP is 192.168.100.1).
  check(hasOneArg(l1, "--dhcp-range", "--dhcp-range=192.168.100.100,192.168.100.200,1h") &&
            hasOneArg(l2, "--dhcp-range",
                      "--dhcp-range=192.168.100.100,192.168.100.200,1h"),
        "every pool is libzknet's own, inside the gateway's /24");
  check(hasOneArg(l1, "--address=", "--address=/#/192.168.100.1"),
        "every name resolves to the gateway, which is what opens the captive sheet");
  check(hasOneArg(l1, "--interface", "--interface=wlan0"), "and layer 1 serves wlan0 only");

  // No layer may name a path under the /var this device does not have.
  for (int layer = 1; layer <= DeviceWifi::kDnsmasqLayers; ++layer) {
    const std::vector<std::string> args = DeviceWifi::dnsmasqArgsForLayer(layer, "192.168.100.1");
    for (size_t i = 0; i < args.size(); ++i) {
      check(args[i].find("/var/") == std::string::npos, "no argument names a path under /var");
    }
  }

  // Derived, not written twice: move the gateway and the pool has to follow, or
  // the two disagree the way the vendor's file does. All layers, because each
  // is a real code path and a pool on the wrong subnet is the bug itself.
  check(hasOneArg(DeviceWifi::dnsmasqLayer1Args("10.0.7.1"), "--dhcp-range",
                  "--dhcp-range=10.0.7.100,10.0.7.200,1h") &&
            hasOneArg(DeviceWifi::dnsmasqLayer2Args("10.0.7.1"), "--dhcp-range",
                      "--dhcp-range=10.0.7.100,10.0.7.200,1h") &&
            hasOneArg(DeviceWifi::dnsmasqProvenArgs("10.0.7.1"), "--dhcp-range",
                      "--dhcp-range=10.0.7.100,10.0.7.200,1h"),
        "a different gateway carries its pool with it in every layer");
  check(hasOneArg(DeviceWifi::dnsmasqLayer1Args("10.0.7.1"), "--address=",
                  "--address=/#/10.0.7.1") &&
            hasOneArg(DeviceWifi::dnsmasqProvenArgs("10.0.7.1"), "--address=",
                      "--address=/#/10.0.7.1"),
        "and the DNS catch-all follows it too");

  // WHERE THE EVIDENCE LIVES. The lease and pid files stay on tmpfs (rewritten
  // constantly; /data holds the credentials), but the stderr captures are on
  // /data and one per layer: the power cycle that lets adb back in ERASES
  // /tmp, which is exactly how a year of tmpfs breadcrumbs never survived to
  // be read. Distinct files, so the layer that named a rejected argument is
  // never overwritten by the layer that ran after it.
  check(std::string(DeviceWifi::dnsmasqPidFile()).compare(0, 5, "/tmp/") == 0 &&
            std::string(DeviceWifi::dnsmasqLeaseFile()).compare(0, 5, "/tmp/") == 0,
        "pid and leases live on tmpfs, not on the jffs2 partition that holds the "
        "user's credentials");
  check(std::string(DeviceWifi::dnsmasqErrFile(1)).compare(0, 6, "/data/") == 0 &&
            std::string(DeviceWifi::dnsmasqErrFile(2)).compare(0, 6, "/data/") == 0 &&
            std::string(DeviceWifi::dnsmasqErrFile(3)).compare(0, 6, "/data/") == 0,
        "every stderr capture lives on /data — the only storage that still exists "
        "after the power cycle that lets adb back in");
  check(std::string(DeviceWifi::dnsmasqErrFile(1)) != std::string(DeviceWifi::dnsmasqErrFile(2)) &&
            std::string(DeviceWifi::dnsmasqErrFile(2)) !=
                std::string(DeviceWifi::dnsmasqErrFile(3)) &&
            std::string(DeviceWifi::dnsmasqErrFile(1)) !=
                std::string(DeviceWifi::dnsmasqErrFile(3)),
        "and no layer's complaint can overwrite another's");

  // --- who counts as OUR dnsmasq --------------------------------------------
  //
  // The old health check asked "is any process named dnsmasq alive?" — and a
  // dnsmasq started by init off the vendor conf, serving a 192.168.1.x pool
  // that can never match this AP, satisfied it perfectly while not one lease
  // went out. Identity is now claimed by cmdline content, and these are the
  // fixtures that pin who is in and who is out.
  {
    const std::string gw = "192.168.100.1";
    std::string joined1 = "/bin/dnsmasq";
    for (size_t i = 0; i < l1.size(); ++i) joined1 += " " + l1[i];
    std::string joined2 = "/bin/dnsmasq";
    for (size_t i = 0; i < l2.size(); ++i) joined2 += " " + l2[i];
    std::string joined3 = "/bin/dnsmasq";
    for (size_t i = 0; i < proven.size(); ++i) joined3 += " " + proven[i];
    check(DeviceWifi::cmdlineClaimsOurDnsmasq(joined1, gw),
          "layer 1 is recognised by its zos lease path");
    check(DeviceWifi::cmdlineClaimsOurDnsmasq(joined2, gw),
          "layer 2 — vendor-verbatim argv, no zos path — by the pool derived from "
          "OUR gateway");
    check(DeviceWifi::cmdlineClaimsOurDnsmasq(joined3, gw),
          "layer 3 by its zos pid file");
    check(!DeviceWifi::cmdlineClaimsOurDnsmasq("/bin/dnsmasq", gw),
          "a bare /bin/dnsmasq — exactly what an init-spawned one looks like — is "
          "NOT ours");
    check(!DeviceWifi::cmdlineClaimsOurDnsmasq(
              "/bin/dnsmasq --dhcp-range=192.168.1.101,192.168.1.200,12h", gw),
          "and neither is one serving the vendor conf's 192.168.1.x pool");
    check(!DeviceWifi::cmdlineClaimsOurDnsmasq(
              "/bin/dnsmasqd --dhcp-range=192.168.100.100,192.168.100.200,1h", gw),
          "a different binary does not count, even with our pool");
    check(!DeviceWifi::cmdlineClaimsOurDnsmasq("/bin/hostapd -B /data/misc/wifi/hostapd.conf",
                                               gw),
          "and neither does a different daemon entirely");
  }

  // --- the scan-completion contract -----------------------------------------
  //
  // The pinned form of the rule that emptied the setup page's dropdown: the
  // supplicant answers SCAN_RESULTS from its cache instantly, a fresh daemon's
  // cache parses as a perfectly valid EMPTY list, and treating that as a
  // finished sweep let the policy raise the hotspot on its first tick — which
  // stopped the supplicant and killed the real sweep mid-air, every time.
  check(!DeviceWifi::scanSweepComplete(true, 0),
        "an empty supplicant cache is NOT a finished sweep");
  check(DeviceWifi::scanSweepComplete(true, 1), "one network is");
  check(DeviceWifi::scanSweepComplete(true, 12), "and so is a full list");
  check(!DeviceWifi::scanSweepComplete(false, 4),
        "a failed parse is never a finished sweep, whatever it claims to carry");
}

// The breadcrumb log is the only debug channel a provisioning device has —
// the radio leaves the LAN, adb dies, logcat is banned, and /tmp is erased by
// the very power cycle that lets a reader back in. Its pure halves (format,
// sanitisation) and its real file behaviour (append, seq, rotation) are all
// host-checkable, so they are checked here rather than discovered on a
// stranded clock.
void checkProvisionLog() {
  using tcos::ProvisionLog;

  // One line, one event, flat key=value: `grep DNSMASQ` must be a complete
  // query language for a stranger reading a pulled file.
  check(ProvisionLog::formatLine(3, 12345, "AP_ENTER", "reason=no-creds scanned=0") ==
            "3 12345 AP_ENTER reason=no-creds scanned=0\n",
        "a line is seq, uptime, tag, fields");
  check(ProvisionLog::formatLine(1, 5, "BOOT", "") == "1 5 BOOT\n",
        "no fields means no trailing separator");

  // An SSID off the air can carry anything; a newline must not fake a second
  // event and a control byte must not mangle the pulled file.
  check(ProvisionLog::sanitize("a\nb\rc\td") == "a b c d",
        "line breaks and tabs inside a field become spaces");
  check(ProvisionLog::sanitize("ok\x01ok") == "ok?ok", "other control bytes are defanged");
  check(ProvisionLog::formatLine(2, 9, "PORTAL_HIT", "ssid=evil\nBOOT rev=fake") ==
            "2 9 PORTAL_HIT ssid=evil BOOT rev=fake\n",
        "so a hostile SSID cannot forge a breadcrumb line");

  // The REDACTION property is structural, not procedural: this API has no
  // argument a PSK could arrive through — the one call site that holds the key
  // (DeviceProvisioning::submit) writes the literal `psk=redacted` before any
  // string reaches the logger. There is nothing to test beyond the call sites,
  // which is the point: nothing to test is nothing to get wrong.

  // Real file behaviour, on a scratch path with a tiny budget so rotation is
  // reachable in a test.
  const char* p = "/tmp/zos-provlog-test.log";
  const char* p1 = "/tmp/zos-provlog-test.log.1";
  ::unlink(p);
  ::unlink(p1);
  {
    tcos::ProvisionLog log(p, p1, 256);
    log.log("BOOT", "rev=test");
    log.log("SCAN_CMD", "reply=OK");
    const std::string body = readFixture(p);
    check(body.compare(0, 2, "1 ") == 0, "seq starts at 1");
    check(body.find(" BOOT rev=test\n") != std::string::npos, "the first event is appended");
    check(body.find(" SCAN_CMD reply=OK\n") != std::string::npos, "and the second after it");
    check(body.find("\n2 ") != std::string::npos, "with the seq counting up");

    // Overflow the budget: the file must rotate to .1 and keep growing from
    // nearly empty, never balloon on the credentials partition.
    for (int i = 0; i < 40; ++i) log.log("PAD", "x=0123456789abcdef");
    struct stat st;
    check(::stat(p1, &st) == 0, "an oversized log rotates to .1 instead of growing");
    check(::stat(p, &st) == 0 && st.st_size <= 256 + 64,
          "and the live file restarts near-empty after rotation");
  }
  ::unlink(p);
  ::unlink(p1);

  // The boot stamp: compare-first, because /data is jffs2 and an unchanged id
  // must cost a read, not a write.
  const char* stamp = "/tmp/zos-provlog-test.id";
  ::unlink(stamp);
  check(tcos::ProvisionLog::writeFileIfChanged(stamp, "rev-1\n"), "a missing stamp is written");
  check(readFixture(stamp) == "rev-1\n", "with the body given");
  check(tcos::ProvisionLog::writeFileIfChanged(stamp, "rev-1\n"), "an identical body succeeds");
  check(tcos::ProvisionLog::writeFileIfChanged(stamp, "rev-2\n"), "a new body replaces it");
  check(readFixture(stamp) == "rev-2\n", "completely");
  ::unlink(stamp);

  check(std::string(ProvisionLog::devicePath()).compare(0, 6, "/data/") == 0 &&
            std::string(ProvisionLog::deviceRotatedPath()).compare(0, 6, "/data/") == 0 &&
            std::string(ProvisionLog::buildIdPath()).compare(0, 6, "/data/") == 0,
        "everything the coordinator must read after a power cycle lives on /data — "
        "tmpfs breadcrumbs are the mistake this class exists to end");
}

// ---------------------------------------------------------------------------
// BLE provisioning: the wire.
//
// Every byte this exercises arrives over an unauthenticated radio from anyone
// within ten metres. There is no TCP handshake in front of it, no same-origin
// check, no LAN membership — a GATT write is the only input this firmware takes
// from a stranger. So the rejection paths get as much attention here as the
// happy one, because on the device they are the paths that will actually be
// walked by something that is not the console.
void checkBleProtocol() {
  using namespace tcos::ble;

  // --- framing --------------------------------------------------------------
  {
    std::vector<std::string> chunks;
    check(encode("hi", &chunks), "a short message encodes");
    check(chunks.size() == 1, "into one chunk");
    check(static_cast<unsigned char>(chunks[0][0]) == (kFlagFirst | kFlagLast | 0),
          "carrying both FIRST and LAST and sequence zero");
    check(chunks[0].substr(1) == "hi", "with the payload behind the header");
  }
  {
    // 45 bytes: 19 + 19 + 7. The boundary that matters, because a message that
    // fits exactly would hide an off-by-one in the LAST bit.
    const std::string body(45, 'x');
    std::vector<std::string> chunks;
    check(encode(body, &chunks) && chunks.size() == 3, "45 bytes is three chunks");
    check(static_cast<unsigned char>(chunks[0][0]) == (kFlagFirst | 0), "first is FIRST only");
    check(static_cast<unsigned char>(chunks[1][0]) == 1, "the middle carries neither flag");
    check(static_cast<unsigned char>(chunks[2][0]) == (kFlagLast | 2), "the last is LAST");
    check(chunks[0].size() == 20 && chunks[1].size() == 20 && chunks[2].size() == 8,
          "and no chunk exceeds the 20-byte ATT payload");

    Reassembler rx;
    std::string out;
    const char* why = "";
    check(rx.push(chunks[0].data(), 20, &out, &why) == Reassembler::kNeedMore, "one chunk in");
    check(rx.push(chunks[1].data(), 20, &out, &why) == Reassembler::kNeedMore, "two chunks in");
    check(rx.push(chunks[2].data(), 8, &out, &why) == Reassembler::kComplete, "and it completes");
    check(out == body, "round-tripping the message exactly");
  }
  {
    const std::string tooBig(tcos::ble::kMaxMessageBytes + 1, 'x');
    std::vector<std::string> chunks;
    check(!encode(tooBig, &chunks) && chunks.empty(),
          "a message over the cap is refused rather than truncated");
  }
  {
    // Every way a stranger can malform the stream, and each one must drop the
    // buffer rather than leave a half-message that still parses.
    Reassembler rx;
    std::string out;
    const char* why = "";
    check(rx.push(0, 0, &out, &why) == Reassembler::kReject, "a zero-length chunk is rejected");
    check(std::string(why) == "chunk-size", "and says so");

    char oversized[32];
    std::memset(oversized, 0, sizeof(oversized));
    oversized[0] = static_cast<char>(kFlagFirst);
    check(rx.push(oversized, 21, &out, &why) == Reassembler::kReject,
          "a chunk longer than the MTU allows is rejected");

    char cont[4];
    cont[0] = 1;  // no FIRST, sequence 1
    check(rx.push(cont, 4, &out, &why) == Reassembler::kReject,
          "a continuation with no message in progress is an orphan");
    check(std::string(why) == "orphan", "named as one");

    char first[4];
    first[0] = static_cast<char>(kFlagFirst);
    first[1] = 'a';
    check(rx.push(first, 2, &out, &why) == Reassembler::kNeedMore, "a fresh FIRST opens one");
    char skipped[4];
    skipped[0] = 5;  // sequence jumps from 1 to 5
    check(rx.push(skipped, 2, &out, &why) == Reassembler::kReject, "a sequence gap is rejected");
    check(std::string(why) == "seq", "named as one");
    check(!rx.inProgress(), "and the partial message is dropped, not kept");
  }
  {
    // Never setting LAST must not be a way to grow the heap of a 36 MB device.
    Reassembler rx;
    std::string out;
    const char* why = "";
    char chunk[20];
    std::memset(chunk, 'x', sizeof(chunk));
    bool rejected = false;
    for (int i = 0; i < 64 && !rejected; ++i) {
      chunk[0] = static_cast<char>((i == 0 ? kFlagFirst : 0) | (i & kSeqMask));
      rejected = rx.push(chunk, 20, &out, &why) == Reassembler::kReject;
    }
    check(rejected && std::string(why) == "overflow",
          "a message that never ends is cut off at the cap");
  }
  {
    // A central that dropped mid-message and came back must not need a resync
    // command; it just starts again.
    Reassembler rx;
    std::string out;
    const char* why = "";
    char first[4];
    first[0] = static_cast<char>(kFlagFirst);
    first[1] = 'a';
    rx.push(first, 2, &out, &why);
    char again[4];
    again[0] = static_cast<char>(kFlagFirst | kFlagLast);
    again[1] = 'b';
    check(rx.push(again, 2, &out, &why) == Reassembler::kComplete, "a new FIRST restarts");
    check(out == "b", "keeping only the new message");
    check(rx.restarts() == 1, "and the discarded partial is counted, not silent");
  }

  // --- the body -------------------------------------------------------------
  {
    Message m;
    const char* why = "";
    check(m.parse("cmd\tjoin\nssid\thome\npsk\thunter2!\n", &why), "a well-formed document parses");
    check(m.get("cmd") == "join" && m.get("ssid") == "home", "fields come back by key");
    check(m.get("missing").empty() && !m.has("missing"), "an absent key is empty, not an error");
    check(m.size() == 3, "with the field count kept");

    Message noTrailing;
    check(noTrailing.parse("cmd\thello", &why), "a missing trailing newline is fine");
  }
  {
    // The rejection table. Each of these was a decision, and each decision is a
    // way in if it goes the other way.
    struct Case { const char* body; const char* why; const char* what; };
    const Case cases[] = {
        {"", "size", "an empty document"},
        {"cmdjoin\n", "no-tab", "a line with no separator"},
        {"cmd\tjoin\textra\n", "extra-tab", "a line with two separators"},
        {"cmd\tjoin\n\nssid\thome\n", "empty-line", "a blank line in the middle"},
        {"CMD\tjoin\n", "key-charset", "an upper-case key"},
        {"cmd!\tjoin\n", "key-charset", "a punctuation key"},
        {"\tjoin\n", "key-size", "an empty key"},
        {"cmd\tjoin\ncmd\tscan\n", "duplicate", "a duplicated key"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
      Message m;
      const char* why = "";
      const bool ok = m.parse(cases[i].body, &why);
      check(!ok && std::string(why) == cases[i].why, std::string("rejects ") + cases[i].what);
    }
    // Duplicates are rejected rather than resolved on purpose: "first wins" and
    // "last wins" are both defensible, and a difference of opinion between the
    // two sides is a way to get one SSID checked and another one joined.

    Message controlByte;
    const char* why = "";
    check(!controlByte.parse(std::string("ssid\tho\x01me\n"), &why) &&
              std::string(why) == "value-control",
          "rejects a control byte inside a value");

    Message longKey;
    check(!longKey.parse(std::string(17, 'k') + "\tv\n", &why) &&
              std::string(why) == "key-size",
          "rejects an over-long key");

    Message longValue;
    check(!longValue.parse("ssid\t" + std::string(161, 'v') + "\n", &why) &&
              std::string(why) == "value-size",
          "rejects an over-long value");

    Message tooMany;
    std::string many;
    for (int i = 0; i < 13; ++i) {
      char line[16];
      std::snprintf(line, sizeof(line), "k%d\tv\n", i);
      many += line;
    }
    check(!tooMany.parse(many, &why) && std::string(why) == "fields",
          "rejects a document with more fields than the protocol has");
  }

  // --- what we send ---------------------------------------------------------
  {
    const std::string doc = buildState("joining", "home", "192.168.8.42", "", -1);
    check(doc == "evt\tstate\nphase\tjoining\nssid\thome\nip\t192.168.8.42\n",
          "a state document is exactly its four fields");
    check(doc.find("psk") == std::string::npos,
          "and there is no slot a passphrase could ride out in — buildState has no such "
          "parameter, which is the same structural redaction ProvisionLog uses");

    const std::string locked = buildState("locked", "", "", "locked-out", 60);
    check(locked.find("err\tlocked-out\n") != std::string::npos, "an error rides along");
    check(locked.find("retry\t60\n") != std::string::npos, "with the countdown when there is one");
    check(buildState("idle", "", "", "", -1).find("retry") == std::string::npos,
          "and no countdown when there is not");

    // An SSID off the air is the one field of an outbound document a stranger
    // writes. A tab in it would forge a field; a newline would forge a line.
    const std::string forged = buildNet(0, 1, "evil\tssid\nrssi\t-1", -40, true, false);
    check(forged.find("evil ssid rssi -1") != std::string::npos,
          "a hostile SSID cannot forge fields on the way out");
    check(buildNet(2, 7, "home", -41, true, true) ==
              "evt\tnet\ni\t2\nn\t7\nssid\thome\nrssi\t-41\nsec\twpa\ncached\t1\n",
          "a network line carries index, total, name, signal, security and provenance");
    check(buildNet(0, 1, "open", -60, false, false).find("sec\topen\n") != std::string::npos,
          "an unsecured network says so");
    check(buildErr("frame") == "evt\terr\ncode\tframe\n", "an error is two fields");
    check(buildHello("ZOS-A772", "abc-1", "CC:C4:B2:77:A7:72") ==
              "evt\thello\nname\tZOS-A772\nbuild\tabc-1\nmac\tCC:C4:B2:77:A7:72\n",
          "hello names the device, the build and the MAC");
  }

  // --- credentials ----------------------------------------------------------
  {
    // THE INJECTION. DeviceWifi::connect builds `SET_NETWORK %d psk "%s"` with
    // snprintf; a quote closes the argument early and the rest of the string is
    // read as further control-socket syntax. Twenty bytes from a stranger is
    // exactly the shape of input that finds this.
    check(!ssidIsSafe("ho\"me"), "an SSID with a quote is refused");
    check(!ssidIsSafe("ho\\me"), "and so is one with a backslash");
    check(!pskIsSafe("pass\"word"), "the same for a passphrase");
    check(!ssidIsSafe(""), "an empty SSID is not a network");
    check(!ssidIsSafe(std::string(33, 'a')), "33 bytes is past what 802.11 allows");
    check(ssidIsSafe(std::string(32, 'a')), "32 is not");
    check(ssidIsSafe("\xE5\xAE\xB6\xE9\x87\x8C"), "a UTF-8 SSID is perfectly legal");
    check(!ssidIsSafe(std::string("a\nb")), "a newline in an SSID is refused");
    check(pskIsSafe(""), "an empty passphrase is an open network, not an error");
    check(!pskIsSafe("short7c"), "seven characters cannot be a WPA passphrase");
    check(pskIsSafe("eightchr"), "eight can");
    check(pskIsSafe(std::string(63, 'x')), "and so can sixty-three");
    check(!pskIsSafe(std::string(64, 'x')),
          "sixty-four would be a raw hex PSK, which this path would quote as a passphrase "
          "and silently fail to associate with");
  }

  // --- the advertisement ----------------------------------------------------
  {
    std::vector<uint8_t> ad;
    check(buildAdvertisingData("ZOS-A772", &ad), "the advertisement builds");
    check(ad.size() == 31,
          "and is exactly full — 3 flags + 18 UUID + 10 name, which is why the name is "
          "eight characters");
    check(ad[0] == 2 && ad[1] == 0x01 && ad[2] == 0x06,
          "flags say LE General Discoverable and BR/EDR Not Supported (the vendor's 0x50 "
          "says neither)");
    check(ad[3] == 17 && ad[4] == 0x07, "then the complete list of 128-bit service UUIDs");
    check(ad[5] == kServiceUuid[15] && ad[20] == kServiceUuid[0],
          "with the UUID reversed, as ATT and AD both require");
    check(ad[21] == 9 && ad[22] == 0x09, "then the complete local name");
    check(std::string(reinterpret_cast<const char*>(&ad[23]), 8) == "ZOS-A772",
          "which is the name the panel shows");

    std::vector<uint8_t> longName;
    check(buildAdvertisingData("ZOS-A772-EXTRA", &longName), "an over-long name still builds");
    check(longName.size() == 31, "inside the same 31 bytes");
    check(longName[22] == 0x08,
          "demoted to Shortened Local Name — an overflowing payload is dropped whole by the "
          "controller, which would leave the device advertising nothing");
    check(!buildAdvertisingData("", &ad), "an empty name is refused");
  }

  // --- the code -------------------------------------------------------------
  {
    check(codeFromSeed(0) == "100000", "the code floor keeps six digits");
    check(codeFromSeed(899999) == "999999", "and so does the ceiling");
    check(codeFromSeed(900000) == "100000", "wrapping stays in range");
    check(codeFromSeed(12345) == codeFromSeed(12345), "and it is a function of the seed alone");
    check(tcos::text::measure(codeFromSeed(4).c_str()) == 36,
          "six ASCII cells is 36 px, comfortably inside the 50 px the panel clips to");
    check(uuidToString(kServiceUuid) == "7a1f5b60-2c8e-4f3a-9d51-0b4e6c8a2d10",
          "the service UUID is the one the console filters its chooser on");
  }
}

// ---------------------------------------------------------------------------
// BLE provisioning: the state machine.
void checkBleSession() {
  using tcos::BleProvisionSession;

  // A session that is advertising, connected, and has not proved anything yet.
  // Repeated in each block rather than shared, because "what happened before"
  // is the thing most of these are about.
  struct Fixture {
    BleProvisionSession session;
    Fixture() {
      session.configure("ZOS-A772", "test-build", "CC:C4:B2:77:A7:72");
      session.beginAdvertising(4242, 0);
      session.onConnect(0);
    }
    void authorise(int nowMs) {
      session.onMessage("cmd\tcode\ncode\t" + session.code() + "\n", nowMs);
      drain();
    }
    void drain() {
      std::string out;
      while (session.takeOutbound(&out)) last = out;
      std::string a;
      while (session.takeAudit(&a)) audits.push_back(a);
    }
    std::string last;
    std::vector<std::string> audits;
  };

  // Authorisation gates BOTH mutators, and it answers rather than ignoring:
  // silence would leave the console waiting for something that is not coming.
  {
    Fixture f;
    f.session.onMessage("cmd\tscan\n", 100);
    std::string ssid;
    std::string psk;
    check(f.session.takeRequest(&ssid, &psk) == BleProvisionSession::kRequestNone,
          "an unauthorised scan reaches the radio not at all");
    f.drain();
    check(f.last.find("err\tno-code\n") != std::string::npos, "and is answered with no-code");
  }

  {
    Fixture f;
    check(f.session.code().size() == 6, "the panel has six digits to show");
    f.session.onMessage("cmd\tcode\ncode\t000000\n", 100);
    f.drain();
    check(!f.session.authorised(), "a wrong code does not authorise");
    for (int i = 0; i < 4; ++i) f.session.onMessage("cmd\tcode\ncode\t000000\n", 200 + i);
    f.drain();
    check(f.last.find("err\tlocked-out\n") != std::string::npos,
          "five wrong tries lock the session out");
    check(f.last.find("retry\t60\n") != std::string::npos, "with a countdown the console can show");
    check(f.session.lockoutRemainingMs(210) > 0, "and the lockout is live");
    // The right code while locked out must not work: otherwise the lockout is a
    // message rather than a limit.
    f.session.onMessage("cmd\tcode\ncode\t" + f.session.code() + "\n", 300);
    check(!f.session.authorised(), "the correct code is refused while locked out");
    const std::string held = f.session.code();
    f.session.beginAdvertising(999, 400);
    check(f.session.code() == held,
          "and reconnecting cannot roll a fresh code — that would make the limit five tries "
          "per reconnect, which is not a limit");
    f.session.onMessage("cmd\tcode\ncode\t" + f.session.code() + "\n",
                        400 + BleProvisionSession::kLockoutMs + 1);
    check(f.session.authorised(), "once it expires the right code works again");
  }

  // The guard. Refused before the radio is touched, and reported at that
  // moment: a submit silently dropped leaves a user waiting for a reconnection
  // that was never going to happen.
  {
    Fixture f;
    BleProvisionSession::Link link;
    link.locked = true;
    f.session.noteLink(link, 50);
    f.authorise(100);
    f.session.onMessage("cmd\tjoin\nssid\thome\npsk\thunter22\n", 150);
    std::string ssid;
    std::string psk;
    check(f.session.takeRequest(&ssid, &psk) == BleProvisionSession::kRequestNone,
          "a locked link never produces a join request");
    f.drain();
    check(f.last.find("err\tlink-locked\n") != std::string::npos, "and the console is told why");
    check(f.last.find("phase\tlocked\n") != std::string::npos, "in the phase as well as the error");
  }

  // Credentials that could break the control socket never become a request.
  {
    Fixture f;
    f.authorise(100);
    f.session.onMessage("cmd\tjoin\nssid\tho\"me\npsk\thunter22\n", 150);
    std::string ssid;
    std::string psk;
    check(f.session.takeRequest(&ssid, &psk) == BleProvisionSession::kRequestNone,
          "an SSID with a quote is refused before it can reach SET_NETWORK");
    f.drain();
    check(f.last.find("code\targ\n") != std::string::npos, "with a distinct error");
  }

  // The happy join, and what happens to the passphrase afterwards.
  {
    Fixture f;
    f.authorise(100);
    f.session.onMessage("cmd\tjoin\nssid\thome\npsk\thunter22\n", 200);
    std::string ssid;
    std::string psk;
    check(f.session.takeRequest(&ssid, &psk) == BleProvisionSession::kRequestJoin,
          "an authorised join is handed to the caller");
    check(ssid == "home" && psk == "hunter22", "with both credentials");
    std::string ssid2;
    std::string psk2;
    check(f.session.takeRequest(&ssid2, &psk2) == BleProvisionSession::kRequestNone &&
              psk2.empty(),
          "and the passphrase is gone from the session the moment it is taken");
    check(std::string(f.session.phase()) == "joining", "the phase follows");

    f.drain();
    for (size_t i = 0; i < f.audits.size(); ++i) {
      check(f.audits[i].find("psk=redacted") != std::string::npos,
            "every audit line says psk=redacted");
      check(f.audits[i].find("hunter22") == std::string::npos,
            "and no audit line can carry the passphrase — the builder is never given it");
    }

    BleProvisionSession::Link link;
    link.joining = true;
    link.wpaState = "ASSOCIATED";
    f.session.noteLink(link, 300);
    check(std::string(f.session.phase()) == "joining", "still joining while the policy tries");
    link.joining = false;
    link.online = true;
    link.ssid = "home";
    link.ip = "192.168.8.42";
    f.session.noteLink(link, 4000);
    check(std::string(f.session.phase()) == "online", "an address ends it");
    f.drain();
    check(f.last.find("ip\t192.168.8.42\n") != std::string::npos,
          "and the console is given the address it was waiting for");
  }

  // The submit tick, in the order osLogic actually uses.
  //
  // Every BLE join used to report failure before the radio was asked. The
  // caller sampled the link BEFORE handing the request to the policy, and at
  // that instant the policy is in kStandby — a connected BLE console puts it
  // there through the hotspot hold — so `joining` was false, the attempt was
  // classified as no-ap, and the console was shown 找不到网络 on the very tick
  // the user pressed submit, then the truth seconds later. osLogic now takes
  // the request first; this latch is the belt-and-braces half, because a
  // caller's ordering is not something this class can see.
  {
    Fixture f;
    f.authorise(100);
    f.session.onMessage("cmd\tjoin\nssid\thome\npsk\thunter22\n", 200);
    BleProvisionSession::Link link;
    link.joining = false;  // the policy has not been asked yet
    f.session.noteLink(link, 200);
    check(std::string(f.session.phase()) == "joining",
          "a link sampled before the policy was asked does not end the attempt");
    check(std::string(f.session.lastError()).empty(), "and diagnoses nothing");

    link.joining = true;
    link.wpaState = "ASSOCIATED";
    f.session.noteLink(link, 400);
    link.joining = false;
    link.wpaState = "SCANNING";
    f.session.noteLink(link, 1200);
    check(std::string(f.session.phase()) == "failed",
          "once it HAS been seen working, a policy that stops is a real failure");

    // And a policy that never associates at all is still ended, by the budget.
    Fixture g;
    g.authorise(100);
    g.session.onMessage("cmd\tjoin\nssid\thome\npsk\thunter22\n", 200);
    BleProvisionSession::Link idle;
    idle.joining = false;
    g.session.noteLink(idle, 200 + BleProvisionSession::kJoinBudgetMs);
    check(std::string(g.session.phase()) == "failed",
          "the join budget is what stops the latch becoming a wait with no end");
  }

  // The three failures, never collapsed into one. Getting this wrong is the
  // console-side twin of a bug this firmware has already shipped: a plausible
  // message that sends the user to fix the wrong thing.
  {
    check(std::string(BleProvisionSession::classifyFailure(true, true, true, false)) == "dhcp",
          "COMPLETED with no address is a lease problem, not a password problem");
    check(std::string(BleProvisionSession::classifyFailure(true, true, true, true)).empty(),
          "COMPLETED with an address is not a failure at all");
    check(std::string(BleProvisionSession::classifyFailure(true, true, false, false)) == "bad-psk",
          "a four-way handshake that never completes is the key");
    check(std::string(BleProvisionSession::classifyFailure(true, false, false, false)) == "bad-psk",
          "and so is an association that never completes — the only step left is the key");
    check(std::string(BleProvisionSession::classifyFailure(false, false, false, false)) == "no-ap",
          "never associating at all means nothing with that name answered");
  }

  {
    Fixture f;
    f.authorise(100);
    f.session.onMessage("cmd\tjoin\nssid\thome\npsk\twrongpass\n", 200);
    std::string ssid;
    std::string psk;
    f.session.takeRequest(&ssid, &psk);
    BleProvisionSession::Link link;
    link.joining = true;
    link.wpaState = "4WAY_HANDSHAKE";
    f.session.noteLink(link, 300);
    link.wpaState = "SCANNING";
    link.joining = false;
    f.session.noteLink(link, 5000);
    check(std::string(f.session.phase()) == "failed", "a policy that gave up ends the attempt");
    check(std::string(f.session.lastError()) == "bad-psk", "with the handshake it saw named");
    check(f.session.code().size() == 6,
          "and the session is still advertising a code, because a failure ends an attempt, "
          "not the session");
  }

  {
    // The state the policy never escapes: associated, no lease, forever. Without
    // a budget of our own the console sits on a progress bar for good.
    Fixture f;
    f.authorise(100);
    f.session.onMessage("cmd\tjoin\nssid\thome\npsk\thunter22\n", 200);
    std::string ssid;
    std::string psk;
    f.session.takeRequest(&ssid, &psk);
    BleProvisionSession::Link link;
    link.joining = true;
    link.wpaState = "COMPLETED";
    f.session.noteLink(link, 300);
    f.session.noteLink(link, 200 + BleProvisionSession::kJoinBudgetMs - 10);
    check(std::string(f.session.phase()) == "joining", "it waits out the whole budget");
    f.session.noteLink(link, 200 + BleProvisionSession::kJoinBudgetMs + 10);
    check(std::string(f.session.phase()) == "failed" &&
              std::string(f.session.lastError()) == "dhcp",
          "then reports the lease as the thing that is missing");
  }

  // The network list.
  {
    Fixture f;
    f.authorise(100);
    f.session.onMessage("cmd\tscan\n", 200);
    std::string ssid;
    std::string psk;
    check(f.session.takeRequest(&ssid, &psk) == BleProvisionSession::kRequestScan,
          "an authorised scan reaches the caller");
    std::vector<BleProvisionSession::Network> nets;
    BleProvisionSession::Network net;
    net.ssid = "home";
    net.rssi = -41;
    net.secured = true;
    nets.push_back(net);
    net.ssid = "guest";
    net.rssi = -70;
    net.secured = false;
    nets.push_back(net);
    net.ssid = "ev\"il";  // an SSID we could not round-trip through the supplicant
    nets.push_back(net);
    f.session.deliverScan(nets, false, 300);

    std::vector<std::string> sent;
    std::string out;
    while (f.session.takeOutbound(&out)) sent.push_back(out);
    int netLines = 0;
    bool sawTotal = false;
    for (size_t i = 0; i < sent.size(); ++i) {
      if (sent[i].find("evt\tnet\n") == 0) {
        ++netLines;
        if (sent[i].find("n\t3\n") != std::string::npos) sawTotal = true;
      }
      check(sent[i].find("ev\"il") == std::string::npos,
            "a network the supplicant could not be asked to join is not offered");
    }
    check(netLines == 2, "one line per usable network");
    check(sawTotal,
          "each carrying the total, so the console renders a determinate list rather than a "
          "spinner that might never end");
    check(std::string(f.session.phase()) != "scanning", "and the scan ends");
  }

  {
    Fixture f;
    f.authorise(100);
    f.session.onMessage("cmd\tscan\n", 200);
    std::string ssid;
    std::string psk;
    f.session.takeRequest(&ssid, &psk);
    f.session.noteScanFailed(300);
    f.drain();
    check(f.last.find("err\tscan-empty\n") != std::string::npos,
          "a sweep that produced nothing says so rather than leaving the list blank forever");
  }

  // Malformed input from the air is answered and dropped, never acted on.
  {
    Fixture f;
    f.authorise(100);
    f.session.onMessage("this is not a document", 200);
    f.drain();
    // `doc`, not `frame`. A document this parser refused is permanent — the
    // same bytes fail the same way — while `frame` means a lost chunk, which
    // the next FIRST resynchronises. The console ignores `frame` on purpose, so
    // sharing the code left it waiting out an 8 s reply timeout and reporting
    // 时钟没有应答 about a device that had answered at once and said no.
    check(f.last == "evt\terr\ncode\tdoc\n", "a malformed message is rejected whole");
    std::string ssid;
    std::string psk;
    check(f.session.takeRequest(&ssid, &psk) == BleProvisionSession::kRequestNone,
          "and produces no work");
    f.session.onFrameError("sequence", 260);
    f.drain();
    check(f.last == "evt\terr\ncode\tframe\n",
          "and `frame` is kept for the transport fault it names");
    f.session.onMessage("cmd\tdrop-tables\n", 250);
    f.drain();
    check(f.last == "evt\terr\ncode\tcmd\n", "an unknown command is refused by name");
  }

  // hello answers before authorisation, and says which of the two reasons the
  // console cannot proceed for.
  {
    Fixture f;
    f.session.onMessage("cmd\thello\n", 100);
    std::vector<std::string> sent;
    std::string out;
    while (f.session.takeOutbound(&out)) sent.push_back(out);
    check(sent.size() >= 2 && sent[0].find("evt\thello\n") == 0, "hello identifies the device");
    check(sent[0].find("name\tZOS-A772\n") != std::string::npos,
          "with the same name the panel and the advertisement carry");
    check(sent[1].find("err\tno-code\n") != std::string::npos,
          "and the state that follows asks for the code");
  }
  {
    Fixture f;
    BleProvisionSession::Link link;
    link.locked = true;
    f.session.noteLink(link, 50);
    f.session.onMessage("cmd\thello\n", 100);
    std::vector<std::string> sent;
    std::string out;
    while (f.session.takeOutbound(&out)) sent.push_back(out);
    bool sawLocked = false;
    for (size_t i = 0; i < sent.size(); ++i) {
      if (sent[i].find("err\tlink-locked\n") != std::string::npos) sawLocked = true;
    }
    check(sawLocked,
          "a guarded device says so on hello — before the user types a password into a "
          "console that was never going to be listened to");
  }

  // A 6 Hz poll must not become six notifications a second.
  {
    Fixture f;
    f.authorise(100);
    BleProvisionSession::Link link;
    link.online = true;
    link.ip = "192.168.8.42";
    for (int t = 200; t < 2000; t += 160) f.session.noteLink(link, t);
    int count = 0;
    std::string out;
    while (f.session.takeOutbound(&out)) ++count;
    check(count <= 2, "an unchanged link is published once, not on every poll");
  }
}

// ---------------------------------------------------------------------------
// BLE provisioning: the panel.
void checkProvisionScreen() {
  using tcos::ProvisionScreen;

  // The stage priority, which is where the honesty rule lives.
  {
    ProvisionScreen::Inputs in;
    in.guardLocked = true;
    in.bleAdvertising = true;
    in.online = true;
    check(ProvisionScreen::stageFor(in) == ProvisionScreen::kGuardLocked,
          "the guard beats everything, including being online");

    ProvisionScreen::Inputs down;
    down.bleAdvertising = false;
    down.centralConnected = true;
    down.authorised = true;
    check(ProvisionScreen::stageFor(down) == ProvisionScreen::kRadioDown,
          "an unconfirmed advertisement beats every stage that would print a name or a code");

    ProvisionScreen::Inputs on;
    on.bleAdvertising = true;
    on.online = true;
    on.joining = true;
    check(ProvisionScreen::stageFor(on) == ProvisionScreen::kOnline, "an address wins over trying");

    ProvisionScreen::Inputs link;
    link.bleAdvertising = true;
    link.centralConnected = true;
    check(ProvisionScreen::stageFor(link) == ProvisionScreen::kLinkUp,
          "a central that has not proved the code parks on it");
    link.authorised = true;
    check(ProvisionScreen::stageFor(link) == ProvisionScreen::kAdvertising,
          "and stops parking once it has");

    ProvisionScreen::Inputs idle;
    idle.bleAdvertising = true;
    check(ProvisionScreen::stageFor(idle) == ProvisionScreen::kAdvertising,
          "on the air with nobody connected is simply advertising");
  }

  // THE HONESTY RULE, asserted where it can actually fail: a state carrying a
  // name and a code, in the two stages that mean nothing is on the air.
  {
    ProvisionScreen::State state;
    state.name = "ZOS-A772";
    state.code = "418327";
    state.portal = "192.168.8.42:80";
    state.stage = ProvisionScreen::kRadioDown;
    std::vector<ProvisionScreen::Page> pages = ProvisionScreen::pagesFor(state);
    for (size_t i = 0; i < pages.size(); ++i) {
      check(pages[i].text != "ZOS-A772" && pages[i].text != "418327",
            "a radio that is not on the air shows neither the name nor the code — a user "
            "tapping a chooser that will never list them is worse than a panel that says so");
    }
    check(pages.size() == 3, "it shows the label, the reason, and the way in that still works");
    check(pages[2].text == "192.168.8.42:80",
          "the hotspot page appears HERE and only here, where it is the only path left");

    state.stage = ProvisionScreen::kGuardLocked;
    pages = ProvisionScreen::pagesFor(state);
    check(pages.size() == 2, "a guarded device says 配网 and 未解锁 and nothing else");
    for (size_t i = 0; i < pages.size(); ++i) {
      check(pages[i].text != "418327", "and offers no code it would refuse to act on");
    }

    state.stage = ProvisionScreen::kAdvertising;
    pages = ProvisionScreen::pagesFor(state);
    check(pages.size() == 3 && pages[1].text == "ZOS-A772" && pages[2].text == "418327",
          "on the air it shows the two things a user standing at the clock needs");
    check(pages[2].tone == ProvisionScreen::kToneCode, "with the code in its own tone");

    state.stage = ProvisionScreen::kFailed;
    state.failure = ProvisionScreen::kFailBadPsk;
    pages = ProvisionScreen::pagesFor(state);
    check(pages.size() == 3 && pages[1].text == "ZOS-A772",
          "a failure keeps the name and the code up: the next thing the user does is retype");

    state.stage = ProvisionScreen::kJoining;
    state.ssid = "home";
    pages = ProvisionScreen::pagesFor(state);
    check(pages.size() == 2 && pages[1].text == "home",
          "joining names the network, so 'you picked the wrong one' is visible on the device");

    state.stage = ProvisionScreen::kOnline;
    state.ip = "192.168.8.42";
    pages = ProvisionScreen::pagesFor(state);
    check(pages.size() == 2 && pages[1].text == "192.168.8.42", "online shows the address");
  }

  // The failure vocabulary is never guessed at.
  {
    check(ProvisionScreen::failureFor("bad-psk") == ProvisionScreen::kFailBadPsk, "密码错误");
    check(ProvisionScreen::failureFor("no-ap") == ProvisionScreen::kFailNoAp, "找不到网络");
    check(ProvisionScreen::failureFor("dhcp") == ProvisionScreen::kFailDhcp, "没有地址");
    check(ProvisionScreen::failureFor("") == ProvisionScreen::kFailNone, "no error, no word");
    check(ProvisionScreen::failureFor("scan-empty") == ProvisionScreen::kFailOther,
          "an error this panel cannot name says 连接失败 rather than picking one of the three "
          "and sending the user to fix the wrong thing");
  }

  // Widths, against the 50 px the screen clips to.
  {
    check(tcos::text::measure("ZOS-A772") == 48, "the name fits without a marquee");
    check(tcos::text::measure("418327") == 36, "and so does the code");
    // 蓝牙未启动 — five CJK cells, 60 px, wider than the window, so it marquees.
    check(tcos::text::measure("\xE8\x93\x9D\xE7\x89\x99\xE6\x9C\xAA\xE5\x90\xAF\xE5\x8A\xA8") ==
              60,
          "the radio-down message is wider than the panel and must scroll");
    check(tcos::text::marqueeCycleMs(48, 50) == 0, "something that fits has no cycle");
    check(tcos::text::marqueeCycleMs(60, 50) ==
              2 * tcos::text::kMarqueeDwellMs + 2 * ((10 * 1000) / tcos::text::kMarqueePxPerSecond),
          "and a cycle is dwell, scroll, dwell, scroll back");
  }

  // THE CAROUSEL RULE. A page that scrolls must hold for its whole scroll, or
  // the tail of the widest and most important strings is never seen at all.
  {
    check(ProvisionScreen::dwellMsFor("ZOS-A772") == ProvisionScreen::kMinDwellMs,
          "a page that fits holds for the floor");
    const std::string wide = "192.168.100.1:8080";
    check(tcos::text::measure(wide.c_str()) > 50, "a long address does not fit");
    check(ProvisionScreen::dwellMsFor(wide) == tcos::text::marqueeCycleMs(
                                                   tcos::text::measure(wide.c_str()), 50),
          "so it holds for exactly one full ping-pong");
    check(ProvisionScreen::dwellMsFor(wide) > ProvisionScreen::kMinDwellMs,
          "which is longer than the floor");
    check(!ProvisionScreen::autoAdvances(ProvisionScreen::kLinkUp),
          "the moment somebody connects, the code stops moving");
    check(ProvisionScreen::autoAdvances(ProvisionScreen::kAdvertising),
          "otherwise the carousel runs");
  }

  // And it renders: pixels on the panel, the rail carrying the stage, and the
  // parked page being the code rather than the label.
  {
    Surface out(tcos::kPanelWidth, tcos::kPanelHeight);
    ProvisionScreen screen;
    ProvisionScreen::State state;
    state.stage = ProvisionScreen::kAdvertising;
    state.name = "ZOS-A772";
    state.code = "418327";
    screen.setState(state, 0);
    screen.onEnter(0);
    screen.render(out, 200);
    check(litPixels(out) > 0, "an advertising panel is not blank");
    check(screen.pageIndex() == 0, "and starts on the label");
    screen.render(out, ProvisionScreen::kMinDwellMs + 10);
    check(screen.pageIndex() == 1, "then advances on its own");

    state.stage = ProvisionScreen::kLinkUp;
    screen.setState(state, 5000);
    check(screen.pageIndex() == 2,
          "a central connecting parks the panel on the code — that instant is when the code "
          "is the answer to the user's question");
    screen.render(out, 5000 + ProvisionScreen::kMinDwellMs * 3);
    check(screen.pageIndex() == 2, "and it stays there while they type it");
    screen.onInput(tcos::kInputTurnCw, 9000);
    check(screen.pageIndex() == 0, "though the knob still works");

    // The rail is the only always-visible channel, and it is what tells a user
    // the panel is alive while the text is mid-scroll.
    Surface joining(tcos::kPanelWidth, tcos::kPanelHeight);
    state.stage = ProvisionScreen::kJoining;
    state.ssid = "home";
    screen.setState(state, 10000);
    screen.onEnter(10000);
    screen.render(joining, 10300);
    int railLit = 0;
    for (int x = 0; x < tcos::kPanelWidth; ++x) {
      const Color c = joining.getPixel(x, tcos::kPanelHeight - 1);
      if (c.r || c.g || c.b) ++railLit;
    }
    check(railLit == tcos::kPanelWidth, "the joining rail is a full row with a sweep on it");

    Surface online(tcos::kPanelWidth, tcos::kPanelHeight);
    state.stage = ProvisionScreen::kOnline;
    state.ip = "192.168.8.42";
    screen.setState(state, 20000);
    screen.onEnter(20000);
    screen.render(online, 20300);
    check(litPixels(online) > 0, "and an online panel shows the address it got");
  }
}

// ---------------------------------------------------------------------------
// The hotspot hold: what BLE provisioning needs from WifiPolicy.
//
// The hotspot is one-way on this radio — bringUpSoftAp() stops wpa_supplicant,
// /etc/init.rc declares that service `disabled` + `oneshot`, and there is no
// concurrent AP+station mode — so raising it under a console that is connected
// over BLE would take away the one thing this architecture exists to provide.
void checkHotspotHold() {
  using tcos::WifiPolicy;

  {
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.setHotspotHold(true, 0);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    check(policy.state() == WifiPolicy::kStandby,
          "with a console connected, a device with no credentials waits in standby");
    check(w.apStarts == 0, "and the hotspot never goes up");
    check(w.scans == 0,
          "nor is a sweep gathered for it — the console does its own, on demand, over a link "
          "that does not cost the radio");
    check(policy.isProvisioning(), "it is still 'waiting for a human'");
    check(!policy.hotspotActive(),
          "but the panel must not print an SSID and passphrase for a network that is not on "
          "the air");
  }

  {
    // Standby keeps the station radio, because that is the whole point: the
    // console is about to ask it to scan and to join.
    FakeWifi w;
    w.stored = true;
    // The credentials are issued fine and simply never associate — a moved
    // router, a changed password. That is the timeout this state exists for.
    w.assoc = false;
    WifiPolicy policy(&w);
    policy.setHotspotHold(true, 0);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    check(policy.state() == WifiPolicy::kConnecting, "it tries the stored network first");
    policy.tick(WifiPolicy::kAdoptGraceMs + 30 + WifiPolicy::kConnectTimeoutMs);
    check(policy.state() == WifiPolicy::kStandby, "a connect timeout lands in standby too");
    const int before = w.connects;
    policy.tick(WifiPolicy::kAdoptGraceMs + 40 + WifiPolicy::kConnectTimeoutMs +
                WifiPolicy::kBackgroundRetryMs);
    check(w.connects > before,
          "and the stored network is still retried in the background — the usual cause is a "
          "router that is merely slow to come back");
    w.running = false;
    policy.tick(WifiPolicy::kAdoptGraceMs + 50 + WifiPolicy::kConnectTimeoutMs +
                WifiPolicy::kBackgroundRetryMs);
    check(w.starts > 1 && policy.state() == WifiPolicy::kStartingWpa,
          "a supplicant that dies in standby is revived, unlike in kProvisioning where "
          "hostapd deliberately owns wlan0");
  }

  {
    // Releasing the hold owes the hotspot to whoever comes next: BLE is not a
    // path Safari or Firefox has, and a device nobody is driving must still fall
    // back to the page that works everywhere.
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.setHotspotHold(true, 0);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    check(policy.state() == WifiPolicy::kStandby, "parked");
    policy.setHotspotHold(false, 30000);
    check(policy.state() == WifiPolicy::kScanning, "releasing it starts the sweep");
    w.visible.push_back("neighbour");
    policy.tick(30100);
    check(policy.state() == WifiPolicy::kProvisioning && w.apUp,
          "and the hotspot follows, in that order, exactly as it always has");
  }

  {
    // THE TRIP NOTHING ELSE CAN MAKE. A device that already gave up and raised
    // its hotspot has stopped the supplicant, and nothing in this firmware puts
    // it back — a console connecting over BLE is the one event that can, because
    // the person whose session it interrupts is the person asking.
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    w.visible.push_back("neighbour");
    policy.tick(WifiPolicy::kAdoptGraceMs + 30);
    check(policy.state() == WifiPolicy::kProvisioning && w.apUp, "the hotspot is up");
    const int stopsBefore = w.apStops;
    const int startsBefore = w.starts;
    policy.setHotspotHold(true, 60000);
    check(w.apStops == stopsBefore + 1, "connecting over BLE tears the hotspot down");
    check(w.starts == startsBefore + 1, "and restarts the supplicant it had stopped");
    check(policy.state() == WifiPolicy::kStartingWpa, "so the radio can be a station again");
  }

  {
    // settled() gates the BLE bring-up, which is `ctl.start hciattach` plus
    // HCIDEVUP on the aic8800 — the part that also carries wlan0 and therefore
    // adb. Starting it while the policy is mid-command races an association on
    // the same chip, and the first tick after boot is the worst moment there
    // is. Nothing but the states where the policy has stopped issuing commands
    // may answer true.
    FakeWifi w;
    w.stored = true;
    w.assoc = false;
    WifiPolicy policy(&w);
    check(!policy.settled(), "before begin() nothing has settled");
    policy.begin(0);
    check(policy.state() == WifiPolicy::kAdopting && !policy.settled(),
          "the adopt grace is a wait, not a resting state");
    policy.tick(WifiPolicy::kAdoptGraceMs + 10);
    policy.tick(WifiPolicy::kAdoptGraceMs + 20);
    check(policy.state() == WifiPolicy::kConnecting && !policy.settled(),
          "and neither is a supplicant being driven");
    policy.tick(WifiPolicy::kAdoptGraceMs + 30 + WifiPolicy::kConnectTimeoutMs);
    check(policy.state() == WifiPolicy::kScanning && !policy.settled(),
          "nor a sweep in flight");
    w.visible.push_back("neighbour");
    policy.tick(WifiPolicy::kAdoptGraceMs + 40 + WifiPolicy::kConnectTimeoutMs);
    check(policy.state() == WifiPolicy::kProvisioning && policy.settled(),
          "a device waiting on its hotspot has stopped touching the radio");

    FakeWifi online;
    online.stored = true;
    online.running = true;
    online.assoc = true;
    online.address = true;
    WifiPolicy up(&online);
    up.begin(0);
    up.tick(10);
    check(up.state() == WifiPolicy::kOnline && up.settled(), "and so has one that is online");
  }
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
  checkChannelRefreshPath();
  std::printf("  channel refresh path ok\n");
  checkSettingsScreen();
  std::printf("  settings screen ok\n");
  checkMusicScreen();
  std::printf("  music screen ok\n");
  checkMusicTheme();
  std::printf("  music theme ok\n");
  checkMusicPath();
  std::printf("  music path ok\n");
  checkLyricTiming();
  std::printf("  lyric timing ok\n");
  checkLyricLegacyFrames();
  std::printf("  lyric legacy frames ok\n");
  checkWordLyricScreen();
  std::printf("  word lyric screen ok\n");
  checkNavigationFlow();
  std::printf("  navigation flow ok\n");
  checkLevelOverlay();
  std::printf("  level overlay ok\n");
  checkConsoleSettings();
  std::printf("  console settings ok\n");
  checkSleepPolicy();
  std::printf("  sleep policy ok\n");
  checkSleepRows();
  std::printf("  sleep rows ok\n");
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
  checkHotspotHold();
  std::printf("  hotspot hold ok\n");
  checkBleProtocol();
  std::printf("  ble protocol ok\n");
  checkBleSession();
  std::printf("  ble session ok\n");
  checkProvisionScreen();
  std::printf("  provision screen ok\n");
  checkProvisionLog();
  std::printf("  provision log ok\n");
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
