#include "pages/SplashPage.h"

#include <math.h>
#include <vector>
#include "utils/Surface.h"
#include "visual/Palette.h"
#include "visual/Spectrum.h"
#include "visual/Icons.h"
#include "visual/LatinFont.h"

using namespace lyricsvisual;

// Boot animation, ~6s in five scenes (40ms tick):
//     0 -  900  CRT power-on: a scanline stretches from the center and blooms
//   900 - 2600  "PIXEL" drops in letter by letter and bounces, console style
//  2600 - 4200  the wordmark swaps to "MUSIC", a shine sweeps across it
//  4200 - 5400  the spectrum rises around the wordmark, the note icon blooms
//  5400 - 6000  fade to black, hand off to the lyrics page
namespace {

const uint32_t kDurationMs = 6000;
const uint32_t kCrtEnd = 900;
const uint32_t kDropEnd = 2600;
const uint32_t kSwapEnd = 4200;
const uint32_t kRiseEnd = 5400;

float clamp01(float v) { return v < 0.f ? 0.f : (v > 1.f ? 1.f : v); }

// 6x12 Latin glyph at (x, y), intensity 0-255. Clips to the panel.
void drawGlyph(Surface& s, char ch, int x, int y, const Color& color, int inten) {
	if (inten <= 0) return;
	const LatinGlyph* g = latinGlyph((uint32_t)(unsigned char)ch);
	if (!g) return;
	Color c = scaled(color, inten);
	for (int row = 0; row < 12; ++row) {
		int py = y + row;
		if (py < 0 || py >= 16) continue;
		for (int col = 0; col < 6; ++col)
			if (g->rows[row] & (1 << (5 - col))) {
				int px = x + col;
				if (px >= 0 && px < 52) s.setPixel(px, py, c);
			}
	}
}

}  // namespace

SplashPage::SplashPage(const std::string& name) : PageBase(name), mProgress(0.0f), mElapsedMs(0) {}
SplashPage::~SplashPage() {}

void SplashPage::onEnter() { mProgress = 0.0f; mElapsedMs = 0; }
void SplashPage::onExit() {}

void SplashPage::tick() {
	mElapsedMs += getTickIntervalMs();
	mProgress = mElapsedMs >= kDurationMs ? 1.0f : float(mElapsedMs) / kDurationMs;
}

void SplashPage::draw() {
	Surface s(52, 16, Color(0, 0, 0));
	const Palette& pal = paletteFor(SKIN_SIGNAL);
	const uint32_t t = mElapsedMs;

	if (t < kCrtEnd) {
		// Scene 1 — CRT power-on.
		float p = t / (float)kCrtEnd;
		if (p < 0.62f) {
			// A bright scanline stretches from the center of the panel.
			float grow = p / 0.62f;
			int half = 1 + int(grow * 25.f);
			for (int dx = -half; dx <= half; ++dx) {
				int x = 26 + dx;
				if (x < 0 || x >= 52) continue;
				float edge = 1.f - (float)(dx < 0 ? -dx : dx) / (float)half;
				int white = int(90.f + 165.f * edge);
				s.setPixel(x, 7, Color(white, white, white));
				s.setPixel(x, 8, scaled(pal.primary, int(edge * 200.f)));
			}
		} else {
			// The line blooms vertically, then dies down.
			float q = (p - 0.62f) / 0.38f;
			int spread = 1 + int(q * 8.f);
			float fade = 1.f - q;
			for (int y = 7 - spread; y <= 8 + spread; ++y) {
				if (y < 0 || y >= 16) continue;
				int dy = y < 7 ? 7 - y : (y > 8 ? y - 8 : 0);
				float centre = 1.f - (float)dy / (float)(spread + 1);
				for (int x = 0; x < 52; ++x) {
					float mid = 1.f - (float)(x < 26 ? 26 - x : x - 26) / 26.f;
					int inten = int(centre * fade * (70.f + 185.f * mid));
					if (inten > 10) s.setPixel(x, y, scaled(pal.primary, inten));
				}
			}
		}
	} else if (t < kDropEnd) {
		// Scene 2 — "PIXEL" drops in letter by letter and bounces.
		const char* word = "PIXEL";
		const int x0 = 11, yTarget = 2;
		for (int i = 0; i < 5; ++i) {
			uint32_t start = kCrtEnd + (uint32_t)i * 220u;
			if (t < start) continue;
			float lp = clamp01((t - start) / 480.f);
			int y;
			if (lp < 0.6f) {
				float f = lp / 0.6f;
				y = -12 + int(f * f * (float)(yTarget + 15));  // accelerate past the target
			} else if (lp < 0.8f) {
				float f = (lp - 0.6f) / 0.2f;
				y = yTarget + 3 - int(f * 3.f);                // bounce back up
			} else {
				y = yTarget;
			}
			drawGlyph(s, word[i], x0 + i * 6, y, pal.primary, 235);
		}
		// A floor flash once the last letter has landed.
		if (t > kDropEnd - 220) {
			int fade = int((1.f - (t - (kDropEnd - 220)) / 220.f) * 130.f);
			for (int x = 10; x < 42; ++x) s.setPixel(x, 15, scaled(pal.secondary, fade));
		}
	} else if (t < kSwapEnd) {
		// Scene 3 — the wordmark swaps to "MUSIC", then a shine sweeps across.
		float p = (t - kDropEnd) / (float)(kSwapEnd - kDropEnd);
		const int x0 = 11;
		if (p < 0.25f) {
			int off = int((p / 0.25f) * 15.f);
			for (int i = 0; i < 5; ++i) drawGlyph(s, "PIXEL"[i], x0 + i * 6, 2 - off, pal.primary, 210);
			for (int i = 0; i < 5; ++i) drawGlyph(s, "MUSIC"[i], x0 + i * 6, 17 - off, pal.primary, 255);
		} else {
			for (int i = 0; i < 5; ++i) drawGlyph(s, "MUSIC"[i], x0 + i * 6, 2, pal.primary, 255);
			// A slightly diagonal shine sweeps over the wordmark.
			float q = (p - 0.25f) / 0.75f;
			int sweep = int(q * 66.f) - 8;
			for (int y = 0; y < 16; ++y) {
				int x = sweep + (15 - y) / 3;
				if (x >= 0 && x < 52) s.setPixel(x, y, Color(235, 235, 235));
				if (x + 1 >= 0 && x + 1 < 52) s.setPixel(x + 1, y, scaled(pal.primary, 120));
			}
		}
	} else {
		// Scenes 4+5 — spectrum + note bloom around the wordmark, then fade out.
		int dim = 255;
		if (t > kRiseEnd) dim = int((1.f - clamp01((t - kRiseEnd) / (float)(kDurationMs - kRiseEnd))) * 255.f);
		float p = clamp01((t - kSwapEnd) / (float)(kRiseEnd - kSwapEnd));
		for (int i = 0; i < 5; ++i) drawGlyph(s, "MUSIC"[i], 11 + i * 6, 1, pal.primary, dim);
		const int energy = int(p * 255.f);
		for (int b = 0; b < 17; ++b) {
			const int x = 1 + b * 3;
			const int lv = spectrumBar(b, 17, mElapsedMs, 3, energy);
			for (int i = 0; i < lv; ++i) {
				const Color& c = (i == lv - 1) ? pal.primary : pal.secondary;
				s.setPixel(x, 15 - i, scaled(c, dim));
				s.setPixel(x + 1, 15 - i, scaled(c, dim));
			}
		}
		float breathe = 0.55f + 0.45f * sinf(mElapsedMs * 0.011f);
		drawNote(s, 3, 2, scaled(pal.primary, int(breathe * dim)));
		if (p < 1.f) {
			int sweepX = int(p * 55.f) - 1;
			for (int y = 0; y < 16; ++y)
				if (sweepX >= 0 && sweepX < 52) s.setPixel(sweepX, y, scaled(pal.primary, (110 * dim) / 255));
		}
	}

	std::vector<uint8_t> data;
	s.extractRGB(data);
	sendLedData(data);
}
