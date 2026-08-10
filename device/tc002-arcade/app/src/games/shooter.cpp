// Space shooter for the 52x16 matrix. Original device engine (no web port);
// timing follows the shared fixed-step pattern, spec in the G1 task brief.
#include "games/shooter.h"

#include <cmath>
#include <cstdio>
#include <ctime>
#include "visual/PixelFont.h"

using namespace arcadegames;

namespace {

const double kStepMs = 1000.0 / 120.0;
const int kShipX = 2;   // left edge of the 5x3 sprite (flame column)
const int kShipW = 5;
const int kShipH = 3;
const double kStartShipTop = 6.0;
const double kKeyShipSpeed = 24.0;  // px/s while a button is held
const double kKnobStepPx = 2.0;
const double kKnobFastStepPx = 4.0;  // x2 within the accel window
const double kKnobAccelWindowMs = 150.0;
const double kFireCooldownMs = 140.0;
const int kBulletW = 3;
const double kBulletSpeed = 34.0;  // px/s rightward
const int kMaxBullets = 4;
const int kEnemyW = 4;
const int kEnemyH = 3;
const double kEnemyBaseSpeed = 10.0;  // px/s at 0 kills
const double kEnemyMaxSpeed = 26.0;
const double kEnemySpeedStep = 1.07;  // per 10 kills
const int kKillsPerStep = 10;
const int kKillScore = 10;
const double kWaveBaseMs = 1200.0;
const double kWaveFactor = 0.95;  // per 10 kills
const double kWaveFloorMs = 500.0;
const int kStartLives = 3;
const double kBoomFrameMs = 40.0;  // 3 frames -> 120ms
const double kRestartLockMs = 600.0;

const Color kHull(0xD6F4FFu);       // primary tier: bright ice-blue hull
const Color kFlameA(0xFF8A2Au);     // secondary tier: engine flame, 2-frame blink
const Color kFlameB(0xFFD43Bu);
const Color kBullet(0xFFFFFFu);
const Color kEnemyBody(0xFF4D5Au);
const Color kEnemyCore(0x7B2930u);  // dark tier: cockpit texture dot
const Color kBoomCore(0xFFFFFFu);
const Color kBoomMid(0xFF8A2Au);
const Color kBoomEnd(0xB33A43u);
const Color kStarDim(0x2E3A46u);    // dark tier: attract backdrop texture
const Color kStarBright(0xFFFFFFu);
const Color kOverTitle(0x55B7E8u);
const Color kScoreColor(0xFFFFFFu);
const Color kPrompt(0xC1FF3Du);

const int kStars[10][2] = {
	{9, 2}, {20, 12}, {30, 4}, {44, 9}, {15, 8},
	{38, 14}, {48, 3}, {25, 1}, {6, 13}, {41, 6},
};

long jsRound(double v) { return (long)std::floor(v + 0.5); }

}  // namespace

ShooterEngine::ShooterEngine() {
	mRandom.seed((uint32_t)::time(0) ^ 0x5107733Bu);
	resetState();
}

ShooterEngine::~ShooterEngine() {}

void ShooterEngine::reset() {
	resetState();
}

void ShooterEngine::resetState() {
	mScore = 0;
	mLives = kStartLives;
	mKills = 0;
	mPhase = GameHud::Ready;
	mShipY = kStartShipTop;
	mBullets.clear();
	mEnemies.clear();
	mBooms.clear();
	mCooldownMs = 0.0;
	mSpawnInMs = kWaveBaseMs;
	mAccumulatorMs = 0.0;
	mElapsedMs = 0.0;
	mOverMs = 0.0;
	mUpHeld = false;
	mDownHeld = false;
	mFireHeld = false;
	mFireEdge = false;
	mConfirmEdge = false;
	mLastKnobDir = 0;
	mLastKnobAtMs = -1000.0;
}

double ShooterEngine::enemySpeed() const {
	const double s = kEnemyBaseSpeed
		* std::pow(kEnemySpeedStep, (double)(mKills / kKillsPerStep));
	return s < kEnemyMaxSpeed ? s : kEnemyMaxSpeed;
}

void ShooterEngine::scheduleWave() {
	double interval = kWaveBaseMs
		* std::pow(kWaveFactor, (double)(mKills / kKillsPerStep));
	if (interval < kWaveFloorMs) interval = kWaveFloorMs;
	mSpawnInMs = interval;
}

void ShooterEngine::spawnWave() {
	const int count = 1 + mRandom.pick(2);
	const int y1 = mRandom.pick(kGameH - kEnemyH + 1);
	Enemy e;
	e.x = (double)kGameW;
	e.y = y1;
	mEnemies.push_back(e);
	if (count == 2) {
		for (int attempt = 0; attempt < 8; ++attempt) {
			const int y2 = mRandom.pick(kGameH - kEnemyH + 1);
			if (y2 >= y1 - 2 && y2 <= y1 + 2) continue;  // would overlap in y
			Enemy f;
			f.x = (double)kGameW;
			f.y = y2;
			mEnemies.push_back(f);
			break;
		}
	}
}

void ShooterEngine::onInput(const GameInputEvent& event) {
	switch (event.kind) {
	case GameInputEvent::KnobCw:
	case GameInputEvent::KnobCcw: {
		if (mPhase != GameHud::Playing) break;
		const int dir = event.kind == GameInputEvent::KnobCw ? 1 : -1;  // cw = down
		double step = kKnobStepPx;
		if (dir == mLastKnobDir && mElapsedMs - mLastKnobAtMs <= kKnobAccelWindowMs)
			step = kKnobFastStepPx;
		mLastKnobDir = dir;
		mLastKnobAtMs = mElapsedMs;
		mShipY = clampd(mShipY + dir * step, 0.0, (double)(kGameH - kShipH));
		break;
	}
	case GameInputEvent::KnobPress:
	case GameInputEvent::Middle:
		if (event.down) {
			if (mPhase == GameHud::Playing) {
				mFireEdge = true;
				mFireHeld = true;
			} else {
				mConfirmEdge = true;
			}
		} else {
			mFireHeld = false;
		}
		break;
	case GameInputEvent::Left:  // up
		mUpHeld = event.down;
		break;
	case GameInputEvent::Right:  // down
		mDownHeld = event.down;
		break;
	}
}

void ShooterEngine::tick(int dtMs) {
	const double dt = clampd((double)dtMs, 0.0, 250.0);
	mElapsedMs += dt;
	const bool confirm = mConfirmEdge;
	const bool fire = mFireEdge;
	mConfirmEdge = false;
	mFireEdge = false;

	if (mPhase == GameHud::Ready) {
		if (confirm) mPhase = GameHud::Playing;
		return;
	}
	if (mPhase == GameHud::Over) {
		mOverMs += dt;
		if (confirm && mOverMs >= kRestartLockMs) resetState();
		return;
	}

	// Held buttons move the ship continuously; the knob already moved it in
	// onInput.
	const int sign = (mDownHeld ? 1 : 0) - (mUpHeld ? 1 : 0);
	if (sign != 0) {
		mShipY = clampd(mShipY + sign * kKeyShipSpeed * (dt / 1000.0),
			0.0, (double)(kGameH - kShipH));
	}

	// Fire: edge shoots immediately, holding autofires at the cooldown rate.
	mCooldownMs -= dt;
	if (mCooldownMs < 0.0) mCooldownMs = 0.0;
	if ((fire || mFireHeld) && mCooldownMs <= 0.0
		&& (int)mBullets.size() < kMaxBullets) {
		Bullet b;
		b.x = (double)(kShipX + kShipW);
		b.y = clampi((int)jsRound(mShipY) + 1, 0, kGameH - 1);  // nose row
		mBullets.push_back(b);
		mCooldownMs = kFireCooldownMs;
	}

	// Explosion sparks age out on wall time.
	std::vector<Boom> keptBooms;
	keptBooms.reserve(mBooms.size());
	for (int i = 0; i < (int)mBooms.size(); ++i) {
		mBooms[i].ageMs += dt;
		if (mBooms[i].ageMs < 3.0 * kBoomFrameMs) keptBooms.push_back(mBooms[i]);
	}
	mBooms.swap(keptBooms);

	mAccumulatorMs += dt;
	while (mAccumulatorMs >= kStepMs && mPhase == GameHud::Playing) {
		mAccumulatorMs -= kStepMs;
		step(kStepMs / 1000.0);
	}
}

void ShooterEngine::step(double dtSeconds) {
	for (int i = 0; i < (int)mBullets.size(); ++i)
		mBullets[i].x += kBulletSpeed * dtSeconds;

	const double es = enemySpeed();
	for (int i = 0; i < (int)mEnemies.size(); ++i)
		mEnemies[i].x -= es * dtSeconds;

	// Bullet vs enemy: first overlap wins, both despawn, a spark blooms.
	std::vector<bool> bulletDead(mBullets.size(), false);
	std::vector<bool> enemyDead(mEnemies.size(), false);
	for (int b = 0; b < (int)mBullets.size(); ++b) {
		for (int e = 0; e < (int)mEnemies.size(); ++e) {
			if (enemyDead[e]) continue;
			const Bullet& shot = mBullets[b];
			const Enemy& foe = mEnemies[e];
			if (shot.x < foe.x + kEnemyW && foe.x < shot.x + kBulletW
				&& shot.y >= foe.y && shot.y <= foe.y + kEnemyH - 1) {
				bulletDead[b] = true;
				enemyDead[e] = true;
				mScore += kKillScore;
				mKills += 1;
				Boom boom;
				boom.x = foe.x + kEnemyW / 2.0;
				boom.y = foe.y + 1;
				boom.ageMs = 0.0;
				mBooms.push_back(boom);
				break;
			}
		}
	}

	std::vector<Bullet> keptBullets;
	keptBullets.reserve(mBullets.size());
	for (int i = 0; i < (int)mBullets.size(); ++i)
		if (!bulletDead[i] && mBullets[i].x < (double)kGameW)
			keptBullets.push_back(mBullets[i]);
	mBullets.swap(keptBullets);

	std::vector<Enemy> keptEnemies;
	keptEnemies.reserve(mEnemies.size());
	for (int i = 0; i < (int)mEnemies.size(); ++i) {
		if (enemyDead[i]) continue;
		if (mEnemies[i].x + kEnemyW <= 0.0) {  // escaped past the left edge
			mLives -= 1;
			continue;
		}
		keptEnemies.push_back(mEnemies[i]);
	}
	mEnemies.swap(keptEnemies);

	if (mLives <= 0) {
		mLives = 0;
		mPhase = GameHud::Over;
		mOverMs = 0.0;
		mAccumulatorMs = 0.0;
		return;
	}

	mSpawnInMs -= dtSeconds * 1000.0;
	if (mSpawnInMs <= 0.0) {
		spawnWave();
		scheduleWave();
	}
}

bool ShooterEngine::blink(double periodMs) const {
	return ((long)(mElapsedMs / periodMs)) % 2 == 0;
}

void ShooterEngine::renderShip(Surface& s, int top) {
	// Hull: compact arrow pointing right; the leftmost column is the engine.
	fillRect(s, kShipX + 1, top, 2, 1, kHull);
	fillRect(s, kShipX + 1, top + 1, 4, 1, kHull);  // spine, nose at x=6
	fillRect(s, kShipX + 1, top + 2, 2, 1, kHull);
	// Engine flame: 2-frame blink in the secondary tier.
	s.setPixel(kShipX, top + 1, blink(70.0) ? kFlameA : kFlameB);
}

void ShooterEngine::renderBooms(Surface& s) {
	for (int i = 0; i < (int)mBooms.size(); ++i) {
		const Boom& boom = mBooms[i];
		const int cx = (int)jsRound(boom.x);
		const int cy = boom.y;
		const int frame = (int)(boom.ageMs / kBoomFrameMs);
		if (frame <= 0) {
			s.setPixel(cx, cy, kBoomCore);
		} else if (frame == 1) {
			s.setPixel(cx, cy, kBoomCore);
			s.setPixel(cx - 1, cy, kBoomMid);
			s.setPixel(cx + 1, cy, kBoomMid);
			s.setPixel(cx, cy - 1, kBoomMid);
			s.setPixel(cx, cy + 1, kBoomMid);
		} else {
			s.setPixel(cx - 1, cy - 1, kBoomEnd);
			s.setPixel(cx + 1, cy - 1, kBoomEnd);
			s.setPixel(cx - 1, cy + 1, kBoomEnd);
			s.setPixel(cx + 1, cy + 1, kBoomEnd);
		}
	}
}

void ShooterEngine::renderGameOver(Surface& s) {
	drawCenteredText3x5(s, "OVER", 1, kOverTitle);
	char lineText[20];
	snprintf(lineText, sizeof(lineText), "%d K%d", mScore, mKills);
	drawCenteredText3x5(s, lineText, 9, kScoreColor);
	if (mOverMs < kRestartLockMs || !blink(420.0)) return;
	for (int x = 0; x < kGameW; x += 2) s.setPixel(x, kGameH - 1, kPrompt);
}

void ShooterEngine::render(Surface& s) {
	// Background stays truly off (black) — the caller supplies a cleared surface.
	if (mPhase == GameHud::Over) {
		renderGameOver(s);
		return;
	}

	if (mPhase == GameHud::Ready) {
		// Star backdrop (dark texture) with two brighter twinkles.
		for (int i = 0; i < 10; ++i) {
			const bool twinkle = (i == 2 || i == 7) && blink(400.0);
			s.setPixel(kStars[i][0], kStars[i][1], twinkle ? kStarBright : kStarDim);
		}
		const double bob = std::sin(mElapsedMs / 300.0) * 1.5;
		renderShip(s, clampi((int)jsRound(kStartShipTop + bob), 0, kGameH - kShipH));
		if (blink(500.0)) drawCenteredText3x5(s, "SHOOTER", 5, kPrompt);
		return;
	}

	for (int i = 0; i < (int)mEnemies.size(); ++i) {
		const Enemy& foe = mEnemies[i];
		const int left = (int)jsRound(foe.x);
		fillRect(s, left, foe.y, kEnemyW, kEnemyH, kEnemyBody);
		s.setPixel(left + 1, foe.y + 1, kEnemyCore);  // cockpit texture dot
	}
	for (int i = 0; i < (int)mBullets.size(); ++i) {
		fillRect(s, (int)jsRound(mBullets[i].x), mBullets[i].y, kBulletW, 1, kBullet);
	}
	renderBooms(s);
	renderShip(s, (int)jsRound(mShipY));
}

GameHud ShooterEngine::hud() const {
	GameHud h;
	h.score = mScore;
	h.lives = mLives;
	h.phase = mPhase;
	return h;
}
