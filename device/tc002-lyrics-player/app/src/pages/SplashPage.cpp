#include "pages/SplashPage.h"

#include <math.h>
#include <vector>
#include "utils/Surface.h"
#include "visual/Palette.h"
#include "visual/Spectrum.h"
#include "visual/Icons.h"

using namespace lyricsvisual;

SplashPage::SplashPage(const std::string& name) : PageBase(name), mProgress(0.0f), mElapsedMs(0) {}
SplashPage::~SplashPage() {}

void SplashPage::onEnter() { mProgress = 0.0f; mElapsedMs = 0; }
void SplashPage::onExit() {}

void SplashPage::tick() {
	mElapsedMs += getTickIntervalMs();
	const uint32_t kDurationMs = 2400;
	mProgress = mElapsedMs >= kDurationMs ? 1.0f : float(mElapsedMs) / kDurationMs;
}

void SplashPage::draw() {
	Surface s(52, 16, Color(0, 0, 0));
	const Palette& pal = paletteFor(SKIN_SIGNAL);
	const float p = mProgress;

	// Full-height spectrum rises + pulses across the whole panel.
	const int energy = int((p < 0.55f ? p / 0.55f : 1.0f) * 255);
	const int barCount = 17;
	for (int b = 0; b < barCount; ++b) {
		const int x = 1 + b * 3;
		const int lv = spectrumBar(b, barCount, mElapsedMs, 7, energy);
		for (int i = 0; i < lv; ++i) {
			const Color& c = (i == lv - 1) ? pal.primary : pal.secondary;
			s.setPixel(x, 15 - i, c);
			s.setPixel(x + 1, 15 - i, c);
		}
	}

	// A bright vertical light-bar sweeps left→right once during the intro.
	const int sweepX = int(p * 55.0f) - 1;
	for (int y = 0; y < 16; ++y) {
		if (sweepX >= 0 && sweepX < 52) s.setPixel(sweepX, y, scaled(pal.primary, 130));
		if (sweepX + 1 >= 0 && sweepX + 1 < 52) s.setPixel(sweepX + 1, y, scaled(pal.secondary, 75));
	}

	// Note icon breathes in the upper-left once the sweep has passed it.
	if (p > 0.28f) {
		const float breathe = 0.55f + 0.45f * sinf(mElapsedMs * 0.011f);
		const int ni = int(fminf(1.0f, (p - 0.28f) * 4.0f) * breathe * 255);
		drawNote(s, 4, 1, scaled(pal.primary, ni));
	}

	std::vector<uint8_t> data;
	s.extractRGB(data);
	sendLedData(data);
}
