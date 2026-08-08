import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import {
  encodePixelLogoPng,
  MAX_LOGO_DIMENSION,
  processLogoPng,
  renderLogoDevicePreview,
} from "../src/market/pixel-logo.ts";
import type { MarketInstrument } from "../src/market/instruments.ts";

function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): Uint8Array {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const color = pixel(x, y);
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = color[3];
    }
  }
  return new Uint8Array(PNG.sync.write(image));
}

const instrument: MarketInstrument = {
  version: 1,
  ref: "ins_aaaaaaaaaaaaaaaaaaaaaaaa",
  iconRef: `ico_${"1".repeat(32)}`,
  canonicalKey: "crypto:COINBASE:LOGO-USD",
  kind: "crypto",
  displayName: "Logo / US Dollar",
  displaySymbol: "LOGO",
  baseCode: "LOGO",
  quoteCode: "USD",
  decimals: 2,
  changePeriod: "24H",
  routes: [{ provider: "coinbase", symbol: "LOGO-USD" }],
  sourceNote: "test",
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

describe("deterministic catalog PNG logo pipeline", () => {
  test("keeps transparent subjects inside a safe border and emits stable previews", () => {
    const source = png(32, 24, (x, y) =>
      x >= 6 && x < 26 && y >= 3 && y < 21
        ? [28, 137, 255, 255]
        : [0, 0, 0, 0]
    );
    const first = processLogoPng(source);
    const repeated = processLogoPng(source);
    expect(first.sourceSha256).toBe(repeated.sourceSha256);
    expect(first.variants.map((variant) => variant.pixelSha256)).toEqual(
      repeated.variants.map((variant) => variant.pixelSha256),
    );
    const balanced = first.variants.find((variant) => variant.id === "balanced")!;
    expect(balanced.bitmap.pixels[(0 * 16 + 0) * 4 + 3]).toBe(0);
    expect(balanced.bitmap.pixels[(15 * 16 + 15) * 4 + 3]).toBe(0);
    expect(balanced.foregroundPixels).toBeGreaterThan(80);
    expect(balanced.paletteSize).toBe(1);

    const encoded = PNG.sync.read(Buffer.from(encodePixelLogoPng(balanced.bitmap)));
    expect([encoded.width, encoded.height]).toEqual([16, 16]);
    const frame = PNG.sync.read(Buffer.from(renderLogoDevicePreview(balanced.bitmap, instrument)));
    expect([frame.width, frame.height]).toEqual([52, 16]);
  });

  test("removes only an edge-connected flat background and retains a preserve-background choice", () => {
    const source = png(40, 40, (x, y) =>
      x >= 11 && x <= 28 && y >= 7 && y <= 32
        ? [230, 40, 80, 255]
        : [255, 255, 255, 255]
    );
    const processed = processLogoPng(source);
    const balanced = processed.variants.find((variant) => variant.id === "balanced")!;
    const background = processed.variants.find((variant) => variant.id === "background")!;
    expect(balanced.backgroundRemoved).toBe(true);
    expect(balanced.bitmap.pixels[3]).toBe(0);
    expect(background.backgroundRemoved).toBe(false);
    expect(background.bitmap.pixels[(1 * 16 + 1) * 4 + 3]).toBe(255);
    expect(background.paletteSize).toBeGreaterThan(1);
  });

  test("lifts a dark catalog mark so it remains visible on the true-black display", () => {
    const source = png(32, 32, (x, y) =>
      x >= 5 && x < 27 && y >= 5 && y < 27
        ? [4, 7, 10, 255]
        : [0, 0, 0, 0]
    );
    const compact = processLogoPng(source).variants.find((variant) => variant.id === "compact")!;
    const visibleLuminance: number[] = [];
    for (let offset = 0; offset < compact.bitmap.pixels.length; offset += 4) {
      if (compact.bitmap.pixels[offset + 3] === 0) continue;
      visibleLuminance.push(
        compact.bitmap.pixels[offset]! * 0.2126
        + compact.bitmap.pixels[offset + 1]! * 0.7152
        + compact.bitmap.pixels[offset + 2]! * 0.0722,
      );
    }
    const average = visibleLuminance.reduce((sum, value) => sum + value, 0) / visibleLuminance.length;
    expect(average).toBeGreaterThanOrEqual(64);
  });

  test("rejects invalid signatures and dimensions before decoding", () => {
    expect(() => processLogoPng(new Uint8Array(64))).toThrow("PNG signature");
    const source = png(1, 1, () => [255, 0, 0, 255]);
    const oversized = new Uint8Array(source);
    const width = MAX_LOGO_DIMENSION + 1;
    oversized[16] = (width >>> 24) & 0xff;
    oversized[17] = (width >>> 16) & 0xff;
    oversized[18] = (width >>> 8) & 0xff;
    oversized[19] = width & 0xff;
    expect(() => processLogoPng(oversized)).toThrow("dimensions");
  });
});
