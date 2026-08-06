import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { getAssetPreset, isAssetId, type AssetId } from "./assets.ts";
import {
  DEFAULT_SETTINGS,
  SettingsValidationError,
  validateSettings,
  type DashboardSettings,
} from "./settings.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ContentItemConfig {
  id: string;
  contentId: string;
  durationMs: number;
  options: Record<string, JsonValue>;
}

export interface ChannelConfig {
  id: string;
  name: string;
  appName: string;
  enabled: boolean;
  refreshIntervalMs: number;
  items: ContentItemConfig[];
}

export interface WorkspaceSettings {
  version: 3;
  channels: ChannelConfig[];
}

export const WORKSPACE_LIMITS = {
  maxChannels: 24,
  maxItemsPerChannel: 48,
  maxCanvasPixels: 52 * 16,
  maxFramesPerChannel: 360,
  maxRequestBytes: 256 * 1024,
} as const;

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const APP_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new SettingsValidationError(
      `${name} must contain 1-64 ASCII letters, numbers, underscores, or hyphens`,
    );
  }
  return value;
}

function validateLabel(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new SettingsValidationError(`${name} must be a string`);
  }
  const label = value.trim();
  if (label.length < 1 || label.length > 48) {
    throw new SettingsValidationError(`${name} must contain 1-48 characters`);
  }
  return label;
}

function validateAppName(value: unknown): string {
  if (typeof value !== "string" || !APP_NAME_PATTERN.test(value.trim())) {
    throw new SettingsValidationError(
      "appName must contain 1-32 ASCII letters, numbers, underscores, or hyphens",
    );
  }
  return value.trim();
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
      `${name} must be an integer in 100ms steps between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function cloneJsonObject(name: string, value: unknown): Record<string, JsonValue> {
  const input = record(value);
  if (!input) throw new SettingsValidationError(`${name} must be an object`);
  try {
    const json = JSON.stringify(input);
    if (json === undefined) throw new Error("not serializable");
    const parsed = JSON.parse(json) as unknown;
    const cloned = record(parsed);
    if (!cloned) throw new Error("not an object");
    return cloned as Record<string, JsonValue>;
  } catch {
    throw new SettingsValidationError(`${name} must contain JSON-compatible values`);
  }
}

export function createContentItem(
  contentId: string,
  durationMs = 15_000,
  options: Record<string, JsonValue> = {},
  id = `item_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
): ContentItemConfig {
  return { id, contentId, durationMs, options: structuredClone(options) };
}

export function createDefaultWorkspace(appName = "btc"): WorkspaceSettings {
  return {
    version: 3,
    channels: [
      {
        id: "market",
        name: "市场轮播",
        appName,
        enabled: true,
        refreshIntervalMs: 15_000,
        items: [
          createContentItem(
            "market:btc",
            DEFAULT_SETTINGS.priceDurationMs + DEFAULT_SETTINGS.changeDurationMs,
            {
              showChange: DEFAULT_SETTINGS.showChange,
              changeDurationMs: DEFAULT_SETTINGS.changeDurationMs,
            },
            "market_btc",
          ),
        ],
      },
    ],
  };
}

function validateItem(value: unknown, channelIndex: number, itemIndex: number): ContentItemConfig {
  const input = record(value);
  if (!input) throw new SettingsValidationError("each channel item must be an object");
  const prefix = `channels[${channelIndex}].items[${itemIndex}]`;
  const contentId = typeof input.contentId === "string" ? input.contentId.trim() : "";
  if (!/^[a-z][a-z0-9-]*:[a-z0-9-]{1,48}$/.test(contentId)) {
    throw new SettingsValidationError(`${prefix}.contentId is invalid`);
  }
  return {
    id: validateIdentifier(`${prefix}.id`, input.id),
    contentId,
    durationMs: validateDuration(`${prefix}.durationMs`, input.durationMs, 500, 900_000),
    options: cloneJsonObject(`${prefix}.options`, input.options),
  };
}

function validateChannel(value: unknown, index: number): ChannelConfig {
  const input = record(value);
  if (!input) throw new SettingsValidationError("each channel must be an object");
  if (typeof input.enabled !== "boolean") {
    throw new SettingsValidationError(`channels[${index}].enabled must be true or false`);
  }
  if (!Array.isArray(input.items) || input.items.length < 1) {
    throw new SettingsValidationError(`channels[${index}] must contain at least one item`);
  }
  if (input.items.length > WORKSPACE_LIMITS.maxItemsPerChannel) {
    throw new SettingsValidationError(
      `channels[${index}] may contain at most ${WORKSPACE_LIMITS.maxItemsPerChannel} items`,
    );
  }
  const items = input.items.map((item, itemIndex) => validateItem(item, index, itemIndex));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new SettingsValidationError(`channels[${index}] contains duplicate item ids`);
  }
  return {
    id: validateIdentifier(`channels[${index}].id`, input.id),
    name: validateLabel(`channels[${index}].name`, input.name),
    appName: validateAppName(input.appName),
    enabled: input.enabled,
    refreshIntervalMs: validateDuration(
      `channels[${index}].refreshIntervalMs`,
      input.refreshIntervalMs,
      1_000,
      900_000,
    ),
    items,
  };
}

export function validateWorkspace(value: unknown): WorkspaceSettings {
  const input = record(value);
  if (!input || input.version !== 3 || !Array.isArray(input.channels)) {
    throw new SettingsValidationError("workspace must be a version 3 object with channels");
  }
  if (input.channels.length < 1 || input.channels.length > WORKSPACE_LIMITS.maxChannels) {
    throw new SettingsValidationError(
      `workspace must contain 1-${WORKSPACE_LIMITS.maxChannels} channels`,
    );
  }
  const channels = input.channels.map(validateChannel);
  if (new Set(channels.map((channel) => channel.id)).size !== channels.length) {
    throw new SettingsValidationError("channel ids must be unique");
  }
  if (new Set(channels.map((channel) => channel.appName)).size !== channels.length) {
    throw new SettingsValidationError("channel appName values must be unique");
  }
  return { version: 3, channels };
}

export function migrateDashboardSettings(
  value: DashboardSettings,
  appName = "btc",
): WorkspaceSettings {
  const settings = validateSettings(value);
  const items = settings.assets.map((assetId) => {
    const hasChange = settings.showChange && getAssetPreset(assetId).changePeriod !== undefined;
    return createContentItem(
      `market:${assetId}`,
      settings.priceDurationMs + (hasChange ? settings.changeDurationMs : 0),
      {
        showChange: hasChange,
        changeDurationMs: settings.changeDurationMs,
      },
      `market_${assetId}`,
    );
  });
  return validateWorkspace({
    version: 3,
    channels: [{
      id: "market",
      name: "市场轮播",
      appName,
      enabled: true,
      refreshIntervalMs: settings.refreshIntervalMs,
      items,
    }],
  });
}

export function legacySettingsFromWorkspace(workspace: WorkspaceSettings): DashboardSettings {
  const channel = workspace.channels[0];
  const assetItems = channel?.items.filter((item) => item.contentId.startsWith("market:")) ?? [];
  const assets = assetItems
    .map((item) => item.contentId.slice("market:".length))
    .filter(isAssetId) as AssetId[];
  if (assets.length === 0) return structuredClone(DEFAULT_SETTINGS);
  const first = assetItems[0]!;
  const showChange = first.options.showChange === true;
  const changeDurationMs = typeof first.options.changeDurationMs === "number"
    ? Math.max(500, Math.min(30_000, first.options.changeDurationMs))
    : DEFAULT_SETTINGS.changeDurationMs;
  return {
    assets,
    priceDurationMs: Math.max(1_000, first.durationMs - (showChange ? changeDurationMs : 0)),
    changeDurationMs,
    refreshIntervalMs: Math.max(10_000, channel?.refreshIntervalMs ?? 15_000),
    showChange,
  };
}

export class WorkspaceStore {
  constructor(
    readonly path: string,
    readonly legacyPath?: string,
    readonly defaultAppName = "btc",
  ) {}

  async load(): Promise<WorkspaceSettings> {
    try {
      return validateWorkspace(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SyntaxError) {
          throw new SettingsValidationError("saved workspace contains invalid JSON");
        }
        throw error;
      }
    }

    if (this.legacyPath) {
      try {
        const raw = JSON.parse(await readFile(this.legacyPath, "utf8"));
        const workspace = migrateDashboardSettings(validateSettings(raw), this.defaultAppName);
        return this.save(workspace);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return createDefaultWorkspace(this.defaultAppName);
  }

  async save(value: WorkspaceSettings): Promise<WorkspaceSettings> {
    const workspace = validateWorkspace(value);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await Bun.write(temporaryPath, `${JSON.stringify(workspace, null, 2)}\n`);
    await rename(temporaryPath, this.path);
    return workspace;
  }
}
