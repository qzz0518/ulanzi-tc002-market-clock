#include "tc002_music/LyricTimeline.h"

namespace tc002_music {

ActiveLyrics selectLyrics(
  const std::vector<TimedLyric>& lines,
  std::uint32_t positionMs
) {
  if (lines.empty() || positionMs < lines.front().startMs) {
    return ActiveLyrics{0, lines.empty() ? 0 : &lines.front(), 0.0f};
  }

  std::size_t low = 0;
  std::size_t high = lines.size();
  while (low < high) {
    const std::size_t middle = low + (high - low) / 2;
    if (lines[middle].startMs <= positionMs) low = middle + 1;
    else high = middle;
  }

  const std::size_t index = low - 1;
  const TimedLyric& current = lines[index];
  const std::uint32_t duration = current.endMs > current.startMs
    ? current.endMs - current.startMs
    : 1;
  const std::uint32_t elapsed = positionMs > current.startMs
    ? positionMs - current.startMs
    : 0;
  const float progress = elapsed >= duration
    ? 1.0f
    : static_cast<float>(elapsed) / static_cast<float>(duration);

  return ActiveLyrics{
    &current,
    index + 1 < lines.size() ? &lines[index + 1] : 0,
    progress,
  };
}

}  // namespace tc002_music
