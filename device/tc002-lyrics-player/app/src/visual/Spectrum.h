#ifndef VISUAL_SPECTRUM_H_
#define VISUAL_SPECTRUM_H_

#include <stdint.h>
#include <math.h>

// Deterministic pseudo-spectrum, mirroring the web preview's skyline bars so
// idle/playing motion matches. No audio FFT — a hash+sine model quantized to
// keep the LED refresh chunky. `energy` 0..255 scales activity (idle vs beat).
namespace lyricsvisual {

inline float fract(float v) { return v - floorf(v); }

inline int spectrumBar(int bar, int barCount, uint32_t timeMs, int maxLevel, int energy) {
	const int slot = int(timeMs / 125);              // ~8 fps quantization
	const float t = slot * 0.125f;
	const float noise = fract(sinf((bar + 1) * 127.1f + slot * 311.7f) * 43758.5453f);
	const float sway = 0.5f + 0.5f * sinf(t * 2.4f + bar * 0.9f);
	const float swell = 0.5f + 0.5f * sinf(t * 0.8f + bar * 0.35f + 2.1f);
	const float center = (barCount - 1) * 0.5f;
	const float stage = 1.0f - (center > 0 ? (fabsf(bar - center) / center) * 0.4f : 0.0f);
	float raw = (0.25f + 0.55f * sway * swell + 0.45f * noise) * stage;
	if (raw > 1.0f) raw = 1.0f;
	int level = int(raw * (energy / 255.0f) * maxLevel + 0.5f);
	if (level < 0) level = 0;
	if (level > maxLevel) level = maxLevel;
	return level;
}

}  // namespace lyricsvisual

#endif  // VISUAL_SPECTRUM_H_
