// Direct port of web/src/lib/games/pong.ts. Physics constants verbatim.
#include "games/pong.h"

#include <cmath>
#include <cstdio>
#include <ctime>

using namespace arcadegames;

namespace {

const double kStepMs = 1000.0 / 120.0;
const int kPaddleHeight = 4;         // PONG_PADDLE_HEIGHT
const double kBaseSpeed = 20.0;      // px/s on the opening serve
const double kSpeedStep = 1.05;      // +5% per round already played
const int kWinScore = 9;
const double kAiSpeed = 13.0;        // px/s ceiling, deliberately slower than the ball
const double kServeDelayMs = 500.0;
const int kLeftColumn = 0;
const int kRightColumn = kGameW - 1;
const double kLeftPlane = 1.0;
const double kRightPlane = kGameW - 2.0;
const double kMidX = kGameW / 2.0;
const double kCenterY = (kGameH - 1.0) / 2.0;
const double kRestartLockMs = 600.0;
const double kKeyPaddleSpeed = 40.0;  // held-button speed, same as breakout
const double kKnobStepPx = 2.0;
const double kKnobFastStepPx = 4.0;
const double kKnobAccelWindowMs = 150.0;
const double kPi = 3.14159265358979323846;

const Color kMidline(0x16324Eu);
const Color kDimMidline(0x0B1A28u);
const Color kScoreDim(0x1D4368u);
const Color kLeftPaddle(0x5B8CFFu);
const Color kRightPaddle(0xFF8A2Au);
const Color kBall(0xFFFFFFu);
const Color kTitle(0x6F8296u);
const Color kFinalScore(0xFFFFFFu);
const Color kPrompt(0xC1FF3Du);

long jsRound(double v) { return (long)std::floor(v + 0.5); }

// Turns a desired paddle centre into a clamped top edge.
double paddleTopFor(double center) {
	return clampd(center - kPaddleHeight / 2.0, 0.0, (double)(kGameH - kPaddleHeight));
}

}  // namespace

PongEngine::PongEngine() {
	mRandom.seed((uint32_t)::time(0) ^ 0x90A6B011u);
	resetState();
}

PongEngine::~PongEngine() {}

void PongEngine::reset() {
	resetState();
}

void PongEngine::resetState() {
	mScoreLeft = 0;
	mScoreRight = 0;
	mPhase = GameHud::Ready;
	mLeftY = paddleTopFor(kGameH / 2.0);
	mRightY = paddleTopFor(kGameH / 2.0);
	mBallX = kMidX;
	mBallY = kCenterY;
	mBallVx = 0.0;
	mBallVy = 0.0;
	mServeDelayMs = 0.0;
	mServeTowardLeft = true;
	mAccumulatorMs = 0.0;
	mElapsedMs = 0.0;
	mOverMs = 0.0;
	mKeyTargetY = kGameH / 2.0;
	mUpHeld = false;
	mDownHeld = false;
	mConfirmEdge = false;
	mPaused = false;
	mLastKnobDir = 0;
	mLastKnobAtMs = -1000.0;
}

int PongEngine::rounds() const {
	return mScoreLeft + mScoreRight;
}

double PongEngine::speed() const {
	return kBaseSpeed * std::pow(kSpeedStep, (double)rounds());
}

void PongEngine::onInput(const GameInputEvent& event) {
	switch (event.kind) {
	case GameInputEvent::KnobCw:
	case GameInputEvent::KnobCcw: {
		if (mPhase == GameHud::Playing && mPaused) break;
		const int dir = event.kind == GameInputEvent::KnobCw ? 1 : -1;  // cw = down
		double step = kKnobStepPx;
		if (dir == mLastKnobDir && mElapsedMs - mLastKnobAtMs <= kKnobAccelWindowMs)
			step = kKnobFastStepPx;
		mLastKnobDir = dir;
		mLastKnobAtMs = mElapsedMs;
		mKeyTargetY = clampd(mKeyTargetY + dir * step, 0.0, (double)kGameH);
		break;
	}
	case GameInputEvent::KnobPress:
	case GameInputEvent::Middle:
		if (!event.down) break;
		if (mPhase == GameHud::Playing) mPaused = !mPaused;
		else mConfirmEdge = true;
		break;
	case GameInputEvent::Left:
		mUpHeld = event.down;
		break;
	case GameInputEvent::Right:
		mDownHeld = event.down;
		break;
	}
}

void PongEngine::tick(int dtMs) {
	const double dt = clampd((double)dtMs, 0.0, 250.0);
	mElapsedMs += dt;
	const bool confirm = mConfirmEdge;
	mConfirmEdge = false;

	if (mPhase == GameHud::Playing && mPaused) return;

	// Held buttons integrate into the paddle-centre target (web tracked the
	// pointer before its phase checks; the target persists the same way).
	const int sign = (mDownHeld ? 1 : 0) - (mUpHeld ? 1 : 0);
	if (sign != 0) {
		mKeyTargetY = clampd(mKeyTargetY + sign * kKeyPaddleSpeed * (dt / 1000.0),
			0.0, (double)kGameH);
	}
	mLeftY = paddleTopFor(mKeyTargetY);

	if (mPhase == GameHud::Ready) {
		if (!confirm) return;
		mPhase = GameHud::Playing;
		serve(mRandom.next() < 0.5);
	} else if (mPhase == GameHud::Over) {
		mOverMs += dt;
		if (confirm && mOverMs >= kRestartLockMs) resetState();
		return;
	}

	mAccumulatorMs += dt;
	while (mAccumulatorMs >= kStepMs && mPhase == GameHud::Playing) {
		mAccumulatorMs -= kStepMs;
		step(kStepMs / 1000.0);
	}
}

void PongEngine::serve(bool towardLeft) {
	const double angle = (mRandom.next() * 2.0 - 1.0) * kPi / 6.0;
	const double s = speed();
	mBallX = kMidX;
	mBallY = kCenterY;
	mBallVx = (towardLeft ? -1.0 : 1.0) * std::cos(angle) * s;
	mBallVy = std::sin(angle) * s;
	mServeDelayMs = 0.0;
}

void PongEngine::step(double dtSeconds) {
	trackWithAi(dtSeconds);  // no gamepad on the device: the AI always drives
	if (mServeDelayMs > 0.0) {
		mServeDelayMs -= dtSeconds * 1000.0;
		if (mServeDelayMs <= 0.0) serve(mServeTowardLeft);
		return;
	}

	double nextX = mBallX + mBallVx * dtSeconds;
	double nextY = mBallY + mBallVy * dtSeconds;

	if (nextY < 0.0) {
		nextY = -nextY;
		mBallVy = std::fabs(mBallVy);
	} else if (nextY > kGameH - 1.0) {
		nextY = 2.0 * (kGameH - 1.0) - nextY;
		mBallVy = -std::fabs(mBallVy);
	}

	if (mBallVx < 0.0 && mBallX >= kLeftPlane && nextX < kLeftPlane && catches(mLeftY, nextY)) {
		nextX = 2.0 * kLeftPlane - nextX;
		bounce(mLeftY, nextY, 1);
	} else if (mBallVx > 0.0 && mBallX <= kRightPlane && nextX > kRightPlane
		&& catches(mRightY, nextY)) {
		nextX = 2.0 * kRightPlane - nextX;
		bounce(mRightY, nextY, -1);
	}

	mBallX = nextX;
	mBallY = nextY;

	if (nextX < -0.5) awardPoint(false);
	else if (nextX > kGameW - 0.5) awardPoint(true);
}

bool PongEngine::catches(double paddleTop, double y) const {
	return y >= paddleTop - 0.5 && y <= paddleTop + kPaddleHeight - 0.5;
}

void PongEngine::bounce(double paddleTop, double y, int towardRight) {
	const double center = paddleTop + kPaddleHeight / 2.0 - 0.5;
	const double offset = clampd((y - center) / (kPaddleHeight / 2.0), -1.0, 1.0);
	const double angle = offset * kPi / 3.0;
	const double s = speed();
	mBallVx = towardRight * std::cos(angle) * s;
	mBallVy = std::sin(angle) * s;
}

void PongEngine::awardPoint(bool leftScored) {
	if (leftScored) mScoreLeft += 1;
	else mScoreRight += 1;

	mBallX = kMidX;
	mBallY = kCenterY;
	mBallVx = 0.0;
	mBallVy = 0.0;
	if (mScoreLeft >= kWinScore || mScoreRight >= kWinScore) {
		mPhase = GameHud::Over;
		mOverMs = 0.0;
		mAccumulatorMs = 0.0;
		mServeDelayMs = 0.0;
		return;
	}
	// The loser of the round receives the next serve.
	mServeTowardLeft = !leftScored;
	mServeDelayMs = kServeDelayMs;
}

void PongEngine::trackWithAi(double dtSeconds) {
	const double center = mRightY + kPaddleHeight / 2.0;
	const double target = mServeDelayMs > 0.0 ? kCenterY : mBallY;
	const double reach = kAiSpeed * dtSeconds;
	mRightY = clampd(mRightY + clampd(target - center, -reach, reach),
		0.0, (double)(kGameH - kPaddleHeight));
}

bool PongEngine::blink(double periodMs) const {
	return ((long)(mElapsedMs / periodMs)) % 2 == 0;
}

void PongEngine::renderMidline(Surface& s, bool dim) {
	const Color& c = dim ? kDimMidline : kMidline;
	for (int y = 0; y < kGameH; ++y) {
		if (y % 3 == 2) continue;
		s.setPixel((int)kMidX, y, c);
	}
}

void PongEngine::renderScores(Surface& s) {
	char left[12];
	char right[12];
	snprintf(left, sizeof(left), "%d", mScoreLeft);
	snprintf(right, sizeof(right), "%d", mScoreRight);
	drawText3x5(s, left, (int)kMidX - 4 - textWidth3x5(left), 1, kScoreDim);
	drawText3x5(s, right, (int)kMidX + 4, 1, kScoreDim);
}

void PongEngine::render(Surface& s) {
	// Background stays truly off (black) — the caller supplies a cleared surface.
	if (mPhase == GameHud::Over) {
		renderMidline(s, true);
		const bool leftWon = mScoreLeft > mScoreRight;
		char finalText[16];
		snprintf(finalText, sizeof(finalText), "%d-%d", mScoreLeft, mScoreRight);
		drawCenteredText3x5(s, leftWon ? "P1 WIN" : "AI WIN",
			2, leftWon ? kLeftPaddle : kRightPaddle);
		drawCenteredText3x5(s, finalText, 9, kFinalScore);
		return;
	}

	renderScores(s);
	renderMidline(s, false);
	fillRect(s, kLeftColumn, (int)jsRound(mLeftY), 1, kPaddleHeight, kLeftPaddle);
	fillRect(s, kRightColumn, (int)jsRound(mRightY), 1, kPaddleHeight, kRightPaddle);

	// The ball blinks while it waits on the centre spot, and on the attract screen.
	const bool waiting = mPhase == GameHud::Ready || mServeDelayMs > 0.0;
	if (!waiting || blink(360.0)) {
		s.setPixel(clampi((int)jsRound(mBallX), 0, kGameW - 1),
			clampi((int)jsRound(mBallY), 0, kGameH - 1), kBall);
	}
	// Sits below the centre spot so the blinking ball stays visible.
	if (mPhase == GameHud::Ready && blink(500.0)) drawCenteredText3x5(s, "PONG", 10, kTitle);
	if (mPhase == GameHud::Playing && mPaused && blink(500.0))
		drawCenteredText3x5(s, "PAUSE", 6, kPrompt);
}

GameHud PongEngine::hud() const {
	GameHud h;
	h.score = mScoreLeft;
	h.lives = -1;
	h.phase = mPhase;
	return h;
}
