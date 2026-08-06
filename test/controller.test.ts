import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.ts";
import { DashboardController } from "../src/controller.ts";
import { MarketDataClient, type AssetMarketData, type FetchLike } from "../src/price.ts";
import { DEFAULT_SETTINGS, SettingsStore } from "../src/settings.ts";

const NOW = Date.parse("2026-08-06T06:00:00.000Z");
const TEST_CONFIG_ENV = { CLOCK_HOST: "tc002.test" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function fixtureFetcher(): FetchLike {
  return async (input) => {
    const url = String(input);
    if (url.includes("BTC-USD/ticker")) {
      return json({ price: "64831", time: "2026-08-06T05:59:50.000Z" });
    }
    if (url.includes("BTC-USD/stats")) return json({ open: "64000" });
    if (url.includes("price/XAU")) {
      return json({ price: 4254.2, updatedAt: "2026-08-06T05:59:55Z" });
    }
    return json({}, 503);
  };
}

describe("DashboardController", () => {
  test("renders selected assets, computes an effective interval, and pushes once", async () => {
    const payloads: unknown[] = [];
    const settings = {
      ...DEFAULT_SETTINGS,
      assets: ["btc", "gold"] as ("btc" | "gold")[],
    };
    const controller = new DashboardController({
      config: loadConfig(TEST_CONFIG_ENV),
      settings,
      settingsStore: new SettingsStore(join(tmpdir(), `not-written-${process.pid}.json`)),
      marketClient: new MarketDataClient({
        fetcher: fixtureFetcher(),
        timeoutMs: 100,
        now: () => NOW,
      }),
      pushPayload: async (payload) => {
        payloads.push(payload);
        return { status: 200 };
      },
      now: () => NOW,
    });

    const state = await controller.pushNow("manual");
    expect(payloads).toHaveLength(1);
    expect(state.healthy).toBe(true);
    expect(state.pushing).toBe(false);
    expect(state.assets.map((asset) => asset.assetId)).toEqual(["btc", "gold"]);
    expect(state.animationDurationMs).toBe(27_500);
    expect(state.effectiveRefreshIntervalMs).toBe(27_500);
  });

  test("keeps a healthy subset when one selected asset fails", async () => {
    const fakeClient = {
      async getAsset(assetId: "btc" | "eth"): Promise<AssetMarketData> {
        if (assetId === "eth") throw new Error("ETH is unavailable");
        return {
          assetId: "btc",
          provider: "coinbase",
          price: 64_831,
          rawPrice: "64831",
          fetchedAt: new Date(NOW).toISOString(),
          changePercent: 1,
          changePeriod: "24H",
        };
      },
    };
    const controller = new DashboardController({
      config: loadConfig(TEST_CONFIG_ENV),
      settings: { ...DEFAULT_SETTINGS, assets: ["btc", "eth"] },
      settingsStore: new SettingsStore(join(tmpdir(), `not-written-subset-${process.pid}.json`)),
      marketClient: fakeClient as MarketDataClient,
      pushPayload: async () => ({ status: 200 }),
      now: () => NOW,
    });
    const state = await controller.pushNow("scheduled");
    expect(state.assets.map((asset) => asset.assetId)).toEqual(["btc"]);
    expect(state.degraded).toBe(true);
    expect(state.assetErrors.eth).toContain("unavailable");
  });
});
