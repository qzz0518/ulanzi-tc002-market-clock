#ifndef CORE_TRANSITIONS_H_
#define CORE_TRANSITIONS_H_

#include "core/Surface.h"

namespace tcos {
namespace transition {

/**
 * The catalogue of screen-to-screen motions.
 *
 * Every entry here is a pure compositing operator over two finished rasters:
 * `from` is what was on the panel, `to` is what is arriving, and `t` walks 0..1.
 * It owns no clock, no state and no buffers, which is what lets the host
 * self-check assert exact pixels at chosen instants rather than only "something
 * moved" — the same property BootScreen is built on.
 *
 * That purity buys the other half of the contract for free: ascending is the
 * descent run backwards. Shell renders a pop as compose(from, to, 1 - t) with
 * the two rasters still in their push-time roles, so push and pop are literally
 * one function evaluated in two directions and cannot drift apart.
 *
 * The motifs are lifted from the two firmwares this OS replaces, because they
 * were the good part of those splash screens and nothing else in ZOS uses them:
 *
 *   kCrt        the music firmware's CRT power-on (SplashPage scene 1)
 *   kEqualiser  its spectrum rise (scene 4)
 *   kDrop       its console-style drop-and-bounce (scene 2)
 *   kCartridge  the arcade firmware's shine-reveal sweep + menu corner brackets
 *   kDive       the depth cue ZOS already had, moved onto the vertical axis
 *
 * Durations differ per style on purpose: a beat that has three phases needs more
 * milliseconds than a straight wipe, and pinning them all to one number is what
 * made every destination feel the same.
 */
enum Style {
  kDive = 0,   // 240 ms — generic descend
  kCrt,        // 320 ms — 轮播 / channels
  kEqualiser,  // 300 ms — 音乐 / music
  kCartridge,  // 280 ms — 游戏 / games
  kDrop,       // 260 ms — 设置 / settings
  kFade,       // 220 ms — handoff, no direction implied
  kStyleCount,
};

/** How long this style runs. Shell reads it; nothing else should hard-code it. */
int durationMs(Style style);

/**
 * Composes `from` -> `to` at normalised progress `t` into `out`.
 *
 * Clears `out` itself, and guarantees t <= 0 is `from` alone and t >= 1 is `to`
 * alone — a transition that leaks a pixel of the wrong screen at either end
 * reads as a flash on a panel this small.
 */
void compose(Surface& out, const Surface& from, const Surface& to, Style style, float t);

}  // namespace transition
}  // namespace tcos

#endif  // CORE_TRANSITIONS_H_
