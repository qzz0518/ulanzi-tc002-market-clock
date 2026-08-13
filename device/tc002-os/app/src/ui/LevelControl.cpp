#include "ui/LevelControl.h"

// Only for the two scales. The header is FlyThings-free; it is DeviceControls.cpp
// that pulls in the audio manager, which is why this file may include it and
// still compile on the host.
#include "platform/DeviceControls.h"

namespace tcos {

void adjustLevel(LevelControls& controls, LevelOverlay& hud, bool brightness,
                 int delta, int nowMs, bool showBar) {
  if (brightness) {
    const int level = controls.nudgeBrightness(delta);
    if (showBar) {
      hud.show(LevelOverlay::kBrightness, level, DeviceControls::kBrightnessSteps, nowMs);
    }
  } else {
    const int level = controls.nudgeVolume(delta);
    if (showBar) {
      hud.show(LevelOverlay::kVolume, level, DeviceControls::kVolumeMax, nowMs);
    }
  }
}

void applyShortPress(LevelControls& controls, LevelOverlay& hud, int delta, int nowMs) {
  const bool brightness = hud.shortPressKind(nowMs) == LevelOverlay::kBrightness;
  adjustLevel(controls, hud, brightness, delta, nowMs);
}

bool applyConsoleSettings(const SettingsRequest& request, int& appliedSeq,
                          LevelControls& controls, LevelOverlay& hud, int nowMs) {
  // A sequence that went BACKWARDS is a restarted service, not a replay: the
  // hub's counters are plain instance state on the Mac and start again at 1
  // after `bun start`, while this device is still up holding the last number it
  // applied. Without this the console's volume slider silently does nothing
  // until it has been dragged as many times as it was before the restart, and
  // nothing surfaces that — the route answers 200 regardless. A replay repeats
  // a number rather than lowering it, so the guard below still holds.
  //
  // Same rule as applySleepRequest's, deliberately written twice rather than
  // shared: these are the two console writers, they are read by different
  // planners, and a shared helper would put the one line that decides whether a
  // remote escape hatch works behind an indirection.
  if (request.seq > 0 && request.seq < appliedSeq) appliedSeq = 0;
  if (request.seq <= appliedSeq) return false;

  // Planned before anything is applied: planSettings' legacy fallback compares
  // the request against the levels the device is still at, so reading them
  // after the first nudge would answer with the value just written.
  const SettingsPlan plan =
      planSettings(request, appliedSeq, controls.volume(), controls.brightness());
  appliedSeq = request.seq;

  // The deltas are computed against the live level for the same reason: the
  // request names an absolute level, adjustLevel takes a step.
  if (plan.applyVolume) {
    adjustLevel(controls, hud, false, request.volume - controls.volume(), nowMs,
                plan.bar == SettingsPlan::kVolumeBar);
  }
  if (plan.applyBrightness) {
    adjustLevel(controls, hud, true, request.brightness - controls.brightness(), nowMs,
                plan.bar == SettingsPlan::kBrightnessBar);
  }
  return true;
}

}  // namespace tcos
