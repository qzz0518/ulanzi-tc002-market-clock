import type { AppConfig } from "./config.ts";
import { buildImagePayload, type ClockPayload } from "./display.ts";
import { renderDashboard, renderOfflineDashboard, type RenderedDashboard } from "./pixel-ui.ts";
import {
  MarketDataClient,
  type AssetMarketData,
  type PriceProvider,
} from "./price.ts";
import {
  SettingsStore,
  maximumAnimationDurationMs,
  validateSettings,
  type DashboardSettings,
} from "./settings.ts";
import type { AssetId } from "./assets.ts";

export interface AssetRuntimeSnapshot {
  assetId: AssetId;
  provider: PriceProvider;
  price: number;
  changePercent?: number;
  changePeriod?: "24H" | "1D";
  fetchedAt: string;
  sourceTime?: string;
  cached: boolean;
}

export interface DashboardRuntimeSnapshot {
  service: "ulanzi-tc002-market-clock";
  startedAt: string;
  healthy: boolean;
  degraded: boolean;
  pushing: boolean;
  deviceReachable: boolean;
  deviceVersions?: { mcu?: string; app?: string };
  settings: DashboardSettings;
  effectiveRefreshIntervalMs: number;
  animationDurationMs: number;
  assets: AssetRuntimeSnapshot[];
  assetErrors: Partial<Record<AssetId, string>>;
  lastPushAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  offlineDisplayed: boolean;
  updateCount: number;
}

export interface DashboardControllerOptions {
  config: AppConfig;
  settings: DashboardSettings;
  settingsStore: SettingsStore;
  marketClient?: MarketDataClient;
  pushPayload: (payload: ClockPayload) => Promise<{ status: number }>;
  now?: () => number;
}

export class DashboardController {
  private readonly config: AppConfig;
  private readonly settingsStore: SettingsStore;
  private readonly marketClient: MarketDataClient;
  private readonly pushPayload: DashboardControllerOptions["pushPayload"];
  private readonly now: () => number;
  private readonly startedAt: string;
  private settings: DashboardSettings;
  private readonly marketCache = new Map<AssetId, AssetMarketData>();
  private lastRender?: RenderedDashboard;
  private activePush?: Promise<DashboardRuntimeSnapshot>;
  private deviceReachable = false;
  private deviceVersions?: { mcu?: string; app?: string };
  private lastPushAt?: string;
  private lastError?: string;
  private assetErrors: Partial<Record<AssetId, string>> = {};
  private consecutiveFailures = 0;
  private offlineDisplayed = false;
  private updateCount = 0;

  constructor(options: DashboardControllerOptions) {
    this.config = options.config;
    this.settings = validateSettings(options.settings);
    this.settingsStore = options.settingsStore;
    this.marketClient = options.marketClient ?? new MarketDataClient({
      timeoutMs: options.config.requestTimeoutMs,
    });
    this.pushPayload = options.pushPayload;
    this.now = options.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
  }

  getSettings(): DashboardSettings {
    return structuredClone(this.settings);
  }

  async saveSettings(value: unknown): Promise<DashboardSettings> {
    const settings = validateSettings(value);
    this.settings = await this.settingsStore.save(settings);
    return this.getSettings();
  }

  setDeviceInfo(info: { mcuVersion?: string; appVersion?: string }): void {
    this.deviceReachable = true;
    this.deviceVersions = { mcu: info.mcuVersion, app: info.appVersion };
  }

  getEffectiveRefreshIntervalMs(settings = this.settings): number {
    return Math.max(settings.refreshIntervalMs, maximumAnimationDurationMs(settings));
  }

  getState(): DashboardRuntimeSnapshot {
    const nowMs = this.now();
    const lastPushMs = this.lastPushAt ? Date.parse(this.lastPushAt) : 0;
    const effectiveRefreshIntervalMs = this.getEffectiveRefreshIntervalMs();
    const healthWindowMs = Math.max(
      this.config.sourceStaleMs,
      effectiveRefreshIntervalMs * 2 + 5_000,
    );
    const assets = this.settings.assets.flatMap((assetId) => {
      const market = this.marketCache.get(assetId);
      return market ? [this.snapshotMarket(market, false)] : [];
    });
    const degraded =
      this.offlineDisplayed ||
      Object.keys(this.assetErrors).length > 0 ||
      assets.some((asset) => asset.provider === "kraken");
    return {
      service: "ulanzi-tc002-market-clock",
      startedAt: this.startedAt,
      healthy:
        this.deviceReachable &&
        lastPushMs > 0 &&
        nowMs - lastPushMs < healthWindowMs,
      degraded,
      pushing: this.activePush !== undefined,
      deviceReachable: this.deviceReachable,
      ...(this.deviceVersions ? { deviceVersions: this.deviceVersions } : {}),
      settings: this.getSettings(),
      effectiveRefreshIntervalMs,
      animationDurationMs:
        this.lastRender?.animationDurationMs ?? maximumAnimationDurationMs(this.settings),
      assets,
      assetErrors: { ...this.assetErrors },
      ...(this.lastPushAt ? { lastPushAt: this.lastPushAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      consecutiveFailures: this.consecutiveFailures,
      offlineDisplayed: this.offlineDisplayed,
      updateCount: this.updateCount,
    };
  }

  async preview(value?: unknown): Promise<RenderedDashboard> {
    const settings = value === undefined ? this.settings : validateSettings(value);
    const markets = await this.collectMarkets(settings.assets, false);
    return renderDashboard(markets, settings);
  }

  async pushNow(reason: "scheduled" | "manual" = "manual"): Promise<DashboardRuntimeSnapshot> {
    if (this.activePush) {
      await this.activePush;
      if (reason === "manual") return this.pushNow(reason);
      return this.getState();
    }
    const operation = this.performPush(reason);
    this.activePush = operation;
    try {
      await operation;
    } finally {
      if (this.activePush === operation) this.activePush = undefined;
    }
    return this.getState();
  }

  private async performPush(reason: "scheduled" | "manual"): Promise<DashboardRuntimeSnapshot> {
    try {
      const markets = await this.collectMarkets(this.settings.assets, true);
      const frame = renderDashboard(markets, this.settings);
      const durationSeconds = Math.min(
        86_400,
        Math.max(
          this.config.displayDurationSeconds,
          Math.ceil(frame.animationDurationMs / 1_000) + 30,
        ),
      );
      await this.pushPayload(buildImagePayload(frame.image, frame.mimeType, durationSeconds));
      this.lastRender = frame;
      this.deviceReachable = true;
      this.lastPushAt = new Date(this.now()).toISOString();
      this.lastError = undefined;
      this.consecutiveFailures = 0;
      this.offlineDisplayed = false;
      this.updateCount += 1;
      if (reason === "manual") this.assetErrors = { ...this.assetErrors };
      return this.getState();
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = error instanceof Error ? error.message : "unknown update error";
      const lastPushMs = this.lastPushAt ? Date.parse(this.lastPushAt) : 0;
      const stale = lastPushMs === 0 || this.now() - lastPushMs >= this.config.sourceStaleMs;
      if (stale && !this.offlineDisplayed) {
        try {
          const offline = renderOfflineDashboard();
          await this.pushPayload(
            buildImagePayload(
              offline.image,
              offline.mimeType,
              this.config.displayDurationSeconds,
            ),
          );
          this.deviceReachable = true;
          this.offlineDisplayed = true;
          this.lastPushAt = new Date(this.now()).toISOString();
        } catch {
          this.deviceReachable = false;
        }
      }
      throw error;
    }
  }

  private async collectMarkets(
    assetIds: readonly AssetId[],
    forceRefresh: boolean,
  ): Promise<AssetMarketData[]> {
    const errors: Partial<Record<AssetId, string>> = {};
    const markets = await Promise.all(
      assetIds.map(async (assetId) => {
        const cached = this.marketCache.get(assetId);
        if (!forceRefresh && cached) return cached;
        try {
          const market = await this.marketClient.getAsset(assetId);
          this.marketCache.set(assetId, market);
          return market;
        } catch (error) {
          errors[assetId] = error instanceof Error ? error.message : "market data failed";
          if (
            cached &&
            this.now() - Date.parse(cached.fetchedAt) < this.config.sourceStaleMs
          ) {
            return cached;
          }
          return undefined;
        }
      }),
    );
    this.assetErrors = errors;
    const available = markets.filter((market): market is AssetMarketData => market !== undefined);
    if (available.length === 0) {
      throw new Error(
        Object.values(errors)[0] ?? "no selected asset has available market data",
      );
    }
    return available;
  }

  private snapshotMarket(market: AssetMarketData, cached: boolean): AssetRuntimeSnapshot {
    return {
      assetId: market.assetId,
      provider: market.provider,
      price: market.price,
      ...(market.changePercent === undefined ? {} : { changePercent: market.changePercent }),
      ...(market.changePeriod === undefined ? {} : { changePeriod: market.changePeriod }),
      fetchedAt: market.fetchedAt,
      ...(market.sourceTime === undefined ? {} : { sourceTime: market.sourceTime }),
      cached,
    };
  }
}
