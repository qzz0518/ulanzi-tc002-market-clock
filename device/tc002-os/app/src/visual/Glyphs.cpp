#include "visual/Glyphs.h"

// THE ONLY TRANSLATION UNIT ALLOWED TO INCLUDE THESE HEADERS.
//
// Both tables are `static const` arrays defined in headers, so every additional
// includer gets its own private copy: the CJK table alone is ~145 KB of .rodata
// on a device with about 1 MB free. Funnelling every lookup through this file
// keeps exactly one copy in the binary. device/tc002-os/hostcheck/selfcheck.cpp
// guards the rule with a grep so it cannot quietly regress.
#include "shared-visual/CjkFont.h"
#include "shared-visual/LatinFont.h"

namespace tcos {
namespace glyphs {

namespace {

const int kCjkCount = sizeof(lyricsvisual::kCjkGlyphs) / sizeof(lyricsvisual::kCjkGlyphs[0]);
const int kLatinCount = sizeof(lyricsvisual::kLatinGlyphs) / sizeof(lyricsvisual::kLatinGlyphs[0]);

// The CJK table is generated sorted by codepoint (gen-fonts.py guarantees it and
// scripts/gen-web-glyphs.ts re-asserts strict ascent), so lookup is a binary
// search: ~13 comparisons over 5195 entries instead of a 5195-step scan, which
// matters because a full line of text does one lookup per cell per frame.
const lyricsvisual::CjkGlyph* findCjk(uint32_t cp) {
  int lo = 0;
  int hi = kCjkCount - 1;
  while (lo <= hi) {
    const int mid = lo + (hi - lo) / 2;
    const uint32_t at = lyricsvisual::kCjkGlyphs[mid].cp;
    if (at == cp) return &lyricsvisual::kCjkGlyphs[mid];
    if (at < cp) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return 0;
}

}  // namespace

Bitmap lookup(uint32_t cp) {
  Bitmap out;
  out.rows = 0;
  out.width = cellWidth(cp);

  if (isHalfWidth(cp)) {
    // ASCII 0x20..0x7E is contiguous by construction, so this is an index.
    const int index = static_cast<int>(cp) - 0x20;
    if (index >= 0 && index < kLatinCount) {
      out.rows = lyricsvisual::kLatinGlyphs[index].rows;
    }
    return out;
  }

  const lyricsvisual::CjkGlyph* g = findCjk(cp);
  if (g != 0) out.rows = g->rows;
  return out;
}

int cjkCount() { return kCjkCount; }
int latinCount() { return kLatinCount; }

}  // namespace glyphs
}  // namespace tcos
