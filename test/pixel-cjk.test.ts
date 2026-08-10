import { describe, expect, test } from "bun:test";
import { cjkTextWidth, drawCjkText } from "../src/pixel-cjk.ts";
import { PixelCanvas, type Rgb } from "../src/pixel-ui.ts";
import {
  FULL_WIDTH_CELL,
  GLYPH_HEIGHT,
  glyphCellWidth,
  glyphRows,
  HALF_WIDTH_CELL,
} from "../web/src/lib/pixel-glyphs.ts";

const LIT: Rgb = [12, 34, 56];

describe("server CJK pixel text", () => {
  test("measures the same full-width and half-width cells as the web decoder", () => {
    expect(cjkTextWidth("选择歌曲")).toBe(4 * FULL_WIDTH_CELL);
    expect(cjkTextWidth("HELLO 世界")).toBe(
      6 * HALF_WIDTH_CELL + 2 * FULL_WIDTH_CELL
    );
    expect(cjkTextWidth("")).toBe(0);
  });

  test("draws web glyph rows bit for bit", () => {
    const text = "曲A";
    const canvas = new PixelCanvas(cjkTextWidth(text), GLYPH_HEIGHT);
    drawCjkText(canvas, text, 0, 0, LIT);

    let cellX = 0;
    for (const character of text) {
      const codepoint = character.codePointAt(0)!;
      const cellWidth = glyphCellWidth(codepoint);
      const rows = glyphRows(codepoint)!;
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        for (let column = 0; column < cellWidth; column += 1) {
          const expected = (rows[row]! >> (cellWidth - 1 - column)) & 1;
          expect(canvas.getPixel(cellX + column, row)).toEqual(
            expected ? LIT : [0, 0, 0]
          );
        }
      }
      cellX += cellWidth;
    }
  });

  test("keeps missing glyph cells blank while preserving their width", () => {
    const canvas = new PixelCanvas(FULL_WIDTH_CELL, GLYPH_HEIGHT);
    drawCjkText(canvas, "😀", 0, 0, LIT);
    expect(cjkTextWidth("😀")).toBe(FULL_WIDTH_CELL);
    expect(canvas.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(false);
  });
});
