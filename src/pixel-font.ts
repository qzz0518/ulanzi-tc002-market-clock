import { PIXEL_FONT_5X7 } from "../web/src/lib/pixel-font-5x7.ts";
import { PixelCanvas, type Rgb } from "./pixel-ui.ts";

// The 5x7 table itself moved to web/src/lib so the canvas text tool can raster
// the same bits (same direction as pixel-cjk.ts / visual-effects.ts). Re-export
// keeps this module's surface unchanged for the badge icons and the bold clock.
export { PIXEL_FONT_5X7 };

export const PIXEL_FONT_3X5: Readonly<Record<string, readonly string[]>> = {
  " ": ["...", "...", "...", "...", "..."],
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", "###", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  A: ["###", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: ["###", "#..", "#..", "#..", "###"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "###", "#..", "###"],
  F: ["###", "#..", "###", "#..", "#.."],
  G: ["###", "#..", "#.#", "#.#", "###"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", "###"],
  K: ["#.#", "##.", "#..", "##.", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "#.#", "#.#", "#.#"],
  N: ["##.", "#.#", "#.#", "#.#", "#.#"],
  O: ["###", "#.#", "#.#", "#.#", "###"],
  P: ["###", "#.#", "###", "#..", "#.."],
  Q: ["###", "#.#", "#.#", "###", "..#"],
  R: ["###", "#.#", "###", "##.", "#.#"],
  S: ["###", "#..", "###", "..#", "###"],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "#.#", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  "%": ["#.#", "..#", ".#.", "#..", "#.#"],
  // No room for a stem at 3 columns, so the S carries the currency on its own
  // — the VIBE pages need "$33" to read as dollars beside a bare "93%".
  $: [".##", "##.", ".#.", ".##", "##."],
  ":": ["...", ".#.", "...", ".#.", "..."],
  "-": ["...", "...", "###", "...", "..."],
  ".": ["...", "...", "...", "...", ".#."],
  "/": ["..#", "..#", ".#.", "#..", "#.."],
  "+": ["...", ".#.", "###", ".#.", "..."],
  "!": [".#.", ".#.", ".#.", "...", ".#."],
  "?": ["###", "..#", ".#.", "...", ".#."],
  "#": ["#.#", "###", "#.#", "###", "#.#"],
  ",": ["...", "...", "...", ".#.", "#.."],
  "(": [".#.", "#..", "#..", "#..", ".#."],
  ")": [".#.", "..#", "..#", "..#", ".#."],
  "*": ["...", "#.#", ".#.", "#.#", "..."],
  "=": ["...", "###", "...", "###", "..."],
};

export function sanitizePixelText(value: string, maximumLength = 96): string {
  return [...value.toUpperCase()]
    .map((character) => PIXEL_FONT_3X5[character] ? character : "?")
    .join("")
    .slice(0, maximumLength);
}

export function measurePixelText(text: string, scale = 1, spacing = 1): number {
  if (text.length === 0) return 0;
  return [...text].length * 3 * scale + ([...text].length - 1) * spacing;
}

export function drawPixelText(
  canvas: PixelCanvas,
  text: string,
  x: number,
  y: number,
  color: Rgb,
  scale = 1,
  spacing = 1,
): number {
  let cursor = x;
  for (const character of sanitizePixelText(text)) {
    const glyph = PIXEL_FONT_3X5[character]!;
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row]!.length; column += 1) {
        if (glyph[row]![column] === "#") {
          canvas.fillRect(cursor + column * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += 3 * scale + spacing;
  }
  return cursor - x;
}

function glyph5x7Width(character: string): number {
  const glyph = PIXEL_FONT_5X7[character];
  if (!glyph) throw new Error(`unsupported 5x7 pixel glyph: ${character}`);
  return glyph[0]!.length;
}

export function measurePixelText5x7(text: string, spacing = 1): number {
  const characters = [...text];
  if (characters.length === 0) return 0;
  return characters.reduce(
    (width, character, index) => width + glyph5x7Width(character) + (index > 0 ? spacing : 0),
    0,
  );
}

export function drawPixelText5x7(
  canvas: PixelCanvas,
  text: string,
  x: number,
  y: number,
  color: Rgb,
  spacing = 1,
): number {
  let cursor = x;
  for (const character of [...text]) {
    const glyph = PIXEL_FONT_5X7[character];
    if (!glyph) throw new Error(`unsupported 5x7 pixel glyph: ${character}`);
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row]!.length; column += 1) {
        if (glyph[row]![column] === "#") canvas.setPixel(cursor + column, y + row, color);
      }
    }
    cursor += glyph[0]!.length + spacing;
  }
  return cursor - spacing - x;
}
