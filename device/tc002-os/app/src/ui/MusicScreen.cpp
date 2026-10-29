#include "ui/MusicScreen.h"

#include <math.h>

#include "core/Ease.h"
#include "core/Text.h"
#include "visual/Glyphs.h"
#include "visual/LyricRings.h"
#include "visual/LyricVisuals.h"

namespace tcos {

namespace {

using lyricsvisual::CASCADE_ENTER;
using lyricsvisual::CASCADE_EXIT;
using lyricsvisual::Palette;
using lyricsvisual::SKYLINE_BARS;
using lyricsvisual::beatKick;
using lyricsvisual::cascadeBandY;
using lyricsvisual::cascadePhase;
using lyricsvisual::lm_unit;
using lyricsvisual::paletteFor;
using lyricsvisual::scaled;
using lyricsvisual::skylineBarLevel;
using lyricsvisual::spanIndexAtPx;
using lyricsvisual::spotlightOffsetPx;

// LyricsPage.cpp's VIEW_X / VIEW_W. Ticker, skyline and cascade draw inside
// [2, 50); spotlight alone passes the full panel, which is why its text bleeds
// off both edges while the others hold a 2 px margin.
const int kViewX = 2;
const int kViewW = 48;

// LyricsPage lays out at most 96 cells and drops the rest. Same cap here, or a
// long line would diverge at exactly the length where the scroll starts to
// matter — and a stack array would be the thing that noticed.
const int kMaxCells = 96;

// A lyric line that arrived without a window animates over this span. It is the
// reference's own fallback for a song's last line (endMs = startMs + 4000), so
// an older service that sends `lyric` but not `lyricat`/`lyricend` still gets
// motion in every mode instead of a line frozen at progress 0.
const int kUntimedLineMs = 4000;

// The press wash and the entry fade, both this firmware's own.
const int kFlashMs = 200;
const int kEntryFadeMs = 320;

struct Cell {
  uint32_t cp;
  int width;
  int startX;
};

// LyricsPage::FrameCtx: everything a painter is allowed to read, snapshotted
// once per frame. The painters are pure functions of it, which is what lets the
// host self-check assert their pixels.
struct FrameCtx {
  const Palette* pal;
  const Cell* cells;
  int n;
  int totalW;
  float prog;   // progress within the current line, 0..1
  // Progress through the line's DISPLAY window, which is later than `prog`
  // whenever an instrumental follows the line. ONLY the cascade choreography may
  // read it; colouring, focus glyph, fill bar, beat and scroll all run on the
  // sung clock. Equal to `prog` unless the service sent a `lyricuntil`, which is
  // what keeps an old service's frames unchanged.
  float windowProg;
  // Where the singer is, per glyph. Without a cell table this is the scalar
  // `prog` re-expressed — floor(p*n) and p, bit for bit — so the painters below
  // read one field instead of branching.
  LyricCursor cursor;
  // The cursor came from a real per-glyph table rather than from the even sweep.
  bool timedCells;
  // The service separates the sung end from the display window for this line, so
  // "sung out and holding" is a state the panel can distinguish at all. Without
  // it, past-the-end means the next line is due right now — which is what this
  // firmware has always drawn, and must keep drawing.
  bool split;
  float track;  // progress through the whole track, 0..1
  float animMs;
  bool playing;
  // The line belongs to the chorus: every mode ripples the glyph being sung.
  bool chorus;
  // 火花, from the theme.
  bool sparks;
  // The line's start in track ms, or -1 when it has no window: seeds which 倾诉
  // phrase leans and where each spark flies.
  int lineStartMs;
  // How far into the line the playhead is, for 倾诉's surfacing glyphs; a large
  // number (everything shown) when the row is not a timed lyric.
  long sinceLineMs;
  // "This row is a timed lyric line", and nothing more. It is the beat input —
  // beatKick snaps on each glyph when it is set and falls back to a 120 BPM
  // pulse when it is not. It deliberately does NOT mean "there is a row to
  // draw": on this firmware the row is also the title/artist rotation, or the
  // 播放中 / 已暂停 fallback under it, and those are text too.
  bool hasLyric;
};

// The glyph to light, or -1 for "nothing is being sung right now".
//
// -1 covers the two ends of a line the wire can only name since ADR 0008: before
// its first word, and during the hold after its last. The painters draw both the
// same way — the whole row in the sung tier, no focus glyph — which is what the
// browser preview does when it has no focus span, and what makes a finished line
// read as finished rather than as one character stuck glowing for thirteen
// seconds.
int focusCell(const FrameCtx& f) {
  if (f.split && f.cursor.phase != kLyricSinging) return -1;
  return f.cursor.index;
}

// The beat has something to snap to only while a glyph is actually in progress.
// In a gap between words, and through the hold at the end of a line, the cursor
// is pinned at the end of a cell and beatKick's per-glyph term would sit at full
// scale — a spectrum slammed to maximum for the whole instrumental. Falling back
// to its free-running 120 BPM pulse there is what the flag is for.
//
// THE HOLD IS CHECKED BEFORE THE TABLE, and that order is the whole of it. The
// commonest proto-2 shape is a `lyricuntil` with NO `lyricw` — four fifths of
// tracks carry no word timings — and there the cursor is the even sweep, pinned
// at progress 1 for the entire hold. beatKick's per-glyph term is
// 1 - fract(1 * n), which is 1 for any integer glyph count: maximum energy, for
// as long as the line stays up. Consulting `timedCells` first would skip
// straight past that, which is exactly the failure this function exists to
// prevent, on the wire shape it will meet most often. `split` is the guard
// because only a service that separates the two clocks can tell a hold from
// "the next line is due right now"; it is false on every legacy frame, so those
// keep the beat they always had.
bool beatIsTimed(const FrameCtx& f) {
  if (!f.hasLyric) return false;
  if (f.split && f.cursor.phase != kLyricSinging) return false;
  if (!f.timedCells) return true;  // the even sweep: unchanged from before
  return f.cursor.frac < 1.f;
}

// ---- UTF-8 layout ----------------------------------------------------------

// LyricsPage::layoutRow. glyphs::cellWidth is bit-for-bit the reference's own
// predicate (half width for ASCII 0x20..0x7E, full width for everything else),
// so the two firmwares cannot disagree about where a cell starts — and this
// firmware needs no font code of its own, which keeps the glyph tables inside
// visual/Glyphs.cpp where the build guard requires them.
int layoutRow(const char* utf8, Cell* cells, int maxCells, int& totalWidth) {
  int n = 0;
  totalWidth = 0;
  const char* p = utf8;
  while (*p && n < maxCells) {
    const uint32_t cp = text::utf8Next(p);
    cells[n].cp = cp;
    cells[n].width = glyphs::cellWidth(cp);
    cells[n].startX = totalWidth;
    totalWidth += cells[n].width;
    ++n;
  }
  return n;
}

// LyricsPage::blitGlyph. One cell, one colour: the whole reason core/Text.h's
// draw() cannot serve here is that every mode colours per cell (sung / focused /
// trailing) and positions per cell.
void blitGlyph(Surface& s, const Cell& cell, int gx, int y, const Color& c, int viewX,
               int viewW) {
  const glyphs::Bitmap bitmap = glyphs::lookup(cell.cp);
  if (bitmap.rows == 0) return;  // unmapped: a gap, never a shifted line
  const int height = s.getHeight();
  for (int row = 0; row < glyphs::kCellHeight; ++row) {
    const int ty = y + row;
    if (ty < 0 || ty >= height) continue;
    const uint16_t mask = bitmap.rows[row];
    if (mask == 0) continue;
    for (int col = 0; col < bitmap.width; ++col) {
      if ((mask & (1 << (bitmap.width - 1 - col))) == 0) continue;
      const int px = gx + col;
      if (px >= viewX && px < viewX + viewW) s.setPixel(px, ty, c);
    }
  }
}

// LyricsPage::scrollOffsetFor — the web preview's whole-cell snapped scroll.
// The 8% dead zone at each end and the 12 px quantisation are the mode note
// "整字格变速"; a continuous scroll here would read as a different mode.
int scrollOffsetFor(int totalWidth, float lyricProgress, int mode) {
  if (mode == MusicScreen::kModeSpotlight) return spotlightOffsetPx(totalWidth, lyricProgress);
  int aligned = ((totalWidth + 11) / 12) * 12;
  int travel = aligned - kViewW;
  if (travel <= 0) return 0;
  float t = (lm_unit(lyricProgress) - 0.08f) / (0.92f - 0.08f);
  t = lm_unit(t);
  float ss = t * t * (3.f - 2.f * t);
  int cont = (int)lroundf(travel * ss);
  int snapped = (int)lroundf((float)cont / 12.f) * 12;
  if (snapped > travel) snapped = travel;
  return snapped;
}

// ---- progress cue row ------------------------------------------------------

// LyricsPage::cueRow. The cursor is plotted last on purpose: it overwrites an
// anchor when it lands on one, rather than being swallowed by it.
void cueRow(Surface& s, const Palette& pal, int y, float progress, int trailPx) {
  const int startX = kViewX, travel = kViewW - 1;  // 47
  s.setPixel(startX, y, pal.muted);
  s.setPixel(startX + (travel / 2), y, pal.muted);
  s.setPixel(startX + travel, y, pal.muted);
  int cursorX = startX + (int)lroundf(travel * lm_unit(progress));
  int trail = trailPx;
  if (trail > cursorX - startX) trail = cursorX - startX;
  for (int i = 0; i < trail; ++i) s.setPixel(cursorX - 1 - i, y, pal.secondary);
  s.setPixel(cursorX, y, pal.primary);
}

// ---- ripple and interlude ---------------------------------------------------

const Color& tierColor(const Palette& pal, lyricrings::Tier tier) {
  switch (tier) {
    case lyricrings::kTierPrimary: return pal.primary;
    case lyricrings::kTierSecondary: return pal.secondary;
    case lyricrings::kTierContext: return pal.context;
    default: return pal.muted;
  }
}

// The glyph actually being sung, or -1 before the line and after it. A space
// has no ink, so the ripple and the lift find nothing to draw there on their own.
//
// Before the line's start, too. An untimed line's cursor reads a playhead before
// the window as progress 0 — glyph 0 "singing" — which the reference modes keep
// for their colouring, but a ring or a spark thrown before the first word is
// sung would be the panel getting ahead of the singer, and the browser (whose
// cursor says "pending" there) draws none.
int singingCell(const FrameCtx& f) {
  if (f.cursor.phase != kLyricSinging) return -1;
  if (f.sinceLineMs < 0) return -1;
  if (f.cursor.index < 0 || f.cursor.index >= f.n) return -1;
  return f.cursor.index;
}

// Where every mode but 聚光 puts the row's left edge.
int lineStartX(const FrameCtx& f, int mode) {
  return f.totalW <= kViewW ? (kPanelWidth - f.totalW) / 2
                            : kViewX - scrollOffsetFor(f.totalW, f.prog, mode);
}

// 聚光's sung column, in bitmap pixels. Without a table this is the old
// arithmetic untouched; with one it is the cursor's own cell, walked at the rate
// the words were sung (the browser's focusPixelAt).
float spotlightFocusPx(const FrameCtx& f) {
  if (f.timedCells) {
    int at = f.cursor.index;
    if (at < 0) at = 0;
    if (at >= f.n) at = f.n - 1;
    const Cell& cell = f.cells[at];
    float focusPx = (float)cell.startX;
    if (f.cursor.index >= 0) focusPx += lm_unit(f.cursor.frac) * (float)cell.width;
    return focusPx;
  }
  return lm_unit(f.prog) * f.totalW;
}

// Screen x of 聚光's bitmap left edge. The lock is the same 26 - focusPx either
// way; the legacy branch keeps the literal expression it always had so no float
// round trip can move a rounded pixel.
int spotlightLineX(const FrameCtx& f, float focusPx) {
  return f.timedCells && f.totalW > 0 ? spotlightOffsetPx(f.totalW, focusPx / (float)f.totalW)
                                      : spotlightOffsetPx(f.totalW, f.prog);
}

// True when a glyph other than `focus` has ink within one pixel of (x, y). Only
// the two neighbours can reach: the ring goes at most two columns past its own
// cell and the gutter one more, and the narrowest cell is six wide.
bool neighbourInkNear(const FrameCtx& f, int focus, int lineX, int lineY, int x, int y) {
  for (int side = -1; side <= 1; side += 2) {
    const int index = focus + side;
    if (index < 0 || index >= f.n) continue;
    const Cell& cell = f.cells[index];
    const glyphs::Bitmap bitmap = glyphs::lookup(cell.cp);
    if (bitmap.rows == 0) continue;
    for (int dy = -1; dy <= 1; ++dy) {
      const int row = y + dy - lineY;
      if (row < 0 || row >= glyphs::kCellHeight) continue;
      for (int dx = -1; dx <= 1; ++dx) {
        const int col = x + dx - lineX - cell.startX;
        if (col < 0 || col >= cell.width || col >= bitmap.width) continue;
        if (bitmap.rows[row] & (1 << (bitmap.width - 1 - col))) return true;
      }
    }
  }
  return false;
}

// One ring around the glyph being sung: every pixel at exactly `radius`
// (Chebyshev) from its ink. Painted before the row, so text and cues land on
// top. The glyph's own cell stays clear — a ring in its counters reads as a
// bolder glyph — and so does a one-pixel gutter around every other glyph's
// strokes, so the ring can run down the gaps between characters without
// fattening a neighbour. On a full line that gap and the rows above and below
// are all the room there is. The browser's paintHalo, pixel for pixel.
void paintHalo(Surface& s, const FrameCtx& f, int focus, int lineX, int lineY, int hopPx,
               int radius) {
  const Cell& cell = f.cells[focus];
  const glyphs::Bitmap bitmap = glyphs::lookup(cell.cp);
  if (bitmap.rows == 0) return;
  const int glyphY = lineY - hopPx;
  const int glyphLeft = lineX + cell.startX;
  const int glyphRight = glyphLeft + cell.width;
  int inkX[glyphs::kCellHeight * 16];
  int inkY[glyphs::kCellHeight * 16];
  int ink = 0;
  for (int row = 0; row < glyphs::kCellHeight; ++row) {
    const uint16_t mask = bitmap.rows[row];
    for (int col = 0; col < bitmap.width && col < 16; ++col) {
      if ((mask & (1 << (bitmap.width - 1 - col))) == 0) continue;
      inkX[ink] = glyphLeft + col;
      inkY[ink] = glyphY + row;
      ++ink;
    }
  }
  if (ink == 0) return;
  const Color& c = tierColor(*f.pal, lyricrings::haloTier(radius));
  for (int y = glyphY - radius; y < glyphY + glyphs::kCellHeight + radius; ++y) {
    if (y < 0 || y >= kPanelHeight) continue;
    for (int x = glyphLeft - radius; x < glyphRight + radius; ++x) {
      if (x < 0 || x >= kPanelWidth) continue;
      if (y >= glyphY && y < glyphY + glyphs::kCellHeight && x >= glyphLeft && x < glyphRight) continue;
      int distance = 1 << 20;
      for (int i = 0; i < ink && distance >= radius; ++i) {
        const int dx = x > inkX[i] ? x - inkX[i] : inkX[i] - x;
        const int dy = y > inkY[i] ? y - inkY[i] : inkY[i] - y;
        const int d = dx > dy ? dx : dy;
        if (d < distance) distance = d;
      }
      if (distance != radius) continue;
      if (neighbourInkNear(f, focus, lineX, lineY, x, y)) continue;
      s.setPixel(x, y, c);
    }
  }
}

// The chorus ripple the four reference modes share: no lift, row where the mode
// put it.
void paintChorusHalo(Surface& s, const FrameCtx& f, int lineX, int lineY) {
  if (!f.chorus) return;
  const int focus = singingCell(f);
  if (focus < 0) return;
  paintHalo(s, f, focus, lineX, lineY, 0, lyricrings::haloRadius(f.cursor.frac));
}

// The instrumental after a line, the same in every mode: three dots filling as
// the next line nears, and the track cue on row 15. The browser's
// paintInterlude.
void paintInterlude(Surface& s, const Palette& pal, float progress, float track, float animMs) {
  cueRow(s, pal, 15, track, 1);
  for (int dot = 0; dot < lyricrings::kInterludeDots; ++dot) {
    const Color& c = tierColor(pal, lyricrings::interludeDotTier(dot, progress, animMs));
    const int x = lyricrings::kInterludeDotX[dot];
    const int y = lyricrings::kInterludeDotY;
    s.setPixel(x, y, c);
    s.setPixel(x + 1, y, c);
    s.setPixel(x, y + 1, c);
    s.setPixel(x + 1, y + 1, c);
  }
}

// ---- per-mode painters -----------------------------------------------------

// LyricsPage's karaokeColorAt: sung glyphs behind the cursor, the focus glyph
// lit, the rest waiting — and, when NO glyph is being sung, the whole row in the
// sung tier. That last case is only reachable once the service separates the two
// clocks, and it is what a held line looks like: complete, not frozen mid-wipe.
const Color& karaokeColor(const Palette& pal, int index, int focus) {
  if (focus < 0 || index < focus) return pal.secondary;
  return index == focus ? pal.primary : pal.context;
}

// 走带: karaoke colouring, in-line cue on row 0, whole-track cue on row 15.
//
// The cue on row 0 and the 12 px scroll both ride the sung progress, so they
// speed up and slow down with the singer. The scroll quantises to whole cells,
// which makes it nearly indifferent to where inside a glyph the cursor is; the
// COLOURING is not indifferent at all, and it is the reason this mode reads as
// karaoke rather than as a marquee.
void paintTicker(Surface& s, const FrameCtx& f) {
  const Palette& pal = *f.pal;
  paintChorusHalo(s, f, lineStartX(f, MusicScreen::kModeTicker), 2);
  cueRow(s, pal, 0, f.prog, 2);
  cueRow(s, pal, 15, f.track, 1);
  const int focus = focusCell(f);
  int startX = f.totalW <= kViewW ? (kPanelWidth - f.totalW) / 2
                                  : kViewX - scrollOffsetFor(f.totalW, f.prog, MusicScreen::kModeTicker);
  for (int i = 0; i < f.n; ++i) {
    blitGlyph(s, f.cells[i], startX + f.cells[i].startX, 2, karaokeColor(pal, i, focus),
              kViewX, kViewW);
  }
}

// 天际: the ONLY mode with a spectrum, and it is a full-width floor on rows
// 13..15 with row 12 as the gutter — never a panel beside the text. That
// distinction is the whole of the reported bug: a 12 px equaliser at x=0 leaves
// 38 of 52 columns for the lyric and covers the rest of it.
//
// Word timings reach it twice: the karaoke colouring, exactly as in 走带, and the
// BEAT, which snaps on each glyph the singer actually starts instead of on a
// twelfth of the line every twelfth of its window. On a line whose first word is
// held for 1.4 s the difference is audible-looking — the bars settle for the held
// note and then rattle through the run that follows.
void paintSkyline(Surface& s, const FrameCtx& f) {
  const Palette& pal = *f.pal;
  // Three levels, always, and the text is always drawn.
  //
  // The reference computes `showText = hasLyric || !playing` and `maxLevel =
  // showText ? 3 : 12` right here, and that expression is NOT portable. Its own
  // gate — LyricsPage.cpp:227, a painter runs only once a timed line exists —
  // makes hasLyric unconditionally true for every frame that reaches it, so the
  // 12-level branch is unreachable there and the bars have never been anything
  // but a three-row floor under a full line of text.
  //
  // This screen has a second source for the row: a track whose lyric lookup
  // failed still shows the title/artist rotation, and a track with no resolvable
  // text at all still shows 播放中 / 已暂停. hasLyric is genuinely false for
  // both, which is the ordinary case on Spotify Connect. Copying the expression
  // therefore woke the dead branch and answered "频谱动画挡字" with a stronger
  // version of it — a 12-row spectrum and not one word.
  const int maxLevel = 3;
  paintChorusHalo(s, f, lineStartX(f, MusicScreen::kModeSkyline), 0);
  float kick = beatKick(f.playing, beatIsTimed(f), f.prog, f.n, f.animMs);
  for (int bar = 0; bar < SKYLINE_BARS; ++bar) {
    int x = 1 + bar * 3;
    int level = skylineBarLevel(bar, f.animMs, f.playing, kick, maxLevel);
    s.setPixel(x, 15, pal.muted);
    s.setPixel(x + 1, 15, pal.muted);
    for (int step = 1; step <= level; ++step) {
      const Color& c = (level <= 1) ? pal.muted
                                    : (step == level && level == maxLevel ? pal.primary : pal.secondary);
      s.setPixel(x, 15 - (step - 1), c);
      s.setPixel(x + 1, 15 - (step - 1), c);
    }
  }
  const int focus = focusCell(f);
  int startX = f.totalW <= kViewW ? (kPanelWidth - f.totalW) / 2
                                  : kViewX - scrollOffsetFor(f.totalW, f.prog, MusicScreen::kModeSkyline);
  for (int i = 0; i < f.n; ++i) {
    blitGlyph(s, f.cells[i], startX + f.cells[i].startX, 0, karaokeColor(pal, i, focus),
              kViewX, kViewW);
  }
}

// 聚光: the sung pixel column is locked to x=26 and the line slides under it.
// The asymmetry is deliberate — brackets at 19/32, fill meter spanning 20..31.
//
// THIS IS THE MODE THE WORD TIMINGS ARE FOR. Every other mode can be read as an
// even wipe that happens to be paced badly; here the panel makes a claim about a
// single pixel column — "the singer is on THIS character, this far into it" — and
// `progress * textWidth` only finds that column when time is spread evenly over
// the row. It is not: the singer holds one glyph for a second and then races
// through four. So the focus pixel comes from the cell table when there is one,
// and the line stops gliding while a held note is held.
void paintSpotlight(Surface& s, const FrameCtx& f) {
  const Palette& pal = *f.pal;
  const float focusPx = spotlightFocusPx(f);

  int spanStarts[kMaxCells];
  int limit = f.n < kMaxCells ? f.n : kMaxCells;
  for (int i = 0; i < limit; ++i) spanStarts[i] = f.cells[i].startX;
  // With a table the cursor already knows which glyph it is on; without one the
  // index is still recovered from the pixel column, and that is NOT the same
  // index on a row mixing 6 px and 12 px cells — so the legacy path keeps its own
  // lookup rather than borrowing floor(progress * n).
  int focusIndex = f.timedCells ? f.cursor.index : spanIndexAtPx(spanStarts, limit, (int)focusPx);
  if (f.split && f.cursor.phase != kLyricSinging) focusIndex = -1;

  const int offset = spotlightLineX(f, focusPx);
  // The ripple first and the brackets and cue after it, as the browser draws
  // them; none of the three overlaps the glyph rows, so moving the brackets
  // below the offset arithmetic changes no pixel of the frame without it.
  paintChorusHalo(s, f, offset, 2);
  s.setPixel(19, 1, pal.muted);
  s.setPixel(32, 1, pal.muted);
  cueRow(s, pal, 15, f.track, 1);
  for (int i = 0; i < f.n; ++i) {
    Color c;
    if (focusIndex < 0) {
      // Sung out, or not started. The whole line in the sung tier, still locked
      // under the spotlight — the alternative is one character glowing alone for
      // the length of an instrumental, which reads as a stuck panel.
      c = pal.secondary;
    } else {
      int dist = i - focusIndex;
      if (dist < 0) dist = -dist;
      c = dist == 0 ? pal.primary : (dist == 1 ? pal.secondary : pal.context);
    }
    blitGlyph(s, f.cells[i], offset + f.cells[i].startX, 2, c, 0, kPanelWidth);
  }
  // A finished line has no glyph in progress, so it gets no fill meter either.
  if (focusIndex < 0 || focusIndex >= f.n) return;
  const Cell& span = f.cells[focusIndex];
  float frac = lm_unit((focusPx - span.startX) / (float)(span.width > 0 ? span.width : 1));
  int barW = (int)lroundf(frac * 12.f);
  for (int i = 0; i < barW; ++i) s.setPixel(20 + i, 14, pal.secondary);
}

// 升降: the whole line rises in, holds, and lifts out the top; the track bar is
// the right edge column, which is outside the [2,50) text window by design.
//
// TWO CLOCKS, and this is the only mode that needs both. The choreography rides
// the DISPLAY window and the colouring rides the singing. They were one number
// until the sung end became real; keyed on the sung progress, cascadeBandY's exit
// ramp starts at 0.86 of the SINGING, so the last line of a verse would fly off
// the panel the instant the voice stopped and leave 升降 blank for the whole
// 13.3 s instrumental that follows (ADR 0008). The line has to stay up until its
// successor is due — that is what the window means — while the karaoke wipe
// finishes when the singer does. A break of 3 s or more is the exception: there
// render() hands the row to the interlude dots before this painter runs.
void paintCascade(Surface& s, const FrameCtx& f) {
  const Palette& pal = *f.pal;
  int phase = cascadePhase(f.windowProg, false);
  int bandY = cascadeBandY(f.windowProg, false);
  // Only while the line holds still: a ring left behind by a row in flight
  // would mark where the row was, not where the singer is. Before the track
  // fill, so a ring off a right-edge glyph never punches a hole in column 51.
  if (phase == lyricsvisual::CASCADE_HOLD) {
    paintChorusHalo(s, f, lineStartX(f, MusicScreen::kModeCascade), bandY);
  }
  int fill = (int)lroundf(lm_unit(f.track) * 16.f);
  for (int step = 0; step < fill; ++step) {
    const Color& c = (step == fill - 1) ? pal.primary : pal.muted;
    s.setPixel(51, 15 - step, c);
  }
  const int focus = focusCell(f);
  int startX = f.totalW <= kViewW ? (kPanelWidth - f.totalW) / 2
                                  : kViewX - scrollOffsetFor(f.totalW, f.prog, MusicScreen::kModeCascade);
  for (int i = 0; i < f.n; ++i) {
    Color c;
    if (phase == CASCADE_ENTER) c = pal.secondary;
    else if (phase == CASCADE_EXIT) c = pal.context;
    else c = karaokeColor(pal, i, focus);
    blitGlyph(s, f.cells[i], startX + f.cells[i].startX, bandY, c, kViewX, kViewW);
  }
}

// 年轮: the karaoke row of 走带, with each glyph lifting a pixel as it is sung
// and throwing a ring outward (folia's 52Hz, on a 52 x 16 grid). No cue rows at
// all: rows 0-1 and 14-15 are where the ring has room on a full line, and a cue
// drawn over them hid most of it. The browser's paintRings.
void paintRings(Surface& s, const FrameCtx& f) {
  const Palette& pal = *f.pal;
  const int lineX = lineStartX(f, MusicScreen::kModeRings);
  const int singing = singingCell(f);
  const int hop = singing >= 0 ? lyricrings::ringsHopPx(f.cursor.frac) : 0;
  if (singing >= 0) {
    paintHalo(s, f, singing, lineX, 2, hop, lyricrings::haloRadius(f.cursor.frac));
  }
  const int focus = focusCell(f);
  for (int i = 0; i < f.n; ++i) {
    const int y = i == singing ? 2 - hop : 2;
    blitGlyph(s, f.cells[i], lineX + f.cells[i].startX, y, karaokeColor(pal, i, focus), kViewX,
              kViewW);
  }
}

// 倾诉 (mygo/folia's tilt, on one 16-row line): the glyphs surface one after
// another from just below the row, the one being sung lifts a pixel, and one
// phrase — chosen per line, the same on every replay — is set in the focus
// colour with its glyphs up and down by turns. Track cue under it on row 15.
// The browser's paintTilt.
void paintTilt(Surface& s, const FrameCtx& f) {
  const Palette& pal = *f.pal;
  cueRow(s, pal, 15, f.track, 1);
  const int lineX = lineStartX(f, MusicScreen::kModeTilt);
  uint32_t cps[kMaxCells];
  for (int i = 0; i < f.n; ++i) cps[i] = f.cells[i].cp;
  int unitFrom[kMaxCells];
  int unitTo[kMaxCells];
  const int units = lyricrings::tiltUnits(cps, f.n, unitFrom, unitTo, kMaxCells);
  const int lean = f.hasLyric && f.lineStartMs >= 0 ? lyricrings::tiltLeanUnit(f.lineStartMs, units)
                                                    : -1;
  const int leanFrom = lean >= 0 ? unitFrom[lean] : -1;
  const int leanTo = lean >= 0 ? unitTo[lean] : -1;
  const int singing = singingCell(f);
  const int hop = singing >= 0 ? lyricrings::ringsHopPx(f.cursor.frac) : 0;
  const int focus = focusCell(f);
  for (int i = 0; i < f.n; ++i) {
    const int stage = lyricrings::tiltStage(i, f.sinceLineMs);
    if (stage == 0) continue;
    const bool leaning = i >= leanFrom && i < leanTo;
    int y = 2;
    if (leaning) y += lyricrings::tiltLeanOffset(i - leanFrom, stage);
    else if (stage == 1) y += 1;
    if (i == singing) y -= hop;
    const Color& c = stage == 1 ? pal.muted : (leaning ? pal.primary : karaokeColor(pal, i, focus));
    blitGlyph(s, f.cells[i], lineX + f.cells[i].startX, y, c, kViewX, kViewW);
  }
}

// 火花: sparks off the glyph being sung, drawn first so everything the mode
// paints lands on top. Where the glyph sits is the mode's own row — skyline's
// row 0, cascade's band, spotlight's lock — without the pixel a lift or a lean
// adds, which no spark this size can show. The browser's paintSparks.
void paintSparks(Surface& s, const FrameCtx& f, int mode) {
  if (!f.sparks || !f.hasLyric || f.lineStartMs < 0) return;
  const int focus = singingCell(f);
  if (focus < 0) return;
  int lineY = 2;
  if (mode == MusicScreen::kModeSkyline) lineY = 0;
  if (mode == MusicScreen::kModeCascade) {
    if (cascadePhase(f.windowProg, false) != lyricsvisual::CASCADE_HOLD) return;
    lineY = cascadeBandY(f.windowProg, false);
  }
  const int lineX = mode == MusicScreen::kModeSpotlight ? spotlightLineX(f, spotlightFocusPx(f))
                                                        : lineStartX(f, mode);
  const Cell& cell = f.cells[focus];
  const double hw = (double)cell.width / 2.0;
  const double cx = (double)(lineX + cell.startX) + hw - 0.5;
  const double cy = (double)lineY + (double)glyphs::kCellHeight / 2.0 - 0.5;
  const bool last = focus == f.n - 1;
  const int count = last ? lyricrings::kSparkCountLast : lyricrings::kSparkCount;
  const uint32_t seed = (uint32_t)(f.lineStartMs + focus * 7919);
  const double t = (double)f.cursor.frac;
  if (t >= 1.0) return;
  const lyricrings::Tier tier = lyricrings::sparkTier(t);
  const Color& headColor = tierColor(*f.pal, tier);
  const Color& tailColor = tierColor(*f.pal, lyricrings::dimmerTier(tier));
  for (int spark = 0; spark < count; ++spark) {
    int hx, hy, tx, ty;
    lyricrings::sparkPixels(cx, cy, hw, (double)glyphs::kCellHeight / 2.0, seed, spark, count, last,
                            t, &hx, &hy, &tx, &ty);
    if (tx >= 0 && tx < kPanelWidth && ty >= 0 && ty < kPanelHeight) s.setPixel(tx, ty, tailColor);
    if (hx >= 0 && hx < kPanelWidth && hy >= 0 && hy < kPanelHeight) s.setPixel(hx, hy, headColor);
  }
}

/**
 * LyricsPage::drawIdle, with this firmware's vocabulary.
 *
 * The reference has one emptiness and one word for it ("选择歌曲"); this screen
 * has three and must not share a word between them. So the chrome is the
 * reference's — the slow per-character brightness wave alternating primary and
 * secondary, and the six deterministic sparkles that by construction only ever
 * land on rows 0, 1, 14 and 15 — and the word is ours. Centring generalises the
 * reference's fixed x=2 origin: for its own four full-width cells the two agree
 * exactly, and 离线 is two cells wide, where a flush-left start would read as a
 * layout bug next to a window-filling 未播放.
 *
 * There is deliberately no port of drawLoading: that state means an audio
 * download is in flight on the device, and this firmware never downloads audio.
 * Its "not ready" is a link state, and a link state has words.
 */
void paintIdle(Surface& s, const Palette& pal, float animMs, const char* word, float fade) {
  Cell cells[kMaxCells];
  int totalW = 0;
  const int n = layoutRow(word, cells, kMaxCells, totalW);
  const int startX = (kPanelWidth - totalW) / 2;
  for (int k = 0; k < n; ++k) {
    float wave = 0.6f + 0.4f * sinf(animMs * 0.0025f - k * 0.9f);
    const Color& base = (k % 2 == 0) ? pal.primary : pal.secondary;
    int inten = (int)(wave * fade * 255.f);
    blitGlyph(s, cells[k], startX + cells[k].startX, 2, scaled(base, inten), 0, kPanelWidth);
  }
  // Deterministic sparkles, repositioned every 400 ms. The hash constants are
  // the reference's; an integer hash "for determinism" would be just as
  // deterministic and would no longer be the same screen.
  for (int i = 0; i < 6; ++i) {
    uint32_t slot = (uint32_t)(animMs / 400.f) + (uint32_t)i * 97u;
    uint32_t h = slot * 2654435761u + (uint32_t)i * 40503u;
    int x = (int)(h % 52u);
    int y = ((h >> 8) & 1u) ? (int)(h % 2u) : 14 + (int)(h % 2u);
    float tw = 0.5f + 0.5f * sinf(animMs * 0.004f + i * 1.3f);
    s.setPixel(x, y, scaled(pal.secondary, (int)(tw * fade * 140.f)));
  }
}

}  // namespace

MusicScreen::MusicScreen()
    : mPresent(false), mLinkConfigured(true), mLinkOnline(true), mPlaying(false),
      mPositionMs(0), mDurationMs(0), mStampMs(0), mLyricStartMs(-1), mLyricEndMs(-1),
      mLyricUntilMs(-1), mLyricChorus(false),
      mEnteredMs(0), mLyricChangedMs(0), mFlashMs(-1), mAction(kNone),
      mMode(kModeSpotlight), mSkin(kSkinSignal), mAccentRgb(0), mHasAccent(false), mSparks(false),
      mOptimisticUntilMs(-1), mOptimisticPlaying(false) {}

void MusicScreen::setLink(bool configured, bool online) {
  mLinkConfigured = configured;
  mLinkOnline = online;
}

void MusicScreen::setTheme(int mode, int skin, uint32_t accentRgb, bool hasAccent, bool sparks) {
  if (mode >= 0 && mode < kModeCount) mMode = mode;
  if (skin >= 0 && skin < kSkinCount) mSkin = skin;
  mAccentRgb = accentRgb;
  mHasAccent = hasAccent;
  mSparks = sparks;
}

void MusicScreen::setNowPlaying(bool present, const std::string& track,
                                const std::string& artist, const std::string& lyric,
                                bool playing, int positionMs, int durationMs,
                                int stampMs, int lyricStartMs, int lyricEndMs,
                                int lyricUntilMs, const LyricCell* cells,
                                int cellCount, bool lyricChorus) {
  // Keyed on the window when there is one, on the text only when there is not.
  // A chorus that repeats a line verbatim leaves `lyric` unchanged, so keying on
  // equality alone would keep animating the previous line's window with progress
  // pinned at 1 — the line would sit there, sung, while the song moved on.
  const bool changed = lyricStartMs >= 0 ? (lyricStartMs != mLyricStartMs) : (lyric != mLyric);
  if (changed) mLyricChangedMs = stampMs;
  mPresent = present;
  mTrack = track;
  mArtist = artist;
  mLyric = lyric;
  mPlaying = playing;
  mPositionMs = positionMs;
  mDurationMs = durationMs;
  mStampMs = stampMs;
  mLyricStartMs = lyricStartMs;
  mLyricEndMs = lyricEndMs;
  mLyricUntilMs = lyricUntilMs;
  mLyricChorus = lyricChorus;
  // Assigned every time, including to nothing. The table belongs to ONE line, so
  // keeping the previous one through a document that carries none would walk the
  // new line's glyphs at the old line's rate — the wrong-character failure, with
  // no way to see it in a screenshot.
  mLyricCells.assign(cells, cellCount);
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

float MusicScreen::lineProgress(int nowMs) const {
  if (mLyricStartMs >= 0 && mLyricEndMs > mLyricStartMs) {
    // LyricsPage::draw's arithmetic, on the playhead this screen extrapolates
    // rather than on the one the last document carried — same shape as the
    // reference's local tick, so the line animates smoothly between documents.
    const int at = playheadMs(nowMs);
    const int span = mLyricEndMs - mLyricStartMs;
    const int into = at > mLyricStartMs ? at - mLyricStartMs : 0;
    return lm_unit((float)into / (float)span);
  }
  // No window on the wire. Sweep the reference's own last-line span from the
  // moment the line changed: wrong in the small (a 2 s line lingers, an 8 s line
  // finishes early) but right in the large, and the alternative is a mode that
  // does not move at all.
  int since = nowMs - mLyricChangedMs;
  if (since < 0) since = 0;
  return lm_unit((float)since / (float)kUntimedLineMs);
}

bool MusicScreen::timedLine(int glyphCount, bool hasLyric) const {
  // Every clause is load-bearing. `hasLyric` because the row is also the
  // title/artist rotation, which has no line window at all; the window because
  // the offsets are relative to it; and the exact cell count because a table one
  // entry out of step against THIS row lights the wrong character for the whole
  // song. Service-side the two are truncated together by construction, so a
  // mismatch here means something went wrong on the wire — fall back, do not
  // trim.
  if (!hasLyric || glyphCount <= 0) return false;
  if (mLyricStartMs < 0 || mLyricEndMs <= mLyricStartMs) return false;
  return mLyricCells.count == glyphCount;
}

LyricCursor MusicScreen::lyricCursor(int nowMs, int glyphCount, bool hasLyric,
                                     float sweepProgress) const {
  if (timedLine(glyphCount, hasLyric)) {
    return lyricCursorAt(mLyricCells.cells, mLyricCells.count, mLyricStartMs,
                         mLyricEndMs, glyphCount, playheadMs(nowMs));
  }
  // No table, or a row that is not a lyric at all — the title/artist rotation
  // supplies its own sweep. Either way the cursor is that scalar re-expressed,
  // index for index, so nothing downstream has to branch.
  return lyricCursorFromProgress(sweepProgress, glyphCount);
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

  // The palette is resolved before the empty-state branch on purpose: the theme
  // is not part of the now-playing block on either firmware, so a paused or
  // unreachable panel keeps the skin the user chose instead of snapping back to
  // signal green the moment the music stops.
  Palette pal = paletteFor(mSkin);
  if (mHasAccent) {
    pal.primary = Color((mAccentRgb >> 16) & 0xff, (mAccentRgb >> 8) & 0xff, mAccentRgb & 0xff);
  }

  // The reference's animation clock is a free-running counter from page
  // construction; here it is the caller's monotonic clock, because a Screen must
  // be a pure function of (state, nowMs) or nothing on the host can assert it.
  // Every animation downstream is periodic in this value, so the two differ in
  // phase and in nothing else.
  //
  // Through uint32_t first, and that cast is the whole of the parity. The
  // reference's counter is `uint32_t mAnimMs`; osLogic's nowMs is a signed int
  // of milliseconds since boot, so at 2^31 ms — 24.86 days of uptime, which a
  // clock reaches — it goes negative. skylineBarLevel clamps a negative timeMs
  // to zero, freezing the spectrum into a still image, and paintIdle's
  // (uint32_t)(animMs / 400.f) is undefined for a negative float and lands on 0
  // on both clang and this device's saturating vcvt, freezing the sparkles too.
  // Wrapping instead of clamping makes the value periodic again, which is what
  // the comment above claims it already is.
  const float animMs = (float)(uint32_t)nowMs;

  if (!mPresent) {
    // Which emptiness this is. The three are genuinely different problems and
    // only one of them is about music, so they must not share a word.
    const char* word;
    if (!mLinkConfigured) {
      word = "\xE6\x9C\xAA\xE9\x85\x8D\xE7\xBD\xAE";  // 未配置 — no console address on this device
    } else if (!mLinkOnline) {
      word = "\xE7\xA6\xBB\xE7\xBA\xBF";              // 离线 — address known, no document has arrived
    } else {
      word = "\xE6\x9C\xAA\xE6\x92\xAD\xE6\x94\xBE";  // 未播放 — the service says nothing is playing
    }
    paintIdle(out, pal, animMs, word, ease::outQuad(ease::progress(nowMs, mEnteredMs, kEntryFadeMs)));
    return;
  }

  const bool playing = (mOptimisticUntilMs >= 0 && nowMs < mOptimisticUntilMs)
                           ? mOptimisticPlaying
                           : mPlaying;

  // A lyric wins the row whenever there is one: it is the only field that
  // changes on its own, and a title the user already read is not worth the row.
  std::string line;
  bool hasLyric = false;
  float prog = 0.f;
  if (!mLyric.empty()) {
    line = mLyric;
    hasLyric = true;
    prog = lineProgress(nowMs);
  } else {
    // No lyrics: alternate title and artist rather than dropping one. On this
    // panel there is exactly one row, so "both at once" is not on the table.
    int since = nowMs - mEnteredMs;
    if (since < 0) since = 0;
    const int phase = (since / kRotateMs) % 2;
    const bool title = (phase == 0) || mArtist.empty();
    line = title ? mTrack : mArtist;
    // With no lyric there is no line window either, and every mode is a function
    // of progress within a line — so the rotation slot becomes the line: the
    // title enters, sweeps and leaves, then the artist does. hasLyric stays
    // false, which is what puts beatKick on its 120 BPM fallback instead of
    // pretending these characters are sung.
    prog = (float)(since % kRotateMs) / (float)kRotateMs;
  }
  // A now-playing document carrying no text at all is a real shape, not a
  // defensive hypothetical: the service resolves a track id to a title through
  // the provider, and when that lookup fails it still publishes the transport so
  // the buttons keep working. The old fallback was "--" — two five-pixel dashes
  // on a 52x16 panel, indistinguishable from a screen that is not drawing, which
  // is exactly the reading that sent this bug to the firmware.
  if (line.empty()) {
    line = playing ? "\xE6\x92\xAD\xE6\x94\xBE\xE4\xB8\xAD"   // 播放中
                   : "\xE5\xB7\xB2\xE6\x9A\x82\xE5\x81\x9C";  // 已暂停
  }

  float track = 0.f;
  if (mDurationMs > 0) track = lm_unit((float)playheadMs(nowMs) / (float)mDurationMs);

  Cell cells[kMaxCells];
  int totalW = 0;
  const int n = layoutRow(line.c_str(), cells, kMaxCells, totalW);

  // Where the singer is. With a per-glyph table this walks the words at the rate
  // they were actually sung; without one it is the scalar every mode has always
  // shared, so `cursor.progress == prog` and nothing below can tell the two
  // apart. That equality is the whole compatibility argument, and the host check
  // asserts it in pixels.
  //
  // NOTE FOR ANYONE COMPARING THE THREE RENDERERS: after this change the browser
  // preview and ZOS walk word-level timings and the SIDELOADED lyrics player
  // (device/tc002-lyrics-player) still sweeps its lines evenly. NONE of the three
  // is broken. That player pulls a different endpoint on a different transport —
  // lyricsLogic.cc asks for /api/music/device/now with no `?v`, and the service
  // answers those bytes verbatim, by design, because its deployed parser treats
  // any key that is not `DUR` as a start time. The `?v=2` encoding carrying `L`
  // and `W` records exists on the service and that firmware does not yet ask for
  // it; the two firmwares are mutually exclusive anyway (ADR 0004), so no user
  // sees both at once. The 主题设置 parity claim in this file's header is about
  // geometry and colour, which are unchanged, not about timing.
  const LyricCursor cursor = lyricCursor(nowMs, n, hasLyric, prog);
  const bool timedCells = timedLine(n, hasLyric);
  // "The service told us these two clocks differ." Both fields only exist from
  // proto 2, so this is also "the service is new enough to have an opinion"; when
  // it is false every branch below collapses to the frame this firmware has
  // always drawn.
  const bool windowed = hasLyric && mLyricStartMs >= 0 && mLyricEndMs > mLyricStartMs;
  const bool split = timedCells || (windowed && mLyricUntilMs > mLyricEndMs);
  float windowProg = cursor.progress;
  if (split && windowed) {
    windowProg = lyricWindowProgress(mLyricStartMs, mLyricEndMs, mLyricUntilMs,
                                     playheadMs(nowMs));
  }

  FrameCtx f;
  f.pal = &pal;
  f.cells = cells;
  f.n = n;
  f.totalW = totalW;
  // The cursor's own progress rather than `prog`: identical without a table, and
  // the non-uniform one with it, which is what makes the scroll and the cue row
  // follow the singer instead of the clock.
  f.prog = cursor.progress;
  f.windowProg = windowProg;
  f.cursor = cursor;
  f.timedCells = timedCells;
  f.split = split;
  f.track = track;
  f.animMs = animMs;
  f.playing = playing;
  f.hasLyric = hasLyric;
  f.chorus = hasLyric && mLyricChorus;
  f.sparks = mSparks;
  f.lineStartMs = windowed ? mLyricStartMs : -1;
  // The browser's sinceLineMs: playhead minus the line's start when the line has
  // a window, everything shown otherwise (a title, or an older service's line).
  f.sinceLineMs = windowed ? (long)playheadMs(nowMs) - (long)mLyricStartMs : 1L << 30;

  // An instrumental long enough to be one gives the row up to the dots, in
  // every mode. Only a service that separates the sung end from the window can
  // say so (`lyricuntil`), so an older one keeps the held line it always had.
  float interlude = -1.f;
  if (windowed && mLyricUntilMs > mLyricEndMs) {
    interlude = lyricrings::lyricInterludeProgress(mLyricEndMs, mLyricUntilMs, playheadMs(nowMs));
  }

  if (interlude >= 0.f) {
    paintInterlude(out, pal, interlude, track, animMs);
  } else {
    paintSparks(out, f, mMode);
    if (mMode == kModeRings) paintRings(out, f);
    else if (mMode == kModeTilt) paintTilt(out, f);
    else if (mMode == kModeSkyline) paintSkyline(out, f);
    else if (mMode == kModeSpotlight) paintSpotlight(out, f);
    else if (mMode == kModeCascade) paintCascade(out, f);
    else paintTicker(out, f);
  }

  if (mFlashMs >= 0) {
    const float p = ease::progress(nowMs, mFlashMs, kFlashMs);
    if (p < 1.0f) {
      // Press feedback, and this firmware's alone: the reference is never
      // touched while it draws. It only ever lights pixels the frame left dark,
      // and it spares the bottom row, where every mode keeps its progress
      // indicator — washing that row would read as a full bar.
      const Color wash = scaled(pal.primary, (int)(0.28f * (1.0f - p) * 255.f));
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
