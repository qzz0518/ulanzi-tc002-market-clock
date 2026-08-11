#ifndef NET_FRAMEBUNDLE_H_
#define NET_FRAMEBUNDLE_H_

#include <stdint.h>

#include <string>
#include <vector>

#include "core/Surface.h"

namespace tcos {

/**
 * Decoder for the bundle served by GET /api/os/frames.
 *
 * The official firmware receives a GIF and decodes it. Ours receives raw RGB:
 * adding a GIF decoder to re-encode pixels the service already has as pixels
 * would cost binary size and CPU for nothing.
 *
 * Every field is validated against this device rather than trusted — a bundle
 * claiming 200x200 or 65535 frames must be rejected, not allocated, because the
 * service is on the same LAN as anything else the user owns.
 */
class FrameBundle {
 public:
  FrameBundle();

  /** Replaces the contents. Returns false and leaves the bundle empty on junk. */
  bool parse(const std::string& body);

  int count() const { return static_cast<int>(mDelays.size()); }
  bool empty() const { return mDelays.empty(); }
  int delayMs(int index) const;

  /** Blits frame `index` into `out`. No-op when the index is out of range. */
  void blit(int index, Surface& out) const;

  /**
   * Index to show at `elapsedMs` into playback, looping. Returns -1 when empty.
   * Total duration is cached, so this is a walk of at most `count` steps rather
   * than a modulo over a recomputed sum every frame.
   */
  int indexAt(int elapsedMs) const;

  int totalDurationMs() const { return mTotalMs; }

  /**
   * Exchanges contents with `other` in constant time. A 360-frame bundle is
   * ~900 KB on a device with ~1 MB free, so handing one from the download
   * thread to the UI has to be a pointer swap; copying one would not merely be
   * slow, it would not fit.
   */
  void swap(FrameBundle& other);

  // Guard rails, exposed so the host self-check asserts the real values.
  static const int kMaxFrames = 600;
  static const int kMinDelayMs = 20;

 private:
  std::vector<uint16_t> mDelays;
  std::vector<uint8_t> mPixels;  // count * width * height * 3, contiguous
  int mWidth;
  int mHeight;
  int mTotalMs;
};

}  // namespace tcos

#endif  // NET_FRAMEBUNDLE_H_
