import { PIXEL_FONT, renderPixelText } from "./pixel-font";
import { PIXEL_FONT_5X7, pixelFont5x7Width, renderPixelText5x7 } from "./pixel-font-5x7";
import { FULL_WIDTH_CELL, GLYPH_HEIGHT, glyphCellWidth, glyphRows } from "./pixel-glyphs";

/**
 * Text layout for the canvas text tool. Three source faces, none replacing the
 * others, each offered at every upscale the panel's 16 rows can show whole:
 *
 * - `ascii-5` / `ascii-10` / `ascii-15` — the 3x5 face in `pixel-font.ts`. Only
 *   5px tall at 1x, so it is the one face that stacks two lines inside 16 rows,
 *   and the only one with a full punctuation set. No CJK coverage. 4x would be
 *   20 rows, which the panel cannot show, so 15 is the ceiling.
 * - `wide-7` / `wide-14` — the variable-width 5x7 face in `pixel-font-5x7.ts`,
 *   shared with the service's badge icons. Rounder letterforms than the 3x5 at
 *   a similar height, at the cost of a charset that stops at A-Z, 0-9 and `?`.
 * - `shared-12` — the 12x12 CJK / 6x12 latin bitmaps in `pixel-glyphs.ts`, the
 *   same blob the firmware draws from (`device/tc002-lyrics-player/app/src/
 *   visual/CjkFont.h`, asserted bit-for-bit by `test/pixel-glyphs.test.ts`).
 *   It is the only face that can put a hanzi or a kana on the board, what it
 *   draws here is what the panel draws, and it does not scale — 24 rows would
 *   not fit and the bitmaps are not ours to resample.
 *
 * The cell walk for `shared-12` copies `LyricsPage::layoutRow` (mirrored in
 * `src/pixel-cjk.ts`): cells butted together with no tracking, ASCII
 * half-width, everything else full-width, and a codepoint outside the generated
 * charset left blank *without* collapsing its cell — dropping the advance would
 * reflow the rest of the line away from what the device shows. The two ASCII
 * faces keep their own tracking column, scaled with the face.
 */

export const PANEL_WIDTH = 52;
export const PANEL_HEIGHT = 16;

export const TEXT_FACES = [
  "shared-12",
  "ascii-5",
  "ascii-10",
  "ascii-15",
  "wide-7",
  "wide-14",
] as const;
export type TextFace = (typeof TEXT_FACES)[number];

/** Which bitmap table a face reads, and how far it is upscaled. */
export type TextFaceFamily = "shared" | "ascii-3x5" | "wide-5x7";

export interface TextFaceSpec {
  family: TextFaceFamily;
  /** Integer upscale of the source bitmap; the shared face is never resampled. */
  scale: number;
  /** Rows the laid-out block occupies — always <= PANEL_HEIGHT. */
  height: number;
  /** True only for the face whose table carries hanzi and kana. */
  cjk: boolean;
}

export const TEXT_FACE_SPECS: Readonly<Record<TextFace, TextFaceSpec>> = {
  "shared-12": { family: "shared", scale: 1, height: GLYPH_HEIGHT, cjk: true },
  "ascii-5": { family: "ascii-3x5", scale: 1, height: 5, cjk: false },
  "ascii-10": { family: "ascii-3x5", scale: 2, height: 10, cjk: false },
  "ascii-15": { family: "ascii-3x5", scale: 3, height: 15, cjk: false },
  "wide-7": { family: "wide-5x7", scale: 1, height: 7, cjk: false },
  "wide-14": { family: "wide-5x7", scale: 2, height: 14, cjk: false },
};

export function isTextFace(value: string): value is TextFace {
  return (TEXT_FACES as readonly string[]).includes(value);
}

/**
 * The shared table carries hanzi, kana and 。！？、…～「」 but not the rest of the
 * fullwidth punctuation. The fullwidth comma is the one that hurts: a Chinese
 * IME emits it by default, so 「你好，世界」 would render a hole. Each entry here
 * maps to an ASCII form the table *does* have across 0x20-0x7E.
 *
 * Substituting is not a compromise on a 52px row — it is better. Half-width
 * punctuation is 6px against fullwidth's 12px, so a comma stops eating a
 * quarter of the four-character budget. The glyph data itself is never touched:
 * it is verified bit-for-bit against the firmware, which is worth more than a
 * handful of punctuation marks. 《》〈〉【】 have no honest ASCII equivalent and
 * are deliberately absent — they fall through and get reported as undrawable.
 */
export const PUNCTUATION_FALLBACK: Readonly<Record<string, string>> = {
  "，": ",",
  "：": ":",
  "；": ";",
  "“": "\"",
  "”": "\"",
  "‘": "'",
  "’": "'",
  "（": "(",
  "）": ")",
  "·": ".",
  "—": "-",
};

/** One-to-one, so a substitution never reflows the cells around it. */
export function applyPunctuationFallback(text: string): string {
  return Array.from(text).map((character) => PUNCTUATION_FALLBACK[character] ?? character).join("");
}

/**
 * 52 / 12 = 4 remainder 4: four full-width characters fit across the panel with
 * 4px to spare, a fifth needs 60px and cannot. Vertically 12 of 16 rows are
 * used, leaving 4px of slack for the placement origin.
 */
export function maxFullWidthCells(panelWidth: number = PANEL_WIDTH): number {
  return Math.floor(panelWidth / FULL_WIDTH_CELL);
}

export interface TextBlock {
  face: TextFace;
  width: number;
  height: number;
  /** Row-major `width * height`; 1 = a lit glyph pixel. */
  on: Uint8Array;
  /** Cells that consumed horizontal space. */
  cells: number;
  /**
   * Characters this face cannot draw, deduped in first-seen order. They still
   * hold their cell (blank), so the caller can name them in the UI *before* the
   * click — a silent blank is the failure mode that sends someone hunting a bug
   * in the canvas.
   */
  missing: string[];
}

interface CellMetric {
  /** Horizontal step to the next cell. */
  advance: number;
  /** Columns this cell can actually ink; `advance` minus inter-glyph tracking. */
  ink: number;
}

/**
 * Fallback first so both faces see the same substituted string, then case-fold
 * for the ASCII faces — `renderPixelText` folds before it walks, so measuring
 * the unfolded text would let capacity disagree with the bitmap it hands back.
 */
function faceText(text: string, face: TextFace): string {
  const substituted = applyPunctuationFallback(text);
  return TEXT_FACE_SPECS[face].family === "shared" ? substituted : substituted.toUpperCase();
}

function faceCharacters(text: string, face: TextFace): string[] {
  return Array.from(faceText(text, face));
}

function pushMissing(missing: string[], character: string): void {
  if (!missing.includes(character)) missing.push(character);
}

function cellMetrics(characters: readonly string[], face: TextFace): CellMetric[] {
  const { family, scale } = TEXT_FACE_SPECS[face];
  if (family === "shared") {
    return characters.map((character) => {
      const width = glyphCellWidth(character.codePointAt(0)!);
      // The shared face carries its own side bearings inside the cell, so cells
      // butt together and the whole advance is inkable.
      return { advance: width, ink: width };
    });
  }
  if (family === "wide-5x7") {
    // Variable width, so every cell is measured; `renderPixelText5x7` walks the
    // same step, and the test that pins measurement to the bitmap proves it.
    return characters.map((character) => {
      const ink = pixelFont5x7Width(character) * scale;
      return { advance: ink + scale, ink };
    });
  }
  // The 3x5 face has no side bearings, so `renderPixelText` inserts one blank
  // column between glyphs and none after the last one.
  return characters.map(() => ({ advance: 4 * scale, ink: 3 * scale }));
}

function prefixWidth(metrics: readonly CellMetric[], count: number): number {
  if (count <= 0) return 0;
  let width = 0;
  for (let index = 0; index < count; index += 1) width += metrics[index]!.advance;
  const last = metrics[count - 1]!;
  return width - (last.advance - last.ink);
}

function layoutSharedFace(characters: readonly string[], metrics: readonly CellMetric[]): TextBlock {
  const width = prefixWidth(metrics, metrics.length);
  const on = new Uint8Array(Math.max(1, width * GLYPH_HEIGHT));
  const missing: string[] = [];
  let cellX = 0;
  characters.forEach((character, index) => {
    const cellWidth = metrics[index]!.advance;
    const rows = glyphRows(character.codePointAt(0)!);
    if (rows) {
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        const mask = rows[row]!;
        for (let column = 0; column < cellWidth; column += 1) {
          // Bit (cellWidth - 1) is the leftmost column, same as the firmware.
          if ((mask >> (cellWidth - 1 - column)) & 1) on[row * width + cellX + column] = 1;
        }
      }
    } else {
      pushMissing(missing, character);
    }
    // Advance even when the glyph was blank: collapsing the cell would reflow
    // the rest of the line away from what the device shows.
    cellX += cellWidth;
  });
  return { face: "shared-12", width, height: GLYPH_HEIGHT, on, cells: characters.length, missing };
}

/**
 * The space is a cell, never a gap to warn about — the 5x7 table has no glyph
 * for it (badge codes never needed one), and reporting every space as
 * "undrawable" would bury the characters that really are.
 */
function faceCanDraw(character: string, family: TextFaceFamily): boolean {
  if (character === " ") return true;
  return family === "wide-5x7"
    ? PIXEL_FONT_5X7[character] !== undefined
    : PIXEL_FONT[character] !== undefined;
}

export function layoutTextBlock(text: string, face: TextFace): TextBlock {
  const characters = faceCharacters(text, face);
  const spec = TEXT_FACE_SPECS[face];
  if (spec.family === "shared") {
    return layoutSharedFace(characters, cellMetrics(characters, face));
  }

  const rendered = faceText(text, face);
  const bitmap = spec.family === "wide-5x7"
    ? renderPixelText5x7(rendered, spec.scale as 1 | 2)
    : renderPixelText(rendered, spec.height as 5 | 10 | 15);
  const missing: string[] = [];
  for (const character of characters) {
    if (!faceCanDraw(character, spec.family)) pushMissing(missing, character);
  }
  return {
    face,
    width: bitmap.width,
    height: bitmap.height,
    on: bitmap.on,
    cells: characters.length,
    missing,
  };
}

export function textBlockHasInk(block: TextBlock): boolean {
  return block.on.some((value) => value === 1);
}

export interface TextBlockFit {
  fits: boolean;
  /** Laid-out width, so the UI can show the budget before the click. */
  width: number;
  /** Pixels past the panel edge; 0 when it fits. */
  overflow: number;
  /** How many leading characters would fit. */
  capacity: number;
}

/**
 * Overflow policy: **refuse with a count**, do not clip. A clipped 12px glyph is
 * a half-drawn hanzi, which reads as a rendering bug rather than as a choice,
 * and fidelity to the panel is the entire reason this face exists. The caller
 * shows `capacity` in the inspector so the limit is visible before the click.
 */
export function measureTextBlockFit(
  text: string,
  face: TextFace,
  panelWidth: number = PANEL_WIDTH,
): TextBlockFit {
  const characters = faceCharacters(text, face);
  const metrics = cellMetrics(characters, face);
  const width = prefixWidth(metrics, metrics.length);
  let capacity = 0;
  while (capacity < metrics.length && prefixWidth(metrics, capacity + 1) <= panelWidth) {
    capacity += 1;
  }
  return { fits: width <= panelWidth, width, overflow: Math.max(0, width - panelWidth), capacity };
}

/**
 * Keeps the whole block on the panel instead of letting the right/bottom edge
 * eat it. Placement only ever runs on a block that already fits (see
 * `measureTextBlockFit`), so clamping can always show every glyph — and a
 * silently half-placed word is worse than one nudged a few pixels.
 */
export function clampTextOrigin(
  block: TextBlock,
  x: number,
  y: number,
  panelWidth: number = PANEL_WIDTH,
  panelHeight: number = PANEL_HEIGHT,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(panelWidth - block.width, Math.round(x))),
    y: Math.max(0, Math.min(panelHeight - block.height, Math.round(y))),
  };
}

export interface TextPaint {
  color: number;
  /**
   * Colour flooded across the **entire panel** before the glyphs go down, or
   * null to leave the board showing through.
   *
   * "Background" means every pixel of the 52x16 field except the lit glyph
   * pixels — not the block's bounding box, which is what this used to fill. A
   * bounding box is the right answer on a page, where the fill reads as a
   * caption plate against a margin. It is the wrong answer here: 52x16 has no
   * margin to read against, so a 12px block at y=2 left rows 0-1 and 14-15 and
   * the columns either side unlit, and the panel showed a coloured rectangle
   * floating in black. Users read that as a rendering bug, not as a caption.
   *
   * Flooding also makes the painted board a pure function of the origin, which
   * is what lets a placement be dragged by repainting rather than by cutting
   * pixels out of the board — see `TextPlacement`.
   *
   * Laying text over an existing drawing did not go away — that is exactly what
   * `background: null` does, and it stays the default.
   */
  background: number | null;
  panelWidth?: number;
  panelHeight?: number;
}

export function paintTextBlock(
  pixels: readonly number[],
  block: TextBlock,
  originX: number,
  originY: number,
  paint: TextPaint,
): number[] {
  const panelWidth = paint.panelWidth ?? PANEL_WIDTH;
  const panelHeight = paint.panelHeight ?? PANEL_HEIGHT;
  const next = pixels.slice();

  const write = (blockX: number, blockY: number, value: number) => {
    const x = originX + blockX;
    const y = originY + blockY;
    if (x < 0 || x >= panelWidth || y < 0 || y >= panelHeight) return;
    next[y * panelWidth + x] = value;
  };

  const background = paint.background;
  if (background !== null) {
    // Whole field, not the block's box — see TextPaint.background.
    for (let index = 0; index < panelWidth * panelHeight; index += 1) next[index] = background;
  }
  for (let blockY = 0; blockY < block.height; blockY += 1) {
    for (let blockX = 0; blockX < block.width; blockX += 1) {
      if (block.on[blockY * block.width + blockX] !== 1) continue;
      write(blockX, blockY, paint.color);
    }
  }
  return next;
}

/** Same shape as the canvas tool's `Selection`; kept structural on purpose. */
export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Text that is on the board but not yet fused into it.
 *
 * Placement hands one of these to the select tool so the position can be
 * corrected by dragging instead of by re-framing a marquee around words that
 * are already down. Dragging it is deliberately **not** the select tool's pixel
 * lift — a lift cuts a rectangle of the board out and stamps it down elsewhere,
 * which gets two things wrong for text:
 *
 * - A lift cannot tell ink from board. 0x000000 is a palette swatch and the
 *   obvious ink colour once `background` floods the panel with something light,
 *   and a stamp that treats 0 as transparent would drop every one of those
 *   glyph pixels — the text would silently vanish on the first drag.
 * - With `background: null` the rectangle around the glyphs *is* the user's
 *   drawing. Lifting it would carry that artwork away stuck to the letters and
 *   leave a torn hole behind, which is the exact thing `background: null`
 *   exists to avoid.
 *
 * So a placement keeps the board as it was *before* the text landed and
 * repaints from it at the new origin. Moving is then defined as "place it there
 * instead": only glyph pixels ever differ, and a block dragged to (x, y) is
 * byte-identical to one placed at (x, y) in the first place.
 *
 * The select tool itself is untouched by any of this — a marquee the user drew
 * still lifts and stamps exactly as it always has.
 */
export interface TextPlacement {
  /** The board before the block landed. The placement owns this array. */
  baseline: number[];
  block: TextBlock;
  paint: TextPaint;
  x: number;
  y: number;
}

/** The rectangle the canvas should show as the selection. */
export function textPlacementRect(placement: TextPlacement): PanelRect {
  return {
    x: placement.x,
    y: placement.y,
    width: placement.block.width,
    height: placement.block.height,
  };
}

/** Repaints the placement at a new origin, clamped so no glyph leaves the panel. */
export function moveTextPlacement(
  placement: TextPlacement,
  x: number,
  y: number,
): { placement: TextPlacement; pixels: number[] } {
  const panelWidth = placement.paint.panelWidth ?? PANEL_WIDTH;
  const panelHeight = placement.paint.panelHeight ?? PANEL_HEIGHT;
  const origin = clampTextOrigin(placement.block, x, y, panelWidth, panelHeight);
  return {
    placement: { ...placement, x: origin.x, y: origin.y },
    pixels: paintTextBlock(
      placement.baseline,
      placement.block,
      origin.x,
      origin.y,
      placement.paint,
    ),
  };
}

/**
 * Puts a block on the board and keeps it movable. Routed through
 * `moveTextPlacement` so the first paint and every later drag are literally the
 * same operation — the two cannot disagree.
 */
export function beginTextPlacement(
  pixels: readonly number[],
  block: TextBlock,
  x: number,
  y: number,
  paint: TextPaint,
): { placement: TextPlacement; pixels: number[] } {
  return moveTextPlacement({ baseline: pixels.slice(), block, paint, x: 0, y: 0 }, x, y);
}
