import { createHash } from "node:crypto";
import type { AppConfig } from "./config.ts";
import { getContentDefinition, type ContentRenderResult } from "./content-registry.ts";
import { buildImagePayload, type ClockPayload } from "./display.ts";
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  encodePixelAnimation,
  type PixelCanvas,
} from "./pixel-ui.ts";
import { MarketDataClient, type AssetMarketData, type PriceProvider } from "./price.ts";
import { SettingsValidationError, validateSettings, type DashboardSettings } from "./settings.ts";
import type { AssetId } from "./assets.ts";
import { isPixelAssetRef, type PixelAssetStore } from "./pixel-asset-store.ts";
import {
  WORKSPACE_LIMITS,
  WorkspaceStore,
  assertLegacySettingsCompatible,
  createDefaultWorkspace,
  legacySettingsFromWorkspace,
  migrateDashboardSettings,
  validateWorkspace,
  type ChannelConfig,
  type WorkspaceSettings,
} from "./workspace.ts";
import {
  INSTRUMENT_REF_PATTERN,
  type InstrumentStore,
  type MarketInstrument,
} from "./market/instruments.ts";
import type { MarketIconStore } from "./market/icon-store.ts";
import {
  DynamicMarketDataClient,
  type RuntimeMarketData,
} from "./market/quotes.ts";
import {
  WeatherNotConfiguredError,
  type WeatherClient,
  type WeatherObservation,
} from "./weather/client.ts";
import {
  VibeUnavailableError,
  type VibeUsageService,
  type VibeUsageSnapshot,
  type VibeUsageView,
} from "./vibe/usage-service.ts";
import { VIBE_CATALOG, defaultVibeStarred } from "./vibe/vibe-catalog.ts";

export interface RenderedChannel {
  frames: readonly PixelCanvas[];
  frameDelaysMs: readonly number[];
  image: Uint8Array;
  mimeType: "image/gif" | "image/png";
  label: string;
  contentIds: readonly string[];
  assetIds: readonly AssetId[];
  animationDurationMs: number;
  contentErrors: Record<string, string>;
}

export interface ChannelRuntimeSnapshot {
  id: string;
  name: string;
  appName: string;
  enabled: boolean;
  healthy: boolean;
  degraded: boolean;
  pushing: boolean;
  effectiveRefreshIntervalMs: number;
  animationDurationMs: number;
  contentIds: string[];
  contentErrors: Record<string, string>;
  assetIds: AssetId[];
  lastPushAt?: string;
  lastError?: string;
  updateCount: number;
}

export interface WorkspaceAssetSnapshot {
  assetId: AssetId;
  provider: PriceProvider;
  price: number;
  changePercent?: number;
  changePeriod?: "24H" | "1D";
  fetchedAt: string;
  sourceTime?: string;
}

export interface WorkspaceRuntimeSnapshot {
  service: "ulanzi-tc002-content-hub";
  startedAt: string;
  healthy: boolean;
  degraded: boolean;
  pushing: boolean;
  deviceReachable: boolean;
  /** The channels are still rendered on schedule; only the device write is off. */
  devicePushSuspended: boolean;
  deviceVersions?: { mcu?: string; app?: string };
  workspace: WorkspaceSettings;
  channels: ChannelRuntimeSnapshot[];
  assets: WorkspaceAssetSnapshot[];
  cleanupErrors: Record<string, string>;
}

interface MutableChannelRuntime {
  pushing: boolean;
  animationDurationMs?: number;
  contentErrors: Record<string, string>;
  assetIds: AssetId[];
  lastPushAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  updateCount: number;
}

export interface WorkspaceControllerOptions {
  config: AppConfig;
  workspace: WorkspaceSettings;
  workspaceStore: WorkspaceStore;
  marketClient?: MarketDataClient;
  pushPayload: (appName: string, payload: ClockPayload) => Promise<{ status: number }>;
  deleteApp: (appName: string) => Promise<{ status: number }>;
  pixelAssetStore?: PixelAssetStore;
  instrumentStore?: InstrumentStore;
  marketIconStore?: MarketIconStore;
  dynamicMarketClient?: DynamicMarketDataClient;
  weatherClient?: WeatherClient;
  vibeClient?: VibeUsageService;
  /** Read per render, not captured: the console can re-star a metric mid-session. */
  vibeStarred?: () => Record<string, string[]>;
  /**
   * True while the device serves itself and must not be written to.
   *
   * A flashed ZOS replaced the official app and with it `POST /api/custom`;
   * what answers now is a setup portal that returns the config page and HTTP
   * 200 for every unknown path, so a push cannot even fail honestly. What must
   * NOT stop is the render: `renderChannel(channel, true)` is the only periodic
   * caller that passes forceRefresh, and forceRefresh is the only thing that
   * sends getMarket/getWeather to the network. Skip the whole schedule and
   * every quote and temperature freezes at whatever was true when the service
   * started, while the device keeps pulling a bundle that looks current because
   * its clock digits advance.
   */
  devicePushSuspended?: () => boolean;
  /**
   * Where the boot-time workspace migration announces itself.
   *
   * Unlike OsSleepRequestStore's onWarn this defaults to writing the line rather
   * than to a no-op: channels vanishing from the knob is the one thing here a
   * user could mistake for data loss, and service.ts builds this controller
   * without handing it a logger. Injectable so tests can read the line back.
   */
  onLog?: (event: string, details: Record<string, unknown>) => void;
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

const PREVIEW_CACHE_TTL_MS = 5_000;
const PREVIEW_CACHE_LIMIT = 16;

/**
 * The appName convention the retired VIBE placement wrote: one overview App
 * plus one detail App per catalogued agent. Matched against the catalog rather
 * than against `vibe_*` so a channel somebody named `vibe_notes` themselves is
 * never a candidate for the whole-channel removal below.
 */
const RETIRED_VIBE_APP_NAMES: ReadonlySet<string> = new Set([
  "vibe",
  ...VIBE_CATALOG.map((entry) => `vibe_${entry.id}`),
]);

function isRetiredVibeContentId(contentId: string): boolean {
  return contentId === "tools:vibe-duo" || contentId === "tools:vibe-agent";
}

interface VibeChannelMigration {
  workspace: WorkspaceSettings;
  droppedChannels: string[];
  strippedItems: number;
  resetToDefaults: boolean;
}

/**
 * Boot-time removal of the channels VIBE used to be placed into.
 *
 * AI usage is a first-class ZOS app now, so `tools:vibe-duo` and
 * `tools:vibe-agent` are gone from the registry — and validateKnownContent
 * turns an unresolvable contentId into a throw inside the constructor, which
 * runs before Bun.serve. Anyone who ever pressed 布置到时钟 therefore has a
 * workspace.json that would stop the service from booting, so this is not an
 * optional convenience: it is what keeps `bun start` working across the upgrade.
 *
 * Two removals, because two different things could have happened. A channel the
 * placement created — our appName AND nothing but VIBE inside — goes whole,
 * name and all. A VIBE tile someone added to their own carousel from 内容市场
 * loses only that item; taking their carousel with it would be a far bigger
 * surprise than the tile. Channels emptied by the second pass then go too,
 * because a channel with no items cannot be represented at all.
 */
function dropRetiredVibeChannels(
  workspace: WorkspaceSettings,
  defaultAppName: string,
): VibeChannelMigration {
  const droppedChannels: string[] = [];
  let strippedItems = 0;
  const channels: ChannelConfig[] = [];
  // Nothing to migrate in a document that is not one; validateWorkspace is the
  // only place allowed to name what is wrong with it.
  if (!Array.isArray(workspace?.channels)) {
    return { workspace, droppedChannels, strippedItems, resetToDefaults: false };
  }
  for (const channel of workspace.channels) {
    const placed = RETIRED_VIBE_APP_NAMES.has(channel.appName)
      && channel.items.length > 0
      && channel.items.every((item) => isRetiredVibeContentId(item.contentId));
    if (placed) {
      droppedChannels.push(channel.appName);
      continue;
    }
    const items = channel.items.filter((item) => !isRetiredVibeContentId(item.contentId));
    if (items.length === channel.items.length) {
      channels.push(channel);
      continue;
    }
    strippedItems += channel.items.length - items.length;
    if (items.length === 0) {
      droppedChannels.push(channel.appName);
      continue;
    }
    channels.push({ ...channel, items });
  }
  if (droppedChannels.length === 0 && strippedItems === 0) {
    return { workspace, droppedChannels, strippedItems, resetToDefaults: false };
  }
  // The device needs at least one channel and validateWorkspace enforces it, so
  // a workspace that was nothing but VIBE pages has to land somewhere. The stock
  // default is the only honest destination — better an obviously fresh panel
  // than a service that refuses to start.
  if (channels.length === 0) {
    return {
      workspace: createDefaultWorkspace(defaultAppName),
      droppedChannels,
      strippedItems,
      resetToDefaults: true,
    };
  }
  return { workspace: { version: 3, channels }, droppedChannels, strippedItems, resetToDefaults: false };
}

/**
 * How long a usage snapshot may stand in for a failed refresh.
 *
 * Deliberately not `config.sourceStaleMs`: that defaults to 120 s, tuned for
 * quote feeds that tick continuously, while a quota window moves in five-minute
 * steps at best and hourly at worst. Two minutes against such a source would
 * call a perfectly current snapshot stale and blank the page on the first
 * hiccup. Fifteen minutes is the tolerance; past that the panel says so rather
 * than showing a number nobody can date.
 */
const VIBE_STALE_MS = 15 * 60_000;

/**
 * The floor between two collection rounds, however often somebody asks.
 *
 * The callers are the five-minute publisher behind the panel's VIBE app, every
 * settings change (a re-star has to show up at once), and an open console tab.
 * Without a floor those three would each start their own round and a quiet
 * afternoon would still cost dozens of vendor requests an hour, for numbers
 * whose own windows move in five-minute steps at best — which is exactly what
 * earned a 429 during bring-up. Only the console's explicit 刷新 bypasses it.
 */
const VIBE_MIN_REFRESH_MS = 5 * 60_000;

/**
 * The floor the console's own 刷新 still has to respect.
 *
 * `GET /api/vibe/status?refresh=1` is a read-only route on a socket bound to
 * 0.0.0.0, so it takes no same-origin check — which means anything on the LAN
 * can ask for a collection round. Without a floor of its own, a loop on that
 * URL would drive ten vendor requests per hit and get the user rate limited
 * everywhere. Twenty seconds keeps the button feeling instant while capping a
 * hostile poller at three rounds a minute.
 */
const VIBE_FORCED_REFRESH_FLOOR_MS = 20_000;

/**
 * JSON with a deterministic key order.
 *
 * The render key doubles as a content revision the device caches against, so it
 * has to survive a service restart: workspace.json is parsed back in file order
 * while a channel that just came off the console carries the request body's
 * order. Plain JSON.stringify would hand those two byte-identical channels two
 * different keys, and every restart would look like an edit — the device would
 * re-download every channel it already holds, for nothing.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export class WorkspaceController {
  private readonly config: AppConfig;
  private readonly workspaceStore: WorkspaceStore;
  private readonly marketClient: MarketDataClient;
  private readonly pushPayload: WorkspaceControllerOptions["pushPayload"];
  private readonly deleteApp: WorkspaceControllerOptions["deleteApp"];
  private readonly pixelAssetStore?: PixelAssetStore;
  private readonly instrumentStore?: InstrumentStore;
  private readonly marketIconStore?: MarketIconStore;
  private readonly dynamicMarketClient: DynamicMarketDataClient;
  private readonly weatherClient?: WeatherClient;
  private readonly vibeClient?: VibeUsageService;
  private readonly vibeStarred?: () => Record<string, string[]>;
  private readonly devicePushSuspended: () => boolean;
  private readonly onLog: (event: string, details: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly startedAt: string;
  private workspace: WorkspaceSettings;
  /**
   * Settles once the boot-time VIBE migration has been written back and the
   * Custom Apps it removed have been deleted from the clock.
   *
   * The migration itself is synchronous — it must be, because the document it
   * repairs is validated in the constructor — but persisting it is not, and
   * without a handle a test could only poll the file. Already resolved when
   * there was nothing to migrate, which is every workspace after the first boot.
   */
  readonly vibeMigrationSettled: Promise<void>;
  private readonly marketCache = new Map<AssetId, AssetMarketData>();
  private readonly marketErrors = new Map<AssetId, string>();
  private readonly dynamicMarketCache = new Map<string, RuntimeMarketData>();
  private readonly dynamicMarketErrors = new Map<string, string>();
  private readonly weatherCache = new Map<string, WeatherObservation>();
  private vibeCache?: VibeUsageSnapshot;
  private vibeInFlight?: Promise<VibeUsageSnapshot>;
  private readonly channelRuntime = new Map<string, MutableChannelRuntime>();
  private readonly previewCache = new Map<string, {
    rendered: RenderedChannel;
    expiresAt: number;
  }>();
  private readonly previewInFlight = new Map<string, Promise<RenderedChannel>>();
  private cleanupErrors: Record<string, string> = {};
  private deviceReachable = false;
  private deviceVersions?: { mcu?: string; app?: string };
  private activePushCount = 0;
  private deviceQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceControllerOptions) {
    this.config = options.config;
    this.workspaceStore = options.workspaceStore;
    this.marketClient = options.marketClient ?? new MarketDataClient({
      timeoutMs: options.config.requestTimeoutMs,
    });
    this.pushPayload = options.pushPayload;
    this.deleteApp = options.deleteApp;
    this.pixelAssetStore = options.pixelAssetStore;
    this.instrumentStore = options.instrumentStore;
    this.marketIconStore = options.marketIconStore;
    this.dynamicMarketClient = options.dynamicMarketClient ?? new DynamicMarketDataClient({
      timeoutMs: options.config.requestTimeoutMs,
    });
    this.weatherClient = options.weatherClient;
    this.vibeClient = options.vibeClient;
    this.vibeStarred = options.vibeStarred;
    this.devicePushSuspended = options.devicePushSuspended ?? (() => false);
    this.onLog = options.onLog ?? ((event, details) => {
      console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
    });
    this.now = options.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
    // Before validateKnownContent, not after: the whole point is that the
    // document coming off disk no longer validates.
    const migration = dropRetiredVibeChannels(options.workspace, options.config.appName);
    this.workspace = this.validateKnownContent(migration.workspace, true);
    this.syncRuntime();
    this.vibeMigrationSettled = this.settleVibeMigration(migration);
  }

  /**
   * Persists the boot-time migration and clears what it left on the device.
   *
   * Writing back matters as much as the removal: skip it and every boot
   * re-migrates while the console shows a workspace that disagrees with disk.
   * Deleting the Custom Apps matters too — under the official firmware each
   * removed channel is still resident on the clock, and nothing else would ever
   * take it off the knob, so 「旧频道自动消失」would be true only in the browser.
   */
  private async settleVibeMigration(migration: VibeChannelMigration): Promise<void> {
    if (migration.droppedChannels.length === 0 && migration.strippedItems === 0) return;
    this.onLog("workspace_vibe_channels_migrated", {
      droppedChannels: migration.droppedChannels,
      strippedItems: migration.strippedItems,
      resetToDefaults: migration.resetToDefaults,
      reason: "vibe_is_a_firmware_app",
    });
    try {
      await this.workspaceStore.save(this.workspace);
    } catch (error) {
      // Not fatal. The in-memory workspace is already correct, so the panel and
      // the console behave; it only means the next boot migrates again.
      this.onLog("workspace_vibe_migration_save_failed", { error: errorMessage(error) });
      return;
    }
    const retained = new Set(this.workspace.channels.map((channel) => channel.appName));
    for (const appName of migration.droppedChannels) {
      if (retained.has(appName) || this.devicePushSuspended()) continue;
      try {
        await this.queueDeviceWrite(() => this.deleteApp(appName));
      } catch (error) {
        // Same bucket saveWorkspace uses, so retryCleanup picks these up on the
        // schedule: a clock that was simply asleep at boot still loses the apps.
        this.cleanupErrors[appName] = errorMessage(error);
      }
    }
  }

  private validateKnownContent(
    value: unknown,
    allowUnavailableRuntimeInstrument = false,
  ): WorkspaceSettings {
    const workspace = validateWorkspace(value);
    for (const channel of workspace.channels) {
      for (const item of channel.items) {
        try {
          getContentDefinition(item.contentId);
        } catch {
          throw new SettingsValidationError(`unknown contentId: ${item.contentId}`);
        }
        if (item.contentId === "market:instrument") {
          const instrumentRef = item.options.instrumentRef;
          if (typeof instrumentRef !== "string" || !INSTRUMENT_REF_PATTERN.test(instrumentRef)) {
            throw new SettingsValidationError("runtime market item must contain a valid instrumentRef");
          }
          const instrument = this.instrumentStore?.get(instrumentRef);
          if (!allowUnavailableRuntimeInstrument && !instrument) {
            throw new SettingsValidationError(`runtime market instrument is unavailable: ${instrumentRef}`);
          }
          const icon = instrument ? this.marketIconStore?.get(instrument.iconRef) : undefined;
          if (!allowUnavailableRuntimeInstrument && instrument && !icon) {
            throw new SettingsValidationError(`runtime market icon is unavailable: ${instrument.iconRef}`);
          }
          if (!allowUnavailableRuntimeInstrument && instrument && icon?.instrumentRef !== instrument.ref) {
            throw new SettingsValidationError(`runtime market icon provenance is invalid: ${instrument.iconRef}`);
          }
        } else if (item.contentId === "creative:canvas") {
          const pixels = item.options.pixels;
          if (!Array.isArray(pixels) || pixels.length !== WORKSPACE_LIMITS.maxCanvasPixels) {
            throw new SettingsValidationError(
              `canvas must contain exactly ${WORKSPACE_LIMITS.maxCanvasPixels} pixels`,
            );
          }
          if (!pixels.every((pixel) =>
            typeof pixel === "number"
            && Number.isInteger(pixel)
            && pixel >= 0
            && pixel <= 0xffffff
          )) {
            throw new SettingsValidationError("canvas pixels must be RGB integers");
          }
        } else if (item.contentId === "creative:pixel-asset") {
          if (!isPixelAssetRef(item.options.assetRef)) {
            throw new SettingsValidationError("pixel asset must contain a valid local assetRef");
          }
          for (const key of ["officialId", "title", "author", "sourceUrl"] as const) {
            const value = item.options[key];
            if (typeof value !== "string" || value.length > 256) {
              throw new SettingsValidationError(`pixel asset ${key} is invalid`);
            }
          }
          if (!/^\d{1,20}$/.test(String(item.options.officialId))) {
            throw new SettingsValidationError("pixel asset officialId is invalid");
          }
        }
      }
    }
    return workspace;
  }

  private syncRuntime(): void {
    const ids = new Set(this.workspace.channels.map((channel) => channel.id));
    for (const id of this.channelRuntime.keys()) {
      if (!ids.has(id)) this.channelRuntime.delete(id);
    }
    for (const channel of this.workspace.channels) {
      if (!this.channelRuntime.has(channel.id)) {
        this.channelRuntime.set(channel.id, {
          pushing: false,
          contentErrors: {},
          assetIds: [],
          updateCount: 0,
        });
      }
    }
  }

  getWorkspace(): WorkspaceSettings {
    return structuredClone(this.workspace);
  }

  getSettings(): DashboardSettings {
    assertLegacySettingsCompatible(this.workspace, this.config.appName);
    return legacySettingsFromWorkspace(this.workspace);
  }

  async saveWorkspace(value: unknown): Promise<WorkspaceSettings> {
    const next = this.validateKnownContent(value);
    const previous = this.workspace;
    const saved = await this.workspaceStore.save(next);
    this.workspace = saved;
    this.syncRuntime();
    for (const channel of saved.channels) {
      const old = previous.channels.find((candidate) => candidate.id === channel.id);
      if (
        !old
        || old.appName !== channel.appName
        || old.enabled !== channel.enabled
        || JSON.stringify(old.items) !== JSON.stringify(channel.items)
      ) {
        const runtime = this.channelRuntime.get(channel.id)!;
        runtime.animationDurationMs = undefined;
        runtime.contentErrors = {};
        runtime.assetIds = [];
        runtime.lastPushAt = undefined;
        runtime.lastAttemptAt = undefined;
        runtime.lastError = undefined;
      }
    }

    const retainedApps = new Set(
      saved.channels.filter((channel) => channel.enabled).map((channel) => channel.appName),
    );
    const staleApps = new Set(
      previous.channels
        .filter((channel) => channel.enabled && !retainedApps.has(channel.appName))
        .map((channel) => channel.appName),
    );
    for (const appName of staleApps) {
      // Same rule as the push: a flashed ZOS has no Custom Apps to delete, so
      // the DELETE would land on the setup portal and come back 200 either way.
      if (this.devicePushSuspended()) {
        delete this.cleanupErrors[appName];
        continue;
      }
      try {
        await this.queueDeviceWrite(() => this.deleteApp(appName));
        delete this.cleanupErrors[appName];
      } catch (error) {
        this.cleanupErrors[appName] = errorMessage(error);
      }
    }
    return this.getWorkspace();
  }

  async saveSettings(value: unknown): Promise<DashboardSettings> {
    assertLegacySettingsCompatible(this.workspace, this.config.appName);
    const settings = validateSettings(value);
    await this.saveWorkspace(migrateDashboardSettings(settings, this.config.appName));
    return this.getSettings();
  }

  setDeviceInfo(info: { mcuVersion?: string; appVersion?: string }): void {
    this.deviceReachable = true;
    this.deviceVersions = { mcu: info.mcuVersion, app: info.appVersion };
  }

  getEffectiveRefreshIntervalMs(channel: ChannelConfig): number {
    const runtime = this.channelRuntime.get(channel.id);
    const animationDurationMs = runtime?.animationDurationMs
      ?? channel.items.reduce((sum, item) => sum + item.durationMs, 0);
    return Math.max(channel.refreshIntervalMs, animationDurationMs);
  }

  getNextWakeMs(): number {
    const now = this.now();
    const dueIn = this.workspace.channels
      .filter((channel) => channel.enabled)
      .map((channel) => {
        const runtime = this.channelRuntime.get(channel.id)!;
        const lastActivity = runtime.lastPushAt ?? runtime.lastAttemptAt;
        if (!lastActivity) return 0;
        return Math.max(
          0,
          Date.parse(lastActivity) + this.getEffectiveRefreshIntervalMs(channel) - now,
        );
      });
    const channelWake = dueIn.length === 0 ? 60_000 : Math.max(250, Math.min(...dueIn));
    return Object.keys(this.cleanupErrors).length > 0 ? Math.min(channelWake, 60_000) : channelWake;
  }

  getState(): WorkspaceRuntimeSnapshot {
    const now = this.now();
    const channels = this.workspace.channels.map((channel): ChannelRuntimeSnapshot => {
      const runtime = this.channelRuntime.get(channel.id)!;
      const effectiveRefreshIntervalMs = this.getEffectiveRefreshIntervalMs(channel);
      const lastPushMs = runtime.lastPushAt ? Date.parse(runtime.lastPushAt) : 0;
      const healthy = !channel.enabled || (
        lastPushMs > 0
        && now - lastPushMs < Math.max(this.config.sourceStaleMs, effectiveRefreshIntervalMs * 2 + 5_000)
        && !runtime.lastError
      );
      return {
        id: channel.id,
        name: channel.name,
        appName: channel.appName,
        enabled: channel.enabled,
        healthy,
        degraded: Object.keys(runtime.contentErrors).length > 0,
        pushing: runtime.pushing,
        effectiveRefreshIntervalMs,
        animationDurationMs: runtime.animationDurationMs
          ?? channel.items.reduce((sum, item) => sum + item.durationMs, 0),
        contentIds: channel.items.map((item) => item.contentId),
        contentErrors: { ...runtime.contentErrors },
        assetIds: [...runtime.assetIds],
        ...(runtime.lastPushAt ? { lastPushAt: runtime.lastPushAt } : {}),
        ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
        updateCount: runtime.updateCount,
      };
    });
    const enabled = channels.filter((channel) => channel.enabled);
    return {
      service: "ulanzi-tc002-content-hub",
      startedAt: this.startedAt,
      healthy: this.deviceReachable && enabled.length > 0 && enabled.every((channel) => channel.healthy),
      degraded:
        Object.keys(this.cleanupErrors).length > 0
        || channels.some((channel) => channel.degraded || Boolean(channel.lastError)),
      pushing: this.activePushCount > 0,
      deviceReachable: this.deviceReachable,
      devicePushSuspended: this.devicePushSuspended(),
      ...(this.deviceVersions ? { deviceVersions: this.deviceVersions } : {}),
      workspace: this.getWorkspace(),
      channels,
      assets: [...this.marketCache.values()].map((market) => ({
        assetId: market.assetId,
        provider: market.provider,
        price: market.price,
        ...(market.changePercent === undefined ? {} : { changePercent: market.changePercent }),
        ...(market.changePeriod === undefined ? {} : { changePeriod: market.changePeriod }),
        fetchedAt: market.fetchedAt,
        ...(market.sourceTime ? { sourceTime: market.sourceTime } : {}),
      })),
      cleanupErrors: { ...this.cleanupErrors },
    };
  }

  private async getMarket(assetId: AssetId, forceRefresh: boolean): Promise<AssetMarketData> {
    const cached = this.marketCache.get(assetId);
    if (!forceRefresh && cached) return cached;
    try {
      const market = await this.marketClient.getAsset(assetId);
      this.marketCache.set(assetId, market);
      this.marketErrors.delete(assetId);
      return market;
    } catch (error) {
      const message = errorMessage(error);
      this.marketErrors.set(assetId, message);
      if (cached && this.now() - Date.parse(cached.fetchedAt) < this.config.sourceStaleMs) {
        return cached;
      }
      throw error;
    }
  }

  private async getInstrumentMarket(
    instrumentRef: string,
    forceRefresh: boolean,
  ): Promise<{ instrument: MarketInstrument; market: RuntimeMarketData; icon: PixelCanvas }> {
    const instrument = this.instrumentStore?.get(instrumentRef);
    if (!instrument) throw new Error(`runtime market instrument is unavailable: ${instrumentRef}`);
    if (!this.marketIconStore) throw new Error("runtime market icon store is unavailable");
    const iconManifest = this.marketIconStore.get(instrument.iconRef);
    if (!iconManifest || iconManifest.instrumentRef !== instrument.ref) {
      throw new Error(`runtime market icon is unavailable or has invalid provenance: ${instrument.iconRef}`);
    }
    const cached = this.dynamicMarketCache.get(instrumentRef);
    let market = cached;
    if (forceRefresh || !market) {
      try {
        market = await this.dynamicMarketClient.getInstrument(instrument);
        this.dynamicMarketCache.set(instrumentRef, market);
        this.dynamicMarketErrors.delete(instrumentRef);
      } catch (error) {
        this.dynamicMarketErrors.set(instrumentRef, errorMessage(error));
        if (!cached || this.now() - Date.parse(cached.fetchedAt) >= this.config.sourceStaleMs) {
          throw error;
        }
        market = cached;
      }
    }
    return {
      instrument,
      market,
      icon: await this.marketIconStore.getCanvas(instrument.iconRef),
    };
  }

  private async getWeather(
    latitude: number,
    longitude: number,
    forceRefresh: boolean,
  ): Promise<WeatherObservation> {
    if (!this.weatherClient) throw new WeatherNotConfiguredError();
    const key = `${latitude},${longitude}`;
    const cached = this.weatherCache.get(key);
    if (!forceRefresh && cached) return cached;
    try {
      const observation = await this.weatherClient.getCurrent(latitude, longitude);
      this.weatherCache.set(key, observation);
      return observation;
    } catch (error) {
      if (cached && this.now() - Date.parse(cached.fetchedAt) < this.config.sourceStaleMs) {
        return cached;
      }
      throw error;
    }
  }

  /**
   * One usage snapshot per refresh, shared by everyone who wants the numbers.
   *
   * No content type reads this any more — AI usage is a firmware app — so the
   * callers are `/api/vibe/status` and service.ts's `publishOsVibe()`, which
   * folds the snapshot into the state document the panel long-polls. It stays
   * on the controller because the three floors below are what stop those two
   * from turning into ten vendor conversations a minute.
   *
   * Same shape as getMarket/getWeather — cache first, stale cache as the
   * fallback, throw once it is older than VIBE_STALE_MS — with one addition:
   * the starred table is merged in here rather than at the consumer, so both
   * the console and the wire see the same 「哪两行上屏」answer.
   */
  async getVibeUsage(forceRefresh: boolean, userRequested = false): Promise<VibeUsageView> {
    if (!this.vibeClient) throw new VibeUnavailableError("usage collection is not configured");
    const starred = this.vibeStarred?.() ?? defaultVibeStarred();
    const cached = this.vibeCache;
    const age = cached === undefined ? Number.POSITIVE_INFINITY : this.now() - Date.parse(cached.fetchedAt);
    // A cache hit must still age out: with no VIBE channel scheduled nothing
    // ever passes forceRefresh=true, so an unaged hit would pin the boot-time
    // snapshot forever while /api/vibe/status reports it as current.
    if (!forceRefresh && cached && age < VIBE_STALE_MS) {
      return { snapshot: cached, starred };
    }
    // Scheduled pushes share one collection round; the console's own refresh
    // gets a much shorter floor rather than none (see both constants).
    const floor = userRequested ? VIBE_FORCED_REFRESH_FLOOR_MS : VIBE_MIN_REFRESH_MS;
    if (cached && age < floor) {
      return { snapshot: cached, starred };
    }
    // One collection round is shared by everyone who asks while it is running:
    // a channel push, a preview and an open console tab otherwise each start
    // their own, and ten vendors do not need three simultaneous conversations.
    // Awaited INSIDE the try, not outside it. Outside, a round that throws gave
    // the caller who started it the last-good snapshot and everyone who joined
    // it the exception — two tabs looking at the same failure, one showing the
    // numbers from ten minutes ago and one showing nothing at all.
    try {
      const inFlight = this.vibeInFlight;
      if (inFlight) return { snapshot: await inFlight, starred };
      const round = this.vibeClient.fetchSnapshot();
      this.vibeInFlight = round;
      const snapshot = await round.finally(() => { this.vibeInFlight = undefined; });
      this.vibeCache = snapshot;
      return { snapshot, starred };
    } catch (error) {
      if (cached && age < VIBE_STALE_MS) {
        return { snapshot: cached, starred };
      }
      throw error;
    }
  }

  private validateRenderedItem(itemId: string, rendered: ContentRenderResult): void {
    if (rendered.frames.length === 0 || rendered.frames.length !== rendered.frameDelaysMs.length) {
      throw new Error(`${itemId} returned invalid frame timing`);
    }
    for (const [index, frame] of rendered.frames.entries()) {
      if (frame.width !== DISPLAY_WIDTH || frame.height !== DISPLAY_HEIGHT) {
        throw new Error(`${itemId} frame ${index} must be ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`);
      }
      const delay = rendered.frameDelaysMs[index];
      if (!Number.isInteger(delay) || delay! < 20 || delay! > 900_000) {
        throw new Error(`${itemId} frame ${index} has an invalid delay`);
      }
    }
  }

  /**
   * Everything a render depends on that a human can change.
   *
   * renderChannel() reads `channel.items` and nothing else off the channel, so
   * the name, appName, enabled flag and refresh interval are deliberately
   * absent: renaming a channel must not invalidate frames that would come back
   * byte-identical. Market icons ARE in here, because regenerating one changes
   * the pixels without touching any item.
   *
   * Volatile inputs — wall clock, quotes, weather — are deliberately NOT in
   * here. They move without anyone editing anything, so folding them in would
   * make this string change once a second and turn every cache into a miss.
   * Their staleness is bounded by the channel's refresh interval instead, which
   * is what `getEffectiveRefreshIntervalMs` is for.
   */
  private renderInputsKey(channel: ChannelConfig): string {
    const iconVersions = channel.items.flatMap((item) => {
      if (item.contentId !== "market:instrument" || typeof item.options.instrumentRef !== "string") {
        return [];
      }
      const instrument = this.instrumentStore?.get(item.options.instrumentRef);
      return [`${item.options.instrumentRef}:${instrument?.iconRef ?? "missing"}`];
    });
    return canonicalJson({ items: channel.items, iconVersions });
  }

  /**
   * A short, stable fingerprint of the frames a channel would render to.
   *
   * The tc002-os firmware pulls a channel's frames once and caches them, and
   * the state document gives it no vocabulary to learn that the pixels behind
   * an app name have changed: `item` carries a kind, an id and a label, and not
   * one of the three moves when 灯牌's colour does. Publishing this alongside
   * the menu entry is what makes an options edit expressible on the wire at all.
   *
   * Same string as the preview cache key, by construction — so "the device
   * needs new frames" and "the cached render is no longer valid" can never
   * disagree. 12 hex digits is 48 bits: a collision costs one skipped refresh
   * of one channel, which is cheaper than the bytes a full digest would add to
   * a document the device pulls every eight seconds.
   */
  channelContentRevision(channel: ChannelConfig): string {
    return createHash("sha1").update(this.renderInputsKey(channel)).digest("hex").slice(0, 12);
  }

  async previewChannel(value: string | ChannelConfig, forceRefresh = false): Promise<RenderedChannel> {
    const channel = typeof value === "string"
      ? this.workspace.channels.find((candidate) => candidate.id === value)
      : this.validateKnownContent({ version: 3, channels: [value] }).channels[0];
    if (!channel) throw new SettingsValidationError("channel not found");
    const key = this.renderInputsKey(channel);
    const now = this.now();

    for (const [cacheKey, entry] of this.previewCache) {
      if (entry.expiresAt <= now) this.previewCache.delete(cacheKey);
    }
    if (!forceRefresh) {
      const cached = this.previewCache.get(key);
      if (cached) return cached.rendered;
    }

    const inFlight = this.previewInFlight.get(key);
    if (inFlight) return inFlight;

    const rendering = this.renderChannel(channel, forceRefresh)
      .then((rendered) => {
        this.previewCache.delete(key);
        this.previewCache.set(key, {
          rendered,
          expiresAt: this.now() + PREVIEW_CACHE_TTL_MS,
        });
        while (this.previewCache.size > PREVIEW_CACHE_LIMIT) {
          const oldestKey = this.previewCache.keys().next().value;
          if (oldestKey === undefined) break;
          this.previewCache.delete(oldestKey);
        }
        return rendered;
      })
      .finally(() => {
        if (this.previewInFlight.get(key) === rendering) {
          this.previewInFlight.delete(key);
        }
      });
    this.previewInFlight.set(key, rendering);
    return rendering;
  }

  private async renderChannel(
    channel: ChannelConfig,
    forceRefresh: boolean,
  ): Promise<RenderedChannel> {
    const frames: PixelCanvas[] = [];
    const frameDelaysMs: number[] = [];
    const labels: string[] = [];
    const contentIds: string[] = [];
    const assetIds: AssetId[] = [];
    const contentErrors: Record<string, string> = {};
    const renderMarkets = new Map<AssetId, Promise<AssetMarketData>>();
    const context = {
      nowMs: this.now(),
      forceRefresh,
      getMarket: (assetId: AssetId, refresh: boolean) => {
        let pending = renderMarkets.get(assetId);
        if (!pending) {
          pending = this.getMarket(assetId, refresh);
          renderMarkets.set(assetId, pending);
        }
        return pending;
      },
      getInstrumentMarket: (instrumentRef: string, refresh: boolean) =>
        this.getInstrumentMarket(instrumentRef, refresh),
      getPixelAsset: (assetRef: string, durationMs: number) => {
        if (!this.pixelAssetStore) throw new Error("pixel asset store is unavailable");
        return this.pixelAssetStore.render(assetRef, durationMs);
      },
      getWeather: (latitude: number, longitude: number, refresh: boolean) =>
        this.getWeather(latitude, longitude, refresh),
    };

    for (const item of channel.items) {
      try {
        const definition = getContentDefinition(item.contentId);
        const rendered = await definition.render(context, item);
        this.validateRenderedItem(item.id, rendered);
        if (frames.length + rendered.frames.length > WORKSPACE_LIMITS.maxFramesPerChannel) {
          throw new Error(
            `channel exceeds the ${WORKSPACE_LIMITS.maxFramesPerChannel}-frame limit`,
          );
        }
        frames.push(...rendered.frames);
        frameDelaysMs.push(...rendered.frameDelaysMs);
        labels.push(rendered.label);
        contentIds.push(item.contentId);
        assetIds.push(...rendered.assetIds ?? []);
        for (const assetId of rendered.assetIds ?? []) {
          const marketError = this.marketErrors.get(assetId);
          if (marketError) contentErrors[item.id] = `cached market data: ${marketError}`;
        }
      } catch (error) {
        contentErrors[item.id] = errorMessage(error);
      }
    }
    if (frames.length === 0) {
      throw new Error(Object.values(contentErrors)[0] ?? "channel rendered no frames");
    }
    const animationDurationMs = frameDelaysMs.reduce((sum, delay) => sum + delay, 0);
    return {
      frames,
      frameDelaysMs,
      image: frames.length === 1 ? frames[0]!.toPng() : encodePixelAnimation(frames, frameDelaysMs),
      mimeType: frames.length === 1 ? "image/png" : "image/gif",
      label: labels.join(" · "),
      contentIds,
      assetIds: [...new Set(assetIds)],
      animationDurationMs,
      contentErrors,
    };
  }

  async pushChannel(channelId: string): Promise<WorkspaceRuntimeSnapshot> {
    const channel = this.workspace.channels.find((candidate) => candidate.id === channelId);
    if (!channel) throw new SettingsValidationError("channel not found");
    if (!channel.enabled) throw new SettingsValidationError("disabled channels cannot be pushed");
    const runtime = this.channelRuntime.get(channel.id)!;
    runtime.pushing = true;
    runtime.lastAttemptAt = new Date(this.now()).toISOString();
    this.activePushCount += 1;
    // Suspension takes away the device write and NOTHING else. The render below
    // is what refreshes the market and weather caches that the device's own
    // /api/os/frames pull then reads out of, so it has to keep running on the
    // channel's interval whether or not anybody is listening on /api/custom.
    const suspended = this.devicePushSuspended();
    try {
      const rendered = await this.renderChannel(channel, true);
      if (!suspended) {
        const durationSeconds = Math.min(
          86_400,
          Math.max(
            this.config.displayDurationSeconds,
            Math.ceil(rendered.animationDurationMs / 1_000) + 30,
          ),
        );
        await this.queueDeviceWrite(() =>
          this.pushPayload(
            channel.appName,
            buildImagePayload(rendered.image, rendered.mimeType, durationSeconds),
          )
        );
      }
      runtime.animationDurationMs = rendered.animationDurationMs;
      runtime.contentErrors = rendered.contentErrors;
      runtime.assetIds = [...rendered.assetIds];
      runtime.lastPushAt = new Date(this.now()).toISOString();
      runtime.lastError = undefined;
      runtime.updateCount += 1;
      // Under suspension we did not talk to the device, so we cannot claim to
      // have reached it — but we do not have to guess either: the only thing
      // that ever sets the suspension is the device's own POST /api/os/report.
      this.deviceReachable = true;
    } catch (error) {
      runtime.lastError = errorMessage(error);
      if (Object.keys(runtime.contentErrors).length === 0) {
        runtime.contentErrors = { channel: runtime.lastError };
      }
      throw error;
    } finally {
      runtime.pushing = false;
      this.activePushCount -= 1;
    }
    return this.getState();
  }

  async pushAll(_reason: "scheduled" | "manual" = "manual"): Promise<WorkspaceRuntimeSnapshot> {
    for (const channel of this.workspace.channels) {
      if (!channel.enabled) continue;
      try {
        await this.pushChannel(channel.id);
      } catch {
        // Per-channel state contains the failure; continue independent channels.
      }
    }
    return this.getState();
  }

  async pushDue(): Promise<WorkspaceRuntimeSnapshot> {
    await this.retryCleanup();
    const now = this.now();
    for (const channel of this.workspace.channels) {
      if (!channel.enabled) continue;
      const runtime = this.channelRuntime.get(channel.id)!;
      const lastActivity = runtime.lastPushAt ?? runtime.lastAttemptAt;
      const due = !lastActivity
        || now - Date.parse(lastActivity) >= this.getEffectiveRefreshIntervalMs(channel);
      if (!due) continue;
      try {
        await this.pushChannel(channel.id);
      } catch {
        // Continue other channels; retry this channel after its configured interval.
      }
    }
    return this.getState();
  }

  private async retryCleanup(): Promise<void> {
    // Nothing left to clean up: the receiver those apps lived in went with the
    // official firmware, and retrying would only feed the captive portal.
    if (this.devicePushSuspended()) {
      this.cleanupErrors = {};
      return;
    }
    const retainedApps = new Set(
      this.workspace.channels.filter((channel) => channel.enabled).map((channel) => channel.appName),
    );
    for (const appName of Object.keys(this.cleanupErrors)) {
      if (retainedApps.has(appName)) {
        delete this.cleanupErrors[appName];
        continue;
      }
      try {
        await this.queueDeviceWrite(() => this.deleteApp(appName));
        delete this.cleanupErrors[appName];
      } catch (error) {
        this.cleanupErrors[appName] = errorMessage(error);
      }
    }
  }

  async pushNow(reason: "scheduled" | "manual" = "manual"): Promise<WorkspaceRuntimeSnapshot> {
    return reason === "scheduled" ? this.pushDue() : this.pushAll(reason);
  }

  async preview(value?: unknown): Promise<RenderedChannel> {
    if (value === undefined) return this.previewChannel(this.workspace.channels[0]!.id);
    const settings = validateSettings(value);
    const migrated = migrateDashboardSettings(settings, this.config.appName);
    return this.renderChannel(migrated.channels[0]!, false);
  }

  private queueDeviceWrite<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.deviceQueue.then(operation, operation);
    this.deviceQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }
}
