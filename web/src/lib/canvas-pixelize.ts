/**
 * Turns a hand-picked rectangle of an uploaded picture into the 52×16 panel.
 * Two knobs, and only two: the shape the selection box is allowed to take, and
 * what to do when that shape is not the panel's. Everything downstream of the
 * sampling grid — tone, saturation, sharpening — is a decision the code makes
 * better than a slider can.
 */

export const PANEL_WIDTH = 52;
export const PANEL_HEIGHT = 16;
/** 52:16 = 13:4 = 3.25. A selection of any other shape must letterbox or squash. */
export const PANEL_ASPECT = PANEL_WIDTH / PANEL_HEIGHT;
const PANEL_CELLS = PANEL_WIDTH * PANEL_HEIGHT;

/**
 * Floor on the crop width, in source pixels. 13:4 is the panel ratio in lowest
 * terms, so this is the smallest rectangle that still lands on whole source
 * pixels; anything below it is a mis-drag, not an intention.
 */
const MIN_CROP_WIDTH = 13;
/** The same floor stated for the other axis, for boxes that are not 13:4. */
const MIN_CROP_HEIGHT = MIN_CROP_WIDTH / PANEL_ASPECT;

/**
 * The shape the selection box holds while it is dragged. A panel-shaped box can
 * only ever frame a 3.25:1 band, which on a square app icon is a strip through
 * the middle with the top and bottom of the logo unreachable — hence the other
 * two. "panel" stays the default: it is the only shape that reaches the panel
 * with nothing cut and nothing left dark.
 */
export type CropRatio = "panel" | "free" | "square";

/** How a selection that is not 52:16 is mapped onto the panel. */
export type FitMode = "cover" | "contain" | "stretch";

/** The ratio the box is pinned to, or null when the two axes move apart. */
function lockedAspect(ratio: CropRatio): number | null {
  if (ratio === "panel") return PANEL_ASPECT;
  if (ratio === "square") return 1;
  return null;
}

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

/** The widest rectangle of this shape the image can hold, ignoring where it sits. */
function maxCropWidth(view: PixelView, ratio: CropRatio): number {
  const aspect = lockedAspect(ratio);
  return Math.max(1, aspect === null ? view.width : Math.min(view.width, view.height * aspect));
}

/** Only a free box needs this: for a locked one the height follows the width. */
function maxCropHeight(view: PixelView, ratio: CropRatio): number {
  const aspect = lockedAspect(ratio);
  return Math.max(1, aspect === null ? view.height : maxCropWidth(view, ratio) / aspect);
}

function minCropWidth(view: PixelView, ratio: CropRatio): number {
  // A source smaller than the floor still deserves a crop, so the floor gives
  // way to the image rather than the other way round.
  return Math.min(MIN_CROP_WIDTH, maxCropWidth(view, ratio));
}

function minCropHeight(view: PixelView, ratio: CropRatio): number {
  return Math.min(MIN_CROP_HEIGHT, maxCropHeight(view, ratio));
}

/**
 * Keeps a rectangle legal: held to the chosen shape, no smaller than the floor,
 * no larger than the image, and fully inside it. Under a locked ratio the width
 * is authoritative and the height is derived from it, because the panel is wide
 * and the width is the extent the user is really choosing.
 */
export function clampCrop(view: PixelView, rect: CropRect, ratio: CropRatio = "panel"): CropRect {
  const aspect = lockedAspect(ratio);
  const width = clamp(rect.width, minCropWidth(view, ratio), maxCropWidth(view, ratio));
  const height = aspect === null
    ? clamp(rect.height, minCropHeight(view, ratio), maxCropHeight(view, ratio))
    : width / aspect;
  return {
    x: clamp(rect.x, 0, Math.max(0, view.width - width)),
    y: clamp(rect.y, 0, Math.max(0, view.height - height)),
    width,
    height,
  };
}

/**
 * The largest rectangle of this shape, centred. This is what the user sees
 * before touching anything, so it has to be the answer for "just pixelize it" —
 * and under "square" it is the whole of a square icon, framed by picking the
 * ratio and nothing else.
 */
export function defaultCrop(view: PixelView, ratio: CropRatio = "panel"): CropRect {
  const aspect = lockedAspect(ratio);
  const width = maxCropWidth(view, ratio);
  const height = aspect === null ? maxCropHeight(view, ratio) : width / aspect;
  return {
    x: (view.width - width) / 2,
    y: (view.height - height) / 2,
    width,
    height,
  };
}

/** Drag inside the box: same size, new top-left, clamped to the image. */
export function moveCrop(
  view: PixelView,
  rect: CropRect,
  x: number,
  y: number,
  ratio: CropRatio = "panel",
): CropRect {
  return clampCrop(view, { ...rect, x, y }, ratio);
}

/**
 * Drag a corner: the opposite corner of `rect` stays pinned. Under a locked
 * ratio the dragged pointer rarely sits on the box's diagonal, so the axis the
 * user pulled hardest wins and the other one follows — dragging sideways and
 * dragging down both grow the box, which is what a corner handle promises.
 * Under "free" there is nothing to reconcile: each axis takes its own pointer
 * distance, and the corner is the only handle needed to reach any rectangle.
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
  ratio: CropRatio = "panel",
): CropRect {
  const anchorX = handle === "nw" || handle === "sw" ? rect.x + rect.width : rect.x;
  const anchorY = handle === "nw" || handle === "ne" ? rect.y + rect.height : rect.y;
  const deltaX = clamp(pointerX, 0, view.width) - anchorX;
  const deltaY = clamp(pointerY, 0, view.height) - anchorY;

  // How far the box may grow before it walks off the image on either axis.
  const roomX = deltaX >= 0 ? view.width - anchorX : anchorX;
  const roomY = deltaY >= 0 ? view.height - anchorY : anchorY;
  const aspect = lockedAspect(ratio);
  const floorX = minCropWidth(view, ratio);
  const floorY = minCropHeight(view, ratio);
  const width = aspect === null
    ? clamp(Math.abs(deltaX), floorX, Math.max(floorX, roomX))
    : clamp(
      Math.max(Math.abs(deltaX), Math.abs(deltaY) * aspect),
      floorX,
      Math.max(floorX, Math.min(roomX, roomY * aspect)),
    );
  const height = aspect === null
    ? clamp(Math.abs(deltaY), floorY, Math.max(floorY, roomY))
    : width / aspect;
  return clampCrop(view, {
    x: deltaX >= 0 ? anchorX : anchorX - width,
    y: deltaY >= 0 ? anchorY : anchorY - height,
    width,
    height,
  }, ratio);
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
  ratio: CropRatio = "panel",
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
  return { drag: { kind: "resize", handle: "se", baseRect }, rect: clampCrop(view, baseRect, ratio) };
}

/** The box for one pointer position, always measured from where the drag began. */
export function applyCropDrag(
  view: PixelView,
  drag: CropDrag,
  pointerX: number,
  pointerY: number,
  ratio: CropRatio = "panel",
): CropRect {
  return drag.kind === "move"
    ? moveCrop(view, drag.baseRect, pointerX - drag.grabX, pointerY - drag.grabY, ratio)
    : resizeCrop(view, drag.baseRect, drag.handle, pointerX, pointerY, ratio);
}

/** A rectangle in whole panel cells — the only unit an LED grid has. */
export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What a fit mode decided: which part of the source is read, where it lands on
 * the panel, and the two facts a readout has to be able to state — that
 * something was thrown away, and that something is left dark.
 */
export interface PixelizePlan {
  /** The region actually sampled. Smaller than the selection only under cover. */
  source: CropRect;
  /** Where it lands. Cells outside it stay off; nothing else is ever drawn. */
  destination: PanelRect;
  /** True when the fit discarded part of what the user framed. */
  cropped: boolean;
  /**
   * Which axis ends up dark because the picture could not fill it. Never both:
   * contain scales until one edge is touched, so one extent always lands on the
   * panel's own.
   */
  padding: "none" | "sides" | "bands";
  /**
   * Source pixels per cell, per axis — the one number that predicts whether the
   * result will read at all. Stretch scales the axes by different amounts and
   * contain rounds to whole cells, so `uniform` says whether quoting a single
   * factor is the whole truth or half of it.
   */
  shrink: { x: number; y: number; uniform: boolean };
}

/**
 * Non-finite and zero extents are mis-drags, not intentions, but they still
 * have to produce a plan; 1e-3 is the same floor boxSample applies, so a
 * degenerate rect divides by the same number everywhere.
 */
const MIN_EXTENT = 1e-3;

function extent(value: number): number {
  return Number.isFinite(value) && value > MIN_EXTENT ? value : MIN_EXTENT;
}

/**
 * Anything inside this of the panel ratio counts as the panel ratio. A
 * panel-locked box gets its height by dividing by 3.25, so its aspect is only
 * 13:4 up to one rounding step; treating that as "needs cutting" would shave a
 * sub-pixel off the default crop of every picture and move every cell boundary.
 */
const RATIO_EPSILON = 1e-9;

/** The largest 52:16 rectangle inside the selection, centred — cover's source. */
function coverSource(rect: CropRect): CropRect {
  const skew = rect.width * PANEL_HEIGHT - rect.height * PANEL_WIDTH;
  const magnitude = Math.abs(rect.width * PANEL_HEIGHT) + Math.abs(rect.height * PANEL_WIDTH);
  // Negated so a NaN extent lands here and the rect passes through untouched.
  if (!(Math.abs(skew) > RATIO_EPSILON * magnitude)) return rect;
  if (skew > 0) {
    const width = rect.height * PANEL_ASPECT;
    return { x: rect.x + (rect.width - width) / 2, y: rect.y, width, height: rect.height };
  }
  const height = rect.width / PANEL_ASPECT;
  return { x: rect.x, y: rect.y + (rect.height - height) / 2, width: rect.width, height };
}

/** The largest whole-cell box of the selection's shape, centred — contain's target. */
function containDestination(rect: CropRect): PanelRect {
  const width = extent(rect.width);
  const height = extent(rect.height);
  const scale = Math.min(PANEL_WIDTH / width, PANEL_HEIGHT / height);
  const columns = clamp(Math.round(width * scale), 1, PANEL_WIDTH);
  const rows = clamp(Math.round(height * scale), 1, PANEL_HEIGHT);
  return {
    // An odd leftover cannot be split, so it goes to the right and the bottom.
    x: Math.floor((PANEL_WIDTH - columns) / 2),
    y: Math.floor((PANEL_HEIGHT - rows) / 2),
    width: columns,
    height: rows,
  };
}

/**
 * Resolves a selection plus a fit mode into the sampling geometry. Split out
 * from pixelizeCrop because the readout has to promise exactly what the
 * generate will do — a chip computed from a second, similar formula is a chip
 * that will one day lie.
 *
 * `rect` is taken to be inside the image, which clampCrop guarantees for every
 * rectangle the UI can produce. A rect hanging off the edge still plans and
 * still renders, but its destination describes the rectangle asked for rather
 * than the smaller one boxSample can actually reach.
 */
export function planPixelize(rect: CropRect, fit: FitMode = "cover"): PixelizePlan {
  const source = fit === "cover" ? coverSource(rect) : rect;
  const destination = fit === "contain"
    ? containDestination(rect)
    : { x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT };
  const sidesDark = destination.width < PANEL_WIDTH;
  const bandsDark = destination.height < PANEL_HEIGHT;
  const shrinkX = extent(source.width) / destination.width;
  const shrinkY = extent(source.height) / destination.height;
  return {
    source,
    destination,
    cropped: source.width + RATIO_EPSILON < rect.width || source.height + RATIO_EPSILON < rect.height,
    padding: sidesDark ? "sides" : bandsDark ? "bands" : "none",
    shrink: {
      x: shrinkX,
      y: shrinkY,
      // A twentieth is below what the readout's one decimal place can show, so
      // agreeing this closely means one number tells the user everything.
      uniform: Math.abs(shrinkX - shrinkY) <= 0.05 * Math.max(shrinkX, shrinkY),
    },
  };
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
 * The grid is `columns × rows`, not always the panel: under "contain" the
 * picture occupies a sub-rectangle, and sampling straight into a 52×16 buffer
 * would feed the dark surround to the tone and sharpen passes — the black bars
 * would set the histogram the picture is stretched against and bleed a halo
 * along its edge.
 *
 * Returns null when the crop covers no opaque pixel at all — a fully
 * transparent region, or a decode that produced nothing. Both would otherwise
 * come out as legitimate-looking black cells.
 */
function boxSample(
  view: PixelView,
  rect: CropRect,
  columns: number,
  rows: number,
): Float32Array | null {
  const out = new Float32Array(columns * rows * 3);
  let coverage = 0;
  // A degenerate rect (a click without a drag, a 1px-tall band) must still
  // produce a frame rather than divide by zero, so both extents get a floor.
  const left = clamp(rect.x, 0, Math.max(0, view.width - 1));
  const top = clamp(rect.y, 0, Math.max(0, view.height - 1));
  const width = clamp(rect.width, 1e-3, Math.max(1e-3, view.width - left));
  const height = clamp(rect.height, 1e-3, Math.max(1e-3, view.height - top));

  for (let cellY = 0; cellY < rows; cellY += 1) {
    const y0 = top + cellY * height / rows;
    const y1 = top + (cellY + 1) * height / rows;
    const pixelY0 = Math.max(0, Math.floor(y0));
    const pixelY1 = Math.min(view.height, Math.max(pixelY0 + 1, Math.ceil(y1)));
    for (let cellX = 0; cellX < columns; cellX += 1) {
      const x0 = left + cellX * width / columns;
      const x1 = left + (cellX + 1) * width / columns;
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
      const offset = (cellY * columns + cellX) * 3;
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

function sharpen(rgb: Float32Array, columns: number, rows: number): Float32Array {
  const kernel = [1, 2, 1];
  const horizontal = new Float32Array(rgb.length);
  const blurred = new Float32Array(rgb.length);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        let weight = 0;
        for (let step = -1; step <= 1; step += 1) {
          const sampleX = clamp(x + step, 0, columns - 1);
          sum += (rgb[(y * columns + sampleX) * 3 + channel] ?? 0) * (kernel[step + 1] ?? 0);
          weight += kernel[step + 1] ?? 0;
        }
        horizontal[(y * columns + x) * 3 + channel] = sum / weight;
      }
    }
  }
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        let weight = 0;
        for (let step = -1; step <= 1; step += 1) {
          const sampleY = clamp(y + step, 0, rows - 1);
          sum += (horizontal[(sampleY * columns + x) * 3 + channel] ?? 0) * (kernel[step + 1] ?? 0);
          weight += kernel[step + 1] ?? 0;
        }
        blurred[(y * columns + x) * 3 + channel] = sum / weight;
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
 * The crop becomes a panel: always exactly 52×16 packed 0xRRGGBB cells, ready
 * to replace the board. No palette snapping — the device path keeps full RGB
 * (see paletteForFrames in src/pixel-ui.ts: a frame under 256 unique colours is
 * carried verbatim), so there is nothing to snap to.
 *
 * Under "contain" the picture occupies only part of that grid and the rest is
 * left at 0. The panel has no alpha channel, so black is the only "off" there
 * is — which is also what the LEDs do with it.
 *
 * Null means "no picture here": an unusable buffer, or a crop over nothing but
 * transparency. The caller must leave the board alone and say so — a black
 * panel reported as a success would silently overwrite the user's artwork.
 */
export function pixelizeCrop(
  view: PixelView,
  rect: CropRect,
  fit: FitMode = "cover",
): number[] | null {
  if (view.width < 1 || view.height < 1 || view.data.length < view.width * view.height * 4) {
    return null;
  }
  const { source, destination } = planPixelize(rect, fit);
  const sampled = boxSample(view, source, destination.width, destination.height);
  if (!sampled) return null;
  const rgb = sharpen(saturate(stretchLevels(sampled)), destination.width, destination.height);
  const pixels = new Array<number>(PANEL_CELLS).fill(0);
  for (let row = 0; row < destination.height; row += 1) {
    for (let column = 0; column < destination.width; column += 1) {
      const offset = (row * destination.width + column) * 3;
      const red = clamp(Math.round(rgb[offset] ?? 0), 0, 255);
      const green = clamp(Math.round(rgb[offset + 1] ?? 0), 0, 255);
      const blue = clamp(Math.round(rgb[offset + 2] ?? 0), 0, 255);
      pixels[(destination.y + row) * PANEL_WIDTH + destination.x + column] =
        (red << 16) | (green << 8) | blue;
    }
  }
  return pixels;
}
