#include "ui/MusicScreen.h"

#include "core/Ease.h"
#include "core/Text.h"

namespace tcos {

namespace {

const int kIconX = 0;
const int kTextX = 14;
const int kBarY = kPanelHeight - 1;
const Color kTitle(214, 244, 255);
const Color kArtist(128, 152, 176);
const Color kLyric(120, 255, 170);
const Color kBarDim(30, 40, 50);
const Color kBarLit(120, 255, 170);

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

/**
 * Four dancing bars in a 12x12 cell.
 *
 * Heights come from an integer hash of (bar, time) rather than sinf: the host
 * self-check asserts specific frames, and float trigonometry is not guaranteed
 * to round identically under clang on x86 and gcc on ARM. Every animation in
 * this firmware that is asserted per-frame is built this way.
 */
void equalizer(Surface& out, int x, int y, int nowMs, bool playing) {
  static const int kBarX[4] = {1, 4, 7, 10};
  // Each bar samples a different rate, so they never pulse in unison — which is
  // what separates "an equalizer" from "a bar chart blinking".
  static const int kRate[4] = {150, 210, 170, 250};
  for (int b = 0; b < 4; ++b) {
    int height;
    if (playing) {
      const unsigned int step = static_cast<unsigned int>(nowMs / kRate[b]);
      unsigned int h = step * 1664525u + 1013904223u + static_cast<unsigned int>(b) * 7919u;
      h ^= h >> 13;
      height = 2 + static_cast<int>(h % 9u);  // 2..10
    } else {
      height = 2;  // paused: parked low, so silence looks deliberate
    }
    for (int i = 0; i < height; ++i) {
      const float k = 0.45f + 0.55f * (static_cast<float>(i) / 10.0f);
      plot(out, x + kBarX[b], y + 11 - i, dim(kLyric, playing ? k : 0.35f));
      plot(out, x + kBarX[b] + 1, y + 11 - i, dim(kLyric, playing ? k : 0.35f));
    }
  }
}

}  // namespace

MusicScreen::MusicScreen()
    : mPresent(false), mLinkConfigured(true), mLinkOnline(true), mPlaying(false),
      mPositionMs(0), mDurationMs(0), mStampMs(0), mEnteredMs(0), mLyricChangedMs(0),
      mFlashMs(-1), mAction(kNone), mOptimisticUntilMs(-1), mOptimisticPlaying(false) {}

void MusicScreen::setLink(bool configured, bool online) {
  mLinkConfigured = configured;
  mLinkOnline = online;
}

void MusicScreen::setNowPlaying(bool present, const std::string& track,
                                const std::string& artist, const std::string& lyric,
                                bool playing, int positionMs, int durationMs,
                                int stampMs) {
  if (lyric != mLyric) mLyricChangedMs = stampMs;
  mPresent = present;
  mTrack = track;
  mArtist = artist;
  mLyric = lyric;
  mPlaying = playing;
  mPositionMs = positionMs;
  mDurationMs = durationMs;
  mStampMs = stampMs;
}

void MusicScreen::onEnter(int nowMs) {
  mEnteredMs = nowMs;
  mFlashMs = -1;
  mAction = kNone;
  mOptimisticUntilMs = -1;
}

int MusicScreen::playheadMs(int nowMs) const {
  if (!mPlaying) return mPositionMs;
  int at = mPositionMs + (nowMs - mStampMs);
  if (at < 0) at = 0;
  if (mDurationMs > 0 && at > mDurationMs) at = mDurationMs;
  return at;
}

bool MusicScreen::onInput(Input input, int nowMs) {
  if (!mPresent) return false;  // nothing to control; hold still pops
  if (input == kInputPress) {
    mAction = kToggle;
    mFlashMs = nowMs;
    // Hold the optimistic state only until the next document could plausibly
    // arrive. Longer and a rejected command would leave the panel lying.
    mOptimisticPlaying = !mPlaying;
    mOptimisticUntilMs = nowMs + 2500;
    return true;
  }
  if (input == kInputTurnCw || input == kInputTurnCcw) {
    mAction = input == kInputTurnCw ? kNext : kPrevious;
    mFlashMs = nowMs;
    return true;
  }
  return false;
}

MusicScreen::Action MusicScreen::takeAction() {
  const Action value = mAction;
  mAction = kNone;
  return value;
}

void MusicScreen::render(Surface& out, int nowMs) {
  out.clear(Color(0, 0, 0));

  const bool playing = (mOptimisticUntilMs >= 0 && nowMs < mOptimisticUntilMs)
                           ? mOptimisticPlaying
                           : mPlaying;

  if (!mPresent) {
    equalizer(out, kIconX, 2, nowMs, false);
    const int clipW = out.getWidth() - kTextX;
    // 未播放
    const char* text = "\xE6\x9C\xAA\xE6\x92\xAD\xE6\x94\xBE";
    const float k = ease::outQuad(ease::progress(nowMs, mEnteredMs, 320));
    text::draw(out, text, kTextX, 2, dim(kArtist, k), kTextX, clipW);
    return;
  }

  equalizer(out, kIconX, 2, nowMs, playing);

  const int clipW = out.getWidth() - kTextX;
  // A lyric wins the row whenever there is one: it is the only field that
  // changes on its own, and a title the user already read is not worth the row.
  const bool showLyric = !mLyric.empty();
  std::string line;
  Color color(0, 0, 0);
  int elapsed = 0;
  if (showLyric) {
    line = mLyric;
    color = kLyric;
    elapsed = nowMs - mLyricChangedMs;
  } else {
    // No lyrics: alternate title and artist rather than dropping one. On this
    // panel there is exactly one row, so "both at once" is not on the table.
    const int phase = ((nowMs - mEnteredMs) / kRotateMs) % 2;
    const bool title = (phase == 0) || mArtist.empty();
    line = title ? mTrack : mArtist;
    color = title ? kTitle : kArtist;
    elapsed = (nowMs - mEnteredMs) % kRotateMs;
  }
  if (line.empty()) line = mTrack.empty() ? "--" : mTrack;

  const int width = text::measure(line.c_str());
  const int x = width <= clipW ? kTextX + (clipW - width) / 2
                               : kTextX + text::marqueeOffset(width, clipW, elapsed);
  text::draw(out, line.c_str(), x, 2, color, kTextX, clipW);

  // Playhead on the bottom row, full panel width. It is the one element that
  // may cross under the icon: the bar is the clock, and a clock that stopped
  // 12 px short of the edge would be read as a shorter song.
  const int width_px = out.getWidth();
  int filled = 0;
  if (mDurationMs > 0) {
    filled = (playheadMs(nowMs) * width_px) / mDurationMs;
    if (filled > width_px) filled = width_px;
  }
  for (int px = 0; px < width_px; ++px) {
    plot(out, px, kBarY, px < filled ? kBarLit : kBarDim);
  }
  if (!playing) {
    // Paused: the head of the bar breathes so a still panel is not mistaken for
    // a frozen firmware — the failure mode this device actually has.
    const int pulse = (nowMs / 90) % 20;
    const float k = pulse < 10 ? pulse / 10.0f : (20 - pulse) / 10.0f;
    if (filled > 0) plot(out, filled - 1, kBarY, dim(kBarLit, 0.35f + 0.65f * k));
  }

  if (mFlashMs >= 0) {
    const float p = ease::progress(nowMs, mFlashMs, 200);
    if (p < 1.0f) {
      const Color wash = dim(kLyric, 0.28f * (1.0f - p));
      for (int y = 0; y < out.getHeight() - 1; ++y) {
        for (int px = 0; px < out.getWidth(); ++px) {
          const Color c = out.getPixel(px, y);
          if (c.r || c.g || c.b) continue;
          out.setPixel(px, y, wash);
        }
      }
    }
  }
}

bool MusicScreen::isAnimating(int nowMs) const {
  (void)nowMs;
  return true;
}

}  // namespace tcos
