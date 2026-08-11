#include "ui/GameScreen.h"

namespace tcos {

GameScreen::GameScreen() : mEngine(0), mLastTickMs(0), mExitRequested(false) {}

void GameScreen::setEngine(GameEngine* engine) {
  mEngine = engine;
}

void GameScreen::onEnter(int nowMs) {
  mLastTickMs = nowMs;
  mExitRequested = false;
  // Every entry starts at the attract screen. Resuming a half-played game the
  // user walked away from would be a surprise, and the engines have no notion
  // of being paused.
  if (mEngine != 0) mEngine->reset();
}

void GameScreen::onExit() {
  mExitRequested = false;
}

bool GameScreen::takeExitRequest() {
  const bool v = mExitRequested;
  mExitRequested = false;
  return v;
}

bool GameScreen::isAnimating(int nowMs) const {
  (void)nowMs;
  return mEngine != 0;
}

void GameScreen::render(Surface& out, int nowMs) {
  out.clear();
  if (mEngine == 0) return;

  // The engines integrate real time, so the elapsed slice comes from the same
  // clock the Shell renders with. Clamped because a stalled tick — a slow poll,
  // a long SPI write — must not teleport a ball through a paddle.
  int dt = nowMs - mLastTickMs;
  if (dt < 0) dt = 0;
  if (dt > 250) dt = 250;
  mLastTickMs = nowMs;

  mEngine->tick(dt);
  mEngine->render(out);
}

bool GameScreen::onInput(Input input, int nowMs) {
  (void)nowMs;
  if (mEngine == 0) return false;

  // A hold always leaves, in every phase.
  //
  // The first version only exited when the game was NOT playing, on the theory
  // that a long press belonged to the game. That was wrong: every engine acts on
  // the DOWN edge of a press (`if (!event.down) break;`) or on the held state of
  // Left/Right, and none reads a hold. Since the side buttons now reach the
  // engine raw, the only key that can produce a hold here is the confirm button,
  // whose in-game action is a tap. The result of getting this wrong was a game
  // you could enter and not leave.
  if (input == kInputHold) {
    mExitRequested = true;
    return true;
  }

  GameInputEvent event;
  event.down = true;
  switch (input) {
    case kInputTurnCw: event.kind = GameInputEvent::KnobCw; break;
    case kInputTurnCcw: event.kind = GameInputEvent::KnobCcw; break;
    case kInputPress: event.kind = GameInputEvent::KnobPress; break;
    default: return false;  // side buttons arrive through onRawButton
  }
  mEngine->onInput(event);
  // The engines act on the down edge of a press and ignore its release, and
  // knob detents carry no release at all — so nothing is synthesised here.
  return true;
}

void GameScreen::onRawButton(Input which, bool down, int nowMs) {
  (void)nowMs;
  if (mEngine == 0) return;
  GameInputEvent event;
  event.down = down;
  if (which == kInputLeft) event.kind = GameInputEvent::Left;
  else if (which == kInputRight) event.kind = GameInputEvent::Right;
  else return;
  // Both edges, unsynthesised: the engines integrate how long a direction is
  // held (mLeftHeld = event.down), so a press followed instantly by its own
  // release moves the paddle for zero milliseconds — which is exactly what the
  // side buttons did before.
  mEngine->onInput(event);
}

}  // namespace tcos
