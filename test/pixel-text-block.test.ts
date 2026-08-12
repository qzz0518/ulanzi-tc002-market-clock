import { describe, expect, test } from "bun:test";
import {
  applyPunctuationFallback,
  beginTextPlacement,
  clampTextOrigin,
  layoutTextBlock,
  maxFullWidthCells,
  measureTextBlockFit,
  moveTextPlacement,
  paintTextBlock,
  PANEL_HEIGHT,
  PANEL_WIDTH,
  PUNCTUATION_FALLBACK,
  TEXT_FACES,
  TEXT_FACE_SPECS,
  textBlockHasInk,
  textPlacementRect,
  type TextBlock,
  type TextFace,
  type TextPaint,
} from "../web/src/lib/pixel-text-block";
import { glyphRows } from "../web/src/lib/pixel-glyphs";
import { PIXEL_FONT } from "../web/src/lib/pixel-font";
import { PIXEL_FONT_5X7 } from "../web/src/lib/pixel-font-5x7";
import { PIXEL_FONT_5X7 as SERVICE_PIXEL_FONT_5X7 } from "../src/pixel-font.ts";

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
    for (const face of TEXT_FACES) {
      for (const text of ["", "A", "HELLO", "HI THERE", "WM1I", "你好", "你A好，B"]) {
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
  const FIELD = 0xff7a00;

  test("covers every pixel of the 52x16 field except the glyphs — counted", () => {
    const block = layoutTextBlock("你好", "shared-12");
    const painted = paintTextBlock(board(), block, 5, 2, { color: 0xffffff, background: FIELD });

    const glyphCells = new Set(expectedGlyphCells(block, 5, 2));
    let ink = 0;
    let field = 0;
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      for (let x = 0; x < PANEL_WIDTH; x += 1) {
        const pixel = painted[y * PANEL_WIDTH + x];
        if (glyphCells.has(`${x},${y}`)) {
          expect(pixel).toBe(0xffffff);
          ink += 1;
        } else {
          expect(pixel).toBe(FIELD);
          field += 1;
        }
      }
    }
    // 你好 lights 84 of the 288 pixels its two 12x12 cells own; every other
    // pixel of the panel — all 52*16 of them minus those — is the fill.
    expect(ink).toBe(84);
    expect(field).toBe(PIXELS - ink);
    expect(ink + field).toBe(PIXELS);
    // Nothing of the previous drawing survives anywhere on the board.
    expect(painted.some((pixel) => pixel === 0x101010)).toBe(false);
  });

  test("extends past the block on every side, including the rows it never occupies", () => {
    const block = layoutTextBlock("你", "shared-12");
    const painted = paintTextBlock(board(), block, 6, 2, { color: 0xffffff, background: FIELD });
    // Rows 0-1 and 14-15 sit outside the 12px block: filled, edge to edge.
    for (const y of [0, 1, 14, 15]) {
      for (let x = 0; x < PANEL_WIDTH; x += 1) {
        expect(painted[y * PANEL_WIDTH + x]).toBe(FIELD);
      }
    }
    // So do the columns left of x=6 and right of the 12px cell.
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      for (const x of [0, 5, 18, PANEL_WIDTH - 1]) {
        expect(painted[y * PANEL_WIDTH + x]).toBe(FIELD);
      }
    }
  });

  test("fills the ASCII face's tracking columns too, so the plate has no holes", () => {
    const block = layoutTextBlock("II", "ascii-5");
    const painted = paintTextBlock(board(), block, 0, 0, { color: 0xffffff, background: FIELD });
    // x=3 is the blank column between the two glyphs.
    for (let y = 0; y < block.height; y += 1) {
      expect(painted[y * PANEL_WIDTH + 3]).toBe(FIELD);
    }
    // x=block.width is the first column past the block, and it is filled now.
    expect(painted[0 * PANEL_WIDTH + block.width]).toBe(FIELD);
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

  test("text with no ink at all leaves a board of pure fill", () => {
    const block = layoutTextBlock("《", "shared-12");
    expect(textBlockHasInk(block)).toBe(false);
    const painted = paintTextBlock(board(), block, 0, 0, { color: 0xffffff, background: FIELD });
    expect(painted.filter((pixel) => pixel === FIELD).length).toBe(PIXELS);
  });

  test("every face fills the same field, whatever its height", () => {
    for (const face of TEXT_FACES) {
      const block = layoutTextBlock(face === "shared-12" ? "字" : "A", face);
      const painted = paintTextBlock(board(), block, 0, 0, { color: 0xffffff, background: FIELD });
      const ink = painted.filter((pixel) => pixel === 0xffffff).length;
      expect(painted.filter((pixel) => pixel === FIELD).length).toBe(PIXELS - ink);
      expect(painted.some((pixel) => pixel === 0x101010)).toBe(false);
    }
  });

  test("does not mutate the board it was handed", () => {
    const original = board();
    const block = layoutTextBlock("A", "ascii-5");
    paintTextBlock(original, block, 0, 0, { color: 0xffffff, background: FIELD });
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

describe("font presets", () => {
  /** The block's own bitmap, compared against a source glyph at an upscale. */
  function expectScaledGlyph(block: TextBlock, rows: readonly string[], scale: number): void {
    expect(block.width).toBe(rows[0]!.length * scale);
    expect(block.height).toBe(rows.length * scale);
    for (let row = 0; row < rows.length; row += 1) {
      const line = rows[row]!;
      for (let column = 0; column < line.length; column += 1) {
        const lit = line[column] === "#" ? 1 : 0;
        for (let scaleY = 0; scaleY < scale; scaleY += 1) {
          for (let scaleX = 0; scaleX < scale; scaleX += 1) {
            const x = column * scale + scaleX;
            const y = row * scale + scaleY;
            expect(block.on[y * block.width + x]).toBe(lit);
          }
        }
      }
    }
  }

  test("every preset states a height the 16-row panel can show whole", () => {
    const heights: Record<TextFace, number> = {
      "shared-12": 12,
      "ascii-5": 5,
      "ascii-10": 10,
      "ascii-15": 15,
      "wide-7": 7,
      "wide-14": 14,
    };
    for (const face of TEXT_FACES) {
      expect(TEXT_FACE_SPECS[face].height).toBe(heights[face]);
      expect(heights[face]).toBeLessThanOrEqual(PANEL_HEIGHT);
      // And the laid-out block agrees with the advertised height.
      expect(layoutTextBlock("A", face).height).toBe(heights[face]);
    }
  });

  test("the 3x5 face draws its own bitmap at 1x, 2x and 3x", () => {
    const source = PIXEL_FONT.R!;
    expect(source).toEqual(["###", "#.#", "###", "##.", "#.#"]);
    expectScaledGlyph(layoutTextBlock("R", "ascii-5"), source, 1);
    expectScaledGlyph(layoutTextBlock("R", "ascii-10"), source, 2);
    expectScaledGlyph(layoutTextBlock("R", "ascii-15"), source, 3);
  });

  test("the 5x7 face draws its own bitmap at 1x and 2x", () => {
    const source = PIXEL_FONT_5X7.A!;
    expect(source).toEqual([".##.", "#..#", "#..#", "####", "#..#", "#..#", "#..#"]);
    expectScaledGlyph(layoutTextBlock("A", "wide-7"), source, 1);
    expectScaledGlyph(layoutTextBlock("A", "wide-14"), source, 2);
  });

  test("the 5x7 face keeps its variable widths, and its narrow glyphs stay narrow", () => {
    // I is 3 columns, A is 4, M is 5 — one tracking column between each.
    expect(layoutTextBlock("I", "wide-7").width).toBe(3);
    expect(layoutTextBlock("A", "wide-7").width).toBe(4);
    expect(layoutTextBlock("M", "wide-7").width).toBe(5);
    expect(layoutTextBlock("IAM", "wide-7").width).toBe(3 + 1 + 4 + 1 + 5);
    expect(layoutTextBlock("IAM", "wide-14").width).toBe((3 + 1 + 4 + 1 + 5) * 2);
  });

  test("each preset gets the row budget its cells actually buy", () => {
    const capacity: Record<TextFace, number> = {
      // 52 / 12 = 4 full-width cells.
      "shared-12": 4,
      // 4px advance, 3px ink: 13 * 4 - 1 = 51.
      "ascii-5": 13,
      "ascii-10": 6,
      // 12px advance, 9px ink: 4 * 12 - 3 = 45; a fifth would need 57.
      "ascii-15": 4,
      // "A" is 4 + 1 tracking: 10 * 5 - 1 = 49; an eleventh would need 54.
      "wide-7": 10,
      "wide-14": 5,
    };
    for (const face of TEXT_FACES) {
      const probe = face === "shared-12" ? "你" : "A";
      expect(measureTextBlockFit(probe.repeat(64), face, PANEL_WIDTH).capacity)
        .toBe(capacity[face]);
    }
  });

  test("only the shared face can draw CJK; the others name what they dropped", () => {
    for (const face of TEXT_FACES) {
      const block = layoutTextBlock("你好", face);
      if (TEXT_FACE_SPECS[face].cjk) {
        expect(block.missing).toEqual([]);
        expect(textBlockHasInk(block)).toBe(true);
      } else {
        expect(block.missing).toEqual(["你", "好"]);
        expect(textBlockHasInk(block)).toBe(false);
      }
    }
  });

  test("the 5x7 face treats a space as a cell, not as a missing character", () => {
    const block = layoutTextBlock("HI YO", "wide-7");
    expect(block.missing).toEqual([]);
    // H=4, I=3, space=4, Y=5, O=4 glyph columns with a tracking column between.
    expect(block.width).toBe(4 + 1 + 3 + 1 + 4 + 1 + 5 + 1 + 4);
    expect(block.cells).toBe(5);
  });

  test("a character the 5x7 face lacks is reported and still holds its cell", () => {
    const withComma = layoutTextBlock("A,B", "wide-7");
    expect(withComma.missing).toEqual([","]);
    // The blank cell is the face's modal 4 columns, so B does not slide left.
    expect(withComma.width).toBe(4 + 1 + 4 + 1 + 4);
    const solo = layoutTextBlock("B", "wide-7");
    for (let y = 0; y < solo.height; y += 1) {
      for (let x = 0; x < solo.width; x += 1) {
        expect(withComma.on[y * withComma.width + 10 + x]).toBe(solo.on[y * solo.width + x]!);
      }
    }
    // And the cell between them really is blank.
    for (let y = 0; y < withComma.height; y += 1) {
      for (let x = 5; x < 10; x += 1) expect(withComma.on[y * withComma.width + x]).toBe(0);
    }
  });

  test("the 5x7 table is one object, not a copy the service can drift from", () => {
    // Same module, reached through `src/pixel-font.ts`'s re-export — identity is
    // a stronger pin than any bit-for-bit comparison could be.
    expect(SERVICE_PIXEL_FONT_5X7).toBe(PIXEL_FONT_5X7);
  });
});

describe("dragging a placed block", () => {
  const FIELD = 0xff7a00;

  /** A three-colour drawing, so "the artwork survived" is observable per pixel. */
  function artwork(): number[] {
    const colors = [0x101010, 0x00ff66, 0x4285f4];
    return Array.from({ length: PIXELS }, (_, index) => colors[index % colors.length]!);
  }

  /** Asserts the whole panel: glyph colour on the block's cells, `field` elsewhere. */
  function expectBoard(
    pixels: readonly number[],
    block: TextBlock,
    originX: number,
    originY: number,
    color: number,
    field: (index: number) => number,
  ): void {
    const glyphs = new Set(expectedGlyphCells(block, originX, originY));
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      for (let x = 0; x < PANEL_WIDTH; x += 1) {
        const index = y * PANEL_WIDTH + x;
        expect(pixels[index]).toBe(glyphs.has(`${x},${y}`) ? color : field(index));
      }
    }
  }

  test("placement paints the board and hands back the block's own rectangle", () => {
    const block = layoutTextBlock("你好", "shared-12");
    const paint: TextPaint = { color: 0xffffff, background: FIELD };
    const placed = beginTextPlacement(blankBoard(), block, 5, 2, paint);
    expect(placed.pixels).toEqual(paintTextBlock(blankBoard(), block, 5, 2, paint));
    // The glyph bounding box, never the filled field — a selection the size of
    // the panel has nowhere to be dragged to.
    expect(textPlacementRect(placed.placement))
      .toEqual({ x: 5, y: 2, width: block.width, height: block.height });
    expect(block.width).toBeLessThan(PANEL_WIDTH);
  });

  test("a drag lands byte-identical to having placed it there, in both fill modes", () => {
    const block = layoutTextBlock("你好", "shared-12");
    for (const background of [FIELD, null]) {
      const board = artwork();
      const paint: TextPaint = { color: 0x00ff66, background };
      const placed = beginTextPlacement(board, block, 5, 2, paint);
      const moved = moveTextPlacement(placed.placement, 1, 3);
      expect(moved.pixels).toEqual(paintTextBlock(board, block, 1, 3, paint));
      expect(textPlacementRect(moved.placement))
        .toEqual({ x: 1, y: 3, width: block.width, height: block.height });
    }
  });

  test("black glyphs survive a drag across a light field", () => {
    // 0x000000 is a palette swatch and dark-on-light is the natural styling once
    // the fill covers the panel. A pixel lift cannot tell that ink from an unlit
    // pixel, so a blit that skips zeros would silently annihilate the text on
    // the first drag; repainting from the baseline cannot.
    const block = layoutTextBlock("你好", "shared-12");
    const paint: TextPaint = { color: 0x000000, background: FIELD };
    const placed = beginTextPlacement(blankBoard(), block, 5, 2, paint);
    expect(placed.pixels.filter((pixel) => pixel === 0x000000).length).toBe(84);

    const moved = moveTextPlacement(placed.placement, 11, 3);
    expect(moved.pixels.filter((pixel) => pixel === 0x000000).length).toBe(84);
    expectBoard(moved.pixels, block, 11, 3, 0x000000, () => FIELD);
  });

  test("a caption over artwork puts the drawing back where it was", () => {
    // background: null is the default and the "caption over a drawing" case. A
    // lift would carry the artwork inside the bounding box away stuck to the
    // letters and leave a torn rectangle behind.
    const art = artwork();
    const block = layoutTextBlock("你好", "shared-12");
    const paint: TextPaint = { color: 0xffffff, background: null };
    const placed = beginTextPlacement(art, block, 5, 2, paint);
    const moved = moveTextPlacement(placed.placement, 9, 3);
    // Only the glyph pixels of the *new* position differ from the drawing —
    // every pixel of the vacated box is the artwork again, not a hole.
    expectBoard(moved.pixels, block, 9, 3, 0xffffff, (index) => art[index]!);
  });

  test("repeated drags repaint from the same baseline, so nothing accumulates", () => {
    const art = artwork();
    const untouched = art.slice();
    const block = layoutTextBlock("HELLO", "wide-14");
    const paint: TextPaint = { color: 0xffd000, background: null };
    const placed = beginTextPlacement(art, block, 4, 1, paint);
    const first = moveTextPlacement(placed.placement, 20, 0);
    const second = moveTextPlacement(first.placement, 30, 2);
    const back = moveTextPlacement(second.placement, 4, 1);
    // Three drags later, dropping it where it started restores that exact board.
    expect(back.pixels).toEqual(placed.pixels);
    // And the caller's array was never written to — the placement took a copy.
    expect(art).toEqual(untouched);
    expect(placed.placement.baseline).not.toBe(art);
  });

  test("a drag cannot push a glyph off the panel", () => {
    const block = layoutTextBlock("你好世界", "shared-12");
    const paint: TextPaint = { color: 0xffffff, background: null };
    const placed = beginTextPlacement(blankBoard(), block, 0, 0, paint);
    const moved = moveTextPlacement(placed.placement, 40, 12);
    expect([moved.placement.x, moved.placement.y]).toEqual([4, 4]);
    expect(litCells(moved.pixels).sort()).toEqual(expectedGlyphCells(block, 4, 4).sort());
    // Negative coordinates clamp the same way.
    expect(moveTextPlacement(placed.placement, -8, -3).placement).toMatchObject({ x: 0, y: 0 });
  });
});
