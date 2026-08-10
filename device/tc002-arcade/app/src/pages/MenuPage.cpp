#include "pages/MenuPage.h"

#include <vector>
#include "utils/Surface.h"
#include "visual/Palette.h"
#include "visual/PixelFont.h"
#include "managers/SfxManager.h"

using namespace lyricsvisual;

namespace {

const int kItemCount = 8;            // seven games + INFO
const int kInfoItem = kItemCount - 1;
const int kPitch = 16;               // px between cartridge centers
const int kCenterX = 20;             // selected icon's left edge
// Eased scroll: the tick after a move draws at 2/4 pitch, the next at 1/4,
// then the strip settles — two visible transitional frames.
const int kEaseFrames = 3;
const int kCaptionSwapTicks = 50;    // 1.5s at the 30ms tick
const int kStarPeriodTicks = 50;     // 1.5s twinkle phase

// 12x12 icons, one uint16 row each, bit11 = leftmost column. The bottom row
// (11) is deliberately empty so the caption line at y=11 never collides.
const uint16_t kIcons[kItemCount][12] = {
	// breakout: two brick courses, ball, paddle
	{ 0xF7B, 0xF7B, 0x000, 0xDEF, 0xDEF, 0x000, 0x080, 0x000, 0x000, 0x000, 0x3E0, 0x000 },
	// flappy: round bird with an eye and a beak
	{ 0x000, 0x1E0, 0x3F0, 0x6F8, 0x7FC, 0x7FE, 0x3FC, 0x1F8, 0x0F0, 0x000, 0x000, 0x000 },
	// snake: serpentine body ending in a fat head, food dot bottom-left
	{ 0x000, 0xFF8, 0x008, 0x008, 0xFF8, 0x800, 0x800, 0xFFE, 0x002, 0x006, 0x400, 0x000 },
	// pong: side paddles, dashed net, ball mid-flight
	{ 0x040, 0x000, 0xC00, 0xC40, 0xC18, 0xC18, 0xC43, 0x003, 0x003, 0x043, 0x003, 0x000 },
	// racer: top-down F1 car — nose, front wing, four wheels, rear wing
	{ 0x060, 0x3FC, 0x666, 0x666, 0x0F0, 0x0F0, 0x6F6, 0x6F6, 0x0F0, 0x3FC, 0x000, 0x000 },
	// shooter: spaceship — nose, widening hull, swept wings, exhaust flame
	{ 0x060, 0x0F0, 0x0F0, 0x1F8, 0x1F8, 0x6F6, 0x7FE, 0x76E, 0x264, 0x060, 0x000, 0x000 },
	// tetris: L tetromino, 3x3 cells with 1px seams
	{ 0x1C0, 0x1C0, 0x1C0, 0x000, 0x1C0, 0x1C0, 0x1C0, 0x000, 0x1DC, 0x1DC, 0x1DC, 0x000 },
	// info: dotted "i" in a rounded badge
	{ 0x3FC, 0x402, 0x861, 0x861, 0x801, 0x861, 0x861, 0x861, 0x861, 0x402, 0x3FC, 0x000 },
};

const char* kNames[kItemCount] = {
	"BREAKOUT", "FLAPPY", "SNAKE", "PONG", "RACER", "SHOOTER", "TETRIS", "INFO",
};

// Sparse background starfield: fixed positions in the icon band's margins
// (rows 0..9, clear of the x=18..33 selection frame), drawn first so the
// cartridges and text always paint over them. Muted tier only — texture,
// never content (bright text rule).
struct Star { int8_t x, y; };
const Star kStars[8] = {
	{ 2, 1 }, { 49, 1 }, { 1, 7 }, { 50, 8 }, { 6, 9 }, { 45, 3 }, { 14, 0 }, { 37, 9 },
};

void drawIcon12(Surface& s, int item, int x0, int y0, const Color& c) {
	for (int row = 0; row < 12; ++row)
		for (int col = 0; col < 12; ++col)
			if (kIcons[item][row] & (1 << (11 - col))) s.setPixel(x0 + col, y0 + row, c);
}

// Corner brackets around the selected cartridge (kept off the caption rows).
void drawBrackets(Surface& s, int x0, const Color& c) {
	const int l = x0 - 2, r = x0 + 13;
	s.setPixel(l, 0, c); s.setPixel(l + 1, 0, c); s.setPixel(l, 1, c);
	s.setPixel(r, 0, c); s.setPixel(r - 1, 0, c); s.setPixel(r, 1, c);
	s.setPixel(l, 9, c); s.setPixel(l, 10, c); s.setPixel(l + 1, 10, c);
	s.setPixel(r, 9, c); s.setPixel(r, 10, c); s.setPixel(r - 1, 10, c);
}

}  // namespace

MenuPage::MenuPage(const std::string& name)
	: PageBase(name), mSelected(0), mAction(-1), mShiftFrom(0), mEaseTick(kEaseFrames), mTicks(0) {}
MenuPage::~MenuPage() {}

void MenuPage::onEnter() {
	// Keep the selection across visits; only transient state resets.
	mAction = -1;
	mShiftFrom = 0;
	mEaseTick = kEaseFrames;
}
void MenuPage::onExit() {}

bool MenuPage::onKeyEvent(int keyCode, int keyStatus) {
	// Buttons act on the press edge; knob detents have no status.
	if (keyStatus != 1 && keyCode != E_KEYCODE_CLOCKWISE && keyCode != E_KEYCODE_ANTI_CLOCKWISE) {
		return true;
	}
	switch (keyCode) {
	case E_KEYCODE_CLOCKWISE:
	case E_KEYCODE_ANTI_CLOCKWISE: {
		int dir = (keyCode == E_KEYCODE_CLOCKWISE) ? 1 : -1;
		// Current eased offset carries over so fast spins stay smooth.
		int carry = 0;
		if (mEaseTick < kEaseFrames) {
			carry = mShiftFrom * (kEaseFrames - mEaseTick) / (kEaseFrames + 1);
		}
		mSelected = (mSelected + dir + kItemCount) % kItemCount;
		mShiftFrom = dir * kPitch + carry;
		if (mShiftFrom > 2 * kPitch) mShiftFrom = 2 * kPitch;
		if (mShiftFrom < -2 * kPitch) mShiftFrom = -2 * kPitch;
		mEaseTick = 0;
		SfxManager::getInstance().play(SfxManager::SFX_TICK);
		break;
	}
	case E_KEYCODE_KNOB_BUTTON:
	case E_KEYCODE_MIDDLE_BUTTON:
		mAction = mSelected;            // 0..6 game, 7 INFO
		break;
	case E_KEYCODE_LEFT_BUTTON:
	case E_KEYCODE_RIGHT_BUTTON:
		mAction = kInfoItem;            // info shortcut
		break;
	default:
		break;
	}
	return true;
}

void MenuPage::tick() {
	++mTicks;
	if (mEaseTick < kEaseFrames) ++mEaseTick;
}

int MenuPage::takeAction() {
	int a = mAction;
	mAction = -1;
	return a;
}

void MenuPage::draw() {
	Surface s(52, 16, Color(0, 0, 0));
	const Palette& pal = paletteFor(SKIN_ARCADE);

	// Background stars first (everything else paints over them): a slow
	// 1.5s triangle-wave twinkle between ~25% and 100% of the muted tier,
	// each star offset by an eighth of the period.
	for (int i = 0; i < 8; ++i) {
		int phase = (mTicks + i * (kStarPeriodTicks / 8)) % kStarPeriodTicks;
		int tri = phase < kStarPeriodTicks / 2 ? phase : kStarPeriodTicks - phase;
		int level = 64 + tri * (255 - 64) * 2 / kStarPeriodTicks;
		s.setPixel(kStars[i].x, kStars[i].y, scaled(pal.muted, level));
	}

	// Strip offset eases pitch -> 1/2 -> 1/4 -> 0 across the frames.
	int shift = 0;
	if (mEaseTick < kEaseFrames) {
		shift = mShiftFrom * (kEaseFrames - mEaseTick) / (kEaseFrames + 1);
	}
	bool settled = (shift == 0);

	// ±3 window: with carried-over shift the strip can travel two pitches,
	// so the slot beyond the usual ±2 becomes visible mid-ease.
	for (int slot = mSelected - 3; slot <= mSelected + 3; ++slot) {
		int item = ((slot % kItemCount) + kItemCount) % kItemCount;
		int x = kCenterX + (slot - mSelected) * kPitch + shift;
		if (x <= -12 || x >= 52) continue;
		bool isSel = (slot == mSelected);
		Color c = isSel && settled ? pal.primary : scaled(pal.secondary, isSel ? 220 : 90);
		drawIcon12(s, item, x, 0, c);
		if (isSel && settled) drawBrackets(s, x, pal.secondary);
	}

	// Caption line (y=11..15): selected title alternating with the hint.
	// Lines wider than the panel bounce InfoPage-style instead of clipping.
	bool showHint = ((mTicks / kCaptionSwapTicks) % 2) == 1;
	const char* caption = showHint
		? (mSelected == kInfoItem ? "PRESS TO OPEN" : "PRESS TO PLAY")
		: kNames[mSelected];
	const Color& capColor = showHint ? pal.secondary : pal.primary;
	int w = textWidth(caption);
	int cx = (52 - w) / 2;
	if (w > 52) {
		int span = w - 52;
		int phase = (mTicks / 8) % (2 * span);
		int off = phase < span ? phase : 2 * span - phase;
		cx = -off;
	}
	drawText(s, cx, 11, caption, capColor);

	// Edge arrows instead of a page rail: a dot row on y=15 collided with the
	// caption glyphs (y=11..15). Two bright chevrons at mid-height hint at
	// more items without touching any text row.
	if (mSelected > 0) {
		s.setPixel(1, 7, pal.secondary);
		s.setPixel(0, 8, pal.secondary);
		s.setPixel(1, 9, pal.secondary);
	}
	if (mSelected < kItemCount - 1) {
		s.setPixel(50, 7, pal.secondary);
		s.setPixel(51, 8, pal.secondary);
		s.setPixel(50, 9, pal.secondary);
	}

	std::vector<uint8_t> data;
	s.extractRGB(data);
	sendLedData(data);
}
