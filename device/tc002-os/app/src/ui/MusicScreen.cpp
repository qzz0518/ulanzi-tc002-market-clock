#include "ui/MusicScreen.h"

#include <math.h>

#include "core/Ease.h"
#include "core/Text.h"
#include "visual/Glyphs.h"
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
  float track;  // progress through the whole track, 0..1
  float animMs;
  bool playing;
  // "This row is a timed lyric line", and nothing more. It is the beat input —
  // beatKick snaps on each glyph when it is set and falls back to a 120 BPM
  // pulse when it is not. It deliberately does NOT mean "there is a row to
  // draw": on this firmware the row is also the title/artist rotation, or the
  // 播放中 / 已暂停 fallback under it, and those are text too.
  bool hasLyric;
};

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

// ---- per-mode painters -----------------------------------------------------

// 走带: karaoke colouring, in-line cue on row 0, whole-track cue on row 15.
void paintTicker(Surface& s, const FrameCtx& f) {
  const Palette& pal = *f.pal;
  cueRow(s, pal, 0, f.prog, 2);
  cueRow(s, pal, 15, f.track, 1);
  int focus = (int)(f.prog * f.n);
  if (focus >= f.n) focus = f.n - 1;
  int startX = f.totalW <= kViewW ? (kPanelWidth - f.totalW) / 2
                                  : kViewX - scrollOffsetFor(f.totalW, f.prog, MusicScreen::kModeTicker);
  for (int i = 0; i < f.n; ++i) {
    const Color& c = (i < focus) ? pal.secondary : (i == focus ? pal.primary : pal.context);
    blitGlyph(s, f.cells[i], startX + f.cells[i].startX, 2, c, kViewX, kViewW);
  }
}

// 天际: the ONLY mode with a spectrum, and it is a full-width floor on rows
// 13..15 with row 12 as the gutter — never a panel beside the text. That
// distinction is the whole of the reported bug: a 12 px equaliser at x=0 leaves
// 38 of 52 columns for the lyric and covers the rest of it.
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
  float kick = beatKick(f.playing, f.hasLyric, f.prog, f.n, f.animMs);
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
  int focus = (int)(f.prog * f.n);
  if (focus >= f.n) focus = f.n - 1;
  int startX = f.totalW <= kViewW ? (kPanelWidth - f.totalW) / 2
                                  : kViewX - scrollOffsetFor(f.totalW, f.prog, MusicScreen::kModeSkyline);
  for (int i = 0; i < f.n; ++i) {
    const Color& c = (i < focus) ? pal.secondary : (i == focus ? pal.primary : pal.context);
    blitGlyph(s, f.cells[i], startX + f.cells[i].startX, 0, c, kViewX, kViewW);
  }
}

// 聚光: the sung pixel column is locked to x=26 and the line slides under it.
// The asymmetry is deliberate — brackets at 19/32, fill meter spanning 20..31.
void paintSpotlight(Surface& s, const FrameCtx& f) {
  const Palette& pal = *f.pal;
  s.setPixel(19, 1, pal.muted);
  s.setPixel(32, 1, pal.muted);
  cueRow(s, pal, 15, f.track, 1);
  float focusPx = lm_unit(f.prog) * f.totalW;
  int spanStarts[kMaxCells];
  int limit = f.n < kMaxCells ? f.n : kMaxCells;
  for (int i = 0; i < limit; ++i) spanStarts[i] = f.cells[i].startX;
  int focusIndex = spanIndexAtPx(spanStarts, limit, (int)focusPx);
  int offset = spotlightOffsetPx(f.totalW, f.prog);  // screen x of the bitmap's left edge
  for (int i = 0; i < f.n; ++i) {
    int dist = i - focusIndex;
    if (dist < 0) dist = -dist;
    const Color& c = dist == 0 ? pal.primary : (dist == 1 ? pal.secondary : pal.context);
    blitGlyph(s, f.cells[i], offset + f.cells[i].startX, 2, c, 0, kPanelWidth);
  }
  if (focusIndex < 0 || focusIndex >= f.n) return;
  const Cell& span = f.cells[focusIndex];
  float frac = lm_unit((focusPx - span.startX) / (float)(span.width > 0 ? span.width : 1));
  int barW = (int)lroundf(frac * 12.f);
  for (int i = 0; i < barW; ++i) s.setPixel(20 + i, 14, pal.secondary);
}

// 升降: the whole line rises in, holds, and lifts out the top; the track bar is
// the right edge column, which is outside the [2,50) text window by design.
void paintCascade(Surface& s, const FrameCtx& f) {
  const Palette& pal = *f.pal;
  int fill = (int)lroundf(lm_unit(f.track) * 16.f);
  for (int step = 0; step < fill; ++step) {
    const Color& c = (step == fill - 1) ? pal.primary : pal.muted;
    s.setPixel(51, 15 - step, c);
  }
  int phase = cascadePhase(f.prog, false);
  int bandY = cascadeBandY(f.prog, false);
  int focus = (int)(f.prog * f.n);
  if (focus >= f.n) focus = f.n - 1;
  int startX = f.totalW <= kViewW ? (kPanelWidth - f.totalW) / 2
                                  : kViewX - scrollOffsetFor(f.totalW, f.prog, MusicScreen::kModeCascade);
  for (int i = 0; i < f.n; ++i) {
    Color c;
    if (phase == CASCADE_ENTER) c = pal.secondary;
    else if (phase == CASCADE_EXIT) c = pal.context;
    else c = (i < focus) ? pal.secondary : (i == focus ? pal.primary : pal.context);
    blitGlyph(s, f.cells[i], startX + f.cells[i].startX, bandY, c, kViewX, kViewW);
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
      mEnteredMs(0), mLyricChangedMs(0), mFlashMs(-1), mAction(kNone),
      mMode(kModeSpotlight), mSkin(kSkinSignal), mAccentRgb(0), mHasAccent(false),
      mOptimisticUntilMs(-1), mOptimisticPlaying(false) {}

void MusicScreen::setLink(bool configured, bool online) {
  mLinkConfigured = configured;
  mLinkOnline = online;
}

void MusicScreen::setTheme(int mode, int skin, uint32_t accentRgb, bool hasAccent) {
  if (mode >= 0 && mode < kModeCount) mMode = mode;
  if (skin >= 0 && skin < kSkinCount) mSkin = skin;
  mAccentRgb = accentRgb;
  mHasAccent = hasAccent;
}

void MusicScreen::setNowPlaying(bool present, const std::string& track,
                                const std::string& artist, const std::string& lyric,
                                bool playing, int positionMs, int durationMs,
                                int stampMs, int lyricStartMs, int lyricEndMs) {
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

  FrameCtx f;
  f.pal = &pal;
  f.cells = cells;
  f.n = n;
  f.totalW = totalW;
  f.prog = prog;
  f.track = track;
  f.animMs = animMs;
  f.playing = playing;
  f.hasLyric = hasLyric;

  if (mMode == kModeSkyline) paintSkyline(out, f);
  else if (mMode == kModeSpotlight) paintSpotlight(out, f);
  else if (mMode == kModeCascade) paintCascade(out, f);
  else paintTicker(out, f);

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
