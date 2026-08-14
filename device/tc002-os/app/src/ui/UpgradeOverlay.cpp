#include "ui/UpgradeOverlay.h"

#include <stdio.h>

#include "core/Text.h"
#include "ui/Screen.h"

namespace tcos {

namespace {

const int kTextY = 2;
const int kRailY = kPanelHeight - 1;
// The same one-pixel margin every other text page here lays out in.
const int kClipX = 1;
const int kClipW = kPanelWidth - 2;

// The provisioning palette, reused rather than re-picked: these two screens are
// the only ones that ever explain a system operation to someone standing in
// front of the clock, and a second set of meanings for the same colours is a
// second thing to keep in step.
const Color kLabel(214, 244, 255);
const Color kValue(120, 255, 170);
const Color kAlarm(255, 118, 96);
const Color kRailDim(28, 46, 40);
const Color kRailAlarm(90, 26, 22);

// UTF-8 hex escapes, as everywhere else in this firmware: the toolchain's
// source charset is not something to rely on for a string that has to survive a
// cross-compile into a device with one font table.
const char* kWordInstalling = "\xE5\xAE\x89\xE8\xA3\x85\xE4\xB8\xAD";                  // 安装中
const char* kWordFailed =
    "\xE6\x9B\xB4\xE6\x96\xB0\xE5\xA4\xB1\xE8\xB4\xA5";                               // 更新失败
const char* kWordUpdate = "\xE6\x9B\xB4\xE6\x96\xB0";                                 // 更新

void plot(Surface& out, int x, int y, const Color& c) {
  if (x < 0 || y < 0 || x >= out.getWidth() || y >= out.getHeight()) return;
  out.setPixel(x, y, c);
}

}  // namespace

UpgradeOverlay::UpgradeOverlay() : mStage(kHidden), mPercent(0), mStageMs(0) {}

void UpgradeOverlay::set(Stage stage, int percent, int nowMs) {
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  if (stage != mStage) mStageMs = nowMs;
  mStage = stage;
  mPercent = percent;
}

bool UpgradeOverlay::visible(int nowMs) const {
  if (mStage == kHidden) return false;
  // A failure expires; a download and an install do not. The device is supposed
  // to disappear into a reboot out of kInstalling, and if it somehow does not,
  // a panel still saying 安装中 is the truth — the image IS staged.
  if (mStage == kFailed) return (nowMs - mStageMs) < kFailHoldMs;
  return true;
}

void UpgradeOverlay::render(Surface& out, int nowMs) const {
  if (!visible(nowMs)) return;
  out.clear(Color(0, 0, 0));

  // 「更新42%」 rather than 「更新 42%」: the CJK cells are 12 px and the digits
  // 6 px, so the widest reading (100%) is 48 px of the 50 available and a space
  // would push it off the panel. The transition between the two cell widths
  // already reads as a break.
  char line[32];
  Color ink = kLabel;
  switch (mStage) {
    case kInstalling:
      ::snprintf(line, sizeof(line), "%s", kWordInstalling);
      ink = kValue;
      break;
    case kFailed:
      ::snprintf(line, sizeof(line), "%s", kWordFailed);
      ink = kAlarm;
      break;
    case kDownloading:
    default:
      ::snprintf(line, sizeof(line), "%s%d%%", kWordUpdate, mPercent);
      break;
  }

  const int width = text::measure(line);
  const int x = kClipX + (kClipW - width) / 2;
  text::draw(out, line, x, kTextY, ink, kClipX, kClipW);

  if (mStage == kFailed) {
    // One lit pixel in the alarm colour, the way ProvisionScreen marks a state
    // that is not going to resolve itself.
    for (int rx = 0; rx < kPanelWidth; ++rx) plot(out, rx, kRailY, kRailAlarm);
    plot(out, kPanelWidth / 2, kRailY, kAlarm);
    return;
  }

  const int filled = (mPercent * kPanelWidth + 50) / 100;
  for (int rx = 0; rx < kPanelWidth; ++rx) {
    plot(out, rx, kRailY, rx < filled ? kValue : kRailDim);
  }
  // The liveness pixel, sweeping what is left. A progress bar alone cannot tell
  // a slow transfer from a stopped one, and that is the only question the person
  // watching actually has.
  if (filled < kPanelWidth) {
    const int span = kPanelWidth - filled;
    const int t = ((nowMs - mStageMs) % kSweepMs + kSweepMs) % kSweepMs;
    plot(out, filled + (t * span) / kSweepMs, kRailY, kLabel);
  }
}

}  // namespace tcos
