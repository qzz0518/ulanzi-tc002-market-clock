import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas, type Rgb } from "../pixel-ui.ts";
import type { VisualAnimation } from "../visual-effects.ts";

/**
 * 彩虹猫 — Nyan Cat, held to the 2011 sprite rather than a rainbow-coloured cat.
 *
 * The source animation is a 34x21 logical grid drawn at 8x. This panel is
 * 52x16, so the width is generous and the HEIGHT is the whole design problem:
 * six 2px rainbow stripes are 12 of the 16 rows before a single cat pixel is
 * placed, and the stripes cannot go to 1px — at LED scale adjacent 1px stripes
 * bloom into each other and the rainbow reads as one smeared band, which is the
 * one thing this effect cannot afford to lose.
 *
 * So the vertical budget is spent as 12 rows of rainbow, a cat exactly as tall,
 * and stars only in the rows the rainbow leaves. The cat is aligned one row
 * ABOVE the rainbow so the tart centres on the stripes and the ears clear the
 * top edge — the silhouette people recognise from across a room is ears-plus-
 * trail, not the face, which at 9px wide is four pixels of eye.
 *
 * Ground is a dim navy rather than black. The original's field is #003366 and
 * black outlines are load-bearing on this sprite — every edge in the reference
 * art is outlined — but an outline only exists if the ground it sits on is lit.
 * At ~4% of full white across 832 LEDs the navy costs about as much light as
 * the stars do and buys back every outline that isn't overlapping the rainbow.
 */

// Reference-art colours, read off the 2011 sprite. The greys and the pink pair
// are the identity of the character; only the navy is ours (see above).
const OUTLINE: Rgb = [0, 0, 0];
const GROUND: Rgb = [0, 12, 32];
const STAR: Rgb = [255, 255, 255];

const NYAN_INKS: Readonly<Record<string, Rgb>> = {
  k: OUTLINE,
  // Pop-Tart: tan crust ring, pink filling, hot-pink sprinkles.
  c: [255, 201, 132],
  p: [255, 153, 204],
  d: [255, 51, 153],
  // Cat: mid grey body, white pupils, pink cheeks.
  g: [153, 153, 153],
  w: [255, 255, 255],
  r: [255, 153, 187],
};

/**
 * The tart, 11x9, drawn from the outside in: black outline with clipped
 * corners, one ring of crust, then filling. That leaves a 7x5 interior, which
 * is exactly enough for two staggered rows of sprinkles — a single row reads as
 * a stripe and three rows fill the pink in solid.
 */
export const NYAN_TART: readonly string[] = [
  ".kkkkkkkkk.",
  "kccccccccck",
  "kcpppppppck",
  "kcpdppdppck",
  "kcpppppppck",
  "kcppdppdpck",
  "kcpppppppck",
  "kccccccccck",
  ".kkkkkkkkk.",
];

/**
 * The head, 9x8, drawn over the tart's upper right so the outline cuts into the
 * filling the way it does in the reference art.
 *
 * The 7px interior is spent 1-2-1-2-1: a grey margin, an eye, the bridge,
 * an eye, a grey margin. Both margins are load-bearing. The first cut of this
 * face let the eyes run into the outline columns, and the black halves merged
 * with the outline — leaving two white pupils floating on grey, which reads as
 * a robot with slot eyes, not a cat. An eye needs its own black to sit in, and
 * that costs the two columns.
 */
export const NYAN_HEAD: readonly string[] = [
  ".k.....k.",
  "kgkkkkkgk",
  "kgkwgwkgk",
  "kgkkgkkgk",
  "kgggggggk",
  "krgkkkgrk",
  "kgggggggk",
  ".kkkkkkk.",
];

// Sprite-space geometry. The bounding box is 20x12: tail, then tart, then a
// head that overlaps it by three columns.
export const NYAN_SPRITE_WIDTH = 20;
export const NYAN_SPRITE_HEIGHT = 12;
const TART_X = 3;
const TART_Y = 1;
const HEAD_X = 11;
const HEAD_Y = 0;

// Four legs under the tart, 2px wide, no outline of their own — an outlined leg
// would be 4px wide and the four of them would fill the tart's whole underside.
const LEG_X = [4, 7, 10, 13] as const;
const LEG_Y = 10;
// Leg length per pose, one entry per leg: 2 is planted, 1 is lifted. Two poses
// alternating on the wave beat is the trot; more poses at this size is motion
// nobody can resolve.
const LEG_POSES: readonly (readonly number[])[] = [
  [2, 1, 2, 1],
  [1, 2, 1, 2],
];

// Tail pixels per pose, walking out from the tart's left outline at rows 5-6.
// The cycle is up / level / down / level so the tail sweeps rather than flicks.
// Two rows thick at the base and one at the tip: a 1px tail on a fully
// saturated trail reads as a dead pixel in the rainbow, and an even 3x2 block
// reads as a brick. The taper is what makes it a tail.
const TAIL_POSES: readonly (readonly (readonly [number, number])[])[] = [
  [[2, 4], [2, 5], [1, 3], [1, 4], [0, 3]],
  [[2, 5], [2, 6], [1, 5], [1, 6], [0, 5]],
  [[2, 6], [2, 7], [1, 7], [1, 8], [0, 8]],
  [[2, 5], [2, 6], [1, 5], [1, 6], [0, 6]],
];

export const NYAN_RAINBOW: readonly Rgb[] = [
  [255, 0, 0],
  [255, 153, 0],
  [255, 255, 0],
  [51, 255, 0],
  [0, 153, 255],
  [102, 51, 255],
];

export const NYAN_STRIPE_HEIGHT = 2;
/** Width of one step of the trail's staircase. */
export const NYAN_SEGMENT_WIDTH = 4;
/** Rainbow top row when the wave is down; the wave adds one. */
export const NYAN_RAINBOW_TOP = 2;
export const NYAN_CAT_X = 31;

// The trail stops one column short of the tart's black outline, so the outline
// is what the rainbow ends against. Running it further under the cat looks
// safe and is not: the tart is 11 columns of sprite but only 9 of them are
// opaque on the clipped corner rows and none of them are on the leg rows, so
// every extra column leaks stray rainbow pixels above and below the tart.
export const NYAN_RAINBOW_RIGHT = NYAN_CAT_X + TART_X;

// Stars live only in rows the 12-row rainbow leaves over, which is why they are
// authored as a fixed constellation instead of scattered randomly: at four
// usable rows, two stars landing on the same row four columns apart reads as a
// mistake, and a seed cannot promise it won't happen.
const STAR_ROWS = [0, 1, 14, 15] as const;
const STAR_SEEDS: readonly (readonly [number, number, number])[] = [
  // [x, row index, twinkle phase offset]
  [3, 0, 0],
  [12, 3, 2],
  [19, 1, 1],
  [27, 2, 3],
  [34, 0, 2],
  [41, 3, 0],
  [47, 1, 3],
];
const STAR_WRAP = DISPLAY_WIDTH + 6;

// Twinkle shapes, smallest first, as pixel offsets from the star's centre. The
// cycle runs 0-1-2-1 so a star grows and shrinks instead of popping.
const STAR_SHAPES: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0]],
  [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]],
  [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, 1], [-1, 1], [1, -1]],
  [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]],
];

// 85 ms is the original's 12 fps. The 120-frame cap is the same one every other
// visual honours; at the default 10 s item this lands at 118 frames, so the
// cadence survives untouched and only longer items stretch.
const FRAME_MS = 85;
const MAX_FRAMES = 120;
// Columns of trail per frame at speed 1. Two is half a segment, so the
// staircase steps on every other frame — fast enough to fly, slow enough that
// the step is a step and not a flicker.
const SCROLL_PER_FRAME = 2;

function framePlan(durationMs: number): number[] {
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(durationMs / FRAME_MS)));
  const base = Math.floor(durationMs / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? durationMs - base * (count - 1) : base
  );
}

function drawSprite(canvas: PixelCanvas, rows: readonly string[], x: number, y: number): void {
  for (let dy = 0; dy < rows.length; dy += 1) {
    const row = rows[dy]!;
    for (let dx = 0; dx < row.length; dx += 1) {
      const ink = NYAN_INKS[row[dx]!];
      if (ink) canvas.setPixel(x + dx, y + dy, ink);
    }
  }
}

/**
 * Which half of the staircase a column is on. The cat reads this at its own
 * position and bobs with it, which is what makes the cat look like it is riding
 * the trail rather than being dragged along in front of one.
 */
export function nyanWaveOffset(x: number, scroll: number): number {
  const segment = Math.floor((x + scroll) / NYAN_SEGMENT_WIDTH);
  return ((segment % 2) + 2) % 2;
}

function drawRainbow(canvas: PixelCanvas, scroll: number): void {
  for (let x = 0; x < NYAN_RAINBOW_RIGHT; x += 1) {
    const top = NYAN_RAINBOW_TOP + nyanWaveOffset(x, scroll);
    for (let stripe = 0; stripe < NYAN_RAINBOW.length; stripe += 1) {
      const color = NYAN_RAINBOW[stripe]!;
      for (let dy = 0; dy < NYAN_STRIPE_HEIGHT; dy += 1) {
        canvas.setPixel(x, top + stripe * NYAN_STRIPE_HEIGHT + dy, color);
      }
    }
  }
}

function drawStars(canvas: PixelCanvas, scroll: number, frameIndex: number): void {
  for (const [seedX, rowIndex, phaseOffset] of STAR_SEEDS) {
    const x = ((seedX - scroll) % STAR_WRAP + STAR_WRAP) % STAR_WRAP - 3;
    const y = STAR_ROWS[rowIndex]!;
    const shape = STAR_SHAPES[(Math.floor(frameIndex / 3) + phaseOffset) % STAR_SHAPES.length]!;
    for (const [dx, dy] of shape) canvas.setPixel(x + dx, y + dy, STAR);
  }
}

function drawCat(canvas: PixelCanvas, originY: number, pose: number): void {
  const x = NYAN_CAT_X;
  for (const [dx, dy] of TAIL_POSES[pose % TAIL_POSES.length]!) {
    canvas.setPixel(x + dx, originY + dy, NYAN_INKS.g!);
  }
  drawSprite(canvas, NYAN_TART, x + TART_X, originY + TART_Y);
  const legs = LEG_POSES[pose % LEG_POSES.length]!;
  for (let index = 0; index < LEG_X.length; index += 1) {
    for (let dy = 0; dy < legs[index]!; dy += 1) {
      canvas.setPixel(x + LEG_X[index]!, originY + LEG_Y + dy, NYAN_INKS.g!);
      canvas.setPixel(x + LEG_X[index]! + 1, originY + LEG_Y + dy, NYAN_INKS.g!);
    }
  }
  drawSprite(canvas, NYAN_HEAD, x + HEAD_X, originY + HEAD_Y);
}

export function renderNyan(durationMs: number, speed = 1): VisualAnimation {
  const delays = framePlan(durationMs);
  const frames = delays.map((_, frameIndex) => {
    const scroll = Math.round(frameIndex * SCROLL_PER_FRAME * speed);
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT, GROUND);
    drawStars(canvas, scroll, frameIndex);
    drawRainbow(canvas, scroll);
    // Cat and rainbow share a top row, which is what centres the 9-row tart on
    // the 12-row band and puts the tail's exit on the band's middle stripe. One
    // row higher looks better on paper — the ears clear the trail — but then
    // three stripes run out below the tart and the trail reads as attached to
    // the cat's feet.
    drawCat(canvas, NYAN_RAINBOW_TOP + nyanWaveOffset(NYAN_CAT_X, scroll), frameIndex >> 1);
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "彩虹猫" };
}
