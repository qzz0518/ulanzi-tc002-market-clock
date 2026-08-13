/**
 * Turns a hand-picked rectangle of an uploaded picture into the whole 52×16
 * panel. There is exactly one knob — the crop — because the panel's size and
 * aspect are fixed and everything else is a decision the code can make better
 * than a slider can.
 */

export const PANEL_WIDTH = 52;
export const PANEL_HEIGHT = 16;
/** 52:16 = 13:4 = 3.25. Any other crop shape would have to letterbox or squash. */
export const PANEL_ASPECT = PANEL_WIDTH / PANEL_HEIGHT;
const PANEL_CELLS = PANEL_WIDTH * PANEL_HEIGHT;

/**
 * Floor on the crop width, in source pixels. 13:4 is the panel ratio in lowest
 * terms, so this is the smallest rectangle that still lands on whole source
 * pixels; anything below it is a mis-drag, not an intention.
 */
const MIN_CROP_WIDTH = 13;

export interface PixelView {
  width: number;
  height: number;
  /** RGBA, row-major, as handed over by CanvasRenderingContext2D.getImageData. */
  data: Uint8ClampedArray;
}

/** A rectangle in source-image pixels. Fractional on purpose — see resizeCrop. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropHandle = "nw" | "ne" | "sw" | "se";

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, value));
}

/** The widest 52:16 rectangle this image can hold, ignoring where it sits. */
function maxCropWidth(view: PixelView): number {
  return Math.max(1, Math.min(view.width, view.height * PANEL_ASPECT));
}

function minCropWidth(view: PixelView): number {
  // A source smaller than the floor still deserves a crop, so the floor gives
  // way to the image rather than the other way round.
  return Math.min(MIN_CROP_WIDTH, maxCropWidth(view));
}

/**
 * Keeps a rectangle legal: locked to the panel ratio, no smaller than the
 * floor, no larger than the image, and fully inside it. Width is authoritative
 * because the panel is wide — height is always derived from it.
 */
export function clampCrop(view: PixelView, rect: CropRect): CropRect {
  const width = clamp(rect.width, minCropWidth(view), maxCropWidth(view));
  const height = width / PANEL_ASPECT;
  return {
    x: clamp(rect.x, 0, Math.max(0, view.width - width)),
    y: clamp(rect.y, 0, Math.max(0, view.height - height)),
    width,
    height,
  };
}

/**
 * The largest panel-shaped rectangle, centred. This is what the user sees
 * before touching anything, so it has to be the answer for "just pixelize it".
 */
export function defaultCrop(view: PixelView): CropRect {
  const width = maxCropWidth(view);
  const height = width / PANEL_ASPECT;
  return {
    x: (view.width - width) / 2,
    y: (view.height - height) / 2,
    width,
    height,
  };
}

/** Drag inside the box: same size, new top-left, clamped to the image. */
export function moveCrop(view: PixelView, rect: CropRect, x: number, y: number): CropRect {
  return clampCrop(view, { ...rect, x, y });
}

/**
 * Drag a corner: the opposite corner of `rect` stays pinned and the ratio never
 * moves. The dragged pointer rarely sits on a 52:16 diagonal, so the axis the
 * user pulled hardest wins and the other one follows — dragging sideways and
 * dragging down both grow the box, which is what a corner handle promises.
 *
 * `rect` must be the rectangle the drag *started* from, not the previous
 * frame's: the anchor is read off it, so feeding it the box's own output makes
 * the anchor chase the pointer. See applyCropDrag.
 */
export function resizeCrop(
  view: PixelView,
  rect: CropRect,
  handle: CropHandle,
  pointerX: number,
  pointerY: number,
): CropRect {
  const anchorX = handle === "nw" || handle === "sw" ? rect.x + rect.width : rect.x;
  const anchorY = handle === "nw" || handle === "ne" ? rect.y + rect.height : rect.y;
  const deltaX = clamp(pointerX, 0, view.width) - anchorX;
  const deltaY = clamp(pointerY, 0, view.height) - anchorY;

  // How far the box may grow before it walks off the image on either axis.
  const roomX = deltaX >= 0 ? view.width - anchorX : anchorX;
  const roomY = deltaY >= 0 ? view.height - anchorY : anchorY;
  const width = clamp(
    Math.max(Math.abs(deltaX), Math.abs(deltaY) * PANEL_ASPECT),
    minCropWidth(view),
    Math.max(minCropWidth(view), Math.min(roomX, roomY * PANEL_ASPECT)),
  );
  const height = width / PANEL_ASPECT;
  return clampCrop(view, {
    x: deltaX >= 0 ? anchorX : anchorX - width,
    y: deltaY >= 0 ? anchorY : anchorY - height,
    width,
    height,
  });
}

/**
 * A drag in progress. Every variant carries `baseRect` — the box as it stood at
 * pointerdown — because both moveCrop and resizeCrop read their fixed point off
 * the rectangle handed to them. Deriving that from the live box instead makes
 * the fixed point move with the box: pressing empty space and dragging up-left,
 * the most ordinary marquee gesture there is, walked the pinned corner from
 * (380,280) to (120,170) over five pointer events and left the box trailing the
 * cursor by 60px. Recomputing from pointerdown makes every frame of a drag a
 * pure function of the pointer, so no gesture can accumulate error.
 */
export type CropDrag =
  | { kind: "move"; grabX: number; grabY: number; baseRect: CropRect }
  | { kind: "resize"; handle: CropHandle; baseRect: CropRect };

/**
 * Decides what a press means: on a handle it resizes, inside the box it moves,
 * and on empty space it starts a new box from that corner — the same "drag on
 * empty space to re-frame" the board's select tool offers. Returns the drag to
 * hold for the gesture plus the rectangle to show right away.
 */
export function beginCropDrag(
  view: PixelView,
  rect: CropRect,
  handle: CropHandle | null,
  pointerX: number,
  pointerY: number,
): { drag: CropDrag; rect: CropRect } {
  if (handle) return { drag: { kind: "resize", handle, baseRect: rect }, rect };
  const inside = pointerX >= rect.x
    && pointerY >= rect.y
    && pointerX < rect.x + rect.width
    && pointerY < rect.y + rect.height;
  if (inside) {
    return {
      drag: { kind: "move", grabX: pointerX - rect.x, grabY: pointerY - rect.y, baseRect: rect },
      rect,
    };
  }
  // The zero-size rect is never shown — it exists so the anchor is exactly the
  // pixel pressed, rather than the corner of the min-size box drawn there.
  const baseRect: CropRect = {
    x: clamp(pointerX, 0, view.width),
    y: clamp(pointerY, 0, view.height),
    width: 0,
    height: 0,
  };
  return { drag: { kind: "resize", handle: "se", baseRect }, rect: clampCrop(view, baseRect) };
}

/** The box for one pointer position, always measured from where the drag began. */
export function applyCropDrag(
  view: PixelView,
  drag: CropDrag,
  pointerX: number,
  pointerY: number,
): CropRect {
  return drag.kind === "move"
    ? moveCrop(view, drag.baseRect, pointerX - drag.grabX, pointerY - drag.grabY)
    : resizeCrop(view, drag.baseRect, drag.handle, pointerX, pointerY);
}

const LUMA_RED = 0.2126;
const LUMA_GREEN = 0.7152;
const LUMA_BLUE = 0.0722;

function luma(red: number, green: number, blue: number): number {
  return LUMA_RED * red + LUMA_GREEN * green + LUMA_BLUE * blue;
}

/**
 * Writes a colour back at a chosen luminance without letting a channel clip.
 * Clipping one channel is a hue shift, not a highlight: lifting skin at
 * (232,141,123) clipped red and turned the face orange in an earlier build.
 * Out-of-gamut colours give up saturation toward the grey of the same
 * luminance instead, so a lifted highlight goes pastel and keeps its hue.
 */
function writeToned(
  out: Float32Array,
  offset: number,
  red: number,
  green: number,
  blue: number,
  target: number,
): void {
  const level = luma(red, green, blue);
  const deltaRed = red - level;
  const deltaGreen = green - level;
  const deltaBlue = blue - level;
  const headroom = (delta: number): number => {
    if (delta > 1e-4) return (255 - target) / delta;
    if (delta < -1e-4) return -target / delta;
    return Number.POSITIVE_INFINITY;
  };
  const scale = Math.max(
    0,
    Math.min(1, headroom(deltaRed), headroom(deltaGreen), headroom(deltaBlue)),
  );
  out[offset] = clamp(target + deltaRed * scale, 0, 255);
  out[offset + 1] = clamp(target + deltaGreen * scale, 0, 255);
  out[offset + 2] = clamp(target + deltaBlue * scale, 0, 255);
}

/**
 * Area average of every source pixel a cell covers, weighted by how much of the
 * pixel falls inside it. One sample per cell (the old behaviour) throws away
 * 99% of a photo and aliases: a 451px-wide crop is 8.7 source pixels per cell.
 * Alpha composites over black because black is the panel's "LED off".
 *
 * Returns null when the crop covers no opaque pixel at all — a fully
 * transparent region, or a decode that produced nothing. Both would otherwise
 * come out as 832 legitimate-looking black cells.
 */
function boxSample(view: PixelView, rect: CropRect): Float32Array | null {
  const out = new Float32Array(PANEL_CELLS * 3);
  let coverage = 0;
  // A degenerate rect (a click without a drag, a 1px-tall band) must still
  // produce a frame rather than divide by zero, so both extents get a floor.
  const left = clamp(rect.x, 0, Math.max(0, view.width - 1));
  const top = clamp(rect.y, 0, Math.max(0, view.height - 1));
  const width = clamp(rect.width, 1e-3, Math.max(1e-3, view.width - left));
  const height = clamp(rect.height, 1e-3, Math.max(1e-3, view.height - top));

  for (let cellY = 0; cellY < PANEL_HEIGHT; cellY += 1) {
    const y0 = top + cellY * height / PANEL_HEIGHT;
    const y1 = top + (cellY + 1) * height / PANEL_HEIGHT;
    const pixelY0 = Math.max(0, Math.floor(y0));
    const pixelY1 = Math.min(view.height, Math.max(pixelY0 + 1, Math.ceil(y1)));
    for (let cellX = 0; cellX < PANEL_WIDTH; cellX += 1) {
      const x0 = left + cellX * width / PANEL_WIDTH;
      const x1 = left + (cellX + 1) * width / PANEL_WIDTH;
      const pixelX0 = Math.max(0, Math.floor(x0));
      const pixelX1 = Math.min(view.width, Math.max(pixelX0 + 1, Math.ceil(x1)));
      let red = 0;
      let green = 0;
      let blue = 0;
      let total = 0;
      for (let pixelY = pixelY0; pixelY < pixelY1; pixelY += 1) {
        // Sub-pixel crops cover less than one whole pixel, so the overlap is
        // floored rather than dropped — otherwise the cell would come out black.
        const spanY = Math.max(0, Math.min(pixelY + 1, y1) - Math.max(pixelY, y0)) || 1;
        for (let pixelX = pixelX0; pixelX < pixelX1; pixelX += 1) {
          const spanX = Math.max(0, Math.min(pixelX + 1, x1) - Math.max(pixelX, x0)) || 1;
          const weight = spanX * spanY;
          const index = (pixelY * view.width + pixelX) * 4;
          const alpha = (view.data[index + 3] ?? 255) / 255;
          coverage += alpha * weight;
          red += (view.data[index] ?? 0) * alpha * weight;
          green += (view.data[index + 1] ?? 0) * alpha * weight;
          blue += (view.data[index + 2] ?? 0) * alpha * weight;
          total += weight;
        }
      }
      const offset = (cellY * PANEL_WIDTH + cellX) * 3;
      if (total <= 0) continue;
      out[offset] = red / total;
      out[offset + 1] = green / total;
      out[offset + 2] = blue / total;
    }
  }
  return coverage > 0 ? out : null;
}

/** Below this spread the crop is effectively one colour and a stretch is noise. */
const FLAT_RANGE = 8;
/**
 * Averaging 832 cells out of a photo collapses the histogram toward mid grey,
 * so the result is re-stretched to the full range. The gain is capped: a night
 * shot that is genuinely dark should stay dark, not be turned into daylight.
 */
const MAX_LEVELS_GAIN = 1.6;
const LEVELS_LOW_PERCENTILE = 0.01;
const LEVELS_HIGH_PERCENTILE = 0.99;
/**
 * Only the range outside these bounds is compressed. A flat stretch to 0/255
 * would darken a true white (a logo on paper) and crush a true black; bending
 * just the tails keeps them exact and folds the overshoot into the headroom.
 */
const LEVELS_KNEE = 0.85;
const LEVELS_TOE = 0.15;

/**
 * Re-stretches the crop's tonal range, measured on the brightest channel rather
 * than on luminance. Luminance calls a saturated blue (0,0,255) the darkest
 * thing in the picture — it scores 18 out of 255 — so a luminance stretch pins
 * blue to the black point and a blue-on-yellow graphic comes back black on
 * yellow. Peak channel puts that blue at the top where the eye has it, and
 * because every channel is then scaled by one factor the hue is exact and the
 * brightest channel lands on the target: this step can never clip.
 */
function stretchLevels(rgb: Float32Array): Float32Array {
  const cells = rgb.length / 3;
  const peaks = new Float32Array(cells);
  for (let cell = 0; cell < cells; cell += 1) {
    peaks[cell] = Math.max(rgb[cell * 3] ?? 0, rgb[cell * 3 + 1] ?? 0, rgb[cell * 3 + 2] ?? 0);
  }
  const sorted = Float32Array.from(peaks).sort();
  const low = sorted[Math.floor((cells - 1) * LEVELS_LOW_PERCENTILE)] ?? 0;
  const high = sorted[Math.ceil((cells - 1) * LEVELS_HIGH_PERCENTILE)] ?? 0;
  if (high - low < FLAT_RANGE) return Float32Array.from(rgb);

  const gain = Math.min(MAX_LEVELS_GAIN, 255 / (high - low));
  const stretched = new Float32Array(cells);
  let lowest = 0;
  let highest = 1;
  for (let cell = 0; cell < cells; cell += 1) {
    const value = ((peaks[cell] ?? 0) - low) * gain / 255;
    stretched[cell] = value;
    if (value < lowest) lowest = value;
    if (value > highest) highest = value;
  }
  const highScale = highest > 1 ? (1 - LEVELS_KNEE) / (highest - LEVELS_KNEE) : 1;
  const lowScale = lowest < 0 ? LEVELS_TOE / (LEVELS_TOE - lowest) : 1;

  const out = new Float32Array(rgb.length);
  for (let cell = 0; cell < cells; cell += 1) {
    let value = stretched[cell] ?? 0;
    if (value > LEVELS_KNEE) value = LEVELS_KNEE + (value - LEVELS_KNEE) * highScale;
    else if (value < LEVELS_TOE) value = LEVELS_TOE - (LEVELS_TOE - value) * lowScale;
    const peak = peaks[cell] ?? 0;
    const scale = peak > 0.5 ? clamp(value * 255, 0, 255) / peak : 0;
    for (let channel = 0; channel < 3; channel += 1) {
      out[cell * 3 + channel] = clamp((rgb[cell * 3 + channel] ?? 0) * scale, 0, 255);
    }
  }
  return out;
}

/**
 * Averaging also drags colours toward each other, so a modest lift puts back
 * what the downsample took. 1.2 is deliberately timid: 1.35 read as neon on an
 * orange flight suit and turned skin tones to tangerine.
 */
const SATURATION = 1.2;

function saturate(rgb: Float32Array): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let offset = 0; offset < rgb.length; offset += 3) {
    const red = rgb[offset] ?? 0;
    const green = rgb[offset + 1] ?? 0;
    const blue = rgb[offset + 2] ?? 0;
    const level = luma(red, green, blue);
    writeToned(
      out,
      offset,
      level + (red - level) * SATURATION,
      level + (green - level) * SATURATION,
      level + (blue - level) * SATURATION,
      level,
    );
  }
  return out;
}

/**
 * Unsharp mask at panel resolution. An area average is a low-pass filter, so
 * every edge that survives it arrives soft — a cat's pupil becomes a smudge.
 * Adding back the difference from a 3×3 blur restores the boundary that makes
 * the picture readable. 0.6 stops short of the white halos 0.9 leaves on a logo.
 */
const SHARPEN = 0.6;

function sharpen(rgb: Float32Array): Float32Array {
  const kernel = [1, 2, 1];
  const horizontal = new Float32Array(rgb.length);
  const blurred = new Float32Array(rgb.length);
  for (let y = 0; y < PANEL_HEIGHT; y += 1) {
    for (let x = 0; x < PANEL_WIDTH; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        let weight = 0;
        for (let step = -1; step <= 1; step += 1) {
          const sampleX = clamp(x + step, 0, PANEL_WIDTH - 1);
          sum += (rgb[(y * PANEL_WIDTH + sampleX) * 3 + channel] ?? 0) * (kernel[step + 1] ?? 0);
          weight += kernel[step + 1] ?? 0;
        }
        horizontal[(y * PANEL_WIDTH + x) * 3 + channel] = sum / weight;
      }
    }
  }
  for (let y = 0; y < PANEL_HEIGHT; y += 1) {
    for (let x = 0; x < PANEL_WIDTH; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        let weight = 0;
        for (let step = -1; step <= 1; step += 1) {
          const sampleY = clamp(y + step, 0, PANEL_HEIGHT - 1);
          sum += (horizontal[(sampleY * PANEL_WIDTH + x) * 3 + channel] ?? 0) * (kernel[step + 1] ?? 0);
          weight += kernel[step + 1] ?? 0;
        }
        blurred[(y * PANEL_WIDTH + x) * 3 + channel] = sum / weight;
      }
    }
  }
  const out = new Float32Array(rgb.length);
  for (let index = 0; index < rgb.length; index += 1) {
    const value = rgb[index] ?? 0;
    out[index] = clamp(value + (value - (blurred[index] ?? 0)) * SHARPEN, 0, 255);
  }
  return out;
}

/**
 * The crop becomes the whole panel: exactly 52×16 packed 0xRRGGBB cells, ready
 * to replace the board. No palette snapping — the device path keeps full RGB
 * (see paletteForFrames in src/pixel-ui.ts: a frame under 256 unique colours is
 * carried verbatim), so there is nothing to snap to.
 *
 * Null means "no picture here": an unusable buffer, or a crop over nothing but
 * transparency. The caller must leave the board alone and say so — a black
 * panel reported as a success would silently overwrite the user's artwork.
 */
export function pixelizeCrop(view: PixelView, rect: CropRect): number[] | null {
  if (view.width < 1 || view.height < 1 || view.data.length < view.width * view.height * 4) {
    return null;
  }
  const sampled = boxSample(view, rect);
  if (!sampled) return null;
  const rgb = sharpen(saturate(stretchLevels(sampled)));
  const pixels = new Array<number>(PANEL_CELLS);
  for (let cell = 0; cell < PANEL_CELLS; cell += 1) {
    const red = clamp(Math.round(rgb[cell * 3] ?? 0), 0, 255);
    const green = clamp(Math.round(rgb[cell * 3 + 1] ?? 0), 0, 255);
    const blue = clamp(Math.round(rgb[cell * 3 + 2] ?? 0), 0, 255);
    pixels[cell] = (red << 16) | (green << 8) | blue;
  }
  return pixels;
}
