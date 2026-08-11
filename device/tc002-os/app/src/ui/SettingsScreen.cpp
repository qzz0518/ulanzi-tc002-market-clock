#include "ui/SettingsScreen.h"

#include "core/Ease.h"
#include "core/Text.h"

namespace tcos {

namespace {

const int kRailY = kPanelHeight - 1;
const int kTextY = 2;
const Color kLabelColor(214, 244, 255);
const Color kValueColor(120, 255, 170);
const Color kRailLit(120, 255, 170);
const Color kRailDim(28, 46, 40);

void plot(Surface& out, int x, int y, const Color& c) {
  if (x < 0 || y < 0 || x >= out.getWidth() || y >= out.getHeight()) return;
  out.setPixel(x, y, c);
}

Color dim(const Color& c, float k) {
  if (k < 0.0f) k = 0.0f;
  if (k > 1.0f) k = 1.0f;
  return Color(static_cast<unsigned char>(c.r * k), static_cast<unsigned char>(c.g * k),
               static_cast<unsigned char>(c.b * k));
}

// Draws centred when it fits and marqueed when it does not, at a vertical
// offset. One helper for both halves of the swap, so the label and the value
// can never drift out of alignment with each other.
void drawRow(Surface& out, const std::string& utf8, int dx, int dy, const Color& color,
             int elapsedMs) {
  if (utf8.empty()) return;
  const int clipX = 1;
  const int clipW = out.getWidth() - 2;
  const int width = text::measure(utf8.c_str());
  const int x = width <= clipW ? clipX + (clipW - width) / 2
                               : clipX + text::marqueeOffset(width, clipW, elapsedMs);
  text::draw(out, utf8.c_str(), x + dx, kTextY + dy, color, clipX, clipW);
}

}  // namespace

SettingsScreen::SettingsScreen()
    : mEnteredMs(0), mRowShownMs(0), mActivated(-1), mPressFlashMs(-1) {}

void SettingsScreen::setRows(const std::vector<Row>& rows, int nowMs) {
  const bool sameShape = rows.size() == mRows.size();
  mRows = rows;
  mRing.setCount(static_cast<int>(mRows.size()));
  // Only rewind the label dwell when the list itself changed. Values refresh
  // twice a second; restarting the swap on every refresh would leave the row
  // permanently stuck on its label.
  if (!sameShape) mRowShownMs = nowMs;
}

void SettingsScreen::onEnter(int nowMs) {
  mEnteredMs = nowMs;
  mRowShownMs = nowMs;
  mPressFlashMs = -1;
  mActivated = -1;
}

bool SettingsScreen::onInput(Input input, int nowMs) {
  if (mRows.empty()) return false;
  if (input == kInputTurnCw || input == kInputTurnCcw) {
    mRing.turn(input == kInputTurnCw ? 1 : -1, nowMs);
    mRowShownMs = nowMs;  // re-ask the question before showing the answer
    return true;
  }
  if (input == kInputPress) {
    const Row& row = mRows[static_cast<size_t>(mRing.index())];
    mPressFlashMs = nowMs;
    // An inert row still flashes: "nothing happened" and "the button did not
    // register" must never look the same.
    if (row.id != 0) mActivated = row.id;
    return true;
  }
  return false;  // hold bubbles to the Shell, which pops
}

int SettingsScreen::takeActivated() {
  const int value = mActivated;
  mActivated = -1;
  return value;
}

void SettingsScreen::render(Surface& out, int nowMs) {
  out.clear(Color(0, 0, 0));
  if (mRows.empty()) return;

  const int base = mRing.index();
  const float offset = mRing.visualOffset(nowMs);
  const int elapsed = nowMs - mRowShownMs;

  // The label/value swap only applies to the settled row. A row sliding past
  // always shows its label: it is on screen for 180 ms, which is not long
  // enough to read a value and is exactly long enough to read a name.
  const float swap = ease::inOutCubic(
      ease::progress(nowMs, mRowShownMs + kLabelDwellMs, kSwapMs));
  // 16 px is the panel height, so each half is fully off-panel at the ends.
  const int labelDy = -static_cast<int>(swap * 16.0f + 0.5f);
  const int valueDy = 16 - static_cast<int>(swap * 16.0f + 0.5f);

  const int width = out.getWidth();
  const int settledDx = static_cast<int>(offset * width + (offset < 0 ? -0.5f : 0.5f));
  {
    const Row& row = mRows[static_cast<size_t>(base)];
    if (swap < 1.0f) drawRow(out, row.label, settledDx, labelDy, kLabelColor, elapsed);
    if (swap > 0.0f) {
      drawRow(out, row.value.empty() ? "--" : row.value, settledDx, valueDy, kValueColor,
              elapsed - kLabelDwellMs);
    }
  }

  // The row being left, trailing the settled one by exactly one panel width.
  // Skipped at rest, where it would be an off-panel no-op that still costs a
  // marquee measurement every frame.
  if (settledDx != 0) {
    const int dir = offset < 0 ? 1 : -1;
    const int leaving = mRing.wrap(base - dir);
    if (leaving != base) {
      drawRow(out, mRows[static_cast<size_t>(leaving)].label, settledDx - dir * width, 0,
              dim(kLabelColor, 0.75f), 0);
    }
  }

  renderRail(out);

  if (mPressFlashMs >= 0) {
    const float p = ease::progress(nowMs, mPressFlashMs, 180);
    if (p < 1.0f) {
      const Color wash = dim(kValueColor, 0.30f * (1.0f - p));
      for (int y = 0; y < out.getHeight(); ++y) {
        for (int x = 0; x < out.getWidth(); ++x) {
          const Color c = out.getPixel(x, y);
          if (c.r || c.g || c.b) continue;
          out.setPixel(x, y, wash);
        }
      }
    }
  }
}

void SettingsScreen::renderRail(Surface& out) const {
  const int n = mRing.count();
  if (n <= 1) return;
  if (n <= kPanelWidth / 2) {
    const int span = n * 2 - 1;
    const int x0 = (kPanelWidth - span) / 2;
    for (int i = 0; i < n; ++i) {
      plot(out, x0 + i * 2, kRailY, i == mRing.index() ? kRailLit : kRailDim);
    }
    return;
  }
  const int cursor = (mRing.index() * (kPanelWidth - 1)) / (n - 1);
  for (int x = 0; x < kPanelWidth; ++x) plot(out, x, kRailY, kRailDim);
  plot(out, cursor, kRailY, kRailLit);
}

bool SettingsScreen::isAnimating(int nowMs) const {
  (void)nowMs;
  return true;  // values refresh and long ones marquee
}

}  // namespace tcos
