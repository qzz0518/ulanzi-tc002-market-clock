#include "pages/VolumePage.h"

#include <vector>
#include "utils/Surface.h"
#include "visual/Palette.h"
#include "visual/PixelFont.h"

using namespace lyricsvisual;

VolumePage::VolumePage(const std::string& name)
	: PageBase(name), mVolume(4), mSkin(SKIN_SIGNAL) {}
VolumePage::~VolumePage() {}

void VolumePage::onEnter() {}
void VolumePage::onExit() {}

void VolumePage::draw() {
	Surface s(52, 16, Color(0, 0, 0));
	const Palette& pal = paletteFor(mSkin);

	// Boba cup on the left. Straw, lid, straight walls, base.
	const int L = 15, R = 27, TOP = 3, BOT = 14;
	s.setPixel(26, 0, pal.secondary);
	s.setPixel(26, 1, pal.secondary);
	s.setPixel(25, 2, pal.secondary);
	for (int x = L - 1; x <= R + 1; ++x) s.setPixel(x, TOP, pal.primary);
	for (int y = TOP + 1; y <= BOT; ++y) { s.setPixel(L, y, pal.primary); s.setPixel(R, y, pal.primary); }
	for (int x = L; x <= R; ++x) s.setPixel(x, BOT, pal.primary);

	// Liquid fill: height maps to volume (the "drink size").
	const int innerTop = TOP + 1, innerBot = BOT - 1;
	const int maxH = innerBot - innerTop;          // 9
	const int fillH = (mVolume * maxH) / 6;
	for (int y = innerBot; y > innerBot - fillH; --y)
		for (int x = L + 1; x < R; ++x) s.setPixel(x, y, pal.secondary);

	// Pearls settle at the bottom.
	s.setPixel(17, innerBot, pal.context);
	s.setPixel(20, innerBot, pal.context);
	s.setPixel(23, innerBot, pal.context);

	// Label to the right: MUTE, or "VOL" over the level digit.
	if (mVolume <= 0) {
		drawText(s, 32, 6, "MUTE", pal.secondary);
	} else {
		drawText(s, 33, 2, "VOL", scaled(pal.primary, 170));
		const char digit[2] = { char('0' + mVolume), 0 };
		drawText(s, 40, 9, digit, pal.primary);
		// small level ticks under the word to echo the fill
		for (int i = 0; i < mVolume; ++i) s.setPixel(33 + i * 2, 14, pal.secondary);
	}

	std::vector<uint8_t> data;
	s.extractRGB(data);
	sendLedData(data);
}
