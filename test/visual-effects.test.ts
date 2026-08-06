import { describe, expect, test } from "bun:test";
import { DISPLAY_WIDTH } from "../src/pixel-ui.ts";
import { measurePixelText } from "../src/pixel-font.ts";
import { renderVisualEffect } from "../src/visual-effects.ts";

describe("visual effects", () => {
  test("matrix clock does not cover the rain with a green time backing panel", () => {
    const animation = renderVisualEffect(
      "matrixclock",
      1_000,
      Date.parse("2026-08-07T00:36:00Z"),
    );

    const labelWidth = measurePixelText("00:36", 2, 2);
    const labelX = Math.floor((DISPLAY_WIDTH - labelWidth) / 2);
    let backingPixelCount = 0;
    let dimmedRainPixelCount = 0;

    for (const frame of animation.frames) {
      for (let y = 0; y < frame.height; y += 1) {
        for (let x = 0; x < frame.width; x += 1) {
          const [red, green, blue] = frame.getPixel(x, y);
          if (red === 0 && green === 8 && blue === 0) backingPixelCount += 1;
          const insideTimeArea = x >= labelX - 1
            && x < labelX + labelWidth + 1
            && y >= 2
            && y < 14;
          if (insideTimeArea && red > 0 && green > red && blue > 0) {
            dimmedRainPixelCount += 1;
          }
        }
      }
    }

    expect(backingPixelCount).toBe(0);
    expect(dimmedRainPixelCount).toBeGreaterThan(0);
  });
});
