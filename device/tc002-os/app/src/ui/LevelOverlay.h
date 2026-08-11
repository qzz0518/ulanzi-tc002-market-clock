#ifndef UI_LEVELOVERLAY_H_
#define UI_LEVELOVERLAY_H_

#include "core/Surface.h"

namespace tcos {

/**
 * The transient HUD for volume and brightness.
 *
 * Both adjustments are blind without it: the knob and the side buttons give no
 * feedback of their own, the speaker may be muted, and a brightness step on an
 * already-dim panel is easy to miss. So every change draws a bar.
 *
 * It is an OVERLAY, not a screen. Changing the volume must not take the user out
 * of whatever they were looking at, and pushing a screen for it would make the
 * back gesture ambiguous. It composites over the current frame and expires on
 * its own.
 *
 * Layout on 52x16: a 12x12 icon at x=0, a segmented bar filling x=14..51. The
 * bar is segmented rather than continuous because at 38 px a smooth fill cannot
 * be read as a value — discrete blocks can be counted at a glance.
 */
class LevelOverlay {
 public:
  enum Kind { kVolume, kBrightness };

  // Timings. The hold is long enough to read after the last press but short
  // enough that it never feels like the UI is stuck.
  static const int kEnterMs = 140;
  static const int kHoldMs = 1100;
  static const int kExitMs = 220;

  LevelOverlay();

  /** (Re)shows the bar. Repeated calls restart the hold without re-animating in. */
  void show(Kind kind, int value, int maxValue, int nowMs);

  bool visible(int nowMs) const;

  /** Composites over whatever is already in `out`. */
  void render(Surface& out, int nowMs) const;

  Kind kind() const { return mKind; }
  int value() const { return mValue; }

  /**
   * Which control a SHORT press should adjust right now.
   *
   * The bar is a transient mode, not just a readout. Once a long press has
   * opened brightness, further short presses keep adjusting brightness until it
   * expires — snapping back to volume mid-adjustment would mean the user has to
   * hold the button for every single step, and would silently change the wrong
   * thing when they did not.
   */
  Kind shortPressKind(int nowMs) const {
    return (visible(nowMs) && mKind == kBrightness) ? kBrightness : kVolume;
  }

 private:
  Kind mKind;
  int mValue;
  int mMax;
  int mShownMs;     // when the current appearance began
  int mLastPokeMs;  // when the value last changed
  bool mActive;
};

}  // namespace tcos

#endif  // UI_LEVELOVERLAY_H_
