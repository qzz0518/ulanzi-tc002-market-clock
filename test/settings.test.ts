import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ASSET_IDS, ASSET_PRESETS, getAssetPreset, isAssetId } from "../src/assets.ts";
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  maximumAnimationDurationMs,
  validateSettings,
  type DashboardSettings,
} from "../src/settings.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("asset presets", () => {
  test("defines six unique, addressable presets", () => {
    expect(ASSET_PRESETS.map((preset) => preset.id)).toEqual([...ASSET_IDS]);
    expect(new Set(ASSET_PRESETS.map((preset) => preset.id)).size).toBe(6);
    expect(isAssetId("usdcny")).toBe(true);
    expect(isAssetId("usdjpy")).toBe(false);
    expect(isAssetId("doge")).toBe(false);
    expect(getAssetPreset("gold").changePeriod).toBeUndefined();
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

  test("persists settings atomically and falls back only when absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-settings-"));
    temporaryDirectories.push(directory);
    const store = new SettingsStore(join(directory, "nested", "settings.json"));
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
    const settings: DashboardSettings = { ...DEFAULT_SETTINGS, assets: ["eth", "sol"] };
    await store.save(settings);
    expect(await store.load()).toEqual(settings);
  });

  test("migrates the retired USD/JPY preset to USD/CNY when loading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-settings-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "settings.json");
    await Bun.write(path, JSON.stringify({ ...DEFAULT_SETTINGS, assets: ["usdjpy"] }));
    const store = new SettingsStore(path);
    expect((await store.load()).assets).toEqual(["usdcny"]);
    expect(JSON.parse(await readFile(path, "utf8")).assets).toEqual(["usdcny"]);
  });
});
