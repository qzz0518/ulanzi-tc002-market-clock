import { describe, expect, test } from "bun:test";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas, type Rgb } from "../src/pixel-ui.ts";
import { drawPixelText } from "../src/pixel-font.ts";
import { cjkTextWidth, drawCjkText } from "../src/pixel-cjk.ts";
import { drawBigClockText } from "../src/tool-renderers.ts";
import type { VisualAnimation } from "../src/visual-effects.ts";
import {
  renderViewfinderClock,
  VIEWFINDER_COLON_SOFT,
  VIEWFINDER_FIELD,
  VIEWFINDER_INK,
} from "../src/visual/viewfinder.ts";

// Local-time construction keeps the expected HH:MM/M.DD stable in any zone.
const NOW = new Date(2026, 7, 13, 9, 18, 0).getTime();

function expectPanelContract(animation: VisualAnimation, durationMs: number): void {
  expect(animation.frames.length).toBeGreaterThan(0);
  expect(animation.frames.length).toBeLessThanOrEqual(90);
  expect(animation.frames.length).toBe(animation.frameDelaysMs.length);
  expect(animation.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(durationMs);
  expect(animation.frameDelaysMs.every((delay) => delay > 0)).toBe(true);
  for (const frame of animation.frames) {
    expect(frame.width).toBe(DISPLAY_WIDTH);
    expect(frame.height).toBe(DISPLAY_HEIGHT);
  }
}

function frameBytes(animation: VisualAnimation): string {
  return animation.frames.map((frame) => Buffer.from(frame.pixels).toString("base64")).join("|");
}

/** Pixels of `color` inside the given box, as "x,y" strings for set equality. */
function inkPixels(
  frame: PixelCanvas,
  color: Rgb,
  box: { x: number; y: number; width: number; height: number },
): string[] {
  const positions: string[] = [];
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const [red, green, blue] = frame.getPixel(x, y);
      if (red === color[0] && green === color[1] && blue === color[2]) {
        positions.push(`${x},${y}`);
      }
    }
  }
  return positions;
}

function overlayPixels(
  draw: (canvas: PixelCanvas) => void,
  box: { x: number; y: number; width: number; height: number },
): string[] {
  const overlay = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  draw(overlay);
  const positions: string[] = [];
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (overlay.getPixel(x, y)[0] > 0) positions.push(`${x},${y}`);
    }
  }
  return positions;
}

describe("viewfinder clock", () => {
  test("holds the panel contract, stays deterministic, caps long items at 90 frames", () => {
    const animation = renderViewfinderClock(4_000, NOW, { temperatureC: 28 });
    expectPanelContract(animation, 4_000);
    expect(animation.label).toBe("取景框钟");
    expect(frameBytes(renderViewfinderClock(4_000, NOW, { temperatureC: 28 })))
      .toBe(frameBytes(animation));
    expect(frameBytes(renderViewfinderClock(4_000, NOW + 60_000, { temperatureC: 28 })))
      .not.toBe(frameBytes(animation));
    const long = renderViewfinderClock(600_000, NOW, { temperatureC: 28 });
    expect(long.frames).toHaveLength(90);
    expectPanelContract(long, 600_000);
  });

  test("fills the field with warm paper and insets both brackets one pixel", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28 }).frames[0]!;
    // The very corners stay field: the brackets are inset, not flush.
    for (const [x, y] of [[0, 0], [51, 0], [0, 15], [51, 15]] as const) {
      expect(frame.getPixel(x, y)).toEqual(VIEWFINDER_FIELD);
    }
    // Top-left L: 6px arm along row 1, 5px arm down column 1.
    for (let x = 1; x <= 6; x += 1) expect(frame.getPixel(x, 1)).toEqual(VIEWFINDER_INK);
    for (let y = 1; y <= 5; y += 1) expect(frame.getPixel(1, y)).toEqual(VIEWFINDER_INK);
    // Bottom-right L, mirrored.
    for (let x = 45; x <= 50; x += 1) expect(frame.getPixel(x, 14)).toEqual(VIEWFINDER_INK);
    for (let y = 10; y <= 14; y += 1) expect(frame.getPixel(50, y)).toEqual(VIEWFINDER_INK);
  });

  test("centres 9px big digits at y=2 and breathes the colon instead of blinking it", () => {
    const date = new Date(NOW);
    const label = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const timeBox = { x: 13, y: 2, width: 25, height: 9 };
    const animation = renderViewfinderClock(4_000, NOW, { temperatureC: 28 });
    // Even second: the whole time incl. colon is solid ink on the house glyphs.
    expect(inkPixels(animation.frames[0]!, VIEWFINDER_INK, timeBox)).toEqual(
      overlayPixels((canvas) => drawBigClockText(canvas, label, 2, [255, 255, 255]), timeBox),
    );
    // Odd second: only the two colon pixels soften; the digits do not move.
    const odd = animation.frames[1]!;
    expect(odd.getPixel(25, 4)).toEqual(VIEWFINDER_COLON_SOFT);
    expect(odd.getPixel(25, 8)).toEqual(VIEWFINDER_COLON_SOFT);
    expect(animation.frames[2]!.getPixel(25, 4)).toEqual(VIEWFINDER_INK);
  });

  test("right-aligns the temperature chip with a 2x2 degree block in the top-right", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28.4 }).frames[0]!;
    const chipBox = { x: 38, y: 0, width: 14, height: 5 };
    expect(inkPixels(frame, VIEWFINDER_INK, chipBox)).toEqual(
      overlayPixels((canvas) => {
        drawPixelText(canvas, "28", 41, 0, [255, 255, 255], 1, 1);
        canvas.fillRect(49, 0, 2, 2, [255, 255, 255]);
      }, chipBox),
    );
  });

  test("spends the degree block on the extra digit for two-digit sub-zero temps", () => {
    // "-12" is 11px, the exact chip budget: the degree mark must yield, and the
    // text still may not cross the 2px gutter (columns 38-39) into the time.
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: -12 }).frames[0]!;
    const chipBox = { x: 38, y: 0, width: 14, height: 5 };
    expect(inkPixels(frame, VIEWFINDER_INK, chipBox)).toEqual(
      overlayPixels((canvas) => drawPixelText(canvas, "-12", 40, 0, [255, 255, 255], 1, 1), chipBox),
    );
  });

  test("marks missing weather with an honest --° instead of a fabricated number", () => {
    const frame = renderViewfinderClock(1_000, NOW, {}).frames[0]!;
    const chipBox = { x: 38, y: 0, width: 14, height: 5 };
    expect(inkPixels(frame, VIEWFINDER_INK, chipBox)).toEqual(
      overlayPixels((canvas) => {
        drawPixelText(canvas, "--", 41, 0, [255, 255, 255], 1, 1);
        canvas.fillRect(49, 0, 2, 2, [255, 255, 255]);
      }, chipBox),
    );
  });

  test("draws the calendar glyph and M.DD date in the bottom-left chip", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28 }).frames[0]!;
    const dateBox = { x: 2, y: 11, width: 26, height: 5 };
    expect(inkPixels(frame, VIEWFINDER_INK, dateBox)).toEqual(
      overlayPixels((canvas) => {
        const glyph = [".#.#.", "#####", "#...#", "#.#.#", "#####"];
        for (let row = 0; row < 5; row += 1) {
          for (let column = 0; column < 5; column += 1) {
            if (glyph[row]![column] === "#") canvas.setPixel(2 + column, 11 + row, [255, 255, 255]);
          }
        }
        drawPixelText(canvas, "8.13", 8, 11, [255, 255, 255], 1, 1);
      }, dateBox),
    );
  });

  test("keeps every element out of the shared gutters even at worst-case widths", () => {
    // Dec 31 23:59 with -12°C is the widest state this face can produce:
    // "12.31" in the date chip and an 11px temperature. The layout only works
    // because columns 38-39 (full height) and columns 7-12 above the date band
    // stay untouched field — this is the collision budget, asserted directly.
    const worst = renderViewfinderClock(
      1_000,
      new Date(2026, 11, 31, 23, 59, 0).getTime(),
      { temperatureC: -12 },
    ).frames[0]!;
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      expect(worst.getPixel(38, y)).toEqual(VIEWFINDER_FIELD);
      expect(worst.getPixel(39, y)).toEqual(VIEWFINDER_FIELD);
    }
    for (let y = 0; y <= 10; y += 1) {
      for (let x = 7; x <= 12; x += 1) expect(worst.getPixel(x, y)).toEqual(VIEWFINDER_FIELD);
    }
    // The widest date ends at x=26; the run up to the bottom-right bracket
    // (vertical arm at x=50, horizontal arm from x=45 on row 14) stays clear.
    for (let y = 11; y <= 15; y += 1) {
      for (let x = 27; x <= 44; x += 1) expect(worst.getPixel(x, y)).toEqual(VIEWFINDER_FIELD);
    }
  });

  test("shows the weather-effect style notice frame when configuration is missing", () => {
    const animation = renderViewfinderClock(5_000, NOW, { weatherNotice: "未配置" });
    expect(animation.frames).toHaveLength(1);
    expect(animation.frameDelaysMs).toEqual([5_000]);
    expect(animation.label).toBe("取景框钟 · 未配置");
    const expected = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    drawCjkText(
      expected,
      "未配置",
      Math.floor((DISPLAY_WIDTH - cjkTextWidth("未配置")) / 2),
      2,
      [255, 176, 32],
    );
    expect(animation.frames[0]!.pixels).toEqual(expected.pixels);
  });
});
