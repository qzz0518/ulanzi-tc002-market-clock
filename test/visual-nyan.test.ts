import { describe, expect, test } from "bun:test";
import {
  NYAN_CAT_X,
  NYAN_HEAD,
  NYAN_RAINBOW,
  NYAN_RAINBOW_RIGHT,
  NYAN_RAINBOW_TOP,
  NYAN_SPRITE_HEIGHT,
  NYAN_SPRITE_WIDTH,
  NYAN_STRIPE_HEIGHT,
  NYAN_TART,
  nyanWaveOffset,
  renderNyan,
} from "../src/visual/nyan.ts";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, type PixelCanvas, type Rgb } from "../src/pixel-ui.ts";

const CRUST: Rgb = [255, 201, 132];

function samePixel(actual: Rgb, expected: Rgb): boolean {
  return actual[0] === expected[0] && actual[1] === expected[1] && actual[2] === expected[2];
}

function isRainbow(color: Rgb): boolean {
  return NYAN_RAINBOW.some((stripe) => samePixel(color, stripe));
}

/** First row of a column painted with the top stripe, or -1 when unpainted. */
function trailTop(frame: PixelCanvas, x: number): number {
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    if (samePixel(frame.getPixel(x, y), NYAN_RAINBOW[0]!)) return y;
  }
  return -1;
}

/**
 * The tart's lower crust row — the only one that survives whole, since the head
 * is drawn over the upper one. It sits eight rows into the sprite, so the tests
 * read the cat's position out of the frame instead of recomputing the scroll
 * arithmetic they are meant to be checking.
 */
const CRUST_ROW_IN_SPRITE = 8;

function crustRow(frame: PixelCanvas): number {
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    let run = 0;
    for (let x = NYAN_CAT_X + 4; x <= NYAN_CAT_X + 12; x += 1) {
      if (samePixel(frame.getPixel(x, y), CRUST)) run += 1;
    }
    if (run === 9) return y;
  }
  return -1;
}

describe("nyan cat sprite", () => {
  test("the sprite fits the panel at both wave heights", () => {
    // The wave adds a row, so the sprite has to clear the bottom edge from its
    // LOW position and the right edge from its only one.
    expect(NYAN_CAT_X + NYAN_SPRITE_WIDTH).toBeLessThanOrEqual(DISPLAY_WIDTH);
    expect(NYAN_RAINBOW_TOP + 1 + NYAN_SPRITE_HEIGHT).toBeLessThanOrEqual(DISPLAY_HEIGHT);
    expect(NYAN_RAINBOW.length * NYAN_STRIPE_HEIGHT + NYAN_RAINBOW_TOP + 1)
      .toBeLessThanOrEqual(DISPLAY_HEIGHT);
  });

  test("each eye keeps its own black instead of borrowing the outline", () => {
    // The regression this pins: eyes drawn hard against the outline columns
    // merge into it, leaving two white pupils floating on grey — slot eyes, not
    // a cat. Both eye rows must therefore start and end on grey.
    for (const row of [NYAN_HEAD[2]!, NYAN_HEAD[3]!]) {
      expect(row[1]).toBe("g");
      expect(row[7]).toBe("g");
      expect(row).toHaveLength(NYAN_HEAD[0]!.length);
    }
    // One white pupil per eye, both on the upper row.
    expect([...NYAN_HEAD[2]!].filter((cell) => cell === "w")).toHaveLength(2);
    expect(NYAN_HEAD[3]).not.toContain("w");
  });

  test("the tart is a closed ring of crust around the filling", () => {
    expect(NYAN_TART).toHaveLength(9);
    for (const row of NYAN_TART) expect(row).toHaveLength(11);
    // No sprinkle ever touches the crust: a dot on the ring reads as a hole in
    // the pastry rather than sugar on it.
    for (const row of NYAN_TART) {
      expect(row.indexOf("d")).not.toBe(1);
      expect(row.lastIndexOf("d")).not.toBe(9);
    }
    expect(NYAN_TART[0]).not.toContain("d");
    expect(NYAN_TART.at(-1)).not.toContain("d");
  });
});

describe("nyan cat animation", () => {
  test("holds the original's 12 fps and still spends the whole item", () => {
    const animation = renderNyan(10_000);
    expect(animation.frames).toHaveLength(118);
    expect(animation.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(10_000);
    expect(animation.frameDelaysMs[0]).toBeGreaterThanOrEqual(80);
    expect(animation.frameDelaysMs[0]).toBeLessThanOrEqual(90);
    expect(animation.label).toBe("彩虹猫");
  });

  test("caps frames the way every other visual does", () => {
    const long = renderNyan(120_000);
    expect(long.frames).toHaveLength(120);
    expect(long.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(120_000);
    expect(long.frames.every((frame) => frame.width === 52 && frame.height === 16)).toBe(true);
  });

  test("renders the same frames twice — nothing here is seeded", () => {
    const first = renderNyan(3_000);
    const second = renderNyan(3_000);
    for (let index = 0; index < first.frames.length; index += 1) {
      expect(first.frames[index]!.pixels).toEqual(second.frames[index]!.pixels);
    }
  });

  test("the trail is the 2011 six-colour order, two rows per stripe", () => {
    const frame = renderNyan(3_000).frames[0]!;
    const top = trailTop(frame, 0);
    expect(top).toBeGreaterThanOrEqual(NYAN_RAINBOW_TOP);
    for (let stripe = 0; stripe < NYAN_RAINBOW.length; stripe += 1) {
      for (let dy = 0; dy < NYAN_STRIPE_HEIGHT; dy += 1) {
        const pixel = frame.getPixel(0, top + stripe * NYAN_STRIPE_HEIGHT + dy);
        expect(samePixel(pixel, NYAN_RAINBOW[stripe]!)).toBe(true);
      }
    }
  });

  test("the staircase only ever takes two heights, one row apart", () => {
    for (const frame of renderNyan(3_000).frames) {
      const heights = new Set<number>();
      for (let x = 0; x < NYAN_RAINBOW_RIGHT; x += 1) heights.add(trailTop(frame, x));
      expect(heights.has(-1)).toBe(false);
      const sorted = [...heights].sort((a, b) => a - b);
      expect(sorted).toEqual([NYAN_RAINBOW_TOP, NYAN_RAINBOW_TOP + 1]);
    }
  });

  test("the cat rides the wave instead of being dragged in front of it", () => {
    // Cat and trail share a top row by construction. If the bob ever desyncs
    // from the staircase the cat detaches from its own trail, which is the
    // whole illusion.
    for (const frame of renderNyan(3_000).frames) {
      const crust = crustRow(frame);
      expect(crust).toBeGreaterThan(0);
      expect(crust).toBe(trailTop(frame, NYAN_CAT_X) + CRUST_ROW_IN_SPRITE);
    }
  });

  test("no rainbow pixel escapes past the tart", () => {
    // A stripe to the right of the cat means the cat is flying backwards. The
    // rows above and below the tart are where leaks show up, because the sprite
    // is only opaque across the 9 rows in between.
    for (const frame of renderNyan(3_000).frames) {
      for (let x = NYAN_RAINBOW_RIGHT; x < DISPLAY_WIDTH; x += 1) {
        for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
          expect(isRainbow(frame.getPixel(x, y))).toBe(false);
        }
      }
    }
  });

  test("the legs trot", () => {
    // Poses alternate every other frame, so two frames one pose apart must
    // differ in the two rows under the tart even after the bob is taken out.
    const frames = renderNyan(3_000).frames;
    const legs = (index: number): string => {
      const frame = frames[index]!;
      const base = crustRow(frame) + 2;
      const cells: string[] = [];
      for (let y = base; y < base + 2; y += 1) {
        for (let x = NYAN_CAT_X + 3; x <= NYAN_CAT_X + 15; x += 1) {
          cells.push(frame.getPixel(x, y).join(","));
        }
      }
      return cells.join("|");
    };
    expect(legs(0)).not.toBe(legs(2));
    expect(legs(0)).toBe(legs(1));
  });

  test("the wave offset is a clean two-step, never negative", () => {
    for (let scroll = 0; scroll < 24; scroll += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        expect([0, 1]).toContain(nyanWaveOffset(x, scroll));
      }
    }
    // Scrolling by one full segment inverts every column's step.
    expect(nyanWaveOffset(0, 0)).not.toBe(nyanWaveOffset(0, 4));
    expect(nyanWaveOffset(0, 0)).toBe(nyanWaveOffset(0, 8));
  });
});
