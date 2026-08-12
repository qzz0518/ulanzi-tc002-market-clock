import { describe, expect, test } from "bun:test";
import {
  applyPunctuationFallback,
  clampTextOrigin,
  layoutTextBlock,
  maxFullWidthCells,
  measureTextBlockFit,
  paintTextBlock,
  PANEL_HEIGHT,
  PANEL_WIDTH,
  PUNCTUATION_FALLBACK,
  textBlockHasInk,
  type TextBlock,
} from "../web/src/lib/pixel-text-block";
import { glyphRows } from "../web/src/lib/pixel-glyphs";

const PIXELS = PANEL_WIDTH * PANEL_HEIGHT;

function blankBoard(): number[] {
  return new Array(PIXELS).fill(0);
}

/** Coordinates of every pixel that differs from a blank board. */
function litCells(pixels: readonly number[]): string[] {
  const cells: string[] = [];
  pixels.forEach((pixel, index) => {
    if (pixel === 0) return;
    cells.push(`${index % PANEL_WIDTH},${Math.floor(index / PANEL_WIDTH)}`);
  });
  return cells;
}

/** The block's own bitmap, projected onto the board at an origin. */
function expectedGlyphCells(block: TextBlock, originX: number, originY: number): string[] {
  const cells: string[] = [];
  for (let y = 0; y < block.height; y += 1) {
    for (let x = 0; x < block.width; x += 1) {
      if (block.on[y * block.width + x] === 1) cells.push(`${originX + x},${originY + y}`);
    }
  }
  return cells;
}

describe("shared 12px face layout", () => {
  test("walks cells exactly as the firmware does: 12px full-width, 6px ASCII", () => {
    const block = layoutTextBlock("你A好", "shared-12");
    expect(block.width).toBe(12 + 6 + 12);
    expect(block.height).toBe(12);
    expect(block.cells).toBe(3);
    expect(block.missing).toEqual([]);
  });

  test("reproduces the shared bitmap bit-for-bit at a known origin", () => {
    // 你 U+4F60 — the same table the firmware compiles into CjkFont.h.
    const rows = glyphRows(0x4f60)!;
    const block = layoutTextBlock("你", "shared-12");
    const painted = paintTextBlock(blankBoard(), block, 3, 2, { color: 0x00ff66, background: null });

    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 12; column += 1) {
        const lit = ((rows[row]! >> (11 - column)) & 1) === 1;
        expect(painted[(2 + row) * PANEL_WIDTH + (3 + column)]).toBe(lit ? 0x00ff66 : 0);
      }
    }
    // And nothing outside the 12x12 cell was touched.
    expect(litCells(painted).sort()).toEqual(expectedGlyphCells(block, 3, 2).sort());
  });

  test("a codepoint with no glyph is skipped but still advances its cell", () => {
    // 《 U+300A is genuinely absent from the generated charset.
    expect(glyphRows(0x300a)).toBeNull();
    const withHole = layoutTextBlock("你《好", "shared-12");
    expect(withHole.width).toBe(36);
    expect(withHole.missing).toEqual(["《"]);

    // The trailing 好 must land in cell 3 (x=24), not slide left into cell 2.
    const solo = layoutTextBlock("好", "shared-12");
    const painted = paintTextBlock(blankBoard(), withHole, 0, 0, { color: 0xffffff, background: null });
    expect(litCells(painted).filter((cell) => Number(cell.split(",")[0]) >= 24).sort())
      .toEqual(expectedGlyphCells(solo, 24, 0).sort());
    // The blank cell really is blank.
    expect(litCells(painted).some((cell) => {
      const x = Number(cell.split(",")[0]);
      return x >= 12 && x < 24;
    })).toBe(false);
  });

  test("missing characters are deduped in first-seen order", () => {
    const block = layoutTextBlock("《你》《", "shared-12");
    expect(block.missing).toEqual(["《", "》"]);
  });

  test("japanese kana and kanji render from the shared table", () => {
    for (const text of ["こんにちは", "カタカナ", "漢字"]) {
      const block = layoutTextBlock(text, "shared-12");
      expect(block.missing).toEqual([]);
      expect(textBlockHasInk(block)).toBe(true);
    }
  });
});

describe("fullwidth punctuation fallback", () => {
  test("maps IME punctuation onto ASCII glyphs the shared table has", () => {
    expect(applyPunctuationFallback("你好，世界（真的）")).toBe("你好,世界(真的)");
    for (const [source, target] of Object.entries(PUNCTUATION_FALLBACK)) {
      expect(target.length).toBe(1);
      expect(source.length).toBe(1);
      expect(glyphRows(source.codePointAt(0)!)).toBeNull();
      expect(glyphRows(target.codePointAt(0)!)).not.toBeNull();
    }
  });

  test("「你好，世界」 draws without a hole and the comma is half-width", () => {
    const block = layoutTextBlock("你好，世界", "shared-12");
    expect(block.missing).toEqual([]);
    // Four full-width cells plus one half-width comma.
    expect(block.width).toBe(12 * 4 + 6);
    // The comma cell carries the ASCII comma's bitmap, not a blank.
    const comma = glyphRows(0x2c)!;
    const painted = paintTextBlock(blankBoard(), block, 0, 0, { color: 0xffffff, background: null });
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        const lit = ((comma[row]! >> (5 - column)) & 1) === 1;
        expect(painted[row * PANEL_WIDTH + 24 + column]).toBe(lit ? 0xffffff : 0);
      }
    }
  });

  test("brackets with no honest ASCII equivalent stay reported as undrawable", () => {
    const block = layoutTextBlock("《书》【名】〈短〉", "shared-12");
    expect(block.missing).toEqual(["《", "》", "【", "】", "〈", "〉"]);
  });
});

describe("four full-width characters, and what happens to a fifth", () => {
  test("52 / 12 leaves room for exactly four", () => {
    expect(maxFullWidthCells()).toBe(4);
    expect(measureTextBlockFit("你好世界", "shared-12")).toEqual({
      fits: true,
      width: 48,
      overflow: 0,
      capacity: 4,
    });
  });

  test("a fifth is refused with a count, never clipped", () => {
    const fit = measureTextBlockFit("你好世界啊", "shared-12");
    expect(fit).toEqual({ fits: false, width: 60, overflow: 8, capacity: 4 });
  });

  test("the half-width comma buys back a fifth character", () => {
    // 12+12+6+12+12 = 54 > 52, so five is still refused …
    expect(measureTextBlockFit("你好，世界", "shared-12").fits).toBe(false);
    // … but four characters plus punctuation fit where five hanzi would not.
    expect(measureTextBlockFit("你好，界", "shared-12")).toEqual({
      fits: true,
      width: 42,
      overflow: 0,
      capacity: 4,
    });
  });

  test("the ASCII faces get their own budget from the same measurement", () => {
    // 4px advance, 3px ink: 13 characters = 51px fits, 14 = 55px does not.
    expect(measureTextBlockFit("A".repeat(13), "ascii-5")).toEqual({
      fits: true,
      width: 51,
      overflow: 0,
      capacity: 13,
    });
    const overflowing = measureTextBlockFit("A".repeat(14), "ascii-5");
    expect(overflowing.fits).toBe(false);
    expect(overflowing.capacity).toBe(13);
    // Doubled face, halved budget.
    expect(measureTextBlockFit("ABCDEFG", "ascii-10").capacity).toBe(6);
  });

  test("measured width always agrees with the laid-out bitmap", () => {
    for (const face of ["ascii-5", "ascii-10", "shared-12"] as const) {
      for (const text of ["", "A", "HELLO", "你好", "你A好，B"]) {
        expect(measureTextBlockFit(text, face).width).toBe(layoutTextBlock(text, face).width);
      }
    }
  });
});

describe("ASCII faces", () => {
  test("the 5px face still cannot draw CJK, and says so by name", () => {
    const block = layoutTextBlock("你好", "ascii-5");
    expect(textBlockHasInk(block)).toBe(false);
    expect(block.missing).toEqual(["你", "好"]);
  });

  test("lowercase is folded before measuring so capacity matches the bitmap", () => {
    expect(layoutTextBlock("hello", "ascii-5").width)
      .toBe(layoutTextBlock("HELLO", "ascii-5").width);
    expect(layoutTextBlock("hello", "ascii-5").missing).toEqual([]);
  });

  test("two 5px lines stack inside the panel's 16 rows", () => {
    const block = layoutTextBlock("HI", "ascii-5");
    expect(block.height).toBe(5);
    // 5 + gap + 5 = 11 rows; the 12px face alone already uses 12.
    expect(block.height * 2 + 1).toBeLessThanOrEqual(PANEL_HEIGHT);
  });
});

describe("background fill", () => {
  const board = () => {
    // A board with existing art everywhere, so "untouched" is observable.
    const pixels = new Array(PIXELS).fill(0x101010);
    return pixels as number[];
  };

  test("covers exactly the block's bounding box and nothing else", () => {
    const block = layoutTextBlock("你好", "shared-12");
    const painted = paintTextBlock(board(), block, 5, 2, {
      color: 0xffffff,
      background: 0x000000,
    });

    const glyphCells = new Set(expectedGlyphCells(block, 5, 2));
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      for (let x = 0; x < PANEL_WIDTH; x += 1) {
        const inside = x >= 5 && x < 5 + block.width && y >= 2 && y < 2 + block.height;
        const expected = !inside
          ? 0x101010
          : glyphCells.has(`${x},${y}`)
            ? 0xffffff
            : 0x000000;
        expect(painted[y * PANEL_WIDTH + x]).toBe(expected);
      }
    }
  });

  test("does not extend to the full panel height", () => {
    const block = layoutTextBlock("你", "shared-12");
    const painted = paintTextBlock(board(), block, 0, 2, { color: 0xffffff, background: 0x000000 });
    // Rows 0-1 and 14-15 sit outside the 12px block and keep the drawing.
    for (const y of [0, 1, 14, 15]) {
      for (let x = 0; x < PANEL_WIDTH; x += 1) {
        expect(painted[y * PANEL_WIDTH + x]).toBe(0x101010);
      }
    }
  });

  test("fills the ASCII face's tracking columns too, so the plate has no holes", () => {
    const block = layoutTextBlock("II", "ascii-5");
    const painted = paintTextBlock(board(), block, 0, 0, { color: 0xffffff, background: 0x000000 });
    // x=3 is the blank column between the two glyphs — part of the plate.
    for (let y = 0; y < block.height; y += 1) {
      expect(painted[y * PANEL_WIDTH + 3]).toBe(0x000000);
    }
    // x=block.width is the first column past the plate.
    expect(painted[0 * PANEL_WIDTH + block.width]).toBe(0x101010);
  });

  test("a null background leaves the board showing through", () => {
    const block = layoutTextBlock("你", "shared-12");
    const painted = paintTextBlock(board(), block, 0, 2, { color: 0xffffff, background: null });
    const glyphCells = new Set(expectedGlyphCells(block, 0, 2));
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      for (let x = 0; x < PANEL_WIDTH; x += 1) {
        expect(painted[y * PANEL_WIDTH + x])
          .toBe(glyphCells.has(`${x},${y}`) ? 0xffffff : 0x101010);
      }
    }
  });

  test("a blank cell still gets its plate, so the hole is a deliberate gap", () => {
    const block = layoutTextBlock("《", "shared-12");
    expect(textBlockHasInk(block)).toBe(false);
    const painted = paintTextBlock(board(), block, 0, 0, { color: 0xffffff, background: 0x000000 });
    expect(painted.filter((pixel) => pixel === 0x000000).length).toBe(12 * 12);
  });

  test("does not mutate the board it was handed", () => {
    const original = board();
    const block = layoutTextBlock("A", "ascii-5");
    paintTextBlock(original, block, 0, 0, { color: 0xffffff, background: 0x000000 });
    expect(original.every((pixel) => pixel === 0x101010)).toBe(true);
  });
});

describe("placement origin", () => {
  test("clamps so a block that fits is always fully on the panel", () => {
    const block = layoutTextBlock("你好世界", "shared-12");
    expect(clampTextOrigin(block, 40, 12)).toEqual({ x: 4, y: 4 });
    expect(clampTextOrigin(block, -3, -3)).toEqual({ x: 0, y: 0 });
    expect(clampTextOrigin(block, 2, 1)).toEqual({ x: 2, y: 1 });
  });

  test("a clamped 12px block never loses a row or a column", () => {
    const block = layoutTextBlock("你好世界", "shared-12");
    const origin = clampTextOrigin(block, 51, 15);
    const painted = paintTextBlock(blankBoard(), block, origin.x, origin.y, {
      color: 0xffffff,
      background: null,
    });
    expect(litCells(painted).sort()).toEqual(expectedGlyphCells(block, origin.x, origin.y).sort());
  });
});
