#ifndef CORE_EASE_H_
#define CORE_EASE_H_

namespace tcos {
namespace ease {

// Everything here is header-only, allocation-free and float-based. A full-panel
// procedural frame is 832 pixels; on a Cortex-A7 that is microseconds, so the
// animation budget is spent on maths rather than on blitting stored assets we
// do not have the RAM to hold.

inline float clamp01(float t) {
  return t < 0.0f ? 0.0f : (t > 1.0f ? 1.0f : t);
}

// Normalised progress of `nowMs` through [startMs, startMs + durationMs].
inline float progress(int nowMs, int startMs, int durationMs) {
  if (durationMs <= 0) return 1.0f;
  return clamp01(static_cast<float>(nowMs - startMs) / static_cast<float>(durationMs));
}

inline float linear(float t) { return clamp01(t); }

inline float inQuad(float t) {
  t = clamp01(t);
  return t * t;
}

inline float outQuad(float t) {
  t = clamp01(t);
  return 1.0f - (1.0f - t) * (1.0f - t);
}

inline float inOutQuad(float t) {
  t = clamp01(t);
  return t < 0.5f ? 2.0f * t * t : 1.0f - 2.0f * (1.0f - t) * (1.0f - t);
}

inline float outCubic(float t) {
  t = clamp01(t);
  const float inv = 1.0f - t;
  return 1.0f - inv * inv * inv;
}

inline float inOutCubic(float t) {
  t = clamp01(t);
  if (t < 0.5f) return 4.0f * t * t * t;
  const float inv = -2.0f * t + 2.0f;
  return 1.0f - inv * inv * inv / 2.0f;
}

// Overshoots past 1 and settles back — the detent feel for knob-driven moves.
inline float outBack(float t) {
  t = clamp01(t);
  const float c1 = 1.70158f;
  const float c3 = c1 + 1.0f;
  const float inv = t - 1.0f;
  return 1.0f + c3 * inv * inv * inv + c1 * inv * inv;
}

inline float lerp(float a, float b, float t) { return a + (b - a) * t; }

}  // namespace ease
}  // namespace tcos

#endif  // CORE_EASE_H_
