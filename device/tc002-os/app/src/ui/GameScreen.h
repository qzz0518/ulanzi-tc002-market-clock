#ifndef UI_GAMESCREEN_H_
#define UI_GAMESCREEN_H_

#include "games/engine.h"
#include "ui/Screen.h"

namespace tcos {

/**
 * Hosts one arcade GameEngine as a Shell screen.
 *
 * The seven engines are compiled in unchanged from device/tc002-arcade: they are
 * hardware-verified, their physics constants are ports of the web engines, and
 * the arcade's own 668-line self-check already asserts every one. Porting them
 * would fork that guarantee for nothing.
 *
 * The adapter's whole job is the input contract. While a game is Playing the
 * engine owns the buttons, so the Shell's global "hold to go up" must not fire
 * mid-game — a long press is part of several games' vocabulary. Exit is
 * therefore a deliberately longer hold, and it is only offered while the game is
 * NOT playing, or the player would leave every time they held a direction.
 */
class GameScreen : public Screen {
 public:
  // Longer than the Shell's 600 ms, so an in-game hold cannot be mistaken for
  // "leave". Matches the arcade firmware's own exit gesture.
  static const int kExitHoldMs = 1200;

  GameScreen();

  void setEngine(GameEngine* engine);
  GameEngine* engine() const { return mEngine; }

  void onEnter(int nowMs);
  void onExit();
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

  /** True once the player has asked to leave; reading it clears the request. */
  bool takeExitRequest();

 private:
  GameEngine* mEngine;
  int mLastTickMs;
  bool mExitRequested;
};

}  // namespace tcos

#endif  // UI_GAMESCREEN_H_
