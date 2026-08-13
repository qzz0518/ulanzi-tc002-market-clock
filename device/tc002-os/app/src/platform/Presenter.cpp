#include "platform/Presenter.h"

#include <unistd.h>

#include <utils/SpiHelper.h>
#include <utils/GpioHelper.h>

#include "base/log.h"
#include "platform/DeviceControls.h"

namespace tcos {

namespace {
// Panel geometry. The MCU always clocks in a 64-column row; columns 52..63 are
// off-panel and must still be sent, as zeroes.
const int kVisibleWidth = 52;
const int kStrideWidth = 64;
const int kHeight = 16;
const int kLatchSettleUs = 1000;
const int kFramePaceUs = 15 * 1000;
}  // namespace

struct Presenter::Impl {
  // 10 MHz, mode 0, 8 bits — the values the arcade firmware runs on hardware.
  Impl() : spi(0, SPI_MODE_0, 10 * 1000 * 1000, 8, false) {}
  SpiHelper spi;
};

Presenter::Presenter() : mImpl(new Impl()) {
  mRgb.reserve(kVisibleWidth * kHeight * 3);
  mPadded.assign(kStrideWidth * kHeight * 3, 0);
}

Presenter::~Presenter() {
  delete mImpl;
}

void Presenter::present(const Surface& surface, int fadePercent) {
  if (surface.getWidth() != kVisibleWidth || surface.getHeight() != kHeight) {
    LOGE_TRACE("presenter: refusing a %dx%d surface", surface.getWidth(), surface.getHeight());
    return;
  }

  surface.extractRGB(mRgb);
  const int visibleBytes = kVisibleWidth * 3;
  const int strideBytes = kStrideWidth * 3;

  // Software dimming. This panel has no backlight to turn down, so the only
  // lever is the byte values themselves — see Presenter::scaleByte. Read once
  // per frame, not once per pixel: the user changes it at button speed.
  //
  // The branch is hoisted out of the loop so the brightest step is provably the
  // same copy the firmware has always done, rather than a scale that happens to
  // be a no-op. Nothing may sit between here and spi.write() that touches the
  // bytes again.
  //
  // 夜间休眠's fade rides in the SAME loop, beside the brightness scale, for the
  // same reason: nothing new may sit between the render and spi.write() that
  // touches the bytes a second time. Both extremes keep their own fast path —
  // fadePercent 100 is byte-identical to what this always did, and 0 is a run
  // of zeroes with no per-byte arithmetic at all, which is what the panel is
  // sent once a second all night.
  const int step = DeviceControls::instance().brightness();
  const bool unscaled = step >= kBrightnessSteps && fadePercent >= 100;
  const bool blank = fadePercent <= 0;

  // mPadded keeps its zeroed tail across frames, so only the visible run is
  // copied; the off-panel columns were zeroed once in the constructor.
  for (int y = 0; y < kHeight; ++y) {
    const uint8_t* src = &mRgb[y * visibleBytes];
    uint8_t* dst = &mPadded[y * strideBytes];
    if (blank) {
      for (int i = 0; i < visibleBytes; ++i) dst[i] = 0;
    } else if (unscaled) {
      for (int i = 0; i < visibleBytes; ++i) dst[i] = src[i];
    } else {
      for (int i = 0; i < visibleBytes; ++i) dst[i] = dimByte(src[i], step, fadePercent);
    }
  }

  // The MCU samples this line to frame the transfer; it needs a settle window
  // before the first clock or it latches a torn row.
  GpioHelper::output("GPIO_35", 0);
  usleep(kLatchSettleUs);
  if (!mImpl->spi.write(&mPadded[0], static_cast<int>(mPadded.size()))) {
    LOGE_TRACE("presenter: spi write failed");
  }
  GpioHelper::output("GPIO_35", 1);


  // Frame pacing, not a lock. Nothing else contends for the bus because nothing
  // else in this firmware is allowed to write it.
  usleep(kFramePaceUs);
}

}  // namespace tcos
