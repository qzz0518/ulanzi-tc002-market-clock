#ifndef GAMES_PONG_H_
#define GAMES_PONG_H_

#include <stdint.h>
#include "games/engine.h"
#include "utils/Surface.h"
#include "games/support.h"

// Direct port of web/src/lib/games/pong.ts. Physics constants verbatim
// (paddle height 4, ball 20 px/s x1.05 per round, AI capped at 13 px/s,
// 9-point match, 500ms serve hold). The device has no WS gamepad, so the
// right paddle is always the AI. Input adaptation mirrors breakout, mapped
// onto the left paddle's centre y: one knob detent = 2px (x2 within 150ms
// same direction), held left/right buttons move up/down at 40 px/s.
class PongEngine : public GameEngine {
public:
	PongEngine();
	virtual ~PongEngine();

	virtual const char* id() const override { return "pong"; }
	virtual const char* title() const override { return "PONG"; }
	virtual void reset() override;
	virtual void onInput(const GameInputEvent& event) override;
	virtual void tick(int dtMs) override;
	virtual void render(Surface& surface) override;
	virtual GameHud hud() const override;

	// Deterministic serve angles for the host selfcheck.
	void seedRandom(uint32_t seed) { mRandom.seed(seed); }

	// Exposed for the host selfcheck.
	int scoreLeft() const { return mScoreLeft; }
	int scoreRight() const { return mScoreRight; }
	double leftTop() const { return mLeftY; }
	double rightTop() const { return mRightY; }
	bool paused() const { return mPaused; }

private:
	void resetState();
	void serve(bool towardLeft);
	void step(double dtSeconds);
	bool catches(double paddleTop, double y) const;
	void bounce(double paddleTop, double y, int towardRight);
	void awardPoint(bool leftScored);
	void trackWithAi(double dtSeconds);
	double speed() const;
	int rounds() const;
	bool blink(double periodMs) const;
	void renderMidline(Surface& s, bool dim);
	void renderScores(Surface& s);

	int mScoreLeft;
	int mScoreRight;
	GameHud::Phase mPhase;
	double mLeftY;   // top edge
	double mRightY;  // top edge
	double mBallX, mBallY, mBallVx, mBallVy;
	double mServeDelayMs;
	bool mServeTowardLeft;
	double mAccumulatorMs;
	double mElapsedMs;
	double mOverMs;
	double mKeyTargetY;  // left paddle centre target, 0..16
	bool mUpHeld;        // left button
	bool mDownHeld;      // right button
	bool mConfirmEdge;
	bool mPaused;
	int mLastKnobDir;
	double mLastKnobAtMs;
	arcadegames::GameRandom mRandom;
};

#endif  // GAMES_PONG_H_
