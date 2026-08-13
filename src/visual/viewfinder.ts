import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas, type Rgb } from "../pixel-ui.ts";
import { drawPixelText, measurePixelText } from "../pixel-font.ts";
import { cjkTextWidth, drawCjkText } from "../pixel-cjk.ts";
import type { VisualAnimation } from "../visual-effects.ts";

/**
 * A film-camera viewfinder: a flat colour field, punched type, corner brackets
 * framing a time that owns the panel, with the two readouts tucked into the
 * corners the brackets do not use.
 *
 * The first cut of this face put 5x9 digits at the top and the date hard against
 * the bottom edge, which made the time share billing with four small elements
 * and read as a beige dashboard rather than a finder. This layout starts from
 * the opposite end: the time is sized first and everything else lives in what is
 * left.
 *
 * Colour is a palette, not two pickers — same reasoning as the sibling 灯牌 face
 * and the same record shape, so the two read as one system. On an emissive panel
 * an arbitrary field/ink pair lands in one of two ditches: values close enough to
 * look tasteful on a monitor lose their 2px strokes to LED bloom, and values far
 * enough apart usually means one of them is a wall of light across 832 emitters.
 * Curated pairs are also the only way to keep BRIGHTNESS a design decision. The
 * field covers all 832 pixels and the type only ~263, so the field is what a dark
 * room actually pays for; the shipped cream throws roughly six times the light of
 * the darkest palette here. See VIEWFINDER_PALETTES for the measured ladder.
 */

export const VIEWFINDER_PALETTE_IDS = [
  "paper",
  "cyanotype",
  "sunset",
  "amber",
  "nightvision",
  "darkroom",
] as const;

export type ViewfinderPaletteId = (typeof VIEWFINDER_PALETTE_IDS)[number];

export interface ViewfinderPalette {
  /** Simplified-Chinese choice label for the marketplace option field. */
  label: string;
  /** Drawn on all 832 pixels, so this is what dominates the face's output. */
  field: Rgb;
  /** Drawn on the ~263 pixels of brackets, digits and chips. */
  ink: Rgb;
  /** Odd-second colon tone; always derived, see makePalette. */
  colonSoft: Rgb;
}

/**
 * The soft colon tone is computed, never authored. It is the one value in a
 * palette that has a right answer — exactly halfway to the field, so the pulse
 * breathes instead of blinking — and the one a new palette would quietly get
 * wrong if it were typed in by hand. Rounding reproduces the shipped paper
 * tone (142,140,103) bit for bit, so existing channels do not shift.
 */
function makePalette(label: string, field: Rgb, ink: Rgb): ViewfinderPalette {
  return {
    label,
    field,
    ink,
    colonSoft: [
      Math.round((field[0] + ink[0]) / 2),
      Math.round((field[1] + ink[1]) / 2),
      Math.round((field[2] + ink[2]) / 2),
    ],
  };
}

// A night palette's ground is its own ink at ember level, not black. 7% is the
// measured floor at which 52x16 LEDs still describe a rectangle in a dark room
// without adding meaningfully to output — the brackets need something to be
// corners OF, and a true (0,0,0) field turns this face into four floating
// digits, which is the sibling 大字天气钟 rather than a finder.
const NIGHT_GROUND_FRACTION = 0.07;

function makeNightPalette(label: string, ink: Rgb): ViewfinderPalette {
  const ground = ink.map((channel) => Math.round(channel * NIGHT_GROUND_FRACTION)) as unknown as Rgb;
  return makePalette(label, ground, ink);
}

/**
 * Ordered brightest to darkest — that ladder is the axis a user actually shops
 * on at 23:00, so it is the order the select shows. Each comment carries the
 * palette's measured light output: the frame's mean per-LED luminance as a
 * fraction of an all-white 832-LED panel, which is what the room actually sees.
 * test/visual-viewfinder.test.ts pins the ordering so a future palette cannot
 * be dropped into the middle of the ladder without measuring it first.
 *
 * The split is structural, not decorative. The first three light the field on
 * every one of the 832 LEDs and punch dark type out of it; the last three light
 * only the ~263 pixels of type and leave the ground at ember. That is a 3-6x
 * difference in output and the whole reason this is a set and not a cream.
 */
export const VIEWFINDER_PALETTES: Readonly<Record<ViewfinderPaletteId, ViewfinderPalette>> = {
  // 38.6% — the shipped look and still the default. Brightest in the set by a
  // wide margin because 832 lit LEDs at this value is most of a white panel; the
  // cream is chosen warm rather than bright for exactly that reason.
  paper: makePalette("胶片米", [200, 191, 164], [84, 88, 41]),
  // 25.4% — cyanotype, and the hinge of the set: field still lit everywhere, but
  // the type is now the LIGHT value. Blue carries the least luminance per unit of
  // drive of any hue, which is what lets a fully-lit field stay this civilised
  // while giving the sharpest field/ink separation of the three lit palettes.
  cyanotype: makePalette("蓝晒", [26, 62, 120], [196, 220, 242]),
  // 16.6% — golden hour. The paper composition an octave down: same warm lit
  // field, same dark type, well under half the output.
  sunset: makePalette("落霞橙", [198, 112, 44], [46, 18, 8]),
  // 14.2% — instrument readout. First of the night palettes: below here the
  // ground goes to ember and only the type burns.
  amber: makeNightPalette("琥珀夜", [246, 158, 42]),
  // 12.5% — scope phosphor. The green is held well short of channel 255: green
  // dominates perceived luminance, so an unclamped one would land brighter than
  // 落霞橙 and break the ladder this list is ordered on.
  nightvision: makeNightPalette("夜视绿", [64, 190, 100]),
  // 6.1%, the floor, and the one to leave on beside a bed — deep red is the
  // least disruptive hue to dark-adapted eyes, which is why darkrooms use it.
  darkroom: makeNightPalette("暗房红", [232, 40, 28]),
};

export const VIEWFINDER_DEFAULT_PALETTE: ViewfinderPaletteId = "paper";

export function viewfinderPalette(paletteId: string | undefined): ViewfinderPalette {
  return paletteId && paletteId in VIEWFINDER_PALETTES
    ? VIEWFINDER_PALETTES[paletteId as ViewfinderPaletteId]
    : VIEWFINDER_PALETTES[VIEWFINDER_DEFAULT_PALETTE];
}

export interface ViewfinderOptions {
  /** Rounded and drawn in the top-right chip; absent draws the "--°" marker. */
  temperatureC?: number;
  /** Config-state hint (e.g. 未配置): replaces the whole face, weather-effect style. */
  weatherNotice?: string;
  /** Palette id; unknown values fall back to the shipped paper look. */
  palette?: string;
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

function fillField(canvas: PixelCanvas, palette: ViewfinderPalette): void {
  canvas.fillRect(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, palette.field);
}

// Brackets keep the photo's TL/BR diagonal; the chips take the other diagonal
// (TR/BL). With the time centred, each corner pairs with its 180° opposite:
// bracket ↔ bracket, data ↔ data — the balance is rotational, not axial.
function drawBrackets(canvas: PixelCanvas, palette: ViewfinderPalette): void {
  canvas.fillRect(1, 1, 6, 1, palette.ink);
  canvas.fillRect(1, 1, 1, 5, palette.ink);
  canvas.fillRect(45, 14, 6, 1, palette.ink);
  canvas.fillRect(50, 10, 1, 5, palette.ink);
}

function drawDigit(
  canvas: PixelCanvas,
  digit: string,
  x: number,
  palette: ViewfinderPalette,
): void {
  const glyph = VIEWFINDER_DIGITS[digit];
  if (!glyph) return;
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row]!.length; column += 1) {
      if (glyph[row]![column] === "#") {
        canvas.setPixel(x + column, TIME_Y + row, palette.ink);
      }
    }
  }
}

function drawTime(canvas: PixelCanvas, timestamp: number, palette: ViewfinderPalette): void {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  const digits = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  for (let index = 0; index < DIGIT_X.length; index += 1) {
    drawDigit(canvas, digits[index]!, DIGIT_X[index]!, palette);
  }
  // 2x2 colon dots at glyph rows 3-4 / 7-8: three blank rows above, two
  // between, three below — symmetric around the 12px digit's waistline. A still
  // panel is this device's real failure mode; the breath is the cheapest proof
  // it is alive without spending width on seconds.
  const tone = Math.floor(timestamp / 1_000) % 2 === 1 ? palette.colonSoft : palette.ink;
  canvas.fillRect(COLON_X, TIME_Y + 3, 2, 2, tone);
  canvas.fillRect(COLON_X, TIME_Y + 7, 2, 2, tone);
}

function drawTemperatureChip(
  canvas: PixelCanvas,
  temperatureC: number | undefined,
  palette: ViewfinderPalette,
): void {
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
    canvas, text, CHIP_RIGHT_EDGE + 1 - width, TEMP_NUMBER_Y, palette.ink, 1, 1,
  );
  // The degree mark rides above the number's right shoulder: the margin has
  // no width for an inline "28°" (10px), but it has rows to spare — and the
  // mark is what disambiguates this chip from the bare day number opposite.
  canvas.fillRect(CHIP_RIGHT_EDGE - 1, TEMP_DEGREE_Y, 2, 2, palette.ink);
  if (signAloft) canvas.fillRect(43, TEMP_DEGREE_Y, 3, 2, palette.ink);
}

function drawDateChip(canvas: PixelCanvas, timestamp: number, palette: ViewfinderPalette): void {
  // Day only, unpadded. "8.13" is 15px and stacking month over day fills the
  // whole margin height, which would evict the bracket from that corner. The
  // day is the part of a date a glance-clock is consulted for; bottom-left is
  // where this family keeps its date, and the degree-marked chip diagonally
  // opposite leaves no other reading for a bare small number.
  drawPixelText(
    canvas, String(new Date(timestamp).getDate()), DATE_X, DATE_Y, palette.ink, 1, 1,
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
  const palette = viewfinderPalette(options.palette);
  const delays = frameDelayPlan(durationMs);
  let elapsed = 0;
  const frames = delays.map((delay) => {
    const timestamp = nowMs + elapsed;
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    fillField(canvas, palette);
    drawBrackets(canvas, palette);
    drawTime(canvas, timestamp, palette);
    drawTemperatureChip(canvas, options.temperatureC, palette);
    drawDateChip(canvas, timestamp, palette);
    elapsed += delay;
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "取景框钟" };
}
