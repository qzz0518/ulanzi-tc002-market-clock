import { describe, expect, test } from "bun:test";
import { ASSET_IDS, ASSET_PRESETS, getAssetPreset, isAssetId } from "../src/assets.ts";
import {
  DEFAULT_SETTINGS,
  maximumAnimationDurationMs,
  validateSettings,
} from "../src/settings.ts";

describe("asset presets", () => {
  test("defines ten unique, addressable presets including the four migrated stocks", () => {
    expect(ASSET_PRESETS.map((preset) => preset.id)).toEqual([...ASSET_IDS]);
    expect(new Set(ASSET_PRESETS.map((preset) => preset.id)).size).toBe(10);
    expect(isAssetId("usdcny")).toBe(true);
    expect(isAssetId("usdjpy")).toBe(false);
    expect(isAssetId("doge")).toBe(false);
    expect(getAssetPreset("gold").changePeriod).toBeUndefined();
    expect(getAssetPreset("aapl")).toMatchObject({ kind: "stock", yahooSymbol: "AAPL" });
  });
});

describe("dashboard settings", () => {
  test("validates multi-asset selection and computes the full animation", () => {
    const settings = validateSettings({
      assets: ["btc", "gold", "usdcny"],
      priceDurationMs: 12_500,
      changeDurationMs: 2_500,
      refreshIntervalMs: 15_000,
      showChange: true,
    });
    expect(settings.assets).toEqual(["btc", "gold", "usdcny"]);
    expect(maximumAnimationDurationMs(settings)).toBe(42_500);
  });

  test("rejects empty, duplicate, unknown, and sub-100ms settings", () => {
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, assets: [] })).toThrow();
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, assets: ["btc", "btc"] })).toThrow();
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, assets: ["doge"] })).toThrow();
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, priceDurationMs: 12_550 })).toThrow();
  });
});
