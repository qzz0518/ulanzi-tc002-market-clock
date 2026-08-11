#ifndef UI_ZOSLOGO_H_
#define UI_ZOSLOGO_H_

namespace tcos {
namespace zoslogo {

/**
 * The ZOS wordmark, constructed rather than stored.
 *
 * Three 10x14 cells with 2 px strokes, side by side and centred: Z at x=8..17,
 * O at x=21..30, S at x=34..43, all on rows y=1..14. 192 lit pixels.
 *
 * It is code, not a glyph table, for two reasons. The boot screen runs before
 * anything else and carries no .rodata of its own; and every beat of the
 * animation addresses the mark per pixel — developing it out of embers, tracing
 * it with a moving pen, collapsing it — which a bitmap blit cannot do.
 *
 * `arc` is the stroke order: an integer "distance along the pen path" for each
 * pixel, so a pen head at progress p lights everything with arc <= p*arcMax.
 * Integers on purpose — no atan2f or sinf anywhere on the boot path, so the
 * host self-check and the ARM device agree on every frame exactly.
 */

enum Letter { kZ = 0, kO = 1, kS = 2, kNone = -1 };

static const int kCellW = 10;
static const int kCellH = 14;
static const int kTopY = 1;
static const int kOriginX[3] = {8, 21, 34};

// Longest stroke order per letter; see the .cpp for the path each one traces.
static const int kArcMax[3] = {29, 35, 32};

/** Is (x, y) part of the wordmark? Fills the cell coordinates when it is. */
bool inkAt(int x, int y, int* letter, int* lx, int* ly);

/** Stroke order of a cell pixel, or -1 when the pixel is not ink. */
int arcOf(int letter, int lx, int ly);

/** True when (x, y) is orthogonally adjacent to ink but is not ink itself. */
bool haloAt(int x, int y);

/** Total lit pixels; the host self-check pins it so the shapes cannot drift. */
int inkCount();

}  // namespace zoslogo
}  // namespace tcos

#endif  // UI_ZOSLOGO_H_
