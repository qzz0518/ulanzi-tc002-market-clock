#include "pages/SplashPage.h"

#include <vector>
#include "utils/Surface.h"
#include "visual/Palette.h"
#include "visual/LatinFont.h"
#include "visual/PixelFont.h"
#include "managers/SfxManager.h"

using namespace lyricsvisual;

// Timeline (3000ms total, 40ms tick):
//     0 -  950  "PIXEL" sweeps in left-to-right behind a shine column, fades
//   950 - 1950  "ARCADE" does the same pass
//  1950 - 3000  the four 8x8 game icons pop on one by one
// A progress bar fills along the bottom row for the whole run.
namespace {

const uint32_t kDurationMs = 3000;
const uint32_t kPixelEnd = 950;
const uint32_t kArcadeEnd = 1950;

// 6x12 Latin glyph at (x, y), intensity 0-255. Clips to the panel. Pure ASCII,
// so latinGlyph((unsigned char)ch) is enough — no utf8 walk needed.
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

// One wordmark pass: letters appear behind a shine column that sweeps across,
// then the whole word fades out over the last 100ms of the scene.
void drawWordSweep(Surface& s, const char* word, int len, int x0,
                   uint32_t local, uint32_t sceneMs, const Palette& pal) {
	const uint32_t sweepMs = (sceneMs * 3) / 5;
	int sweepX = int((float)local / (float)sweepMs * 62.f) - 5;
	int inten = 235;
	if (local > sceneMs - 100) inten = int(235.f * (sceneMs - local) / 100.f);
	for (int i = 0; i < len; ++i) {
		int gx = x0 + i * 6;
		if (gx <= sweepX) drawGlyph(s, word[i], gx, 2, pal.primary, inten);
	}
	// The shine itself: a bright, slightly diagonal double column.
	if (local <= sweepMs) {
		for (int y = 0; y < 15; ++y) {
			int x = sweepX + (15 - y) / 4;
			if (x >= 0 && x < 52) s.setPixel(x, y, Color(235, 235, 235));
			if (x + 1 >= 0 && x + 1 < 52) s.setPixel(x + 1, y, scaled(pal.secondary, 140));
		}
	}
}

// 8x8 game icons (bit7 = leftmost column): breakout, flappy, snake, pong.
const uint8_t kIcons[4][8] = {
	{ 0xFF, 0xFF, 0x00, 0x10, 0x00, 0x00, 0x3C, 0x00 },   // bricks, ball, paddle
	{ 0x00, 0x38, 0x7C, 0xDE, 0xFC, 0x78, 0x20, 0x00 },   // bird
	{ 0x00, 0xF8, 0x08, 0xF8, 0x80, 0xFE, 0x02, 0x00 },   // serpentine
	{ 0x00, 0x80, 0x81, 0x91, 0x81, 0x01, 0x00, 0x00 },   // two paddles + ball
};

void drawIcon8(Surface& s, int idx, int x0, int y0, const Color& c) {
	for (int row = 0; row < 8; ++row)
		for (int col = 0; col < 8; ++col)
			if (kIcons[idx][row] & (1 << (7 - col))) s.setPixel(x0 + col, y0 + row, c);
}

}  // namespace

SplashPage::SplashPage(const std::string& name)
	: PageBase(name), mElapsedMs(0), mSkipped(false) {}
SplashPage::~SplashPage() {}

void SplashPage::onEnter() {
	mElapsedMs = 0;
	mSkipped = false;
	SfxManager::getInstance().play(SfxManager::SFX_BOOT);
}
void SplashPage::onExit() {}

bool SplashPage::onKeyEvent(int keyCode, int keyStatus) {
	// Any button press skips the splash; knob detents don't (they have no
	// press edge and stray rotation shouldn't cut the boot short).
	if (keyStatus == 1 &&
	    (keyCode == E_KEYCODE_KNOB_BUTTON || keyCode == E_KEYCODE_LEFT_BUTTON ||
	     keyCode == E_KEYCODE_MIDDLE_BUTTON || keyCode == E_KEYCODE_RIGHT_BUTTON)) {
		mSkipped = true;
	}
	return true;
}

void SplashPage::tick() {
	mElapsedMs += getTickIntervalMs();
}

bool SplashPage::isDone() const {
	return mSkipped || mElapsedMs >= kDurationMs;
}

void SplashPage::draw() {
	Surface s(52, 16, Color(0, 0, 0));
	const Palette& pal = paletteFor(SKIN_ARCADE);
	const uint32_t t = mElapsedMs;

	if (t < kPixelEnd) {
		drawWordSweep(s, "PIXEL", 5, 11, t, kPixelEnd, pal);
	} else if (t < kArcadeEnd) {
		drawWordSweep(s, "ARCADE", 6, 8, t - kPixelEnd, kArcadeEnd - kPixelEnd, pal);
	} else {
		// Four representative cartridges light up one by one (decor, not the
		// full catalogue); each pops in white before settling to arcade red.
		const int xs[4] = { 4, 16, 28, 40 };
		for (int i = 0; i < 4; ++i) {
			uint32_t start = kArcadeEnd + (uint32_t)i * 210u;
			if (t < start) continue;
			uint32_t age = t - start;
			Color c = age < 90 ? Color(235, 235, 235)
			                   : (i % 2 ? pal.secondary : pal.primary);
			drawIcon8(s, i, xs[i], 2, c);
		}
		// Once the cartridges are in, spell out the actual lineup size.
		if (t > kArcadeEnd + 900u) {
			const char* lineup = "7 GAMES";
			drawText(s, (52 - textWidth(lineup)) / 2, 10, lineup, Color(255, 255, 255));
		}
	}

	// Bottom progress bar: dim track with a bright head pixel.
	int w = int((float)(t > kDurationMs ? kDurationMs : t) / kDurationMs * 52.f);
	for (int x = 0; x < w; ++x) s.setPixel(x, 15, pal.context);
	if (w > 0 && w <= 52) s.setPixel(w - 1, 15, pal.secondary);

	std::vector<uint8_t> data;
	s.extractRGB(data);
	sendLedData(data);
}
