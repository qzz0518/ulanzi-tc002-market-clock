#ifndef UI_BOOTSCREEN_H_
#define UI_BOOTSCREEN_H_

#include "ui/Screen.h"

namespace tcos {

/**
 * The first thing the panel shows after zkswe hands control to us.
 *
 * Six beats, 2460 ms total, all procedural — no glyphs, no assets, so this
 * screen carries zero .rodata and works before the font tables exist. The ZOS
 * wordmark is constructed from strokes (see ui/ZosLogo.h) rather than read from
 * a font table, for the same reason.
 *
 *      0.. 240 ms  SPARK      a single ignition point flares at the centre.
 *    240.. 680 ms  SHOCKWAVE  it throws a ring outward to both edges.
 *    680..1540 ms  TRACE      the wordmark is drawn stroke by stroke, in the
 *                             order a hand would draw it.
 *   1540..1720 ms  FLASH      the finished mark blows out to white and falls back.
 *   1720..2180 ms  HOLD       it sits lit while a specular sheen crosses it.
 *   2180..2460 ms  CRT-OFF    the panel collapses to a line and winks out, so the
 *                             launcher cuts in on a quiet panel.
 *
 * Deterministic in (nowMs - startMs), which is what lets the host self-check
 * assert exact pixels at chosen instants. Every phase boundary above is a named
 * constant in the .cpp and is asserted there — if you change one, the check
 * fails rather than this comment quietly going stale, which is exactly what it
 * had done before.
 */
class BootScreen : public Screen {
 public:
  BootScreen();

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool isAnimating(int nowMs) const;

  // True once the last beat has played out; the Shell uses this to advance.
  bool isDone(int nowMs) const;

  static int durationMs() { return 2460; }

 private:
  int mStartMs;
};

}  // namespace tcos

#endif  // UI_BOOTSCREEN_H_
