import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas, type Rgb } from "../pixel-ui.ts";
import { drawPixelText, measurePixelText } from "../pixel-font.ts";
import { cjkTextWidth, drawCjkText } from "../pixel-cjk.ts";
import { drawBigClockText } from "../tool-renderers.ts";
import type { VisualAnimation } from "../visual-effects.ts";

// The photo's ivory (#F1EEE1) is a wall of light on 832 emissive LEDs; ~78%
// peak keeps the warm-paper read (r > g > b) without the panel glaring.
export const VIEWFINDER_FIELD: Rgb = [200, 191, 164];
// One olive ink for every element, as in the photo: the time wins by size, and
// the 3x5 chips need the full luminance gap to survive halation on a lit field.
export const VIEWFINDER_INK: Rgb = [84, 88, 41];
// Odd-second colon tone: halfway to the field so the pulse reads as breathing,
// not blinking — the face should feel quiet, but a frozen clock looks dead.
export const VIEWFINDER_COLON_SOFT: Rgb = [142, 140, 103];

export interface ViewfinderOptions {
  /** Rounded and drawn in the top-right chip; absent draws the "--°" marker. */
  temperatureC?: number;
  /** Config-state hint (e.g. 未配置): replaces the whole face, weather-effect style. */
  weatherNotice?: string;
}

// The five elements cannot all nest as photographed: the centred 25px time
// leaves 13-14 columns per corner, and a bracket's arms eat the exact rows a
// chip needs. So each corner holds one element — brackets keep the photo's
// TL/BR diagonal (they are the viewfinder signature), chips take the other.
const BRACKET_ARM_H = 6;
const BRACKET_ARM_V = 5;
const TIME_Y = 2; // 9px digits end at row 10, freeing rows 11-15 for the date.
const CHIP_RIGHT_EDGE = 50; // 1px breathing room, mirroring the bracket inset.
const DATE_GLYPH_X = 2;
const DATE_Y = 11;
// Temp text may start no further left than this: the time's last digit ends at
// x=37 and thin chip type merges with it without a 2px gutter.
const TEMP_MIN_X = 40;

// 5x5 calendar: two binding pins, an outlined page, one marked day.
const CALENDAR_GLYPH: readonly string[] = [
  ".#.#.",
  "#####",
  "#...#",
  "#.#.#",
  "#####",
];

function fillField(canvas: PixelCanvas): void {
  canvas.fillRect(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, VIEWFINDER_FIELD);
}

function drawBrackets(canvas: PixelCanvas): void {
  canvas.fillRect(1, 1, BRACKET_ARM_H, 1, VIEWFINDER_INK);
  canvas.fillRect(1, 1, 1, BRACKET_ARM_V, VIEWFINDER_INK);
  canvas.fillRect(DISPLAY_WIDTH - 1 - BRACKET_ARM_H, 14, BRACKET_ARM_H, 1, VIEWFINDER_INK);
  canvas.fillRect(50, DISPLAY_HEIGHT - 1 - BRACKET_ARM_V, 1, BRACKET_ARM_V, VIEWFINDER_INK);
}

function drawTemperatureChip(canvas: PixelCanvas, temperatureC: number | undefined): void {
  const text = temperatureC === undefined ? "--" : String(Math.round(temperatureC));
  const textWidth = measurePixelText(text, 1, 1);
  // The 2x2 degree block costs 3 columns; sub -9°C temps spend them on the
  // extra digit instead — position already says "temperature" on this face.
  const degree = textWidth + 3 <= CHIP_RIGHT_EDGE - TEMP_MIN_X + 1;
  const startX = CHIP_RIGHT_EDGE + 1 - textWidth - (degree ? 3 : 0);
  drawPixelText(canvas, text, startX, 0, VIEWFINDER_INK, 1, 1);
  if (degree) canvas.fillRect(CHIP_RIGHT_EDGE - 1, 0, 2, 2, VIEWFINDER_INK);
}

function drawDateChip(canvas: PixelCanvas, timestamp: number): void {
  for (let row = 0; row < CALENDAR_GLYPH.length; row += 1) {
    for (let column = 0; column < CALENDAR_GLYPH[row]!.length; column += 1) {
      if (CALENDAR_GLYPH[row]![column] === "#") {
        canvas.setPixel(DATE_GLYPH_X + column, DATE_Y + row, VIEWFINDER_INK);
      }
    }
  }
  const date = new Date(timestamp);
  const label = `${date.getMonth() + 1}.${String(date.getDate()).padStart(2, "0")}`;
  drawPixelText(canvas, label, DATE_GLYPH_X + 6, DATE_Y, VIEWFINDER_INK, 1, 1);
}

function frameDelayPlan(durationMs: number): number[] {
  // Same cadence as the sibling clock faces: one frame per second, 90 max.
  const count = Math.max(1, Math.min(90, Math.ceil(durationMs / 1_000)));
  const base = Math.floor(durationMs / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? durationMs - base * (count - 1) : base
  );
}

export function renderViewfinderClock(
  durationMs: number,
  nowMs = Date.now(),
  options: ViewfinderOptions = {},
): VisualAnimation {
  if (options.temperatureC === undefined && options.weatherNotice) {
    // Configuration states borrow the weather effect's presentation exactly:
    // one amber CJK line on switched-off LEDs, held for the whole item.
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    drawCjkText(
      canvas,
      options.weatherNotice,
      Math.floor((DISPLAY_WIDTH - cjkTextWidth(options.weatherNotice)) / 2),
      2,
      [255, 176, 32],
    );
    return {
      frames: [canvas],
      frameDelaysMs: [durationMs],
      label: `取景框钟 · ${options.weatherNotice}`,
    };
  }
  const delays = frameDelayPlan(durationMs);
  let elapsed = 0;
  const frames = delays.map((delay) => {
    const timestamp = nowMs + elapsed;
    const date = new Date(timestamp);
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    fillField(canvas);
    drawBrackets(canvas);
    const label = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    drawBigClockText(canvas, label, TIME_Y, VIEWFINDER_INK);
    if (Math.floor(timestamp / 1_000) % 2 === 1) {
      // HH:MM in 5px digits centres the 1px colon on column 25 every time.
      canvas.setPixel(25, TIME_Y + 2, VIEWFINDER_COLON_SOFT);
      canvas.setPixel(25, TIME_Y + 6, VIEWFINDER_COLON_SOFT);
    }
    drawTemperatureChip(canvas, options.temperatureC);
    drawDateChip(canvas, timestamp);
    elapsed += delay;
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "取景框钟" };
}
