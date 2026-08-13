#include "core/LyricTiming.h"

namespace tcos {

namespace {

float unitf(float value) { return value < 0.f ? 0.f : (value > 1.f ? 1.f : value); }

}  // namespace

void LyricCellTable::assign(const LyricCell* from, int n) {
  count = 0;
  if (from == 0 || n <= 0 || n > kMaxLyricCells) return;
  for (int i = 0; i < n; ++i) cells[i] = from[i];
  count = n;
}

bool decodeLyricCells(const std::string& encoded, int lineStartMs,
                      LyricCellTable* out) {
  out->clear();
  if (encoded.empty()) return false;
  // The line's own start has to be known before the offsets mean anything. The
  // service only ever emits `lyricw` inside the `lyricat` branch, so this is a
  // malformed document rather than an older one.
  if (lineStartMs < 0) return false;

  // Written straight into the destination and COMMITTED LAST. `count` stays 0
  // until the final line of this function, so every rejection below leaves an
  // empty table behind — no intermediate buffer needed to get that guarantee,
  // which matters because this .so has a size budget (hostcheck/link-audit.sh)
  // and a second container is measured in kilobytes of template code.
  int seen = 0;  // numbers read so far; the pair is (seen/2, seen%2)
  int offset = 0;
  size_t start = 0;
  while (true) {
    size_t comma = encoded.find(',', start);
    if (comma == std::string::npos) comma = encoded.size();
    const size_t length = comma - start;
    // Nine digits is 11.5 days of offset. Anything longer is not a lyric, and
    // refusing it here is also what keeps the accumulate below inside an int.
    if (length == 0 || length > 9) return false;
    int value = 0;
    for (size_t i = start; i < comma; ++i) {
      const char c = encoded[i];
      // Digits only, and no sign: encodeLyricCells clamps both numbers to zero
      // before it writes them, so a '-' here is a corrupted document. atoi would
      // read "12x" as 12 and light a glyph at a time nobody sang.
      if (c < '0' || c > '9') return false;
      value = value * 10 + (c - '0');
    }
    if ((seen & 1) == 0) {
      if (seen / 2 >= kMaxLyricCells) return false;
      offset = value;
    } else {
      LyricCell& cell = out->cells[seen / 2];
      cell.startMs = lineStartMs + offset;
      cell.endMs = cell.startMs + value;
    }
    ++seen;
    if (comma >= encoded.size()) break;
    start = comma + 1;
  }
  // Two numbers per cell. An odd count means the table was truncated in flight,
  // and half of it is not a shorter table — every pair after the cut would be
  // one field out of step, which is the silent wrong-glyph failure.
  if (seen == 0 || (seen & 1) != 0) return false;

  out->count = seen / 2;
  return true;
}

LyricCursor lyricCursorFromProgress(float progress, int glyphCount) {
  LyricCursor cursor;
  if (glyphCount <= 0) return cursor;
  const float p = unitf(progress);
  if (p >= 1.f) {
    cursor.index = glyphCount - 1;
    cursor.frac = 1.f;
    cursor.progress = 1.f;
    cursor.phase = kLyricHeld;
    return cursor;
  }
  // (int) rather than floorf: p is non-negative here, so they agree, and this is
  // the cast the three painters have always used.
  int index = static_cast<int>(p * static_cast<float>(glyphCount));
  if (index >= glyphCount) index = glyphCount - 1;
  cursor.index = index;
  cursor.frac = p * static_cast<float>(glyphCount) - static_cast<float>(index);
  cursor.progress = p;
  cursor.phase = kLyricSinging;
  return cursor;
}

LyricCursor lyricCursorAt(const LyricCell* cells, int cellCount, int lineStartMs,
                          int lineEndMs, int glyphCount, int playheadMs) {
  LyricCursor cursor;
  if (glyphCount <= 0) return cursor;

  if (cells == 0 || cellCount != glyphCount) {
    // No usable table: the even sweep, clamped the way lineProgress() clamps —
    // see lyricCursorFromProgress for why a playhead before the line is progress
    // 0 here and not the reference's "pending".
    const int span = lineEndMs > lineStartMs ? lineEndMs - lineStartMs : 1;
    const int into = playheadMs > lineStartMs ? playheadMs - lineStartMs : 0;
    return lyricCursorFromProgress(static_cast<float>(into) / static_cast<float>(span),
                                   glyphCount);
  }

  if (playheadMs < cells[0].startMs) return cursor;  // pending

  // The last LIT cell the singer has reached, and the last lit cell there is.
  // Zero-width cells are whitespace: they keep the index aligned with the row and
  // are skipped here so the cursor can never come to rest on a space.
  int last = -1;
  int lastLit = -1;
  for (int i = 0; i < glyphCount; ++i) {
    if (cells[i].endMs <= cells[i].startMs) continue;
    lastLit = i;
    if (cells[i].startMs <= playheadMs) last = i;
  }
  if (last < 0) return cursor;  // pending

  const LyricCell& cell = cells[last];
  if (playheadMs >= cell.endMs) {
    if (last >= lastLit && playheadMs >= lineEndMs) {
      // Sung out. Pinned at the row's end rather than at the last lit cell, so a
      // line ending in punctuation or a space still reads as complete.
      cursor.index = glyphCount - 1;
      cursor.frac = 1.f;
      cursor.progress = 1.f;
      cursor.phase = kLyricHeld;
      return cursor;
    }
    // Between two words. Hold on the glyph that just finished rather than
    // advancing into one the singer has not reached — AMLL's per-word clamp.
    cursor.index = last;
    cursor.frac = 1.f;
    cursor.progress = static_cast<float>(last + 1) / static_cast<float>(glyphCount);
    cursor.phase = kLyricSinging;
    return cursor;
  }

  cursor.index = last;
  cursor.frac = static_cast<float>(playheadMs - cell.startMs) /
                static_cast<float>(cell.endMs - cell.startMs);
  cursor.progress = (static_cast<float>(last) + cursor.frac) /
                    static_cast<float>(glyphCount);
  cursor.phase = kLyricSinging;
  return cursor;
}

float lyricWindowProgress(int lineStartMs, int lineEndMs, int lineUntilMs,
                          int playheadMs) {
  const int until = lineUntilMs > lineStartMs ? lineUntilMs : lineEndMs;
  if (until <= lineStartMs) return 0.f;
  return unitf(static_cast<float>(playheadMs - lineStartMs) /
               static_cast<float>(until - lineStartMs));
}

}  // namespace tcos
