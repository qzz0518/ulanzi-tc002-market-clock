import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { ASSET_IDS } from "../src/assets.ts";
import { buildImagePayload } from "../src/display.ts";
import {
  createPreviewStrip,
  createScaledPreview,
  formatAssetValue,
  renderAssetIconTile,
  renderDashboard,
  renderOfflineDashboard,
} from "../src/pixel-ui.ts";
import type { AssetMarketData } from "../src/price.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

const markets: AssetMarketData[] = [
  {
    assetId: "btc",
    provider: "coinbase",
    price: 64_831.26,
    rawPrice: "64831.26",
    fetchedAt: "2026-08-06T06:00:00.000Z",
    changePercent: 1.2988,
    changePeriod: "24H",
  },
  {
    assetId: "eth",
    provider: "coinbase",
    price: 1_911.14,
    rawPrice: "1911.14",
    fetchedAt: "2026-08-06T06:00:00.000Z",
    changePercent: 2.2,
    changePeriod: "24H",
  },
  {
    assetId: "bnb",
    provider: "coinbase",
    price: 594.64,
    rawPrice: "594.64",
    fetchedAt: "2026-08-06T06:00:00.000Z",
    changePercent: -0.9,
    changePeriod: "24H",
  },
  {
    assetId: "sol",
    provider: "coinbase",
    price: 73.96,
    rawPrice: "73.96",
    fetchedAt: "2026-08-06T06:00:00.000Z",
    changePercent: 0.5,
    changePeriod: "24H",
  },
  {
    assetId: "gold",
    provider: "gold-api",
    price: 4_254.2,
    rawPrice: "4254.2",
    fetchedAt: "2026-08-06T06:00:00.000Z",
  },
  {
    assetId: "usdcny",
    provider: "frankfurter",
    price: 7.182,
    rawPrice: "7.182",
    fetchedAt: "2026-08-06T06:00:00.000Z",
    changePercent: -0.025,
    changePeriod: "1D",
  },
];

function readGifFrameDelaysMs(gif: Uint8Array): number[] {
  const delays: number[] = [];
  for (let index = 0; index <= gif.length - 8; index += 1) {
    if (gif[index] !== 0x21 || gif[index + 1] !== 0xf9 || gif[index + 2] !== 0x04) {
      continue;
    }
    delays.push((gif[index + 4]! | (gif[index + 5]! << 8)) * 10);
  }
  return delays;
}

function iconTopology(assetId: (typeof ASSET_IDS)[number]): {
  litPixels: number;
  components: number;
  colors: number;
} {
  const canvas = renderAssetIconTile(assetId);
  const isLit = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
    const offset = (y * canvas.width + x) * 4;
    return canvas.pixels[offset] !== 0
      || canvas.pixels[offset + 1] !== 0
      || canvas.pixels[offset + 2] !== 0;
  };
  const seen = new Set<string>();
  const colors = new Set<string>();
  let litPixels = 0;
  let components = 0;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (!isLit(x, y)) continue;
      litPixels += 1;
      const offset = (y * canvas.width + x) * 4;
      colors.add([
        canvas.pixels[offset],
        canvas.pixels[offset + 1],
        canvas.pixels[offset + 2],
      ].join(","));

      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      components += 1;
      const queue: Array<readonly [number, number]> = [[x, y]];
      seen.add(key);
      while (queue.length > 0) {
        const [currentX, currentY] = queue.pop()!;
        for (const [deltaX, deltaY] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nextX = currentX + deltaX;
          const nextY = currentY + deltaY;
          const nextKey = `${nextX},${nextY}`;
          if (!isLit(nextX, nextY) || seen.has(nextKey)) continue;
          seen.add(nextKey);
          queue.push([nextX, nextY]);
        }
      }
    }
  }

  return { litPixels, components, colors: colors.size };
}

describe("TC002 multi-asset pixel dashboard", () => {
  test("uses asset-specific precision that fits the physical display", () => {
    expect(formatAssetValue("btc", 64_831.26)).toBe("64831");
    expect(formatAssetValue("eth", 1_911.14)).toBe("1911.1");
    expect(formatAssetValue("bnb", 594.64)).toBe("594.6");
    expect(formatAssetValue("sol", 73.96)).toBe("73.96");
    expect(formatAssetValue("usdcny", 7.1824)).toBe("7.182");
  });

  test("renders six unique display-safe icon designs on true black", () => {
    const hashes = ASSET_IDS.map((assetId) => {
      const canvas = renderAssetIconTile(assetId);
      expect(canvas.width).toBe(16);
      expect(canvas.height).toBe(16);
      expect([...canvas.pixels.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
      expect(canvas.pixels.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
      return createHash("sha256").update(canvas.pixels).digest("hex");
    });
    expect(new Set(hashes).size).toBe(ASSET_IDS.length);
  });

  test("keeps each redesigned symbol's deliberate pixel topology", () => {
    expect(iconTopology("eth")).toEqual({ litPixels: 156, components: 1, colors: 4 });
    expect(iconTopology("bnb")).toEqual({ litPixels: 156, components: 1, colors: 2 });
    expect(iconTopology("sol")).toEqual({ litPixels: 81, components: 3, colors: 3 });
    expect(iconTopology("gold")).toEqual({ litPixels: 84, components: 1, colors: 3 });
    expect(iconTopology("usdcny")).toEqual({ litPixels: 60, components: 10, colors: 2 });
  });

  test("renders selected assets in order with per-page timings", () => {
    const frame = renderDashboard(markets, {
      ...DEFAULT_SETTINGS,
      assets: ["btc", "gold", "usdcny"],
    });
    expect(frame.assetIds).toEqual(["btc", "gold", "usdcny"]);
    expect(frame.frames).toHaveLength(5);
    expect(frame.frameDelaysMs).toEqual([12_500, 2_500, 12_500, 12_500, 2_500]);
    expect(frame.animationDurationMs).toBe(42_500);
    expect(frame.mimeType).toBe("image/gif");
    expect(Buffer.from(frame.image.subarray(0, 6)).toString("ascii")).toBe("GIF89a");
    expect(readGifFrameDelaysMs(frame.image)).toEqual([...frame.frameDelaysMs]);
  });

  test("creates a static PNG when the only asset has no change frame", () => {
    const frame = renderDashboard(markets, {
      ...DEFAULT_SETTINGS,
      assets: ["gold"],
    });
    expect(frame.frames).toHaveLength(1);
    expect(frame.mimeType).toBe("image/png");
    expect([...frame.image.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("wraps the generated image in the official TC002 payload", () => {
    const frame = renderDashboard(markets, DEFAULT_SETTINGS);
    const payload = buildImagePayload(frame.image, frame.mimeType, 90);
    expect(payload).toMatchObject({
      duration: 90,
      text: [],
      image: [{ position: [0, 0] }],
      draw: [],
    });
    expect(payload.image[0]?.data.startsWith("data:image/gif;base64,")).toBe(true);
  });

  test("creates nearest-neighbor previews for visual QA", () => {
    const frame = renderDashboard(markets, { ...DEFAULT_SETTINGS, assets: ["eth"] });
    const preview = createScaledPreview(frame.frames[0]!, 12);
    const strip = createPreviewStrip(frame.frames, 2, 4);
    expect([...preview.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([...strip.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("keeps a dedicated offline indicator", () => {
    expect(renderOfflineDashboard().label).toBe("OFFLINE");
  });
});
