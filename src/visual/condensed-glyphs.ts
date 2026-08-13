import {
  FULL_WIDTH_CELL,
  GLYPH_HEIGHT,
  glyphRows,
  HALF_WIDTH_CELL,
  isFullWidth,
} from "../../web/src/lib/pixel-glyphs.ts";

/**
 * A 9x12 condensed face derived from the shared 12x12 glyph blob.
 *
 * Derived, never authored: the 12x12 bitmaps are verified bit-for-bit against
 * the firmware font and cannot change, and nobody is hand-drawing a second
 * 5195-glyph set. So this squeezes each glyph at load time and memoises it.
 *
 * Why nine columns. Measured across all 5195 CJK glyphs, column 11 of the cell
 * is never inked and neither is row 0 — the "12x12" cell is really an 11x11 ink
 * box carrying one column of built-in kerning. Five of those are 55px on a 52px
 * panel however tightly packed, so the ink has to give up two columns: 9 ink +
 * 1 kern = a 10px advance, and 5 x 10 = 50px fits. Ten ink columns would fit
 * only by abutting the cells with no kerning at all, and rendered that way
 * 被迫 and 营业 fuse into single blobs — the gap is worth more than the pixel.
 *
 * Which two columns is the actual problem, and four approaches were rendered
 * and compared before this one:
 *   - dropping fixed columns deletes the central stem of 中 and the left prong
 *     of 业, because a stem sits wherever the character puts it;
 *   - OR-merging adjacent columns preserves every stroke but thickens them,
 *     which is exactly wrong on glyphs already at ~50% coverage (摸, 搬);
 *   - a wiggling seam (true seam carving) shears vertical stems into visible
 *     1px jogs, which reads as a broken glyph rather than a narrow one;
 *   - box-filtering 11 -> 9 with a coverage threshold drops any 1px stem that
 *     straddles two output columns, so 中 loses its stem again.
 *
 * What survives is a per-glyph exhaustive search over every pair of interior
 * columns, keeping the pair that fuses the fewest strokes. The outer bounding
 * box is never cut, so every character still fills its cell edge to edge and
 * five cells read as five equal squares instead of a ragged row.
 *
 * Measured outcome over the charset: 2069 of 5195 glyphs condense with zero
 * fused strokes, and 77% lose at most two. See `fusedRuns` for the per-glyph
 * number and CONDENSED_CROWDED_RUNS for where legibility actually breaks.
 */

/** Ink columns per full-width glyph, plus one kerning column in the cell. */
export const CONDENSED_INK_WIDTH = 9;
export const CONDENSED_FULL_CELL = 10;

/**
 * Latin is left alone. Its 6px cell is already a 5px ink box plus one kerning
 * column, so it carries the same 1px separation the condensed CJK cell does,
 * and squeezing it to 4px would cost far more legibility than the 1px per
 * character it would buy back.
 */
export const CONDENSED_HALF_CELL = HALF_WIDTH_CELL;

/**
 * Fused runs at which a character stops being reliably readable. Calibrated by
 * rendering the whole charset bucketed by this number: at 3-4 (被, 议, 休, 从)
 * the glyph is tighter but still itself; at 5 it is marginal; at 6+ (搬, 侧,
 * 删, 挪, 燃) the left radical merges into the body and 删 reads as 田.
 */
export const CONDENSED_CROWDED_RUNS = 5;

export interface CondensedGlyph {
  /** Twelve row masks; bit (inkWidth - 1) is the leftmost column. */
  readonly rows: Uint16Array;
  readonly inkWidth: number;
  /** Advance including the kerning column. */
  readonly cellWidth: number;
  /** Ink runs along the rows that the squeeze fused or erased; 0 is lossless. */
  readonly fusedRuns: number;
}

function popcount(value: number): number {
  let bits = value;
  let count = 0;
  while (bits !== 0) {
    bits &= bits - 1;
    count += 1;
  }
  return count;
}

/** Column-major view of a glyph: bit r of entry c is set when (c, r) is inked. */
function toColumns(rows: Uint16Array, width: number): number[] {
  const columns: number[] = [];
  for (let column = 0; column < width; column += 1) {
    let mask = 0;
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      if ((rows[row]! >> (width - 1 - column)) & 1) mask |= 1 << row;
    }
    columns.push(mask);
  }
  return columns;
}

function toRows(columns: readonly number[], width: number): Uint16Array {
  const rows = new Uint16Array(GLYPH_HEIGHT);
  for (let column = 0; column < width; column += 1) {
    const mask = columns[column]!;
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      if ((mask >> row) & 1) rows[row] = rows[row]! | (1 << (width - 1 - column));
    }
  }
  return rows;
}

/**
 * Total runs of ink along every row. A run starts wherever a column is inked
 * and its left neighbour is not, so this counts the separate strokes the eye
 * can still resolve on each scanline. Deleting a column can only ever lower it
 * — either two strokes fuse or a lone stroke disappears — which makes it the
 * honest damage signal. (Counting runs down the columns instead would be
 * meaningless here: a 9-column glyph mechanically has fewer of those than an
 * 11-column one whether or not anything was harmed.)
 */
function rowRuns(columns: readonly number[]): number {
  let runs = 0;
  let previous = 0;
  for (const mask of columns) {
    runs += popcount(mask & ~previous);
    previous = mask;
  }
  return runs;
}

function inkCount(columns: readonly number[]): number {
  let ink = 0;
  for (const mask of columns) ink += popcount(mask);
  return ink;
}

/** Centre an ink box narrower than the target inside the target width. */
function centred(columns: readonly number[], width: number): number[] {
  const left = Math.floor((width - columns.length) / 2);
  const out = new Array<number>(width).fill(0);
  for (let index = 0; index < columns.length; index += 1) out[left + index] = columns[index]!;
  return out;
}

/**
 * Every way to drop `count` of the interior columns, ranked. Interior only:
 * the first and last inked columns are the glyph's bounding box and cutting
 * them shifts the character off its own cell.
 */
function bestDrop(columns: readonly number[], count: number): number[] {
  const width = columns.length;
  const baseRuns = rowRuns(columns);
  const baseInk = inkCount(columns);
  let best = columns.slice();
  let bestScore = Number.POSITIVE_INFINITY;

  const evaluate = (drop: readonly number[]): void => {
    const kept: number[] = [];
    for (let index = 0; index < width; index += 1) {
      if (!drop.includes(index)) kept.push(columns[index]!);
    }
    const runLoss = baseRuns - rowRuns(kept);
    const inkLoss = baseInk - inkCount(kept);
    // Spread the two cuts apart when they cost the same: squeezing one side of
    // a character twice tips it over, squeezing both sides once reads even.
    const spread = drop.length === 2 ? drop[1]! - drop[0]! : 0;
    const score = runLoss * 10_000 + inkLoss * 100 - spread;
    if (score < bestScore) {
      bestScore = score;
      best = kept;
    }
  };

  if (count === 1) {
    for (let first = 1; first < width - 1; first += 1) evaluate([first]);
  } else {
    for (let first = 1; first < width - 1; first += 1) {
      for (let second = first + 1; second < width - 1; second += 1) {
        evaluate([first, second]);
      }
    }
  }
  return best;
}

function condenseGlyph(rows: Uint16Array): { rows: Uint16Array; fusedRuns: number } {
  const columns = toColumns(rows, FULL_WIDTH_CELL);
  let start = 0;
  let end = columns.length - 1;
  while (start <= end && columns[start] === 0) start += 1;
  while (end >= start && columns[end] === 0) end -= 1;
  if (end < start) {
    return { rows: new Uint16Array(GLYPH_HEIGHT), fusedRuns: 0 };
  }

  const inked = columns.slice(start, end + 1);
  // A glyph whose ink already fits — 日 and 目 sit in nine columns — is only
  // recentred, never cut. That is 119 glyphs the squeeze cannot touch at all.
  if (inked.length <= CONDENSED_INK_WIDTH) {
    return { rows: toRows(centred(inked, CONDENSED_INK_WIDTH), CONDENSED_INK_WIDTH), fusedRuns: 0 };
  }

  // Two cuts at most in practice — the widest ink box in the charset is 11 —
  // and the pair search is exhaustive, so this loop runs once.
  let squeezed = inked;
  while (squeezed.length > CONDENSED_INK_WIDTH) {
    squeezed = bestDrop(squeezed, Math.min(2, squeezed.length - CONDENSED_INK_WIDTH));
  }
  return {
    rows: toRows(squeezed, CONDENSED_INK_WIDTH),
    fusedRuns: rowRuns(inked) - rowRuns(squeezed),
  };
}

const cache = new Map<number, CondensedGlyph | null>();

/**
 * The condensed glyph, or null when the character is outside the generated
 * charset — same contract as `glyphRows`, so callers keep one tofu path.
 */
export function condensedGlyph(codepoint: number): CondensedGlyph | null {
  const cached = cache.get(codepoint);
  if (cached !== undefined) return cached;

  const rows = glyphRows(codepoint);
  let glyph: CondensedGlyph | null = null;
  if (rows) {
    if (isFullWidth(codepoint)) {
      const condensed = condenseGlyph(rows);
      glyph = {
        rows: condensed.rows,
        inkWidth: CONDENSED_INK_WIDTH,
        cellWidth: CONDENSED_FULL_CELL,
        fusedRuns: condensed.fusedRuns,
      };
    } else {
      glyph = {
        rows,
        inkWidth: HALF_WIDTH_CELL,
        cellWidth: CONDENSED_HALF_CELL,
        fusedRuns: 0,
      };
    }
  }

  cache.set(codepoint, glyph);
  return glyph;
}

/** Advance for one cell, defined for characters outside the charset too. */
export function condensedCellWidth(codepoint: number): number {
  return isFullWidth(codepoint) ? CONDENSED_FULL_CELL : CONDENSED_HALF_CELL;
}

export function condensedTextWidth(text: string): number {
  let width = 0;
  for (const character of text) width += condensedCellWidth(character.codePointAt(0)!);
  return width;
}

/** How badly the squeeze hurt this character; 0 when nothing fused. */
export function condensedFusedRuns(codepoint: number): number {
  return condensedGlyph(codepoint)?.fusedRuns ?? 0;
}
