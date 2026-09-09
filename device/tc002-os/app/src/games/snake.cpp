// Direct port of web/src/lib/games/snake.ts. Physics constants verbatim.
#include "games/snake.h"

#include <cmath>
#include <cstdio>
#include <ctime>
#include "visual/PixelFont.h"

using namespace arcadegames;

namespace {

const double kBaseSpeed = 12.0;  // cells per second at level 1
const double kMaxSpeed = 26.0;
const double kSpeedStep = 1.08;
const int kFoodPerLevel = 5;
const int kStartLength = 4;
const double kDigitFoodChance = 1.0 / 6.0;
const int kDigitFoodScore = 5;
const int kDigitFoodGrowth = 3;
const int kDotFoodScore = 1;
const double kRestartLockMs = 600.0;
const int kDigitPlacementTries = 8;
const int kDigitWidth = 3;
const int kDigitHeight = 5;

const uint8_t kHeadRgb[3] = {0xD6, 0xFF, 0x5C};
const uint8_t kTailRgb[3] = {0x0E, 0x9C, 0x6A};
const Color kDimSnake(0x173D2Au);
const Color kFoodBright(0xFF4D5Au);
const Color kFoodDim(0x7A1F27u);
const Color kDigitBright(0xFFD43Bu);
const Color kDigitDim(0x8A6A10u);
const Color kTitle(0x6F8296u);
const Color kScoreColor(0xFFFFFFu);
const Color kPrompt(0xC1FF3Du);

Color mixColor(const uint8_t from[3], const uint8_t to[3], double ratio) {
	const int r = (int)std::floor(from[0] + (to[0] - from[0]) * ratio + 0.5);
	const int g = (int)std::floor(from[1] + (to[1] - from[1]) * ratio + 0.5);
	const int b = (int)std::floor(from[2] + (to[2] - from[2]) * ratio + 0.5);
	return Color((Color::byte)r, (Color::byte)g, (Color::byte)b);
}

}  // namespace

SnakeEngine::SnakeEngine() {
	mRandom.seed((uint32_t)::time(0) ^ 0x5AAC0DE5u);
	resetState();
}

SnakeEngine::~SnakeEngine() {}

void SnakeEngine::reset() {
	resetState();
}

void SnakeEngine::resetState() {
	mScore = 0;
	mEaten = 0;
	mPhase = GameHud::Ready;
	mGrowth = 0;
	mDirection = DirRight;
	mPendingDirection = DirRight;
	mAccumulatorMs = 0.0;
	mElapsedMs = 0.0;
	mOverMs = 0.0;
	mConfirmEdge = false;
	mTurnEdge = false;
	mPaused = false;
	mCells.clear();
	const int y = kGameH / 2;
	for (int i = 0; i < kStartLength; ++i) {
		Cell c;
		c.x = 8 - i;
		c.y = y;
		mCells.push_back(c);
	}
	spawnFood();
}

int SnakeEngine::level() const {
	return mEaten / kFoodPerLevel + 1;
}

double SnakeEngine::speedCells() const {
	const double s = kBaseSpeed * std::pow(kSpeedStep, (double)(level() - 1));
	return s < kMaxSpeed ? s : kMaxSpeed;
}

double SnakeEngine::stepMs() const {
	return 1000.0 / speedCells();
}

// Rejects a 180-degree reversal against the direction the snake last actually moved.
void SnakeEngine::queueDirection(Direction direction) {
	static const Direction kOpposite[4] = {DirDown, DirUp, DirRight, DirLeft};
	if (direction == kOpposite[mDirection]) return;
	mPendingDirection = direction;
}

void SnakeEngine::turn(int sign) {
	// Rotate relative to the queued heading so two quick detents chain into a
	// U-turn across two steps; the reversal guard still checks the committed
	// direction, exactly like the web queueDirection.
	static const Direction kCcw[4] = {DirLeft, DirRight, DirDown, DirUp};   // from up,down,left,right
	static const Direction kCw[4] = {DirRight, DirLeft, DirUp, DirDown};
	const Direction next = sign < 0 ? kCcw[mPendingDirection] : kCw[mPendingDirection];
	queueDirection(next);
	mTurnEdge = true;
}

void SnakeEngine::onInput(const GameInputEvent& event) {
	switch (event.kind) {
	case GameInputEvent::KnobCcw:
		if (!(mPhase == GameHud::Playing && mPaused)) turn(-1);
		break;
	case GameInputEvent::KnobCw:
		if (!(mPhase == GameHud::Playing && mPaused)) turn(1);
		break;
	case GameInputEvent::Left:
		if (event.down && !(mPhase == GameHud::Playing && mPaused)
			&& mPhase != GameHud::Over) turn(-1);
		break;
	case GameInputEvent::Right:
		if (event.down && !(mPhase == GameHud::Playing && mPaused)
			&& mPhase != GameHud::Over) turn(1);
		break;
	case GameInputEvent::KnobPress:
	case GameInputEvent::Middle:
		if (!event.down) break;
		if (mPhase == GameHud::Playing) mPaused = !mPaused;
		else mConfirmEdge = true;
		break;
	}
}

void SnakeEngine::tick(int dtMs) {
	const double dt = clampd((double)dtMs, 0.0, 250.0);
	mElapsedMs += dt;
	const bool confirm = mConfirmEdge;
	const bool turned = mTurnEdge;
	mConfirmEdge = false;
	mTurnEdge = false;

	if (mPhase == GameHud::Ready) {
		// A direction input is the natural first move, so it starts the run too.
		if (!confirm && !turned) return;
		mPhase = GameHud::Playing;
	} else if (mPhase == GameHud::Over) {
		mOverMs += dt;
		if (confirm && mOverMs >= kRestartLockMs) resetState();
		return;
	}

	if (mPaused) return;
	mAccumulatorMs += dt;
	double ms = stepMs();
	while (mAccumulatorMs >= ms && mPhase == GameHud::Playing) {
		mAccumulatorMs -= ms;
		step();
		ms = stepMs();
	}
}

void SnakeEngine::step() {
	static const int kDx[4] = {0, 0, -1, 1};  // up,down,left,right
	static const int kDy[4] = {-1, 1, 0, 0};
	mDirection = mPendingDirection;
	Cell next;
	next.x = mCells[0].x + kDx[mDirection];
	next.y = mCells[0].y + kDy[mDirection];

	if (next.x < 0 || next.x >= kGameW || next.y < 0 || next.y >= kGameH) {
		gameOver();
		return;
	}
	// The tail cell frees up on this very step unless the snake is still growing.
	const int lastIndex = (int)mCells.size() - 1;
	for (int i = 0; i < (int)mCells.size(); ++i) {
		if (mCells[i].x == next.x && mCells[i].y == next.y
			&& !(mGrowth == 0 && i == lastIndex)) {
			gameOver();
			return;
		}
	}

	mCells.insert(mCells.begin(), next);
	bool ate = false;
	for (int i = 0; i < (int)mFoodCells.size(); ++i) {
		if (mFoodCells[i].x == next.x && mFoodCells[i].y == next.y) {
			ate = true;
			break;
		}
	}
	if (ate) {
		mScore += mFoodIsDigit ? kDigitFoodScore : kDotFoodScore;
		mGrowth += mFoodIsDigit ? kDigitFoodGrowth : 1;
		mEaten += 1;
		spawnFood();
	}
	if (mGrowth > 0) mGrowth -= 1;
	else mCells.pop_back();
}

void SnakeEngine::gameOver() {
	mPhase = GameHud::Over;
	mOverMs = 0.0;
	mAccumulatorMs = 0.0;
}

void SnakeEngine::spawnFood() {
	if (mRandom.next() < kDigitFoodChance) {
		if (spawnDigitFood()) return;
	}
	spawnDotFood();
}

bool SnakeEngine::spawnDigitFood() {
	const int digit = mRandom.pick(10);
	const lyricsvisual::Glyph* glyph = lyricsvisual::glyphFor((char)('0' + digit));

	bool occupied[kGameW * kGameH] = {false};
	for (int i = 0; i < (int)mCells.size(); ++i)
		occupied[mCells[i].y * kGameW + mCells[i].x] = true;

	for (int attempt = 0; attempt < kDigitPlacementTries; ++attempt) {
		const int originX = mRandom.pick(kGameW - kDigitWidth + 1);
		const int originY = mRandom.pick(kGameH - kDigitHeight + 1);
		std::vector<Cell> cells;
		for (int row = 0; row < kDigitHeight; ++row) {
			for (int column = 0; column < kDigitWidth; ++column) {
				if (!(glyph->rows[row] & (1 << (2 - column)))) continue;
				Cell c;
				c.x = originX + column;
				c.y = originY + row;
				cells.push_back(c);
			}
		}
		bool free = true;
		for (int i = 0; i < (int)cells.size(); ++i) {
			if (occupied[cells[i].y * kGameW + cells[i].x]) {
				free = false;
				break;
			}
		}
		if (free) {
			mFoodIsDigit = true;
			mFoodCells.swap(cells);
			return true;
		}
	}
	return false;
}

void SnakeEngine::spawnDotFood() {
	bool occupied[kGameW * kGameH] = {false};
	for (int i = 0; i < (int)mCells.size(); ++i)
		occupied[mCells[i].y * kGameW + mCells[i].x] = true;

	std::vector<Cell> free;
	free.reserve(kGameW * kGameH);
	for (int y = 0; y < kGameH; ++y) {
		for (int x = 0; x < kGameW; ++x) {
			if (!occupied[y * kGameW + x]) {
				Cell c;
				c.x = x;
				c.y = y;
				free.push_back(c);
			}
		}
	}
	Cell cell;
	cell.x = 0;
	cell.y = 0;
	if (!free.empty()) cell = free[mRandom.pick((int)free.size())];
	mFoodIsDigit = false;
	mFoodCells.clear();
	mFoodCells.push_back(cell);
}

bool SnakeEngine::blink(double periodMs) const {
	return ((long)(mElapsedMs / periodMs)) % 2 == 0;
}

void SnakeEngine::renderFood(Surface& s, bool dim) {
	const bool on = blink(280.0);
	const Color& c = dim
		? (mFoodIsDigit ? kDigitDim : kFoodDim)
		: mFoodIsDigit
			? (on ? kDigitBright : kDigitDim)
			: on
				? kFoodBright
				: kFoodDim;
	for (int i = 0; i < (int)mFoodCells.size(); ++i)
		s.setPixel(mFoodCells[i].x, mFoodCells[i].y, c);
}

void SnakeEngine::renderSnake(Surface& s, bool dim) {
	const int last = (int)mCells.size() - 1 > 1 ? (int)mCells.size() - 1 : 1;
	for (int i = 0; i < (int)mCells.size(); ++i) {
		const Color c = dim ? kDimSnake : mixColor(kHeadRgb, kTailRgb, (double)i / last);
		s.setPixel(mCells[i].x, mCells[i].y, c);
	}
}

void SnakeEngine::renderGameOver(Surface& s) {
	drawCenteredText3x5(s, "OVER", 1, kTitle);
	char scoreText[12];
	snprintf(scoreText, sizeof(scoreText), "%d", mScore);
	drawCenteredText3x5(s, scoreText, 9, kScoreColor);
	if (mOverMs < kRestartLockMs || !blink(420.0)) return;
	for (int x = 0; x < kGameW; x += 2) s.setPixel(x, kGameH - 1, kPrompt);
}

void SnakeEngine::render(Surface& s) {
	// Background stays truly off (black) — the caller supplies a cleared surface.
	const bool dim = mPhase == GameHud::Over;
	renderFood(s, dim);
	renderSnake(s, dim);

	if (mPhase == GameHud::Ready && blink(500.0)) drawCenteredText3x5(s, "SNAKE", 1, kTitle);
	if (mPhase == GameHud::Playing && mPaused && blink(500.0))
		drawCenteredText3x5(s, "PAUSE", 6, kPrompt);
	if (dim) renderGameOver(s);
}

GameHud SnakeEngine::hud() const {
	GameHud h;
	h.score = mScore;
	h.lives = -1;
	h.phase = mPhase;
	return h;
}
