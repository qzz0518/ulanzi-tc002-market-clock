/**
 * Frame bundle format for tc002-os.
 *
 * The official firmware is handed a GIF and decodes it; ours is not, and adding
 * a GIF decoder to a device with ~1 MB free to re-encode pixels we already have
 * as pixels would be pure loss. The bundle is therefore raw RGB with a per-frame
 * delay, which the firmware blits straight into its Surface.
 *
 *   offset  size  field
 *   0       4     magic "TCF1"
 *   4       2     frame count, little endian
 *   6       1     width
 *   7       1     height
 *   8       ...   per frame: u16 LE delayMs, then width*height*3 bytes RGB
 *
 * Little endian because the device is ARM running little endian; the two u8
 * dimensions keep the header at 8 bytes and are validated by the firmware
 * against its own panel rather than trusted.
 */

export const FRAME_BUNDLE_MAGIC = "TCF1";
export const FRAME_BUNDLE_HEADER_BYTES = 8;

export interface FrameSource {
  /** Row-major RGB, width*height*3 bytes. */
  rgb: Uint8Array;
  delayMs: number;
}

/**
 * PixelCanvas stores RGBA; the panel has no alpha channel and the extra byte
 * would be a quarter of the bundle's size for nothing. Dropping it here keeps
 * the conversion in one place rather than open-coded at each call site.
 */
export function rgbaToRgb(rgba: Uint8Array): Uint8Array {
  const pixels = rgba.length / 4;
  const out = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    out[i * 3] = rgba[i * 4]!;
    out[i * 3 + 1] = rgba[i * 4 + 1]!;
    out[i * 3 + 2] = rgba[i * 4 + 2]!;
  }
  return out;
}

export function encodeFrameBundle(
  frames: readonly FrameSource[],
  width: number,
  height: number,
): Uint8Array {
  if (width <= 0 || width > 255 || height <= 0 || height > 255) {
    throw new Error("frame bundle dimensions must fit in a byte");
  }
  if (frames.length > 0xffff) throw new Error("frame bundle holds at most 65535 frames");

  const pixelBytes = width * height * 3;
  for (const frame of frames) {
    if (frame.rgb.length !== pixelBytes) {
      throw new Error(`frame must be exactly ${pixelBytes} RGB bytes`);
    }
  }

  const out = new Uint8Array(FRAME_BUNDLE_HEADER_BYTES + frames.length * (2 + pixelBytes));
  const view = new DataView(out.buffer);
  out[0] = 0x54; // T
  out[1] = 0x43; // C
  out[2] = 0x46; // F
  out[3] = 0x31; // 1
  view.setUint16(4, frames.length, true);
  out[6] = width;
  out[7] = height;

  let offset = FRAME_BUNDLE_HEADER_BYTES;
  for (const frame of frames) {
    // Clamped rather than rejected: a renderer asking for 0 ms would spin the
    // device's play loop, and one asking for a minute is a stuck panel.
    const delay = Math.max(20, Math.min(60_000, Math.round(frame.delayMs)));
    view.setUint16(offset, delay, true);
    offset += 2;
    out.set(frame.rgb, offset);
    offset += pixelBytes;
  }
  return out;
}
