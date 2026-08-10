import {
  glyphCellWidth,
  glyphRows,
} from "../web/src/lib/pixel-glyphs.ts";
import type { PixelCanvas, Rgb } from "./pixel-ui.ts";

export function cjkTextWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += glyphCellWidth(character.codePointAt(0)!);
  }
  return width;
}

export function drawCjkText(
  canvas: PixelCanvas,
  text: string,
  x: number,
  y: number,
  color: Rgb,
): void {
  let cellX = x;
  for (const character of text) {
    const codepoint = character.codePointAt(0)!;
    const cellWidth = glyphCellWidth(codepoint);
    const rows = glyphRows(codepoint);

    if (rows) {
      for (let row = 0; row < rows.length; row += 1) {
        const mask = rows[row]!;
        for (let column = 0; column < cellWidth; column += 1) {
          if ((mask >> (cellWidth - 1 - column)) & 1) {
            canvas.setPixel(cellX + column, y + row, color);
          }
        }
      }
    }

    cellX += cellWidth;
  }
}
