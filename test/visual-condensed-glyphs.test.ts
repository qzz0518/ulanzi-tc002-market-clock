import { describe, expect, test } from "bun:test";
import {
  CONDENSED_CROWDED_RUNS,
  CONDENSED_FULL_CELL,
  CONDENSED_INK_WIDTH,
  condensedCellWidth,
  condensedFusedRuns,
  condensedGlyph,
  condensedTextWidth,
} from "../src/visual/condensed-glyphs.ts";
import {
  FULL_WIDTH_CELL,
  GLYPH_HEIGHT,
  glyphRows,
  isFullWidth,
} from "../web/src/lib/pixel-glyphs.ts";

function codepoint(character: string): number {
  return character.codePointAt(0)!;
}

/** Leftmost and rightmost inked column of a glyph, or null when it is blank. */
function inkBox(rows: Uint16Array, width: number): { min: number; max: number } | null {
  let min = width;
  let max = -1;
  for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if (!((rows[row]! >> (width - 1 - column)) & 1)) continue;
      if (column < min) min = column;
      if (column > max) max = column;
    }
  }
  return max < 0 ? null : { min, max };
}

function everyCjkCodepoint(): number[] {
  const found: number[] = [];
  for (let cp = 0x2000; cp <= 0xffff; cp += 1) {
    if (isFullWidth(cp) && glyphRows(cp)) found.push(cp);
  }
  return found;
}

const CJK = everyCjkCodepoint();

describe("condensed face geometry", () => {
  test("the charset is the 5195 glyphs the firmware ships", () => {
    expect(CJK).toHaveLength(5195);
  });

  test("five condensed cells fit the 52px panel and five full cells do not", () => {
    expect(CONDENSED_FULL_CELL * 5).toBe(50);
    expect(FULL_WIDTH_CELL * 5).toBe(60);
    // The kerning column is what the squeeze protects: nine ink plus one gap.
    expect(CONDENSED_INK_WIDTH + 1).toBe(CONDENSED_FULL_CELL);
  });

  test("every hanzi condenses to nine columns with nothing spilling past them", () => {
    for (const cp of CJK) {
      const glyph = condensedGlyph(cp)!;
      expect(glyph.inkWidth).toBe(CONDENSED_INK_WIDTH);
      expect(glyph.cellWidth).toBe(CONDENSED_FULL_CELL);
      expect(glyph.rows).toHaveLength(GLYPH_HEIGHT);
      for (const mask of glyph.rows) {
        expect(mask).toBeLessThan(1 << CONDENSED_INK_WIDTH);
      }
    }
  });

  test("the bounding box is never cut: wide glyphs still reach both edges", () => {
    // This is the property that makes five cells read as five equal squares.
    // Any glyph whose source ink already spans nine or more columns must still
    // touch column 0 and column 8 after the squeeze.
    let checked = 0;
    for (const cp of CJK) {
      const source = inkBox(glyphRows(cp)!, FULL_WIDTH_CELL)!;
      if (source.max - source.min + 1 < CONDENSED_INK_WIDTH) continue;
      checked += 1;
      const box = inkBox(condensedGlyph(cp)!.rows, CONDENSED_INK_WIDTH)!;
      expect(box.min).toBe(0);
      expect(box.max).toBe(CONDENSED_INK_WIDTH - 1);
    }
    expect(checked).toBe(5176);
  });
});

describe("condensed face fidelity", () => {
  test("中 keeps its full-height stem and its closed box", () => {
    // The single most destructive failure mode: a fixed-column drop or a
    // coverage-threshold downscale deletes this 1px stem and 中 becomes 口.
    const rows = [...condensedGlyph(codepoint("中"))!.rows];
    expect(rows).toEqual([
      0b000000000,
      0b000010000,
      0b000010000,
      0b111111111,
      0b100010001,
      0b100010001,
      0b100010001,
      0b111111111,
      0b000010000,
      0b000010000,
      0b000010000,
      0b000010000,
    ]);
    expect(condensedFusedRuns(codepoint("中"))).toBe(0);
  });

  test("日 already fits nine columns, so it is recentred and not cut at all", () => {
    const rows = [...condensedGlyph(codepoint("日"))!.rows];
    expect(rows).toEqual([
      0b000000000,
      0b111111111,
      0b100000001,
      0b100000001,
      0b100000001,
      0b100000001,
      0b111111111,
      0b100000001,
      0b100000001,
      0b100000001,
      0b100000001,
      0b111111111,
    ]);
    expect(condensedFusedRuns(codepoint("日"))).toBe(0);
  });

  test("业 keeps four separate prongs on its shoulder rows", () => {
    // A naive sparsest-column drop fuses the left prong into the stem here.
    const glyph = condensedGlyph(codepoint("业"))!;
    const shoulder = glyph.rows[6]!;
    expect(shoulder).toBe(0b010101010);
    let runs = 0;
    let previous = 0;
    for (let column = 0; column < CONDENSED_INK_WIDTH; column += 1) {
      const bit = (shoulder >> (CONDENSED_INK_WIDTH - 1 - column)) & 1;
      if (bit && !previous) runs += 1;
      previous = bit;
    }
    expect(runs).toBe(4);
  });

  test("latin is passed through untouched — its 6px cell already kerns itself", () => {
    const glyph = condensedGlyph(codepoint("A"))!;
    expect(glyph.inkWidth).toBe(6);
    expect(glyph.cellWidth).toBe(6);
    expect([...glyph.rows]).toEqual([...glyphRows(codepoint("A"))!]);
    expect(glyph.fusedRuns).toBe(0);
  });

  test("characters outside the charset stay null but still claim a cell", () => {
    // Traditional 營 is not in the simplified set; the sign draws tofu for it.
    expect(condensedGlyph(codepoint("營"))).toBeNull();
    expect(condensedCellWidth(codepoint("營"))).toBe(CONDENSED_FULL_CELL);
    expect(condensedFusedRuns(codepoint("營"))).toBe(0);
  });

  test("text width counts 10px per hanzi and leaves ASCII at 6px", () => {
    expect(condensedTextWidth("被迫营业中")).toBe(50);
    expect(condensedTextWidth("摸鱼ing")).toBe(38);
    expect(condensedTextWidth("")).toBe(0);
  });
});

describe("condensed face damage", () => {
  test("the search keeps 2069 glyphs perfectly intact and never fuses more than 8", () => {
    // Guards the column search itself: a regression that starts cutting
    // bounding boxes or merging neighbours moves both of these numbers.
    let lossless = 0;
    let worst = 0;
    for (const cp of CJK) {
      const fused = condensedGlyph(cp)!.fusedRuns;
      if (fused === 0) lossless += 1;
      if (fused > worst) worst = fused;
    }
    expect(lossless).toBe(2069);
    expect(worst).toBe(8);
  });

  test("crowding is graded the way the rendered glyphs actually read", () => {
    // Calibrated by rendering the charset bucketed by fused runs: 被 and 议
    // stay themselves, 删 collapses toward 田 and 挪 becomes a blob.
    for (const character of "中日业今摸") {
      expect(condensedFusedRuns(codepoint(character))).toBeLessThan(CONDENSED_CROWDED_RUNS);
    }
    for (const character of "被议休从") {
      expect(condensedFusedRuns(codepoint(character))).toBeLessThan(CONDENSED_CROWDED_RUNS);
    }
    for (const character of "删侧做搬挪燃") {
      expect(condensedFusedRuns(codepoint(character))).toBeGreaterThanOrEqual(CONDENSED_CROWDED_RUNS);
    }
  });

  test("squeezing only ever removes ink, never adds it", () => {
    // OR-merging neighbours would thicken strokes; this face must not.
    for (const cp of CJK) {
      const source = glyphRows(cp)!;
      const condensed = condensedGlyph(cp)!.rows;
      let sourceInk = 0;
      let condensedInk = 0;
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        for (let column = 0; column < FULL_WIDTH_CELL; column += 1) {
          if ((source[row]! >> column) & 1) sourceInk += 1;
        }
        for (let column = 0; column < CONDENSED_INK_WIDTH; column += 1) {
          if ((condensed[row]! >> column) & 1) condensedInk += 1;
        }
      }
      expect(condensedInk).toBeLessThanOrEqual(sourceInk);
    }
  });
});
