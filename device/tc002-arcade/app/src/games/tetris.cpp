// Sideways tetris (gravity left) for the 52x16 matrix. Original device
// engine (no web port); SRS shapes, spec in the G1 task brief.
#include "games/tetris.h"

#include <cmath>
#include <cstdio>
#include <ctime>
#include "visual/PixelFont.h"

using namespace arcadegames;

namespace {

const int kWellScreenX = 8;   // internal x=0 maps here
const int kWellScreenY = 3;   // internal y=0 maps here
const int kSpawnX = 36;       // 4x4 box at screen x=44..47
const int kSpawnY = 3;        // box centred on the 10-wide well
const double kBaseIntervalMs = 800.0;
const double kIntervalStepMs = 60.0;   // faster per 4 cleared columns
const double kMinIntervalMs = 140.0;
const int kSoftDropFactor = 8;
const int kClearScores[4] = {100, 300, 500, 800};
const int kColumnsPerLevel = 4;
const double kRestartLockMs = 600.0;
const double kFlashMs = 60.0;  // hard-drop landing flash, 2 shell frames

// SRS states 0,R,2,L as (cx,cy) cells in the 4x4 box. Screen axes match the
// standard grid (x right, y down), so the standard tables apply verbatim;
// only gravity differs (toward -x instead of +y).
const int8_t kCells[7][4][4][2] = {
	// I
	{{{0,1},{1,1},{2,1},{3,1}}, {{2,0},{2,1},{2,2},{2,3}},
	 {{0,2},{1,2},{2,2},{3,2}}, {{1,0},{1,1},{1,2},{1,3}}},
	// J
	{{{0,0},{0,1},{1,1},{2,1}}, {{1,0},{2,0},{1,1},{1,2}},
	 {{0,1},{1,1},{2,1},{2,2}}, {{1,0},{1,1},{0,2},{1,2}}},
	// L
	{{{2,0},{0,1},{1,1},{2,1}}, {{1,0},{1,1},{1,2},{2,2}},
	 {{0,1},{1,1},{2,1},{0,2}}, {{0,0},{1,0},{1,1},{1,2}}},
	// O
	{{{1,0},{2,0},{1,1},{2,1}}, {{1,0},{2,0},{1,1},{2,1}},
	 {{1,0},{2,0},{1,1},{2,1}}, {{1,0},{2,0},{1,1},{2,1}}},
	// S
	{{{1,0},{2,0},{0,1},{1,1}}, {{1,0},{1,1},{2,1},{2,2}},
	 {{1,1},{2,1},{0,2},{1,2}}, {{0,0},{0,1},{1,1},{1,2}}},
	// T
	{{{1,0},{0,1},{1,1},{2,1}}, {{1,0},{1,1},{2,1},{1,2}},
	 {{0,1},{1,1},{2,1},{1,2}}, {{1,0},{0,1},{1,1},{1,2}}},
	// Z
	{{{0,0},{1,0},{1,1},{2,1}}, {{2,0},{1,1},{2,1},{1,2}},
	 {{0,1},{1,1},{1,2},{2,2}}, {{1,0},{0,1},{1,1},{0,2}}},
};

// High-saturation piece colors (same family as the breakout rainbow).
const Color kPieceColors[7] = {
	Color(0x35C7D4u),  // I cyan
	Color(0x5B8CFFu),  // J blue
	Color(0xFF8A2Au),  // L orange
	Color(0xFFD43Bu),  // O yellow
	Color(0x58D68Du),  // S green
	Color(0xB66CFFu),  // T purple
	Color(0xFF4D5Au),  // Z red
};

const Color kWall(0x1C3550u);       // dark tier: well outline only
const Color kFlash(0xFFFFFFu);
const Color kHudLabel(0x55B7E8u);   // 'N' next label
const Color kHudLevel(0xFFFFFFu);
const Color kTitleColor(0xFFD43Bu);
const Color kScoreColor(0xFFFFFFu);
const Color kPrompt(0xC1FF3Du);

}  // namespace

TetrisEngine::TetrisEngine() {
	mRandom.seed((uint32_t)::time(0) ^ 0x7E7215C7u);
	resetState();
}

TetrisEngine::~TetrisEngine() {}

void TetrisEngine::reset() {
	resetState();
}

void TetrisEngine::resetState() {
	for (int x = 0; x < kDepth; ++x)
		for (int y = 0; y < kWidth; ++y) mBoard[x][y] = -1;
	mScore = 0;
	mCleared = 0;
	mPhase = GameHud::Ready;
	mDropMs = 0.0;
	mElapsedMs = 0.0;
	mOverMs = 0.0;
	mFlashMs = 0.0;
	mFlashCount = 0;
	mSoftHeld = false;
	mConfirmEdge = false;
	mNext = mRandom.pick(7);
	spawn();
}

int TetrisEngine::level() const {
	return mCleared / kColumnsPerLevel + 1;
}

double TetrisEngine::intervalMs() const {
	const double ms = kBaseIntervalMs - kIntervalStepMs * (double)(level() - 1);
	return ms > kMinIntervalMs ? ms : kMinIntervalMs;
}

int TetrisEngine::filledCount() const {
	int n = 0;
	for (int x = 0; x < kDepth; ++x)
		for (int y = 0; y < kWidth; ++y)
			if (mBoard[x][y] >= 0) ++n;
	return n;
}

bool TetrisEngine::fits(int piece, int rot, int px, int py) const {
	for (int i = 0; i < 4; ++i) {
		const int gx = px + kCells[piece][rot][i][0];
		const int gy = py + kCells[piece][rot][i][1];
		if (gx < 0 || gx >= kDepth || gy < 0 || gy >= kWidth) return false;
		if (mBoard[gx][gy] >= 0) return false;
	}
	return true;
}

void TetrisEngine::spawn() {
	mPiece = mNext;
	mNext = mRandom.pick(7);
	mRotation = 0;
	mPieceX = kSpawnX;
	mPieceY = kSpawnY;
	if (!fits(mPiece, mRotation, mPieceX, mPieceY)) {
		// Stack reached the entry zone (screen x=47): spawn fails.
		mPhase = GameHud::Over;
		mOverMs = 0.0;
	}
}

void TetrisEngine::lockPiece(bool flash) {
	mFlashCount = 0;
	for (int i = 0; i < 4; ++i) {
		const int gx = mPieceX + kCells[mPiece][mRotation][i][0];
		const int gy = mPieceY + kCells[mPiece][mRotation][i][1];
		mBoard[gx][gy] = (int8_t)mPiece;
		mFlashCells[i][0] = (int8_t)gx;
		mFlashCells[i][1] = (int8_t)gy;
		mFlashCount = i + 1;
	}
	if (flash) mFlashMs = kFlashMs;
	else mFlashCount = 0;
	// A clear shifts everything right of the gap leftwards, which would leave
	// the landing flash painted at stale coordinates — the clear itself is
	// feedback enough, so drop the flash on those locks.
	if (clearFullColumns() > 0) {
		mFlashCount = 0;
		mFlashMs = 0;
	}
	spawn();
}

int TetrisEngine::clearFullColumns() {
	bool full[kDepth];
	int n = 0;
	for (int x = 0; x < kDepth; ++x) {
		full[x] = true;
		for (int y = 0; y < kWidth; ++y) {
			if (mBoard[x][y] < 0) {
				full[x] = false;
				break;
			}
		}
		if (full[x]) ++n;
	}
	if (n == 0) return 0;

	mScore += kClearScores[n - 1 < 3 ? n - 1 : 3] * level();  // pre-clear level
	mCleared += n;

	// Compact toward the floor: everything right of a cleared column moves
	// one column left.
	int dst = 0;
	for (int src = 0; src < kDepth; ++src) {
		if (full[src]) continue;
		if (dst != src)
			for (int y = 0; y < kWidth; ++y) mBoard[dst][y] = mBoard[src][y];
		++dst;
	}
	for (; dst < kDepth; ++dst)
		for (int y = 0; y < kWidth; ++y) mBoard[dst][y] = -1;
	return n;
}

void TetrisEngine::tryShift(int dy) {
	if (fits(mPiece, mRotation, mPieceX, mPieceY + dy)) mPieceY += dy;
}

void TetrisEngine::tryRotate() {
	const int next = (mRotation + 1) & 3;
	// Base position, then the three kicks: +1y, -1y, +1x (away from the floor).
	const int kicks[4][2] = {{0, 0}, {0, 1}, {0, -1}, {1, 0}};
	for (int i = 0; i < 4; ++i) {
		const int px = mPieceX + kicks[i][0];
		const int py = mPieceY + kicks[i][1];
		if (fits(mPiece, next, px, py)) {
			mRotation = next;
			mPieceX = px;
			mPieceY = py;
			return;
		}
	}
}

void TetrisEngine::hardDrop() {
	while (fits(mPiece, mRotation, mPieceX - 1, mPieceY)) mPieceX -= 1;
	lockPiece(true);
}

void TetrisEngine::onInput(const GameInputEvent& event) {
	switch (event.kind) {
	case GameInputEvent::KnobCw:
		if (mPhase == GameHud::Playing) tryShift(1);
		break;
	case GameInputEvent::KnobCcw:
		if (mPhase == GameHud::Playing) tryShift(-1);
		break;
	case GameInputEvent::KnobPress:
	case GameInputEvent::Middle:
		if (!event.down) break;
		if (mPhase == GameHud::Playing) tryRotate();
		else mConfirmEdge = true;
		break;
	case GameInputEvent::Left:  // soft drop while held
		if (mPhase == GameHud::Playing) mSoftHeld = event.down;
		break;
	case GameInputEvent::Right:  // hard drop
		if (event.down && mPhase == GameHud::Playing) hardDrop();
		break;
	}
}

void TetrisEngine::tick(int dtMs) {
	const double dt = clampd((double)dtMs, 0.0, 250.0);
	mElapsedMs += dt;
	const bool confirm = mConfirmEdge;
	mConfirmEdge = false;

	if (mPhase == GameHud::Ready) {
		if (confirm) mPhase = GameHud::Playing;
		return;
	}
	if (mPhase == GameHud::Over) {
		mOverMs += dt;
		if (confirm && mOverMs >= kRestartLockMs) resetState();
		return;
	}

	if (mFlashMs > 0.0) {
		mFlashMs -= dt;
		if (mFlashMs < 0.0) mFlashMs = 0.0;
	}

	mDropMs += dt;
	double threshold = intervalMs() / (mSoftHeld ? kSoftDropFactor : 1);
	while (mDropMs >= threshold && mPhase == GameHud::Playing) {
		mDropMs -= threshold;
		if (fits(mPiece, mRotation, mPieceX - 1, mPieceY)) mPieceX -= 1;
		else lockPiece(false);
		threshold = intervalMs() / (mSoftHeld ? kSoftDropFactor : 1);
	}
}

bool TetrisEngine::blink(double periodMs) const {
	return ((long)(mElapsedMs / periodMs)) % 2 == 0;
}

void TetrisEngine::renderWalls(Surface& s) {
	// Dark-tier outline: floor column at screen x=7, rails at y=2 and y=13.
	for (int y = 2; y <= 13; ++y) s.setPixel(7, y, kWall);
	for (int x = 7; x <= 47; ++x) {
		s.setPixel(x, 2, kWall);
		s.setPixel(x, 13, kWall);
	}
}

void TetrisEngine::renderHud(Surface& s) {
	// 7px side panel (x=0..6): 'N' label, next-piece 4x4 thumb, level digits.
	// ("NEXT" is 15px wide in the 3x5 font and cannot fit — abbreviated.)
	drawText3x5(s, "N", 0, 0, kHudLabel);
	for (int i = 0; i < 4; ++i) {
		const int cx = kCells[mNext][0][i][0];
		const int cy = kCells[mNext][0][i][1];
		s.setPixel(1 + cx, 6 + cy, kPieceColors[mNext]);
	}
	char levelText[8];
	snprintf(levelText, sizeof(levelText), "%d", level());
	drawText3x5(s, levelText, (7 - textWidth3x5(levelText)) / 2, 11, kHudLevel);
}

void TetrisEngine::renderGameOver(Surface& s) {
	drawCenteredText3x5(s, "OVER", 1, kTitleColor);
	char lineText[20];
	snprintf(lineText, sizeof(lineText), "%d L%d", mScore, mCleared);
	drawCenteredText3x5(s, lineText, 9, kScoreColor);
	if (mOverMs < kRestartLockMs || !blink(420.0)) return;
	for (int x = 0; x < kGameW; x += 2) s.setPixel(x, kGameH - 1, kPrompt);
}

void TetrisEngine::render(Surface& s) {
	// Background stays truly off (black) — the caller supplies a cleared surface.
	if (mPhase == GameHud::Over) {
		renderGameOver(s);
		return;
	}

	renderWalls(s);
	if (mPhase == GameHud::Ready) {
		// Empty well + blinking title, centred over the well.
		if (blink(500.0)) drawText3x5(s, "TETRIS", 16, 5, kPrompt);
		return;
	}

	for (int x = 0; x < kDepth; ++x) {
		for (int y = 0; y < kWidth; ++y) {
			if (mBoard[x][y] >= 0)
				s.setPixel(kWellScreenX + x, kWellScreenY + y, kPieceColors[mBoard[x][y]]);
		}
	}
	for (int i = 0; i < 4; ++i) {
		const int gx = mPieceX + kCells[mPiece][mRotation][i][0];
		const int gy = mPieceY + kCells[mPiece][mRotation][i][1];
		s.setPixel(kWellScreenX + gx, kWellScreenY + gy, kPieceColors[mPiece]);
	}
	if (mFlashMs > 0.0) {
		for (int i = 0; i < mFlashCount; ++i)
			s.setPixel(kWellScreenX + mFlashCells[i][0],
				kWellScreenY + mFlashCells[i][1], kFlash);
	}
	renderHud(s);
}

GameHud TetrisEngine::hud() const {
	GameHud h;
	h.score = mScore;
	h.lives = -1;
	h.phase = mPhase;
	return h;
}
