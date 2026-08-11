#include "ui/BootScreen.h"

#include <math.h>

#include "core/Ease.h"
#include "ui/ZosLogo.h"

namespace tcos {

namespace {

// "Ignition Trace": a spark gathers, its shockwave develops the wordmark out of
// embers, three pens trace the letters, the finished mark flashes and holds,
// then collapses like a CRT switching off.
const int kSparkEnd = 240;
const int kWaveEnd = 680;
const int kTraceEnd = 1540;
const int kFlashRiseEnd = 1600;
const int kFlashEnd = 1720;
const int kHoldEnd = 2180;
const int kCollapseMidEnd = 2320;
const int kCollapseEnd = 2460;

const float kCenterX = 25.5f;
const float kCenterY = 7.5f;

// Rounding is spelled out once and used everywhere: the host self-check asserts
// exact frames, so ARM and macOS must agree on every boundary pixel.
inline int roundToInt(float v) {
  return static_cast<int>(floorf(v + 0.5f));
}

inline unsigned char channel(float v) {
  if (v <= 0.0f) return 0;
  if (v >= 255.0f) return 255;
  return static_cast<unsigned char>(roundToInt(v));
}

const Color kBrandGreen(32, 255, 128);
const Color kWhite(255, 255, 255);
const Color kEmber(8, 60, 30);

Color mixColor(const Color& a, const Color& b, float t) {
  return Color(channel(ease::lerp(a.r, b.r, t)),
               channel(ease::lerp(a.g, b.g, t)),
               channel(ease::lerp(a.b, b.b, t)));
}

Color maxColor(const Color& a, const Color& b) {
  return Color(a.r > b.r ? a.r : b.r, a.g > b.g ? a.g : b.g, a.b > b.b ? a.b : b.b);
}

void plot(Surface& out, int x, int y, const Color& c) {
  if (x < 0 || y < 0 || x >= out.getWidth() || y >= out.getHeight()) return;
  out.setPixel(x, y, c);
}

// BEAT 1 — a spark grows, throws out cross arms, then snaps them back. The
// retraction is anticipation: without it the shockwave reads as arriving from
// nowhere.
void renderSpark(Surface& out, int t) {
  const int coreX[4] = {25, 26, 25, 26};
  const int coreY[4] = {7, 7, 8, 8};
  const int armX[8] = {24, 24, 27, 27, 25, 26, 25, 26};
  const int armY[8] = {7, 8, 7, 8, 6, 6, 9, 9};

  float coreLevel = 1.0f;
  float armLevel = 0.0f;
  if (t < 140) {
    coreLevel = ease::outQuad(ease::progress(t, 0, 140));
  } else if (t < 200) {
    armLevel = 0.6f * ease::linear(ease::progress(t, 140, 60));
  } else {
    armLevel = 0.6f * (1.0f - ease::linear(ease::progress(t, 200, 40)));
  }

  const Color core(channel(255.0f * coreLevel), channel(255.0f * coreLevel),
                   channel(235.0f * coreLevel));
  for (int i = 0; i < 4; ++i) plot(out, coreX[i], coreY[i], core);
  if (armLevel > 0.0f) {
    const Color arm(channel(255.0f * armLevel), channel(255.0f * armLevel),
                    channel(235.0f * armLevel));
    for (int i = 0; i < 8; ++i) plot(out, armX[i], armY[i], arm);
  }
}

// BEAT 2 — an expanding ring. Where it passes over the wordmark it leaves an
// ember, so the mark is "developed" by the wave rather than simply appearing.
void renderShockwave(Surface& out, int t) {
  const float p = ease::progress(t, kSparkEnd, kWaveEnd - kSparkEnd);
  const float radius = 29.0f * ease::outQuad(p);
  const float fade = 1.0f - 0.55f * p;

  for (int y = 0; y < out.getHeight(); ++y) {
    for (int x = 0; x < out.getWidth(); ++x) {
      const float dx = x - kCenterX;
      const float dy = y - kCenterY;
      const float d = sqrtf(dx * dx + dy * dy);

      Color c(0, 0, 0);
      const float fromFront = d - radius;
      const float absFront = fromFront < 0 ? -fromFront : fromFront;
      if (absFront < 1.6f) {
        const float i = (1.0f - absFront / 1.6f) * fade;
        c = Color(channel(180.0f * i), channel(255.0f * i), channel(215.0f * i));
      } else if (d > radius - 4.8f && d <= radius - 1.6f) {
        const float i = 0.25f * fade;
        c = Color(channel(180.0f * i), channel(255.0f * i), channel(215.0f * i));
      }

      // The ember stays once the front has passed; taking the channel-wise max
      // keeps this a pure function of t with no state to carry between frames.
      if (zoslogo::inkAt(x, y, 0, 0, 0) && d <= radius) c = maxColor(c, kEmber);
      if (c.r || c.g || c.b) plot(out, x, y, c);
    }
  }
}

// BEAT 3 — three pens, one per letter, run their strokes in step. Ahead of a
// pen the pixel is still an ember; at the tip it is white hot; behind it cools
// to the brand green over about three pixels of arc.
void renderTrace(Surface& out, int t) {
  const float front = ease::inOutQuad(ease::progress(t, kWaveEnd, kTraceEnd - kWaveEnd));
  for (int y = 0; y < out.getHeight(); ++y) {
    for (int x = 0; x < out.getWidth(); ++x) {
      int letter = 0;
      int lx = 0;
      int ly = 0;
      if (!zoslogo::inkAt(x, y, &letter, &lx, &ly)) continue;
      const int arc = zoslogo::arcOf(letter, lx, ly);
      if (arc < 0) continue;
      const float a = static_cast<float>(arc) / zoslogo::kArcMax[letter];

      if (a <= front - 0.10f) {
        plot(out, x, y, kBrandGreen);
      } else if (a <= front) {
        plot(out, x, y, mixColor(kWhite, kBrandGreen, (front - a) / 0.10f));
      } else {
        plot(out, x, y, kEmber);
      }
    }
  }
}

// BEAT 4 — the finished stroke ignites the whole mark: white, with a one-pixel
// halo, then annealing back to green.
void renderFlash(Surface& out, int t) {
  const bool rising = t < kFlashRiseEnd;
  const float rise = rising ? ease::outQuad(ease::progress(t, kTraceEnd, 60)) : 1.0f;
  const float fall = rising ? 0.0f : ease::outCubic(ease::progress(t, kFlashRiseEnd, 120));

  const float haloLevel = rising ? 90.0f * rise : 90.0f * (1.0f - fall);
  if (haloLevel > 0.0f) {
    const Color halo(channel(haloLevel), channel(haloLevel), channel(haloLevel));
    for (int y = 0; y < out.getHeight(); ++y) {
      for (int x = 0; x < out.getWidth(); ++x) {
        if (zoslogo::haloAt(x, y)) plot(out, x, y, halo);
      }
    }
  }

  for (int y = 0; y < out.getHeight(); ++y) {
    for (int x = 0; x < out.getWidth(); ++x) {
      if (!zoslogo::inkAt(x, y, 0, 0, 0)) continue;
      if (rising) {
        // Channel-wise max so a stroke that is already white does not dip.
        const Color white(channel(255.0f * rise), channel(255.0f * rise), channel(255.0f * rise));
        plot(out, x, y, maxColor(kBrandGreen, white));
      } else {
        plot(out, x, y, mixColor(kWhite, kBrandGreen, fall));
      }
    }
  }
}

// BEAT 5 — the only still moment, so the name is actually read. A diagonal
// sheen crosses it once, lighting only the mark.
void renderHold(Surface& out, int t) {
  const bool sheen = (t >= 1760 && t < 2120);
  float pos = 0.0f;
  if (sheen) pos = -4.0f + 64.0f * ease::inOutQuad(ease::progress(t, 1760, 360));

  for (int y = 0; y < out.getHeight(); ++y) {
    for (int x = 0; x < out.getWidth(); ++x) {
      if (!zoslogo::inkAt(x, y, 0, 0, 0)) continue;
      Color c = kBrandGreen;
      if (sheen) {
        const float g = x + 0.5f * (y - 1);
        const float delta = g - pos;
        const float dist = delta < 0 ? -delta : delta;
        const float weight = dist >= 3.0f ? 0.0f : (1.0f - dist / 3.0f);
        if (weight > 0.0f) c = mixColor(kBrandGreen, kWhite, 0.8f * weight);
      }
      plot(out, x, y, c);
    }
  }
}

// BEAT 6 — a CRT losing its deflection: the picture squashes into the centre
// line, gets hotter as the energy piles up, then closes horizontally to black.
void renderCollapse(Surface& out, int t) {
  const bool squashing = t < kCollapseMidEnd;
  const float squash = squashing
                           ? ease::lerp(1.0f, 0.08f,
                                        ease::inQuad(ease::progress(t, kHoldEnd, 140)))
                           : 0.08f;
  const float heat = squashing ? ease::inQuad(ease::progress(t, kHoldEnd, 140)) : 1.0f;
  const float close = squashing
                          ? 0.0f
                          : ease::inQuad(ease::progress(t, kCollapseMidEnd, 140));
  const float dim = 1.0f - close;

  const Color hot(200, 255, 220);
  for (int y = 0; y < out.getHeight(); ++y) {
    for (int x = 0; x < out.getWidth(); ++x) {
      if (!zoslogo::inkAt(x, y, 0, 0, 0)) continue;
      if (!squashing) {
        const float fromCenter = x - kCenterX;
        const float dist = fromCenter < 0 ? -fromCenter : fromCenter;
        if (dist > 17.5f * (1.0f - close)) continue;
      }
      const int ty = roundToInt(kCenterY + (y - kCenterY) * squash);
      Color c = squashing ? mixColor(kBrandGreen, hot, heat)
                          : Color(channel(200.0f * dim), channel(255.0f * dim),
                                  channel(220.0f * dim));
      // Several source rows land on one output row; taking the max makes the
      // pile-up read as concentrated energy and keeps the result order-free.
      if (ty >= 0 && ty < out.getHeight()) {
        c = maxColor(c, out.getPixel(x, ty));
        plot(out, x, ty, c);
      }
    }
  }
}

}  // namespace

BootScreen::BootScreen() : mStartMs(0) {}

void BootScreen::onEnter(int nowMs) {
  mStartMs = nowMs;
}

bool BootScreen::isDone(int nowMs) const {
  return (nowMs - mStartMs) >= kCollapseEnd;
}

bool BootScreen::isAnimating(int nowMs) const {
  return !isDone(nowMs);
}

void BootScreen::render(Surface& out, int nowMs) {
  const int t = nowMs - mStartMs;
  out.clear();
  if (t < 0 || t >= kCollapseEnd) return;

  if (t < kSparkEnd) renderSpark(out, t);
  else if (t < kWaveEnd) renderShockwave(out, t);
  else if (t < kTraceEnd) renderTrace(out, t);
  else if (t < kFlashEnd) renderFlash(out, t);
  else if (t < kHoldEnd) renderHold(out, t);
  else renderCollapse(out, t);
}

}  // namespace tcos
