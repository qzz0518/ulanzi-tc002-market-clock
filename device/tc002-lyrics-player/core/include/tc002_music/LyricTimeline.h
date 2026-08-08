#ifndef TC002_MUSIC_LYRIC_TIMELINE_H
#define TC002_MUSIC_LYRIC_TIMELINE_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace tc002_music {

struct TimedLyric {
  std::uint32_t startMs;
  std::uint32_t endMs;
  std::string text;
  std::string translation;
};

struct ActiveLyrics {
  const TimedLyric* current;
  const TimedLyric* next;
  float lineProgress;
};

ActiveLyrics selectLyrics(
  const std::vector<TimedLyric>& lines,
  std::uint32_t positionMs
);

}  // namespace tc002_music

#endif
