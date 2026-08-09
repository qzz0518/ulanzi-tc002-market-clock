import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { ASSET_IDS, getAssetPreset, isAssetId, type AssetId } from "./assets.ts";

export interface DashboardSettings {
  assets: AssetId[];
  priceDurationMs: number;
  changeDurationMs: number;
  refreshIntervalMs: number;
  showChange: boolean;
}

export const DEFAULT_SETTINGS: DashboardSettings = {
  assets: ["btc"],
  priceDurationMs: 12_500,
  changeDurationMs: 2_500,
  refreshIntervalMs: 15_000,
  showChange: true,
};

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

function migrateSavedSettings(value: unknown): { value: unknown; migrated: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { value, migrated: false };
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.assets) || !input.assets.includes("usdjpy")) {
    return { value, migrated: false };
  }
  return {
    value: {
      ...input,
      assets: input.assets.map((asset) => asset === "usdjpy" ? "usdcny" : asset),
    },
    migrated: true,
  };
}

function validateDuration(
  name: string,
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum ||
    value % 100 !== 0
  ) {
    throw new SettingsValidationError(
      `${name} must be a whole number of milliseconds, in 100ms steps, between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function validateSettings(value: unknown): DashboardSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SettingsValidationError("settings must be an object");
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.assets) || input.assets.length < 1) {
    throw new SettingsValidationError("select at least one asset");
  }
  if (input.assets.length > ASSET_IDS.length || !input.assets.every(isAssetId)) {
    throw new SettingsValidationError("settings contain an unknown asset");
  }
  const assets = [...new Set(input.assets as AssetId[])];
  if (assets.length !== input.assets.length) {
    throw new SettingsValidationError("each asset can only be selected once");
  }
  if (typeof input.showChange !== "boolean") {
    throw new SettingsValidationError("showChange must be true or false");
  }
  return {
    assets,
    priceDurationMs: validateDuration("priceDurationMs", input.priceDurationMs, 1_000, 60_000),
    changeDurationMs: validateDuration("changeDurationMs", input.changeDurationMs, 500, 30_000),
    refreshIntervalMs: validateDuration(
      "refreshIntervalMs",
      input.refreshIntervalMs,
      10_000,
      900_000,
    ),
    showChange: input.showChange,
  };
}

export function maximumAnimationDurationMs(settings: DashboardSettings): number {
  const changeFrames = settings.showChange
    ? settings.assets.filter((id) => getAssetPreset(id).changePeriod !== undefined).length
    : 0;
  return settings.assets.length * settings.priceDurationMs
    + changeFrames * settings.changeDurationMs;
}

export class SettingsStore {
  constructor(readonly path: string) {}

  async load(): Promise<DashboardSettings> {
    try {
      const json = await readFile(this.path, "utf8");
      const migration = migrateSavedSettings(JSON.parse(json));
      const settings = validateSettings(migration.value);
      return migration.migrated ? this.save(settings) : settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(DEFAULT_SETTINGS);
      }
      if (error instanceof SyntaxError) {
        throw new SettingsValidationError("saved settings contain invalid JSON");
      }
      throw error;
    }
  }

  async save(value: DashboardSettings): Promise<DashboardSettings> {
    const settings = validateSettings(value);
    await mkdir(dirname(this.path), { recursive: true });
    // tmp 名必须逐次唯一：同一进程里并发写会共用 `pid` 后缀，先落地的那次 rename
    // 会把文件抢走，后一次就撞上 ENOENT（Spotify 令牌刷新最容易触发）。
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await Bun.write(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(temporaryPath, this.path);
    return settings;
  }
}
