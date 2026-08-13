import { describe, expect, test } from "bun:test";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas, type Rgb } from "../src/pixel-ui.ts";
import { drawPixelText } from "../src/pixel-font.ts";
import { cjkTextWidth, drawCjkText } from "../src/pixel-cjk.ts";
import type { VisualAnimation } from "../src/visual-effects.ts";
import {
  renderViewfinderClock,
  VIEWFINDER_COLON_SOFT,
  VIEWFINDER_FIELD,
  VIEWFINDER_INK,
} from "../src/visual/viewfinder.ts";

// Local-time construction keeps the expected HH:MM and day stable in any zone.
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
    // Bottom-right L, the 180° rotation of it.
    for (let x = 45; x <= 50; x += 1) expect(frame.getPixel(x, 14)).toEqual(VIEWFINDER_INK);
    for (let y = 10; y <= 14; y += 1) expect(frame.getPixel(50, y)).toEqual(VIEWFINDER_INK);
  });

  test("draws a 12-row digit, and rows 0 and 15 stay pure field", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28 }).frames[0]!;
    // 09:18 — the leading "0" sits at x=11. Its bitmap is spelled out here
    // rather than imported so the test fails if the glyph table is edited,
    // which is the only way an assertion about a font means anything.
    const zero = [
      ".####.", "######", "##..##", "##..##", "##..##", "##..##",
      "##..##", "##..##", "##..##", "##..##", "######", ".####.",
    ];
    expect(zero).toHaveLength(12);
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        expect(frame.getPixel(11 + column, 2 + row))
          .toEqual(zero[row]![column] === "#" ? VIEWFINDER_INK : VIEWFINDER_FIELD);
      }
    }
    // The time is the full height of the composition minus one row of air at
    // each edge — that margin is what the inset brackets need to read as a frame.
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      expect(frame.getPixel(x, 0)).toEqual(VIEWFINDER_FIELD);
      expect(frame.getPixel(x, 15)).toEqual(VIEWFINDER_FIELD);
    }
  });

  test("breathes the colon on the panel's centre seam instead of blinking it", () => {
    const animation = renderViewfinderClock(4_000, NOW, { temperatureC: 28 });
    const dots = [[25, 5], [26, 5], [25, 6], [26, 6], [25, 9], [26, 9], [25, 10], [26, 10]] as const;
    for (const [x, y] of dots) {
      expect(animation.frames[0]!.getPixel(x, y)).toEqual(VIEWFINDER_INK);
      expect(animation.frames[1]!.getPixel(x, y)).toEqual(VIEWFINDER_COLON_SOFT);
      expect(animation.frames[2]!.getPixel(x, y)).toEqual(VIEWFINDER_INK);
    }
    // Only the colon moves: the digits are byte-identical between the two
    // phases, so the breath cannot be mistaken for the time changing.
    const timeBox = { x: 11, y: 2, width: 30, height: 12 };
    const digitsOnly = (frame: PixelCanvas) =>
      inkPixels(frame, VIEWFINDER_INK, timeBox).filter((at) => {
        const [x, y] = at.split(",").map(Number);
        return !(x! >= 25 && x! <= 26);
      });
    expect(digitsOnly(animation.frames[1]!)).toEqual(digitsOnly(animation.frames[0]!));
  });

  test("right-aligns the temperature and hangs its degree mark above the number", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28.4 }).frames[0]!;
    // The whole right margin, from the digit gutter to the panel edge, above
    // the bottom-right bracket.
    const chipBox = { x: 41, y: 0, width: 11, height: 10 };
    expect(inkPixels(frame, VIEWFINDER_INK, chipBox)).toEqual(
      overlayPixels((canvas) => {
        drawPixelText(canvas, "28", 43, 4, [255, 255, 255], 1, 1);
        canvas.fillRect(48, 1, 2, 2, [255, 255, 255]);
      }, chipBox),
    );
  });

  test("lifts the minus beside the degree mark rather than dropping a digit", () => {
    // "-12" is 11px and the number line holds 7. The sign goes aloft; the two
    // digits stay, because a temperature missing its sign is worse than one
    // whose sign moved.
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: -12 }).frames[0]!;
    const chipBox = { x: 41, y: 0, width: 11, height: 10 };
    expect(inkPixels(frame, VIEWFINDER_INK, chipBox)).toEqual(
      overlayPixels((canvas) => {
        drawPixelText(canvas, "12", 43, 4, [255, 255, 255], 1, 1);
        canvas.fillRect(48, 1, 2, 2, [255, 255, 255]);
        canvas.fillRect(43, 1, 3, 2, [255, 255, 255]);
      }, chipBox),
    );
  });

  test("marks missing weather with an honest -- instead of a fabricated number", () => {
    const frame = renderViewfinderClock(1_000, NOW, {}).frames[0]!;
    const chipBox = { x: 41, y: 0, width: 11, height: 10 };
    expect(inkPixels(frame, VIEWFINDER_INK, chipBox)).toEqual(
      overlayPixels((canvas) => {
        drawPixelText(canvas, "--", 43, 4, [255, 255, 255], 1, 1);
        canvas.fillRect(48, 1, 2, 2, [255, 255, 255]);
      }, chipBox),
    );
    // An off-planet reading is unknown, not clipped.
    const absurd = renderViewfinderClock(1_000, NOW, { temperatureC: 250 }).frames[0]!;
    expect(inkPixels(absurd, VIEWFINDER_INK, chipBox))
      .toEqual(inkPixels(frame, VIEWFINDER_INK, chipBox));
  });

  test("puts the bare day number in the bottom-left corner", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28 }).frames[0]!;
    const dateBox = { x: 0, y: 8, width: 10, height: 8 };
    expect(inkPixels(frame, VIEWFINDER_INK, dateBox)).toEqual(
      overlayPixels((canvas) => drawPixelText(canvas, "13", 2, 9, [255, 255, 255], 1, 1), dateBox),
    );
    // Unpadded, so a single-digit day is narrower rather than zero-prefixed.
    const ninth = renderViewfinderClock(
      1_000, new Date(2026, 7, 9, 9, 18, 0).getTime(), { temperatureC: 28 },
    ).frames[0]!;
    expect(inkPixels(ninth, VIEWFINDER_INK, dateBox)).toEqual(
      overlayPixels((canvas) => drawPixelText(canvas, "9", 2, 9, [255, 255, 255], 1, 1), dateBox),
    );
  });

  test("keeps both gutters clear of ink even at the widest state", () => {
    // Dec 31 23:59 at -12°C is the widest this face gets: a two-digit day, a
    // sign aloft, and the four widest-stroked digits. Columns 9-10 and 41-42
    // are the collision budget between the time and the two chips, and they
    // are asserted directly because the layout has no slack anywhere else.
    const worst = renderViewfinderClock(
      1_000,
      new Date(2026, 11, 31, 23, 59, 0).getTime(),
      { temperatureC: -12 },
    ).frames[0]!;
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (const x of [9, 10, 41, 42]) {
        expect(worst.getPixel(x, y)).toEqual(VIEWFINDER_FIELD);
      }
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
