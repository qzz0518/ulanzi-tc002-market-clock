#include "ui/ChannelRingScreen.h"

#include "core/Ease.h"
#include "core/Text.h"

namespace tcos {

namespace {

const Color kAccent(120, 255, 170);
const Color kWarn(255, 138, 42);
const Color kLabel(214, 244, 255);
const std::string kEmptyString;

Color dim(const Color& c, float k) {
  if (k < 0.0f) k = 0.0f;
  if (k > 1.0f) k = 1.0f;
  return Color(static_cast<unsigned char>(c.r * k), static_cast<unsigned char>(c.g * k),
               static_cast<unsigned char>(c.b * k));
}

// A one-pixel travelling sweep on the bottom row: the only progress indicator
// that fits beside a 12 px text row.
void sweep(Surface& out, int nowMs, const Color& color) {
  const int w = out.getWidth();
  const int y = out.getHeight() - 1;
  const int head = (nowMs / 26) % (w + 12);
  for (int i = 0; i < 12; ++i) {
    const int x = head - i;
    if (x < 0 || x >= w) continue;
    out.setPixel(x, y, dim(color, 1.0f - static_cast<float>(i) / 12.0f));
  }
}

// The position rail, shown only just after a move.
//
// The page carries no icon and no label by design, which also leaves the user
// with no idea how many channels there are or where they are among them. A
// permanent rail would solve that by painting a row of the content the page
// exists to show, so it fades out instead: present exactly while navigating,
// gone while watching.
const int kRailHoldMs = 1200;
const int kRailFadeMs = 500;

void renderRail(Surface& out, int index, int count, int sinceMs) {
  if (count <= 1) return;
  const int age = sinceMs - kRailHoldMs;
  if (age >= kRailFadeMs) return;
  const float k = age <= 0 ? 1.0f : 1.0f - static_cast<float>(age) / kRailFadeMs;

  const int y = out.getHeight() - 1;
  if (count <= out.getWidth() / 2) {
    const int span = count * 2 - 1;
    const int x0 = (out.getWidth() - span) / 2;
    for (int i = 0; i < count; ++i) {
      const int x = x0 + i * 2;
      if (x < 0 || x >= out.getWidth()) continue;
      out.setPixel(x, y, dim(i == index ? kAccent : Color(28, 46, 40), k));
    }
    return;
  }
  const int cursor = (index * (out.getWidth() - 1)) / (count - 1);
  for (int x = 0; x < out.getWidth(); ++x) out.setPixel(x, y, dim(Color(28, 46, 40), k));
  out.setPixel(cursor, y, dim(kAccent, k));
}

}  // namespace

ChannelRingScreen::ChannelRingScreen()
    : mStatus(kLoading), mStartedMs(0), mSettledMs(0), mPausedAtMs(0), mPaused(false),
      mSelectionChanged(false), mBody(kPanelWidth, kPanelHeight),
      mOutgoing(kPanelWidth, kPanelHeight), mHasOutgoing(false) {}

void ChannelRingScreen::setEntries(const std::vector<Entry>& entries, int nowMs) {
  // Keep the user where they are across a republish: the service resends the
  // menu whenever any setting changes, and snapping back to the first channel
  // every time would make the ring unusable while the console is being edited.
  const std::string keep = currentApp();
  mEntries = entries;
  mRing.setCount(static_cast<int>(mEntries.size()));
  if (!keep.empty()) {
    for (size_t i = 0; i < mEntries.size(); ++i) {
      if (mEntries[i].appName != keep) continue;
      mRing.setIndex(static_cast<int>(i), nowMs);
      return;
    }
    // The channel we were on is gone; whatever is at this position now is a
    // different channel, so its frames are no longer ours.
    mBundle = FrameBundle();
    mBundleApp.clear();
    mStatus = kLoading;
    mSelectionChanged = true;
    mSettledMs = nowMs;
  }
}

const std::string& ChannelRingScreen::currentApp() const {
  if (mEntries.empty()) return kEmptyString;
  return mEntries[static_cast<size_t>(mRing.index())].appName;
}

const std::string& ChannelRingScreen::currentLabel() const {
  if (mEntries.empty()) return kEmptyString;
  return mEntries[static_cast<size_t>(mRing.index())].label;
}

bool ChannelRingScreen::selectApp(const std::string& appName, int nowMs) {
  for (size_t i = 0; i < mEntries.size(); ++i) {
    if (mEntries[i].appName != appName) continue;
    if (mRing.index() != static_cast<int>(i)) {
      mRing.setIndex(static_cast<int>(i), nowMs);
      mSelectionChanged = true;
      mSettledMs = nowMs;
      mStatus = kLoading;
      mPaused = false;
    }
    return true;
  }
  return false;
}

bool ChannelRingScreen::takeSelectionChanged() {
  const bool value = mSelectionChanged;
  mSelectionChanged = false;
  return value;
}

void ChannelRingScreen::adoptFrames(FrameBundle& bundle, const std::string& appName,
                                    int nowMs) {
  // Frames that finished downloading after the knob moved on are dropped, not
  // shown: without this check a slow channel paints over the one the user is
  // actually looking at.
  if (appName != currentApp()) return;
  mBundle.swap(bundle);
  mBundleApp = appName;
  mStartedMs = nowMs;
  mPaused = false;
  mStatus = mBundle.empty() ? kFailed : kReady;
}

void ChannelRingScreen::setStatus(Status status, int nowMs) {
  if (mStatus == status) return;
  mStatus = status;
  mSettledMs = nowMs;
}

void ChannelRingScreen::onEnter(int nowMs) {
  mSettledMs = nowMs;
  mStartedMs = nowMs;
  mPaused = false;
  mHasOutgoing = false;
  // Re-ask on every entry: the ring is entered from the root, and the frames
  // held from last time may be minutes stale.
  mSelectionChanged = true;
}

bool ChannelRingScreen::onInput(Input input, int nowMs) {
  if (mEntries.empty()) return false;

  if (input == kInputTurnCw || input == kInputTurnCcw) {
    // Snapshot what is on screen before the selection moves: a channel's pixels
    // came from a download, so unlike an icon card the outgoing page cannot be
    // re-rendered once the index has changed.
    renderPage(mBody, nowMs);
    for (int y = 0; y < mOutgoing.getHeight(); ++y) {
      for (int x = 0; x < mOutgoing.getWidth(); ++x) {
        mOutgoing.setPixel(x, y, mBody.getPixel(x, y));
      }
    }
    mHasOutgoing = true;

    mRing.turn(input == kInputTurnCw ? 1 : -1, nowMs);
    mBundle = FrameBundle();
    mBundleApp.clear();
    mStatus = kLoading;
    mPaused = false;
    mSettledMs = nowMs;
    mSelectionChanged = true;
    return true;
  }

  if (input == kInputPress && mStatus == kReady && !mBundle.empty()) {
    if (mPaused) {
      mStartedMs = nowMs - (mPausedAtMs - mStartedMs);
      mPaused = false;
    } else {
      mPausedAtMs = nowMs;
      mPaused = true;
    }
    return true;
  }
  return false;  // hold bubbles to the Shell, which pops back to the root
}

void ChannelRingScreen::renderPage(Surface& out, int nowMs) const {
  out.clear(Color(0, 0, 0));
  if (mEntries.empty()) return;

  if (mStatus == kReady && !mBundle.empty() && mBundleApp == currentApp()) {
    const int at = mPaused ? mPausedAtMs : nowMs;
    int elapsed = at - mStartedMs;
    if (elapsed < 0) elapsed = 0;
    const int index = mBundle.indexAt(elapsed);
    if (index >= 0) {
      mBundle.blit(index, out);
      if (mPaused) {
        for (int y = 1; y <= 4; ++y) {
          out.setPixel(out.getWidth() - 2, y, kAccent);
          out.setPixel(out.getWidth() - 4, y, kAccent);
        }
      }
      return;
    }
  }

  // Not loaded yet. The name is shown ONLY here — once the frames land the
  // channel speaks for itself and a label would be describing a picture the
  // user is already looking at.
  const int clipX = 2;
  const int clipW = out.getWidth() - 4;
  const std::string& label = currentLabel();
  const char* text = label.empty() ? "..." : label.c_str();
  const int width = text::measure(text);
  const int offset = width <= clipW
                         ? (clipW - width) / 2
                         : text::marqueeOffset(width, clipW, nowMs - mSettledMs);
  const bool bad = (mStatus == kFailed || mStatus == kOffline);
  const float k = ease::outQuad(ease::progress(nowMs, mSettledMs, 260));
  text::draw(out, text, clipX + offset, 1, dim(bad ? kWarn : kLabel, k), clipX, clipW);
  if (!bad) sweep(out, nowMs, kAccent);
}

void ChannelRingScreen::blitShifted(Surface& out, const Surface& src, int dx) const {
  for (int y = 0; y < out.getHeight(); ++y) {
    for (int x = 0; x < out.getWidth(); ++x) {
      const int sx = x - dx;
      if (sx < 0 || sx >= src.getWidth()) continue;
      const Color c = src.getPixel(sx, y);
      if (!c.r && !c.g && !c.b) continue;  // keep the destination's black
      out.setPixel(x, y, c);
    }
  }
}

void ChannelRingScreen::render(Surface& out, int nowMs) {
  out.clear(Color(0, 0, 0));
  if (mEntries.empty()) {
    // 没有频道
    text::drawCentered(out, "\xE6\xB2\xA1\xE6\x9C\x89\xE9\xA2\x91\xE9\x81\x93", 2,
                       dim(kLabel, 0.7f), 0, out.getWidth());
    return;
  }

  renderPage(mBody, nowMs);

  const float offset = mRing.visualOffset(nowMs);
  if (offset == 0.0f || !mHasOutgoing) {
    blitShifted(out, mBody, 0);
    if (offset == 0.0f) mHasOutgoing = false;
    renderRail(out, mRing.index(), count(), nowMs - mSettledMs);
    return;
  }

  // offset runs from -delta towards 0, in items. The incoming page rides it and
  // the outgoing page trails exactly one panel width behind, so the pair moves
  // as one strip rather than as a cross-fade — the same grammar as the root
  // ring, which is what makes the two read as the same gesture.
  const int width = out.getWidth();
  const int dx = static_cast<int>(offset * width + (offset < 0 ? -0.5f : 0.5f));
  const int dir = offset < 0 ? 1 : -1;
  blitShifted(out, mBody, dx);
  blitShifted(out, mOutgoing, dx - dir * width);
  renderRail(out, mRing.index(), count(), nowMs - mSettledMs);
}

bool ChannelRingScreen::isAnimating(int nowMs) const {
  (void)nowMs;
  return true;
}

}  // namespace tcos
