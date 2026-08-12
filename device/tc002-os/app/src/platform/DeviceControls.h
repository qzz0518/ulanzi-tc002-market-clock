#ifndef PLATFORM_DEVICECONTROLS_H_
#define PLATFORM_DEVICECONTROLS_H_

namespace tcos {

/**
 * Volume and panel brightness, as the rest of the firmware sees them.
 *
 * Both are stepped rather than continuous, because the only input is a button
 * press: a user cannot aim at "63%", and a bar with more steps than the panel
 * can draw is a bar that appears not to move.
 *
 * The two scales differ on purpose. Volume matches the device's own 0..6 notch
 * scale, the same one the official firmware's /setConfig exposes, so a level set
 * here means the same thing after a power cycle back to the official app.
 * Brightness is 0..100 in the hardware API but stepped in tens — below about 10
 * the LED matrix is effectively off, and single-percent steps are invisible.
 */
class DeviceControls {
 public:
  static const int kVolumeMax = 6;

  // The mixer's ceiling, measured on the device rather than assumed: setVolume
  // accepts 0 and 50 verbatim and clamps anything above 50 back to 50. Mapping
  // the six notches onto 0..100 therefore pinned notches 3 through 6 all to the
  // same maximum, so four of the six steps did nothing.
  static const int kMixerMax = 50;
  static const int kBrightnessSteps = 10;

  static DeviceControls& instance();

  /** Reads whatever the device is currently set to. Safe before any write. */
  void initialize();

  int volume() const { return mVolume; }
  int brightness() const { return mBrightnessStep; }

  /** Applies a delta and pushes it to the hardware. Returns the new level. */
  int nudgeVolume(int delta);
  int nudgeBrightness(int delta);

  /**
   * Writes pending changes to /data, but only once the user has stopped
   * turning the knob.
   *
   * Called from the render tick. The debounce is not politeness: /data is jffs2
   * on raw NAND, so committing on every detent would put a flash erase in the
   * input path — audibly, since the volume keys are the ones being held.
   */
  void flushIfDue(int nowMs);

  /** How long after the last change the value is committed. */
  static const int kFlushDelayMs = 2000;

 private:
  DeviceControls();
  DeviceControls(const DeviceControls&);
  DeviceControls& operator=(const DeviceControls&);

  int mVolume;
  int mDirtySinceMs;  // -1 when there is nothing to write
  int mBrightnessStep;
  bool mInitialized;
};

}  // namespace tcos

#endif  // PLATFORM_DEVICECONTROLS_H_
