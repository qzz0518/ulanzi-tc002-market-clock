#ifndef CORE_LYRICTIMING_H_
#define CORE_LYRICTIMING_H_

#include <string>

namespace tcos {

/**
 * When one glyph of the current lyric line is sung, in ABSOLUTE track ms.
 *
 * The service splits the line's words into one cell per codepoint and ships the
 * result as `lyricw` (ADR 0008). The split happens there rather than here on
 * purpose: it is a pure function with tests, both firmwares get the same answer,
 * and the wire table's index IS the glyph index this firmware's layoutRow()
 * produces — so there is no arithmetic on the device that can disagree about
 * which character is being sung.
 *
 * A whitespace cell is declared with zero width (endMs == startMs). It holds an
 * index so the table stays aligned with the row, and it can never be the cursor:
 * a highlight coming to rest on a space reads as a dropped character.
 */
struct LyricCell {
  int startMs;
  int endMs;

  LyricCell() : startMs(0), endMs(0) {}
};

/**
 * Ceiling on a decoded table.
 *
 * The service clamps a lyric label to 24 cells, so a real table is at most 24
 * pairs; this is the bound that keeps a malformed document from growing a vector
 * without limit on a device with ~1 MB free. It matches MusicScreen's own
 * kMaxCells, which is the most glyphs the panel will ever lay out.
 */
const int kMaxLyricCells = 96;

/**
 * A decoded table: a fixed array and a count, deliberately NOT a std::vector.
 *
 * This is a size decision, and it is the whole reason the type exists. The table
 * is held in three places — the parsed document, the snapshot the UI thread
 * reads, and the screen itself — so a vector<LyricCell> instantiates its
 * allocate/grow/copy machinery into three translation units of a .so that has a
 * size budget to live inside (hostcheck/link-audit.sh). The array costs 772
 * bytes of RAM per holder on a box with ~1 MB free, which is the cheaper side of
 * that trade by a wide margin — and it also takes three heap allocations per
 * document off the poll path, which is the part that runs ten times a second.
 *
 * `count` is the only field a reader may trust: decodeLyricCells writes cells in
 * place and publishes the count last, so a refused table leaves stale bytes in
 * `cells` that no caller can reach.
 */
struct LyricCellTable {
  LyricCell cells[kMaxLyricCells];
  int count;

  LyricCellTable() : count(0) {}

  bool empty() const { return count == 0; }
  void clear() { count = 0; }
  /** Copies a foreign table in, refusing (as empty) anything over the ceiling. */
  void assign(const LyricCell* from, int n);
};

/**
 * Decodes `lyricw`: `d0,w0,d1,w1,…`, offsets and widths relative to the line's
 * start (which is already on the wire as `lyricat`).
 *
 * The exact inverse of encodeLyricCells() in src/music/lyric-timing.ts — that
 * function's own comment says "the firmwares implement this same loop", so this
 * is the loop it means. One comma-separated field rather than tab-separated
 * columns because StateDoc::splitTabs stops after three tabs; do not "fix" that.
 *
 * ALL OR NOTHING. An odd count, an empty field, a non-digit, a table longer than
 * kMaxLyricCells: every one of them returns false with `out` left empty, and the
 * caller falls back to the line-level sweep. A half-read table is the one
 * failure that cannot be seen on a screenshot — it lights the wrong character
 * for the rest of the song and looks like a font bug.
 */
bool decodeLyricCells(const std::string& encoded, int lineStartMs,
                      LyricCellTable* out);

/**
 * Which glyph the singer is on.
 *
 * kLyricPending is "the line has not started"; kLyricHeld is "it is sung out and
 * still on the panel", which is a state only a service that separates the sung
 * end from the display window can express. Both are drawn the same way — the
 * whole row in the sung tier, no focused glyph — matching the browser preview,
 * where an absent focus span paints every column secondary.
 */
enum LyricPhase { kLyricPending = 0, kLyricSinging = 1, kLyricHeld = 2 };

struct LyricCursor {
  int index;       // glyph being sung, or -1
  float frac;      // position inside that glyph, 0..1; pinned at 1 in a word gap
  float progress;  // (index + frac) / glyphCount — the geometry every mode uses
  LyricPhase phase;

  LyricCursor() : index(-1), frac(0.f), progress(0.f), phase(kLyricPending) {}
};

/**
 * The cursor a bare scalar progress produces — `floor(p * n)` and `p`, bit for
 * bit, which is the arithmetic all three renderers shared before word timings
 * existed.
 *
 * Deliberately has no "pending": this firmware clamps a playhead before the line
 * to progress 0 and paints the first glyph, and that is what it has always
 * drawn. Returning -1 here instead would repaint every legacy frame at the head
 * of a line.
 */
LyricCursor lyricCursorFromProgress(float progress, int glyphCount);

/**
 * The cursor at a playhead, walking the table when there is one.
 *
 * A strict generalisation of lyricCursorFromProgress(): a table that is not
 * exactly one cell per glyph is REFUSED rather than trimmed, and the line falls
 * back to the even sweep. The two can only disagree by a whole glyph, and being
 * one glyph out of step for a whole song is worse than not walking the words.
 */
LyricCursor lyricCursorAt(const LyricCell* cells, int cellCount, int lineStartMs,
                          int lineEndMs, int glyphCount, int playheadMs);

/**
 * How far into the line's DISPLAY window the playhead is, as distinct from how
 * far into the singing.
 *
 * Only the cascade mode's entrance/exit choreography may use this. With the sung
 * progress now pinning at 1 the moment the voice stops, keying the exit ramp on
 * it would fly the line off the panel at the start of a 13-second instrumental
 * and leave the panel blank until the next line — the exact regression
 * OS_PROTO_LYRIC_WINDOW exists to keep off un-upgraded devices.
 *
 * `lineUntilMs` at or below `lineStartMs` means the service did not send one, in
 * which case the window IS the sung span and this equals the sung progress.
 */
float lyricWindowProgress(int lineStartMs, int lineEndMs, int lineUntilMs,
                          int playheadMs);

}  // namespace tcos

#endif  // CORE_LYRICTIMING_H_
