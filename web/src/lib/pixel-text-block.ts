import { PIXEL_FONT, renderPixelText } from "./pixel-font";
import { FULL_WIDTH_CELL, GLYPH_HEIGHT, glyphCellWidth, glyphRows } from "./pixel-glyphs";

/**
 * Text layout for the canvas text tool. Two faces, neither replacing the other:
 *
 * - `ascii-5` / `ascii-10` — the 3x5 face in `pixel-font.ts`. Only 5px tall, so
 *   it is the one face that stacks two lines inside the panel's 16 rows, and it
 *   stays the better pick for short latin labels. It has no CJK coverage.
 * - `shared-12` — the 12x12 CJK / 6x12 latin bitmaps in `pixel-glyphs.ts`, the
 *   same blob the firmware draws from (`device/tc002-lyrics-player/app/src/
 *   visual/CjkFont.h`, asserted bit-for-bit by `test/pixel-glyphs.test.ts`).
 *   It is the only face that can put a hanzi or a kana on the board, and what
 *   it draws here is what the panel draws.
 *
 * The cell walk for `shared-12` copies `LyricsPage::layoutRow` (mirrored in
 * `src/pixel-cjk.ts`): cells butted together with no tracking, ASCII
 * half-width, everything else full-width, and a codepoint outside the generated
 * charset left blank *without* collapsing its cell — dropping the advance would
 * reflow the rest of the line away from what the device shows.
 */

export const PANEL_WIDTH = 52;
export const PANEL_HEIGHT = 16;

export const TEXT_FACES = ["ascii-5", "ascii-10", "shared-12"] as const;
export type TextFace = (typeof TEXT_FACES)[number];

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
  return face === "shared-12" ? substituted : substituted.toUpperCase();
}

function faceCharacters(text: string, face: TextFace): string[] {
  return Array.from(faceText(text, face));
}

function pushMissing(missing: string[], character: string): void {
  if (!missing.includes(character)) missing.push(character);
}

function cellMetrics(characters: readonly string[], face: TextFace): CellMetric[] {
  if (face === "shared-12") {
    return characters.map((character) => {
      const width = glyphCellWidth(character.codePointAt(0)!);
      // The shared face carries its own side bearings inside the cell, so cells
      // butt together and the whole advance is inkable.
      return { advance: width, ink: width };
    });
  }
  const scale = face === "ascii-10" ? 2 : 1;
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

export function layoutTextBlock(text: string, face: TextFace): TextBlock {
  const characters = faceCharacters(text, face);
  const metrics = cellMetrics(characters, face);
  if (face === "shared-12") return layoutSharedFace(characters, metrics);

  const bitmap = renderPixelText(faceText(text, face), face === "ascii-10" ? 10 : 5);
  const missing: string[] = [];
  for (const character of characters) {
    if (PIXEL_FONT[character] === undefined) pushMissing(missing, character);
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
   * Colour laid under the block before the glyphs, or null to leave the board
   * showing through (the tool's original behaviour).
   *
   * "The background" is the block's **bounding box** — `block.width` by
   * `block.height` at the placement origin — and nothing else. Two reasons it
   * is not per-character cell and not the full panel height:
   *
   * - Per cell would be identical for `shared-12` (cells butt together) but
   *   would leave 1px unlit stripes between letters of the 3x5 ASCII face,
   *   where the tracking column belongs to no cell. A backing plate with holes
   *   in it reads as broken, not as tight typography.
   * - Full panel height would wipe rows the text never occupies. A 12px block
   *   at y=2 deliberately leaves rows 0-1 and 14-15 alone, which is the whole
   *   point of laying a caption over an existing drawing.
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
    for (let blockY = 0; blockY < block.height; blockY += 1) {
      for (let blockX = 0; blockX < block.width; blockX += 1) {
        write(blockX, blockY, background);
      }
    }
  }
  for (let blockY = 0; blockY < block.height; blockY += 1) {
    for (let blockX = 0; blockX < block.width; blockX += 1) {
      if (block.on[blockY * block.width + blockX] !== 1) continue;
      write(blockX, blockY, paint.color);
    }
  }
  return next;
}
