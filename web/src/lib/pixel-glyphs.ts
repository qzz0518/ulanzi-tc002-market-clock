import {
  PIXEL_GLYPH_BLOB_BASE64,
  PIXEL_GLYPH_CELL_HEIGHT,
  PIXEL_GLYPH_CJK_COUNT,
  PIXEL_GLYPH_LATIN_FIRST,
  PIXEL_GLYPH_LATIN_LAST,
} from "./pixel-glyph-data";

/**
 * The dot-matrix font the TC002 panel itself renders from, decoded for the web
 * preview. See `scripts/gen-web-glyphs.ts` for the blob layout and why the
 * preview reads these bits instead of rasterising a webfont at runtime.
 */

export const GLYPH_HEIGHT = PIXEL_GLYPH_CELL_HEIGHT;
export const FULL_WIDTH_CELL = 12;
export const HALF_WIDTH_CELL = 6;

const CJK_PACKED_BYTES = GLYPH_HEIGHT / 2 * 3;
const codepointBytes = PIXEL_GLYPH_CJK_COUNT * 2;
const cjkRowBytes = PIXEL_GLYPH_CJK_COUNT * CJK_PACKED_BYTES;

function decodeBlob(): Uint8Array {
  const binary = atob(PIXEL_GLYPH_BLOB_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const blob = decodeBlob();
const codepoints = new Uint16Array(
  blob.buffer.slice(blob.byteOffset, blob.byteOffset + codepointBytes),
);

/**
 * Firmware rule (`LyricsPage::layoutRow`): ASCII renders half-width from the
 * 6x12 latin set, everything else — hanzi, kana, full-width punctuation —
 * renders full-width from the 12x12 set.
 */
export function isFullWidth(codepoint: number): boolean {
  return !(codepoint >= PIXEL_GLYPH_LATIN_FIRST && codepoint <= PIXEL_GLYPH_LATIN_LAST);
}

export function glyphCellWidth(codepoint: number): number {
  return isFullWidth(codepoint) ? FULL_WIDTH_CELL : HALF_WIDTH_CELL;
}

// Codepoints are strictly ascending, matching the firmware's own binary search.
function cjkIndexOf(codepoint: number): number {
  let low = 0;
  let high = PIXEL_GLYPH_CJK_COUNT - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = codepoints[mid]!;
    if (value === codepoint) return mid;
    if (value < codepoint) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

const rowCache = new Map<number, Uint16Array | null>();

/**
 * The glyph's twelve row masks, or null when the character is outside the
 * generated charset — the panel skips those, so the preview does too. Bit
 * (cellWidth - 1) is the leftmost column.
 */
export function glyphRows(codepoint: number): Uint16Array | null {
  const cached = rowCache.get(codepoint);
  if (cached !== undefined) return cached;

  let rows: Uint16Array | null = null;
  if (isFullWidth(codepoint)) {
    const index = cjkIndexOf(codepoint);
    if (index >= 0) {
      rows = new Uint16Array(GLYPH_HEIGHT);
      const base = codepointBytes + index * CJK_PACKED_BYTES;
      for (let pair = 0; pair < GLYPH_HEIGHT / 2; pair += 1) {
        const first = blob[base + pair * 3]!;
        const middle = blob[base + pair * 3 + 1]!;
        const last = blob[base + pair * 3 + 2]!;
        rows[pair * 2] = (first << 4) | (middle >> 4);
        rows[pair * 2 + 1] = ((middle & 0xf) << 8) | last;
      }
    }
  } else {
    rows = new Uint16Array(GLYPH_HEIGHT);
    const base = codepointBytes + cjkRowBytes
      + (codepoint - PIXEL_GLYPH_LATIN_FIRST) * GLYPH_HEIGHT;
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) rows[row] = blob[base + row]!;
  }

  rowCache.set(codepoint, rows);
  return rows;
}
