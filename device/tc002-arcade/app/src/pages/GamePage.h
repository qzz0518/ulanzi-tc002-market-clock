#ifndef PAGES_GAMEPAGE_H_
#define PAGES_GAMEPAGE_H_

#include <string>
#include "pages/PageBase.h"
#include "games/engine.h"

// Hosts the current GameEngine: translates key events into GameInputEvents,
// draws the engine's frame, holds the middle-button long-press (1.2s) exit
// gesture, and reports a finished game's score exactly once.
// Driven by arcadeLogic in the PageBase pattern: tick(30) then draw() per
// UI timer slot; the logic polls wantsExitToMenu() after each tick.
class GamePage : public PageBase {
public:
	explicit GamePage(const std::string& name);
	virtual ~GamePage();

	virtual void draw() override;
	virtual void onEnter() override;
	virtual void onExit() override;
	virtual bool onKeyEvent(int keyCode, int keyStatus) override;

	// Non-owning; the logic keeps the engines alive. Resets the engine to its
	// attract screen on the next onEnter.
	void setEngine(GameEngine* engine);
	GameEngine* engine() const { return mEngine; }

	// Advance the engine and the long-press timer. dtMs must match the UI
	// timer period (30ms => 33fps).
	void tick(int dtMs = 30);

	// True when the player asked to leave (1.2s middle hold, or left button
	// on the game-over screen). Cleared on onEnter/onExit.
	bool wantsExitToMenu() const { return mWantsExit; }

private:
	static const int kExitHoldMs = 1200;
	static const int kExitBarShowMs = 250;

	GameEngine* mEngine;  // not owned
	bool mWantsExit;
	bool mMiddleHeld;
	int mMiddleHeldMs;
};

#endif  // PAGES_GAMEPAGE_H_
