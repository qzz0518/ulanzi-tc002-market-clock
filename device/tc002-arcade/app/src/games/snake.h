#ifndef GAMES_SNAKE_H_
#define GAMES_SNAKE_H_

#include <stdint.h>
#include <vector>
#include "games/engine.h"
#include "utils/Surface.h"
#include "games/support.h"

// Direct port of web/src/lib/games/snake.ts. Physics constants verbatim
// (12 cells/s, +8% per 5 food capped at 26, digit bonus food, 180-degree
// reversal rejected against the last committed direction). Input adaptation:
// knob ccw/cw (and left/right buttons) turn relative to the queued heading;
// knob-press/middle pauses while playing and confirms on ready/over screens.
class SnakeEngine : public GameEngine {
public:
	struct Cell {
		int x, y;
	};

	SnakeEngine();
	virtual ~SnakeEngine();

	virtual const char* id() const override { return "snake"; }
	virtual const char* title() const override { return "SNAKE"; }
	virtual void reset() override;
	virtual void onInput(const GameInputEvent& event) override;
	virtual void tick(int dtMs) override;
	virtual void render(Surface& surface) override;
	virtual GameHud hud() const override;

	// Deterministic food placement for the host selfcheck.
	void seedRandom(uint32_t seed) { mRandom.seed(seed); }

	// Exposed for the host selfcheck.
	int headX() const { return mCells[0].x; }
	int headY() const { return mCells[0].y; }
	int length() const { return (int)mCells.size(); }
	bool foodIsDigit() const { return mFoodIsDigit; }
	const std::vector<Cell>& foodCells() const { return mFoodCells; }
	bool paused() const { return mPaused; }

private:
	enum Direction { DirUp, DirDown, DirLeft, DirRight };

	void resetState();
	void step();
	void gameOver();
	void queueDirection(Direction direction);
	void turn(int sign);  // -1 = ccw (turn left), +1 = cw (turn right)
	void spawnFood();
	bool spawnDigitFood();
	void spawnDotFood();
	double speedCells() const;
	double stepMs() const;
	int level() const;
	bool blink(double periodMs) const;
	void renderFood(Surface& s, bool dim);
	void renderSnake(Surface& s, bool dim);
	void renderGameOver(Surface& s);

	int mScore;
	int mEaten;
	GameHud::Phase mPhase;
	std::vector<Cell> mCells;  // head first, tail last
	Direction mDirection;
	Direction mPendingDirection;
	bool mFoodIsDigit;
	std::vector<Cell> mFoodCells;
	int mGrowth;
	double mAccumulatorMs;
	double mElapsedMs;
	double mOverMs;
	bool mConfirmEdge;
	bool mTurnEdge;  // a turn input arrived since last tick (starts the run too)
	bool mPaused;
	arcadegames::GameRandom mRandom;
};

#endif  // GAMES_SNAKE_H_
