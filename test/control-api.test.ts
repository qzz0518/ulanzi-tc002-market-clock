import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlHandler, resetDeviceMusicSelection } from "../src/control-api.ts";
import {
  DEFAULT_DEVICE_GENERAL_SETTINGS,
  type DeviceGeneralSettings,
} from "../src/device-settings.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { DashboardController } from "../src/controller.ts";
import { renderOfflineDashboard } from "../src/pixel-ui.ts";
import { MusicServiceError } from "../src/netease-music.ts";
import type { MusicHub } from "../src/music/hub.ts";
import { createDefaultWorkspace } from "../src/workspace.ts";
import type { WorkspaceController } from "../src/workspace-controller.ts";
import { PixelAssetStore } from "../src/pixel-asset-store.ts";
import { PixelCanvas } from "../src/pixel-ui.ts";
import type { UlanziPixelAssetClient } from "../src/ulanzi-pixel-assets.ts";
import type { Tc002MusicInstaller } from "../src/tc002-music-installer.ts";
import { InstrumentStore } from "../src/market/instruments.ts";
import { MarketIconStore } from "../src/market/icon-store.ts";
import { MarketSearchService } from "../src/market/search.ts";
import { MarketCatalogService } from "../src/market/catalog-service.ts";
import { BundledCryptoLogoCatalog } from "../src/market/logo-catalog.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

// A hub whose active provider is whatever the test hands it; the Spotify half
// only has to exist for the routes that read the overview.
function fakeMusicHub(
  active: Record<string, unknown>,
  spotify: Record<string, unknown> = {},
): MusicHub {
  const provider = {
    id: "netease",
    label: "网易云音乐",
    playbackMode: "device-audio",
    status: () => ({ loggedIn: false }),
    ...active,
  };
  const spotifyProvider = {
    id: "spotify",
    label: "Spotify",
    playbackMode: "remote",
    status: () => ({ loggedIn: false }),
    appStatus: () => ({ configured: false, clientId: null, redirectUri: "http://127.0.0.1:43820/api/music/spotify/callback" }),
    ...spotify,
  };
  return {
    netease: provider,
    spotify: spotifyProvider,
    activeId: () => provider.id,
    activeProvider: () => provider,
    provider: (id: string) => (id === "spotify" ? spotifyProvider : provider),
    setActive: async () => ({ active: provider.id, providers: [] }),
    overview: () => ({ active: provider.id, providers: [] }),
  } as unknown as MusicHub;
}

function fakeController(): DashboardController {
  let settings = structuredClone(DEFAULT_SETTINGS);
  return {
    getSettings: () => structuredClone(settings),
    saveSettings: async (value: unknown) => {
      settings = value as typeof settings;
      return structuredClone(settings);
    },
    getState: () => ({
      service: "ulanzi-tc002-market-clock",
      healthy: true,
      settings,
    }),
    preview: async () => renderOfflineDashboard(),
    pushNow: async () => ({ healthy: true }),
  } as unknown as DashboardController;
}

function fakeWorkspaceController(previewCalls?: boolean[]): WorkspaceController {
  let workspace = createDefaultWorkspace("markets");
  return {
    getWorkspace: () => structuredClone(workspace),
    saveWorkspace: async (value: unknown) => {
      workspace = value as typeof workspace;
      return structuredClone(workspace);
    },
    getSettings: () => structuredClone(DEFAULT_SETTINGS),
    saveSettings: async () => structuredClone(DEFAULT_SETTINGS),
    getState: () => ({
      service: "ulanzi-tc002-content-hub",
      healthy: true,
      workspace,
      channels: [],
    }),
    preview: async () => renderOfflineDashboard(),
    previewChannel: async (_target: unknown, forceRefresh = false) => {
      previewCalls?.push(forceRefresh);
      return renderOfflineDashboard() as never;
    },
    pushAll: async () => ({ healthy: true }),
    pushChannel: async () => ({ healthy: true }),
  } as unknown as WorkspaceController;
}

describe("local control API", () => {
  test("serves the GUI, official clock frame, ten presets, and pixel icons", async () => {
    const handler = createControlHandler(fakeController());
    const page = await handler(new Request("http://127.0.0.1:43820/"));
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Pixel Market");
    expect(pageHtml).toContain('id="root"');
    expect(pageHtml).toContain('href="/assets/studio.css"');
    expect(pageHtml).toContain('src="/assets/studio.js"');
    expect(pageHtml).toContain('href="/manifest.webmanifest"');
    expect(pageHtml).toContain('href="/icons/apple-touch-icon.png"');
    expect(pageHtml).not.toContain("status-progress");
    expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(page.headers.get("Content-Security-Policy")).not.toContain("script-src 'unsafe-inline'");
    expect(page.headers.get("Content-Security-Policy")).toContain("img-src 'self' blob:");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");

    const frame = await handler(new Request("http://127.0.0.1:43820/assets/tc002-frame.png"));
    expect(frame.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await frame.arrayBuffer()).subarray(0, 4)).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );

    const presets = await handler(new Request("http://127.0.0.1:43820/api/presets"));
    const presetBody = await presets.json() as {
      presets: Array<{ id: string; iconUrl: string }>;
    };
    expect(presetBody.presets).toHaveLength(10);
    const ethPreset = presetBody.presets.find((preset) => preset.id === "eth");
    expect(ethPreset?.iconUrl).toMatch(/^\/api\/icons\/eth\.png\?v=[a-f0-9]{12}$/);

    const icon = await handler(new Request(new URL(ethPreset!.iconUrl, "http://127.0.0.1:43820")));
    expect(icon.headers.get("Content-Type")).toBe("image/png");
    expect(icon.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await icon.arrayBuffer()).subarray(0, 4)).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );

    const manifest = await handler(new Request("http://127.0.0.1:43820/manifest.webmanifest"));
    expect(manifest.headers.get("Content-Type")).toContain("application/manifest+json");
    expect((await manifest.json()).display).toBe("standalone");
    const serviceWorker = await handler(new Request("http://127.0.0.1:43820/sw.js"));
    expect(serviceWorker.headers.get("Service-Worker-Allowed")).toBe("/");
    expect(await serviceWorker.text()).toContain("/api/");
    const pwaIcon = await handler(new Request("http://127.0.0.1:43820/icons/pwa-192.png"));
    expect(new Uint8Array(await pwaIcon.arrayBuffer()).subarray(0, 4)).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });

  test("reports the phone control URL supplied by the service", async () => {
    const access = {
      port: 43_820,
      address: "192.0.2.12",
      url: "http://192.0.2.12:43820/",
      suggestedUrl: "http://192.0.2.12:43820/",
      lanEnabled: true,
      sameSubnetAsClock: true,
    };
    const handler = createControlHandler(fakeController(), { controlAccess: () => access });
    const response = await handler(new Request("http://127.0.0.1:43820/api/access"));
    expect(response.status).toBe(200);
    expect((await response.json()).access).toEqual(access);
  });

  test("persists same-origin JSON settings and rejects cross-origin writes", async () => {
    const handler = createControlHandler(fakeController());
    const body = JSON.stringify({ ...DEFAULT_SETTINGS, assets: ["eth", "sol"] });
    const saved = await handler(
      new Request("http://127.0.0.1:43820/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
        body,
      }),
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings.assets).toEqual(["eth", "sol"]);

    const rejected = await handler(
      new Request("http://127.0.0.1:43820/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: "https://example.com" },
        body,
      }),
    );
    expect(rejected.status).toBe(400);
  });

  test("reads and writes every device general setting through a same-origin adapter", async () => {
    let settings: DeviceGeneralSettings = structuredClone(DEFAULT_DEVICE_GENERAL_SETTINGS);
    const handler = createControlHandler(fakeWorkspaceController(), {
      deviceGeneralSettings: {
        read: async () => structuredClone(settings),
        write: async (next) => {
          settings = structuredClone(next);
          return structuredClone(settings);
        },
      },
    });
    const current = await handler(new Request(
      "http://127.0.0.1:43820/api/device/settings/general",
    ));
    expect(current.status).toBe(200);
    expect((await current.json()).settings).toEqual(DEFAULT_DEVICE_GENERAL_SETTINGS);

    const next: DeviceGeneralSettings = {
      ...DEFAULT_DEVICE_GENERAL_SETTINGS,
      brightness: { level: "high", low: 40, mid: 70, high: 95 },
      volume: 5,
      carouselSpeed: 30,
      scrollSpeed: 2,
      timezone: "UTC-5",
      dateFormat: "DD/MM",
      showWeek: false,
      weekStart: 0,
      lowBatteryAutoSleep: true,
    };
    const saved = await handler(new Request(
      "http://127.0.0.1:43820/api/device/settings/general",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:43820",
        },
        body: JSON.stringify(next),
      },
    ));
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toEqual(next);

    const invalid = await handler(new Request(
      "http://127.0.0.1:43820/api/device/settings/general",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:43820",
        },
        body: JSON.stringify({
          ...next,
          brightness: { level: "high", low: 90, mid: 70, high: 95 },
        }),
      },
    ));
    expect(invalid.status).toBe(400);

    const crossOrigin = await handler(new Request(
      "http://127.0.0.1:43820/api/device/settings/general",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: "https://example.com" },
        body: JSON.stringify(next),
      },
    ));
    expect(crossOrigin.status).toBe(400);
  });

  test("keeps music login writes same-origin and exposes only sanitized session state", async () => {
    let avatarRequests = 0;
    const netease = {
      id: "netease",
      label: "网易云音乐",
      playbackMode: "device-audio",
      status: () => ({
        loggedIn: true,
        profile: {
          provider: "netease",
          id: "42",
          nickname: "像素听众",
          avatarUrl: "https://p1.music.126.net/avatar.jpg",
        },
      }),
      avatar: async () => {
        avatarRequests += 1;
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          headers: { "Content-Type": "image/jpeg" },
        });
      },
      createQrLogin: async () => ({
        id: "00000000-0000-4000-8000-000000000000",
        qrUrl: "https://music.163.com/login?codekey=test",
        expiresAt: "2026-08-07T00:03:00.000Z",
      }),
      search: async () => [{
        id: "123",
        title: "夜航",
        artists: ["像素乐队"],
        album: "十六行",
        durationMs: 180_000,
      }],
    };
    const music = fakeMusicHub(netease);
    const handler = createControlHandler(fakeWorkspaceController(), { music });

    const session = await handler(new Request("http://127.0.0.1:43820/api/music/session"));
    expect(await session.json()).toEqual({
      session: {
        loggedIn: true,
        profile: {
          provider: "netease",
          id: "42",
          nickname: "像素听众",
          avatarUrl: "https://p1.music.126.net/avatar.jpg",
        },
      },
    });

    const avatar = await handler(new Request("http://127.0.0.1:43820/api/music/avatar"));
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await avatar.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    );
    expect(avatarRequests).toBe(1);

    const failedAvatarHandler = createControlHandler(fakeWorkspaceController(), {
      music: fakeMusicHub({
        avatar: async () => {
          throw new MusicServiceError("头像格式无效", 502);
        },
      }),
    });
    const failedAvatar = await failedAvatarHandler(
      new Request("http://127.0.0.1:43820/api/music/avatar"),
    );
    expect(failedAvatar.status).toBe(502);
    expect(await failedAvatar.json()).toEqual({ error: "头像格式无效" });

    const rejected = await handler(new Request("http://127.0.0.1:43820/api/music/qr", {
      method: "POST",
      headers: { Origin: "https://example.com" },
    }));
    expect(rejected.status).toBe(400);

    const created = await handler(new Request("http://127.0.0.1:43820/api/music/qr", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:43820" },
    }));
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain("cookie");

    const search = await handler(new Request(
      "http://127.0.0.1:43820/api/music/search?query=%E5%A4%9C%E8%88%AA",
    ));
    expect((await search.json()).tracks[0].title).toBe("夜航");
  });

  test("switches the live music source and keeps the switch same-origin", async () => {
    let active = "netease";
    const music = fakeMusicHub({});
    (music as unknown as Record<string, unknown>).setActive = async (id: string) => {
      active = id;
      return { active, providers: [] };
    };
    (music as unknown as Record<string, unknown>).overview = () => ({ active, providers: [] });
    const handler = createControlHandler(fakeWorkspaceController(), { music });

    const listed = await handler(new Request("http://127.0.0.1:43820/api/music/providers"));
    expect(listed.status).toBe(200);
    expect((await listed.json()).music.active).toBe("netease");

    const crossOrigin = await handler(new Request("http://127.0.0.1:43820/api/music/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({ provider: "spotify" }),
    }));
    expect(crossOrigin.status).toBe(400);
    expect(active).toBe("netease");

    const unknown = await handler(new Request("http://127.0.0.1:43820/api/music/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify({ provider: "tidal" }),
    }));
    expect(unknown.status).toBe(400);

    const switched = await handler(new Request("http://127.0.0.1:43820/api/music/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify({ provider: "spotify" }),
    }));
    expect(switched.status).toBe(200);
    expect(active).toBe("spotify");
  });

  test("publishes the Connect player's position to the device and relays transport commands", async () => {
    const commands: string[] = [];
    let snapshot = {
      trackId: "4uLU6hMCjMI75M1A2tKUQC",
      positionMs: 42_000,
      durationMs: 213_000,
      playing: true,
      deviceName: "厨房音箱",
      volumePercent: 40,
      fetchedAt: 0,
    };
    const remoteProvider = {
      id: "spotify",
      label: "Spotify",
      playbackMode: "remote",
      status: () => ({ loggedIn: true, profile: { provider: "spotify", id: "u", nickname: "听众" } }),
      trackDetail: async (id: string) => ({
        track: { id, title: "夜航", artists: ["像素乐队"], album: "十六行", durationMs: 213_000 },
        lyrics: [{ startMs: 1_000, endMs: 4_000, text: "第一行" }],
      }),
      remote: {
        snapshot: async () => snapshot,
        play: async () => { commands.push("play"); },
        pause: async () => { commands.push("pause"); },
        next: async () => { commands.push("next"); },
        previous: async () => { commands.push("previous"); },
        seek: async (ms: number) => { commands.push(`seek:${ms}`); },
        setVolume: async (pct: number) => { commands.push(`volume:${pct}`); },
        devices: async () => [],
        transfer: async (id: string) => { commands.push(`transfer:${id}`); },
      },
    };
    resetDeviceMusicSelection("spotify");
    const handler = createControlHandler(fakeWorkspaceController(), {
      music: fakeMusicHub(remoteProvider),
    });

    const state = await handler(new Request("http://127.0.0.1:43820/api/music/device/state"));
    const fields = Object.fromEntries(
      (await state.text()).split("\n").filter(Boolean).map((line) => line.split("\t") as [string, string]),
    );
    expect(fields.SRC).toBe("spotify");
    expect(fields.RMT).toBe("1");
    // The device follows whatever the Connect player moved to on its own.
    expect(fields.TID).toBe("4uLU6hMCjMI75M1A2tKUQC");
    expect(fields.RPOS).toBe("42000");
    expect(fields.RDUR).toBe("213000");
    expect(fields.RPLAY).toBe("1");
    expect(fields.RVOL).toBe("40");

    // Remote mode has no local audio for the device to fetch.
    const audio = await handler(new Request("http://127.0.0.1:43820/api/music/device/audio"));
    expect(audio.status).toBe(204);

    // ...but the lyric timeline still comes from the service.
    const now = await handler(new Request("http://127.0.0.1:43820/api/music/device/now"));
    expect(await now.text()).toBe("DUR\t213000\n1000\t第一行\n");

    const stream = await handler(new Request(
      "http://127.0.0.1:43820/api/music/tracks/4uLU6hMCjMI75M1A2tKUQC/stream",
    ));
    expect(stream.status).toBe(409);

    const rejected = await handler(new Request("http://127.0.0.1:43820/api/music/remote", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({ action: "next" }),
    }));
    expect(rejected.status).toBe(400);
    expect(commands).toEqual([]);

    for (const patch of [
      { action: "next" },
      { action: "seek", positionMs: 12_345 },
      { action: "volume", percent: 55 },
      { action: "transfer", deviceId: "device1" },
    ]) {
      const response = await handler(new Request("http://127.0.0.1:43820/api/music/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
        body: JSON.stringify(patch),
      }));
      expect(response.status).toBe(200);
    }
    expect(commands).toEqual(["next", "seek:12345", "volume:55", "transfer:device1"]);

    // A device key press is a Connect command too — the TC002 has no audio here.
    await handler(new Request("http://127.0.0.1:43820/api/music/device/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playing: false }),
    }));
    expect(commands.at(-1)).toBe("pause");

    // A base62 track ID survives the shared route that used to be digits-only.
    const detail = await handler(new Request(
      "http://127.0.0.1:43820/api/music/tracks/4uLU6hMCjMI75M1A2tKUQC",
    ));
    expect((await detail.json()).detail.track.title).toBe("夜航");

    snapshot = { ...snapshot, trackId: "1301WleyT98MSxVHPZCA6M", playing: false };
    const moved = await handler(new Request("http://127.0.0.1:43820/api/music/device/state"));
    expect(await moved.text()).toContain("TID\t1301WleyT98MSxVHPZCA6M");

    // A Spotify outage must not tell the device to fall back to local audio.
    remoteProvider.remote.snapshot = async () => {
      throw new MusicServiceError("Spotify 无法连接", 502);
    };
    const degraded = await handler(new Request("http://127.0.0.1:43820/api/music/device/state"));
    const degradedText = await degraded.text();
    expect(degradedText).toContain("RMT\t1");
    expect(degradedText).toContain("RPOS\t-1");
    expect(degradedText).toContain("TID\t1301WleyT98MSxVHPZCA6M");
    resetDeviceMusicSelection("netease");
  });

  test("renders a self-contained Spotify callback page and escapes its message", async () => {
    const handler = createControlHandler(fakeWorkspaceController(), {
      music: fakeMusicHub({}),
    });
    const denied = await handler(new Request(
      "http://127.0.0.1:43820/api/music/spotify/callback?error=%3Cimg+src%3Dx%3E",
    ));
    expect(denied.status).toBe(400);
    expect(denied.headers.get("Content-Type")).toContain("text/html");
    const html = await denied.text();
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
  });

  test("does not allow cross-origin sideload session requests", async () => {
    let started = false;
    const installer = {
      status: async () => ({
        artifact: { state: "missing", appId: "tc002-lyrics-player", message: "missing" },
        adb: "missing",
        busy: false,
        session: { active: false },
        restore: { title: "恢复", steps: [] },
      }),
      startSession: async () => {
        started = true;
        return { state: "running" };
      },
    } as unknown as Tc002MusicInstaller;
    const handler = createControlHandler(fakeWorkspaceController(), { musicInstaller: installer });
    const response = await handler(new Request(
      "http://127.0.0.1:43820/api/music/device-app/session/start",
      {
        method: "POST",
        headers: {
          Origin: "https://example.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation: "x", expectedBundleId: "a".repeat(64) }),
      },
    ));
    expect(response.status).toBe(400);
    expect(started).toBe(false);
  });

  test("serves the same device-app lifecycle under the arcade prefix", async () => {
    let probed = 0;
    const installer = {
      status: async () => ({
        artifact: { state: "ready", appId: "tc002-arcade", bundleId: "b".repeat(64), message: "ok" },
        adb: "ready",
        busy: false,
        session: { active: false },
        restore: { title: "恢复", steps: [] },
      }),
      probe: async () => {
        probed += 1;
        return { adb: "ready", connected: true, message: "ok" };
      },
      sessionState: () => ({ active: false }),
    } as unknown as Tc002MusicInstaller;
    const handler = createControlHandler(fakeWorkspaceController(), { arcadeInstaller: installer });

    const status = await handler(new Request("http://127.0.0.1:43820/api/arcade/device-app"));
    expect(status.status).toBe(200);
    expect((await status.json()).deviceApp.artifact.appId).toBe("tc002-arcade");

    const probe = await handler(new Request("http://127.0.0.1:43820/api/arcade/device-app/probe", {
      method: "POST",
    }));
    expect(probe.status).toBe(200);
    expect(probed).toBe(1);

    // The music prefix stays independent: no music installer configured here.
    const music = await handler(new Request("http://127.0.0.1:43820/api/music/device-app"));
    expect(music.status).toBe(404);
    expect((await music.json()).error).toContain("music device installer");
  });

  test("records arcade heartbeats and answers the status poll from memory", async () => {
    const handler = createControlHandler(fakeWorkspaceController(), {});

    // Before any heartbeat (module state starts cold in this suite): offline.
    const before = await handler(new Request("http://127.0.0.1:43820/api/arcade/status"));
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.online).toBe(false);
    expect(beforeBody.ageMs).toBe(-1);

    // Malformed heartbeats are refused before touching the snapshot.
    const bad = await handler(new Request("http://127.0.0.1:43820/api/arcade/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: "DROP TABLE", phase: "playing", score: 3, uptimeMs: 1 }),
    }));
    expect(bad.status).toBe(400);
    const negative = await handler(new Request("http://127.0.0.1:43820/api/arcade/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: "breakout", phase: "playing", score: -1, uptimeMs: 1 }),
    }));
    expect(negative.status).toBe(400);

    // The firmware calls cross-origin (no browser Origin header): accepted.
    const beat = await handler(new Request("http://127.0.0.1:43820/api/arcade/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: "breakout", phase: "playing", score: 128, uptimeMs: 60_000 }),
    }));
    expect(beat.status).toBe(200);

    const after = await handler(new Request("http://127.0.0.1:43820/api/arcade/status"));
    const afterBody = await after.json();
    expect(afterBody.online).toBe(true);
    expect(afterBody.ageMs).toBeGreaterThanOrEqual(0);
    expect(afterBody.ageMs).toBeLessThan(12_000);
    expect(afterBody.game).toBe("breakout");
    expect(afterBody.phase).toBe("playing");
    expect(afterBody.score).toBe(128);
  });

  test("an active installer session counts as online before the first heartbeat", async () => {
    const installer = {
      sessionState: () => ({ active: true, version: "0.1.0" }),
    } as unknown as Tc002MusicInstaller;
    const handler = createControlHandler(fakeWorkspaceController(), { arcadeInstaller: installer });
    const status = await handler(new Request("http://127.0.0.1:43820/api/arcade/status"));
    expect((await status.json()).online).toBe(true);
  });

  test("encodes mirror frames into one custom-app push and supports clearing", async () => {
    const payloads: { duration: number; image: { data: string }[] }[] = [];
    let cleared = 0;
    const handler = createControlHandler(fakeWorkspaceController(), {
      musicMirror: {
        push: async (payload) => {
          payloads.push(payload as never);
          return { status: 200 };
        },
        clear: async () => {
          cleared += 1;
          return { status: 200 };
        },
      },
    });

    const pixels = Buffer.alloc(52 * 16 * 3, 32).toString("base64");
    const pushed = await handler(new Request("http://127.0.0.1:43820/api/music/mirror", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frames: [
          { delayMs: 400, pixels },
          { delayMs: 400, pixels },
        ],
      }),
    }));
    expect(pushed.status).toBe(200);
    expect((await pushed.json()).mirror.frames).toBe(2);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.image[0]!.data.startsWith("data:image/gif;base64,")).toBe(true);
    expect(payloads[0]!.duration).toBeGreaterThanOrEqual(5);

    // 歌词 GIF 只播一次：没有 NETSCAPE 循环块，唱完的句子就停在最后一帧，
    // 不会在下一句推上来之前从头再滚一遍。
    const gifBytes = Buffer.from(
      payloads[0]!.image[0]!.data.replace("data:image/gif;base64,", ""),
      "base64",
    );
    expect(gifBytes.includes(Buffer.from("NETSCAPE2.0"))).toBe(false);

    const badFrame = await handler(new Request("http://127.0.0.1:43820/api/music/mirror", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames: [{ delayMs: 400, pixels: "short" }] }),
    }));
    expect(badFrame.status).toBe(400);

    // 一句 12 秒的歌词按 33fps 就是 400 帧，整条请求约 1.3MB——通用的 256KB
    // 上限会把它挡掉，所以这个端点单独放宽了 body 限制。
    const fullLine = await handler(new Request("http://127.0.0.1:43820/api/music/mirror", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frames: Array.from({ length: 400 }, () => ({ delayMs: 30, pixels })),
      }),
    }));
    expect(fullLine.status).toBe(200);
    expect((await fullLine.json()).mirror.frames).toBe(400);

    const overCap = await handler(new Request("http://127.0.0.1:43820/api/music/mirror", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frames: Array.from({ length: 401 }, () => ({ delayMs: 30, pixels })),
      }),
    }));
    expect(overCap.status).toBe(400);

    const clearedResponse = await handler(new Request("http://127.0.0.1:43820/api/music/mirror", {
      method: "DELETE",
    }));
    expect(clearedResponse.status).toBe(200);
    expect(cleared).toBe(1);
  });

  test("returns preview bytes and supports direct push", async () => {
    const handler = createControlHandler(fakeController());
    const preview = await handler(
      new Request("http://127.0.0.1:43820/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(DEFAULT_SETTINGS),
      }),
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Content-Type")).toBe("image/png");

    const pushed = await handler(
      new Request("http://127.0.0.1:43820/api/push", { method: "POST" }),
    );
    expect(pushed.status).toBe(200);
  });

  test("exposes the extensible catalog and versioned channel workspace", async () => {
    const previewCalls: boolean[] = [];
    const handler = createControlHandler(fakeWorkspaceController(previewCalls));
    const catalog = await handler(new Request("http://127.0.0.1:43820/api/catalog"));
    const catalogBody = await catalog.json();
    expect(catalogBody.contents).toHaveLength(30);
    expect(catalogBody.categories.map((category: { id: string }) => category.id)).toEqual([
      "market", "tools", "visual", "creative",
    ]);

    const current = await handler(new Request("http://127.0.0.1:43820/api/workspace"));
    const workspace = (await current.json()).workspace;
    workspace.channels[0].name = "组合轮播";
    const saved = await handler(new Request("http://127.0.0.1:43820/api/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify(workspace),
    }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).workspace.channels[0].name).toBe("组合轮播");

    const preview = await handler(new Request("http://127.0.0.1:43820/api/channels/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: workspace.channels[0].id, forceRefresh: true }),
    }));
    expect(preview.headers.get("X-Frame-Count")).toBe("1");
    expect(previewCalls).toEqual([true]);
  });

  test("imports official pixel assets through the same-origin library adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-control-assets-"));
    directories.push(directory);
    const png = new PixelCanvas(52, 16, [0, 255, 102]).toPng();
    const client = {
      async list() {
        return {
          count: 1,
          page: 1,
          limit: 12,
          items: [{
            id: "1091",
            title: "新天鹅堡",
            author: "Sakiko",
            description: "",
            classificationCode: 12,
            previewPath: "/cdn/uploadPath/upload/castle.png",
            detailUrl: "https://ugc.ulanzistudio.com/contentView/1091",
            createdAt: "2026-07-31 00:00:00",
            animatedPreview: false,
          }],
        };
      },
      async download() {
        return {
          officialId: "1091",
          title: "新天鹅堡",
          author: "Sakiko",
          sourceUrl: "https://ugc.ulanzistudio.com/contentView/1091",
          mimeType: "image/png" as const,
          bytes: png,
        };
      },
      async preview() {
        return { bytes: png, contentType: "image/png" };
      },
    } as unknown as UlanziPixelAssetClient;
    const store = new PixelAssetStore(directory);
    const handler = createControlHandler(fakeWorkspaceController(), {
      pixelAssetLibrary: { client, store },
    });

    const listed = await handler(new Request(
      "http://127.0.0.1:43820/api/library/ulanzi/pixel-assets?classificationId=13",
    ));
    expect(listed.status).toBe(200);
    expect((await listed.json()).items[0].previewUrl).toContain("/api/library/ulanzi/media?");

    const imported = await handler(new Request("http://127.0.0.1:43820/api/library/ulanzi/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify({ source: "1091" }),
    }));
    expect(imported.status).toBe(200);
    const importedBody = await imported.json();
    expect(importedBody.asset).toMatchObject({ officialId: "1091", frameCount: 1 });
    const localMedia = await handler(new Request(
      `http://127.0.0.1:43820${importedBody.asset.previewUrl}`,
    ));
    expect(localMedia.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await localMedia.arrayBuffer()).subarray(0, 4)).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });

  test("searches, registers, lists, and serves runtime market instruments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-control-market-"));
    directories.push(directory);
    const instruments = new InstrumentStore(join(directory, "instruments"));
    const icons = new MarketIconStore(join(directory, "icons"));
    await Promise.all([instruments.load(), icons.load()]);
    const marketCatalog = new MarketCatalogService({
      instruments,
      icons,
      search: new MarketSearchService({
        fetcher: async (input) => {
          if (String(input).endsWith("/products")) {
            return Response.json([{
              id: "DOGE-USD",
              base_currency: "DOGE",
              quote_currency: "USD",
              display_name: "DOGE/USD",
              status: "online",
              quote_increment: "0.0001",
            }]);
          }
          if (String(input).endsWith("/currencies")) {
            return Response.json([{
              id: "DOGE",
              name: "Dogecoin",
              default_network: "dogecoin",
              supported_networks: [],
            }]);
          }
          return Response.json([]);
        },
      }),
      logos: new BundledCryptoLogoCatalog(join(
        import.meta.dir,
        "../node_modules/cryptocurrency-icons",
      )),
    });
    const handler = createControlHandler(fakeWorkspaceController(), { marketCatalog });
    const search = await handler(new Request(
      "http://127.0.0.1:43820/api/market/search?q=doge&kind=crypto",
    ));
    expect(search.status).toBe(200);
    const candidate = (await search.json()).results[0];
    expect(candidate.pair).toBe("DOGE/USD");

    const created = await handler(new Request("http://127.0.0.1:43820/api/market/instruments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify({ candidateRef: candidate.candidateRef }),
    }));
    expect(created.status).toBe(201);
    const instrument = (await created.json()).instrument;
    expect(instrument.iconUrl).toContain("/api/market/icons/ico_");
    expect(instrument.iconMode).toBe("catalog");

    const listed = await handler(new Request("http://127.0.0.1:43820/api/market/instruments"));
    expect((await listed.json()).instruments).toHaveLength(1);
    const icon = await handler(new Request(new URL(instrument.iconUrl, "http://127.0.0.1:43820")));
    expect(icon.status).toBe(200);
    expect(icon.headers.get("Cache-Control")).toContain("immutable");
    const etag = icon.headers.get("ETag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const unchanged = await handler(new Request(
      new URL(instrument.iconUrl, "http://127.0.0.1:43820"),
      { headers: { "If-None-Match": etag! } },
    ));
    expect(unchanged.status).toBe(304);
    const removedUploadEndpoint = await handler(new Request(
      `http://127.0.0.1:43820/api/market/logo-uploads?instrumentRef=${instrument.ref}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
        body: "{}",
      },
    ));
    expect(removedUploadEndpoint.status).toBe(404);
  });

  test("geocodes place queries through the injected client and validates them first", async () => {
    const queries: string[] = [];
    const places = [
      { name: "Shanghai", admin1: "Shanghai", country: "China", latitude: 31.2222, longitude: 121.4581 },
      { name: "Shanghai Reef", country: "PH", latitude: 9.9, longitude: 114.1 },
    ];
    const handler = createControlHandler(fakeWorkspaceController(), {
      weatherGeocode: {
        search: async (query: string) => {
          queries.push(query);
          return places;
        },
      },
    });

    const found = await handler(new Request(
      "http://127.0.0.1:43820/api/weather/geocode?q=%20shanghai%20",
    ));
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ places });
    // The route trims before delegating, so the client caches a clean key.
    expect(queries).toEqual(["shanghai"]);

    const missing = await handler(new Request("http://127.0.0.1:43820/api/weather/geocode"));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("q must contain 1-64 characters");
    const tooLong = await handler(new Request(
      `http://127.0.0.1:43820/api/weather/geocode?q=${"a".repeat(65)}`,
    ));
    expect(tooLong.status).toBe(400);
    const crossOrigin = await handler(new Request(
      "http://127.0.0.1:43820/api/weather/geocode?q=paris",
      { headers: { Origin: "https://example.com" } },
    ));
    expect(crossOrigin.status).toBe(400);
    // None of the rejected requests reached the geocoder.
    expect(queries).toEqual(["shanghai"]);

    const failingHandler = createControlHandler(fakeWorkspaceController(), {
      weatherGeocode: {
        search: async () => {
          throw new Error("open-meteo geocoding returned HTTP 503");
        },
      },
    });
    const upstream = await failingHandler(new Request(
      "http://127.0.0.1:43820/api/weather/geocode?q=paris",
    ));
    expect(upstream.status).toBe(503);
  });
});
