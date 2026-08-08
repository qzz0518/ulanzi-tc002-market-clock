#include "tc002_music/LyricTimeline.h"
#include "tc002_music/PixelLyricLayout.h"

#include <cassert>
#include <vector>

int main() {
  using namespace tc002_music;
  const std::vector<TimedLyric> lines = {
    TimedLyric{1000, 3000, "first", ""},
    TimedLyric{3000, 5000, "second", ""},
  };

  const ActiveLyrics before = selectLyrics(lines, 500);
  assert(before.current == 0);
  assert(before.next == &lines[0]);

  const ActiveLyrics active = selectLyrics(lines, 2000);
  assert(active.current == &lines[0]);
  assert(active.next == &lines[1]);
  assert(active.lineProgress > 0.49f && active.lineProgress < 0.51f);

  Frame frame;
  paintPlayerChrome(frame, true, 0.5f, active.lineProgress);
  const PixelLyricLayout layout = defaultPixelLyricLayout();
  assert(layout.currentLine.x == 2);
  assert(layout.currentLine.y == 2);
  assert(layout.currentLine.width == 48);
  assert(layout.currentLine.height == 12);
  assert(lyricScrollOffset(48, 0.5f, false) == 0);
  assert(lyricScrollOffset(80, 0.0f, false) == 0);
  assert(lyricScrollOffset(80, 0.5f, false) == 24);
  assert(lyricScrollOffset(80, 1.0f, false) == 36);
  assert(lyricScrollOffset(80, 0.5f, true) == 0);
  assert(lyricScrollOffset(80, 1.0f, true) == 36);
  assert(frame.size() == 52 * 16);
  const Rgb trackLocator = frame[15 * 52 + 26];
  assert(trackLocator.green > 200);
  return 0;
}
