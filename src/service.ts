import { fileURLToPath } from "node:url";
import {
  deleteClockApp,
  pushClockPayloadNamed,
  readClockDeviceInfo,
  readClockGeneralSettings,
  readClockInfo,
  writeClockGeneralSettings,
} from "./clock-client.ts";
import { loadConfig } from "./config.ts";
import { ClockHostStore, type DeviceHostStatus } from "./device-host.ts";
import { OsLinkHub, type OsMenuEntry } from "./os-link.ts";
import {
  createControlHandler,
  resetDeviceMusicSelection,
  restoreDeviceLyricTheme,
} from "./control-api.ts";
import { LyricThemeStore } from "./lyric-theme-store.ts";
import { OsSleepRequestStore } from "./os-sleep-request-store.ts";
import { MusicSessionStore, NeteaseLyricsFallback, NeteaseMusicService } from "./netease-music.ts";
import { MusicHub, MusicProviderStore } from "./music/hub.ts";
import type { MusicLyricLine, MusicLyricWord } from "./music/core.ts";
import { LrclibLyricsClient } from "./music/lyrics.ts";
import { SpotifyAppStore, SpotifyMusicService, SpotifySessionStore } from "./music/spotify.ts";
import { createGameSocketHub } from "./game-socket.ts";
import { ConsoleBeacon } from "./console-beacon.ts";
import { discoverControlAccess } from "./network-access.ts";
import { WorkspaceStore, createDefaultWorkspace } from "./workspace.ts";
import { WorkspaceController } from "./workspace-controller.ts";
import { PixelAssetStore } from "./pixel-asset-store.ts";
import { UlanziPixelAssetClient } from "./ulanzi-pixel-assets.ts";
import {
  ARCADE_SIDELOAD_PROFILE,
  MUSIC_SIDELOAD_PROFILE,
  OS_SIDELOAD_PROFILE,
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
import { VibeUsageService } from "./vibe/usage-service.ts";
import { VibeIngestStore } from "./vibe/ingest-store.ts";
import { VibeStore } from "./vibe/vibe-store.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

const config = loadConfig();
// The launchd plist is not editable from the console, so an address the user typed
// there has to outrank CLOCK_HOST or it would be reverted by the very restart it is
// meant to survive. CLOCK_HOST remains the first-run seed (ADR 0005).
const clockHostStore = new ClockHostStore(".runtime/clock-host.json");
const envClockHost = config.clockHost;
let clockHostOverridden = false;
const storedClockHost = await clockHostStore.load();
if (storedClockHost) {
  clockHostOverridden = true;
  if (storedClockHost !== config.clockHost) {
    config.clockHost = storedClockHost;
    log("clock_host_override_applied", { host: storedClockHost, envHost: envClockHost });
  }
}
const clockHostStatus = (): DeviceHostStatus => ({
  host: config.clockHost,
  envHost: envClockHost,
  source: clockHostOverridden ? "override" : "env",
});
const workspaceStore = new WorkspaceStore(
  ".runtime/workspace.json",
  ".runtime/settings.json",
  config.appName,
);
// The 主题设置 the console's panel writes, kept across restarts. Loaded BEFORE
// the handler is built, because building it primes the ZOS link with whatever
// sDeviceState holds and the device applies that unconditionally — a restart
// that served the defaults would repaint the panel and clobber the device's own
// /data copy in the same poll (ADR 0007).
const lyricThemeStore = new LyricThemeStore(".runtime/lyric-theme.json");
restoreDeviceLyricTheme(await lyricThemeStore.load());
// Which usage metrics each AI agent pins on the LED. Loaded before the handler
// like the theme store above, for a plainer reason: the controller reads this
// table on the very first channel render, and a render that started on the
// catalog defaults would push a panel the user never asked for.
const vibeStore = new VibeStore(".runtime/vibe.json");
await vibeStore.load();
// Vendor API keys live in their own 0600 file, for vendors with no CLI on this
// machine to borrow a login from. All four agents VIBE collects have one, so the
// Each adapter talks to its own vendor over the public internet, so these
// requests take the normal route — CLOCK_HTTP_PROXY is for the device only.
//
// The ingest store is always constructed, never conditional on the token: the
// console has to be able to say「远程采集未启用，设置 VIBE_INGEST_TOKEN 即可」
// and list the machines already pushing, and it cannot do either through a
// route that answers 404 (ADR 0013).
const vibeIngest = new VibeIngestStore();
// Docker writes /.dockerenv into every container it starts; Podman and most
// others leave the same marker or set container=. Checked once at boot because
// it cannot change under a running process, and used only to pick the wording
// of the console's empty state.
const containerized = await Bun.file("/.dockerenv").exists()
  || (process.env.container ?? "") !== "";
const vibeClient = new VibeUsageService({
  ingest: vibeIngest,
});
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
// Re-resolved per call: once PUT /api/device/host repoints the clock, a boot-time
// same-subnet verdict is stale and the phone-control popover would keep advertising
// the wrong answer. This route only fires when that popover opens.
const controlAccess = () => discoverControlAccess({
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
  // Deferred read: osLink is constructed below. zosFlashed() is sticky and
  // device-reported — only the device knows what is in its flash, and once it
  // has said so the answer does not change until somebody reflashes, at which
  // point the service is restarted anyway.
  devicePushSuspended: () => osLink.zosFlashed(),
  pixelAssetStore,
  instrumentStore,
  marketIconStore,
  dynamicMarketClient,
  weatherClient: new WeatherClient({ timeoutMs: config.requestTimeoutMs }),
  vibeClient,
  vibeStarred: () => vibeStore.getStarred(),
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
  // A getter, not a value: the clock is repointable at runtime, and the ADB target
  // must follow it instead of freezing whatever CLOCK_HOST said at boot (ADR 0005).
  get clockHost() { return config.clockHost; },
  adbPath: process.env.ADB_BIN,
  profile: MUSIC_SIDELOAD_PROFILE,
  bundleStore: new MusicPlayerBundleStore(
    MUSIC_SIDELOAD_PROFILE.releaseDirectory,
    MUSIC_SIDELOAD_PROFILE,
  ),
  verifyClock: verifySideloadClock,
  serviceOrigin: sideloadServiceOrigin,
  // Deferred read: osLink is constructed below, and what a power cycle brings
  // back is a fact only the device reports.
  zosFlashed: () => osLink.zosFlashed(),
});
const arcadeInstaller = new Tc002SideloadInstaller({
  get clockHost() { return config.clockHost; },
  adbPath: process.env.ADB_BIN,
  profile: ARCADE_SIDELOAD_PROFILE,
  bundleStore: new MusicPlayerBundleStore(
    ARCADE_SIDELOAD_PROFILE.releaseDirectory,
    ARCADE_SIDELOAD_PROFILE,
  ),
  verifyClock: verifySideloadClock,
  serviceOrigin: sideloadServiceOrigin,
  // Deferred read: osLink is constructed below, and what a power cycle brings
  // back is a fact only the device reports.
  zosFlashed: () => osLink.zosFlashed(),
});

const osInstaller = new Tc002SideloadInstaller({
  get clockHost() { return config.clockHost; },
  adbPath: process.env.ADB_BIN,
  profile: OS_SIDELOAD_PROFILE,
  bundleStore: new MusicPlayerBundleStore(
    OS_SIDELOAD_PROFILE.releaseDirectory,
    OS_SIDELOAD_PROFILE,
  ),
  verifyClock: verifySideloadClock,
  serviceOrigin: sideloadServiceOrigin,
  // Deferred read: osLink is constructed below, and what a power cycle brings
  // back is a fact only the device reports.
  zosFlashed: () => osLink.zosFlashed(),
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
// Channel pushes keep curl because they are not latency-bound. Both transports
// route through CLOCK_HTTP_PROXY when it is set — the proxy is not an optional
// extra but the only path to the device on hosts where the service process may
// not open LAN sockets itself (see requestWithFetch in clock-client.ts).
const notify = new NotifyManager({
  pushPayload: (payload) => queueLiveWrite(() => pushClockPayloadNamed(config, NOTIFY_APP, payload, fetch)),
  clearApp: () => queueLiveWrite(() => deleteClockApp(config, NOTIFY_APP, fetch)),
  onCleanupError: (error) => log("notify_cleanup_failed", { error: errorMessage(error) }),
});

let stopping = false;
let wakeSleep: (() => void) | undefined;
const loggedUpdateCounts = new Map<string, number>();
// Logged once, on the transition. Otherwise silent by design — the loop still
// runs every interval, and a line per pass would be a line a minute forever.
let osPushSuppressed = false;

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

// The tc002-os firmware pulls its own menu, so the workspace's enabled channels
// are republished on every settings change. setMenu is idempotent — an unchanged
// list does not bump the sequence — so this can be called freely without waking
// every parked long poll.
//
// Each channel carries a content revision and a time-to-live along with its
// label. Those two fields are the whole reason a saved edit reaches the panel:
// the device caches a channel's frames, and a menu of ids and labels alone
// compares equal after every content edit ever made, so the sequence never
// moved and the parked poll was never released. The revision moves when the
// pixels would; the ttl says how long a render of a clock face stays true.
//
// The 夜间息屏 request is the one piece of hub state that must outlive the
// process. The device applies it only on a RISING sequence, and that counter
// used to restart at 0 on every `bun start` while the clock was still up holding
// the last number it had applied — so the console's next change was silently
// refused, and the user had to make as many changes as the old counter had
// reached before one took. Loaded before the first document is served, because
// the device polls long before anybody opens a browser.
const osSleepRequestStore = new OsSleepRequestStore(".runtime/os-sleep-request.json", log);
const osLink = new OsLinkHub(() => Date.now(), osSleepRequestStore);
const restoredSleepRequest = await osSleepRequestStore.load();
osLink.restoreSleepRequest(restoredSleepRequest);
// Logged even when there is nothing to resume: "which sequence am I at" was
// unanswerable while this lived in module memory, and the failure it causes is
// invisible from both ends — the route answers 200 and the panel does nothing.
log("os_sleep_request_restored", { seq: restoredSleepRequest?.seq ?? 0 });
function publishOsMenu(): void {
  const entries: OsMenuEntry[] = controller.getWorkspace().channels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      id: channel.appName,
      label: channel.name,
      kind: "channel" as const,
      rev: controller.channelContentRevision(channel),
      ttlMs: controller.getEffectiveRefreshIntervalMs(channel),
    }));
  // The three built-in destinations always follow the channels, so their
  // position does not shift as the user adds and removes content.
  entries.push({ id: "music", label: "音乐", kind: "music" });
  entries.push({ id: "game", label: "游戏", kind: "game" });
  entries.push({ id: "vibe", label: "VIBE", kind: "vibe" });
  entries.push({ id: "settings", label: "设置", kind: "settings" });
  osLink.setMenu(entries);
}
publishOsMenu();

/**
 * Publishes the AI-usage rows the panel's VIBE app draws.
 *
 * Reads the controller's cached snapshot rather than forcing a collection: this
 * runs on a timer and on every settings change, and ten vendors do not need a
 * conversation because somebody renamed a channel. `getVibeUsage(false)` serves
 * the cache and only reaches the network when there is nothing to serve.
 *
 * Nothing signed in is a state, not a failure — the document then carries
 * `vibe\t0` and the panel draws its own 未登录 page, exactly as the console does.
 */
async function publishOsVibe(): Promise<void> {
  try {
    const view = await controller.getVibeUsage(false);
    osLink.setVibe(view.snapshot.providers.map((provider) => {
      const starred = view.starred[provider.id] ?? [];
      // Star order decides row order; a starred metric the vendor did not send
      // this round simply has no row rather than an invented zero.
      const metrics = starred
        .map((key) => provider.metrics.find((metric) => metric.key === key))
        .filter((metric): metric is NonNullable<typeof metric> => metric !== undefined);
      return {
        id: provider.id,
        label: provider.displayName,
        plan: provider.plan ?? "",
        stale: provider.stale,
        metrics: metrics.map((metric) => {
          const value = metric.kind === "balance" ? metric.available : metric.used;
          const resetsAt = metric.resetsAt === undefined ? Number.NaN : Date.parse(metric.resetsAt);
          return {
            label: metric.label,
            used: value ?? 0,
            // A meter needs a ceiling to mean anything; percent metrics carry
            // one, a credit balance does not and is drawn as a bare number.
            limit: metric.unit === "percent" ? metric.limit ?? 100 : 0,
            resetSec: Number.isFinite(resetsAt) ? Math.round((resetsAt - Date.now()) / 1000) : -1,
          };
        }),
      };
    }));
  } catch {
    // Signed into nothing, or every vendor refused: the panel says so itself.
    osLink.setVibe([]);
  }
}
void publishOsVibe();
// Same cadence as the collector's own floor, so a republish never costs a
// vendor request — it only moves numbers the collector already refreshed.
//
// unref'd like every other timer here. A referenced interval holds the event
// loop open, and this process is stopped by a signal: without this it survives
// SIGINT/SIGTERM and only dies when something works out to SIGKILL it, which on
// a launchd-managed service turns every restart into a stall.
const osVibeTimer = setInterval(() => { void publishOsVibe(); }, 5 * 60_000);
osVibeTimer.unref?.();

// --- now playing, for the tc002-os music screen ------------------------------
// The device-facing music endpoints carry a track *id*; a 52x16 panel needs a
// title. Only the service holds the credentials that turn one into the other,
// so the lookup lives here and the firmware reads plain text.
let osNowTrackId: string | null = null;
let osNowLyrics: MusicLyricLine[] = [];
let osNowTitle = "";
let osNowArtist = "";

interface OsLyricWindow {
  text: string;
  startMs: number;
  /** When the line stops being sung. */
  endMs: number;
  /** When the next line takes over. */
  untilMs: number;
  words?: MusicLyricWord[];
}

function lyricAt(
  lines: readonly MusicLyricLine[],
  positionMs: number,
  durationMs: number,
): OsLyricWindow {
  // Linear rather than a binary search on purpose: a song is a few hundred
  // lines and this runs twice a second.
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.startMs > positionMs) break;
    index = i;
  }
  if (index < 0) return { text: "", startMs: 0, endMs: 0, untilMs: 0 };
  const current = lines[index]!;
  const next = lines[index + 1];
  // Two different questions, and conflating them is the bug this whole change
  // exists to fix. `untilMs` is when the NEXT line takes over — the last line
  // of a song runs to the end of the track, or four seconds if the duration is
  // unknown, byte for byte the fallback in the sideloaded player. `endMs` is
  // when this line stopped being SUNG, which the provider already worked out
  // from word timings or bounded with an estimate; re-deriving it here from the
  // next line's start (which is what this used to do) threw that away and left
  // ZOS crawling through every instrumental.
  const untilMs = next
    ? next.startMs
    : (durationMs > current.startMs ? durationMs : current.startMs + 4000);
  const endMs = current.endMs > current.startMs
    // A foreign duration (a Connect snapshot of a different master) can make
    // the window shorter than the line the provider timed.
    ? Math.min(current.endMs, untilMs)
    : untilMs;
  return {
    text: current.text,
    startMs: current.startMs,
    endMs,
    untilMs,
    ...(current.words ? { words: current.words } : {}),
  };
}

async function publishOsNowPlaying(): Promise<void> {
  const provider = music.activeProvider();
  if (!provider.remote || !provider.status().loggedIn) {
    // Every write here is tagged "remote", and the hub refuses a silent write
    // over a source that is playing. That is what makes this null safe to send
    // twice a second while NetEase is active: it clears a stale Connect reading
    // without touching the browser's report, and it is also the sweeper that
    // eventually drops a console report whose tab died without saying goodbye
    // (the hub frees the field once that report goes stale).
    osLink.setNowPlaying(null, "remote");
    return;
  }
  let snapshot;
  try {
    snapshot = await provider.remote.snapshot();
  } catch {
    // Keep the last good reading rather than blanking the panel: a transient
    // Connect error is not the same as nothing playing, and this is exactly the
    // "never fabricate, but never lie by omission either" case the market
    // renderers already settle the same way.
    return;
  }
  if (!snapshot.trackId) {
    osLink.setNowPlaying(null, "remote");
    return;
  }
  if (snapshot.trackId !== osNowTrackId) {
    osNowTrackId = snapshot.trackId;
    osNowLyrics = [];
    osNowTitle = "";
    osNowArtist = "";
    try {
      const detail = await provider.trackDetail(snapshot.trackId);
      osNowTitle = detail.track.title;
      osNowArtist = detail.track.artists.join(" / ");
      osNowLyrics = detail.lyrics;
    } catch {
      // A title we cannot resolve still leaves a usable transport view.
    }
  }
  const line = lyricAt(osNowLyrics, snapshot.positionMs, snapshot.durationMs);
  osLink.setNowPlaying({
    track: osNowTitle,
    artist: osNowArtist,
    playing: snapshot.playing,
    positionMs: snapshot.positionMs,
    durationMs: snapshot.durationMs,
    lyric: line.text,
    lyricStartMs: line.startMs,
    lyricEndMs: line.endMs,
    lyricUntilMs: line.untilMs,
    ...(line.words ? { lyricWords: line.words } : {}),
  }, "remote");
}

// Gated on the device actually being attached: this reaches out to Spotify, and
// polling a third-party API forever because the service happens to be running
// would be rude to it and pointless to us. The firmware reports every 10 s from
// boot, so the gate opens on its own.
const osNowTimer = setInterval(() => {
  if (!osLink.isDeviceLive()) return;
  void publishOsNowPlaying().catch(() => {});
}, 2_000);
osNowTimer.unref?.();

const controlHandler = createControlHandler(controller, {
  onSettingsChanged: () => {
    // A star change must reach the panel now, not at the next five-minute tick.
    void publishOsVibe();
    publishOsMenu();
    wakeSleep?.();
  },
  osLink,
  // What `mise run os-image` packs (device/tc002-os/release/pack-image.ts). The
  // device pulls its document and its pixels over HTTP, so it pulls its firmware
  // the same way; naming the path here rather than in the handler keeps it a
  // fixed string that no request can influence.
  osFirmwarePath: ".runtime/tc002-os/update.img",
  // The way back to Ulanzi's own firmware, packed by `mise run os-restore-image`
  // from the device's live /res BEFORE ZOS was flashed over it. Irreplaceable:
  // Ulanzi publishes no TC002 download, there is no recovery partition, and
  // running the packer now would only pack the running ZOS.
  osRestorePath: ".runtime/tc002-stock/restore-live.img",
  lyricThemeStore,
  controlAccess,
  deviceGeneralSettings: {
    read: () => readClockGeneralSettings(config),
    write: (settings) => writeClockGeneralSettings(config, settings),
  },
  deviceInfo: {
    read: async () => {
      const info = await readClockDeviceInfo(config);
      // Keep /health's versions in step with the last successful probe; the boot
      // probe below is the only other writer and it never runs again. The narrow
      // shape is deliberate — serial and MAC must not enter the health snapshot.
      controller.setDeviceInfo({ mcuVersion: info.mcuVersion, appVersion: info.appVersion });
      return info;
    },
  },
  deviceHost: {
    read: () => clockHostStatus(),
    write: async (host) => {
      const saved = await clockHostStore.save(host);
      // One assignment is the whole rewiring: clock-client interpolates
      // config.clockHost on every request, the installers read it through a
      // getter, and controlAccess re-resolves per call (ADR 0005).
      config.clockHost = saved;
      clockHostOverridden = true;
      log("clock_host_changed", { host: saved, envHost: envClockHost });
      return clockHostStatus();
    },
    reset: async () => {
      await clockHostStore.clear();
      config.clockHost = envClockHost;
      clockHostOverridden = false;
      log("clock_host_reset", { host: envClockHost });
      return clockHostStatus();
    },
  },
  pixelAssetLibrary: { client: ulanziPixelAssets, store: pixelAssetStore },
  music,
  musicInstaller,
  arcadeInstaller,
  osInstaller,
  live: {
    push: (appName, payload) => queueLiveWrite(() => pushClockPayloadNamed(config, appName, payload, fetch)),
    clear: (appName) => queueLiveWrite(() => deleteClockApp(config, appName, fetch)),
  },
  notify,
  notifyToken: config.notifyToken,
  marketCatalog,
  vibe: {
    status: async (refresh) => {
      try {
        // The console's 刷新 is the one caller allowed past the collection floor.
        const view = await controller.getVibeUsage(refresh, refresh);
        return {
          starred: view.starred,
          snapshot: view.snapshot,
          error: null,
        };
      } catch (error) {
        // Signed into nothing yet is the normal first-run state, so the console
        // gets a 200 with the reason and renders its setup guide.
        return {
          starred: vibeStore.getStarred(),
          snapshot: null,
          error: errorMessage(error),
        };
      }
    },
    setStarred: (providerId, starred) => {
      const next = vibeStore.setStarred(providerId, starred);
      // The panel draws the starred metrics, so a star change is a change to
      // what is ON THE CLOCK. Without this it reached the device at the next
      // five-minute tick, while both reference docs and the console's own
      // caption promised it arrived at once — the docs were right about the
      // design and the wiring was the part that was missing.
      void publishOsVibe();
      return next;
    },
  },
  vibeIngest: {
    ...(config.vibeIngestToken ? { token: config.vibeIngestToken } : {}),
    accept: (body) => {
      vibeIngest.accept(body);
      // A push is fresh numbers for the panel, so it reaches the clock now
      // rather than up to VIBE_STALE_MS later. The cache must be dropped first
      // — publishOsVibe reads with forceRefresh=false and would otherwise be
      // served the very snapshot this push supersedes.
      controller.invalidateVibeUsage();
      void publishOsVibe();
    },
    machines: () => vibeIngest.listMachines(),
    containerized,
    forget: (machine) => {
      const forgotten = vibeIngest.forget(machine);
      if (forgotten) {
        controller.invalidateVibeUsage();
        void publishOsVibe();
      }
      return forgotten;
    },
  },
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

// The LAN beacon. Started after the listener, because what it announces is where
// that listener can be reached and there is no point telling a device to poll a
// port nothing is bound to yet. Failure to start is logged and survivable: this
// repairs a link that is already broken, so it must never be the reason a
// console that would otherwise work does not come up.
const consoleBeacon = config.consoleDiscovery
  ? new ConsoleBeacon({
    consolePort: config.healthPort,
    announcePort: config.consoleDiscoveryPort,
    // A getter, like the installers': the clock is repointable at runtime and
    // the interface choice follows it rather than freezing at boot (ADR 0005).
    clockHost: () => config.clockHost,
    log,
  })
  : undefined;
if (consoleBeacon) {
  try {
    await consoleBeacon.start();
  } catch (error) {
    log("console_beacon_start_failed", { error: errorMessage(error) });
  }
} else {
  log("console_beacon_disabled", { reason: "CONSOLE_DISCOVERY" });
}

function beginShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log("shutdown_requested", { signal });
  wakeSleep?.();
  // Closes game sockets and flushes the doodle wall before the listener dies.
  void gameSockets.stop();
  consoleBeacon?.stop();
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
    // The loop keeps its schedule under a flashed ZOS; only the device write is
    // dropped (see WorkspaceControllerOptions.devicePushSuspended). Suspending
    // the loop itself was the shape this started as, and it froze every quote
    // and temperature in the process: pushDue() is the only periodic caller
    // that renders with forceRefresh, and forceRefresh is the only thing that
    // goes to the network for market and weather data.
    if (!osPushSuppressed && osLink.zosFlashed()) {
      osPushSuppressed = true;
      log("device_push_suspended", {
        reason: "zos_flashed",
        detail: "the device pulls its own frames; channels keep refreshing on their interval",
      });
    }
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
