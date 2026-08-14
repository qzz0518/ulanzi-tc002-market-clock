#ifndef UI_UPGRADEOVERLAY_H_
#define UI_UPGRADEOVERLAY_H_

#include "core/Surface.h"

namespace tcos {

/**
 * What the panel says while a firmware image is being downloaded and installed.
 *
 * An OVERLAY on the Shell, exactly like ui/LevelOverlay and for a stronger form
 * of the same reason: an install must survive navigation, and it must not change
 * what 「返回」 means. You cannot walk away from a flash, so it cannot be a place
 * you can be — and pushing a Screen for it would put one on the stack that the
 * hold gesture could pop out from under a device that is about to reboot.
 *
 * It TAKES THE PANEL, rather than dimming what is underneath the way the volume
 * bar does. On 52x16 there is exactly one 12 px text row, so a banner over a
 * running channel would be a banner INSTEAD of the channel; and the device is
 * seconds away from tearing every service down and rebooting, which is the one
 * thing on this display that outranks whatever was on it.
 *
 * The bottom row is the evidence that it is alive. A download is the longest
 * span in this firmware during which nothing else on the panel moves, and a
 * frozen ZOS is indistinguishable from a bricked one to the person watching:
 * the rail fills with the bytes that have landed, and a single lit pixel sweeps
 * the part that has not — the same idiom ui/ProvisionScreen uses for 「working
 * on it」, so a stalled transfer still reads as a device that is running.
 *
 * Deterministic in (stage, percent, nowMs), like every Screen here, so the host
 * self-check can assert its pixels.
 *
 * NOT SHOWN WHILE THE PANEL IS ASLEEP, and deliberately not special-cased to
 * be: 夜间息屏 skips shell().render() entirely, so a 3 a.m. install is silent.
 * osLogic treats a rising upgrade request as activity for exactly that reason —
 * a human pressed a button, so the panel wakes and this is what they see.
 */
class UpgradeOverlay {
 public:
  enum Stage {
    kHidden,
    kDownloading,
    kInstalling,  // a whole image is staged; the vendor chain is next
    kFailed,      // nothing was staged, and nothing will be installed
  };

  // How long 更新失败 holds before the panel goes back to being a clock. Long
  // enough to be read by someone who looked up at the noise, short enough that
  // a failed attempt does not leave the device stuck showing an error nobody is
  // coming to clear.
  static const int kFailHoldMs = 8000;
  // One pass of the liveness pixel across the unfilled rail.
  static const int kSweepMs = 1400;

  UpgradeOverlay();

  /**
   * Sets the current stage. Idempotent: repeating a stage does not restart it,
   * so the caller can hand over the link's state on every tick without thinking
   * about edges.
   */
  void set(Stage stage, int percent, int nowMs);

  Stage stage() const { return mStage; }
  int percent() const { return mPercent; }

  bool visible(int nowMs) const;

  /** Replaces whatever is in `out`. See the class comment for why. */
  void render(Surface& out, int nowMs) const;

 private:
  Stage mStage;
  int mPercent;
  int mStageMs;  // when the current stage began, for the hold and the sweep
};

}  // namespace tcos

#endif  // UI_UPGRADEOVERLAY_H_
