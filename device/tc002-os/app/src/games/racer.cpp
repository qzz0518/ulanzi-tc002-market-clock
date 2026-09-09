// Lane racer for the 52x16 matrix. Original device engine (no web port);
// timing follows the shared fixed-step pattern, spec in the G1 task brief.
#include "games/racer.h"

#include <cmath>
#include <cstdio>
#include <ctime>
#include "visual/PixelFont.h"

using namespace arcadegames;

namespace {

const double kStepMs = 1000.0 / 120.0;
const int kPlayerX = 4;   // left edge of the 4x3 player car
const int kCarW = 4;
const int kCarH = 3;
const double kBaseSpeed = 14.0;  // px/s at 0 dodges
const double kMaxSpeed = 34.0;
const double kSpeedStep = 1.08;  // per 10 dodged cars
const int kDodgePerStep = 10;
const int kDodgeScore = 10;
const double kSpawnMinMs = 900.0;   // wave interval at base speed...
const double kSpawnRangeMs = 700.0; // ...0.9..1.6s, scaled down by speed
const double kRestartLockMs = 600.0;
const double kCrashFlashMs = 60.0;  // 2 frames at the 30ms shell tick
const int kLaneCenter[4] = {2, 6, 10, 14};
const int kDividerY[3] = {4, 8, 12};

const Color kPlayerBody(0xC1FF3Du);
const Color kPlayerWindow(0xFFFFFFu);
const Color kCrashWhite(0xFFFFFFu);
// Secondary-tier traffic tints, one picked per car.
const Color kCarColors[3] = {Color(0xFF4D5Au), Color(0xFF8A2Au), Color(0xB66CFFu)};
const Color kLaneDot(0x2E3A46u);   // dark tier: road texture only
const Color kExhaust(0x73401Eu);   // dark tier: idle exhaust puff
const Color kOverTitle(0xFF4D5Au);
const Color kScoreColor(0xFFFFFFu);
const Color kPrompt(0xC1FF3Du);

long jsRound(double v) { return (long)std::floor(v + 0.5); }

}  // namespace

RacerEngine::RacerEngine() {
	mRandom.seed((uint32_t)::time(0) ^ 0x0ACE7C4Bu);
	resetState();
}

RacerEngine::~RacerEngine() {}

void RacerEngine::reset() {
	resetState();
}

void RacerEngine::resetState() {
	mScore = 0;
	mDodged = 0;
	mPhase = GameHud::Ready;
	mLane = 1;  // lane 2 of 4, centre y=6
	mCars.clear();
	mCrashX = 0.0;
	mCrashLane = 0;
	mScrolled = 0.0;
	mAccumulatorMs = 0.0;
	mElapsedMs = 0.0;
	mOverMs = 0.0;
	mConfirmEdge = false;
	scheduleWave();
}

double RacerEngine::speed() const {
	const double s = kBaseSpeed * std::pow(kSpeedStep, (double)(mDodged / kDodgePerStep));
	return s < kMaxSpeed ? s : kMaxSpeed;
}

void RacerEngine::changeLane(int delta) {
	mLane = clampi(mLane + delta, 0, 3);
}

void RacerEngine::onInput(const GameInputEvent& event) {
	switch (event.kind) {
	case GameInputEvent::KnobCw:  // next lane = down
		if (mPhase == GameHud::Playing) changeLane(1);
		break;
	case GameInputEvent::KnobCcw:  // previous lane = up
		if (mPhase == GameHud::Playing) changeLane(-1);
		break;
	case GameInputEvent::Left:  // up
		if (event.down && mPhase == GameHud::Playing) changeLane(-1);
		break;
	case GameInputEvent::Right:  // down
		if (event.down && mPhase == GameHud::Playing) changeLane(1);
		break;
	case GameInputEvent::KnobPress:
	case GameInputEvent::Middle:
		if (event.down && mPhase != GameHud::Playing) mConfirmEdge = true;
		break;
	}
}

void RacerEngine::scheduleWave() {
	// Constant pixel gap between waves; the time interval shrinks as the
	// traffic speeds up (0.9..1.6s at 14 px/s).
	mSpawnInMs = (kSpawnMinMs + mRandom.next() * kSpawnRangeMs) * (kBaseSpeed / speed());
}

void RacerEngine::spawnWave() {
	// One random lane, or two adjacent lanes; a wave never blocks more than
	// two of the four lanes, so a free lane always exists.
	const bool pair = mRandom.pick(2) == 1;
	int lanes[2];
	int count;
	if (pair) {
		lanes[0] = mRandom.pick(3);  // adjacent pairs (0,1) (1,2) (2,3)
		lanes[1] = lanes[0] + 1;
		count = 2;
	} else {
		lanes[0] = mRandom.pick(4);
		count = 1;
	}
	for (int i = 0; i < count; ++i) {
		Car car;
		car.x = (double)kGameW;
		car.lane = lanes[i];
		car.colorIndex = mRandom.pick(3);
		car.scored = false;
		mCars.push_back(car);
	}
}

void RacerEngine::tick(int dtMs) {
	const double dt = clampd((double)dtMs, 0.0, 250.0);
	mElapsedMs += dt;
	const bool confirm = mConfirmEdge;
	mConfirmEdge = false;

	if (mPhase == GameHud::Ready) {
		mScrolled += kBaseSpeed * (dt / 1000.0);  // road idles under the car
		if (confirm) mPhase = GameHud::Playing;
		return;
	}
	if (mPhase == GameHud::Over) {
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

void RacerEngine::step(double dtSeconds) {
	const double distance = speed() * dtSeconds;
	mScrolled += distance;

	for (int i = 0; i < (int)mCars.size(); ++i) {
		Car& car = mCars[i];
		car.x -= distance;
		if (!car.scored && car.x + kCarW <= (double)kPlayerX) {
			car.scored = true;
			mScore += kDodgeScore;
			mDodged += 1;
		}
	}
	// Drop cars once fully off screen.
	std::vector<Car> kept;
	kept.reserve(mCars.size());
	for (int i = 0; i < (int)mCars.size(); ++i)
		if (mCars[i].x + kCarW > -1.0) kept.push_back(mCars[i]);
	mCars.swap(kept);

	mSpawnInMs -= dtSeconds * 1000.0;
	if (mSpawnInMs <= 0.0) {
		spawnWave();
		scheduleWave();
	}

	// AABB against the player: lanes are 4px apart and cars 3px tall, so a
	// y overlap is exactly a same-lane overlap.
	for (int i = 0; i < (int)mCars.size(); ++i) {
		const Car& car = mCars[i];
		if (car.lane != mLane) continue;
		if (car.x < (double)(kPlayerX + kCarW) && (double)kPlayerX < car.x + kCarW) {
			mCrashX = car.x;
			mCrashLane = car.lane;
			mPhase = GameHud::Over;
			mOverMs = 0.0;
			mAccumulatorMs = 0.0;
			return;
		}
	}
}

bool RacerEngine::blink(double periodMs) const {
	return ((long)(mElapsedMs / periodMs)) % 2 == 0;
}

void RacerEngine::renderRoad(Surface& s) {
	// Sparse dashed lane dividers, scrolling with the traffic. Dark tier by
	// design: road texture only, never information.
	const int offset = (int)(((long)std::floor(mScrolled)) % 6);
	for (int i = 0; i < 3; ++i) {
		for (int x = 0; x < kGameW; ++x) {
			if ((x + offset) % 6 < 2) s.setPixel(x, kDividerY[i], kLaneDot);
		}
	}
}

void RacerEngine::renderPlayer(Surface& s, bool white) {
	const int cy = kLaneCenter[mLane];
	fillRect(s, kPlayerX, cy - 1, kCarW, kCarH, white ? kCrashWhite : kPlayerBody);
	if (!white) {
		s.setPixel(kPlayerX + 1, cy, kPlayerWindow);  // cabin
		s.setPixel(kPlayerX + 2, cy, kPlayerWindow);
	}
}

void RacerEngine::renderCars(Surface& s, bool white) {
	for (int i = 0; i < (int)mCars.size(); ++i) {
		const Car& car = mCars[i];
		const int left = (int)jsRound(car.x);
		const bool flash = white && car.lane == mCrashLane
			&& std::fabs(car.x - mCrashX) < 0.5;
		fillRect(s, left, kLaneCenter[car.lane] - 1, kCarW, kCarH,
			flash ? kCrashWhite : kCarColors[car.colorIndex]);
	}
}

void RacerEngine::renderGameOver(Surface& s) {
	drawCenteredText3x5(s, "OVER", 1, kOverTitle);
	char scoreText[12];
	snprintf(scoreText, sizeof(scoreText), "%d", mScore);
	drawCenteredText3x5(s, scoreText, 9, kScoreColor);
	if (mOverMs < kRestartLockMs || !blink(420.0)) return;
	for (int x = 0; x < kGameW; x += 2) s.setPixel(x, kGameH - 1, kPrompt);
}

void RacerEngine::render(Surface& s) {
	// Background stays truly off (black) — the caller supplies a cleared surface.
	if (mPhase == GameHud::Over) {
		if (mOverMs < kCrashFlashMs) {  // impact: 2 white frames
			renderRoad(s);
			renderCars(s, true);
			renderPlayer(s, true);
			return;
		}
		renderGameOver(s);
		return;
	}

	renderRoad(s);
	renderCars(s, false);
	renderPlayer(s, false);

	if (mPhase == GameHud::Ready) {
		// Idle exhaust puff behind the car (texture blink).
		if (blink(300.0)) s.setPixel(kPlayerX - 1, kLaneCenter[mLane], kExhaust);
		if (blink(500.0)) drawCenteredText3x5(s, "RACER", 5, kPrompt);
	}
}

GameHud RacerEngine::hud() const {
	GameHud h;
	h.score = mScore;
	h.lives = -1;
	h.phase = mPhase;
	return h;
}
