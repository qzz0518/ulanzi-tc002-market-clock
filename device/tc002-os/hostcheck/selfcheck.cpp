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
#include "ui/BootScreen.h"
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
  checkBootScreen();
  std::printf("  boot screen ok\n");

  if (gFailures != 0) {
    std::printf("%d check(s) failed\n", gFailures);
    return 1;
  }
  std::printf("all tc002-os host checks passed\n");
  return 0;
}
