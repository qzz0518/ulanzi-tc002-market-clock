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
#include "core/Surface.h"
#include "ui/BootScreen.h"

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

}  // namespace

int main() {
  std::printf("tc002-os host self-check\n");
  checkEase();
  std::printf("  ease ok\n");
  checkSurface();
  std::printf("  surface ok\n");
  checkBootScreen();
  std::printf("  boot screen ok\n");

  if (gFailures != 0) {
    std::printf("%d check(s) failed\n", gFailures);
    return 1;
  }
  std::printf("all tc002-os host checks passed\n");
  return 0;
}
