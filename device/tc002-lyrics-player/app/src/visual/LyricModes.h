#ifndef VISUAL_LYRICMODES_H_
#define VISUAL_LYRICMODES_H_

#include <math.h>
#include <stdint.h>

// C++ port of web/src/components/music/pixel-lyric-modes.ts. Kept numerically
// identical so the device and the web preview animate the same way. All the
// tunables (0.14 enter, 17 bars, 125ms slot, the hash constants) mirror the TS.
namespace lyricsvisual {

inline float lm_unit(float v) { return v < 0.f ? 0.f : (v > 1.f ? 1.f : v); }
inline float lm_fract(float v) { return v - floorf(v); }

enum CascadePhase { CASCADE_ENTER = 0, CASCADE_HOLD = 1, CASCADE_EXIT = 2 };

static const int SKYLINE_BARS = 17;

// Spotlight locks the sung pixel column to screen center (x=26); returns the
// screen x of the bitmap's left edge.
inline int spotlightOffsetPx(int textWidth, float lyricProgress) {
	int w = textWidth > 0 ? textWidth : 0;
	return 26 - (int)lroundf(lm_unit(lyricProgress) * (float)w);
}

// Index of the glyph span being sung at a bitmap pixel position (spanStarts must
// be ascending; a pixel in a gap keeps the previous glyph focused).
inline int spanIndexAtPx(const int* spanStarts, int spanCount, int px) {
	if (spanCount <= 0) return -1;
	int index = 0;
	for (int i = 0; i < spanCount; ++i) {
		if (spanStarts[i] > px) break;
		index = i;
	}
	return index;
}

// Cascade's vertical band Y: rises from y=16 into y=2, holds, lifts out the top.
inline int cascadeBandY(float lyricProgress, bool reducedMotion) {
	float p = lm_unit(lyricProgress);
	if (reducedMotion || p <= 0.f) return 2;
	const float ENTER_END = 0.14f, EXIT_START = 0.86f;
	if (p < ENTER_END) {
		float t = p / ENTER_END;
		float eased = 1.f - powf(1.f - t, 3.f);
		return (int)lroundf(16.f - 14.f * eased);
	}
	if (p > EXIT_START) {
		float t = (p - EXIT_START) / (1.f - EXIT_START);
		return (int)lroundf(2.f - 18.f * t * t * t);
	}
	return 2;
}

inline int cascadePhase(float lyricProgress, bool reducedMotion) {
	float p = lm_unit(lyricProgress);
	if (reducedMotion || p <= 0.f) return CASCADE_HOLD;
	if (p < 0.14f) return CASCADE_ENTER;
	if (p > 0.86f) return CASCADE_EXIT;
	return CASCADE_HOLD;
}

// Beat impulse (0..1): snaps to 1 as each glyph starts, decays until the next;
// falls back to a 120 BPM pulse without lyric timing.
inline float beatKick(bool playing, bool hasLyricTiming, float lyricProgress,
                      int glyphCount, float timeMs) {
	if (!playing) return 0.f;
	if (hasLyricTiming && glyphCount > 0) {
		float f = 1.f - lm_fract(lm_unit(lyricProgress) * (float)glyphCount);
		return f * f;
	}
	float f = 1.f - lm_fract(timeMs / 500.f);
	return f * f * 0.7f;
}

// Deterministic pseudo-spectrum level for one skyline bar, quantized to 8 fps
// slots. Matches the TS hash exactly so bars look identical on both ends.
inline int skylineBarLevel(int bar, float timeMs, bool playing, float kick, int maxLevel) {
	const float SLOT_MS = 125.f;
	float tms = timeMs < 0.f ? 0.f : timeMs;
	float slot = floorf(tms / SLOT_MS);
	float t = slot * (SLOT_MS / 1000.f);
	float noise = lm_fract(sinf((bar + 1) * 127.1f + slot * 311.7f) * 43758.5453f);
	float sway = 0.5f + 0.5f * sinf(t * 2.4f + bar * 0.9f);
	float swell = 0.5f + 0.5f * sinf(t * 0.8f + bar * 0.35f + 2.1f);
	float center = (SKYLINE_BARS - 1) / 2.f;
	float stage = 1.f - (fabsf(bar - center) / center) * 0.4f;
	float energy = playing ? 0.55f + 0.45f * lm_unit(kick) : 0.18f;
	float raw = (0.25f + 0.55f * sway * swell + 0.45f * noise) * stage * energy;
	if (raw > 1.f) raw = 1.f;
	int m = maxLevel > 0 ? maxLevel : 0;
	return (int)lroundf(raw * (float)m);
}

}  // namespace lyricsvisual

#endif  // VISUAL_LYRICMODES_H_
