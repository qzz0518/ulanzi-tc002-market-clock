import { describe, expect, test } from "bun:test";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas } from "../src/pixel-ui.ts";
import { drawPixelText, drawPixelText5x7, measurePixelText } from "../src/pixel-font.ts";
import {
  BOLD_COLON_X,
  BOLD_DIGITS,
  BOLD_DIGIT_X,
  BOLD_ICON_X,
  BOLD_INK,
  BOLD_NOTICE_INK,
  BOLD_TEMP_INK,
  BOLD_TIME_Y,
  BOLD_WEATHER_ICONS,
  BOLD_WEATHER_X,
  renderBoldClock,
  type BoldClockWeather,
} from "../src/visual/boldclock.ts";

const NOW = Date.parse("2026-08-10T09:36:00Z");
const RAIN: BoldClockWeather = { condition: "rain", temperatureC: 28.4 };

type Position = [number, number];

function pixelsOfColor(frame: PixelCanvas, color: readonly [number, number, number]): Position[] {
  const positions: Position[] = [];
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      const [red, green, blue] = frame.getPixel(x, y);
      if (red === color[0] && green === color[1] && blue === color[2]) positions.push([x, y]);
    }
  }
  return positions;
}

function litPositions(canvas: PixelCanvas): Position[] {
  const positions: Position[] = [];
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      const [red, green, blue] = canvas.getPixel(x, y);
      if (red + green + blue > 0) positions.push([x, y]);
    }
  }
  return positions;
}

function frameBytes(frames: PixelCanvas[]): string {
  return frames.map((frame) => Buffer.from(frame.pixels).toString("base64")).join("|");
}

function localDigits(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

describe("bold weather clock", () => {
  test("keeps the panel contract at a 1s cadence and caps long items at 90 frames", () => {
    const short = renderBoldClock(10_000, NOW, RAIN);
    expect(short.frames).toHaveLength(10);
    expect(short.frameDelaysMs.every((delay) => delay === 1_000)).toBe(true);
    expect(short.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(10_000);
    for (const frame of short.frames) {
      expect(frame.width).toBe(DISPLAY_WIDTH);
      expect(frame.height).toBe(DISPLAY_HEIGHT);
    }
    expect(short.label).toBe("大字天气钟");

    const long = renderBoldClock(600_000, NOW, RAIN);
    expect(long.frames).toHaveLength(90);
    expect(long.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(600_000);
  });

  test("every authored digit is 7x14 with ink on its first and last row", () => {
    for (const digit of "0123456789") {
      const glyph = BOLD_DIGITS[digit]!;
      expect(glyph).toHaveLength(14);
      for (const row of glyph) expect(row).toHaveLength(7);
      // The height claim: each digit truly spans rows 1..14 of the panel.
      expect(glyph[0]!.includes("#")).toBe(true);
      expect(glyph[13]!.includes("#")).toBe(true);
    }
  });

  test("the wall-clock digits land exactly on the authored grid", () => {
    const frame = renderBoldClock(2_000, NOW, RAIN).frames[0]!;
    const digits = localDigits(NOW);
    for (let index = 0; index < 4; index += 1) {
      const glyph = BOLD_DIGITS[digits[index]!]!;
      for (let row = 0; row < 14; row += 1) {
        for (let column = 0; column < 7; column += 1) {
          const expected = glyph[row]![column] === "#" ? BOLD_INK : [0, 0, 0];
          expect(frame.getPixel(BOLD_DIGIT_X[index]! + column, BOLD_TIME_Y + row)).toEqual(
            expected as [number, number, number],
          );
        }
      }
    }
    // Margin rows above and below the time block stay switched off.
    for (let x = 0; x <= 35; x += 1) {
      expect(frame.getPixel(x, 0)).toEqual([0, 0, 0]);
      expect(frame.getPixel(x, 15)).toEqual([0, 0, 0]);
    }
    expect(frame.getPixel(0, 0)).toEqual([0, 0, 0]);
  });

  test("the colon blinks once per second as the alive signal", () => {
    const animation = renderBoldClock(3_000, NOW, RAIN);
    const litIndex = Math.floor(NOW / 1_000) % 2 === 0 ? 0 : 1;
    const darkIndex = 1 - litIndex;
    const dots: Position[] = [
      [BOLD_COLON_X, BOLD_TIME_Y + 3], [BOLD_COLON_X + 1, BOLD_TIME_Y + 4],
      [BOLD_COLON_X, BOLD_TIME_Y + 9], [BOLD_COLON_X + 1, BOLD_TIME_Y + 10],
    ];
    for (const [x, y] of dots) {
      expect(animation.frames[litIndex]!.getPixel(x, y)).toEqual([255, 255, 255]);
      expect(animation.frames[darkIndex]!.getPixel(x, y)).toEqual([0, 0, 0]);
      expect(animation.frames[litIndex + 2]!.getPixel(x, y)).toEqual([255, 255, 255]);
    }
  });

  test("draws the weather column exactly: icon bitmap plus centred temperature", () => {
    const frame = renderBoldClock(2_000, NOW, RAIN).frames[0]!;
    // Rain: grey cloud body and blue streaks at their authored offsets.
    expect(frame.getPixel(BOLD_ICON_X + 6, 3)).toEqual([176, 190, 205]);
    expect(frame.getPixel(BOLD_ICON_X + 4, 6)).toEqual([92, 170, 255]);
    // 28.4C rounds to "28C" (11px), centred in the 16px column at x=38, y=11.
    const overlay = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    drawPixelText(overlay, "28C", BOLD_WEATHER_X + 2, 11, [255, 255, 255], 1, 1);
    expect(pixelsOfColor(frame, BOLD_TEMP_INK)).toEqual(litPositions(overlay));
    // The divider column between time and weather stays dark.
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) expect(frame.getPixel(35, y)).toEqual([0, 0, 0]);

    // A clear sky swaps in the sun without touching the time block.
    const clear = renderBoldClock(2_000, NOW, { condition: "clear", temperatureC: 28.4 }).frames[0]!;
    expect(clear.getPixel(BOLD_ICON_X + 6, 2)).toEqual([255, 214, 64]);
    expect(clear.getPixel(BOLD_ICON_X, 0)).toEqual([255, 176, 32]);
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x <= 35; x += 1) {
        expect(clear.getPixel(x, y)).toEqual(frame.getPixel(x, y));
      }
    }
  });

  test("covers all six conditions with a non-empty icon", () => {
    for (const condition of ["clear", "cloud", "fog", "rain", "snow", "thunder"] as const) {
      const icon = BOLD_WEATHER_ICONS[condition];
      for (const row of icon.rows) expect(row).toHaveLength(13);
      const frame = renderBoldClock(1_000, NOW, { condition, temperatureC: 5 }).frames[0]!;
      let iconLit = 0;
      for (let y = 0; y < 10; y += 1) {
        for (let x = BOLD_WEATHER_X; x < DISPLAY_WIDTH; x += 1) {
          const [red, green, blue] = frame.getPixel(x, y);
          if (red + green + blue > 0) iconLit += 1;
        }
      }
      expect(iconLit).toBeGreaterThan(10);
    }
  });

  test("a wide negative temperature stays inside the weather column", () => {
    const frame = renderBoldClock(1_000, NOW, { condition: "snow", temperatureC: -12.3 }).frames[0]!;
    const positions = pixelsOfColor(frame, BOLD_TEMP_INK);
    // "-12C" is 15px: the widest realistic reading still clears the divider.
    expect(measurePixelText("-12C", 1, 1)).toBe(15);
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every(([x]) => x >= BOLD_WEATHER_X)).toBe(true);
  });

  test("missing weather keeps the clock and says the state in amber only", () => {
    const animation = renderBoldClock(2_000, NOW, undefined, "未配置");
    expect(animation.label).toBe("大字天气钟 · 未配置");
    const frame = animation.frames[0]!;
    // The time still renders at full size — the clock never dies with the corner.
    const digits = localDigits(NOW);
    const glyph = BOLD_DIGITS[digits[0]!]!;
    for (let row = 0; row < 14; row += 1) {
      for (let column = 0; column < 7; column += 1) {
        if (glyph[row]![column] === "#") {
          expect(frame.getPixel(BOLD_DIGIT_X[0]! + column, BOLD_TIME_Y + row)).toEqual([255, 255, 255]);
        }
      }
    }
    // The column carries exactly the amber "?" and "--" — nothing weather-shaped.
    const overlay = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    drawPixelText5x7(overlay, "?", BOLD_WEATHER_X + 6, 1, [255, 255, 255]);
    drawPixelText(overlay, "--", BOLD_WEATHER_X + 4, 11, [255, 255, 255], 1, 1);
    expect(pixelsOfColor(frame, BOLD_NOTICE_INK)).toEqual(litPositions(overlay));
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = BOLD_WEATHER_X; x < DISPLAY_WIDTH; x += 1) {
        const pixel = frame.getPixel(x, y);
        const isAmber = pixel[0] === BOLD_NOTICE_INK[0] && pixel[1] === BOLD_NOTICE_INK[1]
          && pixel[2] === BOLD_NOTICE_INK[2];
        const isOff = pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0;
        expect(isAmber || isOff).toBe(true);
      }
    }
    // An omitted notice defaults to the configuration hint.
    expect(renderBoldClock(1_000, NOW).label).toBe("大字天气钟 · 未配置");
  });

  test("stays deterministic for identical inputs", () => {
    expect(frameBytes(renderBoldClock(5_000, NOW, RAIN).frames))
      .toBe(frameBytes(renderBoldClock(5_000, NOW, RAIN).frames));
    expect(frameBytes(renderBoldClock(5_000, NOW, RAIN).frames))
      .not.toBe(frameBytes(renderBoldClock(5_000, NOW + 60_000, RAIN).frames));
  });
});
