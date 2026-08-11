#include "platform/Presenter.h"

#include <unistd.h>

#include <utils/SpiHelper.h>
#include <utils/GpioHelper.h>

#include "base/log.h"

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

void Presenter::present(const Surface& surface) {
  if (surface.getWidth() != kVisibleWidth || surface.getHeight() != kHeight) {
    LOGE_TRACE("presenter: refusing a %dx%d surface", surface.getWidth(), surface.getHeight());
    return;
  }

  surface.extractRGB(mRgb);
  const int visibleBytes = kVisibleWidth * 3;
  const int strideBytes = kStrideWidth * 3;
  // mPadded keeps its zeroed tail across frames, so only the visible run is
  // copied; the off-panel columns were zeroed once in the constructor.
  for (int y = 0; y < kHeight; ++y) {
    const uint8_t* src = &mRgb[y * visibleBytes];
    uint8_t* dst = &mPadded[y * strideBytes];
    for (int i = 0; i < visibleBytes; ++i) dst[i] = src[i];
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
