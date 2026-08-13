#ifndef UI_LEVELCONTROL_H_
#define UI_LEVELCONTROL_H_

#include "net/StateDoc.h"
#include "ui/LevelOverlay.h"

namespace tcos {

/**
 * The two stepped levels, as everything that moves them needs to see them.
 *
 * DeviceControls is the only production implementation, and one more indirection
 * in front of a singleton would normally not earn its keep. It earns it here
 * because DeviceControls.cpp reaches into the FlyThings audio manager: any
 * translation unit that names it can be compiled for the device and nowhere
 * else. That is exactly how the wrong-bar bug shipped — the console branch was
 * written inline in osLogic.cc, which no host check compiles (by FlyThings
 * convention the logic sources are `#include`d by an activity, so they are not
 * translation units of their own), and a mirrored copy in the self-check cannot
 * fail when only the original is wrong.
 *
 * With this seam the decisions below are ordinary host-compilable code, so
 * `mise run os-hostcheck` runs the same lines the device runs.
 */
class LevelControls {
 public:
  virtual ~LevelControls() {}

  virtual int volume() const = 0;
  virtual int brightness() const = 0;

  /** Applies a delta and returns the new level. Clamping belongs to the impl. */
  virtual int nudgeVolume(int delta) = 0;
  virtual int nudgeBrightness(int delta) = 0;
};

/**
 * Moves one level and raises its bar.
 *
 * Every path that changes volume or brightness goes through here — side
 * buttons, long press, and the console — so the kind → (nudge, bar, scale)
 * mapping exists once. A second copy of that mapping in the console branch is
 * what drew a brightness bar for a volume change.
 *
 * `showBar` is the one thing the console needs that a button does not: a single
 * document can move BOTH levels and the panel has one bar, so the field that
 * did not win the bar is still applied, quietly. It defaults to true so a
 * physical press cannot accidentally acquire the quiet behaviour.
 */
void adjustLevel(LevelControls& controls, LevelOverlay& hud, bool brightness,
                 int delta, int nowMs, bool showBar = true);

/**
 * A short press on a side button: whatever the HUD is showing decides which
 * control moves.
 *
 * The bar is a transient mode, not just a readout. Once a long press (or a
 * console brightness change) has opened brightness, further short presses keep
 * adjusting brightness until it expires — snapping back to volume
 * mid-adjustment would mean holding the button for every single step, and would
 * silently change the wrong thing when the user did not.
 */
void applyShortPress(LevelControls& controls, LevelOverlay& hud, int delta, int nowMs);

/**
 * Applies the console's settings block, at most once per rising sequence.
 *
 * The document keeps carrying the last request forever, so re-applying it every
 * poll would make the physical knob useless — the volume would spring back the
 * instant the user let go. WHICH level to act on is planSettings' decision; this
 * is only the wiring from that plan to the device, and the wiring is what was
 * wrong before.
 *
 * Returns true when the request was acted on, i.e. when `appliedSeq` moved.
 */
bool applyConsoleSettings(const SettingsRequest& request, int& appliedSeq,
                          LevelControls& controls, LevelOverlay& hud, int nowMs);

}  // namespace tcos

#endif  // UI_LEVELCONTROL_H_
