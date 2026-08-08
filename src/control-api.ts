import { createHash } from "node:crypto";
import { ASSET_PRESETS, isAssetId, type AssetId } from "./assets.ts";
import { getContentCatalog } from "./content-registry.ts";
import type { DashboardController } from "./controller.ts";
import {
  DeviceSettingsValidationError,
  validateDeviceGeneralSettings,
  type DeviceGeneralSettings,
} from "./device-settings.ts";
import { renderAssetIconTile } from "./pixel-ui.ts";
import type { ControlAccessInfo } from "./network-access.ts";
import { MusicServiceError, type NeteaseMusicService } from "./netease-music.ts";
import { PWA_ICONS, PWA_MANIFEST, pwaServiceWorker } from "./pwa.ts";
import { SettingsValidationError } from "./settings.ts";
import { getStockIconPng, isStockIconId } from "./stock-icons.ts";
import { controlPageHtml } from "./web-ui.ts";
import { WORKSPACE_LIMITS, type ChannelConfig } from "./workspace.ts";
import type { WorkspaceController } from "./workspace-controller.ts";
import type { PixelAssetStore } from "./pixel-asset-store.ts";
import {
  MusicInstallerError,
  type Tc002MusicInstaller,
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
  ["/assets/fusion-pixel-12px-monospaced-sc.woff2", {
    url: new URL(
      "../dist/assets/fusion-pixel-12px-monospaced-sc.woff2",
      import.meta.url,
    ),
    type: "font/woff2",
  }],
]);

export interface ControlApiOptions {
  onSettingsChanged?: () => void;
  controlAccess?: () => ControlAccessInfo | Promise<ControlAccessInfo>;
  deviceGeneralSettings?: {
    read: () => Promise<DeviceGeneralSettings>;
    write: (settings: DeviceGeneralSettings) => Promise<DeviceGeneralSettings>;
  };
  pixelAssetLibrary?: {
    client: UlanziPixelAssetClient;
    store: PixelAssetStore;
  };
  music?: NeteaseMusicService;
  musicInstaller?: Tc002MusicInstaller;
  musicMirror?: {
    push: (payload: ClockPayload) => Promise<{ status: number }>;
    clear: () => Promise<{ status: number }>;
  };
}

// The device's live music control state. The web UI mutates it via /control (and
// /select); the device polls /state and applies changes; the device reports its
// own key-press changes back via /report. Single-device service, so module state
// is fine. `seq` bumps on every change so both sides can detect "something moved".
type LyricMode = "ticker" | "skyline" | "spotlight" | "cascade";
type LyricSkin = "signal" | "tape" | "blueprint" | "arcade";
interface DeviceMusicState {
  trackId: number | null;
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
  trackId: null,
  playing: true,
  mode: "spotlight",
  skin: "signal",
  accent: null,
  seekMs: -1,
  seq: 0,
};

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
    if (patch.trackId === null) {
      sDeviceState.trackId = null;
    } else if (typeof patch.trackId === "number" && Number.isSafeInteger(patch.trackId) && patch.trackId > 0) {
      sDeviceState.trackId = patch.trackId;
    } else {
      throw new SettingsValidationError("trackId is invalid");
    }
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
  trackId: number | null;
  playheadMs: number;
  playing: boolean;
}
const sDeviceLive: DeviceLiveStatus = {
  heartbeatAt: 0,
  trackId: null,
  playheadMs: 0,
  playing: false,
};

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

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > WORKSPACE_LIMITS.maxRequestBytes) {
    throw new SettingsValidationError("request body is too large");
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new SettingsValidationError("Content-Type must be application/json");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > WORKSPACE_LIMITS.maxRequestBytes) {
    throw new SettingsValidationError("request body is too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SettingsValidationError("request body must contain valid JSON");
  }
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

const MIRROR_FRAME_BYTES = DISPLAY_WIDTH * DISPLAY_HEIGHT * 3;

function decodeMirrorFrames(
  value: unknown,
): { canvas: PixelCanvas; delayMs: number }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 60) {
    throw new SettingsValidationError("mirror frames must contain 1 to 60 entries");
  }
  return value.map((entry) => {
    const record = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    const delayMs = boundedInteger(record.delayMs, 40, 10_000, "frame delayMs");
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

      if (request.method === "GET" && url.pathname === "/api/access") {
        if (!options.controlAccess) {
          return jsonResponse({ error: "control access information is unavailable" }, 404);
        }
        return jsonResponse({ access: await options.controlAccess() });
      }

      if (request.method === "GET" && url.pathname === "/api/music/session") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({ session: options.music.status() });
      }

      if (request.method === "GET" && url.pathname === "/api/music/avatar") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return await options.music.avatar();
      }

      if (request.method === "POST" && url.pathname === "/api/music/qr") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        return jsonResponse({ login: await options.music.createQrLogin() }, 201);
      }

      if (request.method === "POST" && url.pathname === "/api/music/qr/check") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        const input = await readJson(request) as { id?: unknown };
        if (typeof input.id !== "string") throw new SettingsValidationError("QR session ID is required");
        return jsonResponse({ login: await options.music.checkQrLogin(input.id) });
      }

      if (request.method === "POST" && url.pathname === "/api/music/logout") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        assertSameOrigin(request);
        await options.music.logout();
        return jsonResponse({ session: options.music.status() });
      }

      if (request.method === "GET" && url.pathname === "/api/music/search") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({ tracks: await options.music.search(url.searchParams.get("query") ?? "") });
      }

      if (request.method === "GET" && url.pathname === "/api/music/playlists") {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({ playlists: await options.music.playlists() });
      }

      const playlistTracksMatch = url.pathname.match(/^\/api\/music\/playlists\/(\d+)\/tracks$/);
      if (request.method === "GET" && playlistTracksMatch) {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({
          tracks: await options.music.playlistTracks(positivePathId(playlistTracksMatch[1], "playlist")),
        });
      }

      const musicTrackMatch = url.pathname.match(/^\/api\/music\/tracks\/(\d+)$/);
      if (request.method === "GET" && musicTrackMatch) {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return jsonResponse({
          detail: await options.music.trackDetail(positivePathId(musicTrackMatch[1], "track")),
        });
      }

      const musicStreamMatch = url.pathname.match(/^\/api\/music\/tracks\/(\d+)\/stream$/);
      if (request.method === "GET" && musicStreamMatch) {
        if (!options.music) return jsonResponse({ error: "music service is unavailable" }, 404);
        return options.music.stream(
          positivePathId(musicStreamMatch[1], "track"),
          request.headers.get("Range"),
        );
      }

      if (request.method === "GET" && url.pathname === "/api/music/device-app") {
        if (!options.musicInstaller) {
          return jsonResponse({ error: "music device installer is unavailable" }, 404);
        }
        return jsonResponse({ deviceApp: await options.musicInstaller.status() });
      }

      if (request.method === "POST" && url.pathname === "/api/music/device-app/probe") {
        if (!options.musicInstaller) {
          return jsonResponse({ error: "music device installer is unavailable" }, 404);
        }
        assertSameOrigin(request);
        return jsonResponse({ device: await options.musicInstaller.probe() });
      }

      if (request.method === "POST" && url.pathname === "/api/music/device-app/session/start") {
        if (!options.musicInstaller) {
          return jsonResponse({ error: "music device installer is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request) as {
          confirmation?: unknown;
          expectedBundleId?: unknown;
        };
        if (typeof input.confirmation !== "string" || typeof input.expectedBundleId !== "string") {
          throw new SettingsValidationError("session confirmation and bundleId are required");
        }
        return jsonResponse({
          result: await options.musicInstaller.startSession({
            confirmation: input.confirmation,
            expectedBundleId: input.expectedBundleId,
          }),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/music/device-app/session/stop") {
        if (!options.musicInstaller) {
          return jsonResponse({ error: "music device installer is unavailable" }, 404);
        }
        assertSameOrigin(request);
        return jsonResponse({ result: await options.musicInstaller.stopSession() });
      }

      if (request.method === "POST" && url.pathname === "/api/music/mirror") {
        if (!options.musicMirror) {
          return jsonResponse({ error: "music mirror is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request) as { frames?: unknown; holdSeconds?: unknown };
        const frames = decodeMirrorFrames(input.frames);
        const totalMs = frames.reduce((sum, frame) => sum + frame.delayMs, 0);
        const holdSeconds = input.holdSeconds === undefined
          ? Math.min(86_400, Math.ceil(totalMs / 1_000) + 30)
          : boundedInteger(input.holdSeconds, 5, 86_400, "holdSeconds");
        const image = frames.length === 1
          ? { bytes: frames[0]!.canvas.toPng(), mimeType: "image/png" as const }
          : {
            bytes: encodePixelAnimation(
              frames.map((frame) => frame.canvas),
              frames.map((frame) => frame.delayMs),
            ),
            mimeType: "image/gif" as const,
          };
        const pushed = await options.musicMirror.push(
          buildImagePayload(image.bytes, image.mimeType, holdSeconds),
        );
        return jsonResponse({ mirror: { status: pushed.status, frames: frames.length } });
      }

      if (request.method === "DELETE" && url.pathname === "/api/music/mirror") {
        if (!options.musicMirror) {
          return jsonResponse({ error: "music mirror is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const cleared = await options.musicMirror.clear();
        return jsonResponse({ mirror: { status: cleared.status, frames: 0 } });
      }

      if (request.method === "POST" && url.pathname === "/api/music/device/select") {
        // The web UI reports the track it just selected (same-origin). Selecting
        // a track also (re)starts playback.
        assertSameOrigin(request);
        const input = await readJson(request) as { trackId?: unknown };
        if (input.trackId === null) {
          sDeviceState.trackId = null;
          sDeviceState.seq += 1;
          return jsonResponse({ ok: true });
        }
        if (typeof input.trackId !== "number" || !Number.isSafeInteger(input.trackId) || input.trackId <= 0) {
          throw new SettingsValidationError("trackId is invalid");
        }
        sDeviceState.trackId = input.trackId;
        sDeviceState.playing = true;
        sDeviceState.seekMs = -1; // a fresh track starts from 0, no pending seek
        sDeviceState.seq += 1;
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
        // lib — one "KEY\tVALUE" line each. Both device and web UI poll this.
        const s = sDeviceState;
        const hbAge = sDeviceLive.heartbeatAt > 0 ? Date.now() - sDeviceLive.heartbeatAt : -1;
        const body =
          `SEQ\t${s.seq}\n` +
          `TID\t${s.trackId === null ? "-" : s.trackId}\n` +
          `PLAY\t${s.playing ? 1 : 0}\n` +
          `MODE\t${s.mode}\n` +
          `SKIN\t${s.skin}\n` +
          `ACCENT\t${s.accent ?? "-"}\n` +
          `SEEK\t${s.seekMs}\n` +
          // Device-reported live status (web reads these; the device ignores them).
          `HBAGE\t${hbAge}\n` +
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
        applyControlPatch(await readJson(request));
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
        sDeviceLive.trackId =
          typeof input.trackId === "number" && input.trackId > 0 ? input.trackId : null;
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
        const detail = await options.music.trackDetail(sDeviceState.trackId);
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
        if (options.music && sDeviceState.trackId !== null) {
          return options.music.stream(sDeviceState.trackId, request.headers.get("Range"));
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
