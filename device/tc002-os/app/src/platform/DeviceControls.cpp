#include "platform/DeviceControls.h"

#include <utils/BrightnessHelper.h>

#include "base/log.h"

namespace tcos {

namespace {

int clampInt(int value, int lo, int hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

}  // namespace

DeviceControls::DeviceControls() : mVolume(3), mBrightnessStep(5), mInitialized(false) {}

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
}

int DeviceControls::nudgeVolume(int delta) {
  mVolume = clampInt(mVolume + delta, 0, kVolumeMax);
  // Volume deliberately does NOT touch the audio stack here. Linking it pulls
  // ffmpeg in — measured at ~1.1 MB .text plus 856 KB .bss on a device with
  // about 1 MB free — so with AUDIO=0 the level is tracked and shown, and the
  // sink is wired when the audio build flag is turned on.
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
