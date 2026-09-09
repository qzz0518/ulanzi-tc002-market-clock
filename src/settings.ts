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
