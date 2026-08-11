import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  CONTENT_DEFINITIONS,
  createDefaultContentItem,
  getContentCatalog,
} from "../src/content-registry.ts";
import { getStockIconPng } from "../src/stock-icons.ts";
import type { AssetMarketData } from "../src/price.ts";
import { PixelCanvas } from "../src/pixel-ui.ts";
import { renderInstrumentFallbackIcon } from "../src/market/fallback-icon.ts";

describe("built-in content registry", () => {
  test("ships all market, tool, visual, and creative content through one renderer contract", async () => {
    const context = {
      nowMs: Date.parse("2026-08-06T06:00:00Z"),
      forceRefresh: false,
      async getMarket(assetId: AssetMarketData["assetId"]): Promise<AssetMarketData> {
        return {
          assetId,
          provider: assetId === "aapl" || assetId === "msft" || assetId === "nvda" || assetId === "googl"
            ? "yahoo"
            : "coinbase",
          price: 233.19,
          rawPrice: "233.19",
          fetchedAt: "2026-08-06T06:00:00Z",
          changePercent: 1.25,
          changePeriod: "1D",
        };
      },
      async getInstrumentMarket() {
        const instrument = {
          version: 1 as const,
          ref: "ins_aaaaaaaaaaaaaaaaaaaaaaaa",
          iconRef: `ico_${"1".repeat(32)}`,
          canonicalKey: "crypto:COINBASE:ABC-USD",
          kind: "crypto" as const,
          displayName: "ABC / US Dollar",
          displaySymbol: "ABC",
          baseCode: "ABC",
          quoteCode: "USD",
          decimals: 2,
          changePeriod: "24H" as const,
          routes: [{ provider: "coinbase" as const, symbol: "ABC-USD" }],
          sourceNote: "Fixture.",
          createdAt: "2026-08-06T06:00:00Z",
          updatedAt: "2026-08-06T06:00:00Z",
        };
        return {
          instrument,
          market: {
            instrumentRef: instrument.ref,
            provider: "coinbase" as const,
            price: 12.34,
            rawPrice: "12.34",
            fetchedAt: "2026-08-06T06:00:00Z",
            changePercent: 2.5,
            changePeriod: "24H" as const,
          },
          icon: renderInstrumentFallbackIcon(instrument),
        };
      },
      async getWeather(latitude: number, longitude: number) {
        return {
          latitude,
          longitude,
          condition: "rain" as const,
          weatherCode: 61,
          temperatureC: 18.4,
          precipitationMm: 1.2,
          cloudCoverPercent: 88,
          fetchedAt: "2026-08-06T06:00:00Z",
        };
      },
      async getPixelAsset(_assetRef: string, durationMs: number) {
        return {
          metadata: {
            version: 1 as const,
            ref: "0".repeat(64),
            officialId: "1091",
            title: "Fixture",
            author: "Tester",
            sourceUrl: "https://ugc.ulanzistudio.com/contentView/1091",
            mimeType: "image/png" as const,
            frameCount: 1,
            nativeDurationMs: 0,
            importedAt: "2026-08-06T06:00:00Z",
          },
          frames: [new PixelCanvas(52, 16)],
          frameDelaysMs: [durationMs],
        };
      },
    };
    expect(CONTENT_DEFINITIONS).toHaveLength(31);
    expect(new Set(getContentCatalog().map((entry) => entry.category))).toEqual(
      new Set(["market", "tools", "visual", "creative"]),
    );
    for (const definition of CONTENT_DEFINITIONS) {
      const item = createDefaultContentItem(definition.id);
      item.durationMs = 1_000;
      const rendered = await definition.render(context, item);
      expect(rendered.frames.length).toBeGreaterThan(0);
      expect(rendered.frames.length).toBe(rendered.frameDelaysMs.length);
      expect(rendered.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(1_000);
      expect(rendered.frames.every((frame) => frame.width === 52 && frame.height === 16)).toBe(true);
    }
  });

  test("routes flux palette and burst options through the registry whitelist", async () => {
    const context = {
      nowMs: Date.parse("2026-08-06T06:00:00Z"),
      forceRefresh: false,
      async getMarket(): Promise<never> { throw new Error("unused"); },
      async getInstrumentMarket(): Promise<never> { throw new Error("unused"); },
      async getWeather(): Promise<never> { throw new Error("unused"); },
      async getPixelAsset(): Promise<never> { throw new Error("unused"); },
    };
    const definition = CONTENT_DEFINITIONS.find((entry) => entry.id === "visual:flux")!;
    const bytes = async (options: Record<string, string>) => {
      const item = createDefaultContentItem(definition.id);
      item.durationMs = 4_000;
      item.options = { ...item.options, ...options };
      const rendered = await definition.render(context, item);
      return rendered.frames.map((frame) => Buffer.from(frame.pixels).toString("base64")).join("|");
    };
    const defaults = await bytes({});
    expect(await bytes({ fluxPalette: "ember" })).not.toBe(defaults);
    expect(await bytes({ fluxBurst: "never" })).not.toBe(defaults);
    // Unknown values must fall back to the defaults instead of leaking through.
    expect(await bytes({ fluxPalette: "chartreuse", fluxBurst: "sometimes" })).toBe(defaults);
  });

  test("preserves the exact four upstream stock PNG byte streams", () => {
    const expected = {
      aapl: "da282197f269bae31b56995c74dba6ee0b03da4da7dffd8ec836c3a88a21f1f0",
      msft: "1d68ff4849741622ac5fd3d922bc602893e4cdb97fa3532835eb3aa2d7c4b3de",
      nvda: "11c4324008c049aaf9d4a9d15d335b9be65403dd1af6daa595a817a276685021",
      googl: "438e777d006c32ea5124152d5e430d43529cbeb58d34fc36c2dc27760a21a096",
    } as const;
    for (const [id, hash] of Object.entries(expected)) {
      expect(createHash("sha256").update(getStockIconPng(id as keyof typeof expected)).digest("hex"))
        .toBe(hash);
    }
  });
});
