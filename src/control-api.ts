import { createHash, timingSafeEqual } from "node:crypto";
import { ASSET_PRESETS, isAssetId, type AssetId } from "./assets.ts";
import { getContentCatalog } from "./content-registry.ts";
import type { DashboardController } from "./controller.ts";
import {
  DeviceSettingsValidationError,
  validateDeviceGeneralSettings,
  type DeviceGeneralSettings,
} from "./device-settings.ts";
import { validateDeviceHost, type DeviceHostStatus } from "./device-host.ts";
import type { ClockDeviceInfo } from "./clock-client.ts";
import { OS_INPUT_ACTIONS, type OsInputAction, type OsLinkHub } from "./os-link.ts";
import { encodeFrameBundle, rgbaToRgb } from "./os-frames.ts";
import { renderAssetIconTile } from "./pixel-ui.ts";
import type { ControlAccessInfo } from "./network-access.ts";
import {
  isMusicProviderId,
  isSafeMediaId,
  MusicServiceError,
  proxyMusicArt,
  type MusicProvider,
  type MusicProviderId,
  type MusicRemoteSnapshot,
} from "./music/core.ts";
import type { MusicHub } from "./music/hub.ts";
import { PWA_ICONS, PWA_MANIFEST, pwaServiceWorker } from "./pwa.ts";
import { SettingsValidationError } from "./settings.ts";
import { getStockIconPng, isStockIconId } from "./stock-icons.ts";
import { controlPageHtml, drawPageHtml, padPageHtml } from "./web-ui.ts";
import { WORKSPACE_LIMITS, type ChannelConfig } from "./workspace.ts";
import type { WorkspaceController } from "./workspace-controller.ts";
import type { PixelAssetStore } from "./pixel-asset-store.ts";
import {
  MusicInstallerError,
  type Tc002SideloadInstaller,
} from "./tc002-music-installer.ts";
import { buildImagePayload, type ClockPayload } from "./display.ts";
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  encodePixelAnimation,
  PixelCanvas,
} from "./pixel-ui.ts";
import {
  ULANZI_PIXEL_ASSET_CLASSIFICATIONS,
  type UlanziPixelAssetClassification,
  type UlanziPixelAssetSort,
  type UlanziPixelAssetClient,
} from "./ulanzi-pixel-assets.ts";
import {
  importVideoAsGif,
  VIDEO_IMPORT_MAX_BYTES,
  VideoImportError,
  type VideoImportRequest,
  type VideoImportResult,
} from "./video-import.ts";
import type { MarketCatalogService } from "./market/catalog-service.ts";
import { parseNotifyMessage, type NotifyMessage } from "./notify.ts";
import {
  type MarketInstrument,
  type MarketInstrumentKind,
} from "./market/instruments.ts";
import { GeocodeClient, parseGeocodeQuery, type GeocodePlace } from "./weather/geocode.ts";

const CLOCK_FRAME_FILE = Bun.file(new URL("./assets/tc002-frame.png", import.meta.url));
const WEB_ASSETS = new Map([
  ["/assets/studio.css", {
    url: new URL("../dist/assets/studio.css", import.meta.url),
    type: "text/css; charset=utf-8",
  }],
  ["/assets/studio.js", {
    url: new URL("../dist/assets/studio.js", import.meta.url),
    type: "text/javascript; charset=utf-8",
  }],
]);

export interface ControlApiOptions {
  onSettingsChanged?: () => void;
  controlAccess?: () => ControlAccessInfo | Promise<ControlAccessInfo>;
  deviceGeneralSettings?: {
    read: () => Promise<DeviceGeneralSettings>;
    write: (settings: DeviceGeneralSettings) => Promise<DeviceGeneralSettings>;
  };
  deviceInfo?: {
    read: () => Promise<ClockDeviceInfo>;
  };
  deviceHost?: {
    read: () => DeviceHostStatus;
    write: (host: string) => Promise<DeviceHostStatus>;
    reset: () => Promise<DeviceHostStatus>;
  };
  osLink?: OsLinkHub;
  pixelAssetLibrary?: {
    client: UlanziPixelAssetClient;
    store: PixelAssetStore;
    // Test seam; defaults to the real ffmpeg pipeline in video-import.ts.
    importVideo?: (input: VideoImportRequest) => Promise<VideoImportResult>;
  };
  music?: MusicHub;
  musicInstaller?: Tc002SideloadInstaller;
  arcadeInstaller?: Tc002SideloadInstaller;
  osInstaller?: Tc002SideloadInstaller;
  musicMirror?: {
    push: (payload: ClockPayload) => Promise<{ status: number }>;
    clear: () => Promise<{ status: number }>;
  };
  live?: {
    push: (appName: string, payload: ClockPayload) => Promise<{ status: number }>;
    clear: (appName: string) => Promise<{ status: number }>;
  };
  notify?: {
    push: (input: NotifyMessage) => Promise<{ status: number }>;
    clear: () => Promise<{ status: number }>;
  };
  notifyToken?: string;
  notifyNow?: () => number;
  marketCatalog?: MarketCatalogService;
  // Test seam; defaults to the real Open-Meteo geocoding client (free, no key).
  weatherGeocode?: { search(query: string): Promise<GeocodePlace[]> };
}

// The device's live music control state. The web UI mutates it via /control (and
// /select); the device polls /state and applies changes; the device reports its
// own key-press changes back via /report. Single-device service, so module state
// is fine. `seq` bumps on every change so both sides can detect "something moved".
type LyricMode = "ticker" | "skyline" | "spotlight" | "cascade";
type LyricSkin = "signal" | "tape" | "blueprint" | "arcade";
interface DeviceMusicState {
  // Which music source the selection belongs to. NetEase IDs are decimal and
  // Spotify IDs are base62, so the device needs both to interpret trackId.
  provider: MusicProviderId;
  trackId: string | null;
  playing: boolean;
  mode: LyricMode;
  skin: LyricSkin;
  accent: string | null; // "RRGGBB" hex overriding the skin's primary, or null
  seekMs: number;         // last web-requested seek target (ms), or -1 for none
  seq: number;
}
const LYRIC_MODES: readonly LyricMode[] = ["ticker", "skyline", "spotlight", "cascade"];
const LYRIC_SKINS: readonly LyricSkin[] = ["signal", "tape", "blueprint", "arcade"];
const sDeviceState: DeviceMusicState = {
  provider: "netease",
  trackId: null,
  playing: true,
  mode: "spotlight",
  skin: "signal",
  accent: null,
  seekMs: -1,
  seq: 0,
};

// Switching sources invalidates the selection: the new provider cannot resolve
// the old provider's track ID, so the device falls back to its idle screen.
export function resetDeviceMusicSelection(provider: MusicProviderId): void {
  sDeviceState.provider = provider;
  sDeviceState.trackId = null;
  sDeviceState.seekMs = -1;
  sDeviceState.playing = provider === "netease";
  sDeviceState.seq += 1;
  sDeviceLive.trackId = null;
  sDeviceLive.playheadMs = 0;
}

// Merge a partial control patch (from /control or /report) into the state,
// validating each field, and bump seq if anything actually changed.
function applyControlPatch(input: unknown): void {
  const patch = (input ?? {}) as Record<string, unknown>;
  let changed = false;
  if ("playing" in patch) {
    if (typeof patch.playing !== "boolean") throw new SettingsValidationError("playing must be boolean");
    sDeviceState.playing = patch.playing;
    changed = true;
  }
  if ("mode" in patch) {
    if (typeof patch.mode !== "string" || !LYRIC_MODES.includes(patch.mode as LyricMode))
      throw new SettingsValidationError("mode is invalid");
    sDeviceState.mode = patch.mode as LyricMode;
    changed = true;
  }
  if ("skin" in patch) {
    if (typeof patch.skin !== "string" || !LYRIC_SKINS.includes(patch.skin as LyricSkin))
      throw new SettingsValidationError("skin is invalid");
    sDeviceState.skin = patch.skin as LyricSkin;
    changed = true;
  }
  if ("accent" in patch) {
    if (patch.accent === null) {
      sDeviceState.accent = null;
    } else if (typeof patch.accent === "string" && /^[0-9a-fA-F]{6}$/.test(patch.accent)) {
      sDeviceState.accent = patch.accent.toLowerCase();
    } else {
      throw new SettingsValidationError("accent must be RRGGBB hex or null");
    }
    changed = true;
  }
  if ("trackId" in patch) {
    sDeviceState.trackId = patch.trackId === null ? null : mediaId(patch.trackId, "trackId");
    changed = true;
  }
  if ("seekMs" in patch) {
    if (typeof patch.seekMs !== "number" || !Number.isFinite(patch.seekMs) || patch.seekMs < 0)
      throw new SettingsValidationError("seekMs must be a non-negative number");
    sDeviceState.seekMs = Math.round(patch.seekMs);
    changed = true;
  }
  if (changed) sDeviceState.seq += 1;
}

// The device's reported live status (from /heartbeat): what it is actually
// playing right now and when it last checked in. Distinct from sDeviceState,
// which is the *target* the web UI sets. The web uses heartbeatAt to detect the
// music firmware is running, and playheadMs to align its preview to the device.
interface DeviceLiveStatus {
  heartbeatAt: number; // Date.now() of the last heartbeat, 0 if never
  firmwarePollAt: number; // Date.now() of the last firmware /state poll, 0 if never
  trackId: string | null;
  playheadMs: number;
  playing: boolean;
}
const sDeviceLive: DeviceLiveStatus = {
  heartbeatAt: 0,
  firmwarePollAt: 0,
  trackId: null,
  playheadMs: 0,
  playing: false,
};

// The arcade firmware's liveness channel: a 5s POST with the current game,
// phase and score. Unlike the music firmware there is no control state for
// the device to pull, so a tiny push endpoint plus this in-memory snapshot is
// the whole protocol. Single-device service, so module state is fine.
interface ArcadeLiveStatus {
  heartbeatAt: number; // Date.now() of the last heartbeat, 0 if never
  game: string;        // "menu" | "breakout" | "flappy" | "snake" | "pong" | ...
  phase: string;       // "ready" | "playing" | "over" | ...
  score: number;
  uptimeMs: number;
}
const sArcadeLive: ArcadeLiveStatus = {
  heartbeatAt: 0,
  game: "",
  phase: "",
  score: 0,
  uptimeMs: 0,
};
// Heartbeats come every 5s; two misses plus network slack means offline.
const ARCADE_ONLINE_WINDOW_MS = 12_000;

interface IconAsset {
  bytes: Uint8Array;
  version: string;
}

const ICON_ASSETS = new Map<AssetId, IconAsset>(
  ASSET_PRESETS.map((preset) => {
    const bytes = isStockIconId(preset.id)
      ? getStockIconPng(preset.id)
      : renderAssetIconTile(preset.id).toPng();
    return [
      preset.id,
      {
        bytes,
        version: createHash("sha256").update(bytes).digest("hex").slice(0, 12),
      },
    ];
  }),
);

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function arrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  const requestUrl = new URL(request.url);
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new SettingsValidationError("request origin is invalid");
  }
  if (originUrl.protocol !== requestUrl.protocol || originUrl.host !== requestUrl.host) {
    throw new SettingsValidationError("cross-origin changes are not allowed");
  }
}

async function readJson(
  request: Request,
  maxBytes: number = WORKSPACE_LIMITS.maxRequestBytes,
): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > maxBytes) {
    throw new SettingsValidationError("request body is too large");
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new SettingsValidationError("Content-Type must be application/json");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new SettingsValidationError("request body is too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SettingsValidationError("request body must contain valid JSON");
  }
}

/**
 * The four-route device-app lifecycle (status/probe/session start/stop) is
 * identical for every sideloadable app; one helper serves it under each
 * prefix so the two firmwares' behavior cannot drift apart. Returns null for
 * paths outside `/api/<scope>/device-app`.
 */
async function deviceAppResponse(
  request: Request,
  url: URL,
  scope: "music" | "arcade" | "os",
  installer: Tc002SideloadInstaller | undefined,
): Promise<Response | null> {
  const base = `/api/${scope}/device-app`;
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
  if (!installer) {
    return jsonResponse({ error: `${scope} device installer is unavailable` }, 404);
  }

  if (request.method === "GET" && url.pathname === base) {
    return jsonResponse({ deviceApp: await installer.status() });
  }

  if (request.method === "POST" && url.pathname === `${base}/probe`) {
    assertSameOrigin(request);
    return jsonResponse({ device: await installer.probe() });
  }

  if (request.method === "POST" && url.pathname === `${base}/session/start`) {
    assertSameOrigin(request);
    const input = await readJson(request) as {
      confirmation?: unknown;
      expectedBundleId?: unknown;
    };
    if (typeof input.confirmation !== "string" || typeof input.expectedBundleId !== "string") {
      throw new SettingsValidationError("session confirmation and bundleId are required");
    }
    return jsonResponse({
      result: await installer.startSession({
        confirmation: input.confirmation,
        expectedBundleId: input.expectedBundleId,
      }),
    });
  }

  if (request.method === "POST" && url.pathname === `${base}/session/stop`) {
    assertSameOrigin(request);
    return jsonResponse({ result: await installer.stopSession() });
  }

  return null;
}

function marketInstrumentPayload(
  catalog: MarketCatalogService,
  instrument: MarketInstrument,
): MarketInstrument & { iconUrl: string; iconMode: "fallback" | "catalog" | null } {
  const icon = catalog.icons.get(instrument.iconRef);
  return {
    ...instrument,
    iconUrl: `/api/market/icons/${instrument.iconRef}.png${icon ? `?v=${icon.pixelSha256.slice(0, 12)}` : ""}`,
    iconMode: icon?.mode ?? null,
  };
}

type ControlController = DashboardController | WorkspaceController;

function supportsWorkspace(controller: ControlController): controller is WorkspaceController {
  return "getWorkspace" in controller && "previewChannel" in controller;
}

function boundedQueryInteger(
  url: URL,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SettingsValidationError(`${key} is invalid`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SettingsValidationError(`${label} is invalid`);
  }
  return value;
}

function tokensMatch(expected: string, candidate: string | null): boolean {
  if (candidate === null) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

function notifyAuthorized(request: Request, url: URL, expected: string | undefined): boolean {
  if (!expected) return true;
  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  return tokensMatch(expected, bearer) || tokensMatch(expected, url.searchParams.get("token"));
}

function createNotifyRateLimiter(now: () => number): () => boolean {
  const capacity = 6;
  const refillPerMs = capacity / 10_000;
  let tokens = capacity;
  let lastRefillAt = now();
  return () => {
    const current = now();
    const elapsed = Math.max(0, current - lastRefillAt);
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
    lastRefillAt = current;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

const MIRROR_FRAME_BYTES = DISPLAY_WIDTH * DISPLAY_HEIGHT * 3;
// 400 帧覆盖一句 12 秒的歌词跑满 33fps。真机实测官方固件 400 帧 / 48KB 请求体照收，只用
// 109ms，所以这个上限管的是渲染与传输成本，不是设备容量。
const MIRROR_MAX_FRAMES = 400;
// 每帧 base64 约 3.3KB，满帧一次请求约 1.3MB——比通用的 256KB 上限大，单独放宽这一个
// 端点，而不是把所有写接口的门槛都抬上去。
const MIRROR_REQUEST_BYTES = 2048 * 1024;

function decodeMirrorFrames(
  value: unknown,
): { canvas: PixelCanvas; delayMs: number }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MIRROR_MAX_FRAMES) {
    throw new SettingsValidationError(
      `mirror frames must contain 1 to ${MIRROR_MAX_FRAMES} entries`,
    );
  }
  return value.map((entry) => {
    const record = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    // 下限 20ms：GIF 的厘秒粒度下 50fps 还能如实表达，再快就得指望解码器不去钳它。
    const delayMs = boundedInteger(record.delayMs, 20, 10_000, "frame delayMs");
    if (typeof record.pixels !== "string" || record.pixels.length > MIRROR_FRAME_BYTES * 2) {
      throw new SettingsValidationError("frame pixels are invalid");
    }
    const bytes = Buffer.from(record.pixels, "base64");
    if (bytes.length !== MIRROR_FRAME_BYTES) {
      throw new SettingsValidationError(
        `frame pixels must decode to ${MIRROR_FRAME_BYTES} RGB bytes`,
      );
    }
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT, [0, 0, 0]);
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        const offset = (y * DISPLAY_WIDTH + x) * 3;
        canvas.setPixel(x, y, [bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!]);
      }
    }
    return { canvas, delayMs };
  });
}

function liveAppName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]{0,15}$/.test(value)) {
    throw new SettingsValidationError("live app must match ^[a-z][a-z0-9]{0,15}$");
  }
  return `live_${value}`;
}

function buildLiveFramePayload(input: {
  frames?: unknown;
  holdSeconds?: unknown;
}): { payload: ClockPayload; frameCount: number; holdSeconds: number } {
  const frames = decodeMirrorFrames(input.frames);
  const totalMs = frames.reduce((sum, frame) => sum + frame.delayMs, 0);
  const holdSeconds = input.holdSeconds === undefined
    ? Math.min(86_400, Math.ceil(totalMs / 1_000) + 30)
    : boundedInteger(input.holdSeconds, 5, 86_400, "holdSeconds");
  const image = frames.length === 1
    ? { bytes: frames[0]!.canvas.toPng(), mimeType: "image/png" as const }
    : {
      // One submitted batch plays once and holds its final frame. Producers
      // that need freshness submit the next batch through the single-flight queue.
      bytes: encodePixelAnimation(
        frames.map((frame) => frame.canvas),
        frames.map((frame) => frame.delayMs),
        { repeat: -1 },
      ),
      mimeType: "image/gif" as const,
    };
  return {
    payload: buildImagePayload(image.bytes, image.mimeType, holdSeconds),
    frameCount: frames.length,
    holdSeconds,
  };
}

// Track and playlist IDs are opaque strings now that two providers share the
// same routes: NetEase hands out decimals, Spotify base62.
function mediaId(value: unknown, label: string): string {
  const raw = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value) // tolerated so an older firmware build's numeric report still lands
    : typeof value === "string"
      ? value
      : "";
  if (!isSafeMediaId(raw)) throw new SettingsValidationError(`${label} is invalid`);
  return raw;
}

function optionalMediaId(value: unknown): string | null {
  try {
    return value === null || value === undefined ? null : mediaId(value, "trackId");
  } catch {
    return null;
  }
}

function activeMusicProvider(hub: MusicHub): MusicProvider {
  return hub.activeProvider();
}

// Read the Connect player and fold it into the shared device state. Both the
// firmware and the web poll /state on their own cadence, and the provider
// caches the upstream call, so this stays one Spotify request every couple of
// seconds no matter how many readers there are.
async function pollRemote(hub: MusicHub): Promise<MusicRemoteSnapshot | null> {
  const provider = hub.activeProvider();
  if (!provider.remote || !provider.status().loggedIn) return null;
  let snapshot: MusicRemoteSnapshot;
  try {
    snapshot = await provider.remote.snapshot();
  } catch {
    return null;
  }
  // Whatever the Connect player moved to becomes the device's selection, so
  // starting a song on your phone re-targets the lyrics on the clock.
  if (snapshot.trackId && snapshot.trackId !== sDeviceState.trackId) {
    sDeviceState.provider = provider.id;
    sDeviceState.trackId = snapshot.trackId;
    sDeviceState.seekMs = -1;
    sDeviceState.seq += 1;
  }
  if (snapshot.playing !== sDeviceState.playing) {
    sDeviceState.playing = snapshot.playing;
    sDeviceState.seq += 1;
  }
  return snapshot;
}

type RemoteAction = "play" | "pause" | "next" | "previous" | "seek" | "volume" | "transfer";
const REMOTE_ACTIONS: readonly RemoteAction[] = [
  "play",
  "pause",
  "next",
  "previous",
  "seek",
  "volume",
  "transfer",
];

// One command shape for both callers: the web studio posts to /api/music/remote,
// and the TC002's key presses arrive as the same fields on /device/report.
function readRemoteAction(patch: Record<string, unknown>): RemoteAction | null {
  if (typeof patch.action === "string") {
    if (!REMOTE_ACTIONS.includes(patch.action as RemoteAction)) {
      throw new SettingsValidationError("action is invalid");
    }
    return patch.action as RemoteAction;
  }
  if (typeof patch.playing === "boolean") return patch.playing ? "play" : "pause";
  if (patch.volume !== undefined) return "volume";
  return null;
}

async function applyRemoteAction(
  provider: MusicProvider,
  input: unknown,
  options: { required?: boolean } = {},
): Promise<MusicRemoteSnapshot | null> {
  const remote = provider.remote;
  if (!remote) {
    throw new SettingsValidationError(`${provider.label} does not support remote playback control`);
  }
  const patch = (input ?? {}) as Record<string, unknown>;
  const action = readRemoteAction(patch);
  if (action === null) {
    if (options.required) throw new SettingsValidationError("action is required");
    return null;
  }

  switch (action) {
    case "play": {
      const trackId = patch.trackId === undefined || patch.trackId === null
        ? undefined
        : mediaId(patch.trackId, "trackId");
      const positionMs = patch.positionMs === undefined
        ? undefined
        : boundedInteger(patch.positionMs, 0, 86_400_000, "positionMs");
      await remote.play({
        ...(trackId ? { trackId } : {}),
        ...(positionMs === undefined ? {} : { positionMs }),
      });
      break;
    }
    case "pause":
      await remote.pause();
      break;
    case "next":
      await remote.next();
      break;
    case "previous":
      await remote.previous();
      break;
    case "seek":
      await remote.seek(boundedInteger(patch.positionMs, 0, 86_400_000, "positionMs"));
      break;
    case "volume":
      await remote.setVolume(
        boundedInteger(patch.percent ?? patch.volume, 0, 100, "volume percent"),
      );
      break;
    case "transfer": {
      if (typeof patch.deviceId !== "string") {
        throw new SettingsValidationError("deviceId is required");
      }
      await remote.transfer(patch.deviceId, patch.play !== false);
      break;
    }
  }
  // The caller wants the state the command produced, not the one before it.
  return await remote.snapshot(true).catch(() => null);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] ?? character));
}

// The page Spotify's redirect lands on. Self-contained so it renders before the
// studio bundle exists, and it closes itself when it was opened as a popup.
function spotifyCallbackPage(ok: boolean, message: string): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${ok ? "Spotify 已连接" : "Spotify 连接失败"}</title>` +
    `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;` +
    `font:16px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;background:#0b0d0c;color:#e9f0ec}` +
    `main{max-width:32rem;padding:2rem;text-align:center}` +
    `h1{font-size:1.25rem;margin:0 0 .5rem;color:${ok ? "#1ed760" : "#ff6b6b"}}` +
    `p{margin:0;color:#9bb0a5}</style></head><body><main>` +
    `<h1>${ok ? "Spotify 已连接" : "Spotify 连接失败"}</h1>` +
    `<p>${escapeHtml(message)}</p>` +
    `<p>${ok ? "可以关闭此页面，回到 Pixel Studio 继续。" : "请回到 Pixel Studio 重试。"}</p>` +
    `</main><script>if(window.opener){setTimeout(function(){window.close()},1200)}</script>` +
    `</body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  });
}

function positivePathId(value: string | undefined, label: string): number {
  if (!value || !/^\d{1,18}$/.test(value)) {
    throw new SettingsValidationError(`${label} ID is invalid`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new SettingsValidationError(`${label} ID is invalid`);
  }
  return id;
}

function previewResponse(preview: {
  image: Uint8Array;
  mimeType: string;
  animationDurationMs: number;
  frames: readonly unknown[];
}): Response {
  return new Response(arrayBufferCopy(preview.image), {
    headers: {
      "Content-Type": preview.mimeType,
      "Cache-Control": "no-store",
      "X-Animation-Duration-Ms": String(preview.animationDurationMs),
      "X-Frame-Count": String(preview.frames.length),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function createControlHandler(
  controller: ControlController,
  options: ControlApiOptions = {},
): (request: Request) => Promise<Response> {
  const consumeNotifyToken = createNotifyRateLimiter(options.notifyNow ?? (() => Date.now()));
  // Same token-bucket policy as /api/notify (6 per 10s), but a separate bucket:
  // a burst of webhook notifications must not lock players out of the board.
  const weatherGeocode = options.weatherGeocode ?? new GeocodeClient();
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(controlPageHtml(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Content-Security-Policy": [
              "default-src 'self'",
              "img-src 'self' blob:",
              "media-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "script-src 'self'",
              "worker-src 'self'",
              "connect-src 'self'",
              "manifest-src 'self'",
              "base-uri 'none'",
              "frame-ancestors 'none'",
              "form-action 'self'",
            ].join("; "),
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
          },
        });
      }

      // Self-contained companion pages (QR targets): the Pong gamepad and the
      // doodle wall. Inline script/style only, talking to the same-origin
      // /api/game/socket relay — hence the ws: allowance in connect-src.
      if (request.method === "GET" && (url.pathname === "/pad" || url.pathname === "/draw")) {
        return new Response(url.pathname === "/pad" ? padPageHtml() : drawPageHtml(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Content-Security-Policy": [
              "default-src 'none'",
              "style-src 'unsafe-inline'",
              "script-src 'unsafe-inline'",
              "connect-src 'self' ws: wss:",
              "base-uri 'none'",
              "form-action 'none'",
            ].join("; "),
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/manifest.webmanifest") {
        return new Response(JSON.stringify(PWA_MANIFEST), {
          headers: {
            "Content-Type": "application/manifest+json; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/sw.js") {
        return new Response(pwaServiceWorker(), {
          headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
            "Service-Worker-Allowed": "/",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (request.method === "GET" && PWA_ICONS.has(url.pathname)) {
        return new Response(arrayBufferCopy(PWA_ICONS.get(url.pathname)!), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=604800",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (request.method === "GET" && WEB_ASSETS.has(url.pathname)) {
        const asset = WEB_ASSETS.get(url.pathname)!;
        const file = Bun.file(asset.url);
        if (!await file.exists()) {
          return jsonResponse({ error: "web asset is not built" }, 404);
        }
        return new Response(file, {
          headers: {
            "Content-Type": asset.type,
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/favicon.svg") {
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#f4f4f4"/><circle cx="16" cy="16" r="11" fill="#c5f6cc"/><path fill="#159b2d" d="M10 10h5v5h-5zm7 0h5v5h-5zm-7 7h5v5h-5zm7 0h5v5h-5z"/></svg>',
          { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } },
        );
      }

      if (request.method === "GET" && url.pathname === "/assets/tc002-frame.png") {
        return new Response(CLOCK_FRAME_FILE, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const iconMatch = url.pathname.match(/^\/api\/icons\/([a-z]+)\.png$/);
      if (request.method === "GET" && iconMatch) {
        const assetId = iconMatch[1];
        if (!isAssetId(assetId)) return jsonResponse({ error: "unknown asset icon" }, 404);
        const icon = ICON_ASSETS.get(assetId)!;
        return new Response(arrayBufferCopy(icon.bytes), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const marketIconMatch = url.pathname.match(/^\/api\/market\/icons\/(ico_[a-f0-9]{32})\.png$/);
      if (request.method === "GET" && marketIconMatch) {
        if (!options.marketCatalog) return jsonResponse({ error: "market catalog is unavailable" }, 404);
        const manifest = options.marketCatalog.icons.get(marketIconMatch[1]!);
        if (!manifest) return jsonResponse({ error: "market icon not found" }, 404);
        const etag = `"${manifest.pixelSha256}"`;
        if (request.headers.get("If-None-Match") === etag) {
          return new Response(null, {
            status: 304,
            headers: {
              ETag: etag,
              "Cache-Control": "public, max-age=31536000, immutable",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        const bytes = await options.marketCatalog.icons.getPng(manifest.ref);
        return new Response(arrayBufferCopy(bytes), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=31536000, immutable",
            ETag: etag,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/presets") {
        return jsonResponse({
          presets: ASSET_PRESETS.map((preset) => ({
            ...preset,
            iconUrl: `/api/icons/${preset.id}.png?v=${ICON_ASSETS.get(preset.id)!.version}`,
          })),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/catalog") {
        return jsonResponse({
          categories: [
            { id: "market", label: "市场" },
            { id: "tools", label: "工具" },
            { id: "visual", label: "视觉" },
            { id: "creative", label: "创作" },
          ],
          contents: getContentCatalog(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/market/instruments") {
        if (!options.marketCatalog) return jsonResponse({ error: "market catalog is unavailable" }, 404);
        return jsonResponse({
          instruments: options.marketCatalog.list().map((instrument) =>
            marketInstrumentPayload(options.marketCatalog!, instrument)
          ),
          issues: options.marketCatalog.getIssues(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/market/search") {
        if (!options.marketCatalog) return jsonResponse({ error: "market catalog is unavailable" }, 404);
        const query = (url.searchParams.get("q") ?? "").trim();
        if (query.length < 1 || query.length > 48) {
          throw new SettingsValidationError("q must contain 1-48 characters");
        }
        const rawKind = url.searchParams.get("kind");
        if (rawKind !== null && !["crypto", "fx", "metal", "stock"].includes(rawKind)) {
          throw new SettingsValidationError("kind is invalid");
        }
        return jsonResponse(await options.marketCatalog.search(
          query,
          rawKind as MarketInstrumentKind | undefined,
        ));
      }

      if (request.method === "POST" && url.pathname === "/api/market/instruments") {
        if (!options.marketCatalog) return jsonResponse({ error: "market catalog is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request) as { candidateRef?: unknown };
        if (typeof input.candidateRef !== "string" || !/^cand_[a-f0-9]{32}$/.test(input.candidateRef)) {
          throw new SettingsValidationError("candidateRef is invalid");
        }
        let instrument;
        try {
          instrument = await options.marketCatalog.register(input.candidateRef);
        } catch (error) {
          throw new SettingsValidationError(error instanceof Error ? error.message : "candidate could not be registered");
        }
        return jsonResponse({
          instrument: marketInstrumentPayload(options.marketCatalog, instrument),
        }, 201);
      }

      if (request.method === "GET" && url.pathname === "/api/weather/geocode") {
        assertSameOrigin(request);
        let query: string;
        try {
          query = parseGeocodeQuery(url.searchParams.get("q"));
        } catch (error) {
          throw new SettingsValidationError(error instanceof Error ? error.message : "q is invalid");
        }
        // The client already slims each entry to name/admin1/country/lat/lon,
        // so the route forwards its result as-is.
        return jsonResponse({ places: await weatherGeocode.search(query) });
      }

      if (request.method === "GET" && url.pathname === "/api/access") {
        if (!options.controlAccess) {
          return jsonResponse({ error: "control access information is unavailable" }, 404);
        }
        return jsonResponse({ access: await options.controlAccess() });
      }

      if (request.method === "GET" && url.pathname === "/api/music/providers") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({ music: options.music.overview() });
      }

      if (request.method === "POST" && url.pathname === "/api/music/provider") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request) as { provider?: unknown };
        if (!isMusicProviderId(input.provider)) {
          throw new SettingsValidationError("provider must be netease or spotify");
        }
        return jsonResponse({ music: await options.music.setActive(input.provider) });
      }

      if (request.method === "GET" && url.pathname === "/api/music/session") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({ session: activeMusicProvider(options.music).status() });
      }

      if (request.method === "GET" && url.pathname === "/api/music/art") {
        // Same-origin album art. The `url` must be one the providers handed us,
        // which the host allowlist enforces; nothing else is fetchable through
        // this route.
        const target = url.searchParams.get("url") ?? "";
        if (target.length < 8 || target.length > 2_048) {
          throw new SettingsValidationError("cover url is invalid");
        }
        return await proxyMusicArt(target);
      }

      if (request.method === "GET" && url.pathname === "/api/music/avatar") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        // The caller may name the source it wants. Without that, a switch and an
        // in-flight avatar request race to decide whose face is shown.
        const requested = url.searchParams.get("provider");
        if (requested !== null && !isMusicProviderId(requested)) {
          throw new SettingsValidationError("provider must be netease or spotify");
        }
        const provider = requested === null
          ? activeMusicProvider(options.music)
          : options.music.provider(requested);
        return await provider.avatar();
      }

      if (request.method === "POST" && url.pathname === "/api/music/qr") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        return jsonResponse({ login: await options.music.netease.createQrLogin() }, 201);
      }

      if (request.method === "POST" && url.pathname === "/api/music/qr/check") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request) as { id?: unknown };
        if (typeof input.id !== "string") throw new SettingsValidationError("QR session ID is required");
        return jsonResponse({ login: await options.music.netease.checkQrLogin(input.id) });
      }

      if (request.method === "POST" && url.pathname === "/api/music/logout") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        const provider = activeMusicProvider(options.music);
        await provider.logout();
        resetDeviceMusicSelection(provider.id);
        return jsonResponse({ session: provider.status(), music: options.music.overview() });
      }

      if (request.method === "GET" && url.pathname === "/api/music/search") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({
          tracks: await activeMusicProvider(options.music).search(url.searchParams.get("query") ?? ""),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/music/playlists") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({ playlists: await activeMusicProvider(options.music).playlists() });
      }

      const playlistTracksMatch = url.pathname.match(/^\/api\/music\/playlists\/([A-Za-z0-9_-]{1,64})\/tracks$/);
      if (request.method === "GET" && playlistTracksMatch) {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({
          tracks: await activeMusicProvider(options.music).playlistTracks(playlistTracksMatch[1]!),
        });
      }

      const musicTrackMatch = url.pathname.match(/^\/api\/music\/tracks\/([A-Za-z0-9_-]{1,64})$/);
      if (request.method === "GET" && musicTrackMatch) {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({
          detail: await activeMusicProvider(options.music).trackDetail(musicTrackMatch[1]!),
        });
      }

      const musicStreamMatch = url.pathname.match(/^\/api\/music\/tracks\/([A-Za-z0-9_-]{1,64})\/stream$/);
      if (request.method === "GET" && musicStreamMatch) {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        const provider = activeMusicProvider(options.music);
        if (!provider.stream) {
          // Spotify audio never leaves Spotify's own clients; the studio player
          // is a Connect remote there, not an audio element.
          return jsonResponse({ error: `${provider.label} 不提供音频流，请使用远程播放` }, 409);
        }
        return await provider.stream(musicStreamMatch[1]!, request.headers.get("Range"));
      }

      /* ------------------------------ Spotify ------------------------------ */

      if (request.method === "GET" && url.pathname === "/api/music/spotify/app") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({ app: options.music.spotify.appStatus() });
      }

      if (request.method === "PUT" && url.pathname === "/api/music/spotify/app") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request) as { clientId?: unknown };
        if (typeof input.clientId !== "string") {
          throw new SettingsValidationError("clientId is required");
        }
        return jsonResponse({ app: await options.music.spotify.saveApp(input.clientId) });
      }

      if (request.method === "POST" && url.pathname === "/api/music/spotify/login") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        return jsonResponse({ login: options.music.spotify.beginLogin() }, 201);
      }

      if (request.method === "GET" && url.pathname === "/api/music/spotify/callback") {
        // Spotify redirects the browser here after consent. This is a top-level
        // navigation from accounts.spotify.com, so it carries no Origin header
        // and the state parameter is what proves the request is ours.
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        const denied = url.searchParams.get("error");
        if (denied) return spotifyCallbackPage(false, `Spotify 拒绝了授权：${denied}`);
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        try {
          const profile = await options.music.spotify.completeLogin({ code, state });
          return spotifyCallbackPage(true, `已连接 ${profile.nickname}`);
        } catch (error) {
          return spotifyCallbackPage(
            false,
            error instanceof Error ? error.message : "登录失败，请重试",
          );
        }
      }

      if (request.method === "POST" && url.pathname === "/api/music/spotify/complete") {
        // Fallback for a browser that is not on this machine: the loopback
        // redirect cannot reach the service, so the user pastes the URL back.
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request) as { redirectUrl?: unknown };
        if (typeof input.redirectUrl !== "string") {
          throw new SettingsValidationError("redirectUrl is required");
        }
        const profile = await options.music.spotify.completeLoginFromRedirect(input.redirectUrl);
        return jsonResponse({ session: { loggedIn: true, profile } });
      }

      if (request.method === "GET" && url.pathname === "/api/music/spotify/devices") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({ devices: await options.music.spotify.devices() });
      }

      /* --------------------------- Remote transport -------------------------- */

      if (request.method === "POST" && url.pathname === "/api/music/remote") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        const snapshot = await applyRemoteAction(
          activeMusicProvider(options.music),
          await readJson(request),
          { required: true },
        );
        return jsonResponse({ snapshot });
      }

      // Sideload lifecycle for both device apps, same four routes each.
      const deviceAppRouted =
        await deviceAppResponse(request, url, "music", options.musicInstaller)
        ?? await deviceAppResponse(request, url, "arcade", options.arcadeInstaller)
        ?? await deviceAppResponse(request, url, "os", options.osInstaller);
      if (deviceAppRouted) return deviceAppRouted;

      if (request.method === "POST" && url.pathname === "/api/arcade/heartbeat") {
        // The arcade firmware checks in every 5s with what it is running
        // (cross-origin: the caller is the TC002, not the browser).
        const input = await readJson(request) as {
          game?: unknown;
          phase?: unknown;
          score?: unknown;
          uptimeMs?: unknown;
        };
        if (typeof input.game !== "string" || !/^[a-z][a-z0-9-]{0,23}$/.test(input.game)) {
          throw new SettingsValidationError("game is invalid");
        }
        if (typeof input.phase !== "string" || !/^[a-z][a-z0-9-]{0,23}$/.test(input.phase)) {
          throw new SettingsValidationError("phase is invalid");
        }
        if (
          !Number.isSafeInteger(input.score)
          || (input.score as number) < 0
          || (input.score as number) > 1_000_000_000
        ) {
          throw new SettingsValidationError("score is invalid");
        }
        if (
          typeof input.uptimeMs !== "number"
          || !Number.isFinite(input.uptimeMs)
          || input.uptimeMs < 0
        ) {
          throw new SettingsValidationError("uptimeMs is invalid");
        }
        sArcadeLive.heartbeatAt = Date.now();
        sArcadeLive.game = input.game;
        sArcadeLive.phase = input.phase;
        sArcadeLive.score = input.score as number;
        sArcadeLive.uptimeMs = input.uptimeMs;
        return jsonResponse({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/arcade/status") {
        // The web's "is the arcade firmware live?" read: pure memory, so the
        // game view can poll it every 10s for free. A fresh heartbeat proves
        // liveness; right after a sideload the installer's session bridges
        // the gap until the first heartbeat lands.
        assertSameOrigin(request);
        const ageMs = sArcadeLive.heartbeatAt > 0 ? Date.now() - sArcadeLive.heartbeatAt : -1;
        const online = (ageMs >= 0 && ageMs < ARCADE_ONLINE_WINDOW_MS)
          || options.arcadeInstaller?.sessionState().active === true
          || options.osInstaller?.sessionState().active === true;
        return jsonResponse({
          online,
          ageMs,
          game: sArcadeLive.game,
          phase: sArcadeLive.phase,
          score: sArcadeLive.score,
        });
      }

      if (["POST", "DELETE"].includes(request.method) && url.pathname === "/api/notify") {
        if (!options.notify) {
          return jsonResponse({ error: "notification service is unavailable" }, 404);
        }
        if (!notifyAuthorized(request, url, options.notifyToken)) {
          return jsonResponse({ error: "notification token is invalid" }, 401);
        }
        if (request.method === "DELETE") {
          await options.notify.clear();
          return jsonResponse({ ok: true });
        }
        const input = parseNotifyMessage(await readJson(request));
        if (!consumeNotifyToken()) {
          return jsonResponse({ error: "notification rate limit exceeded" }, 429);
        }
        await options.notify.push(input);
        return jsonResponse({ ok: true, holdSeconds: input.holdSeconds });
      }

      if (request.method === "POST" && url.pathname === "/api/music/mirror") {
        const writer = options.live
          ? {
            push: (payload: ClockPayload) => options.live!.push("music_lyrics", payload),
            clear: () => options.live!.clear("music_lyrics"),
          }
          : options.musicMirror;
        if (!writer) {
          return jsonResponse({ error: "music mirror is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request, MIRROR_REQUEST_BYTES) as {
          frames?: unknown;
          holdSeconds?: unknown;
        };
        const encoded = buildLiveFramePayload(input);
        const pushed = await writer.push(encoded.payload);
        return jsonResponse({ mirror: { status: pushed.status, frames: encoded.frameCount } });
      }

      if (request.method === "DELETE" && url.pathname === "/api/music/mirror") {
        const writer = options.live
          ? { clear: () => options.live!.clear("music_lyrics") }
          : options.musicMirror;
        if (!writer) {
          return jsonResponse({ error: "music mirror is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const cleared = await writer.clear();
        return jsonResponse({ mirror: { status: cleared.status, frames: 0 } });
      }

      if (request.method === "POST" && url.pathname === "/api/live/frames") {
        if (!options.live) return jsonResponse({ error: "live frame service is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request, MIRROR_REQUEST_BYTES) as {
          app?: unknown;
          frames?: unknown;
          holdSeconds?: unknown;
        };
        const appName = liveAppName(input.app);
        const encoded = buildLiveFramePayload(input);
        await options.live.push(appName, encoded.payload);
        return new Response(null, { status: 204 });
      }

      if (request.method === "DELETE" && url.pathname === "/api/live/frames") {
        if (!options.live) return jsonResponse({ error: "live frame service is unavailable" }, 404);
        assertSameOrigin(request);
        await options.live.clear(liveAppName(url.searchParams.get("app")));
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && url.pathname === "/api/music/device/select") {
        // The web UI reports the track it just selected (same-origin). Selecting
        // a track also (re)starts playback — locally on the TC002 for NetEase,
        // or on the chosen Spotify Connect device for Spotify.
        assertSameOrigin(request);
        const input = await readJson(request) as { trackId?: unknown };
        const provider = options.music ? activeMusicProvider(options.music) : null;
        if (input.trackId === null) {
          sDeviceState.trackId = null;
          sDeviceState.seq += 1;
          return jsonResponse({ ok: true });
        }
        const trackId = mediaId(input.trackId, "trackId");
        sDeviceState.provider = provider?.id ?? sDeviceState.provider;
        sDeviceState.trackId = trackId;
        sDeviceState.playing = true;
        sDeviceState.seekMs = -1; // a fresh track starts from 0, no pending seek
        sDeviceState.seq += 1;
        if (provider?.remote) {
          // Errors here are the user's real answer ("no active device", "needs
          // Premium"), so they surface instead of being swallowed.
          await provider.remote.play({ trackId });
        }
        return jsonResponse({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/music/device/current") {
        // Back-compat lightweight poll: just the current track id (or empty).
        // New firmware uses /state instead.
        return new Response(
          sDeviceState.trackId === null ? "" : String(sDeviceState.trackId),
          { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/music/device/state") {
        // Full control state as plain text so the TC002 parses it without a JSON
        // lib — one "KEY\tVALUE" line each. Both device and web UI poll this;
        // the web tags itself with ?viewer=web so a bare poll marks the firmware
        // as alive (it polls from boot, long before the first heartbeat).
        if (url.searchParams.get("viewer") !== "web") sDeviceLive.firmwarePollAt = Date.now();
        // In remote mode the authority on "what is playing" is the Connect
        // player, not the device: fold its reading into the state both readers
        // already poll, so neither needs a second request.
        const remote = options.music ? await pollRemote(options.music) : null;
        // RMT tracks the *source*, not whether this poll reached it: a transient
        // Spotify outage must not tell the device to start playing audio itself.
        const remoteSource = options.music
          ? activeMusicProvider(options.music).remote !== undefined
          : false;
        const s = sDeviceState;
        const hbAge = sDeviceLive.heartbeatAt > 0 ? Date.now() - sDeviceLive.heartbeatAt : -1;
        const fwPollAge = sDeviceLive.firmwarePollAt > 0 ? Date.now() - sDeviceLive.firmwarePollAt : -1;
        const body =
          `SEQ\t${s.seq}\n` +
          `SRC\t${s.provider}\n` +
          `RMT\t${remoteSource ? 1 : 0}\n` +
          `TID\t${s.trackId === null ? "-" : s.trackId}\n` +
          `PLAY\t${s.playing ? 1 : 0}\n` +
          `MODE\t${s.mode}\n` +
          `SKIN\t${s.skin}\n` +
          `ACCENT\t${s.accent ?? "-"}\n` +
          `SEEK\t${s.seekMs}\n` +
          // Remote-player status; only meaningful while RMT is 1.
          `RPOS\t${remote ? Math.round(remote.positionMs) : -1}\n` +
          `RDUR\t${remote ? Math.round(remote.durationMs) : -1}\n` +
          `RPLAY\t${remote?.playing ? 1 : 0}\n` +
          `RVOL\t${remote?.volumePercent ?? -1}\n` +
          // Device-reported live status (web reads these; the device ignores them).
          `HBAGE\t${hbAge}\n` +
          `FWPOLL\t${fwPollAge}\n` +
          `DTRACK\t${sDeviceLive.trackId === null ? "-" : sDeviceLive.trackId}\n` +
          `DPLAY\t${Math.round(sDeviceLive.playheadMs)}\n` +
          `DPLAYING\t${sDeviceLive.playing ? 1 : 0}\n`;
        return new Response(body, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/music/device/control") {
        // The web UI drives the device: play/pause, lyric mode, skin, accent, track.
        assertSameOrigin(request);
        applyControlPatch(await readJson(request));
        return jsonResponse({ ok: true, seq: sDeviceState.seq });
      }

      if (request.method === "POST" && url.pathname === "/api/music/device/report") {
        // The device reports its own key-press changes back (cross-origin: this
        // caller is the TC002, not the browser), so the web UI can reflect them.
        // In remote mode a key press is also a Connect command — the device has
        // no audio of its own to pause.
        const report = await readJson(request);
        const provider = options.music ? activeMusicProvider(options.music) : null;
        if (provider?.remote) {
          await applyRemoteAction(provider, report).catch(() => null);
        }
        applyControlPatch(report);
        return jsonResponse({ ok: true, seq: sDeviceState.seq });
      }

      if (request.method === "POST" && url.pathname === "/api/music/device/heartbeat") {
        // The device checks in every couple seconds with what it is actually
        // playing (cross-origin: the TC002). Powers the web's "is the music
        // firmware live?" detection and its preview-sync clock.
        const input = await readJson(request) as {
          trackId?: unknown; playheadMs?: unknown; playing?: unknown;
        };
        sDeviceLive.heartbeatAt = Date.now();
        // Firmware built before the multi-provider split sends a bare number.
        // A heartbeat is best-effort telemetry: an unparseable ID reads as
        // "nothing playing" rather than failing the device's request.
        sDeviceLive.trackId = optionalMediaId(input.trackId);
        sDeviceLive.playheadMs =
          typeof input.playheadMs === "number" && input.playheadMs >= 0 ? input.playheadMs : 0;
        sDeviceLive.playing = input.playing === true;
        return jsonResponse({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/music/device/now") {
        // Device-facing lyric timeline. Plain text (not JSON) so the TC002 parses
        // it without a JSON lib: one "DUR\t<ms>" header line, then "<startMs>\t<text>"
        // lines in UTF-8. Empty body = nothing selected (device falls back to demo).
        const headers = {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        };
        if (!options.music || sDeviceState.trackId === null) {
          return new Response("", { headers });
        }
        const detail = await activeMusicProvider(options.music).trackDetail(sDeviceState.trackId);
        let body = `DUR\t${Math.round(detail.track.durationMs)}\n`;
        for (const line of detail.lyrics) {
          const text = line.text.replace(/[\t\r\n]+/g, " ").trim();
          if (!text) continue;
          body += `${Math.round(line.startMs)}\t${text}\n`;
        }
        return new Response(body, { headers });
      }

      if (request.method === "GET" && url.pathname === "/api/music/device/audio") {
        // Device downloads this and plays it through MI_AO: the selected track's
        // stream, or the demo tone before anything is selected.
        const audioProvider = options.music ? activeMusicProvider(options.music) : null;
        if (audioProvider && !audioProvider.stream) {
          // Remote mode — the device must not try to play anything locally.
          return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
        }
        if (audioProvider?.stream && sDeviceState.trackId !== null) {
          return await audioProvider.stream(sDeviceState.trackId, request.headers.get("Range"));
        }
        return new Response(
          Bun.file(new URL("./assets/demo-audio.mp3", import.meta.url)),
          { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/library/ulanzi/pixel-assets") {
        if (!options.pixelAssetLibrary) {
          return jsonResponse({ error: "pixel asset library is unavailable" }, 404);
        }
        const classificationId = boundedQueryInteger(url, "classificationId", 0, 0, 99);
        if (!ULANZI_PIXEL_ASSET_CLASSIFICATIONS.includes(
          classificationId as UlanziPixelAssetClassification,
        )) {
          throw new SettingsValidationError("classificationId is invalid");
        }
        const sort = url.searchParams.get("sort") ?? "";
        if (!["", "hot", "star", "new"].includes(sort)) {
          throw new SettingsValidationError("sort is invalid");
        }
        const search = (url.searchParams.get("search") ?? "").trim();
        if (search.length > 80) throw new SettingsValidationError("search is too long");
        const result = await options.pixelAssetLibrary.client.list({
          page: boundedQueryInteger(url, "page", 1, 1, 1_000),
          limit: boundedQueryInteger(url, "limit", 12, 1, 24),
          search,
          classificationId: classificationId as UlanziPixelAssetClassification,
          sort: sort as UlanziPixelAssetSort,
        });
        return jsonResponse({
          ...result,
          items: result.items.map(({ previewPath, ...item }) => ({
            ...item,
            previewUrl: `/api/library/ulanzi/media?path=${encodeURIComponent(previewPath)}`,
          })),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/library/ulanzi/media") {
        if (!options.pixelAssetLibrary) {
          return jsonResponse({ error: "pixel asset library is unavailable" }, 404);
        }
        const path = url.searchParams.get("path") ?? "";
        if (path.length < 1 || path.length > 1_024) {
          throw new SettingsValidationError("preview path is invalid");
        }
        const media = await options.pixelAssetLibrary.client.preview(path);
        return new Response(arrayBufferCopy(media.bytes), {
          headers: {
            "Content-Type": media.contentType,
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const importedPixelAssetMatch = url.pathname.match(
        /^\/api\/library\/ulanzi\/imported\/([a-f0-9]{64})$/,
      );
      if (request.method === "GET" && importedPixelAssetMatch) {
        if (!options.pixelAssetLibrary) {
          return jsonResponse({ error: "pixel asset library is unavailable" }, 404);
        }
        const media = await options.pixelAssetLibrary.store.getMedia(importedPixelAssetMatch[1]!);
        return new Response(arrayBufferCopy(media.bytes), {
          headers: {
            "Content-Type": media.metadata.mimeType,
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/library/ulanzi/import") {
        if (!options.pixelAssetLibrary) {
          return jsonResponse({ error: "pixel asset library is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request) as { source?: unknown };
        const downloaded = await options.pixelAssetLibrary.client.download(input.source);
        const metadata = await options.pixelAssetLibrary.store.save(downloaded);
        return jsonResponse({
          asset: {
            ...metadata,
            previewUrl: `/api/library/ulanzi/imported/${metadata.ref}`,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/library/video/import") {
        if (!options.pixelAssetLibrary) {
          return jsonResponse({ error: "pixel asset library is unavailable" }, 404);
        }
        assertSameOrigin(request);
        // Dedicated 100MB cap for this endpoint; the declared length gets 1MB
        // of slack for multipart framing, the file itself is checked exactly.
        const declaredBytes = Number(request.headers.get("Content-Length") ?? 0);
        if (declaredBytes > VIDEO_IMPORT_MAX_BYTES + 1024 * 1024) {
          return jsonResponse({ error: "视频超出 100MB 上限" }, 413);
        }
        const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
        if (!contentType.startsWith("multipart/form-data")) {
          throw new SettingsValidationError("Content-Type must be multipart/form-data");
        }
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          throw new SettingsValidationError("缺少 file 字段（视频文件）");
        }
        const fit = form.get("fit") ?? "cover";
        if (fit !== "cover" && fit !== "contain") {
          throw new SettingsValidationError("fit 只支持 cover 或 contain");
        }
        if (file.size > VIDEO_IMPORT_MAX_BYTES) {
          return jsonResponse({ error: "视频超出 100MB 上限" }, 413);
        }
        try {
          const importVideo = options.pixelAssetLibrary.importVideo ?? importVideoAsGif;
          const converted = await importVideo({
            bytes: new Uint8Array(await file.arrayBuffer()),
            fileName: file.name || "video",
            fit,
          });
          // Same shape as the Ulanzi import above, so the web library, channel
          // and push flows consume the result without special cases. Local
          // uploads have no official id; the digits-only timestamp satisfies
          // the store's metadata contract and keeps refs unique per upload.
          const title = (file.name || "").replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
          const metadata = await options.pixelAssetLibrary.store.save({
            officialId: String(Date.now()),
            title: title || "导入视频",
            author: "本地视频",
            sourceUrl: `upload://${file.name || "video"}`,
            mimeType: "image/gif",
            bytes: converted.gifBytes,
          });
          return jsonResponse({
            asset: {
              ...metadata,
              previewUrl: `/api/library/ulanzi/imported/${metadata.ref}`,
            },
          });
        } catch (error) {
          if (error instanceof VideoImportError) {
            return jsonResponse({ error: error.message }, error.status);
          }
          throw error;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/workspace") {
        if (!supportsWorkspace(controller)) {
          return jsonResponse({ error: "workspace API is unavailable" }, 404);
        }
        return jsonResponse({ workspace: controller.getWorkspace() });
      }

      if (request.method === "GET" && url.pathname === "/api/device/settings/general") {
        if (!options.deviceGeneralSettings) {
          return jsonResponse({ error: "device general settings are unavailable" }, 404);
        }
        return jsonResponse({ settings: await options.deviceGeneralSettings.read() });
      }

      if (request.method === "PUT" && url.pathname === "/api/device/settings/general") {
        if (!options.deviceGeneralSettings) {
          return jsonResponse({ error: "device general settings are unavailable" }, 404);
        }
        assertSameOrigin(request);
        const settings = validateDeviceGeneralSettings(await readJson(request));
        return jsonResponse({ settings: await options.deviceGeneralSettings.write(settings) });
      }

      if (request.method === "GET" && url.pathname === "/api/device/info") {
        if (!options.deviceInfo) {
          return jsonResponse({ error: "device info is unavailable" }, 404);
        }
        // A ClockRequestError deliberately falls through to the outer handler's 503:
        // "the clock did not answer" is exactly the signal the settings tab keys its
        // address-recovery UI off, so it must not be flattened into an empty 200.
        return jsonResponse({ info: await options.deviceInfo.read() });
      }

      if (request.method === "GET" && url.pathname === "/api/device/host") {
        if (!options.deviceHost) {
          return jsonResponse({ error: "device host control is unavailable" }, 404);
        }
        return jsonResponse({ host: options.deviceHost.read() });
      }

      if (request.method === "PUT" && url.pathname === "/api/device/host") {
        if (!options.deviceHost) {
          return jsonResponse({ error: "device host control is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request) as { host?: unknown };
        const host = validateDeviceHost(input.host);
        const status = await options.deviceHost.write(host);
        // The user is here because the clock was unreachable, so answering "saved"
        // alone is useless — probe the new address and report what happened. A
        // failed probe never rejects the save: the clock may simply be powered off.
        let probe: { ok: boolean; info?: ClockDeviceInfo; error?: string } = { ok: false };
        if (options.deviceInfo) {
          try {
            probe = { ok: true, info: await options.deviceInfo.read() };
          } catch (error) {
            probe = { ok: false, error: error instanceof Error ? error.message : "unknown error" };
          }
        }
        options.onSettingsChanged?.();
        return jsonResponse({ host: status, probe });
      }

      // --- tc002-os link -----------------------------------------------------
      // The firmware calls these two, so like the other device-called routes
      // (/api/arcade/heartbeat, /api/music/device/*) they carry no same-origin
      // check: the device is not a browser and has no Origin to send.
      if (request.method === "GET" && url.pathname === "/api/os/pull") {
        if (!options.osLink) return jsonResponse({ error: "os link is unavailable" }, 404);
        const since = Number(url.searchParams.get("seq") ?? "0");
        // 8 s: comfortably inside any NAT idle timeout on a home router, and
        // short enough that a device which missed a wake-up self-heals quickly.
        const body = await options.osLink.waitForChange(since, 8_000);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/os/frames") {
        if (!options.osLink) return jsonResponse({ error: "os link is unavailable" }, 404);
        if (!supportsWorkspace(controller)) {
          return jsonResponse({ error: "workspace API is unavailable" }, 404);
        }
        const appName = url.searchParams.get("app") ?? "";
        const channel = controller.getWorkspace().channels.find((c) => c.appName === appName);
        if (!channel) return jsonResponse({ error: "channel not found" }, 404);
        const rendered = await controller.previewChannel(channel.id);
        const bundle = encodeFrameBundle(
          rendered.frames.map((frame, index) => ({
            rgb: rgbaToRgb(frame.pixels),
            delayMs: rendered.frameDelaysMs[index] ?? 100,
          })),
          DISPLAY_WIDTH,
          DISPLAY_HEIGHT,
        );
        // The typed array itself is not a BodyInit under this lib target; its
        // backing buffer is, and encodeFrameBundle allocates exactly one.
        return new Response(bundle.buffer as ArrayBuffer, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/os/report") {
        if (!options.osLink) return jsonResponse({ error: "os link is unavailable" }, 404);
        const input = await readJson(request) as Record<string, unknown>;
        const str = (key: string): string =>
          typeof input[key] === "string" ? (input[key] as string).slice(0, 64) : "";
        const num = (key: string): number =>
          typeof input[key] === "number" && Number.isFinite(input[key] as number)
            ? (input[key] as number)
            : 0;
        options.osLink.report({
          screen: str("screen"),
          focus: str("focus"),
          wifi: str("wifi"),
          ip: str("ip"),
          uptimeMs: num("uptimeMs"),
          freeKb: num("freeKb"),
          supplicantRestarts: num("supplicantRestarts"),
          // -1 rather than 0 when the device has no reading yet: a console that
          // showed 0% would be reporting a flat battery on a charged device.
          batteryPercent: typeof input.batteryPercent === "number"
            ? input.batteryPercent
            : -1,
          charging: input.charging === true,
          flashed: input.flashed === true,
        });
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && url.pathname === "/api/os/mirror") {
        if (!options.osLink) return jsonResponse({ error: "os link is unavailable" }, 404);
        // Device-called, so no same-origin check. The body is raw RGB rather
        // than JSON: base64 in a JSON envelope would cost a third more bytes
        // per frame for nothing the firmware can use.
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length !== MIRROR_FRAME_BYTES) {
          return jsonResponse({ error: `frame must be ${MIRROR_FRAME_BYTES} RGB bytes` }, 400);
        }
        options.osLink.putMirrorFrame(Buffer.from(bytes).toString("base64"));
        // The answer tells the device whether to keep streaming, so it stops on
        // its own when the console closes instead of waiting for a poll.
        return jsonResponse({ wanted: options.osLink.mirrorWanted() });
      }

      // --- tc002-os console control -----------------------------------------
      if (request.method === "GET" && url.pathname === "/api/os/mirror") {
        if (!options.osLink) return jsonResponse({ error: "os link is unavailable" }, 404);
        // Asking for the frame IS the subscription: a console that stops polling
        // stops the stream ten seconds later with no explicit teardown to leak.
        options.osLink.requestMirror();
        const frame = options.osLink.getMirrorFrame();
        // ageMs is computed HERE, against the same clock that stamped the frame.
        // Without it the console has to subtract a service timestamp from its own
        // wall clock, so a browser ten seconds out of step decides a live stream
        // is stale — or worse, shows a two-minute-old frame as current. A first
        // poll after a gap really does return a frame that old.
        return jsonResponse({
          frame: frame === null ? null : { ...frame, ageMs: Date.now() - frame.receivedAt },
          // Whether the device has been told to stream. Without this the console
          // cannot tell "the device has not started yet" from "the device is not
          // streaming at all", and its only feedback is frames eventually arriving.
          wanted: options.osLink.mirrorWanted(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/os/state") {
        if (!options.osLink) return jsonResponse({ error: "os link is unavailable" }, 404);
        const telemetry = options.osLink.getTelemetry();
        return jsonResponse({
          seq: options.osLink.currentSeq(),
          menu: options.osLink.getMenu(),
          display: options.osLink.getDisplay(),
          // Same reason as the mirror's ageMs: the console must not have to
          // compare a service timestamp against its own clock to decide how old
          // this is.
          telemetry: telemetry === null
            ? null
            : { ...telemetry, ageMs: Date.now() - telemetry.receivedAt },
          live: options.osLink.isDeviceLive(),
          mirrorWanted: options.osLink.mirrorWanted(),
          // Sticky and independent of `live`: what a power cycle restores does
          // not stop being true because the device stopped reporting.
          zosFlashed: options.osLink.zosFlashed(),
          requestedSettings: options.osLink.getDeviceSettings(),
          pendingInputs: options.osLink.pendingInputs(),
        });
      }

      if (request.method === "PUT" && url.pathname === "/api/os/display") {
        if (!options.osLink) return jsonResponse({ error: "os link is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request) as { focus?: unknown; pinned?: unknown };
        if (input.focus !== null && input.focus !== undefined && typeof input.focus !== "string") {
          throw new SettingsValidationError("focus must be a string or null");
        }
        if (input.pinned !== undefined && typeof input.pinned !== "boolean") {
          throw new SettingsValidationError("pinned must be a boolean");
        }
        // A focus with no pinned flag used to coerce to pinned:false — the
        // request succeeded, the response looked plausible, and nothing happened
        // on the device. Naming a channel is only meaningful together with a
        // decision about who is driving, so ask for both rather than guessing.
        if (typeof input.focus === "string" && input.pinned === undefined) {
          throw new SettingsValidationError(
            "pinned is required when focus names a channel",
          );
        }
        options.osLink.setDisplay({
          focus: typeof input.focus === "string" ? input.focus : null,
          pinned: input.pinned === true,
        });
        return jsonResponse({ display: options.osLink.getDisplay(), seq: options.osLink.currentSeq() });
      }

      if (request.method === "POST" && url.pathname === "/api/os/input") {
        if (!options.osLink) return jsonResponse({ error: "os link is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request) as { action?: unknown };
        if (typeof input.action !== "string"
          || !OS_INPUT_ACTIONS.includes(input.action as OsInputAction)) {
          throw new SettingsValidationError(
            `action must be one of ${OS_INPUT_ACTIONS.join(", ")}`,
          );
        }
        const event = options.osLink.pressInput(input.action as OsInputAction);
        // The sequence is the receipt: the console can tell a press that reached
        // the hub from one that did not, without waiting for the panel to move.
        return jsonResponse({ event });
      }

      if (request.method === "PUT" && url.pathname === "/api/os/settings") {
        if (!options.osLink) return jsonResponse({ error: "os link is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request) as { volume?: unknown; brightness?: unknown };
        const number = (value: unknown, name: string, low: number, high: number) => {
          if (value === undefined) return undefined;
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new SettingsValidationError(`${name} must be a number`);
          }
          if (value < low || value > high) {
            throw new SettingsValidationError(`${name} must be between ${low} and ${high}`);
          }
          return value;
        };
        const volume = number(input.volume, "volume", 0, 6);
        const brightness = number(input.brightness, "brightness", 1, 10);
        if (volume === undefined && brightness === undefined) {
          throw new SettingsValidationError("volume or brightness is required");
        }
        options.osLink.setDeviceSettings({
          ...(volume === undefined ? {} : { volume }),
          ...(brightness === undefined ? {} : { brightness }),
        });
        // The device is the authority on what it ended up at; this only echoes
        // what was asked for, and telemetry reports what actually happened.
        return jsonResponse({ requested: options.osLink.getDeviceSettings() });
      }

      if (request.method === "DELETE" && url.pathname === "/api/device/host") {
        if (!options.deviceHost) {
          return jsonResponse({ error: "device host control is unavailable" }, 404);
        }
        assertSameOrigin(request);
        options.onSettingsChanged?.();
        return jsonResponse({ host: await options.deviceHost.reset() });
      }

      if (request.method === "PUT" && url.pathname === "/api/workspace") {
        if (!supportsWorkspace(controller)) {
          return jsonResponse({ error: "workspace API is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const workspace = await controller.saveWorkspace(await readJson(request));
        options.onSettingsChanged?.();
        return jsonResponse({ workspace, state: controller.getState() });
      }

      if (request.method === "GET" && url.pathname === "/api/settings") {
        return jsonResponse({ settings: controller.getSettings() });
      }

      if (request.method === "PUT" && url.pathname === "/api/settings") {
        assertSameOrigin(request);
        const settings = await controller.saveSettings(await readJson(request));
        options.onSettingsChanged?.();
        return jsonResponse({ settings });
      }

      if (request.method === "GET" && ["/api/state", "/health"].includes(url.pathname)) {
        return jsonResponse(controller.getState());
      }

      if (request.method === "POST" && url.pathname === "/api/preview") {
        assertSameOrigin(request);
        const contentLength = Number(request.headers.get("Content-Length") ?? 0);
        const settings = contentLength > 0 ? await readJson(request) : undefined;
        const preview = await controller.preview(settings);
        return previewResponse(preview);
      }

      if (request.method === "POST" && url.pathname === "/api/channels/preview") {
        if (!supportsWorkspace(controller)) {
          return jsonResponse({ error: "workspace API is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request) as {
          channelId?: unknown;
          channel?: unknown;
          forceRefresh?: unknown;
        };
        const target = typeof input.channelId === "string"
          ? input.channelId
          : input.channel as ChannelConfig;
        if (!target) throw new SettingsValidationError("channelId or channel is required");
        return previewResponse(await controller.previewChannel(target, input.forceRefresh === true));
      }

      if (request.method === "POST" && url.pathname === "/api/channels/push") {
        if (!supportsWorkspace(controller)) {
          return jsonResponse({ error: "workspace API is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request) as { channelId?: unknown };
        if (typeof input.channelId !== "string") {
          throw new SettingsValidationError("channelId is required");
        }
        return jsonResponse({ state: await controller.pushChannel(input.channelId) });
      }

      if (request.method === "POST" && url.pathname === "/api/push") {
        assertSameOrigin(request);
        const state = supportsWorkspace(controller)
          ? await controller.pushAll("manual")
          : await controller.pushNow("manual");
        return jsonResponse({ state });
      }

      return jsonResponse({ error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown control error";
      const status = error instanceof MusicServiceError || error instanceof MusicInstallerError
        ? error.status
        : error instanceof SettingsValidationError || error instanceof DeviceSettingsValidationError
          ? 400
          : 503;
      return jsonResponse({ error: message }, status);
    }
  };
}
