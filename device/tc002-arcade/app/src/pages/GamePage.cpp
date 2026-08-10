#include "pages/GamePage.h"

#include <string.h>
#include <vector>
#include "managers/KeyManager.h"
#include "managers/SfxManager.h"
#include "utils/Surface.h"

namespace {

// Long-press progress bar, arcade-red tiers from Palette SKIN_ARCADE.
const Color kExitBarFill(0xFF, 0x4C, 0x58);
const Color kExitBarBg(0x7B, 0x29, 0x30);

}  // namespace

GamePage::GamePage(const std::string& name)
	: PageBase(name),
	  mEngine(0),
	  mWantsExit(false),
	  mMiddleHeld(false),
	  mMiddleHeldMs(0) {}

GamePage::~GamePage() {}

void GamePage::setEngine(GameEngine* engine) {
	mEngine = engine;
}

void GamePage::onEnter() {
	mWantsExit = false;
	mMiddleHeld = false;
	mMiddleHeldMs = 0;
	if (mEngine) mEngine->reset();  // fresh attract screen on every entry
}

void GamePage::onExit() {
	mWantsExit = false;
	mMiddleHeld = false;
	mMiddleHeldMs = 0;
}

bool GamePage::onKeyEvent(int keyCode, int keyStatus) {
	// Dispatched from the UI tick (arcadeLogic drains the key queue there),
	// so no locking against tick()/draw() is needed.
	GameInputEvent event;
	event.down = keyStatus == 1;

	switch (keyCode) {
	case E_KEYCODE_CLOCKWISE:
		event.kind = GameInputEvent::KnobCw;
		event.down = true;  // rotation has no release edge
		break;
	case E_KEYCODE_ANTI_CLOCKWISE:
		event.kind = GameInputEvent::KnobCcw;
		event.down = true;
		break;
	case E_KEYCODE_KNOB_BUTTON:
		event.kind = GameInputEvent::KnobPress;
		break;
	case E_KEYCODE_LEFT_BUTTON:
		event.kind = GameInputEvent::Left;
		break;
	case E_KEYCODE_MIDDLE_BUTTON:
		event.kind = GameInputEvent::Middle;
		break;
	case E_KEYCODE_RIGHT_BUTTON:
		event.kind = GameInputEvent::Right;
		break;
	default:
		return true;
	}

	// Long-press exit gesture: middle button normally, but the shooter fires
	// by holding middle mid-run, so there the knob press carries the gesture
	// instead (its press edge still fires a shot; only a full 1.2s hold exits).
	const bool shooterRun = mEngine && strcmp(mEngine->id(), "shooter") == 0
		&& mEngine->hud().phase == GameHud::Playing;
	const GameInputEvent::Kind exitKind =
		shooterRun ? GameInputEvent::KnobPress : GameInputEvent::Middle;
	if (event.kind == GameInputEvent::Middle || event.kind == GameInputEvent::KnobPress) {
		if (event.kind == exitKind) {
			if (event.down) {
				mMiddleHeld = true;
				mMiddleHeldMs = 0;
			} else {
				mMiddleHeld = false;  // released early = cancelled
				mMiddleHeldMs = 0;
			}
		} else if (!event.down) {
			// The non-gesture trigger released: never leave a stale hold timer.
			mMiddleHeld = false;
			mMiddleHeldMs = 0;
		}
		// Shooter fire feel: a tick per trigger press-edge while playing.
		// Engines never play sfx themselves (shared-asset rule).
		if (event.down && shooterRun) {
			SfxManager::getInstance().play(SfxManager::SFX_TICK);
		}
	}

	// Left on the settlement screen returns to the menu (design §2.3);
	// the engines ignore Left there, so forwarding stays harmless.
	if (event.kind == GameInputEvent::Left && event.down
		&& mEngine && mEngine->hud().phase == GameHud::Over) {
		mWantsExit = true;
	}

	if (mEngine) mEngine->onInput(event);
	return true;
}

void GamePage::tick(int dtMs) {
	if (mMiddleHeld) {
		mMiddleHeldMs += dtMs;
		if (mMiddleHeldMs >= kExitHoldMs) mWantsExit = true;
	}

	if (!mEngine) return;
	mEngine->tick(dtMs);
}

void GamePage::draw() {
	Surface s(52, 16, Color(0, 0, 0));
	if (mEngine) mEngine->render(s);

	// Long-press progress bar on the top row; drawn only once the hold is
	// clearly intentional so ordinary taps do not flash it.
	if (mMiddleHeld && mMiddleHeldMs >= kExitBarShowMs) {
		for (int x = 0; x < 52; ++x) s.setPixel(x, 0, kExitBarBg);
		int w = 52 * mMiddleHeldMs / kExitHoldMs;
		if (w > 52) w = 52;
		for (int x = 0; x < w; ++x) s.setPixel(x, 0, kExitBarFill);
	}

	std::vector<uint8_t> data;
	s.extractRGB(data);
	sendLedData(data);
}
