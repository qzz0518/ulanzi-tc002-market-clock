import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas, type Rgb } from "../pixel-ui.ts";
import { drawPixelText, measurePixelText } from "../pixel-font.ts";
import { cjkTextWidth, drawCjkText } from "../pixel-cjk.ts";
import type { VisualAnimation } from "../visual-effects.ts";

/**
 * A film-camera viewfinder: warm paper, olive type, corner brackets framing a
 * time that owns the panel, with the two readouts tucked into the corners the
 * brackets do not use.
 *
 * The first cut of this face put 5x9 digits at the top and the date hard against
 * the bottom edge, which made the time share billing with four small elements
 * and read as a beige dashboard rather than a finder. This layout starts from
 * the opposite end: the time is sized first and everything else lives in what is
 * left.
 *
 * Almost every LED is lit, which makes this the brightest face in the set. The
 * cream is chosen warm rather than bright for that reason — a value that looks
 * like paper on a monitor is a wall of light across 832 emitters.
 */
export const VIEWFINDER_FIELD: Rgb = [200, 191, 164];
export const VIEWFINDER_INK: Rgb = [84, 88, 41];
// Odd-second colon tone: halfway to the field, so the pulse breathes instead of
// blinking. A still panel is this device's real failure mode; the breath is the
// cheapest proof it is alive without spending width on seconds.
export const VIEWFINDER_COLON_SOFT: Rgb = [142, 140, 103];

export interface ViewfinderOptions {
  /** Rounded and drawn in the top-right chip; absent draws the "--°" marker. */
  temperatureC?: number;
  /** Config-state hint (e.g. 未配置): replaces the whole face, weather-effect style. */
  weatherNotice?: string;
}

// The layout arithmetic this face is built on. Four 6px digits, 1px pair gaps
// and a 2px colon with 1px air each side span exactly 30px: x=11..40, leaving
// two symmetric 11px margins. An 11px margin is the narrowest that holds a
// 7px 3x5 number with a 2px gutter to the bold digits AND 2px inset from the
// panel edge — 7px digits (34px span, 9px margins) lose one of the two, which
// is why the BOLD_DIGITS set was narrowed rather than reused as-is.
const TIME_Y = 2; // 12px digits at y=2..13: rows 0 and 15 stay pure field.
const DIGIT_X = [11, 18, 28, 35] as const;
const COLON_X = 25;
// Number lines are right-aligned to x=49: column 50 belongs to the BR bracket
// arm and 51 is edge air, mirroring the 2px gutter on the digit side.
const CHIP_RIGHT_EDGE = 49;
const TEMP_DEGREE_Y = 1; // rhymes with the TL bracket arm hanging at y=1
const TEMP_NUMBER_Y = 4;
const DATE_X = 2;
const DATE_Y = 9; // 3 rows below the TL arm's foot, 2 rows above the edge

// 6x12 digits with a 2px stroke, cut down from boldclock's 7x14 BOLD_DIGITS:
// one bowl row and one tail row removed, width narrowed by one counter pixel
// (2px counters instead of 3px). Outer corners stay clipped 1px so the round
// shapes read round at LED scale.
const VIEWFINDER_DIGITS: Readonly<Record<string, readonly string[]>> = {
  "0": [
    ".####.", "######", "##..##", "##..##", "##..##", "##..##",
    "##..##", "##..##", "##..##", "##..##", "######", ".####.",
  ],
  "1": [
    "..##..", ".###..", "..##..", "..##..", "..##..", "..##..",
    "..##..", "..##..", "..##..", "..##..", "######", "######",
  ],
  "2": [
    ".####.", "######", "##..##", "....##", "...###", "..###.",
    ".###..", "###...", "##....", "##....", "######", "######",
  ],
  "3": [
    ".####.", "######", "##..##", "....##", "....##", "..####",
    "..####", "....##", "....##", "##..##", "######", ".####.",
  ],
  "4": [
    "##..##", "##..##", "##..##", "##..##", "##..##", "######",
    "######", "....##", "....##", "....##", "....##", "....##",
  ],
  "5": [
    "######", "######", "##....", "##....", "##....", "#####.",
    "######", "....##", "....##", "##..##", "######", ".####.",
  ],
  "6": [
    ".####.", "######", "##..##", "##....", "##....", "#####.",
    "######", "##..##", "##..##", "##..##", "######", ".####.",
  ],
  "7": [
    "######", "######", "....##", "....##", "...###", "...##.",
    "..###.", "..##..", ".###..", ".##...", ".##...", ".##...",
  ],
  "8": [
    ".####.", "######", "##..##", "##..##", "##..##", ".####.",
    ".####.", "##..##", "##..##", "##..##", "######", ".####.",
  ],
  "9": [
    ".####.", "######", "##..##", "##..##", "##..##", "######",
    ".#####", "....##", "....##", "##..##", "######", ".####.",
  ],
};

function fillField(canvas: PixelCanvas): void {
  canvas.fillRect(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, VIEWFINDER_FIELD);
}

// Brackets keep the photo's TL/BR diagonal; the chips take the other diagonal
// (TR/BL). With the time centred, each corner pairs with its 180° opposite:
// bracket ↔ bracket, data ↔ data — the balance is rotational, not axial.
function drawBrackets(canvas: PixelCanvas): void {
  canvas.fillRect(1, 1, 6, 1, VIEWFINDER_INK);
  canvas.fillRect(1, 1, 1, 5, VIEWFINDER_INK);
  canvas.fillRect(45, 14, 6, 1, VIEWFINDER_INK);
  canvas.fillRect(50, 10, 1, 5, VIEWFINDER_INK);
}

function drawDigit(canvas: PixelCanvas, digit: string, x: number): void {
  const glyph = VIEWFINDER_DIGITS[digit];
  if (!glyph) return;
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row]!.length; column += 1) {
      if (glyph[row]![column] === "#") {
        canvas.setPixel(x + column, TIME_Y + row, VIEWFINDER_INK);
      }
    }
  }
}

function drawTime(canvas: PixelCanvas, timestamp: number): void {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  const digits = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  for (let index = 0; index < DIGIT_X.length; index += 1) {
    drawDigit(canvas, digits[index]!, DIGIT_X[index]!);
  }
  // 2x2 colon dots at glyph rows 3-4 / 7-8: three blank rows above, two
  // between, three below — symmetric around the 12px digit's waistline.
  const tone = Math.floor(timestamp / 1_000) % 2 === 1
    ? VIEWFINDER_COLON_SOFT
    : VIEWFINDER_INK;
  canvas.fillRect(COLON_X, TIME_Y + 3, 2, 2, tone);
  canvas.fillRect(COLON_X, TIME_Y + 7, 2, 2, tone);
}

function drawTemperatureChip(canvas: PixelCanvas, temperatureC: number | undefined): void {
  const rounded = temperatureC === undefined ? undefined : Math.round(temperatureC);
  let text = rounded === undefined ? "--" : String(rounded);
  let signAloft = false;
  if (rounded !== undefined && measurePixelText(text, 1, 1) > 7) {
    if (Math.abs(rounded) > 99) {
      // Off-planet input: show the honest "unknown" marker rather than clip.
      text = "--";
    } else {
      // "-12" is 11px and the number line holds 7: the minus moves up beside
      // the degree mark ("- °" over "12") instead of dropping a digit.
      signAloft = true;
      text = String(Math.abs(rounded));
    }
  }
  const width = measurePixelText(text, 1, 1);
  drawPixelText(
    canvas, text, CHIP_RIGHT_EDGE + 1 - width, TEMP_NUMBER_Y, VIEWFINDER_INK, 1, 1,
  );
  // The degree mark rides above the number's right shoulder: the margin has
  // no width for an inline "28°" (10px), but it has rows to spare — and the
  // mark is what disambiguates this chip from the bare day number opposite.
  canvas.fillRect(CHIP_RIGHT_EDGE - 1, TEMP_DEGREE_Y, 2, 2, VIEWFINDER_INK);
  if (signAloft) canvas.fillRect(43, TEMP_DEGREE_Y, 3, 2, VIEWFINDER_INK);
}

function drawDateChip(canvas: PixelCanvas, timestamp: number): void {
  // Day only, unpadded. "8.13" is 15px and stacking month over day fills the
  // whole margin height, which would evict the bracket from that corner. The
  // day is the part of a date a glance-clock is consulted for; bottom-left is
  // where this family keeps its date, and the degree-marked chip diagonally
  // opposite leaves no other reading for a bare small number.
  drawPixelText(
    canvas, String(new Date(timestamp).getDate()), DATE_X, DATE_Y, VIEWFINDER_INK, 1, 1,
  );
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
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    fillField(canvas);
    drawBrackets(canvas);
    drawTime(canvas, timestamp);
    drawTemperatureChip(canvas, options.temperatureC);
    drawDateChip(canvas, timestamp);
    elapsed += delay;
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "取景框钟" };
}
