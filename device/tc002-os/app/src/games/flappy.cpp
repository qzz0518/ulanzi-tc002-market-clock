// Direct port of web/src/lib/games/flappy.ts. Physics constants verbatim.
#include "games/flappy.h"

#include <cmath>
#include <cstdio>
#include <ctime>

using namespace arcadegames;

namespace {

const double kStepMs = 1000.0 / 120.0;
const int kBirdX = 12;               // FLAPPY_BIRD_X
const int kBirdSize = 2;             // FLAPPY_BIRD_SIZE
const double kGravity = 42.0;        // px/s^2
const double kJumpVelocity = -18.0;  // absolute velocity on every flap
const int kPipeWidth = 3;
const double kPipeSpacing = 18.0;
const double kBaseSpeed = 14.0;      // px/s at score 0
const double kSpeedStep = 1.06;
const int kScorePerStep = 5;
const int kMaxGap = 7;
const int kMinGap = 5;
const int kGroundY = kGameH - 1;     // bottom row is the ground strip
const int kFieldHeight = kGroundY;
const int kPipesOnField = 4;
const double kRestartLockMs = 600.0;
const double kStartBirdY = 6.0;

const Color kPipe(0x28C05Au);
const Color kPipeRim(0x7DFFA8u);
const Color kGround(0x3A2A12u);
const Color kGroundDash(0x7A5A26u);
const Color kBird(0xFFD43Bu);
const Color kBirdWing(0xFF8A2Au);
const Color kDimPipe(0x0F3320u);
const Color kDimRim(0x1C5535u);
const Color kDimGround(0x181207u);
const Color kDimBird(0x4A3F14u);
const Color kTitle(0x6F8296u);
const Color kScoreColor(0xFFFFFFu);
const Color kPrompt(0xC1FF3Du);

long jsRound(double v) { return (long)std::floor(v + 0.5); }

}  // namespace

FlappyEngine::FlappyEngine() {
	mRandom.seed((uint32_t)::time(0) ^ 0x46C0FFEEu);
	resetState();
}

FlappyEngine::~FlappyEngine() {}

void FlappyEngine::reset() {
	resetState();
}

void FlappyEngine::resetState() {
	mScore = 0;
	mPhase = GameHud::Ready;
	mBirdY = kStartBirdY;
	mVelocity = 0.0;
	mScrolled = 0.0;
	mAccumulatorMs = 0.0;
	mElapsedMs = 0.0;
	mOverMs = 0.0;
	mFlapEdge = false;
	mConfirmEdge = false;
	mPipes.clear();
	refillPipes();
}

void FlappyEngine::onInput(const GameInputEvent& event) {
	switch (event.kind) {
	case GameInputEvent::KnobPress:
	case GameInputEvent::Middle:
		if (event.down) {
			mFlapEdge = true;
			mConfirmEdge = true;
		}
		break;
	case GameInputEvent::Left:
	case GameInputEvent::Right:
		if (event.down) mFlapEdge = true;  // any key flaps; restart stays on confirm keys
		break;
	case GameInputEvent::KnobCw:
	case GameInputEvent::KnobCcw:
		break;  // rotation is unused in flappy (design §2.3)
	}
}

double FlappyEngine::speed() const {
	return kBaseSpeed * std::pow(kSpeedStep, (double)(mScore / kScorePerStep));
}

int FlappyEngine::gapSize() const {
	const int g = kMaxGap - mScore / kScorePerStep;
	return g > kMinGap ? g : kMinGap;
}

void FlappyEngine::tick(int dtMs) {
	const double dt = clampd((double)dtMs, 0.0, 250.0);
	mElapsedMs += dt;
	const bool flap = mFlapEdge;
	const bool confirm = mConfirmEdge;
	mFlapEdge = false;
	mConfirmEdge = false;

	if (mPhase == GameHud::Ready) {
		if (!flap) return;
		mPhase = GameHud::Playing;
		mVelocity = kJumpVelocity;
	} else if (mPhase == GameHud::Over) {
		mOverMs += dt;
		if (confirm && mOverMs >= kRestartLockMs) resetState();
		return;
	} else if (flap) {
		mVelocity = kJumpVelocity;
	}

	mAccumulatorMs += dt;
	while (mAccumulatorMs >= kStepMs && mPhase == GameHud::Playing) {
		mAccumulatorMs -= kStepMs;
		step(kStepMs / 1000.0);
	}
}

void FlappyEngine::step(double dtSeconds) {
	mVelocity += kGravity * dtSeconds;
	mBirdY += mVelocity * dtSeconds;
	if (mBirdY < 0.0) {
		mBirdY = 0.0;
		mVelocity = 0.0;
	}

	const double distance = speed() * dtSeconds;
	mScrolled += distance;
	for (int i = 0; i < (int)mPipes.size(); ++i) {
		Pipe& pipe = mPipes[i];
		pipe.x -= distance;
		if (!pipe.scored && pipe.x + kPipeWidth < kBirdX) {
			pipe.scored = true;
			mScore += 1;
		}
	}
	// filter: keep pipes with x + width > -1
	std::vector<Pipe> kept;
	kept.reserve(mPipes.size());
	for (int i = 0; i < (int)mPipes.size(); ++i)
		if (mPipes[i].x + kPipeWidth > -1.0) kept.push_back(mPipes[i]);
	mPipes.swap(kept);
	refillPipes();

	if (hitsGround() || hitsPipe()) {
		mPhase = GameHud::Over;
		mOverMs = 0.0;
		mAccumulatorMs = 0.0;
	}
}

bool FlappyEngine::hitsGround() const {
	return mBirdY + kBirdSize > kGroundY;
}

bool FlappyEngine::hitsPipe() const {
	for (int i = 0; i < (int)mPipes.size(); ++i) {
		const Pipe& pipe = mPipes[i];
		const bool overlapsX = pipe.x < kBirdX + kBirdSize && kBirdX < pipe.x + kPipeWidth;
		if (!overlapsX) continue;
		if (mBirdY < pipe.gapTop || mBirdY + kBirdSize > pipe.gapTop + pipe.gap) return true;
	}
	return false;
}

void FlappyEngine::refillPipes() {
	while ((int)mPipes.size() < kPipesOnField) {
		const double x = mPipes.empty() ? (double)kGameW : mPipes.back().x + kPipeSpacing;
		const int gap = gapSize();
		// Keep at least one solid row above and below so both stubs stay visible.
		int span = kFieldHeight - gap - 1;
		if (span < 1) span = 1;
		Pipe pipe;
		pipe.x = x;
		pipe.gap = gap;
		pipe.gapTop = 1 + mRandom.pick(span);
		pipe.scored = false;
		mPipes.push_back(pipe);
	}
}

bool FlappyEngine::blink(double periodMs) const {
	return ((long)(mElapsedMs / periodMs)) % 2 == 0;
}

void FlappyEngine::renderPipes(Surface& s, bool dim) {
	for (int i = 0; i < (int)mPipes.size(); ++i) {
		const Pipe& pipe = mPipes[i];
		const int left = (int)jsRound(pipe.x);
		for (int column = left; column < left + kPipeWidth; ++column) {
			if (column < 0 || column >= kGameW) continue;
			const Color& body = dim ? kDimPipe : kPipe;
			if (pipe.gapTop > 0) fillRect(s, column, 0, 1, pipe.gapTop, body);
			const int bottom = pipe.gapTop + pipe.gap;
			if (bottom < kFieldHeight) fillRect(s, column, bottom, 1, kFieldHeight - bottom, body);
			const Color& rim = dim ? kDimRim : kPipeRim;
			if (pipe.gapTop - 1 >= 0) s.setPixel(column, pipe.gapTop - 1, rim);
			if (bottom < kFieldHeight) s.setPixel(column, bottom, rim);
		}
	}
}

void FlappyEngine::renderGround(Surface& s, bool dim) {
	fillRect(s, 0, kGroundY, kGameW, 1, dim ? kDimGround : kGround);
	if (dim) return;
	const int offset = (int)(((long)std::floor(mScrolled)) % 4);
	for (int x = 3 - offset; x < kGameW; x += 4) {
		if (x < 0) continue;
		s.setPixel(x, kGroundY, kGroundDash);
	}
}

void FlappyEngine::renderBird(Surface& s, int top, bool dim) {
	const int y = clampi(top, 0, kFieldHeight - kBirdSize);
	fillRect(s, kBirdX, y, kBirdSize, kBirdSize, dim ? kDimBird : kBird);
	s.setPixel(kBirdX, y + 1, dim ? kDimBird : kBirdWing);
}

void FlappyEngine::renderGameOver(Surface& s) {
	drawCenteredText3x5(s, "OVER", 1, kTitle);
	char scoreText[12];
	snprintf(scoreText, sizeof(scoreText), "%d", mScore);
	drawCenteredText3x5(s, scoreText, 9, kScoreColor);
	if (mOverMs < kRestartLockMs || !blink(420.0)) return;
	for (int x = 0; x < kGameW; x += 2) s.setPixel(x, kGroundY, kPrompt);
}

void FlappyEngine::render(Surface& s) {
	// Sky stays truly off (black) — the caller supplies a cleared surface.
	const bool dim = mPhase == GameHud::Over;
	renderPipes(s, dim);
	renderGround(s, dim);

	if (mPhase == GameHud::Ready) {
		const double bob = std::sin(mElapsedMs / 260.0) * 1.4;
		renderBird(s, (int)jsRound(kStartBirdY + bob), false);
		if (blink(420.0)) drawText3x5(s, "FLAP", 30, 5, kPrompt);
		return;
	}

	renderBird(s, (int)jsRound(mBirdY), dim);
	if (dim) renderGameOver(s);
}

GameHud FlappyEngine::hud() const {
	GameHud h;
	h.score = mScore;
	h.lives = -1;
	h.phase = mPhase;
	return h;
}
