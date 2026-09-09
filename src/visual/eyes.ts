import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas, type Rgb } from "../pixel-ui.ts";
import type { VisualAnimation } from "../visual-effects.ts";

/**
 * 一对眼睛 — a face that is two rounded rectangles and nothing else.
 *
 * Modelled on the M5Stack Stopwatch expression set the owner shared, and the
 * thing worth copying there is not the artwork: it is that the artwork does not
 * exist. Every expression is the SAME rounded box with different numbers —
 * width, height, corner radius, tilt, and where the pair is pointing. Sprite
 * sheets cannot blend, so a sprite face snaps between poses; a parametric one
 * gets every in-between for free, and the in-betweens are the whole illusion.
 *
 * THE SCOWL IS A BROW, NOT A TILTED EYE. Reading the reference at low
 * resolution it looks like the eye itself rotates; frame-stepped and zoomed it
 * is plainly two objects — a thin slanted line with an unrotated rounded box
 * sitting under it. That distinction is the whole expression. A rotated eye
 * reads as a head tilt, while a line above a level eye reads as an opinion, and
 * a brow can also fade in over an eye that stays put, which is what lets the
 * face get annoyed without appearing to move.
 *
 * WHY THE EDGES ARE NOT HARD. This repo is pixel art everywhere else and hard
 * edges are usually the point, but a 10x12 capsule quantised to whole pixels is
 * a staircase with four steps per side, and at LED scale a staircase reads as a
 * hexagon rather than a curve. So each pixel is lit by how much of it the shape
 * covers, computed from a signed distance field. The partial pixels along the
 * corners are what make the eye read as round, and they cost nothing: the panel
 * is RGB, it has the levels to spend.
 *
 * WHAT MAKES IT LOOK ALIVE, at the ~12 fps this panel's frame budget allows:
 *
 *   - Eyes do not drift, they JUMP. A gaze change is two frames and then a hold
 *     — a real saccade is 30-80 ms, and easing one smoothly across half a second
 *     is the single thing that makes an animated face look like a screensaver.
 *   - Blinks are asymmetric: shut in one frame, open over three. Lids fall and
 *     are lifted, and matching the two halves makes it read as a flicker.
 *   - Nothing is ever perfectly still. A slow sub-pixel sway runs underneath
 *     every hold, well below the level anyone notices as motion but far enough
 *     above zero that the face never looks paused.
 *   - Blinks land just after a saccade, which is where they land in a person.
 */

// Off, and the ink. The reference display's white is faintly lavender and it is
// worth keeping: a pure #FFFFFF pair on black is the colour of a status LED,
// while a hint of blue in the white reads as a lit screen behind glass.
const GROUND: Rgb = [0, 0, 0];
const INK: Rgb = [228, 233, 255];

// Geometry, in panel pixels.
//
// THE PROPORTION IS THE LIKENESS. The reference eye is a tall capsule, about
// one part wide to two parts high, and 16 rows is the hard limit here: a 13-row
// eye can therefore be at most 7 px wide before it stops being a pill and turns
// into an oval. Which means the face cannot fill this panel — 7 + gap + 7 is
// about 22 of the 52 columns — and trying to fill it by widening the eyes gets
// a pair of eggs. The panel's leftover width is spent on gaze instead: the pair
// travels +/-5 px, and a shift that size is only legible because there is
// somewhere for it to go.
//
// The gap runs slightly wider than the reference's (about 1.2 eye-widths against
// its 1.15), which is the one liberty taken: eyes set close together on a strip
// this wide read as a single blob from the far side of a room.
//
// THE EDGE BUDGET. Rows 0 and 15 are kept dark, and everything above is sized
// backwards from that. It costs a row of eye and it is worth it: a capsule that
// runs past the edge does not fade off, it gets its rounded end sliced flat,
// and one flat end is enough to stop the pair reading as eyes. So the resting
// half-height is 6.2 rather than the 6.5 that would just fit, the gaze rises no
// more than 0.4, the drift no more than 0.2, and the surprise pose gets wider
// instead of taller. `eyeExtentAt` is the arithmetic, and a test walks the whole
// cycle against it.
const EYE_CENTRE_Y = 8;
const EYE_OFFSET_X = 8;
const CENTRE_X = DISPLAY_WIDTH / 2;

/** One eye's shape. Every expression in this file is these four numbers. */
export interface EyeShape {
  halfW: number;
  halfH: number;
  /** Clamped to the half-extents when drawn, so halfW === radius is a capsule. */
  radius: number;
  /** Degrees clockwise on screen, so a positive brow drops its right-hand end. */
  tiltDeg: number;
  brow: Brow;
}

/**
 * The line above an eye.
 *
 * Its own object because it moves independently — the reference raises, lowers
 * and angles it over an eye that does not change — and because `alpha` has to
 * be able to reach zero: a neutral face has no brow at all, and fading one in
 * is how it acquires an opinion.
 */
export interface Brow {
  /** 0 hides it. Interpolated, so a brow arrives by fading rather than popping. */
  alpha: number;
  /** Pixels ABOVE the eye's centre. */
  offsetY: number;
  halfW: number;
  halfH: number;
  tiltDeg: number;
}

export interface EyePose {
  /** Where the pair is pointing, in panel pixels, applied to both eyes. */
  gazeX: number;
  gazeY: number;
  left: EyeShape;
  right: EyeShape;
}

/**
 * Where a brow sits when it is not being shown.
 *
 * Level, full length, at the height it would occupy — invisible only because
 * alpha is zero. Parking it somewhere neutral instead means every brow that
 * fades in also swings in from that pose, and the face looks like it is winding
 * up rather than reacting.
 */
const NO_BROW: Brow = { alpha: 0, offsetY: 5, halfW: 3.6, halfH: 0.6, tiltDeg: 0 };

// The vocabulary, read off the reference: a tall capsule at rest, a small round
// dot for surprise, a flat bar for a squint. radius === halfW, so the ends are
// true half-circles: a capsule, not a rectangle with the corners taken off.
const OPEN: EyeShape = { halfW: 3.5, halfH: 6.2, radius: 3.5, tiltDeg: 0, brow: NO_BROW };
// SHUT is 1.8 px rather than the 1.4 that looks right on paper. The eye centre
// sits on a pixel BOUNDARY, so a 1.4 px bar straddles two rows at 70% each and
// the blink reads as the eye fading out rather than closing. 1.8 fills both
// rows, and a lid that shuts at full brightness is the difference between a
// blink and a dropped frame.
const SHUT: EyeShape = { halfW: 3.5, halfH: 0.9, radius: 0.9, tiltDeg: 0, brow: NO_BROW };
const DOT: EyeShape = { halfW: 2.2, halfH: 2.2, radius: 2.2, tiltDeg: 0, brow: NO_BROW };
// Wider than SHUT by a whole row, so a squint and a blink are never the same
// picture — the blink is a lid, this is an attitude, and they hold for very
// different lengths of time.
const SQUINT: EyeShape = { halfW: 3.5, halfH: 1.5, radius: 1.5, tiltDeg: 0, brow: NO_BROW };

/**
 * Brow down, eye squat: the reference's unimpressed face.
 *
 * The two brows angle in OPPOSITE directions, which is what makes a pair of
 * lines a face at all — same-direction lines read as a sleep mask. Inner ends
 * high, outer ends low, exactly as the reference has them; the mirrored version
 * (inner ends low) is a glare rather than a sulk, and this one is the one in
 * the video.
 *
 * The eye has to shrink to about a third of its height and drop, or there is
 * nowhere for the brow to be: 16 rows do not hold a 13-row eye AND a line above
 * it. That constraint turns out to be the expression — a hooded eye under a
 * lowered brow is what being unimpressed looks like.
 */
const SULK_EYE: EyeShape = { halfW: 3.6, halfH: 1.9, radius: 1.9, tiltDeg: 0, brow: NO_BROW };
// The brow runs slightly LONGER than the eye is wide, as the reference's does.
// A brow the same length reads as a lid, and a lid is not an opinion.
//
// THICKER AND FLATTER THAN THE REFERENCE'S, on purpose. Its brow is a hairline
// because it has a few hundred rows to spend; here a 1 px bar tilted 18 degrees
// smears its coverage across three rows and every one of them comes out at a
// third brightness — a dashed grey line, not a stroke. 1.6 px at 16 degrees
// keeps at least one row fully lit along the whole length, which is what makes
// it read as drawn rather than as noise.
const SULK_BROW = { alpha: 1, offsetY: 5.2, halfW: 3.9, halfH: 0.8 };
const SULK_LEFT: EyeShape = { ...SULK_EYE, brow: { ...SULK_BROW, tiltDeg: -16 } };
const SULK_RIGHT: EyeShape = { ...SULK_EYE, brow: { ...SULK_BROW, tiltDeg: 16 } };

function pose(
  gazeX: number,
  gazeY: number,
  left: EyeShape,
  right: EyeShape = left,
): EyePose {
  return { gazeX, gazeY, left, right };
}

/**
 * How a segment gets from one pose to the next.
 *
 * `snap` is the important one and the reason this is not a single easing
 * function: a saccade covers its distance in about two frames and then stops
 * dead. Everything else — a lid opening, a squint relaxing — is muscle, and
 * moves like muscle.
 */
type Ease = "snap" | "smooth" | "hold";

interface Keyframe {
  atMs: number;
  pose: EyePose;
  /** How to reach THIS keyframe from the one before it. */
  ease: Ease;
}

/**
 * The loop, in milliseconds.
 *
 * Read it as behaviour rather than animation: look around, react to something,
 * get bored, get annoyed, settle. It opens and closes on the same resting pose
 * so the cycle joins itself invisibly, which is what lets the whole script be
 * stretched to fit whatever duration the channel asks for.
 */
const SCRIPT: readonly Keyframe[] = [
  { atMs: 0, pose: pose(0, 0, OPEN), ease: "hold" },
  { atMs: 820, pose: pose(0, 0, OPEN), ease: "hold" },
  // Blink. Shut fast, hold shut for one frame, open slowly.
  { atMs: 900, pose: pose(0, 0, SHUT), ease: "snap" },
  { atMs: 980, pose: pose(0, 0, SHUT), ease: "hold" },
  { atMs: 1180, pose: pose(0, 0, OPEN), ease: "smooth" },
  { atMs: 1560, pose: pose(0, 0, OPEN), ease: "hold" },
  // Look left, hold, then across to the right. The eye that leads the movement
  // is fractionally narrower — the far eye of a turned head foreshortens, and
  // one pixel of it is enough to stop the pair reading as a rigid mask.
  { atMs: 1660, pose: pose(-5, 0.4, { ...OPEN, halfW: 3.0 }, OPEN), ease: "snap" },
  { atMs: 2280, pose: pose(-5, 0.4, { ...OPEN, halfW: 3.0 }, OPEN), ease: "hold" },
  { atMs: 2380, pose: pose(5, 0.4, OPEN, { ...OPEN, halfW: 3.0 }), ease: "snap" },
  { atMs: 3060, pose: pose(5, 0.4, OPEN, { ...OPEN, halfW: 3.0 }), ease: "hold" },
  { atMs: 3160, pose: pose(0, 0, OPEN), ease: "snap" },
  // Something arrives: eyes go WIDE and almost circular, then shrink to dots.
  // Widening before shrinking is what sells surprise; going straight to dots
  // reads as a squint. It widens rather than growing taller because there is no
  // taller to go — see the edge budget above.
  { atMs: 3420, pose: pose(0, -0.3, { ...OPEN, halfW: 4.3, halfH: 6.3, radius: 4.3 }), ease: "snap" },
  { atMs: 3620, pose: pose(0, -0.8, DOT), ease: "smooth" },
  { atMs: 4180, pose: pose(1.6, -0.8, DOT), ease: "snap" },
  { atMs: 4600, pose: pose(-1.6, -0.8, DOT), ease: "snap" },
  { atMs: 4900, pose: pose(0, 0, OPEN), ease: "smooth" },
  { atMs: 5320, pose: pose(0, 0, OPEN), ease: "hold" },
  { atMs: 5400, pose: pose(0, 0, SHUT), ease: "snap" },
  { atMs: 5560, pose: pose(0, 0, OPEN), ease: "smooth" },
  // Bored, then narked. The squint arrives slowly, the brow snaps down — one is
  // attention fading, the other is a decision.
  { atMs: 6180, pose: pose(0, 1, SQUINT), ease: "smooth" },
  { atMs: 6900, pose: pose(0, 1, SQUINT), ease: "hold" },
  { atMs: 7020, pose: pose(0, 2.2, SULK_LEFT, SULK_RIGHT), ease: "snap" },
  { atMs: 7820, pose: pose(0, 2.2, SULK_LEFT, SULK_RIGHT), ease: "hold" },
  { atMs: 7980, pose: pose(0, 0, OPEN), ease: "snap" },
  { atMs: 8420, pose: pose(0, 0, OPEN), ease: "hold" },
  { atMs: 8500, pose: pose(0, 0, SHUT), ease: "snap" },
  { atMs: 8700, pose: pose(0, 0, OPEN), ease: "smooth" },
  { atMs: 9200, pose: pose(0, 0, OPEN), ease: "hold" },
];

export const EYES_CYCLE_MS = SCRIPT[SCRIPT.length - 1]!.atMs;

// 80 ms is 12.5 fps, which is what 120 frames buys across a 10 s item — the
// same cap every other visual here honours. The script is written to survive
// it: nothing moves for fewer than two frames except a blink shutting, and a
// blink shutting in one frame is correct.
const FRAME_MS = 80;
const MAX_FRAMES = 120;

function easeValue(kind: Ease, t: number): number {
  if (kind === "hold") return t >= 1 ? 1 : 0;
  // A saccade is ballistic: almost all of the distance in the first half of the
  // segment, then a hard stop. Cubic ease-out, not smoothstep.
  if (kind === "snap") return 1 - (1 - t) ** 3;
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function blendBrow(a: Brow, b: Brow, t: number): Brow {
  return {
    alpha: lerp(a.alpha, b.alpha, t),
    offsetY: lerp(a.offsetY, b.offsetY, t),
    halfW: lerp(a.halfW, b.halfW, t),
    halfH: lerp(a.halfH, b.halfH, t),
    tiltDeg: lerp(a.tiltDeg, b.tiltDeg, t),
  };
}

function blendShape(a: EyeShape, b: EyeShape, t: number): EyeShape {
  return {
    halfW: lerp(a.halfW, b.halfW, t),
    halfH: lerp(a.halfH, b.halfH, t),
    radius: lerp(a.radius, b.radius, t),
    tiltDeg: lerp(a.tiltDeg, b.tiltDeg, t),
    brow: blendBrow(a.brow, b.brow, t),
  };
}

/**
 * The pose at a moment in the cycle.
 *
 * Exported because this is the whole design: given this function, the renderer
 * below is a rasteriser and nothing more, and a test can assert that the face
 * blinks without decoding a single pixel.
 */
export function eyePoseAt(ms: number): EyePose {
  const cycle = ((ms % EYES_CYCLE_MS) + EYES_CYCLE_MS) % EYES_CYCLE_MS;
  let index = 0;
  while (index < SCRIPT.length - 1 && SCRIPT[index + 1]!.atMs <= cycle) index += 1;
  const from = SCRIPT[index]!;
  const to = SCRIPT[index + 1] ?? SCRIPT[SCRIPT.length - 1]!;
  const span = to.atMs - from.atMs;
  const t = span <= 0 ? 1 : easeValue(to.ease, (cycle - from.atMs) / span);
  return {
    gazeX: lerp(from.pose.gazeX, to.pose.gazeX, t),
    gazeY: lerp(from.pose.gazeY, to.pose.gazeY, t),
    left: blendShape(from.pose.left, to.pose.left, t),
    right: blendShape(from.pose.right, to.pose.right, t),
  };
}

/**
 * The sway that runs under everything.
 *
 * Three periods that do not line up with each other or with the script, so the
 * face never settles into a visible rhythm. The amplitude is deliberately below
 * a pixel: it shows up only as the anti-aliased edges breathing, which is
 * exactly the level a living thing idles at.
 *
 * MEASURED IN CYCLES, NOT MILLISECONDS. The obvious `sin(ms / 1370)` is wrong
 * here for one reason: it is not periodic over the script, so at the loop point
 * the sway teleports from wherever it had got to back to zero. A third of a
 * pixel is small, but it lands on every anti-aliased edge at once and on a
 * looping GIF it recurs forever. Whole numbers of oscillations per cycle make
 * the seam exact — 3, 7 and 5 of them, which at this cycle length works out at
 * one sway every 3.1 s, 1.3 s and 1.8 s.
 */
function drift(ms: number): { x: number; y: number } {
  const turn = (2 * Math.PI * (((ms % EYES_CYCLE_MS) + EYES_CYCLE_MS) % EYES_CYCLE_MS)) / EYES_CYCLE_MS;
  return {
    x: Math.sin(turn * 3) * 0.35 + Math.sin(turn * 7) * 0.12,
    y: Math.sin(turn * 5) * 0.2,
  };
}

/**
 * How much of the pixel at (px, py) the shape covers, 0..1.
 *
 * Signed distance to a rounded box, read as coverage: a pixel whose centre sits
 * exactly on the edge is half lit, and the ramp is one pixel wide. Exact enough
 * that a 5x6 capsule has no visible flat on its curve, and cheap enough to run
 * for every pixel of every frame without anybody noticing.
 */
export function roundedBoxCoverage(
  px: number,
  py: number,
  shape: EyeShape,
): number {
  const tilt = (-shape.tiltDeg * Math.PI) / 180;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const x = px * cos - py * sin;
  const y = px * sin + py * cos;
  const radius = Math.max(0, Math.min(shape.radius, shape.halfW, shape.halfH));
  const qx = Math.abs(x) - (shape.halfW - radius);
  const qy = Math.abs(y) - (shape.halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const distance = outside + inside - radius;
  return Math.max(0, Math.min(1, 0.5 - distance));
}

/**
 * One rounded box, anti-aliased, brightest-wins.
 *
 * Brightest-wins rather than painted over: the brow can overlap the eye during a
 * transition, and a later shape darkening an earlier one would punch a hole
 * through it. Two lit things on an LED panel add; they never subtract.
 */
function drawBox(
  canvas: PixelCanvas,
  centreX: number,
  centreY: number,
  shape: EyeShape,
  alpha: number,
): void {
  if (alpha <= 0) return;
  // Only the rows and columns the shape can reach. +1 covers the one-pixel
  // anti-aliasing ramp that lies just outside the shape's own extent.
  const reach = halfExtents(shape);
  const minX = Math.max(0, Math.floor(centreX - reach.x - 1));
  const maxX = Math.min(DISPLAY_WIDTH - 1, Math.ceil(centreX + reach.x + 1));
  const minY = Math.max(0, Math.floor(centreY - reach.y - 1));
  const maxY = Math.min(DISPLAY_HEIGHT - 1, Math.ceil(centreY + reach.y + 1));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      // +0.5 puts the sample at the pixel's centre rather than its corner;
      // without it the whole face sits half a pixel up and to the left.
      const coverage = roundedBoxCoverage(x + 0.5 - centreX, y + 0.5 - centreY, shape) * alpha;
      if (coverage <= 0) continue;
      const previous = canvas.getPixel(x, y);
      const lit: Rgb = [
        Math.max(previous[0], Math.round(INK[0] * coverage)),
        Math.max(previous[1], Math.round(INK[1] * coverage)),
        Math.max(previous[2], Math.round(INK[2] * coverage)),
      ];
      canvas.setPixel(x, y, lit);
    }
  }
}

/**
 * The axis-aligned half-extents of a shape, tilt included.
 *
 * A rotated rectangle's shadow on each axis is |w·cos| + |h·sin|. The rounded
 * box sits INSIDE that rectangle, so this bounds it — exactly at the corners,
 * generously along the flats, and never short, which is the direction that
 * matters for both the raster loop and the edge check.
 */
function halfExtents(shape: EyeShape): { x: number; y: number } {
  const tilt = (shape.tiltDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(tilt));
  const sin = Math.abs(Math.sin(tilt));
  return {
    x: shape.halfW * cos + shape.halfH * sin,
    y: shape.halfW * sin + shape.halfH * cos,
  };
}

function browShape(brow: Brow): EyeShape {
  return { halfW: brow.halfW, halfH: brow.halfH, radius: brow.halfH, tiltDeg: brow.tiltDeg, brow: NO_BROW };
}

export interface EyeExtent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Everything the face occupies at a moment, in panel pixels.
 *
 * Exists so the edge budget is an assertion rather than an intention: a test
 * walks the cycle and checks this stays inside the panel, which catches a pose
 * that would have its rounded end sliced flat — the one failure that cannot be
 * seen in a still and reads as a broken shape in motion.
 */
export function eyeExtentAt(ms: number): EyeExtent {
  const eyes = eyePoseAt(ms);
  const sway = drift(ms);
  const originX = CENTRE_X + eyes.gazeX + sway.x;
  const originY = EYE_CENTRE_Y + eyes.gazeY + sway.y;
  const extent: EyeExtent = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const add = (cx: number, cy: number, shape: EyeShape): void => {
    const half = halfExtents(shape);
    extent.minX = Math.min(extent.minX, cx - half.x);
    extent.maxX = Math.max(extent.maxX, cx + half.x);
    extent.minY = Math.min(extent.minY, cy - half.y);
    extent.maxY = Math.max(extent.maxY, cy + half.y);
  };
  for (const [side, shape] of [[-1, eyes.left], [1, eyes.right]] as const) {
    const cx = originX + side * EYE_OFFSET_X;
    add(cx, originY, shape);
    // A brow with no opacity occupies nothing, however it is parked.
    if (shape.brow.alpha > 0) add(cx, originY - shape.brow.offsetY, browShape(shape.brow));
  }
  return extent;
}

function drawEye(canvas: PixelCanvas, centreX: number, centreY: number, shape: EyeShape): void {
  drawBox(canvas, centreX, centreY, shape, 1);
  const brow = shape.brow;
  // A brow is a rounded box like the eye is; only its alpha and its offset make
  // it a different thing. Squared corners on a 1px-high bar would be invisible
  // anyway, so it reuses the same rasteriser rather than earning its own.
  drawBox(canvas, centreX, centreY - brow.offsetY, browShape(brow), brow.alpha);
}

/** One frame at a moment in the cycle. Exported so a test can pin a pose. */
export function renderEyeFrame(ms: number): PixelCanvas {
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT, GROUND);
  const eyes = eyePoseAt(ms);
  const sway = drift(ms);
  const x = CENTRE_X + eyes.gazeX + sway.x;
  const y = EYE_CENTRE_Y + eyes.gazeY + sway.y;
  drawEye(canvas, x - EYE_OFFSET_X, y, eyes.left);
  drawEye(canvas, x + EYE_OFFSET_X, y, eyes.right);
  return canvas;
}

function framePlan(durationMs: number): number[] {
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(durationMs / FRAME_MS)));
  const base = Math.floor(durationMs / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? durationMs - base * (count - 1) : base
  );
}

/**
 * Fits whole cycles into the item's duration.
 *
 * The script has to both keep its timing and join itself at the loop point, and
 * those pull opposite ways: a 9.2 s script inside a 10 s item leaves 800 ms of
 * a second cycle, so the GIF restarts mid-blink. Running an INTEGER number of
 * cycles and stretching each to fit costs at most a quarter of the natural
 * speed — a blink between 60 and 100 ms, which nobody can tell apart — and buys
 * a seam nobody can see.
 */
export function eyeCycleScale(durationMs: number, speed: number): number {
  const target = EYES_CYCLE_MS / Math.max(0.1, speed);
  const cycles = Math.max(1, Math.round(durationMs / target));
  return (cycles * EYES_CYCLE_MS) / durationMs;
}

export function renderEyes(durationMs: number, speed = 1): VisualAnimation {
  const delays = framePlan(durationMs);
  const scale = eyeCycleScale(durationMs, speed);
  let elapsed = 0;
  const frames = delays.map((delay) => {
    const canvas = renderEyeFrame(elapsed * scale);
    elapsed += delay;
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "一对眼睛" };
}
