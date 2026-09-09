#ifndef UI_GAMESCREEN_H_
#define UI_GAMESCREEN_H_

#include "games/engine.h"
#include "ui/Screen.h"

namespace tcos {

/**
 * Hosts one arcade GameEngine as a Shell screen.
 *
 * The seven arcade engines are compiled in unchanged from device/tc002-arcade:
 * they are
 * hardware-verified, their physics constants are ports of the web engines, and
 * the arcade's own 668-line self-check already asserts every one. Porting them
 * would fork that guarantee for nothing.
 *
 * The adapter's whole job is the input contract. The side buttons reach the
 * engine raw, because engines integrate how long a direction is held; the knob
 * and confirm button arrive as completed gestures, because that is what the
 * engines act on. A hold always leaves — no engine reads one, and a game you can
 * enter but not leave is worse than any gesture conflict.
 */
class GameScreen : public Screen {
 public:
  GameScreen();

  void setEngine(GameEngine* engine);
  GameEngine* engine() const { return mEngine; }

  void onEnter(int nowMs);
  void onExit();
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

  // Games integrate held directions, so they take the raw edges.
  bool wantsRawButtons() const { return true; }
  void onRawButton(Input which, bool down, int nowMs);

  /** True once the player has asked to leave; reading it clears the request. */
  bool takeExitRequest();

 private:
  GameEngine* mEngine;
  int mLastTickMs;
  bool mExitRequested;
};

}  // namespace tcos

#endif  // UI_GAMESCREEN_H_
