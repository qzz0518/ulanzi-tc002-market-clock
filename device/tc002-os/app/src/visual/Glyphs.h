#ifndef VISUAL_GLYPHS_H_
#define VISUAL_GLYPHS_H_

#include <stdint.h>

namespace tcos {
namespace glyphs {

// Cell geometry. A 12 px CJK cell on a 16 px panel leaves 4 px of vertical
// slack, and 52 / 12 = 4 characters across — which is exactly why this firmware
// puts one item on a page instead of a row of them.
static const int kCellHeight = 12;
static const int kCjkWidth = 12;
static const int kLatinWidth = 6;

// A row bitmap, MSB = leftmost column. CJK rows use the low 12 bits, Latin the
// low 6. Both tables are generated offline by tools/gen-fonts.py and shared with
// the browser preview through scripts/gen-web-glyphs.ts; test/pixel-glyphs.test.ts
// asserts the two sides bit-for-bit, which is what makes the preview truthful.
struct Bitmap {
  const uint16_t* rows;  // kCellHeight entries, or NULL when unmapped
  int width;             // kCjkWidth or kLatinWidth
};

// Half-width for ASCII 0x20..0x7E, full-width for everything else. Kept as one
// predicate so layout and drawing can never disagree about a cell's width.
inline bool isHalfWidth(uint32_t cp) { return cp >= 0x20 && cp <= 0x7E; }
inline int cellWidth(uint32_t cp) { return isHalfWidth(cp) ? kLatinWidth : kCjkWidth; }

// Looks a codepoint up in whichever table owns it. Returns a Bitmap with a NULL
// `rows` when the glyph is absent — callers skip it rather than substituting,
// so a missing glyph shows as a gap instead of silently shifting the line.
Bitmap lookup(uint32_t cp);

// Table sizes, exposed for the host self-check.
int cjkCount();
int latinCount();

}  // namespace glyphs
}  // namespace tcos

#endif  // VISUAL_GLYPHS_H_
