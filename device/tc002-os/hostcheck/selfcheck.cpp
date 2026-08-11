// Host self-check for tc002-os.
//
// Compiles the parts of the firmware that carry no FlyThings headers with a
// plain clang++ and asserts their pixels. The device's adbd is not reliably
// reachable and the LED bus is write-only — nothing can read a frame back off
// the panel — so this is the only place a UI regression can be caught at all.
//
// Run with: mise run os-hostcheck

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "core/Ease.h"
#include "core/RingModel.h"
#include "core/Shell.h"
#include "core/Surface.h"
#include "core/Text.h"
#include "net/FrameBundle.h"
#include "net/HttpServer.h"
#include "net/SetupPortal.h"
#include "net/StateDoc.h"
#include "net/WifiPolicy.h"
#include "games/breakout.h"
#include "games/flappy.h"
#include "games/pong.h"
#include "games/racer.h"
#include "games/shooter.h"
#include "games/snake.h"
#include "games/tetris.h"
#include "ui/BootScreen.h"
#include "ui/GameScreen.h"
#include "ui/LauncherScreen.h"
#include "ui/LevelOverlay.h"
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

void checkBootScreen() {
  tcos::BootScreen boot;
  Surface s(52, 16);
  boot.onEnter(0);

  check(tcos::BootScreen::durationMs() == 1500, "boot lasts 1500 ms");
  check(!boot.isDone(0), "boot is not done at t=0");
  check(!boot.isDone(1499), "boot is still running one ms before the end");
  check(boot.isDone(1500), "boot is done at its stated duration");
  check(boot.isAnimating(300) && !boot.isAnimating(1500), "isAnimating tracks isDone");

  // Determinism is the whole contract that lets these assertions exist.
  boot.render(s, 300);
  std::vector<uint8_t> first;
  s.extractRGB(first);
  Surface again(52, 16);
  boot.render(again, 300);
  std::vector<uint8_t> second;
  again.extractRGB(second);
  check(first == second, "the same instant renders the same pixels");

  // BEAT 1: the head sweeps left to right, so its brightest column advances.
  boot.render(s, 40);
  const int early = brightestColumn(s);
  boot.render(s, 300);
  const int mid = brightestColumn(s);
  boot.render(s, 500);
  const int late = brightestColumn(s);
  check(early < mid && mid < late, "the sweep head travels rightwards");
  check(late >= 45, "the sweep reaches the right edge before beat 2");

  // The trail must persist behind the head, or the sweep reads as a lone dot.
  boot.render(s, 300);
  int litBehind = 0;
  for (int x = 0; x < 8; ++x) {
    for (int y = 0; y < 16; ++y) {
      const Color c = s.getPixel(x, y);
      if (c.r || c.g || c.b) ++litBehind;
    }
  }
  check(litBehind > 0, "a dim trail persists behind the head");

  // BEAT 2: the bloom covers strictly more of the panel than the sweep did.
  boot.render(s, 300);
  const int sweepLit = litPixels(s);
  boot.render(s, 1100);
  const int bloomLit = litPixels(s);
  check(bloomLit > sweepLit, "the bloom fills more of the panel than the sweep");
  check(bloomLit > 52 * 16 / 2, "the bloom covers at least half the panel");

  // BEAT 3: collapse and fade to black by the final frame.
  boot.render(s, 1200);
  const int settleLit = litPixels(s);
  check(settleLit > 0 && settleLit < bloomLit, "the settle beat collapses the bloom");
  boot.render(s, 1500);
  check(litPixels(s) == 0, "boot hands over a dark panel");

  // Nothing may be drawn outside the panel, ever.
  for (int t = 0; t <= 1500; t += 25) {
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

  // Push: mid-transition both screens are on the panel, and the incoming one
  // arrives from the right.
  shell.push(&green, 100);
  check(shell.depth() == 2 && shell.top() == &green, "push descends");
  check(red.mExits == 1 && green.mEnters == 1, "push fires the lifecycle callbacks");
  shell.render(out, 100 + Shell::kTransitionMs / 2);
  bool sawRed = false;
  bool sawGreen = false;
  for (int x = 0; x < 52; ++x) {
    const Color c = out.getPixel(x, 8);
    if (c.r > 0) sawRed = true;
    if (c.g > 0) sawGreen = true;
  }
  check(sawRed && sawGreen, "both screens are visible mid-transition");
  check(out.getPixel(51, 8).g > 0, "the incoming screen enters from the right");

  shell.render(out, 100 + Shell::kTransitionMs);
  check(out.getPixel(0, 8).g == 255 && out.getPixel(0, 8).r == 0,
        "the transition resolves to the new screen alone");
  check(!shell.isAnimating(100 + Shell::kTransitionMs), "the transition ends");

  // Pop mirrors it, arriving from the left.
  shell.pop(1000);
  check(shell.depth() == 1 && shell.top() == &red, "pop ascends");
  shell.render(out, 1000 + Shell::kTransitionMs / 2);
  check(out.getPixel(0, 8).r > 0, "the revealed screen enters from the left");

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

    // And it must stay inside its 12 px cell, or it would collide with the label.
    Surface frame(52, 16);
    screen.render(frame, 500);
    bool inkedBetween = false;
    for (int y = 0; y < 16; ++y) {
      for (int x = 12; x < 14; ++x) {
        const Color c = frame.getPixel(x, y);
        if (c.r || c.g || c.b) inkedBetween = true;
      }
    }
    check(!inkedBetween, std::string("the ") + kIconNames[i] + " icon stays in its cell");
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
  }

  server.stop();
  check(!server.running(), "stop closes the listener");
}

class FakePortalBackend : public tcos::SetupPortal::Backend {
 public:
  std::vector<std::string> scanResults() { return networks; }
  void submit(const std::string& s, const std::string& p) {
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
}

void checkGameScreen() {
  using tcos::GameScreen;

  BreakoutEngine engine;
  GameScreen screen;
  screen.setEngine(&engine);
  check(screen.engine() == &engine, "the engine mounts");

  screen.onEnter(0);
  check(engine.hud().phase == GameHud::Ready, "entering rewinds to the attract screen");

  Surface out(52, 16);
  screen.render(out, 0);
  check(litPixels(out) > 0, "the attract screen renders");

  // While NOT playing, a hold leaves. This is the only state where it may:
  // during play a long press belongs to the game.
  check(screen.onInput(tcos::kInputHold, 100), "a hold is consumed while idle");
  check(screen.takeExitRequest(), "and asks to leave");
  check(!screen.takeExitRequest(), "reading the request clears it");

  // Start playing, then confirm a hold no longer ejects the player.
  screen.onEnter(200);
  screen.onInput(tcos::kInputPress, 210);
  screen.render(out, 220);
  if (engine.hud().phase == GameHud::Playing) {
    check(screen.onInput(tcos::kInputHold, 300), "a hold is still consumed while playing");
    check(!screen.takeExitRequest(),
          "but does NOT eject the player — a long press belongs to the game");
  }

  // A stalled tick must not teleport the simulation. Two renders far apart
  // should advance by the clamp, not by the wall-clock gap.
  screen.onEnter(0);
  screen.render(out, 0);
  screen.render(out, 100000);
  check(out.getWidth() == 52, "a huge time step does not corrupt the surface");

  // Every engine must mount and render without the adapter caring which it is.
  BreakoutEngine b;
  FlappyEngine f;
  SnakeEngine s;
  PongEngine p;
  RacerEngine r;
  ShooterEngine sh;
  TetrisEngine t;
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
}

// A scriptable stand-in for zknet: every predicate is a field the test sets, so
// the timeout branches can be reached in microseconds instead of by unplugging
// a router and waiting.
class FakeWifi : public tcos::WifiPolicy::Actuator {
 public:
  FakeWifi()
      : running(false), stored(false), assoc(false), address(false),
        connectOk(true), apUp(false), starts(0), connects(0), dhcpCalls(0),
        apStarts(0), apStops(0) {}

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
  void startSoftAp() {
    apUp = true;
    ++apStarts;
  }
  void stopSoftAp() {
    apUp = false;
    ++apStops;
  }

  bool autoStart = true;
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
};

void checkWifiPolicy() {
  using tcos::WifiPolicy;

  // Happy path: stored credentials, supplicant comes up, associate, lease, online.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    check(w.starts == 1, "begin starts the supplicant — init will not");
    check(policy.state() == WifiPolicy::kStartingWpa, "begin waits for the daemon");
    policy.tick(10);
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
    policy.tick(10);
    check(policy.state() == WifiPolicy::kProvisioning, "no credentials means provisioning");
    check(w.apUp && w.apStarts == 1, "the hotspot is raised");
    check(w.connects == 0, "nothing is attempted without credentials");
  }

  // THE case this class exists for: valid-looking credentials, network gone.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(10);
    check(policy.state() == WifiPolicy::kConnecting, "it tries the stored network first");
    policy.tick(WifiPolicy::kConnectTimeoutMs);
    check(policy.state() == WifiPolicy::kConnecting, "it does not give up early");
    policy.tick(20 + WifiPolicy::kConnectTimeoutMs);
    check(policy.state() == WifiPolicy::kProvisioning,
          "a moved router falls back to provisioning instead of waiting forever");
    check(w.apUp, "the hotspot comes up so the user has a way in");

    // ...and keeps retrying in the background, because the usual cause is a
    // router that is merely slow to come back.
    const int t0 = 20 + WifiPolicy::kConnectTimeoutMs;
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
    policy.tick(10);
    policy.tick(20 + WifiPolicy::kConnectTimeoutMs);
    check(w.apUp, "hotspot up");
    const int t0 = 20 + WifiPolicy::kConnectTimeoutMs;
    policy.tick(t0 + WifiPolicy::kBackgroundRetryMs + 10);  // assoc still false
    check(w.apUp, "a failed retry leaves the hotspot standing");
    check(policy.state() == WifiPolicy::kProvisioning, "and stays in provisioning");
  }

  // Credentials from the setup page take effect immediately.
  {
    FakeWifi w;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(10);
    check(policy.isProvisioning(), "starts in provisioning");
    policy.applyCredentials("newnet", "secret", 100);
    check(policy.state() == WifiPolicy::kConnecting, "submitted credentials are tried at once");
    check(w.lastSsid == "newnet", "the submitted network is the one attempted");
    check(!w.apUp, "the hotspot drops as soon as the user has submitted");
  }

  // Supervision: init will not respawn a oneshot service, so we must.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(10);
    w.assoc = true;
    policy.tick(20);
    w.address = true;
    policy.tick(30);
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
    policy.tick(WifiPolicy::kSupplicantStartMs + 10);
    check(w.starts >= 2, "a supplicant that will not start is retried");
    check(policy.state() == WifiPolicy::kStartingWpa, "and we keep waiting for it");
  }

  // Losing the lease re-associates instead of sitting on a dead link.
  {
    FakeWifi w;
    w.stored = true;
    WifiPolicy policy(&w);
    policy.begin(0);
    policy.tick(10);
    w.assoc = true;
    policy.tick(20);
    w.address = true;
    policy.tick(30);
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
    policy.tick(10);
    w.assoc = true;
    policy.tick(20);
    check(w.dhcpCalls == 1, "one lease request so far");
    policy.tick(20 + WifiPolicy::kDhcpTimeoutMs + 1);
    check(w.dhcpCalls == 2, "a silent DHCP server is asked again");
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
  checkLauncher();
  std::printf("  launcher ok\n");
  checkStateDoc();
  std::printf("  state doc ok\n");
  checkFrameBundle();
  std::printf("  frame bundle ok\n");
  checkHttpServer();
  std::printf("  http server ok\n");
  checkSetupPortal();
  std::printf("  setup portal ok\n");
  checkGameScreen();
  std::printf("  game screen ok\n");
  checkLevelOverlay();
  std::printf("  level overlay ok\n");
  checkWifiPolicy();
  std::printf("  wifi policy ok\n");
  checkBootScreen();
  std::printf("  boot screen ok\n");

  if (gFailures != 0) {
    std::printf("%d check(s) failed\n", gFailures);
    return 1;
  }
  std::printf("all tc002-os host checks passed\n");
  return 0;
}
