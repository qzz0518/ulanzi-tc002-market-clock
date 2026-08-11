#include "ui/LauncherScreen.h"

#include <math.h>

#include "core/Ease.h"
#include "core/Text.h"
#include "visual/Glyphs.h"

namespace tcos {

namespace {

const int kIconX = 0;
const int kLabelX = 14;
const int kLabelW = kPanelWidth - kLabelX;  // 38 px: three CJK cells and a sliver
const int kLabelY = 1;                      // 12 px cell over rows 1..12
const int kRailY = kPanelHeight - 1;        // the bottom row, rows 13..14 stay dark
const int kPressFlashMs = 160;

Color dim(const Color& c, float k) {
  if (k <= 0.0f) return Color(0, 0, 0);
  if (k > 1.0f) k = 1.0f;
  return Color(static_cast<unsigned char>(c.r * k),
               static_cast<unsigned char>(c.g * k),
               static_cast<unsigned char>(c.b * k));
}

// One accent per icon kind, so a glance at the colour already says which family
// the current card belongs to before the label is even read.
Color accentFor(LauncherScreen::Icon icon) {
  switch (icon) {
    case LauncherScreen::kIconMusic:    return Color(255, 96, 160);
    case LauncherScreen::kIconGame:     return Color(120, 170, 255);
    case LauncherScreen::kIconSettings: return Color(200, 200, 200);
    case LauncherScreen::kIconChannel:
    default:                            return Color(0, 230, 100);
  }
}

void plot(Surface& out, int x, int y, const Color& c) {
  if (x < 0 || y < 0 || x >= out.getWidth() || y >= out.getHeight()) return;
  out.setPixel(x, y, c);
}

// Icons are procedural: a 12x12 RGB bitmap would cost 432 bytes each, and the
// whole point of this firmware is that it fits where the official one does not.
//
// All four ANIMATE, and all four animate by MOVING something. On a 12x12 cell a
// brightness pulse is nearly invisible and a 4-step rotation reads as flicker,
// so every icon here changes a position by at least two pixels per cycle. Cost
// is a handful of sinf/cosf per frame over at most 144 pixels.
void drawIcon(Surface& out, LauncherScreen::Icon icon, int x, int y,
              const Color& c, int phaseMs) {
  const float kTwoPi = 6.2831853f;

  switch (icon) {
    case LauncherScreen::kIconChannel: {
      // A 3-bar equaliser. sinf rather than a fract-based ramp: the ramp had a
      // discontinuity at the wrap, which showed up as a visible snap.
      for (int bar = 0; bar < 3; ++bar) {
        const float phase = (phaseMs / 900.0f) * kTwoPi + bar * 1.9f;
        const float wave = 0.5f + 0.5f * sinf(phase);
        const int h = 3 + static_cast<int>(wave * 7.0f);
        for (int i = 0; i < h; ++i) {
          const int py = y + 11 - i;
          plot(out, x + 1 + bar * 4, py, c);
          plot(out, x + 2 + bar * 4, py, c);
        }
      }
      break;
    }
    case LauncherScreen::kIconMusic: {
      // Two beamed quavers bouncing in antiphase. The beam stays put and the
      // heads travel 3 px, which is a quarter of the cell — unmistakable motion
      // at this size, and unmistakably musical.
      const float phase = (phaseMs / 760.0f) * kTwoPi;
      const int lift[2] = {
          static_cast<int>(1.5f + 1.5f * sinf(phase)),
          static_cast<int>(1.5f + 1.5f * sinf(phase + 3.14159f)),
      };
      // Beam across the top, joining both stems.
      for (int i = 0; i < 9; ++i) plot(out, x + 2 + i, y + 1, c);
      for (int i = 0; i < 9; ++i) plot(out, x + 2 + i, y + 2, c);
      for (int n = 0; n < 2; ++n) {
        const int sx = (n == 0) ? x + 2 : x + 10;
        const int headTop = y + 7 + lift[n];
        for (int i = y + 3; i < headTop; ++i) plot(out, sx, i, c);
        // A 3x3 head hanging off the stem, on the inside so both fit the cell.
        const int hx = (n == 0) ? sx : sx - 2;
        for (int dy = 0; dy < 3; ++dy)
          for (int dx = 0; dx < 3; ++dx) plot(out, hx + dx, headTop + dy, c);
      }
      break;
    }
    case LauncherScreen::kIconGame: {
      // Pong. A d-pad was tried first and rejected: its only motion was a
      // highlight landing on pixels the static cross had already lit, so the
      // icon's silhouette never changed and it read as frozen. Here the ball
      // travels the full cell and the paddles chase it — actual displacement,
      // which is the only kind of animation legible at 12x12.
      const float period = 1500.0f;
      const float u = (phaseMs / period) - floorf(phaseMs / period);
      // Triangle waves: the ball crosses and returns, bouncing off the top and
      // bottom on a faster axis so the path reads as a rally rather than a slide.
      const float triX = u < 0.5f ? (u * 2.0f) : (2.0f - u * 2.0f);
      const float v = (phaseMs / 620.0f) - floorf(phaseMs / 620.0f);
      const float triY = v < 0.5f ? (v * 2.0f) : (2.0f - v * 2.0f);
      const int bx = x + 3 + static_cast<int>(triX * 6.0f + 0.5f);
      const int by = y + 2 + static_cast<int>(triY * 8.0f + 0.5f);

      // Paddles track the ball, clamped inside the cell.
      int leftY = by - 1;
      if (leftY < y + 1) leftY = y + 1;
      if (leftY > y + 9) leftY = y + 9;
      int rightY = (y + 11) - (by - y) - 1;  // mirrored, so they are not identical
      if (rightY < y + 1) rightY = y + 1;
      if (rightY > y + 9) rightY = y + 9;

      for (int i = 0; i < 3; ++i) {
        plot(out, x + 1, leftY + i, c);
        plot(out, x + 10, rightY + i, c);
      }
      // A 2x2 ball, big enough to be seen against the paddles.
      plot(out, bx, by, c);
      plot(out, bx + 1, by, c);
      plot(out, bx, by + 1, c);
      plot(out, bx + 1, by + 1, c);
      break;
    }
    case LauncherScreen::kIconSettings: {
      // A gear that actually rotates: six teeth placed by angle and advanced
      // continuously, instead of four teeth snapping between four slots.
      const float angle = (phaseMs / 2400.0f) * kTwoPi;
      const int cx = x + 5;
      const int cy = y + 6;
      // Hub.
      for (int dy = 0; dy < 2; ++dy)
        for (int dx = 0; dx < 2; ++dx) plot(out, cx + dx, cy + dy, c);
      // Body ring at radius 2.
      for (int a = 0; a < 16; ++a) {
        const float th = (a / 16.0f) * kTwoPi;
        plot(out, cx + static_cast<int>(cosf(th) * 2.4f + 0.5f),
             cy + static_cast<int>(sinf(th) * 2.4f + 0.5f), dim(c, 0.55f));
      }
      // Teeth at radius 4, rotating.
      for (int t = 0; t < 6; ++t) {
        const float th = angle + (t / 6.0f) * kTwoPi;
        const int tx = cx + static_cast<int>(cosf(th) * 4.2f + (cosf(th) < 0 ? -0.5f : 0.5f));
        const int ty = cy + static_cast<int>(sinf(th) * 4.2f + (sinf(th) < 0 ? -0.5f : 0.5f));
        plot(out, tx, ty, c);
        // Fatten each tooth towards the hub so it reads as a tooth, not a speck.
        plot(out, cx + static_cast<int>(cosf(th) * 3.0f + (cosf(th) < 0 ? -0.5f : 0.5f)),
             cy + static_cast<int>(sinf(th) * 3.0f + (sinf(th) < 0 ? -0.5f : 0.5f)), c);
      }
      break;
    }
    default:
      break;
  }
}

}  // namespace

LauncherScreen::LauncherScreen()
    : mEnteredMs(0), mActivated(-1), mPressFlashMs(-1) {}

void LauncherScreen::setEntries(const std::vector<Entry>& entries, int nowMs) {
  mEntries = entries;
  mRing.setCount(static_cast<int>(mEntries.size()));
  mRing.setIndex(mRing.index(), nowMs);
}

void LauncherScreen::onEnter(int nowMs) {
  mEnteredMs = nowMs;
  mActivated = -1;
  mPressFlashMs = -1;
}

int LauncherScreen::takeActivated() {
  const int v = mActivated;
  mActivated = -1;
  return v;
}

bool LauncherScreen::onInput(Input input, int nowMs) {
  if (mEntries.empty()) return false;
  switch (input) {
    case kInputTurnCw:
      mRing.turn(1, nowMs);
      return true;
    case kInputTurnCcw:
      mRing.turn(-1, nowMs);
      return true;
    case kInputPress:
      mActivated = mEntries[mRing.index()].id;
      mPressFlashMs = nowMs;
      return true;
    default:
      // A hold is not ours: the Shell turns it into "up one level", and at the
      // launcher there is nowhere up, so it harmlessly does nothing.
      return false;
  }
}

bool LauncherScreen::isAnimating(int nowMs) const {
  if (mRing.isAnimating(nowMs)) return true;
  if (mPressFlashMs >= 0 && (nowMs - mPressFlashMs) < kPressFlashMs) return true;
  // The icons breathe, so the launcher is never actually static.
  return true;
}

void LauncherScreen::renderRail(Surface& out) const {
  const int n = mRing.count();
  if (n <= 1) return;
  // One rail pixel per entry, centred. With more entries than pixels the rail
  // degrades to a proportional cursor rather than lying about the count.
  if (n <= kPanelWidth / 2) {
    const int span = n * 2 - 1;
    const int x0 = (kPanelWidth - span) / 2;
    for (int i = 0; i < n; ++i) {
      const bool on = (i == mRing.index());
      plot(out, x0 + i * 2, kRailY, on ? Color(0, 220, 110) : Color(0, 40, 20));
    }
    return;
  }
  const int cursor = (mRing.index() * (kPanelWidth - 1)) / (n - 1);
  for (int x = 0; x < kPanelWidth; ++x) plot(out, x, kRailY, Color(0, 30, 15));
  plot(out, cursor, kRailY, Color(0, 220, 110));
}

void LauncherScreen::renderCard(Surface& out, const Entry& entry, int originX,
                                int nowMs) const {
  const Color accent = accentFor(entry.icon);

  // Cards slide horizontally; anything fully off-panel costs nothing to skip.
  if (originX <= -kPanelWidth || originX >= kPanelWidth) return;

  drawIcon(out, entry.icon, originX + kIconX, 2, accent, nowMs);

  const int labelWidth = text::measure(entry.label.c_str());
  const int viewX = originX + kLabelX;
  int labelX = viewX;
  if (labelWidth > kLabelW) {
    // Marquee only the settled card: scrolling a card that is itself sliding
    // reads as jitter.
    if (originX == 0) labelX += text::marqueeOffset(labelWidth, kLabelW, nowMs - mEnteredMs);
  } else {
    labelX += (kLabelW - labelWidth) / 2;
  }
  // The clip window travels with the card, so a neighbour's label can never
  // bleed into this one during a slide.
  int clipX = viewX;
  int clipW = kLabelW;
  if (clipX < 0) {
    clipW += clipX;
    clipX = 0;
  }
  if (clipX + clipW > kPanelWidth) clipW = kPanelWidth - clipX;
  if (clipW > 0) {
    text::draw(out, entry.label.c_str(), labelX, kLabelY, Color(255, 255, 255), clipX, clipW);
  }
}

void LauncherScreen::render(Surface& out, int nowMs) {
  out.clear();
  if (mEntries.empty()) {
    text::drawCentered(out, "\xE6\x97\xA0\xE9\xA2\x91\xE9\x81\x93", kLabelY,  // 无频道
                       Color(120, 120, 120), 0, kPanelWidth);
    return;
  }

  const float offset = mRing.visualOffset(nowMs);
  const int base = mRing.index();

  // During a slide two cards are on the panel; when settled only one is, and the
  // neighbours are skipped by the off-panel test in renderCard.
  for (int step = -1; step <= 1; ++step) {
    const int idx = mRing.wrap(base + step);
    const float slot = static_cast<float>(step) + offset;
    const int originX = static_cast<int>(slot * kPanelWidth + (slot < 0 ? -0.5f : 0.5f));
    renderCard(out, mEntries[idx], originX, nowMs);
  }

  renderRail(out);

  // Confirm flash: a brief full-panel wash on press, so the knob feels connected
  // even though this device has no haptics and (by default) no sound.
  if (mPressFlashMs >= 0) {
    const float p = ease::progress(nowMs, mPressFlashMs, kPressFlashMs);
    if (p < 1.0f) {
      const Color wash = dim(accentFor(mEntries[base].icon), 0.35f * (1.0f - p));
      for (int y = 0; y < kPanelHeight; ++y) {
        for (int x = 0; x < kPanelWidth; ++x) {
          const Color c = out.getPixel(x, y);
          if (c.r || c.g || c.b) continue;
          out.setPixel(x, y, wash);
        }
      }
    }
  }
}

}  // namespace tcos
