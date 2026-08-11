#ifndef CORE_PRESENTER_H_
#define CORE_PRESENTER_H_

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
  void present(const Surface& surface);

  // Milliseconds the panel needs between two writes. The MCU drops frames
  // below this; measured and documented by the arcade firmware as 15 ms.
  static int minFrameIntervalMs() { return 15; }

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

#endif  // CORE_PRESENTER_H_
