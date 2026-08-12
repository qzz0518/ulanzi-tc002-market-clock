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
 * Brightness is ten steps because that is what a button can aim at, and because
 * ten steps of 10% each land on exactly the same bytes the stock firmware emits
 * at its own deciles.
 *
 * BRIGHTNESS IS NOT A HARDWARE CALL. It used to be: this class drove
 * BRIGHTNESSHELPER->setBrightness(), the FlyThings SDK's LCD backlight helper,
 * which writes /sys/class/backlight/soc:backlight/brightness. This product has
 * no backlight — the display is an SPI LED matrix behind an MCU — and the stock
 * firmware proves the point twice over: its libzkgui.so imports no
 * BrightnessHelper symbol at all, and it dims by scaling the RGB bytes in
 * software before the SPI write. So that call was a control that looked like it
 * worked and changed nothing. brightness() is now simply the level Presenter
 * scales each frame by; see Presenter::scaleByte.
 */
class DeviceControls {
 public:
  static const int kVolumeMax = 6;

  // The mixer's ceiling, measured on the device rather than assumed: setVolume
  // accepts 0 and 50 verbatim and clamps anything above 50 back to 50. Mapping
  // the six notches onto 0..100 therefore pinned notches 3 through 6 all to the
  // same maximum, so four of the six steps did nothing.
  static const int kMixerMax = 50;

  // Must equal Presenter::kBrightnessSteps, which is the half that actually
  // dims pixels. Asserted in the host self-check; the two headers do not
  // include each other because this one drags in the audio manager.
  static const int kBrightnessSteps = 10;

  static DeviceControls& instance();

  /** Restores the stored levels and applies the volume one. Call once, early. */
  void initialize();

  int volume() const { return mVolume; }

  /** 1..kBrightnessSteps. Read by Presenter on every frame. */
  int brightness() const { return mBrightnessStep; }

  /**
   * Applies a delta and returns the new level.
   *
   * Volume reaches the mixer immediately; brightness reaches the panel on the
   * next frame, because it is applied by the renderer rather than by a device
   * call. Both persist through Prefs, debounced by flushIfDue.
   */
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
