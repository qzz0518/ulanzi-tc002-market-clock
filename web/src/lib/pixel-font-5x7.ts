import type { PixelTextBitmap } from "./pixel-font";

/**
 * The variable-width 5x7 ASCII face — 3 to 5 columns wide, 7 rows tall.
 *
 * It lives on the web side even though it was drawn for the service's 16x16
 * badge icons, because both sides need the same bits: `src/pixel-font.ts`
 * re-exports this table for the market fallback icons and the bold clock, and
 * the canvas text tool rasterises it for the 52x16 preview. One table, so a
 * second copy can never silently drift. Service-reaches-into-`web/src/lib` is
 * the direction `src/pixel-cjk.ts` and `src/visual-effects.ts` already take for
 * the shared CJK glyphs — the reverse cannot work, since `src/pixel-font.ts`
 * pulls in `PixelCanvas` and with it `node:zlib` and `gifenc`.
 *
 * Coverage is deliberately narrow: digits, A-Z and `?`. It was drawn for short
 * uppercase codes, and `pixelFont5x7Width` below is what keeps a character it
 * cannot draw from collapsing the line it sits in.
 */
export const PIXEL_FONT_5X7: Readonly<Record<string, readonly string[]>> = {
  "0": [".##.", "#..#", "#..#", "#..#", "#..#", "#..#", ".##."],
  "1": [".#.", "##.", ".#.", ".#.", ".#.", ".#.", "###"],
  "2": [".##.", "#..#", "...#", "..#.", ".#..", "#...", "####"],
  "3": ["###.", "...#", "...#", ".##.", "...#", "...#", "###."],
  "4": ["..##", ".#.#", "#..#", "####", "...#", "...#", "...#"],
  "5": ["####", "#...", "#...", "###.", "...#", "...#", "###."],
  "6": [".##.", "#...", "#...", "###.", "#..#", "#..#", ".##."],
  "7": ["####", "...#", "..#.", "..#.", ".#..", ".#..", ".#.."],
  "8": [".##.", "#..#", "#..#", ".##.", "#..#", "#..#", ".##."],
  "9": [".##.", "#..#", "#..#", ".###", "...#", "...#", ".##."],
  A: [".##.", "#..#", "#..#", "####", "#..#", "#..#", "#..#"],
  B: ["###.", "#..#", "#..#", "###.", "#..#", "#..#", "###."],
  C: [".##.", "#..#", "#...", "#...", "#...", "#..#", ".##."],
  D: ["###.", "#..#", "#..#", "#..#", "#..#", "#..#", "###."],
  E: ["####", "#...", "#...", "###.", "#...", "#...", "####"],
  F: ["####", "#...", "#...", "###.", "#...", "#...", "#..."],
  G: [".##.", "#..#", "#...", "#.##", "#..#", "#..#", ".##."],
  H: ["#..#", "#..#", "#..#", "####", "#..#", "#..#", "#..#"],
  I: ["###", ".#.", ".#.", ".#.", ".#.", ".#.", "###"],
  J: ["...#", "...#", "...#", "...#", "#..#", "#..#", ".##."],
  K: ["#..#", "#..#", "#.#.", "##..", "#.#.", "#..#", "#..#"],
  L: ["#...", "#...", "#...", "#...", "#...", "#...", "####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#..#", "##.#", "##.#", "#.##", "#.##", "#..#", "#..#"],
  O: [".##.", "#..#", "#..#", "#..#", "#..#", "#..#", ".##."],
  P: ["###.", "#..#", "#..#", "###.", "#...", "#...", "#..."],
  Q: [".##.", "#..#", "#..#", "#..#", "#..#", ".##.", "...#"],
  R: ["###.", "#..#", "#..#", "###.", "#.#.", "#..#", "#..#"],
  S: [".###", "#...", "#...", ".##.", "...#", "...#", "###."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#..#", "#..#", "#..#", "#..#", "#..#", "#..#", ".##."],
  V: ["#...#", "#...#", "#...#", ".#.#.", ".#.#.", "..#..", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["####", "...#", "..#.", "..#.", ".#..", "#...", "####"],
  "?": [".##.", "#..#", "...#", "..#.", "..#.", "....", "..#."],
  // The VIBE duo page sets a lone starred percent in this face, so the sign has
  // to exist at 7 px too; 5 columns is the widest cell here, which is what the
  // two bowls plus the slash need.
  "%": ["##..#", "##..#", "...#.", "..#..", ".#...", "#..##", "#..##"],
};

/** Every glyph in the table is exactly this tall; only the width varies. */
export const PIXEL_FONT_5X7_HEIGHT = 7;

/**
 * Cell width for a character the table has no glyph for — the space, above all,
 * which the badge icons never needed. 4 columns is the face's modal width, so a
 * blank cell measures like the letters around it instead of reflowing the line.
 */
export const PIXEL_FONT_5X7_BLANK_WIDTH = 4;

export function pixelFont5x7Width(character: string): number {
  return PIXEL_FONT_5X7[character]?.[0]?.length ?? PIXEL_FONT_5X7_BLANK_WIDTH;
}

/**
 * Rasterises a line of 5x7 text the same way `drawPixelText5x7` paints it: one
 * blank tracking column between cells, none after the last, and the whole step
 * multiplied by `scale` so a doubled face keeps its proportions. A character
 * outside the charset holds a blank cell rather than disappearing — the caller
 * names it separately instead of quietly reflowing the rest of the line.
 */
export function renderPixelText5x7(text: string, scale: 1 | 2): PixelTextBitmap {
  const characters = Array.from(text.toUpperCase());
  const widths = characters.map(pixelFont5x7Width);
  const baseWidth = widths.reduce((total, width, index) => total + width + (index > 0 ? 1 : 0), 0);
  const width = baseWidth * scale;
  const height = PIXEL_FONT_5X7_HEIGHT * scale;
  const on = new Uint8Array(Math.max(1, width * height));

  let cursor = 0;
  characters.forEach((character, index) => {
    const glyph = PIXEL_FONT_5X7[character];
    if (glyph) {
      for (let row = 0; row < PIXEL_FONT_5X7_HEIGHT; row += 1) {
        const line = glyph[row]!;
        for (let column = 0; column < line.length; column += 1) {
          if (line[column] !== "#") continue;
          for (let scaleY = 0; scaleY < scale; scaleY += 1) {
            for (let scaleX = 0; scaleX < scale; scaleX += 1) {
              on[(row * scale + scaleY) * width + (cursor + column) * scale + scaleX] = 1;
            }
          }
        }
      }
    }
    cursor += widths[index]! + 1;
  });

  return { width, height, on };
}
