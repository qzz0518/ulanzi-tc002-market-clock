#ifndef PLATFORM_PRESENTER_H_
#define PLATFORM_PRESENTER_H_

#include <stdint.h>
#include <vector>

#include "core/Surface.h"

namespace tcos {

/**
 * The only object in this firmware that touches the LED bus.
 *
 * The arcade firmware let four different pages call sendLedData() from a shared
 * PageBase, each holding one static mutex across the whole write — including the
 * mandatory 15 ms inter-frame sleep — so any other thread wanting the panel
 * stalled for a full frame. Here the panel has a single owner: screens render
 * into a Surface and hand it over, and only Presenter::present() writes SPI.
 *
 * That is not just tidiness. It is what makes the mirror feature possible with
 * one tee point, and what keeps every screen free of device headers so the host
 * self-check can compile them.
 */
class Presenter {
 public:
  Presenter();
  ~Presenter();

  // Blits a 52x16 surface to the panel. Blocks for the bus write plus the
  // frame-pacing sleep the MCU requires; call it from one thread only.
  //
  // The dimmer level is read from DeviceControls here rather than passed in, so
  // there is exactly one place that knows a frame can be dimmed and no caller
  // can forget to dim one. It is also what makes the stored brightness apply at
  // boot for free: the first frame after DeviceControls::initialize() is
  // already scaled, with no separate "push it to the hardware" step to miss.
  void present(const Surface& surface);

  // Milliseconds the panel needs between two writes. The MCU drops frames
  // below this; measured and documented by the arcade firmware as 15 ms.
  static int minFrameIntervalMs() { return 15; }

  // Dimmer steps. Must equal DeviceControls::kBrightnessSteps — asserted in the
  // host self-check, since the two headers deliberately do not include each
  // other (DeviceControls pulls in the audio manager).
  static const int kBrightnessSteps = 10;

  /**
   * One RGB byte, dimmed to `step` of kBrightnessSteps.
   *
   * WHY THIS EXISTS AT ALL. There is no backlight on this product to dim. The
   * panel is an SPI LED matrix behind an MCU, and the only way to make it
   * emit less light is to send smaller RGB bytes. The stock firmware does
   * exactly this: awtrix::LogicThread::drawAndSubmit() walks the extracted RGB
   * buffer doing `b = b * brightness / 100` before handing it to the SPI
   * thread. This is that, on a ten-notch scale instead of a percentage.
   *
   * INTEGER ONLY. 2496 bytes, 25 times a second, on a Cortex-A7 without a
   * fast divider — but mostly because every animation in this firmware is
   * asserted per-frame on the host, and float rounding is not guaranteed to
   * land on the same byte there as it does on ARM. `v * step / 10` is exact
   * everywhere and matches the stock's truncation at each decile.
   *
   * FLOOR OF 1. Dimming must not delete content: at step 1 a byte of 9 would
   * otherwise round to 0 and the pixel would simply vanish, which reads as a
   * bug, not as a dim panel. One is the smallest value that keeps the LED on.
   * We deliberately do NOT copy the stock's other trick here — its SPI writer
   * lifts every non-zero byte to a floor of 50 (`50 + (v-1)*205/254`, verified
   * in the shipped libzkgui.so). That is a panel-linearity correction applied
   * at every brightness including maximum, so adopting it would mean step 10
   * no longer emits what the renderer drew, which is the one thing the
   * brightest setting has to guarantee.
   *
   * Step kBrightnessSteps returns `value` unchanged, byte for byte.
   */
  static uint8_t scaleByte(uint8_t value, int step) {
    if (step >= kBrightnessSteps) return value;
    if (step < 1) step = 1;
    if (value == 0) return 0;  // black stays black; nothing is "lit" to keep
    const int scaled = (static_cast<int>(value) * step) / kBrightnessSteps;
    return static_cast<uint8_t>(scaled > 0 ? scaled : 1);
  }

 private:
  Presenter(const Presenter&);
  Presenter& operator=(const Presenter&);

  struct Impl;
  Impl* mImpl;

  // Scratch buffers kept alive across frames: the panel wants a 64-column
  // stride while the visible area is 52, and allocating 3 KB per frame at
  // ~50 fps on a 36 MB device is avoidable churn.
  std::vector<uint8_t> mRgb;
  std::vector<uint8_t> mPadded;
};

}  // namespace tcos

#endif  // PLATFORM_PRESENTER_H_
