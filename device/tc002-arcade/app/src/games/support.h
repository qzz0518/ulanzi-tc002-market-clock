#ifndef GAMES_SUPPORT_H_
#define GAMES_SUPPORT_H_

#include <stdint.h>
#include "utils/Surface.h"
#include "visual/PixelFont.h"

// Small shared helpers for the game engines. Everything here is pure C++
// (no FlyThings headers) so the engines compile on the host for selfcheck.
namespace arcadegames {

const int kGameW = 52;
const int kGameH = 16;

inline double clampd(double v, double lo, double hi) {
	return v < lo ? lo : (v > hi ? hi : v);
}

inline int clampi(int v, int lo, int hi) {
	return v < lo ? lo : (v > hi ? hi : v);
}

inline void fillRect(Surface& s, int x, int y, int w, int h, const Color& c) {
	for (int yy = y; yy < y + h; ++yy)
		for (int xx = x; xx < x + w; ++xx)
			s.setPixel(xx, yy, c);  // setPixel clips out-of-bounds writes
}

// 3x5 text via the shared PixelFont; setPixel clips, matching the web
// drawText which skips off-screen pixels.
inline void drawText3x5(Surface& s, const char* text, int x, int y, const Color& c) {
	lyricsvisual::drawText(s, x, y, text, c);
}

inline int textWidth3x5(const char* text) {
	return lyricsvisual::textWidth(text);
}

inline void drawCenteredText3x5(Surface& s, const char* text, int y, const Color& c) {
	drawText3x5(s, text, (kGameW - textWidth3x5(text)) / 2, y, c);
}

// Deterministic replacement for the web engines' injectable `random()`:
// xorshift32 mapped to [0,1). Engines expose seedRandom() so the host
// selfcheck can pin layouts, mirroring the web tests' injected random.
struct GameRandom {
	uint32_t state;

	GameRandom() : state(0x9E3779B9u) {}

	void seed(uint32_t s) { state = s ? s : 1u; }

	// [0,1)
	double next() {
		uint32_t x = state;
		x ^= x << 13;
		x ^= x >> 17;
		x ^= x << 5;
		state = x;
		return (x >> 8) * (1.0 / 16777216.0);
	}

	// Uniform integer in [0,bound) — mirrors the web `pick()` helper.
	int pick(int bound) {
		if (bound <= 0) return 0;
		double r = clampd(next(), 0.0, 0.999999);
		int v = (int)(r * bound);
		return v > bound - 1 ? bound - 1 : v;
	}
};

}  // namespace arcadegames

#endif  // GAMES_SUPPORT_H_
