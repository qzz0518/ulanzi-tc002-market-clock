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

  const bool playing = mEngine->hud().phase == GameHud::Playing;

  // A hold only means "leave" when the game is not running. During play a long
  // press belongs to the game — several use it — and stealing it would eject the
  // player mid-rally.
  if (input == kInputHold) {
    if (playing) {
      GameInputEvent event;
      event.kind = GameInputEvent::Middle;
      event.down = true;
      mEngine->onInput(event);
      return true;
    }
    mExitRequested = true;
    return true;
  }

  GameInputEvent event;
  event.down = true;
  switch (input) {
    case kInputTurnCw: event.kind = GameInputEvent::KnobCw; break;
    case kInputTurnCcw: event.kind = GameInputEvent::KnobCcw; break;
    case kInputPress: event.kind = GameInputEvent::KnobPress; break;
    case kInputLeft: event.kind = GameInputEvent::Left; break;
    case kInputRight: event.kind = GameInputEvent::Right; break;
    default: return false;
  }
  mEngine->onInput(event);

  // Buttons report both edges to the engines; the Shell's vocabulary has only
  // the completed gesture, so the release is synthesised immediately. Knob
  // detents carry no release by contract.
  if (event.kind != GameInputEvent::KnobCw && event.kind != GameInputEvent::KnobCcw) {
    GameInputEvent release = event;
    release.down = false;
    mEngine->onInput(release);
  }
  return true;
}

}  // namespace tcos
