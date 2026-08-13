/**
 * The dominant colour of a cover, for the mini player's frosted backdrop.
 *
 * Two halves on purpose: `dominantColorFromPixels` is arithmetic over an RGBA
 * buffer and is unit-tested, while `readCoverTint` is the twenty lines that need
 * a DOM. Everything that can be got wrong — near-white and near-black being
 * excluded, saturation winning ties, the fallback when a cover has no colour at
 * all — lives in the half a test can reach.
 *
 * Sampling is safe because covers are same-origin: they arrive through
 * /api/music/art, so the canvas is never tainted and `getImageData` works. A
 * remote CDN URL would throw here, which is one more reason the proxy exists.
 */

export interface CoverTint {
  /** `r g b`, SPACE-separated: rgb(var(--tint) / a) needs the modern syntax,
   * and a comma triple makes every alpha-carrying declaration invalid at
   * computed-value time — the cascade keeps it, the renderer drops it. */
  rgb: string;
  /** True when the artwork is dark enough that light type reads better on it. */
  dark: boolean;
}

/** Sample grid. 16x16 is 256 pixels: enough to find a colour, cheap to decode. */
const SAMPLE = 16;

// Below this the pixel is nearly black and above it nearly white; both are
// everywhere in album art (borders, blown highlights, letterboxing) and both
// would drag the average towards grey, which is the one result that makes a
// tinted panel look broken rather than tinted.
const MIN_LUMA = 26;
const MAX_LUMA = 232;

/** Rec. 601 luma, which is what "how bright does this look" means here. */
function luma(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}

/** 0..1, how far the pixel is from grey. Saturated pixels carry the identity. */
function saturation(red: number, green: number, blue: number): number {
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  return high === 0 ? 0 : (high - low) / high;
}

/**
 * Weighted mean of the pixels worth counting, with saturation as the weight.
 *
 * A plain average of a photograph is always mud. Weighting by saturation lets
 * the one strong colour in a mostly-grey cover win, which is what a person
 * would name if you asked them the colour of the sleeve.
 */
export function dominantColorFromPixels(pixels: ArrayLike<number>): CoverTint {
  let red = 0;
  let green = 0;
  let blue = 0;
  let weight = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 0;
    if (alpha < 128) continue;
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    const light = luma(r, g, b);
    if (light < MIN_LUMA || light > MAX_LUMA) continue;
    // +0.12 so a fully desaturated cover still produces its own grey rather
    // than dividing by zero and falling back to the theme's.
    const pixelWeight = saturation(r, g, b) + 0.12;
    red += r * pixelWeight;
    green += g * pixelWeight;
    blue += b * pixelWeight;
    weight += pixelWeight;
  }
  if (weight === 0) return { rgb: "120 120 120", dark: false };
  const out = [red / weight, green / weight, blue / weight].map((channel) =>
    Math.max(0, Math.min(255, Math.round(channel)))
  ) as [number, number, number];
  return { rgb: out.join(" "), dark: luma(out[0], out[1], out[2]) < 128 };
}

/** Reads the tint off a loaded, same-origin image. Null if it cannot be read. */
export function readCoverTint(image: HTMLImageElement): CoverTint | null {
  if (!image.naturalWidth || !image.naturalHeight) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    return dominantColorFromPixels(context.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } catch {
    // A tainted canvas throws here. The widget keeps its untinted look rather
    // than the page losing a player over a colour.
    return null;
  }
}
