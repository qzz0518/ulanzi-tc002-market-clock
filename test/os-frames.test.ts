import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFrameBundle, rgbaToRgb, FRAME_BUNDLE_HEADER_BYTES } from "../src/os-frames.ts";

const W = 52;
const H = 16;
const PIXEL_BYTES = W * H * 3;

function patternFrame(n: number): Uint8Array {
  const rgb = new Uint8Array(PIXEL_BYTES);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      rgb[i] = (x * 5 + n) & 0xff;
      rgb[i + 1] = (y * 17 + n * 2) & 0xff;
      rgb[i + 2] = ((x + y) * 3 + n * 4) & 0xff;
    }
  }
  return rgb;
}

describe("tc002-os frame bundle", () => {
  test("lays the header out exactly as the firmware reads it", () => {
    const bundle = encodeFrameBundle([{ rgb: patternFrame(0), delayMs: 100 }], W, H);
    expect(bundle.length).toBe(FRAME_BUNDLE_HEADER_BYTES + 2 + PIXEL_BYTES);
    expect(String.fromCharCode(...bundle.slice(0, 4))).toBe("TCF1");
    expect(bundle[4]! | (bundle[5]! << 8)).toBe(1); // little endian count
    expect(bundle[6]).toBe(W);
    expect(bundle[7]).toBe(H);
    expect(bundle[8]! | (bundle[9]! << 8)).toBe(100);
  });

  test("clamps delays instead of trusting a renderer", () => {
    // 0 ms would spin the device's play loop; a minute is a stuck panel.
    const bundle = encodeFrameBundle(
      [
        { rgb: patternFrame(0), delayMs: 0 },
        { rgb: patternFrame(1), delayMs: 999_999 },
      ],
      W,
      H,
    );
    const first = bundle[8]! | (bundle[9]! << 8);
    const secondAt = FRAME_BUNDLE_HEADER_BYTES + 2 + PIXEL_BYTES;
    const second = bundle[secondAt]! | (bundle[secondAt + 1]! << 8);
    expect(first).toBe(20);
    expect(second).toBe(60_000);
  });

  test("rejects frames that are not exactly one panel", () => {
    expect(() => encodeFrameBundle([{ rgb: new Uint8Array(10), delayMs: 50 }], W, H))
      .toThrow("RGB bytes");
    expect(() => encodeFrameBundle([], 300, 16)).toThrow("fit in a byte");
  });

  test("drops the alpha channel PixelCanvas carries", () => {
    // The panel has no alpha and the extra byte would be a quarter of the
    // bundle for nothing.
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 128]);
    expect(Array.from(rgbaToRgb(rgba))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("still produces the exact bytes the firmware's decoder is tested against", () => {
    // device/tc002-os/hostcheck/fixtures/frames.bin is decoded by the C++
    // self-check. Asserting it here is what stops the two from drifting into a
    // mismatch that would only show up as a torn panel on hardware.
    const bundle = encodeFrameBundle(
      [0, 1, 2].map((n) => ({ rgb: patternFrame(n), delayMs: 40 + n * 30 })),
      W,
      H,
    );
    const fixture = readFileSync(
      join(import.meta.dir, "../device/tc002-os/hostcheck/fixtures/frames.bin"),
    );
    expect(Buffer.from(bundle).equals(fixture)).toBe(true);
  });
});
