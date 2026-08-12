import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas, type Rgb } from "../pixel-ui.ts";
import { drawPixelText, drawPixelText5x7, measurePixelText } from "../pixel-font.ts";
import type { VisualAnimation } from "../visual-effects.ts";
import type { WeatherCondition } from "../weather/client.ts";

// 大字天气钟: the whole design is scale and contrast, so the digits get almost
// everything. Four 7x14 digits plus a 2px colon need 34px, which leaves a
// 16px column for the weather — the widest split where the time still fills
// rows 1-14 with an even 2px stroke. BIG_DIGITS (5x9) was rejected because it
// leaves 7 of 16 rows dark and the panel stops reading as "a big clock".

/** The two fields the face consumes; structurally below WeatherVisualInput. */
export interface BoldClockWeather {
  condition: WeatherCondition;
  temperatureC: number;
}

// Pure white on switched-off black is the photo's entire idea. The ink lights
// ~210 LEDs at worst (08:08), so full brightness costs nothing here.
export const BOLD_INK: Rgb = [255, 255, 255];
// Same blue-grey as the weather panel's temperature so the two faces read as
// one family, and a visible step below the digits so the time stays dominant.
export const BOLD_TEMP_INK: Rgb = [214, 224, 240];
// House "unconfigured" amber (drawCjkNotice / offline markers).
export const BOLD_NOTICE_INK: Rgb = [255, 176, 32];

export const BOLD_TIME_Y = 1;
// 1px outer margin, 1px between paired digits, 1px on both sides of the
// colon: x spans 1-34 and column 35 stays dark as the divider.
export const BOLD_DIGIT_X = [1, 9, 20, 28] as const;
export const BOLD_COLON_X = 17;

export const BOLD_WEATHER_X = 36;
export const BOLD_WEATHER_WIDTH = DISPLAY_WIDTH - BOLD_WEATHER_X;
// 13px icons centre in the column with a spare pixel each side.
export const BOLD_ICON_X = 38;
const ICON_AREA_HEIGHT = 10;
const TEMP_Y = 11;

// Hand-authored 7x14 digits, 2px stroke throughout, outer corners clipped one
// pixel so the round shapes read round instead of boxy at LED scale.
export const BOLD_DIGITS: Readonly<Record<string, readonly string[]>> = {
  "0": [
    ".#####.", "#######", "##...##", "##...##", "##...##", "##...##", "##...##",
    "##...##", "##...##", "##...##", "##...##", "##...##", "#######", ".#####.",
  ],
  "1": [
    "..##...", ".###...", "..##...", "..##...", "..##...", "..##...", "..##...",
    "..##...", "..##...", "..##...", "..##...", "..##...", "######.", "######.",
  ],
  "2": [
    ".#####.", "#######", "##...##", ".....##", ".....##", "....###", "..####.",
    ".####..", "###....", "##.....", "##.....", "##.....", "#######", "#######",
  ],
  "3": [
    ".#####.", "#######", "##...##", ".....##", ".....##", ".....##", "..#####",
    "..#####", ".....##", ".....##", ".....##", "##...##", "#######", ".#####.",
  ],
  "4": [
    "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "#######",
    "#######", ".....##", ".....##", ".....##", ".....##", ".....##", ".....##",
  ],
  "5": [
    "#######", "#######", "##.....", "##.....", "##.....", "##.....", "######.",
    "#######", ".....##", ".....##", ".....##", "##...##", "#######", ".#####.",
  ],
  "6": [
    ".#####.", "#######", "##...##", "##.....", "##.....", "##.....", "######.",
    "#######", "##...##", "##...##", "##...##", "##...##", "#######", ".#####.",
  ],
  "7": [
    "#######", "#######", ".....##", ".....##", ".....##", "....###", "....##.",
    "...###.", "...##..", "..###..", "..##...", "..##...", "..##...", "..##...",
  ],
  "8": [
    ".#####.", "#######", "##...##", "##...##", "##...##", "##...##", ".#####.",
    ".#####.", "##...##", "##...##", "##...##", "##...##", "#######", ".#####.",
  ],
  "9": [
    ".#####.", "#######", "##...##", "##...##", "##...##", "##...##", "#######",
    ".######", ".....##", ".....##", ".....##", "##...##", "#######", ".#####.",
  ],
};

const CLOUD_BODY: Rgb = [176, 190, 205];
const STORM_BODY: Rgb = [132, 146, 166];
const SUN_CORE: Rgb = [255, 214, 64];
const SUN_RAY: Rgb = [255, 176, 32];
const RAIN_STREAK: Rgb = [92, 170, 255];
const SNOW_FLAKE: Rgb = [236, 244, 255];
const FOG_BAR: Rgb = [140, 150, 165];
const BOLT: Rgb = [255, 214, 64];

export interface BoldWeatherIcon {
  rows: readonly string[];
  inks: Readonly<Record<string, Rgb>>;
}

// 13px-wide icon set, one per WeatherCondition, drawn to be unmistakable from
// across a room: a disc with rays, a lone cloud, cloud + falling marks. The
// bodies stay a step dimmer than the digits so the icon never outshines the
// time; only the falling marks take colour (blue rain, warm bolt) because a
// single-hue accent is what separates rain/snow/thunder at 13px.
export const BOLD_WEATHER_ICONS: Readonly<Record<WeatherCondition, BoldWeatherIcon>> = {
  clear: {
    rows: [
      "+.....+.....+",
      ".............",
      "....#####....",
      "...#######...",
      "++.#######.++",
      "...#######...",
      "....#####....",
      ".............",
      "+.....+.....+",
    ],
    inks: { "#": SUN_CORE, "+": SUN_RAY },
  },
  cloud: {
    rows: [
      "....#####....",
      "..#########..",
      ".###########.",
      "#############",
      "#############",
      ".###########.",
    ],
    inks: { "#": CLOUD_BODY },
  },
  fog: {
    rows: [
      "....#####....",
      "..#########..",
      ".###########.",
      "#############",
      ".###########.",
      ".............",
      ".==========..",
      ".............",
      "..==========.",
    ],
    inks: { "#": CLOUD_BODY, "=": FOG_BAR },
  },
  rain: {
    rows: [
      "....#####....",
      "..#########..",
      ".###########.",
      "#############",
      ".###########.",
      ".............",
      "....|...|...|",
      "...|...|...|.",
      "..|...|...|..",
    ],
    inks: { "#": CLOUD_BODY, "|": RAIN_STREAK },
  },
  snow: {
    rows: [
      "....#####....",
      "..#########..",
      ".###########.",
      "#############",
      ".###########.",
      ".............",
      "..*...*...*..",
      ".............",
      "....*...*....",
    ],
    inks: { "#": CLOUD_BODY, "*": SNOW_FLAKE },
  },
  thunder: {
    rows: [
      "....#####....",
      "..#########..",
      ".###########.",
      "#############",
      ".###########.",
      "......//.....",
      ".....//......",
      "....////.....",
      "......//.....",
      ".....//......",
    ],
    inks: { "#": STORM_BODY, "/": BOLT },
  },
};

// Same 1-second cadence and 90-frame cap as the sibling clock faces
// (flipclock, suncolor). Past the cap the delays stretch and the colon blink
// slows with them — the honest trade for a bounded frame budget.
function tickPlan(durationMs: number): number[] {
  const count = Math.max(1, Math.min(90, Math.ceil(durationMs / 1_000)));
  const base = Math.floor(durationMs / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? durationMs - base * (count - 1) : base
  );
}

function drawBoldDigit(canvas: PixelCanvas, digit: string, x: number, y: number): void {
  const glyph = BOLD_DIGITS[digit];
  if (!glyph) return;
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row]!.length; column += 1) {
      if (glyph[row]![column] === "#") canvas.setPixel(x + column, y + row, BOLD_INK);
    }
  }
}

function drawTime(canvas: PixelCanvas, timestamp: number): void {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  const digits = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  for (let index = 0; index < BOLD_DIGIT_X.length; index += 1) {
    drawBoldDigit(canvas, digits[index]!, BOLD_DIGIT_X[index]!, BOLD_TIME_Y);
  }
  // The colon blinks at 1 Hz because this panel's real failure mode is a
  // frozen frame; a moving pixel is the cheapest proof the clock is alive.
  // 2x2 dots, symmetric around the digit waistline (rows 6-7 of the glyph box).
  if (Math.floor(timestamp / 1_000) % 2 === 0) {
    canvas.fillRect(BOLD_COLON_X, BOLD_TIME_Y + 3, 2, 2, BOLD_INK);
    canvas.fillRect(BOLD_COLON_X, BOLD_TIME_Y + 9, 2, 2, BOLD_INK);
  }
}

function drawIcon(canvas: PixelCanvas, icon: BoldWeatherIcon): void {
  const y0 = Math.floor((ICON_AREA_HEIGHT - icon.rows.length) / 2);
  for (let row = 0; row < icon.rows.length; row += 1) {
    const line = icon.rows[row]!;
    for (let column = 0; column < line.length; column += 1) {
      const ink = icon.inks[line[column]!];
      if (ink) canvas.setPixel(BOLD_ICON_X + column, y0 + row, ink);
    }
  }
}

function drawTemperature(canvas: PixelCanvas, temperatureC: number): void {
  const text = `${Math.round(temperatureC)}C`;
  const width = measurePixelText(text, 1, 1);
  // Centred in the column; "-12C" is 15px and still fits the 16px width. The
  // clamp only matters for off-planet input, where clipping right is fine.
  const x = Math.max(BOLD_WEATHER_X, BOLD_WEATHER_X + Math.floor((BOLD_WEATHER_WIDTH - width) / 2));
  drawPixelText(canvas, text, x, TEMP_Y, BOLD_TEMP_INK, 1, 1);
}

function drawNoticeColumn(canvas: PixelCanvas): void {
  // The 16px column cannot fit a CJK notice (one glyph is 12px wide), so the
  // configuration state is said with the house amber instead: a "?" where the
  // icon would be and "--" where the temperature would be. Nothing
  // weather-shaped is drawn, so no observation is ever faked.
  drawPixelText5x7(canvas, "?", BOLD_WEATHER_X + 6, 1, BOLD_NOTICE_INK);
  drawPixelText(canvas, "--", BOLD_WEATHER_X + 4, TEMP_Y, BOLD_NOTICE_INK, 1, 1);
}

export function renderBoldClock(
  durationMs: number,
  nowMs: number,
  weather?: BoldClockWeather,
  notice?: string,
): VisualAnimation {
  const delays = tickPlan(durationMs);
  let elapsed = 0;
  const frames = delays.map((delay) => {
    const timestamp = nowMs + elapsed;
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    drawTime(canvas, timestamp);
    if (weather) {
      drawIcon(canvas, BOLD_WEATHER_ICONS[weather.condition]);
      drawTemperature(canvas, weather.temperatureC);
    } else {
      drawNoticeColumn(canvas);
    }
    elapsed += delay;
    return canvas;
  });
  return {
    frames,
    frameDelaysMs: delays,
    label: weather ? "大字天气钟" : `大字天气钟 · ${notice ?? "未配置"}`,
  };
}
