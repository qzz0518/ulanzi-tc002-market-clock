#ifndef TC002_MUSIC_PIXEL_LYRIC_LAYOUT_H
#define TC002_MUSIC_PIXEL_LYRIC_LAYOUT_H

#include <array>
#include <cstddef>
#include <cstdint>

namespace tc002_music {

const std::size_t kDisplayWidth = 52;
const std::size_t kDisplayHeight = 16;

struct Rgb {
  std::uint8_t red;
  std::uint8_t green;
  std::uint8_t blue;
};

struct Rect {
  std::uint8_t x;
  std::uint8_t y;
  std::uint8_t width;
  std::uint8_t height;
};

struct PixelLyricLayout {
  Rect lyricCue;
  Rect currentLine;
  Rect trackCue;
};

typedef std::array<Rgb, kDisplayWidth * kDisplayHeight> Frame;

PixelLyricLayout defaultPixelLyricLayout();
std::size_t lyricScrollOffset(
  std::size_t textWidth,
  float lyricProgress,
  bool reducedMotion
);
void paintPlayerChrome(
  Frame& frame,
  bool playing,
  float trackProgress,
  float lyricProgress
);

}  // namespace tc002_music

#endif
