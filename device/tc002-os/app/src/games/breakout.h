#ifndef GAMES_BREAKOUT_H_
#define GAMES_BREAKOUT_H_

#include <vector>
#include "games/engine.h"
#include "utils/Surface.h"

// Direct port of web/src/lib/games/breakout.ts (BreakoutGame + BreakoutEngine).
// All physics constants are copied verbatim — they are hardware-verified.
// Input differs by design: the web samples a pointer, the device integrates
// knob detents (2px, x2 within 150ms same-direction) and held L/R buttons
// (40 px/s) into a paddle-centre target.
class BreakoutEngine : public GameEngine {
public:
	BreakoutEngine();
	virtual ~BreakoutEngine();

	virtual const char* id() const override { return "breakout"; }
	virtual const char* title() const override { return "BREAKOUT"; }
	virtual void reset() override;
	virtual void onInput(const GameInputEvent& event) override;
	virtual void tick(int dtMs) override;
	virtual void render(Surface& surface) override;
	virtual GameHud hud() const override;

	// Exposed for the host selfcheck.
	int bricksLeft() const { return (int)mSim.bricks.size(); }
	double ballX() const { return mSim.ballX; }
	double ballY() const { return mSim.ballY; }
	double paddleX() const { return mSim.paddleX; }
	bool paused() const { return mPaused; }

private:
	struct Brick {
		int x, y, w, h;
		Color color;
		bool digit;  // time-digit brick scores 30, filler scores 10
	};

	// Mirrors web BreakoutGame — the verified simulation.
	struct Sim {
		int score;
		int lives;
		int level;
		bool over;  // web sim phase: "playing" | "game-over"
		double paddleX;
		int paddleWidth;
		double ballX, ballY, ballVx, ballVy;
		std::vector<Brick> bricks;
		int destroyed;
		double accumulatorMs;

		void reset(int width);
		void tick(double dtMs, double paddleTargetX);
		void step(double dtSeconds);
		double speed() const;
		void applySpeed(double speed);
		void startBall();
		void loseLife();
		void nextLevel();
		void buildBricks();
	};

	void begin();
	double resolvePaddleTarget(double dtMs);
	void renderSim(Surface& s);
	void renderGameOver(Surface& s);
	bool blink(double periodMs) const;

	Sim mSim;
	int mPaddleWidth;
	GameHud::Phase mPhase;
	double mElapsedMs;
	double mGameOverAtMs;
	double mKeyTargetX;  // paddle centre target, 0..52
	bool mLeftHeld;
	bool mRightHeld;
	bool mStartEdge;  // knob-press/middle down since last tick (web pressedEdge)
	bool mPaused;
	int mLastKnobDir;       // +1 cw, -1 ccw, 0 none
	double mLastKnobAtMs;   // elapsed timestamp of the previous detent
	int mReadyHH, mReadyMM;  // attract board clock, rebuilt on minute roll
};

#endif  // GAMES_BREAKOUT_H_
