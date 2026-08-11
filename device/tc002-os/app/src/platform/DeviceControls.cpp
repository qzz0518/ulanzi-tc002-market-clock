#include "platform/DeviceControls.h"

#include <utils/BrightnessHelper.h>

#include "audio_manager.h"

#include "base/log.h"

namespace tcos {

namespace {

int clampInt(int value, int lo, int hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

}  // namespace

DeviceControls::DeviceControls() : mVolume(5), mBrightnessStep(5), mInitialized(false) {}

DeviceControls& DeviceControls::instance() {
  static DeviceControls single;
  return single;
}

void DeviceControls::initialize() {
  if (mInitialized) return;
  mInitialized = true;

  // Adopt the panel's current brightness instead of imposing a default: the
  // user may have set it from the official firmware before sideloading, and
  // snapping it on boot would be a visible, unexplained change.
  const int max = BRIGHTNESSHELPER->getMaxBrightness();
  const int current = BRIGHTNESSHELPER->getBrightness();
  if (max > 0) {
    mBrightnessStep = clampInt((current * kBrightnessSteps + max / 2) / max, 1, kBrightnessSteps);
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
  // The device's own 0..6 notch scale, mapped onto the mixer's 0..100. The
  // sound effects are synthesised rather than decoded, so this costs the
  // resampler and mixer but not ffmpeg (see platform/Sfx.cpp).
  base::AudioManager::instance().setVolume((mVolume * kMixerMax) / kVolumeMax);
  base::AudioManager::instance().setMute(mVolume == 0);
  return mVolume;
}

int DeviceControls::nudgeBrightness(int delta) {
  mBrightnessStep = clampInt(mBrightnessStep + delta, 1, kBrightnessSteps);
  const int max = BRIGHTNESSHELPER->getMaxBrightness();
  if (max > 0) {
    // Floor at one step: zero would black the panel out with no way to see the
    // bar that would let the user turn it back up.
    BRIGHTNESSHELPER->setBrightness((mBrightnessStep * max) / kBrightnessSteps);
  }
  return mBrightnessStep;
}

}  // namespace tcos
