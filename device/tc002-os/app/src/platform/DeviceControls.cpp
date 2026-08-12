#include "platform/DeviceControls.h"

#include <utils/BrightnessHelper.h>

#include "audio_manager.h"

#include "base/log.h"
#include "platform/Prefs.h"

namespace tcos {

namespace {

int clampInt(int value, int lo, int hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

}  // namespace

DeviceControls::DeviceControls()
    : mVolume(5), mDirtySinceMs(-1), mBrightnessStep(5), mInitialized(false) {}

DeviceControls& DeviceControls::instance() {
  static DeviceControls single;
  return single;
}

void DeviceControls::initialize() {
  if (mInitialized) return;
  mInitialized = true;

  // Restore what the user chose last time. This is the whole reason prefs
  // exist: flashed, a reboot is an ordinary event rather than something that
  // hands the device back to another firmware, so "my volume resets every time"
  // is a real complaint and was one.
  //
  // The panel's current level is the fallback, not the source of truth. Reading
  // it was the original design and it was pure sideload reasoning — it assumed
  // the stock app had already applied the user's setting, which is exactly the
  // inheritance this firmware keeps getting caught by.
  const int max = BRIGHTNESSHELPER->getMaxBrightness();
  const int current = BRIGHTNESSHELPER->getBrightness();
  int adopted = mBrightnessStep;
  if (max > 0) {
    adopted = clampInt((current * kBrightnessSteps + max / 2) / max, 1, kBrightnessSteps);
  }
  mBrightnessStep = clampInt(prefs::getInt("brightness", adopted), 1, kBrightnessSteps);
  mVolume = clampInt(prefs::getInt("volume", mVolume), 0, kVolumeMax);
  if (max > 0) {
    // Apply it, rather than merely remembering it: on a flashed boot nothing
    // else has ever written this node.
    BRIGHTNESSHELPER->setBrightness((mBrightnessStep * max) / kBrightnessSteps);
  }
  LOGD("tcos controls: brightness %d/%d -> step %d", current, max, mBrightnessStep);
  base::AudioManager::instance().setVolume((mVolume * kMixerMax) / kVolumeMax);
  // Paired with the setVolume above: without it a mute inherited from the
  // previous firmware would silence a session that never touches the volume
  // keys, and the only cure would be pressing volume-down to 0 and back.
  base::AudioManager::instance().setMute(false);
}

int DeviceControls::nudgeVolume(int delta) {
  mVolume = clampInt(mVolume + delta, 0, kVolumeMax);
  prefs::setInt("volume", mVolume);
  // The device's own 0..6 notch scale, mapped onto the mixer's 0..100. The
  // sound effects are synthesised rather than decoded, so this costs the
  // resampler and mixer but not ffmpeg (see platform/Sfx.cpp).
  base::AudioManager::instance().setVolume((mVolume * kMixerMax) / kVolumeMax);
  base::AudioManager::instance().setMute(mVolume == 0);
  return mVolume;
}

int DeviceControls::nudgeBrightness(int delta) {
  mBrightnessStep = clampInt(mBrightnessStep + delta, 1, kBrightnessSteps);
  prefs::setInt("brightness", mBrightnessStep);
  const int max = BRIGHTNESSHELPER->getMaxBrightness();
  if (max > 0) {
    // Floor at one step: zero would black the panel out with no way to see the
    // bar that would let the user turn it back up.
    BRIGHTNESSHELPER->setBrightness((mBrightnessStep * max) / kBrightnessSteps);
  }
  return mBrightnessStep;
}

void DeviceControls::flushIfDue(int nowMs) {
  if (!prefs::dirty()) {
    mDirtySinceMs = -1;
    return;
  }
  if (mDirtySinceMs < 0) {
    mDirtySinceMs = nowMs;
    return;
  }
  if (nowMs - mDirtySinceMs < kFlushDelayMs) return;
  mDirtySinceMs = -1;
  prefs::commit();
}

}  // namespace tcos
