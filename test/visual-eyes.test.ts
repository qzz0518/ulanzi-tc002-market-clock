import { describe, expect, test } from "bun:test";
import {
  EYES_CYCLE_MS,
  eyeCycleScale,
  eyeExtentAt,
  eyePoseAt,
  renderEyeFrame,
  renderEyes,
  roundedBoxCoverage,
  type EyeShape,
} from "../src/visual/eyes.ts";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, type PixelCanvas } from "../src/pixel-ui.ts";

const CAPSULE: EyeShape = {
  halfW: 3.5,
  halfH: 6.2,
  radius: 3.5,
  tiltDeg: 0,
  brow: { alpha: 0, offsetY: 5, halfW: 3.6, halfH: 0.6, tiltDeg: 0 },
};

/** Brightest pixel in a frame, 0..255 on the red channel. */
function peak(frame: PixelCanvas): number {
  let best = 0;
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) best = Math.max(best, frame.getPixel(x, y)[0]);
  }
  return best;
}

/** How many rows have anything lit in them — a blink collapses this to one or two. */
function litRows(frame: PixelCanvas): number {
  let rows = 0;
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      if (frame.getPixel(x, y)[0] > 0) { rows += 1; break; }
    }
  }
  return rows;
}

describe("the rounded-box rasteriser", () => {
  test("coverage is a real distance, not a hit test", () => {
    // Dead centre is fully lit, well outside is dark, and a sample sitting
    // exactly on the edge is half — that ramp IS the anti-aliasing, and it is
    // the reason a 7x12 capsule reads as curved instead of as a hexagon.
    expect(roundedBoxCoverage(0, 0, CAPSULE)).toBe(1);
    expect(roundedBoxCoverage(0, 20, CAPSULE)).toBe(0);
    expect(roundedBoxCoverage(0, CAPSULE.halfH, CAPSULE)).toBeCloseTo(0.5, 5);
    expect(roundedBoxCoverage(CAPSULE.halfW, 0, CAPSULE)).toBeCloseTo(0.5, 5);
  });

  test("the corner is empty, which is the whole point of the shape", () => {
    // The square corner of the bounding box. A plain rectangle would light it
    // fully; a capsule must not light it at all, and if this ever passes for a
    // rectangle the eyes have quietly become bricks.
    expect(roundedBoxCoverage(CAPSULE.halfW, CAPSULE.halfH, CAPSULE)).toBe(0);
    // Half-way down the straight flank is still solid, so the roundness is at
    // the ends rather than everywhere.
    expect(roundedBoxCoverage(0, CAPSULE.halfH - 2, CAPSULE)).toBe(1);
  });

  test("a tilt rotates the shape rather than shearing it", () => {
    const bar: EyeShape = { ...CAPSULE, halfW: 4, halfH: 0.6, radius: 0.6, tiltDeg: 45 };
    // A point 45 degrees off along the bar's own axis is inside it; the same
    // distance the other way is not. 1.5 rather than something nearer the tip:
    // out at the rounded end the coverage is legitimately just under 1, and a
    // test that pins the exact value there is testing the corner radius, not
    // the rotation.
    const step = 1.5;
    expect(roundedBoxCoverage(step, step, bar)).toBe(1);
    expect(roundedBoxCoverage(step, -step, bar)).toBe(0);
  });
});

describe("the expression script", () => {
  test("the cycle joins itself, pose and pixels alike", () => {
    // The whole duration-fitting scheme below rests on this: the script is
    // stretched to a whole number of cycles precisely because its first frame
    // and its last are the same frame. The sway underneath had to be counted in
    // cycles rather than milliseconds to make it true — a millisecond-based
    // sine is not periodic here, and it teleported a third of a pixel at the
    // seam, on every anti-aliased edge at once, forever.
    expect(eyePoseAt(EYES_CYCLE_MS)).toEqual(eyePoseAt(0));
    expect(renderEyeFrame(EYES_CYCLE_MS).pixels).toEqual(renderEyeFrame(0).pixels);
    // And it keeps joining, so a long item running several cycles has no seam
    // at any of them.
    expect(renderEyeFrame(EYES_CYCLE_MS * 3).pixels).toEqual(renderEyeFrame(0).pixels);
  });

  test("a blink shuts faster than it opens", () => {
    // Lids fall and are lifted. Matching the two halves is what makes an
    // animated blink read as a flicker in the signal rather than as a face.
    const openHeight = eyePoseAt(820).left.halfH;
    const shutHeight = eyePoseAt(940).left.halfH;
    expect(shutHeight).toBeLessThan(openHeight / 3);

    // Half-way through the closing segment it is already most of the way shut;
    // half-way through the opening segment it is not yet most of the way open.
    const closing = eyePoseAt(860).left.halfH;
    const opening = eyePoseAt(1080).left.halfH;
    expect(closing).toBeLessThan(openHeight / 2);
    expect(opening).toBeLessThan(openHeight * 0.7);
  });

  test("a gaze change is ballistic, not a glide", () => {
    // A real saccade is 30-80 ms. Easing one smoothly across half a second is
    // the single thing that makes an animated face look like a screensaver, so
    // the segment has to spend most of its travel in its first half.
    const start = eyePoseAt(1560).gazeX;
    const end = eyePoseAt(2280).gazeX;
    const half = eyePoseAt(1610).gazeX;
    expect(start).toBe(0);
    expect(end).toBe(-5);
    expect(Math.abs(half - start) / Math.abs(end - start)).toBeGreaterThan(0.75);
  });

  test("the pair looks both ways, and the far eye narrows when it does", () => {
    const left = eyePoseAt(2000);
    const right = eyePoseAt(2800);
    expect(left.gazeX).toBeLessThan(-4);
    expect(right.gazeX).toBeGreaterThan(4);
    // Looking left, the LEFT eye is the far one and foreshortens. One pixel of
    // it is enough to stop the pair reading as a rigid mask bolted to a face.
    expect(left.left.halfW).toBeLessThan(left.right.halfW);
    expect(right.right.halfW).toBeLessThan(right.left.halfW);
  });

  test("brows exist only where there is an opinion, and they oppose each other", () => {
    // At rest there is no brow at all: a permanent brow is a drawn-on face, and
    // the expression here comes from the brow ARRIVING.
    expect(eyePoseAt(0).left.brow.alpha).toBe(0);
    expect(eyePoseAt(2000).left.brow.alpha).toBe(0);

    const sulk = eyePoseAt(7400);
    expect(sulk.left.brow.alpha).toBe(1);
    expect(sulk.right.brow.alpha).toBe(1);
    // Opposite tilts. Two lines leaning the same way are a sleep mask, not a
    // face — and the sign matters: inner ends high is the reference's sulk,
    // inner ends low would be a glare.
    expect(sulk.left.brow.tiltDeg).toBeLessThan(0);
    expect(sulk.right.brow.tiltDeg).toBe(-sulk.left.brow.tiltDeg);
    // The eye under it hoods right down, because 16 rows do not hold a
    // full-height eye AND a brow above it.
    expect(sulk.left.halfH).toBeLessThan(eyePoseAt(0).left.halfH / 2);
  });

  test("a blink is the whole face going flat, not the eyes going out", () => {
    const open = renderEyeFrame(820);
    const shut = renderEyeFrame(940);
    expect(litRows(open)).toBeGreaterThan(10);
    expect(litRows(shut)).toBeLessThanOrEqual(3);
    // Still bright: the lids close, the panel does not dim. This is what forced
    // the shut bar to 1.8 px — the eye centre lands on a pixel boundary, so a
    // thinner one splits across two rows at 70% each and the blink reads as the
    // eye fading out instead of shutting.
    expect(peak(shut)).toBeGreaterThan(peak(open) * 0.85);
  });
});

describe("fitting the panel and the item", () => {
  test("nothing is ever sliced by an edge", () => {
    // The failure this guards cannot be seen in a still: a capsule pushed past
    // the panel does not fade off, it gets its rounded end cut flat, and one
    // flat end stops the pair reading as eyes. Sizes, gaze range and drift are
    // all chosen backwards from this assertion.
    for (let ms = 0; ms < EYES_CYCLE_MS; ms += 10) {
      const extent = eyeExtentAt(ms);
      expect(extent.minX).toBeGreaterThanOrEqual(0);
      expect(extent.maxX).toBeLessThanOrEqual(DISPLAY_WIDTH);
      expect(extent.minY).toBeGreaterThanOrEqual(0);
      expect(extent.maxY).toBeLessThanOrEqual(DISPLAY_HEIGHT);
    }
  });

  test("the outermost rows stay dark, so the eye's ends are always round", () => {
    for (let ms = 0; ms < EYES_CYCLE_MS; ms += 40) {
      const frame = renderEyeFrame(ms);
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        expect(frame.getPixel(x, 0)[0]).toBe(0);
        expect(frame.getPixel(x, DISPLAY_HEIGHT - 1)[0]).toBe(0);
      }
    }
  });

  test("an item runs a whole number of cycles, whatever its duration", () => {
    // A 9.2 s script inside a 10 s item leaves 800 ms of a second cycle and the
    // GIF restarts mid-blink. Stretching to whole cycles costs at most a
    // quarter of the natural speed and buys a seam nobody can see.
    for (const durationMs of [3_000, 8_000, 10_000, 15_000, 30_000, 60_000]) {
      for (const speed of [0.5, 1, 2]) {
        const cycles = (durationMs * eyeCycleScale(durationMs, speed)) / EYES_CYCLE_MS;
        expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(1e-9);
        expect(cycles).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("a short item still gets one whole cycle rather than a fragment", () => {
    // Rounding to zero cycles would divide by zero, and rounding down would
    // show a face that only ever blinks. One cycle sped up is the honest answer.
    const scale = eyeCycleScale(1_000, 1);
    expect((1_000 * scale) / EYES_CYCLE_MS).toBe(1);
  });

  test("the frames add up to exactly the duration asked for", () => {
    for (const durationMs of [4_000, 10_000, 33_333]) {
      const animation = renderEyes(durationMs);
      expect(animation.frames.length).toBe(animation.frameDelaysMs.length);
      expect(animation.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(durationMs);
      expect(animation.frames.length).toBeLessThanOrEqual(120);
      expect(animation.label).toBe("一对眼睛");
    }
  });

  test("the face is never blank, at any moment of the cycle", () => {
    // Every pose lights something. A pose that renders empty would read as the
    // channel having crashed, and the closed-eye poses are exactly the ones
    // where an off-by-one in the rasteriser would produce it.
    for (let ms = 0; ms < EYES_CYCLE_MS; ms += 25) {
      expect(peak(renderEyeFrame(ms))).toBeGreaterThan(0);
    }
  });
});
