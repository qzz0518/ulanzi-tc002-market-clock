import { describe, expect, test } from "bun:test";
import { dominantColorFromPixels } from "../web/src/lib/cover-tint.ts";

/** Builds an RGBA buffer from a list of [r,g,b,count] runs. */
function pixels(...runs: Array<[number, number, number, number]>): Uint8ClampedArray {
  const total = runs.reduce((sum, run) => sum + run[3], 0);
  const out = new Uint8ClampedArray(total * 4);
  let at = 0;
  for (const [red, green, blue, count] of runs) {
    for (let index = 0; index < count; index += 1) {
      out[at] = red;
      out[at + 1] = green;
      out[at + 2] = blue;
      out[at + 3] = 255;
      at += 4;
    }
  }
  return out;
}

function channels(rgb: string): number[] {
  return rgb.split(/\s+/).map(Number);
}

describe("cover tint", () => {
  test("returns the colour a person would name, not the average", () => {
    // Three quarters mid-grey, one quarter strong red. A flat mean lands on a
    // dull pink; weighting by saturation keeps the red the sleeve is actually
    // known by. This is the whole reason the function is not an average.
    const [red, green, blue] = channels(
      dominantColorFromPixels(pixels([128, 128, 128, 300], [220, 30, 30, 100])).rgb,
    );
    expect(red!).toBeGreaterThan(green! + 40);
    expect(red!).toBeGreaterThan(blue! + 40);
  });

  test("ignores the near-black and near-white that every cover has", () => {
    // Letterboxing and blown highlights are present in most artwork and carry
    // no identity; counting them drags any tint towards grey.
    const framed = dominantColorFromPixels(
      pixels([0, 0, 0, 400], [255, 255, 255, 400], [40, 90, 200, 100]),
    );
    const bare = dominantColorFromPixels(pixels([40, 90, 200, 100]));
    expect(framed.rgb).toBe(bare.rgb);
  });

  test("reports darkness so the panel can lean on its border instead of colour", () => {
    expect(dominantColorFromPixels(pixels([30, 40, 70, 100])).dark).toBe(true);
    expect(dominantColorFromPixels(pixels([225, 205, 160, 100])).dark).toBe(false);
  });

  test("a fully grey cover still yields its own grey rather than dividing by zero", () => {
    // Saturation is 0 for every pixel here, so the +0.12 floor is what keeps
    // this from being 0/0 and silently falling back to the theme's grey.
    const tint = dominantColorFromPixels(pixels([150, 150, 150, 200]));
    expect(channels(tint.rgb)).toEqual([150, 150, 150]);
  });

  test("falls back rather than throwing when nothing is countable", () => {
    expect(dominantColorFromPixels(new Uint8ClampedArray(0)).rgb).toBe("120 120 120");
    // All transparent, and all outside the luma window: both must survive.
    expect(dominantColorFromPixels(new Uint8ClampedArray(64)).rgb).toBe("120 120 120");
    expect(dominantColorFromPixels(pixels([255, 255, 255, 50])).rgb).toBe("120 120 120");
  });

  test("never emits a channel outside 0-255", () => {
    const tint = dominantColorFromPixels(pixels([231, 12, 4, 40], [40, 231, 12, 40]));
    for (const channel of channels(tint.rgb)) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });
});
