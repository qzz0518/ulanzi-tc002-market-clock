import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pixelTextWidth } from "../web/src/components/music/pixel-lyrics-preview";
import {
  FULL_WIDTH_CELL,
  GLYPH_HEIGHT,
  glyphCellWidth,
  glyphRows,
  HALF_WIDTH_CELL,
  isFullWidth,
} from "../web/src/lib/pixel-glyphs";

// One copy of the tables serves every firmware and the browser preview; this
// test is what stops the two sides from drifting apart.
const visualDir = join(import.meta.dir, "../device/shared-visual");

function parseGlyphHeader(fileName: string): Map<number, number[]> {
  const source = readFileSync(join(visualDir, fileName), "utf8");
  const glyphs = new Map<number, number[]>();
  for (const match of source.matchAll(/\{0x([0-9A-Fa-f]{4}),\{([^}]*)\}\}/g)) {
    glyphs.set(
      Number.parseInt(match[1]!, 16),
      match[2]!.split(",").map((value) => Number.parseInt(value, 16)),
    );
  }
  return glyphs;
}

describe("pixel glyph tables", () => {
  // The preview used to rasterize a webfont at runtime, but the published npm
  // package carries only the latin subset -- every hanzi silently fell back to
  // the system UI font and turned to mush once thresholded to 1-bit. The
  // preview now reads the firmware's own tables, so this guards the property
  // that actually matters: both renderers draw identical bitmaps. Regenerate
  // with `bun run scripts/gen-web-glyphs.ts` when the headers change.
  test("web glyphs match the firmware headers bit for bit", () => {
    const cjk = parseGlyphHeader("CjkFont.h");
    const latin = parseGlyphHeader("LatinFont.h");
    expect(cjk.size).toBeGreaterThan(5_000);
    expect(latin.size).toBe(95);

    for (const [codepoint, rows] of [...cjk, ...latin]) {
      const decoded = glyphRows(codepoint);
      expect(decoded, `missing glyph U+${codepoint.toString(16)}`).not.toBeNull();
      expect(
        [...decoded!],
        `glyph mismatch at U+${codepoint.toString(16)}`,
      ).toEqual(rows);
    }
  });

  test("row masks stay inside their cell width", () => {
    for (const [codepoint, cellWidth] of [
      [0x9009, FULL_WIDTH_CELL],
      [0x41, HALF_WIDTH_CELL],
    ] as const) {
      const rows = glyphRows(codepoint)!;
      expect(rows).toHaveLength(GLYPH_HEIGHT);
      for (const row of rows) expect(row).toBeLessThan(1 << cellWidth);
    }
  });

  // Mirrors LyricsPage::layoutRow: ASCII is half-width, everything else full.
  test("cell widths follow the firmware's half/full-width split", () => {
    expect(glyphCellWidth("A".codePointAt(0)!)).toBe(HALF_WIDTH_CELL);
    expect(glyphCellWidth(" ".codePointAt(0)!)).toBe(HALF_WIDTH_CELL);
    expect(glyphCellWidth("~".codePointAt(0)!)).toBe(HALF_WIDTH_CELL);
    expect(glyphCellWidth("选".codePointAt(0)!)).toBe(FULL_WIDTH_CELL);
    expect(glyphCellWidth("あ".codePointAt(0)!)).toBe(FULL_WIDTH_CELL);
    expect(glyphCellWidth("。".codePointAt(0)!)).toBe(FULL_WIDTH_CELL);
    expect(isFullWidth("Z".codePointAt(0)!)).toBe(false);
  });

  test("line width equals the summed cells the panel would lay out", () => {
    expect(pixelTextWidth("选择歌曲")).toBe(4 * FULL_WIDTH_CELL);
    expect(pixelTextWidth("HELLO 世界")).toBe(6 * HALF_WIDTH_CELL + 2 * FULL_WIDTH_CELL);
    expect(pixelTextWidth("夜空中最亮的星")).toBe(7 * FULL_WIDTH_CELL);
  });

  test("hanzi render as real strokes rather than a solid block", () => {
    // 曲 (U+66F2) is the character that gave the old renderer away: system-font
    // fallback filled its enclosure into one lit slab.
    const rows = glyphRows(0x66f2)!;
    const litPerRow = [...rows].map((row) =>
      [...Array(FULL_WIDTH_CELL)].filter((_, column) => (row >> column) & 1).length
    );
    expect(litPerRow.some((count) => count === 0)).toBe(true);
    expect(Math.max(...litPerRow)).toBeLessThan(FULL_WIDTH_CELL);
    // Interior counter-spaces survive: no row is fully lit, and the glyph uses
    // well under half the cell's pixels.
    const lit = litPerRow.reduce((total, count) => total + count, 0);
    expect(lit).toBeLessThan(FULL_WIDTH_CELL * GLYPH_HEIGHT / 2);
  });

  test("characters outside the charset stay blank instead of substituting", () => {
    expect(glyphRows(0x1f600)).toBeNull();
    expect(glyphCellWidth(0x1f600)).toBe(FULL_WIDTH_CELL);
  });
});
