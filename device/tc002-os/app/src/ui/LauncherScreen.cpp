#include "ui/LauncherScreen.h"

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
void drawIcon(Surface& out, LauncherScreen::Icon icon, int x, int y,
              const Color& c, int phaseMs) {
  switch (icon) {
    case LauncherScreen::kIconChannel: {
      // A 3-bar equaliser whose bars breathe out of phase.
      for (int bar = 0; bar < 3; ++bar) {
        const float t = (phaseMs / 420.0f) + bar * 0.7f;
        const float wave = 0.5f + 0.5f * ease::inOutQuad((t - (int)t));
        const int h = 3 + static_cast<int>(wave * 6.0f);
        for (int i = 0; i < h; ++i) {
          const int py = y + 11 - i;
          plot(out, x + 1 + bar * 4, py, c);
          plot(out, x + 2 + bar * 4, py, c);
        }
      }
      break;
    }
    case LauncherScreen::kIconMusic: {
      // A quaver: stem, flag, and a filled head.
      for (int i = 0; i < 8; ++i) plot(out, x + 7, y + 1 + i, c);
      for (int i = 0; i < 3; ++i) plot(out, x + 8 + i, y + 1 + i, c);
      for (int dy = 0; dy < 3; ++dy)
        for (int dx = 0; dx < 4; ++dx) plot(out, x + 3 + dx, y + 8 + dy, c);
      break;
    }
    case LauncherScreen::kIconGame: {
      // A d-pad and two buttons.
      for (int i = 0; i < 5; ++i) plot(out, x + 1 + i, y + 6, c);
      for (int i = 0; i < 5; ++i) plot(out, x + 3, y + 4 + i, c);
      plot(out, x + 8, y + 5, c);
      plot(out, x + 9, y + 5, c);
      plot(out, x + 9, y + 7, c);
      plot(out, x + 10, y + 7, c);
      break;
    }
    case LauncherScreen::kIconSettings: {
      // A gear: a ring with four teeth, rotating one step per 250 ms.
      const int cx = x + 6;
      const int cy = y + 6;
      for (int a = 0; a < 12; ++a) {
        static const int ringX[12] = {0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3};
        static const int ringY[12] = {-3, -3, -2, -1, 0, 1, 2, 3, 3, 2, 1, 0};
        plot(out, cx + ringX[a] - 1, cy + ringY[a], c);
      }
      const int step = (phaseMs / 250) % 4;
      static const int toothX[4] = {0, 4, 0, -4};
      static const int toothY[4] = {-4, 0, 4, 0};
      for (int t = 0; t < 4; ++t) {
        const int k = (t + step) % 4;
        plot(out, cx - 1 + toothX[k], cy + toothY[k], c);
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
