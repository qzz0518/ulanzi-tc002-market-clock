#include "net/FrameBundle.h"

#include <algorithm>

#include "ui/Screen.h"

namespace tcos {

namespace {
const int kHeaderBytes = 8;
uint16_t readU16(const unsigned char* p) {
  return static_cast<uint16_t>(p[0] | (p[1] << 8));  // little endian, as ARM is
}
}  // namespace

FrameBundle::FrameBundle() : mWidth(0), mHeight(0), mTotalMs(0) {}

bool FrameBundle::parse(const std::string& body) {
  mDelays.clear();
  mPixels.clear();
  mWidth = 0;
  mHeight = 0;
  mTotalMs = 0;

  if (body.size() < static_cast<size_t>(kHeaderBytes)) return false;
  const unsigned char* p = reinterpret_cast<const unsigned char*>(body.data());
  if (p[0] != 'T' || p[1] != 'C' || p[2] != 'F' || p[3] != '1') return false;

  const int count = readU16(p + 4);
  const int width = p[6];
  const int height = p[7];

  // Validated against this panel, not trusted. The service shares a LAN with
  // everything else the user owns, and a bundle claiming 255x255x600 frames
  // would be a 117 MB allocation on a device with about 1 MB free.
  if (width != kPanelWidth || height != kPanelHeight) return false;
  if (count <= 0 || count > kMaxFrames) return false;

  const size_t pixelBytes = static_cast<size_t>(width) * height * 3;
  const size_t needed = static_cast<size_t>(kHeaderBytes) +
                        static_cast<size_t>(count) * (2 + pixelBytes);
  // A truncated body is rejected outright rather than played as far as it goes:
  // half a frame is a torn panel, and the poll will simply fetch it again.
  if (body.size() < needed) return false;

  mDelays.reserve(count);
  mPixels.resize(static_cast<size_t>(count) * pixelBytes);

  size_t offset = kHeaderBytes;
  for (int i = 0; i < count; ++i) {
    int delay = readU16(p + offset);
    offset += 2;
    if (delay < kMinDelayMs) delay = kMinDelayMs;  // never spin the play loop
    mDelays.push_back(static_cast<uint16_t>(delay));
    mTotalMs += delay;
    for (size_t b = 0; b < pixelBytes; ++b) {
      mPixels[static_cast<size_t>(i) * pixelBytes + b] = p[offset + b];
    }
    offset += pixelBytes;
  }
  mWidth = width;
  mHeight = height;
  return true;
}

int FrameBundle::delayMs(int index) const {
  if (index < 0 || index >= count()) return 0;
  return mDelays[index];
}

void FrameBundle::blit(int index, Surface& out) const {
  if (index < 0 || index >= count()) return;
  if (out.getWidth() != mWidth || out.getHeight() != mHeight) return;
  const size_t pixelBytes = static_cast<size_t>(mWidth) * mHeight * 3;
  const uint8_t* src = &mPixels[static_cast<size_t>(index) * pixelBytes];
  for (int y = 0; y < mHeight; ++y) {
    for (int x = 0; x < mWidth; ++x) {
      const size_t at = (static_cast<size_t>(y) * mWidth + x) * 3;
      out.setPixel(x, y, Color(src[at], src[at + 1], src[at + 2]));
    }
  }
}

int FrameBundle::indexAt(int elapsedMs) const {
  if (mDelays.empty() || mTotalMs <= 0) return -1;
  if (elapsedMs < 0) elapsedMs = 0;
  int t = elapsedMs % mTotalMs;
  for (size_t i = 0; i < mDelays.size(); ++i) {
    if (t < mDelays[i]) return static_cast<int>(i);
    t -= mDelays[i];
  }
  return static_cast<int>(mDelays.size()) - 1;
}

void FrameBundle::swap(FrameBundle& other) {
  mDelays.swap(other.mDelays);
  mPixels.swap(other.mPixels);
  std::swap(mWidth, other.mWidth);
  std::swap(mHeight, other.mHeight);
  std::swap(mTotalMs, other.mTotalMs);
}

}  // namespace tcos
