import { fileURLToPath } from "node:url";
import {
  deleteClockApp,
  pushClockPayloadNamed,
  readClockGeneralSettings,
  readClockInfo,
  writeClockGeneralSettings,
} from "./clock-client.ts";
import { loadConfig } from "./config.ts";
import { createControlHandler, resetDeviceMusicSelection } from "./control-api.ts";
import { MusicSessionStore, NeteaseLyricsFallback, NeteaseMusicService } from "./netease-music.ts";
import { MusicHub, MusicProviderStore } from "./music/hub.ts";
import { LrclibLyricsClient } from "./music/lyrics.ts";
import { SpotifyAppStore, SpotifyMusicService, SpotifySessionStore } from "./music/spotify.ts";
import { createGameSocketHub } from "./game-socket.ts";
import { discoverControlAccess } from "./network-access.ts";
import { WorkspaceStore, createDefaultWorkspace } from "./workspace.ts";
import { WorkspaceController } from "./workspace-controller.ts";
import { PixelAssetStore } from "./pixel-asset-store.ts";
import { UlanziPixelAssetClient } from "./ulanzi-pixel-assets.ts";
import {
  ARCADE_SIDELOAD_PROFILE,
  MUSIC_SIDELOAD_PROFILE,
  MusicPlayerBundleStore,
  Tc002SideloadInstaller,
} from "./tc002-music-installer.ts";
import { InstrumentStore } from "./market/instruments.ts";
import { MarketIconStore } from "./market/icon-store.ts";
import { MarketSearchService } from "./market/search.ts";
import { MarketCatalogService } from "./market/catalog-service.ts";
import { DynamicMarketDataClient } from "./market/quotes.ts";
import { BundledCryptoLogoCatalog } from "./market/logo-catalog.ts";
import { NotifyManager } from "./notify.ts";
import { WeatherClient } from "./weather/client.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

const config = loadConfig();
const workspaceStore = new WorkspaceStore(
  ".runtime/workspace.json",
  ".runtime/settings.json",
  config.appName,
);
const pixelAssetStore = new PixelAssetStore(".runtime/pixel-assets");
const instrumentStore = new InstrumentStore(".runtime/market-instruments");
const marketIconStore = new MarketIconStore(".runtime/market-icons");
await Promise.all([instrumentStore.load(), marketIconStore.load()]);
const dynamicMarketClient = new DynamicMarketDataClient({ timeoutMs: config.requestTimeoutMs });
const marketCatalog = new MarketCatalogService({
  instruments: instrumentStore,
  icons: marketIconStore,
  search: new MarketSearchService({ timeoutMs: config.requestTimeoutMs }),
  logos: new BundledCryptoLogoCatalog(fileURLToPath(new URL("./assets/crypto-icons", import.meta.url))),
});
const refreshedMarketIcons = await marketCatalog.reconcileGeneratedIcons();
if (refreshedMarketIcons.length > 0) {
  log("market_icons_refreshed", { instruments: refreshedMarketIcons });
}
for (const issue of marketCatalog.getIssues()) {
  log("market_store_issue", { error: issue });
}
const ulanziPixelAssets = new UlanziPixelAssetClient({ timeoutMs: config.requestTimeoutMs });
const netease = new NeteaseMusicService({
  sessionStore: new MusicSessionStore(".runtime/music-session.json"),
});
const spotify = new SpotifyMusicService({
  appStore: new SpotifyAppStore(".runtime/spotify-app.json"),
  sessionStore: new SpotifySessionStore(".runtime/spotify-session.json"),
  // Spotify only accepts loopback for plaintext redirects, so the callback
  // always comes back to this machine regardless of which host the studio was
  // opened on; a LAN browser finishes the login by pasting the URL back.
  redirectUri: `http://127.0.0.1:${config.healthPort}/api/music/spotify/callback`,
  // Spotify publishes no lyric API; LRCLIB covers most catalogues and NetEase
  // fills in the Mandarin and Cantopop it misses.
  lyrics: new LrclibLyricsClient({
    timeoutMs: config.requestTimeoutMs,
    fallback: new NeteaseLyricsFallback(netease),
  }),
  timeoutMs: Math.max(config.requestTimeoutMs, 8_000),
});
const music = new MusicHub({
  netease,
  spotify,
  store: new MusicProviderStore(".runtime/music-provider.json"),
  onSwitch: (provider) => {
    resetDeviceMusicSelection(provider.id);
    log("music_provider_switched", { provider: provider.id });
  },
});
await music.initialize();
for (const [provider, error] of music.initializeFailures) {
  log("music_session_load_failed", { provider, error, fallback: "signed_out" });
}
const controlAccess = discoverControlAccess({
  clockHost: config.clockHost,
  controlHost: config.controlHost,
  port: config.healthPort,
});
let workspace = createDefaultWorkspace(config.appName);
try {
  workspace = await workspaceStore.load();
} catch (error) {
  log("workspace_load_failed", { error: errorMessage(error), fallback: "defaults" });
}

const controller = new WorkspaceController({
  config,
  workspace,
  workspaceStore,
  pushPayload: (appName, payload) => pushClockPayloadNamed(config, appName, payload),
  deleteApp: (appName) => deleteClockApp(config, appName),
  pixelAssetStore,
  instrumentStore,
  marketIconStore,
  dynamicMarketClient,
  weatherClient: new WeatherClient({ timeoutMs: config.requestTimeoutMs }),
});
// Both sideloadable apps (music player, arcade) share one installer class and
// the same clock verification / service-origin closures; only the profile
// differs (ADR 0004).
const verifySideloadClock = async () => {
  const info = await readClockInfo(config);
  return { mcuVersion: info.mcuVersion, appVersion: info.appVersion };
};
const sideloadServiceOrigin = async () => {
  const access = await discoverControlAccess({
    clockHost: config.clockHost,
    controlHost: config.controlHost,
    port: config.healthPort,
  });
  return access.address ? `http://${access.address}:${config.healthPort}` : null;
};
const musicInstaller = new Tc002SideloadInstaller({
  clockHost: config.clockHost,
  adbPath: process.env.ADB_BIN,
  profile: MUSIC_SIDELOAD_PROFILE,
  bundleStore: new MusicPlayerBundleStore(
    MUSIC_SIDELOAD_PROFILE.releaseDirectory,
    MUSIC_SIDELOAD_PROFILE,
  ),
  verifyClock: verifySideloadClock,
  serviceOrigin: sideloadServiceOrigin,
});
const arcadeInstaller = new Tc002SideloadInstaller({
  clockHost: config.clockHost,
  adbPath: process.env.ADB_BIN,
  profile: ARCADE_SIDELOAD_PROFILE,
  bundleStore: new MusicPlayerBundleStore(
    ARCADE_SIDELOAD_PROFILE.releaseDirectory,
    ARCADE_SIDELOAD_PROFILE,
  ),
  verifyClock: verifySideloadClock,
  serviceOrigin: sideloadServiceOrigin,
});

const NOTIFY_APP = "notify";
let liveWriteQueue: Promise<unknown> = Promise.resolve();
function queueLiveWrite<T>(operation: () => Promise<T>): Promise<T> {
  const next = liveWriteQueue.then(operation, operation);
  liveWriteQueue = next.catch(() => undefined);
  return next;
}
// Latency-critical device writes (live frames, notifications) use Bun's native
// fetch: spawning a curl subprocess per write costs ~170ms while a direct fetch
// is ~16ms, which is the difference between 25fps animation and a slideshow.
// Channel pushes keep curl because they are not latency-bound and curl carries
// the CLOCK_HTTP_PROXY scenario; live/notify therefore bypass that proxy.
const notify = new NotifyManager({
  pushPayload: (payload) => queueLiveWrite(() => pushClockPayloadNamed(config, NOTIFY_APP, payload, fetch)),
  clearApp: () => queueLiveWrite(() => deleteClockApp(config, NOTIFY_APP, fetch)),
  onCleanupError: (error) => log("notify_cleanup_failed", { error: errorMessage(error) }),
});

let stopping = false;
let wakeSleep: (() => void) | undefined;
const loggedUpdateCounts = new Map<string, number>();

function interruptibleSleep(ms: number): Promise<void> {
  if (stopping) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = undefined;
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = undefined;
      resolve();
    };
  });
}

const controlHandler = createControlHandler(controller, {
  onSettingsChanged: () => wakeSleep?.(),
  controlAccess: () => controlAccess,
  deviceGeneralSettings: {
    read: () => readClockGeneralSettings(config),
    write: (settings) => writeClockGeneralSettings(config, settings),
  },
  pixelAssetLibrary: { client: ulanziPixelAssets, store: pixelAssetStore },
  music,
  musicInstaller,
  arcadeInstaller,
  live: {
    push: (appName, payload) => queueLiveWrite(() => pushClockPayloadNamed(config, appName, payload, fetch)),
    clear: (appName) => queueLiveWrite(() => deleteClockApp(config, appName, fetch)),
  },
  notify,
  notifyToken: config.notifyToken,
  marketCatalog,
});
const gameSockets = await createGameSocketHub({
  doodlePath: ".runtime/doodle.json",
  onError: (scope, error) => log("game_socket_error", { scope, error: errorMessage(error) }),
});
const controlServer = Bun.serve({
  // 0.0.0.0 so the TC002 on the LAN can reach the device-facing endpoints
  // (e.g. /api/music/device/audio); localhost clients still work.
  hostname: "0.0.0.0",
  port: config.healthPort,
  fetch: (request, server) => {
    // Gamepad/doodle WebSocket upgrades are decided before the REST handler;
    // a matched route either upgrades (undefined) or answers with the reason.
    const upgrade = gameSockets.handleUpgrade(request, server);
    if (upgrade.matched) return upgrade.response;
    return controlHandler(request);
  },
  websocket: gameSockets.websocket,
});

function beginShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log("shutdown_requested", { signal });
  wakeSleep?.();
  // Closes game sockets and flushes the doodle wall before the listener dies.
  void gameSockets.stop();
  controlServer.stop(true);
}

process.once("SIGINT", () => beginShutdown("SIGINT"));
process.once("SIGTERM", () => beginShutdown("SIGTERM"));

async function run(): Promise<void> {
  log("service_started", {
    clockHost: config.clockHost,
    channels: controller.getWorkspace().channels.map((channel) => ({
      appName: channel.appName,
      items: channel.items.map((item) => item.contentId),
    })),
    controlUrl: `http://${config.controlHost}:${config.healthPort}/`,
  });

  try {
    const info = await readClockInfo(config);
    controller.setDeviceInfo(info);
    log("clock_detected", { mcu: info.mcuVersion, app: info.appVersion });
  } catch (error) {
    log("clock_detection_failed", { error: errorMessage(error) });
  }

  while (!stopping) {
    try {
      const state = await controller.pushDue();
      const updatedChannels = state.channels.filter((channel) =>
        channel.updateCount > (loggedUpdateCounts.get(channel.id) ?? 0)
      );
      for (const channel of updatedChannels) {
        loggedUpdateCounts.set(channel.id, channel.updateCount);
      }
      if (updatedChannels.length > 0 || state.degraded) {
        log("channels_checked", {
          channels: updatedChannels.map((channel) => ({
            appName: channel.appName,
            updateCount: channel.updateCount,
            animationDurationMs: channel.animationDurationMs,
            degraded: channel.degraded,
          })),
          degraded: state.degraded,
        });
      }
    } catch (error) {
      log("update_failed", {
        error: errorMessage(error),
      });
    }

    await interruptibleSleep(controller.getNextWakeMs());
  }

  log("service_stopped");
}

await run();
