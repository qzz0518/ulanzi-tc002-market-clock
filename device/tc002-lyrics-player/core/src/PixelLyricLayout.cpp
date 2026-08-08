#include "tc002_music/PixelLyricLayout.h"

#include <algorithm>

namespace tc002_music {
namespace {

const Rgb kBlack = {0, 0, 0};
const Rgb kAccent = {121, 255, 151};
const Rgb kSecondary = {68, 132, 82};
const Rgb kMuted = {36, 66, 46};
const std::size_t kTextViewportWidth = 48;
const std::size_t kGlyphCellWidth = 12;
const float kScrollStart = 0.08f;
const float kScrollEnd = 0.92f;

float unit(float value) {
  if (value < 0.0f) return 0.0f;
  if (value > 1.0f) return 1.0f;
  return value;
}

void set(Frame& frame, std::size_t x, std::size_t y, const Rgb& color) {
  if (x >= kDisplayWidth || y >= kDisplayHeight) return;
  frame[y * kDisplayWidth + x] = color;
}

float smoothstep(float value) {
  const float progress = unit(value);
  return progress * progress * (3.0f - 2.0f * progress);
}

}  // namespace

PixelLyricLayout defaultPixelLyricLayout() {
  return PixelLyricLayout{
    Rect{2, 0, 48, 1},
    Rect{2, 2, 48, 12},
    Rect{2, 15, 48, 1},
  };
}

std::size_t lyricScrollOffset(
  std::size_t textWidth,
  float lyricProgress,
  bool reducedMotion
) {
  const std::size_t alignedTextWidth = (
    (textWidth + kGlyphCellWidth - 1) / kGlyphCellWidth
  ) * kGlyphCellWidth;
  const std::size_t travel = alignedTextWidth > kTextViewportWidth
    ? alignedTextWidth - kTextViewportWidth
    : 0;
  if (travel == 0) return 0;
  const float scrollProgress = smoothstep(
    (unit(lyricProgress) - kScrollStart) / (kScrollEnd - kScrollStart)
  );
  const std::size_t continuousOffset = static_cast<std::size_t>(
    static_cast<float>(travel) * scrollProgress + 0.5f
  );
  const std::size_t step = reducedMotion ? kTextViewportWidth : kGlyphCellWidth;
  const std::size_t snappedOffset = (
    (continuousOffset + step / 2) / step
  ) * step;
  return std::min(travel, snappedOffset);
}

void paintPlayerChrome(
  Frame& frame,
  bool playing,
  float trackProgress,
  float lyricProgress
) {
  std::fill(frame.begin(), frame.end(), kBlack);
  const PixelLyricLayout layout = defaultPixelLyricLayout();

  // Three quiet anchors preserve position without competing with the lyric line.
  for (std::size_t index = 0; index < 3; ++index) {
    const std::size_t x = layout.lyricCue.x
      + static_cast<std::size_t>(47.0f * static_cast<float>(index) / 2.0f + 0.5f);
    set(frame, x, layout.lyricCue.y, kMuted);
    set(frame, x, layout.trackCue.y, kMuted);
  }

  const std::size_t lyricX = layout.lyricCue.x + static_cast<std::size_t>(
    47.0f * unit(lyricProgress) + 0.5f
  );
  if (lyricX > layout.lyricCue.x) set(frame, lyricX - 1, layout.lyricCue.y, kSecondary);
  set(frame, lyricX, layout.lyricCue.y, playing ? kAccent : kSecondary);

  const std::size_t trackX = layout.trackCue.x + static_cast<std::size_t>(
    47.0f * unit(trackProgress) + 0.5f
  );
  if (trackX > layout.trackCue.x) set(frame, trackX - 1, layout.trackCue.y, kSecondary);
  set(frame, trackX, layout.trackCue.y, kAccent);
}

}  // namespace tc002_music
