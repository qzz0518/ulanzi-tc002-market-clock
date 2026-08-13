#ifndef CORE_TEXT_H_
#define CORE_TEXT_H_

#include <stdint.h>

#include "core/Surface.h"

namespace tcos {
namespace text {

// Decodes one UTF-8 scalar and advances `p`. Malformed bytes yield U+FFFD and
// consume one byte, so a truncated channel name from the host can never spin
// the layout loop forever.
uint32_t utf8Next(const char*& p);

// Number of codepoints, not bytes.
int countCells(const char* utf8);

// Total advance width in pixels: 6 per ASCII cell, 12 per anything else.
int measure(const char* utf8);

// Widest prefix of `utf8` that fits in `maxPx`, in bytes. Never splits a
// multi-byte sequence.
int prefixBytesThatFit(const char* utf8, int maxPx);

/**
 * Draws `utf8` with its left edge at `x`, top edge at `y`, clipped to the
 * horizontal window [clipX, clipX + clipW) and to the surface vertically.
 *
 * `x` may be negative — that is how scrolling works: the caller moves the origin
 * and the clip window stays put. A codepoint with no glyph in either table is
 * skipped but still advances, so a missing character leaves a gap instead of
 * shifting everything after it.
 */
void draw(Surface& out, const char* utf8, int x, int y, const Color& color,
          int clipX, int clipW);

// Convenience: draw centred inside [clipX, clipX + clipW).
void drawCentered(Surface& out, const char* utf8, int y, const Color& color,
                  int clipX, int clipW);

/**
 * Ping-pong marquee offset for a label too wide for its viewport.
 *
 * Returns a value in [-(widthPx - viewW), 0] to be used as the draw origin.
 * Zero when the label already fits, so callers need no special case. The cycle
 * is: dwell at the left, scroll right, dwell at the right, scroll back. Ellipsis
 * is deliberately not offered — truncating a Chinese label usually destroys the
 * word, and these labels are user-chosen channel names.
 */
int marqueeOffset(int widthPx, int viewW, int elapsedMs);

/**
 * How long one full ping-pong takes, in ms; zero when the label already fits.
 *
 * Exists because any carousel that advances on a fixed period is unreadable the
 * moment one of its pages marquees: the page changes halfway through the scroll
 * and the user never sees the tail. A caller that auto-advances must dwell for
 * at least this long — see ui/ProvisionScreen::dwellMsFor, which is where that
 * rule is written down and asserted.
 */
int marqueeCycleMs(int widthPx, int viewW);

// Marquee tuning, exposed so the host self-check asserts the real values.
static const int kMarqueeDwellMs = 900;
static const int kMarqueePxPerSecond = 14;

}  // namespace text
}  // namespace tcos

#endif  // CORE_TEXT_H_
