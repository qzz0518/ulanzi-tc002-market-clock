#ifndef GAMES_RACER_H_
#define GAMES_RACER_H_

#include <stdint.h>
#include <vector>
#include "games/engine.h"
#include "utils/Surface.h"
#include "games/support.h"

// Lane racer built for the device (no web counterpart; follows the flappy
// fixed-step + spawn-list pattern). Four lanes with centres y=2/6/10/14; the
// player car (4x3) is pinned at x=4 and dodges oncoming 4x3 traffic entering
// at x=52. Traffic runs 14 px/s and gains x1.08 per 10 dodged cars (cap 34);
// each dodged car scores 10. Input is discrete: knob cw / Right = next lane
// (down), knob ccw / Left = previous lane (up); knob-press/middle confirms on
// the Ready/Over screens.
class RacerEngine : public GameEngine {
public:
	RacerEngine();
	virtual ~RacerEngine();

	virtual const char* id() const override { return "racer"; }
	virtual const char* title() const override { return "RACER"; }
	virtual void reset() override;
	virtual void onInput(const GameInputEvent& event) override;
	virtual void tick(int dtMs) override;
	virtual void render(Surface& surface) override;
	virtual GameHud hud() const override;

	// Deterministic traffic for the host selfcheck.
	void seedRandom(uint32_t seed) { mRandom.seed(seed); }

	// Exposed for the host selfcheck.
	int playerLane() const { return mLane; }
	int carCount() const { return (int)mCars.size(); }
	double carX(int i) const { return mCars[i].x; }
	int carLane(int i) const { return mCars[i].lane; }
	int dodged() const { return mDodged; }

private:
	struct Car {
		double x;        // left edge; floats so the scroll stays smooth
		int lane;        // 0..3
		int colorIndex;  // 0..2 into the traffic palette
		bool scored;
	};

	void resetState();
	void step(double dtSeconds);
	void spawnWave();
	void scheduleWave();
	double speed() const;
	void changeLane(int delta);
	bool blink(double periodMs) const;
	void renderRoad(Surface& s);
	void renderPlayer(Surface& s, bool white);
	void renderCars(Surface& s, bool white);
	void renderGameOver(Surface& s);

	int mScore;
	int mDodged;
	GameHud::Phase mPhase;
	int mLane;  // 0..3, starts on lane index 1 (lane 2 of 4)
	std::vector<Car> mCars;
	double mCrashX;   // left edge of the car that was hit (for the flash)
	int mCrashLane;
	double mSpawnInMs;
	double mScrolled;
	double mAccumulatorMs;
	double mElapsedMs;
	double mOverMs;
	bool mConfirmEdge;
	arcadegames::GameRandom mRandom;
};

#endif  // GAMES_RACER_H_
