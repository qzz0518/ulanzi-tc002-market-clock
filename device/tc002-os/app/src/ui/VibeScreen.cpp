#include "ui/VibeScreen.h"

#include <stdio.h>

#include "core/Ease.h"
#include "core/Text.h"
#include "visual/VibeIcons.h"

namespace tcos {

namespace {

// The palette, written out rather than derived: these exact values are what the
// console's VIBE page and the LED channel version shipped with, and the whole
// claim of this screen is that the panel says the same thing the browser does.
// White until 80% of a quota is gone, amber to 90%, red past it — OpenUsage's
// two absolute steps, which is also what the console draws.
const Color kValueNormal(255, 255, 255);
const Color kValueWarn(255, 204, 0);
const Color kValueDanger(255, 69, 58);
const Color kLabelSoft(130, 140, 155);
const Color kMeterTrack(40, 44, 52);
const Color kMeterFill(10, 132, 255);
const Color kEmptyWord(120, 120, 120);
const Color kRailLit(170, 130, 255);  // the launcher card's accent, so the ring reads as this room
const Color kRailDim(28, 20, 46);

// Geometry, from docs/design/vibe-usage.md §3. The overview packs 10 px marks so
// two agents plus their numbers fit across 52 px; a detail page shows one agent
// and can afford the full-height mark.
const int kMarkSmall = 10;
const int kMarkLarge = 12;
const int kMarkColor = 16;   // the 16x16 brand art, drawn 1:1 — the panel IS 16 rows
const int kMarkSmallY = 3;   // (16 - 10) / 2
const int kMarkLargeY = 2;   // (16 - 12) / 2
const int kMarkColorY = 0;   // (16 - 16) / 2 — no scaling, no crop, no offset
const int kMarkFallbackX = (kMarkColor - kMarkLarge) / 2;  // the 12 px stand-in, centred in the same column
const int kRowTopY = 2;      // the two-row layout: rows 2..6 and 9..13
const int kRowBottomY = 9;
const int kRowSoloY = 5;     // one row, centred: 5..9
const int kGlyphH = 5;
const int kGlyphAdvance = 4;  // 3 px cell + 1 px gap

// The detail row starts one column past the 16 px mark. That leaves 35 px for
// the row (x=17..51) rather than the 37 px a 12 px mark left, and the whole row
// — label, meter, value — shifts by the same 2 px so the spacing inside it is
// unchanged. The budget is exact: label 17..19, meter 21..34, and a worst-case
// "999%" is 15 px right-aligned to 51, so it starts at 37.
const int kDetailRowX = 17;   // x=16 is the gutter that keeps the mark separate
const int kDetailRightX = 51;
const int kMeterX = 21;
const int kMeterW = 14;
const int kMarkGap = 2;       // between an overview mark and its value column

const int kRailY = kPanelHeight - 1;
const int kPressFlashMs = 160;

void plot(Surface& out, int x, int y, const Color& c) {
  if (x < 0 || y < 0 || x >= out.getWidth() || y >= out.getHeight()) return;
  out.setPixel(x, y, c);
}

// The cell is shared in TIME, so both halves need a floor a person can read and
// a ceiling short enough that the other half still comes round. Clamped here as
// well as on the wire, for the reason StateDoc states: neither end should depend
// on the other behaving.
int clampDwell(int ms) {
  if (ms < StateDoc::kMinVibeDwellMs) return StateDoc::kMinVibeDwellMs;
  if (ms > StateDoc::kMaxVibeDwellMs) return StateDoc::kMaxVibeDwellMs;
  return ms;
}

Color dim(const Color& c, float k) {
  if (k <= 0.0f) return Color(0, 0, 0);
  if (k > 1.0f) k = 1.0f;
  return Color(static_cast<unsigned char>(c.r * k),
               static_cast<unsigned char>(c.g * k),
               static_cast<unsigned char>(c.b * k));
}

// ---- the 3x5 numerals ------------------------------------------------------
//
// visual/Glyphs.h has exactly one cell height, 12 px, which is the whole panel
// minus four rows — so it can draw ONE row of text and this screen needs two.
// The bits below are src/pixel-font.ts's PIXEL_FONT_3X5 transcribed, which is
// the table the console's own VIBE preview rasters, so a number reads the same
// in both places. The arcade firmware's PixelFont.h is a different 3x5 face and
// has no '%', which is the character this screen exists to draw.
//
// Rows are 3-bit masks, bit2 = leftmost. Only the characters a quota row can
// contain are here: digits, the two units, a minus, and A..Z because a metric's
// label is the vendor's own word and its initial is whatever they chose.
struct TinyGlyph {
  char ch;
  unsigned char rows[5];
};

const TinyGlyph kTinyFont[] = {
    {' ', {0, 0, 0, 0, 0}},
    {'0', {7, 5, 5, 5, 7}}, {'1', {2, 6, 2, 2, 7}}, {'2', {7, 1, 7, 4, 7}},
    {'3', {7, 1, 7, 1, 7}}, {'4', {5, 5, 7, 1, 1}}, {'5', {7, 4, 7, 1, 7}},
    {'6', {7, 4, 7, 5, 7}}, {'7', {7, 1, 2, 2, 2}}, {'8', {7, 5, 7, 5, 7}},
    {'9', {7, 5, 7, 1, 7}},
    {'%', {5, 1, 2, 4, 5}}, {'-', {0, 0, 7, 0, 0}},
    {'A', {7, 5, 7, 5, 5}}, {'B', {6, 5, 6, 5, 6}}, {'C', {7, 4, 4, 4, 7}},
    {'D', {6, 5, 5, 5, 6}}, {'E', {7, 4, 7, 4, 7}}, {'F', {7, 4, 7, 4, 4}},
    {'G', {7, 4, 5, 5, 7}}, {'H', {5, 5, 7, 5, 5}}, {'I', {7, 2, 2, 2, 7}},
    {'J', {1, 1, 1, 5, 7}}, {'K', {5, 6, 4, 6, 5}}, {'L', {4, 4, 4, 4, 7}},
    {'M', {5, 7, 5, 5, 5}}, {'N', {6, 5, 5, 5, 5}}, {'O', {7, 5, 5, 5, 7}},
    {'P', {7, 5, 7, 4, 4}}, {'Q', {7, 5, 5, 7, 1}}, {'R', {7, 5, 7, 6, 5}},
    {'S', {7, 4, 7, 1, 7}}, {'T', {7, 2, 2, 2, 2}}, {'U', {5, 5, 5, 5, 7}},
    {'V', {5, 5, 5, 5, 2}}, {'W', {5, 5, 5, 7, 5}}, {'X', {5, 5, 2, 5, 5}},
    {'Y', {5, 5, 2, 2, 2}}, {'Z', {7, 1, 2, 4, 7}},
};
const int kTinyCount = sizeof(kTinyFont) / sizeof(kTinyFont[0]);

const TinyGlyph* tinyGlyph(char c) {
  if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  for (int i = 0; i < kTinyCount; ++i) {
    if (kTinyFont[i].ch == c) return &kTinyFont[i];
  }
  return 0;
}

int tinyWidth(const char* text) {
  int n = 0;
  for (const char* p = text; *p; ++p) ++n;
  return n == 0 ? 0 : n * kGlyphAdvance - 1;
}

// An unmapped character leaves a gap and still advances, the same rule
// core/Text.h's draw() follows: a missing glyph must not shift the rest of the
// number one cell left and turn 100 into 10.
void drawTiny(Surface& out, const char* text, int x, int y, const Color& c) {
  for (const char* p = text; *p; ++p) {
    const TinyGlyph* g = tinyGlyph(*p);
    if (g != 0) {
      for (int row = 0; row < kGlyphH; ++row) {
        for (int col = 0; col < 3; ++col) {
          if ((g->rows[row] & (1 << (2 - col))) == 0) continue;
          plot(out, x + col, y + row, c);
        }
      }
    }
    x += kGlyphAdvance;
  }
}

// ---- the numbers themselves ------------------------------------------------

// How much of this quota is gone, in percent, or -1 when the vendor named no
// ceiling. -1 is a state and not a failure: a credit balance has no percentage,
// and inventing one by dividing by zero-as-100 would be the panel making up a
// number the vendor never quoted.
int utilPercent(const StateDoc::VibeMetric& metric) {
  if (metric.limit <= 0) return -1;
  long value = ((long)metric.used * 100 + metric.limit / 2) / metric.limit;
  if (value < 0) value = 0;
  if (value > 999) value = 999;
  return (int)value;
}

// Severity is always read off what has been SPENT, including while the numbers
// read 剩余: "you have 8% left" and "you have burnt 92%" are one fact, and it
// must not change colour because the user pressed the knob.
const Color& severityFor(int percent) {
  if (percent >= 90) return kValueDanger;
  if (percent >= 80) return kValueWarn;
  return kValueNormal;
}

const Color& meterFillFor(int percent) {
  if (percent >= 90) return kValueDanger;
  if (percent >= 80) return kValueWarn;
  return kMeterFill;
}

// `withPercent` is the overflow ladder's second step — see renderOverview. The
// sign is what goes, never a digit.
void formatValue(char* out, int size, const StateDoc::VibeMetric& metric, bool showLeft,
                 bool withPercent) {
  const int percent = utilPercent(metric);
  if (percent < 0) {
    // A bare balance. 剩余 is what a balance already IS, so the toggle has
    // nothing to invert here and the number is the same either way.
    snprintf(out, size, "%d", metric.used);
    return;
  }
  int shown = percent;
  if (showLeft) {
    shown = 100 - percent;  // not (limit-used)/limit: the two must sum to 100
    if (shown < 0) shown = 0;
  }
  snprintf(out, size, withPercent ? "%d%%" : "%d", shown);
}

// Relative seconds to the coarsest unit that still fits three cells. The vendor
// said "in six days", not "at 03:00 on Thursday", and this device's wall clock
// may never have been synced — see StateDoc::VibeMetric::resetSec.
void formatReset(char* out, int size, int resetSec) {
  if (resetSec >= 86400) {
    int days = resetSec / 86400;
    if (days > 999) days = 999;
    snprintf(out, size, "%dD", days);
  } else if (resetSec >= 3600) {
    snprintf(out, size, "%dH", resetSec / 3600);
  } else if (resetSec >= 60) {
    snprintf(out, size, "%dM", resetSec / 60);
  } else {
    snprintf(out, size, "%dS", resetSec < 0 ? 0 : resetSec);
  }
}

// ---- marks and meters ------------------------------------------------------

// The generated grids from visual/VibeIcons.h, which scripts/gen-vibe-icons.ts
// emits from the same source the console renders — test/vibe-icons-parity.test.ts
// holds the two sides bit for bit, so "what the LED shows is what the panel
// shows" is a checked fact rather than a coincidence.
void drawMark(Surface& out, const std::string& id, int x, int y, int size, const Color& c) {
  const vibeicons::Mark* mark = vibeicons::find(id.c_str());
  // An agent this firmware has never heard of still gets a mark: the neutral
  // gauge. Drawing nothing would leave a page of numbers with no owner, which
  // is worse than a generic badge on a vendor added after this build shipped.
  if (mark == 0) mark = vibeicons::find("gauge");
  if (mark == 0) return;
  const uint16_t* rows = (size == kMarkSmall) ? mark->s10 : mark->s12;
  for (int row = 0; row < size; ++row) {
    const uint16_t bits = rows[row];
    if (bits == 0) continue;
    for (int col = 0; col < size; ++col) {
      if ((bits & (1 << (size - 1 - col))) == 0) continue;
      plot(out, x + col, y + row, c);
    }
  }
}

// The 16x16 brand art, at the panel's native resolution: one grid pixel is one
// LED, so nothing is scaled and nothing is resampled (16 -> 10 is not an integer
// factor, which is why the overview above keeps its own hand-drawn 10 px grids
// instead of shrinking these).
//
// This one takes NO colour. These marks carry sampled brand colours of their
// own, and repainting them in the page's severity accent would be the same
// mistake as tinting a photograph: the red would stop meaning "92% spent" and
// start meaning "this vendor's logo is red". Index 0 is transparent and is not
// plotted at all, so whatever the page drew behind the mark shows through.
//
// Returns false when this build has no colour art for the vendor, which is the
// caller's cue to fall back rather than leave the page ownerless.
bool drawColorMark(Surface& out, const std::string& id, int x, int y) {
  const vibeicons::ColorMark* mark = vibeicons::findColor(id.c_str());
  if (mark == 0) return false;
  for (int row = 0; row < vibeicons::kColorMarkSize; ++row) {
    const uint32_t bits = mark->rows[row];
    if (bits == 0) continue;
    for (int col = 0; col < vibeicons::kColorMarkSize; ++col) {
      const int shift = vibeicons::kColorMarkBpp * (vibeicons::kColorMarkSize - 1 - col);
      const int index = static_cast<int>((bits >> shift) & 0x3u);
      if (index == 0) continue;
      const uint8_t* rgb = mark->palette[index - 1];
      plot(out, x + col, y + row, Color(rgb[0], rgb[1], rgb[2]));
    }
  }
  return true;
}

/**
 * The brand colour a vendor's own mark is drawn in, for the sizes that carry no
 * colour of their own.
 *
 * The 16x16 art on the detail page paints itself. The 10x10 overview mark is one
 * bit per pixel, so it needs a colour handed to it — and that colour should be
 * the SAME ONE the detail page shows, or the same vendor arrives in two liveries
 * one knob-click apart. Index 0 of the mark's palette is its dominant ink; for a
 * two-tone mark that is the lighter half, which is what reads at 10 px.
 *
 * Falls back to `fallback` for an agent with no 16x16 art — a vendor added after
 * this build shipped has no brand ink here to borrow.
 */
Color brandColorFor(const std::string& id, const Color& fallback) {
  const vibeicons::ColorMark* mark = vibeicons::findColor(id.c_str());
  if (mark == 0) return fallback;
  return Color(mark->palette[0][0], mark->palette[0][1], mark->palette[0][2]);
}

// The agent's worst metric decides how its VALUE is lit, so a glance across the
// overview finds the vendor that is about to run out before any number is read.
// It no longer decides the mark: identity and urgency are two facts, and giving
// them one channel meant Claude was orange on one page and grey on the next.
const Color& markColorFor(const StateDoc::VibeAgent& agent) {
  int worst = -1;
  for (size_t i = 0; i < agent.metrics.size(); ++i) {
    const int percent = utilPercent(agent.metrics[i]);
    if (percent > worst) worst = percent;
  }
  if (worst >= 90) return kValueDanger;
  if (worst >= 80) return kValueWarn;
  return kLabelSoft;
}

void drawMeter(Surface& out, int x, int y, int percent) {
  for (int i = 0; i < kMeterW; ++i) {
    for (int row = 0; row < kGlyphH; ++row) plot(out, x + i, y + row, kMeterTrack);
  }
  int filled = (percent * kMeterW + 50) / 100;
  if (filled > kMeterW) filled = kMeterW;
  // A quota that has been touched at all shows one lit column. Rounding 1% to
  // an empty bar reads as "nothing used yet", which is a different claim.
  if (filled < 1 && percent > 0) filled = 1;
  if (filled < 0) filled = 0;
  const Color& fill = meterFillFor(percent);
  for (int i = 0; i < filled; ++i) {
    for (int row = 0; row < kGlyphH; ++row) plot(out, x + i, y + row, fill);
  }
}

// The initial of the vendor's own row label — Session, Weekly, Credits. One
// character is all the row has: the meter owns x=19..32 and a three-digit value
// owns x=37..51. A non-ASCII label draws nothing rather than a wrong glyph.
char metricInitial(const std::string& label) {
  if (label.empty()) return ' ';
  const char c = label[0];
  if (c >= 'a' && c <= 'z') return static_cast<char>(c - 'a' + 'A');
  if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
  return ' ';
}

// True while the value column is showing the reset countdown rather than the
// number. Phase-anchored to the page change by the caller, so walking onto a
// page always starts on the number.
bool showingReset(const StateDoc::VibeMetric& metric, int phaseMs, int valueMs,
                  int resetMs) {
  if (metric.resetSec < 0) return false;
  // A zero countdown share is the user saying "just the number" — the cell then
  // never leaves the value, which is what the arithmetic below already does.
  if (resetMs <= 0) return false;
  const int cycle = valueMs + resetMs;
  int at = phaseMs % cycle;
  if (at < 0) at += cycle;
  return at >= valueMs;
}

}  // namespace

VibeScreen::VibeScreen()
    // Defaults to REMAINING, not spent. "93%" on a quota screen is ambiguous
    // until you know which way it counts, and the number a person acts on is
    // how much they have left — nobody rations against a number that grows.
    // The knob still toggles it, and the choice is remembered in prefs.
    : mLinkConfigured(true), mLinkOnline(true), mShowLeft(true),
      mShowLeftChanged(false), mPageMs(0), mAutoAdvanceMs(0), mAutoAtMs(0),
      mValueDwellMs(kValueDwellMs), mResetDwellMs(kResetDwellMs),
      mPressFlashMs(-1) {}

void VibeScreen::setAgents(const std::vector<StateDoc::VibeAgent>& agents, int nowMs) {
  const int before = pageCount();
  mAgents = agents;
  const int after = pageCount();
  if (after == before) return;  // an in-flight slide is not interrupted for new numbers
  mRing.setCount(after);
  // The shape changed — an agent signed in or out — so the page the user was on
  // no longer names the same thing. Only then is a rewind honest.
  mRing.setIndex(0, nowMs);
  mPageMs = nowMs;
  mAutoAtMs = nowMs;
}

void VibeScreen::setLink(bool configured, bool online) {
  mLinkConfigured = configured;
  mLinkOnline = online;
}

void VibeScreen::setShowLeft(bool showLeft) {
  mShowLeft = showLeft;
}

bool VibeScreen::takeShowLeftChanged() {
  const bool changed = mShowLeftChanged;
  mShowLeftChanged = false;
  return changed;
}

void VibeScreen::setAutoAdvanceMs(int ms, int nowMs) {
  if (ms < 0) ms = 0;
  if (ms == mAutoAdvanceMs) return;  // fed every tick; only a CHANGE re-arms
  mAutoAdvanceMs = ms;
  mAutoAtMs = nowMs;
}

void VibeScreen::setCellDwell(int valueMs, int resetMs) {
  // A value the service did not send (-1) keeps the shipped default rather than
  // collapsing the cell: this arrives on every document, and a build that
  // predates the key must not silently stop showing one half of the row.
  mValueDwellMs = valueMs > 0 ? clampDwell(valueMs) : kValueDwellMs;
  if (resetMs < 0) {
    mResetDwellMs = kResetDwellMs;
  } else {
    mResetDwellMs = resetMs == 0 ? 0 : clampDwell(resetMs);
  }
}

void VibeScreen::advanceIfDue(int nowMs) {
  if (mAutoAdvanceMs <= 0) return;
  if (pageCount() < 2) return;  // signed into nothing: one page, nothing to turn
  const int elapsed = nowMs - mAutoAtMs;
  if (elapsed < mAutoAdvanceMs) return;
  // Far past due means nobody was watching this clock run: 夜间息屏 stops calling
  // render() for the whole night (logic/osLogic.cc), and the Shell rasters the
  // screen being LEFT one last time on the way out. Both would otherwise land a
  // page turn on the first frame the panel comes back, which reads as the clock
  // losing the user's place while they were away. Re-arm instead of turning.
  if (elapsed > 2 * mAutoAdvanceMs) {
    mAutoAtMs = nowMs;
    return;
  }
  // One page per frame, and mRing.turn() directly rather than onInput(): this is
  // not a press, so it must not click (logic/osLogic.cc plays Sfx::kTick on the
  // knob) and must not toggle anything.
  mRing.turn(1, nowMs);
  mPageMs = nowMs;
  mAutoAtMs = nowMs;
}

int VibeScreen::pageCount() const {
  if (mAgents.empty()) return 1;  // the empty state is still a page
  return 1 + static_cast<int>(mAgents.size());
}

void VibeScreen::onEnter(int nowMs) {
  mPageMs = nowMs;
  mAutoAtMs = nowMs;
  mPressFlashMs = -1;
  // NOT reset to page 0: coming back to the agent you were reading is the whole
  // point of a ring, and a hold to check the time should not cost your place.
}

bool VibeScreen::onInput(Input input, int nowMs) {
  // Nothing to page through and nothing to toggle. Returning false leaves the
  // hold — and every other key — to the Shell, so an empty page is never a trap.
  if (mAgents.empty()) return false;
  switch (input) {
    case kInputTurnCw:
      mRing.turn(1, nowMs);
      mPageMs = nowMs;
      mAutoAtMs = nowMs;
      return true;
    case kInputTurnCcw:
      mRing.turn(-1, nowMs);
      mPageMs = nowMs;
      mAutoAtMs = nowMs;
      return true;
    case kInputPress:
      mShowLeft = !mShowLeft;
      mShowLeftChanged = true;
      mPressFlashMs = nowMs;
      // A hand is on the knob, so the dwell starts over — but mPageMs is left
      // alone, or the countdown the user was reading would jump back to the
      // number under their thumb.
      mAutoAtMs = nowMs;
      return true;
    default:
      // A hold is not ours: the Shell turns it into "up one level", which is how
      // the user leaves. Consuming it here would strand them on this page.
      return false;
  }
}

bool VibeScreen::isAnimating(int nowMs) const {
  if (mRing.isAnimating(nowMs)) return true;
  if (mPressFlashMs >= 0 && (nowMs - mPressFlashMs) < kPressFlashMs) return true;
  // The value column alternates with the reset countdown, so this page is never
  // actually still.
  return true;
}

void VibeScreen::renderRail(Surface& out) const {
  const int n = mRing.count();
  if (n <= 1) return;
  // Lifted from LauncherScreen::renderRail, including the degradation above 26
  // entries: eight pages on a screen that shows one at a time is exactly where
  // a user asks "how many more are there".
  if (n <= kPanelWidth / 2) {
    const int span = n * 2 - 1;
    const int x0 = (kPanelWidth - span) / 2;
    for (int i = 0; i < n; ++i) {
      plot(out, x0 + i * 2, kRailY, (i == mRing.index()) ? kRailLit : kRailDim);
    }
    return;
  }
  const int cursor = (mRing.index() * (kPanelWidth - 1)) / (n - 1);
  for (int x = 0; x < kPanelWidth; ++x) plot(out, x, kRailY, kRailDim);
  plot(out, cursor, kRailY, kRailLit);
}

void VibeScreen::renderOverview(Surface& out, int originX, int nowMs) const {
  // The first two agents that have numbers. A cell with nothing to say
  // disappears whole, mark included, and the survivor centres — showing a mark
  // above an em dash would claim the vendor reported "no quota", which is a
  // different statement from "we could not read it".
  const StateDoc::VibeAgent* cells[2] = {0, 0};
  int count = 0;
  for (size_t i = 0; i < mAgents.size() && count < 2; ++i) {
    if (mAgents[i].metrics.empty()) continue;
    cells[count++] = &mAgents[i];
  }
  if (count == 0) {
    text::drawCentered(out, "\xE6\x97\xA0\xE6\x95\xB0\xE6\x8D\xAE",  // 无数据
                       kRowTopY, kLabelSoft, 0, kPanelWidth);
    return;
  }

  // The overflow ladder from docs/design/vibe-usage.md §3.1, in the order it
  // specifies: close the gap first, then drop the percent sign. It stops there
  // because the service clamps a value to three digits — worst case is two
  // cells of "100%", 27 px each, which the two steps bring to 49 px. Dropping a
  // metric ROW, the ladder's third step, is unreachable and therefore not here.
  char values[2][2][8];
  int rows[2] = {0, 0};
  int cellW[2] = {0, 0};
  int gap = 5;
  bool withPercent = true;
  int total = 0;
  for (int attempt = 0; attempt < 3; ++attempt) {
    if (attempt == 1) gap = 3;
    if (attempt == 2) withPercent = false;
    total = (count == 2) ? gap : 0;
    for (int i = 0; i < count; ++i) {
      rows[i] = static_cast<int>(cells[i]->metrics.size());
      if (rows[i] > 2) rows[i] = 2;
      int widest = 0;
      for (int r = 0; r < rows[i]; ++r) {
        formatValue(values[i][r], sizeof(values[i][r]), cells[i]->metrics[r], mShowLeft,
                    withPercent);
        const int w = tinyWidth(values[i][r]);
        if (w > widest) widest = w;
      }
      cellW[i] = kMarkSmall + kMarkGap + widest;
      total += cellW[i];
    }
    if (total <= kPanelWidth) break;
  }

  int x = originX + (kPanelWidth - total) / 2;
  const int phaseMs = nowMs - mPageMs;
  for (int i = 0; i < count; ++i) {
    drawMark(out, cells[i]->id, x, kMarkSmallY, kMarkSmall,
             brandColorFor(cells[i]->id, markColorFor(*cells[i])));
    const int right = x + cellW[i] - 1;
    for (int r = 0; r < rows[i]; ++r) {
      const StateDoc::VibeMetric& metric = cells[i]->metrics[r];
      const int y = (rows[i] == 1) ? kRowSoloY : (r == 0 ? kRowTopY : kRowBottomY);
      char reset[8];
      const bool asReset = showingReset(metric, phaseMs, mValueDwellMs, mResetDwellMs);
      if (asReset) formatReset(reset, sizeof(reset), metric.resetSec);
      const char* text = asReset ? reset : values[i][r];
      const Color& colour = asReset ? kLabelSoft : severityFor(utilPercent(metric));
      drawTiny(out, text, right - tinyWidth(text) + 1, y, colour);
    }
    x += cellW[i] + gap;
  }

  // One amber pixel in the corner when any number on this page is being held up
  // from a refresh the vendor refused. Same convention as the LED channel
  // version, and the same reason: the number is still the best one there is, so
  // it is marked rather than hidden.
  for (int i = 0; i < count; ++i) {
    if (!cells[i]->stale) continue;
    plot(out, originX + kPanelWidth - 1, 0, kValueWarn);
    break;
  }
}

void VibeScreen::renderAgent(Surface& out, const StateDoc::VibeAgent& agent, int originX,
                             int nowMs) const {
  // A vendor added after this build shipped has no 16x16 art, and neither does
  // the neutral `gauge`. It keeps the monochrome 12 px mark lit by severity —
  // centred in the same 16 px column so the row still starts where the eye
  // expects — because a page of numbers with no owner is worse than a badge
  // that is merely older.
  if (!drawColorMark(out, agent.id, originX, kMarkColorY)) {
    drawMark(out, agent.id, originX + kMarkFallbackX, kMarkLargeY, kMarkLarge, markColorFor(agent));
  }
  if (agent.stale) plot(out, originX + kPanelWidth - 1, 0, kValueWarn);

  if (agent.metrics.empty()) {
    // The vendor is signed in and reported nothing this build can draw. The plan
    // string is deliberately not put here instead: it is Latin at 6 px and would
    // marquee inside a 35 px window, and "Max 20x" scrolling past is not an
    // answer to "how much is left".
    int clipX = originX + kDetailRowX;
    int clipW = kPanelWidth - kDetailRowX;
    if (clipX < 0) {
      clipW += clipX;
      clipX = 0;
    }
    if (clipX + clipW > kPanelWidth) clipW = kPanelWidth - clipX;
    if (clipW > 0) {
      text::draw(out, "\xE6\x97\xA0\xE6\x95\xB0\xE6\x8D\xAE",  // 无数据
                 originX + kDetailRowX, kRowTopY, kLabelSoft, clipX, clipW);
    }
    return;
  }

  const int phaseMs = nowMs - mPageMs;
  const int count = static_cast<int>(agent.metrics.size());
  for (int r = 0; r < count && r < 2; ++r) {
    const StateDoc::VibeMetric& metric = agent.metrics[r];
    const int y = (count == 1) ? kRowSoloY : (r == 0 ? kRowTopY : kRowBottomY);
    const int percent = utilPercent(metric);

    const char initial[2] = {metricInitial(metric.label), 0};
    drawTiny(out, initial, originX + kDetailRowX, y, kLabelSoft);

    // No ceiling, no meter: a bar needs a full to be a fraction of, and drawing
    // one against an invented 100 would turn a credit balance into a percentage
    // nobody quoted.
    if (percent >= 0) drawMeter(out, originX + kMeterX, y, percent);

    char text[8];
    const bool asReset = showingReset(metric, phaseMs, mValueDwellMs, mResetDwellMs);
    if (asReset) {
      formatReset(text, sizeof(text), metric.resetSec);
    } else {
      formatValue(text, sizeof(text), metric, mShowLeft, true);
    }
    const Color& colour = asReset ? kLabelSoft : severityFor(percent);
    drawTiny(out, text, originX + kDetailRightX - tinyWidth(text) + 1, y, colour);
  }
}

void VibeScreen::renderPage(Surface& out, int index, int originX, int nowMs) const {
  if (index == 0) {
    renderOverview(out, originX, nowMs);
    return;
  }
  const size_t agent = static_cast<size_t>(index - 1);
  if (agent >= mAgents.size()) return;
  renderAgent(out, mAgents[agent], originX, nowMs);
}

void VibeScreen::render(Surface& out, int nowMs) {
  out.clear(Color(0, 0, 0));
  // Before anything is measured, the way ProvisionScreen does it: the ring's
  // index is what the rest of this function reads, so turning it afterwards
  // would draw one frame of the page the user has already left.
  advanceIfDue(nowMs);

  if (mAgents.empty()) {
    // Which emptiness this is. Two of the three are not about VIBE at all, and
    // sending a user to hunt for a login they already have is exactly what one
    // shared word would do.
    const char* word;
    if (!mLinkConfigured) {
      word = "\xE6\x9C\xAA\xE9\x85\x8D\xE7\xBD\xAE";      // 未配置 — no console address here
    } else if (!mLinkOnline) {
      word = "\xE7\xA6\xBB\xE7\xBA\xBF";                  // 离线 — address known, nothing arrived
    } else {
      word = "\xE6\x9C\xAA\xE7\x99\xBB\xE5\xBD\x95";      // 未登录 — no agent is signed in on the host
    }
    text::drawCentered(out, word, kRowTopY, kEmptyWord, 0, kPanelWidth);
    return;
  }

  // Two pages are on the panel during a slide and one when settled; the rest are
  // skipped by the off-panel test, exactly as the launcher does it.
  const float offset = mRing.visualOffset(nowMs);
  const int base = mRing.index();
  for (int step = -1; step <= 1; ++step) {
    const float slot = static_cast<float>(step) + offset;
    const int originX = static_cast<int>(slot * kPanelWidth + (slot < 0 ? -0.5f : 0.5f));
    if (originX <= -kPanelWidth || originX >= kPanelWidth) continue;
    renderPage(out, mRing.wrap(base + step), originX, nowMs);
  }

  renderRail(out);

  // Confirm flash on the 已用/剩余 toggle. A metric with no ceiling shows the
  // same number either way, so without this the press would look dropped on
  // exactly the pages where nothing else moves.
  if (mPressFlashMs >= 0) {
    const float p = ease::progress(nowMs, mPressFlashMs, kPressFlashMs);
    if (p < 1.0f) {
      const Color wash = dim(kRailLit, 0.30f * (1.0f - p));
      for (int y = 0; y < kPanelHeight; ++y) {
        for (int x = 0; x < kPanelWidth; ++x) {
          const Color c = out.getPixel(x, y);
          if (c.r || c.g || c.b) continue;
          out.setPixel(x, y, wash);
        }
      }
    }
  }
}

}  // namespace tcos
