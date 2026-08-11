#include "ui/LevelOverlay.h"

#include "core/Ease.h"
#include "ui/Screen.h"

namespace tcos {

namespace {

const int kIconX = 0;
const int kBarX = 14;
const int kBarW = kPanelWidth - kBarX;  // 38 px
const int kSegments = 9;                // 3 px block + 1 px gap fits 38 px exactly

void plot(Surface& out, int x, int y, const Color& c) {
  if (x < 0 || y < 0 || x >= out.getWidth() || y >= out.getHeight()) return;
  out.setPixel(x, y, c);
}

Color scale(const Color& c, float k) {
  if (k <= 0.0f) return Color(0, 0, 0);
  if (k > 1.0f) k = 1.0f;
  return Color(static_cast<unsigned char>(c.r * k),
               static_cast<unsigned char>(c.g * k),
               static_cast<unsigned char>(c.b * k));
}

// A speaker with sound arcs whose count follows the level, so the icon itself
// carries the value even before the bar is read. At zero it shows a mute cross,
// which is the one state a bar alone communicates badly.
void drawSpeaker(Surface& out, int x, int y, const Color& c, int filled, float alpha) {
  const Color body = scale(c, alpha);
  // Cone.
  for (int dy = 0; dy < 4; ++dy) {
    plot(out, x + 2, y + 4 + dy, body);
    plot(out, x + 3, y + 4 + dy, body);
  }
  for (int dy = 0; dy < 8; ++dy) {
    plot(out, x + 4, y + 2 + dy, body);
  }
  for (int dy = 0; dy < 6; ++dy) {
    plot(out, x + 5, y + 3 + dy, body);
  }

  if (filled == 0) {
    // Mute: a cross where the arcs would be.
    for (int i = 0; i < 4; ++i) {
      plot(out, x + 7 + i, y + 4 + i, body);
      plot(out, x + 10 - i, y + 4 + i, body);
    }
    return;
  }
  // Up to three arcs, lit in proportion to the level.
  const int arcs = 1 + (filled * 2) / kSegments;
  for (int a = 0; a < 3; ++a) {
    const float k = (a < arcs) ? alpha : alpha * 0.18f;
    const int ax = x + 7 + a * 2;
    const int half = 2 + a;
    for (int dy = -half; dy <= half; ++dy) {
      plot(out, ax, y + 6 + dy, scale(c, k));
    }
  }
}

// A sun whose rays extend with the level — the same trick as the speaker arcs.
void drawSun(Surface& out, int x, int y, const Color& c, int filled, float alpha) {
  const Color body = scale(c, alpha);
  const int cx = x + 6;
  const int cy = y + 6;
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      plot(out, cx + dx, cy + dy, body);
    }
  }
  const float ratio = kSegments > 0 ? static_cast<float>(filled) / kSegments : 0.0f;
  const int reach = 2 + static_cast<int>(ratio * 2.0f + 0.5f);
  static const int dirX[8] = {0, 1, 1, 1, 0, -1, -1, -1};
  static const int dirY[8] = {-1, -1, 0, 1, 1, 1, 0, -1};
  for (int d = 0; d < 8; ++d) {
    for (int r = 2; r <= reach; ++r) {
      // Diagonals shorten by one so the sun reads round rather than square.
      const bool diagonal = (dirX[d] != 0 && dirY[d] != 0);
      if (diagonal && r > reach - 1) continue;
      plot(out, cx + dirX[d] * r, cy + dirY[d] * r, scale(c, alpha * 0.8f));
    }
  }
}

}  // namespace

LevelOverlay::LevelOverlay()
    : mKind(kVolume), mValue(0), mMax(1), mShownMs(0), mLastPokeMs(0), mActive(false) {}

void LevelOverlay::show(Kind kind, int value, int maxValue, int nowMs) {
  if (maxValue < 1) maxValue = 1;
  if (value < 0) value = 0;
  if (value > maxValue) value = maxValue;

  // Restarting the enter animation on every detent would make a fast run of
  // presses flicker; only a fresh appearance animates in.
  const bool wasVisible = visible(nowMs) && mKind == kind;
  if (!wasVisible) mShownMs = nowMs;
  mKind = kind;
  mValue = value;
  mMax = maxValue;
  mLastPokeMs = nowMs;
  mActive = true;
}

bool LevelOverlay::visible(int nowMs) const {
  if (!mActive) return false;
  return (nowMs - mLastPokeMs) < (kHoldMs + kExitMs);
}

void LevelOverlay::render(Surface& out, int nowMs) const {
  if (!visible(nowMs)) return;

  const int sinceShown = nowMs - mShownMs;
  const int sincePoke = nowMs - mLastPokeMs;

  // Alpha: rise on entry, hold, fall after the last change.
  float alpha = 1.0f;
  if (sinceShown < kEnterMs) {
    alpha = ease::outQuad(ease::progress(nowMs, mShownMs, kEnterMs));
  }
  if (sincePoke > kHoldMs) {
    const float out01 = ease::progress(nowMs, mLastPokeMs + kHoldMs, kExitMs);
    alpha *= (1.0f - ease::inQuad(out01));
  }
  if (alpha <= 0.0f) return;

  // The overlay owns the panel while it is up: dimming what is underneath is
  // what makes a 38 px bar readable over a running game or a channel frame.
  for (int y = 0; y < out.getHeight(); ++y) {
    for (int x = 0; x < out.getWidth(); ++x) {
      const Color under = out.getPixel(x, y);
      if (under.r || under.g || under.b) out.setPixel(x, y, scale(under, 1.0f - 0.85f * alpha));
    }
  }

  const Color accent = (mKind == kVolume) ? Color(120, 190, 255) : Color(255, 200, 90);
  const int filled = (mValue * kSegments + mMax / 2) / mMax;

  if (mKind == kVolume) {
    drawSpeaker(out, kIconX, 2, accent, filled, alpha);
  } else {
    drawSun(out, kIconX, 2, accent, filled, alpha);
  }

  // Segmented bar. Blocks slide up into place on entry, which is what makes the
  // change legible when the value moves by one step.
  for (int seg = 0; seg < kSegments; ++seg) {
    const int bx = kBarX + seg * 4;
    const bool on = seg < filled;
    const float lift = (sinceShown < kEnterMs)
                           ? (1.0f - ease::outQuad(ease::progress(nowMs, mShownMs, kEnterMs)))
                           : 0.0f;
    const int drop = static_cast<int>(lift * 4.0f + 0.5f);
    for (int dy = 0; dy < 8; ++dy) {
      const int y = 4 + dy + drop;
      for (int dx = 0; dx < 3; ++dx) {
        plot(out, bx + dx, y, on ? scale(accent, alpha) : scale(accent, alpha * 0.14f));
      }
    }
  }
}

}  // namespace tcos
