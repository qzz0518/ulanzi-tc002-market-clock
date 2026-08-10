#ifndef GAMES_SHOOTER_H_
#define GAMES_SHOOTER_H_

#include <stdint.h>
#include <vector>
#include "games/engine.h"
#include "utils/Surface.h"
#include "games/support.h"

// Side-scrolling space shooter built for the device (no web counterpart;
// follows the pong knob-adaptation and flappy spawn-list patterns). The 5x3
// ship sits at x=2 and moves continuously in y: one knob detent = 2px (x2
// within 150ms same direction), held Left/Right buttons = 24 px/s up/down.
// Middle (or knob press) fires 3x1 bullets at 34 px/s, 140ms cooldown, at
// most 4 on screen. 4x3 enemies enter from the right at 10 px/s (x1.07 per
// 10 kills, cap 26); waves of 1-2 spawn every 1.2s (x0.95 per 10 kills,
// floor 0.5s). A kill scores 10; an enemy escaping past x=0 costs one of
// three lives.
class ShooterEngine : public GameEngine {
public:
	ShooterEngine();
	virtual ~ShooterEngine();

	virtual const char* id() const override { return "shooter"; }
	virtual const char* title() const override { return "SHOOTER"; }
	virtual void reset() override;
	virtual void onInput(const GameInputEvent& event) override;
	virtual void tick(int dtMs) override;
	virtual void render(Surface& surface) override;
	virtual GameHud hud() const override;

	// Deterministic waves for the host selfcheck.
	void seedRandom(uint32_t seed) { mRandom.seed(seed); }

	// Exposed for the host selfcheck.
	double shipTop() const { return mShipY; }
	int bulletCount() const { return (int)mBullets.size(); }
	int enemyCount() const { return (int)mEnemies.size(); }
	double enemyX(int i) const { return mEnemies[i].x; }
	int enemyY(int i) const { return mEnemies[i].y; }
	int kills() const { return mKills; }

private:
	struct Bullet {
		double x;  // left edge of the 3x1 shot
		int y;
	};
	struct Enemy {
		double x;  // left edge of the 4x3 hull
		int y;     // top edge
	};
	struct Boom {
		double x;  // centre
		int y;     // centre
		double ageMs;
	};

	void resetState();
	void step(double dtSeconds);
	void spawnWave();
	void scheduleWave();
	double enemySpeed() const;
	bool blink(double periodMs) const;
	void renderShip(Surface& s, int top);
	void renderBooms(Surface& s);
	void renderGameOver(Surface& s);

	int mScore;
	int mLives;
	int mKills;
	GameHud::Phase mPhase;
	double mShipY;  // top edge of the 5x3 ship, 0..13
	std::vector<Bullet> mBullets;
	std::vector<Enemy> mEnemies;
	std::vector<Boom> mBooms;
	double mCooldownMs;
	double mSpawnInMs;
	double mAccumulatorMs;
	double mElapsedMs;
	double mOverMs;
	bool mUpHeld;    // left button
	bool mDownHeld;  // right button
	bool mFireHeld;
	bool mFireEdge;
	bool mConfirmEdge;
	int mLastKnobDir;
	double mLastKnobAtMs;
	arcadegames::GameRandom mRandom;
};

#endif  // GAMES_SHOOTER_H_
