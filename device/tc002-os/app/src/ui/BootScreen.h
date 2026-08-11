#ifndef UI_BOOTSCREEN_H_
#define UI_BOOTSCREEN_H_

#include "ui/Screen.h"

namespace tcos {

/**
 * The first thing the panel shows after zkswe hands control to us.
 *
 * Three beats, 1500 ms total, all procedural — no glyphs, no assets, so this
 * screen carries zero .rodata and works before the font tables exist:
 *
 *   0.. 520 ms  SWEEP  a bright head runs left to right with a 7 px comet tail,
 *                      leaving a dim persistent trail behind it.
 *   520..1120 ms BLOOM  the trail blooms outward from the centre row as a
 *                      vertical wave, saturating into the accent colour.
 *   1120..1500 ms SETTLE the wave collapses to a single centred pulse bar and
 *                      dims, so the first real screen can cut in on a quiet panel.
 *
 * Deterministic in (nowMs - startMs), which is what lets the host self-check
 * assert exact pixels at chosen instants.
 */
class BootScreen : public Screen {
 public:
  BootScreen();

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool isAnimating(int nowMs) const;

  // True once the last beat has played out; the Shell uses this to advance.
  bool isDone(int nowMs) const;

  static int durationMs() { return 1500; }

 private:
  int mStartMs;
};

}  // namespace tcos

#endif  // UI_BOOTSCREEN_H_
