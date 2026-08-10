#ifndef GAMES_FLAPPY_H_
#define GAMES_FLAPPY_H_

#include <stdint.h>
#include <vector>
#include "games/engine.h"
#include "utils/Surface.h"
#include "games/support.h"

// Direct port of web/src/lib/games/flappy.ts. Physics constants verbatim
// (gravity 42, jump -18 absolute, pipe width 3 / spacing 18, gap 7→5,
// ground row y=15). Input adaptation: any button down = flap; on the
// game-over screen only knob-press/middle restarts (left exits via GamePage).
class FlappyEngine : public GameEngine {
public:
	FlappyEngine();
	virtual ~FlappyEngine();

	virtual const char* id() const override { return "flappy"; }
	virtual const char* title() const override { return "FLAPPY"; }
	virtual void reset() override;
	virtual void onInput(const GameInputEvent& event) override;
	virtual void tick(int dtMs) override;
	virtual void render(Surface& surface) override;
	virtual GameHud hud() const override;

	// Deterministic pipe layout for the host selfcheck.
	void seedRandom(uint32_t seed) { mRandom.seed(seed); }

	// Exposed for the host selfcheck.
	double birdTop() const { return mBirdY; }
	double birdVelocity() const { return mVelocity; }
	int pipeCount() const { return (int)mPipes.size(); }

private:
	struct Pipe {
		double x;    // left edge; floats so the scroll stays smooth
		int gapTop;  // first row of the gap
		int gap;     // frozen at spawn time
		bool scored;
	};

	void resetState();
	void step(double dtSeconds);
	bool hitsGround() const;
	bool hitsPipe() const;
	void refillPipes();
	double speed() const;
	int gapSize() const;
	bool blink(double periodMs) const;
	void renderPipes(Surface& s, bool dim);
	void renderGround(Surface& s, bool dim);
	void renderBird(Surface& s, int top, bool dim);
	void renderGameOver(Surface& s);

	int mScore;
	GameHud::Phase mPhase;
	double mBirdY;  // top edge of the 2x2 bird
	double mVelocity;
	std::vector<Pipe> mPipes;
	double mScrolled;
	double mAccumulatorMs;
	double mElapsedMs;
	double mOverMs;
	bool mFlapEdge;     // any button down since last tick
	bool mConfirmEdge;  // knob-press/middle down since last tick (restart)
	arcadegames::GameRandom mRandom;
};

#endif  // GAMES_FLAPPY_H_
