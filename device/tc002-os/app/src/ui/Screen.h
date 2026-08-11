#ifndef UI_SCREEN_H_
#define UI_SCREEN_H_

#include "core/Surface.h"

namespace tcos {

// The panel, in pixels. Every screen composes into exactly this.
static const int kPanelWidth = 52;
static const int kPanelHeight = 16;

// Input vocabulary, decoupled from the MCU key codes so the whole UI stays
// host-testable. managers/KeyManager.h owns the wire values; Shell translates.
enum Input {
  kInputNone = 0,
  kInputTurnCw,
  kInputTurnCcw,
  kInputPress,      // knob or middle button, released before the hold threshold
  kInputHold,       // the same button, held past the threshold
  kInputLeft,
  kInputRight,
};

/**
 * A full-screen page.
 *
 * The single rule this firmware is built on: a Screen renders into a Surface
 * and NEVER touches the SPI bus, the framework, or a clock of its own. Time
 * arrives as a parameter. That is what lets every screen — and therefore every
 * animation — be compiled and asserted on the host with clang++, which matters
 * because the device's adbd is not always reachable and a pixel regression is
 * invisible until someone looks at the panel.
 *
 * `nowMs` is a monotonic millisecond clock supplied by the caller. Screens must
 * be pure functions of (state, nowMs): given the same pair they must produce
 * the same pixels, or the host golden frames stop meaning anything.
 */
class Screen {
 public:
  virtual ~Screen() {}

  virtual void render(Surface& out, int nowMs) = 0;

  // Called when the screen becomes visible; `nowMs` anchors its animations.
  virtual void onEnter(int nowMs) { (void)nowMs; }
  virtual void onExit() {}

  // Return true when the input was consumed and must not bubble to the Shell.
  virtual bool onInput(Input input, int nowMs) {
    (void)input;
    (void)nowMs;
    return false;
  }

  // Screens that animate ask to be re-rendered; static ones can idle the loop.
  virtual bool isAnimating(int nowMs) const {
    (void)nowMs;
    return true;
  }
};

}  // namespace tcos

#endif  // UI_SCREEN_H_
