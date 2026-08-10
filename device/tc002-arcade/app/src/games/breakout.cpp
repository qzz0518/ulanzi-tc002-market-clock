// Direct port of web/src/lib/games/breakout.ts. Physics constants verbatim.
#include "games/breakout.h"

#include <cmath>
#include <cstdio>
#include <ctime>
#include "games/support.h"
#include "visual/PixelFont.h"

using namespace arcadegames;

namespace {

const double kFixedStepMs = 1000.0 / 120.0;
const double kStartSpeed = 16.0;
const double kMaxSpeed = 30.0;
const int kDefaultPaddleWidth = 8;
const double kGameOverBarMs = 3000.0;   // web BREAKOUT_GAME_OVER_MS
const double kRestartLockoutMs = 800.0; // web RESTART_LOCKOUT_MS
const double kKeyPaddleSpeed = 40.0;    // web KEY_PADDLE_SPEED px/s
const double kKnobStepPx = 2.0;         // design §2.3: one detent = 2px
const double kKnobFastStepPx = 4.0;     // x2 within the accel window
const double kKnobAccelWindowMs = 150.0;
const double kPi = 3.14159265358979323846;

const Color kRainbow[7] = {
	Color(0xFF4D5Au), Color(0xFF8A2Au), Color(0xFFD43Bu), Color(0x58D68Du),
	Color(0x35C7D4u), Color(0x5B8CFFu), Color(0xB66CFFu),
};
const Color kPaddle(0xC1FF3Du);
const Color kBall(0xFFFFFFu);
const Color kOverTitleA(0xFF4D5Au);
const Color kOverTitleB(0xFF8A2Au);
const Color kOverScore(0xC1FF3Du);
const Color kOverBarBg(0x284B2Cu);
const Color kOverBarFill(0xC1FF3Du);
const Color kPromptBright(0xC1FF3Du);
const Color kPromptAlt(0xFFFFFFu);

void currentTime(int& hh, int& mm) {
	time_t t = ::time(0);
	struct tm lt;
	localtime_r(&t, &lt);
	hh = lt.tm_hour;
	mm = lt.tm_min;
}

long jsRound(double v) { return (long)std::floor(v + 0.5); }  // JS Math.round

}  // namespace

// ---------------------------------------------------------------------------
// Sim — web BreakoutGame
// ---------------------------------------------------------------------------

void BreakoutEngine::Sim::reset(int width) {
	score = 0;
	lives = 3;
	level = 1;
	over = false;
	destroyed = 0;
	accumulatorMs = 0.0;
	paddleWidth = width;
	paddleX = (double)((kGameW - paddleWidth) / 2);
	buildBricks();
	startBall();
}

// Bricks spell HH:MM with the 3x5 PixelFont (device adaptation of the web's
// renderPixelText board); filler bricks flank the clock exactly like the web.
void BreakoutEngine::Sim::buildBricks() {
	bricks.clear();

	int hh, mm;
	currentTime(hh, mm);
	char text[6];
	snprintf(text, sizeof(text), "%02d:%02d", hh, mm);

	const int bitmapW = 5 * 4 - 1;  // 5 glyphs, 3px + 1px gap
	const int bitmapH = 5;
	const int startX = (kGameW - bitmapW) / 2;

	// Row-major over the whole bitmap, matching the web's brick order (the
	// first-match hit test makes insertion order part of the physics).
	for (int row = 0; row < bitmapH; ++row) {
		for (int col = 0; col < bitmapW; ++col) {
			const int glyphCol = col % 4;
			if (glyphCol == 3) continue;  // 1px gap between glyphs
			const lyricsvisual::Glyph* g = lyricsvisual::glyphFor(text[col / 4]);
			if (!(g->rows[row] & (1 << (2 - glyphCol)))) continue;
			Brick b;
			b.x = startX + col;
			b.y = row;
			b.w = 1;
			b.h = 1;
			b.color = kRainbow[row % 7];
			b.digit = true;
			bricks.push_back(b);
		}
	}

	const int sideGap = 1;
	const int rightStart = startX + bitmapW + sideGap;
	for (int y = 0; y <= 5; ++y) {
		for (int x = 0; x < startX - sideGap; x += 4) {
			Brick b;
			b.x = x;
			b.y = y;
			b.w = startX - sideGap - x < 3 ? startX - sideGap - x : 3;
			b.h = 1;
			b.color = kRainbow[y % 7];
			b.digit = false;
			bricks.push_back(b);
		}
		for (int x = rightStart; x < kGameW; x += 4) {
			Brick b;
			b.x = x;
			b.y = y;
			b.w = kGameW - x < 3 ? kGameW - x : 3;
			b.h = 1;
			b.color = kRainbow[y % 7];
			b.digit = false;
			bricks.push_back(b);
		}
	}
}

double BreakoutEngine::Sim::speed() const {
	double s = kStartSpeed * std::pow(1.06, (double)(destroyed / 8));
	return s < kMaxSpeed ? s : kMaxSpeed;
}

void BreakoutEngine::Sim::applySpeed(double target) {
	double current = std::sqrt(ballVx * ballVx + ballVy * ballVy);
	if (current == 0.0) current = 1.0;
	ballVx = ballVx / current * target;
	ballVy = ballVy / current * target;
}

void BreakoutEngine::Sim::startBall() {
	const double angle = (level % 2 == 0 ? -1.0 : 1.0) * kPi / 9.0;
	const double s = speed();
	ballX = kGameW / 2.0;
	ballY = 12.5;
	ballVx = std::sin(angle) * s;
	ballVy = -std::cos(angle) * s;
}

void BreakoutEngine::Sim::tick(double dtMs, double paddleTargetX) {
	if (over) return;
	paddleX = clampd(paddleTargetX - paddleWidth / 2.0, 0.0, (double)(kGameW - paddleWidth));
	accumulatorMs += clampd(dtMs, 0.0, 250.0);
	while (accumulatorMs >= kFixedStepMs && !over) {
		step(kFixedStepMs / 1000.0);
		accumulatorMs -= kFixedStepMs;
	}
}

void BreakoutEngine::Sim::step(double dtSeconds) {
	double nextX = ballX + ballVx * dtSeconds;
	double nextY = ballY + ballVy * dtSeconds;

	if (nextX < 0.0) {
		nextX = -nextX;
		ballVx = std::fabs(ballVx);
	} else if (nextX > kGameW - 1.0) {
		nextX = 2.0 * (kGameW - 1.0) - nextX;
		ballVx = -std::fabs(ballVx);
	}
	if (nextY < 0.0) {
		nextY = -nextY;
		ballVy = std::fabs(ballVy);
	}

	if (ballVy > 0.0 && ballY < 14.5 && nextY >= 14.5) {
		const double hitX = nextX;
		if (hitX >= paddleX - 0.5 && hitX <= paddleX + paddleWidth - 0.5) {
			nextY = 14.5 - (nextY - 14.5);
			const double center = paddleX + paddleWidth / 2.0 - 0.5;
			const double offset = clampd((hitX - center) / (paddleWidth / 2.0), -1.0, 1.0);
			const double angle = offset * kPi / 3.0;
			const double s = speed();
			ballVx = std::sin(angle) * s;
			ballVy = -std::cos(angle) * s;
		}
	}

	int hitIndex = -1;
	for (int i = 0; i < (int)bricks.size(); ++i) {
		const Brick& b = bricks[i];
		if (nextX >= b.x - 0.5 && nextX <= b.x + b.w - 0.5
			&& nextY >= b.y - 0.5 && nextY <= b.y + b.h - 0.5) {
			hitIndex = i;
			break;
		}
	}
	if (hitIndex >= 0) {
		const bool digit = bricks[hitIndex].digit;
		bricks.erase(bricks.begin() + hitIndex);
		score += digit ? 30 : 10;
		destroyed += 1;
		ballVy *= -1.0;
		applySpeed(speed());
		nextY = ballY + ballVy * dtSeconds;
	}

	ballX = nextX;
	ballY = nextY;
	if (ballY > kGameH - 0.5) loseLife();
	else if (bricks.empty()) nextLevel();
}

void BreakoutEngine::Sim::loseLife() {
	lives -= 1;
	if (lives <= 0) {
		lives = 0;
		over = true;
		return;
	}
	paddleX = (double)((kGameW - paddleWidth) / 2);
	startBall();
}

void BreakoutEngine::Sim::nextLevel() {
	level += 1;
	buildBricks();
	paddleX = (double)((kGameW - paddleWidth) / 2);
	startBall();
}

// ---------------------------------------------------------------------------
// Engine — web BreakoutEngine (shell adapter)
// ---------------------------------------------------------------------------

BreakoutEngine::BreakoutEngine()
	: mPaddleWidth(kDefaultPaddleWidth) {
	reset();
}

BreakoutEngine::~BreakoutEngine() {}

void BreakoutEngine::reset() {
	mSim.reset(mPaddleWidth);
	mPhase = GameHud::Ready;
	mElapsedMs = 0.0;
	mGameOverAtMs = 0.0;
	mKeyTargetX = kGameW / 2.0;
	mLeftHeld = false;
	mRightHeld = false;
	mStartEdge = false;
	mPaused = false;
	mLastKnobDir = 0;
	mLastKnobAtMs = -1000.0;
	currentTime(mReadyHH, mReadyMM);
}

void BreakoutEngine::begin() {
	mSim.reset(mPaddleWidth);
	mPhase = GameHud::Playing;
	mKeyTargetX = kGameW / 2.0;
	mPaused = false;
}

void BreakoutEngine::onInput(const GameInputEvent& event) {
	switch (event.kind) {
	case GameInputEvent::KnobCw:
	case GameInputEvent::KnobCcw: {
		if (mPhase != GameHud::Playing || mPaused) break;
		const int dir = event.kind == GameInputEvent::KnobCw ? 1 : -1;
		double step = kKnobStepPx;
		if (dir == mLastKnobDir && mElapsedMs - mLastKnobAtMs <= kKnobAccelWindowMs)
			step = kKnobFastStepPx;
		mLastKnobDir = dir;
		mLastKnobAtMs = mElapsedMs;
		mKeyTargetX = clampd(mKeyTargetX + dir * step, 0.0, (double)kGameW);
		break;
	}
	case GameInputEvent::KnobPress:
	case GameInputEvent::Middle:
		if (!event.down) break;
		if (mPhase == GameHud::Playing) mPaused = !mPaused;
		else mStartEdge = true;
		break;
	case GameInputEvent::Left:
		mLeftHeld = event.down;
		break;
	case GameInputEvent::Right:
		mRightHeld = event.down;
		break;
	}
}

double BreakoutEngine::resolvePaddleTarget(double dtMs) {
	const int sign = (mRightHeld ? 1 : 0) - (mLeftHeld ? 1 : 0);
	if (sign != 0) {
		mKeyTargetX = clampd(mKeyTargetX + sign * kKeyPaddleSpeed * (dtMs / 1000.0),
			0.0, (double)kGameW);
	}
	return mKeyTargetX;
}

void BreakoutEngine::tick(int dtMs) {
	const double dt = clampd((double)dtMs, 0.0, 250.0);
	mElapsedMs += dt;
	const bool start = mStartEdge;
	mStartEdge = false;

	if (mPhase == GameHud::Ready) {
		// The attract board shows the live clock; rebuild it when the minute rolls.
		int hh, mm;
		currentTime(hh, mm);
		if (hh != mReadyHH || mm != mReadyMM) {
			mReadyHH = hh;
			mReadyMM = mm;
			mSim.reset(mPaddleWidth);
		}
		if (start) begin();
		return;
	}

	if (mPhase == GameHud::Playing) {
		if (mPaused) return;
		mSim.tick(dt, resolvePaddleTarget(dt));
		if (mSim.over) {
			mPhase = GameHud::Over;
			mGameOverAtMs = mElapsedMs;
		}
		return;
	}

	// Over: hold the settlement screen briefly, then a press replays.
	if (start && mElapsedMs - mGameOverAtMs >= kRestartLockoutMs) begin();
}

bool BreakoutEngine::blink(double periodMs) const {
	return ((long)(mElapsedMs / periodMs)) % 2 == 0;
}

void BreakoutEngine::renderSim(Surface& s) {
	for (int i = 0; i < (int)mSim.bricks.size(); ++i) {
		const Brick& b = mSim.bricks[i];
		fillRect(s, b.x, b.y, b.w, b.h, b.color);
	}
	fillRect(s, (int)jsRound(mSim.paddleX), 15, mSim.paddleWidth, 1, kPaddle);
	s.setPixel(clampi((int)jsRound(mSim.ballX), 0, kGameW - 1),
		clampi((int)jsRound(mSim.ballY), 0, kGameH - 1), kBall);
}

void BreakoutEngine::renderGameOver(Surface& s) {
	const double elapsed = mElapsedMs - mGameOverAtMs;
	const bool pulse = ((long)(elapsed / 250.0)) % 2 == 0;
	drawCenteredText3x5(s, "GAME OVER", 1, pulse ? kOverTitleA : kOverTitleB);
	char scoreText[16];
	snprintf(scoreText, sizeof(scoreText), "S %d", mSim.score);
	drawCenteredText3x5(s, scoreText, 9, kOverScore);
	fillRect(s, 0, 15, kGameW, 1, kOverBarBg);
	double ratio = elapsed / kGameOverBarMs;
	if (ratio > 1.0) ratio = 1.0;
	fillRect(s, 0, 15, (int)jsRound(kGameW * ratio), 1, kOverBarFill);
}

void BreakoutEngine::render(Surface& s) {
	// Background stays black — Surface is cleared by the caller / constructor.
	if (mPhase == GameHud::Over) {
		renderGameOver(s);
		return;
	}
	renderSim(s);
	if (mPhase == GameHud::Ready) {
		// Attract overlay in the free band between bricks and paddle.
		// "PLAY!" — the shared font lacks '!', so place the bang by hand.
		const int w = 5 * 4 - 1;  // width of "PLAY!"
		const int x = (kGameW - w) / 2;
		const Color& c = blink(500.0) ? kPromptBright : kPromptAlt;
		drawText3x5(s, "PLAY", x, 8, c);
		const int bangX = x + 4 * 4 + 1;  // centre column of the '!' cell
		s.setPixel(bangX, 8, c);
		s.setPixel(bangX, 9, c);
		s.setPixel(bangX, 10, c);
		s.setPixel(bangX, 12, c);
	} else if (mPaused) {
		if (blink(500.0)) drawCenteredText3x5(s, "PAUSE", 8, kPromptBright);
	}
}

GameHud BreakoutEngine::hud() const {
	GameHud h;
	h.score = mSim.score;
	h.lives = mSim.lives;
	h.phase = mPhase;
	return h;
}
