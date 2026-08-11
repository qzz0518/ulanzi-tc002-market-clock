#include "ui/BootScreen.h"

#include "core/Ease.h"

namespace tcos {

namespace {

const int kSweepEndMs = 520;
const int kBloomEndMs = 1120;
const int kSettleEndMs = 1500;

// The accent the console uses for the device, so the panel and the studio read
// as one product. Kept as three ramps rather than a palette table: at boot the
// font and palette units may not be initialised yet.
inline Color accent(float level) {
  if (level <= 0.0f) return Color(0, 0, 0);
  if (level > 1.0f) level = 1.0f;
  // Green-dominant with a cyan lift in the highlights; the blue term only
  // engages in the top third so mid-brightness stays a clean green.
  const float lift = level > 0.66f ? (level - 0.66f) * 3.0f : 0.0f;
  const int r = static_cast<int>(level * level * 40.0f);
  const int g = static_cast<int>(level * 255.0f);
  const int b = static_cast<int>(lift * 120.0f);
  return Color(static_cast<unsigned char>(r),
               static_cast<unsigned char>(g),
               static_cast<unsigned char>(b));
}

}  // namespace

BootScreen::BootScreen() : mStartMs(0) {}

void BootScreen::onEnter(int nowMs) {
  mStartMs = nowMs;
}

bool BootScreen::isDone(int nowMs) const {
  return (nowMs - mStartMs) >= kSettleEndMs;
}

bool BootScreen::isAnimating(int nowMs) const {
  return !isDone(nowMs);
}

void BootScreen::render(Surface& out, int nowMs) {
  const int t = nowMs - mStartMs;
  out.clear();

  const int w = out.getWidth();
  const int h = out.getHeight();
  if (w <= 0 || h <= 0) return;
  const float midY = (h - 1) * 0.5f;

  if (t < kSweepEndMs) {
    // BEAT 1 — a head runs the full width on an ease-out so it decelerates into
    // the right edge, dragging a 7 px tail and leaving a dim trail behind.
    const float p = ease::outCubic(ease::progress(t, 0, kSweepEndMs));
    const float headX = p * (w - 1);
    for (int x = 0; x < w; ++x) {
      const float behind = headX - x;
      float level;
      if (behind < 0.0f) {
        level = 0.0f;                                  // ahead of the head
      } else if (behind < 1.0f) {
        level = 1.0f;                                  // the head itself
      } else if (behind < 7.0f) {
        level = 1.0f - (behind - 1.0f) / 6.0f;         // comet tail
        level = 0.18f + level * 0.82f;
      } else {
        level = 0.18f;                                 // persistent trail
      }
      if (level <= 0.0f) continue;
      // A 3 px band around the centre row; the head flares to full height so
      // the leading edge reads as a beam rather than a dot.
      const float flare = (behind >= 0.0f && behind < 1.5f) ? 1.0f : 0.0f;
      for (int y = 0; y < h; ++y) {
        const float dy = (y - midY) < 0 ? (midY - y) : (y - midY);
        float vertical;
        if (dy <= 1.5f) {
          vertical = 1.0f;
        } else if (flare > 0.0f) {
          vertical = 1.0f - (dy - 1.5f) / (midY + 1.0f);
          if (vertical < 0.0f) vertical = 0.0f;
        } else {
          continue;
        }
        out.setPixel(x, y, accent(level * vertical));
      }
    }
    return;
  }

  if (t < kBloomEndMs) {
    // BEAT 2 — the trail blooms vertically out of the centre row. The wavefront
    // travels top/bottom on an ease-in-out; behind it the panel holds at 55%.
    const float p = ease::inOutQuad(ease::progress(t, kSweepEndMs, kBloomEndMs - kSweepEndMs));
    const float front = p * (midY + 1.5f);
    for (int y = 0; y < h; ++y) {
      const float dy = (y - midY) < 0 ? (midY - y) : (y - midY);
      float level;
      if (dy <= front - 1.0f) {
        level = 0.55f;                                 // filled
      } else if (dy <= front) {
        level = 1.0f;                                  // the wavefront itself
      } else {
        continue;
      }
      for (int x = 0; x < w; ++x) {
        // A slow horizontal shimmer so the fill is not a flat slab.
        const float shimmer = 0.88f + 0.12f * ((x + (t / 24)) % 8 < 4 ? 1.0f : 0.0f);
        out.setPixel(x, y, accent(level * shimmer));
      }
    }
    return;
  }

  // BEAT 3 — collapse to a centred bar and dim out, leaving a quiet panel for
  // whichever screen the Shell cuts to.
  const float p = ease::inOutCubic(ease::progress(t, kBloomEndMs, kSettleEndMs - kBloomEndMs));
  const float halfWidth = ease::lerp(w * 0.5f, 3.0f, p);
  const float level = ease::lerp(0.75f, 0.0f, p);
  if (level <= 0.0f) return;
  const float centreX = (w - 1) * 0.5f;
  for (int x = 0; x < w; ++x) {
    const float dx = (x - centreX) < 0 ? (centreX - x) : (x - centreX);
    if (dx > halfWidth) continue;
    const float edge = halfWidth <= 0.0f ? 1.0f : 1.0f - (dx / halfWidth) * 0.35f;
    for (int y = 0; y < h; ++y) {
      const float dy = (y - midY) < 0 ? (midY - y) : (y - midY);
      if (dy > 1.5f) continue;
      out.setPixel(x, y, accent(level * edge));
    }
  }
}

}  // namespace tcos
