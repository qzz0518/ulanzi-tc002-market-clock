import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlHandler, resetDeviceMusicSelection } from "../src/control-api.ts";
import { ClockRequestError } from "../src/clock-client.ts";
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
import type { VibeUsageSnapshot } from "../src/vibe/usage-service.ts";

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
    channelContentRevision: () => "deadbeef0001",
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

  test("answers 每日推荐 and 随机一首 from NetEase itself, and passes its failures through", async () => {
    const track = {
      id: "560693602",
      title: "夜航",
      artists: ["像素乐队"],
      album: "十六行",
      durationMs: 180_000,
    };
    // Both routes name `netease` rather than the active provider: they ask a
    // question only NetEase has an answer to. Spotify being the live source
    // must not change who is asked — so it is, and its stubs throw.
    const music = fakeMusicHub({
      dailyRecommendations: async () => [track],
      randomLikedTrack: async () => track,
    });
    const spotifyProvider = {
      id: "spotify",
      playbackMode: "remote",
      status: () => ({ loggedIn: false }),
      dailyRecommendations: async () => {
        throw new Error("asked Spotify for a NetEase-only list");
      },
      randomLikedTrack: async () => {
        throw new Error("asked Spotify for a NetEase-only list");
      },
    };
    (music as unknown as Record<string, unknown>).spotify = spotifyProvider;
    (music as unknown as Record<string, unknown>).activeProvider = () => spotifyProvider;
    const handler = createControlHandler(fakeWorkspaceController(), { music });

    const daily = await handler(new Request("http://127.0.0.1:43820/api/music/netease/daily"));
    expect(daily.status).toBe(200);
    expect(await daily.json()).toEqual({ tracks: [track] });

    const random = await handler(
      new Request("http://127.0.0.1:43820/api/music/netease/liked/random"),
    );
    expect(random.status).toBe(200);
    expect(await random.json()).toEqual({ track });

    // Signed out: the user is told to scan, not handed an empty list.
    const signedOut = createControlHandler(fakeWorkspaceController(), {
      music: fakeMusicHub({
        dailyRecommendations: async () => {
          throw new MusicServiceError("请先使用网易云音乐扫码登录", 401);
        },
        randomLikedTrack: async () => {
          throw new MusicServiceError("这个网易云账号还没有喜欢的歌曲", 404);
        },
      }),
    });
    const denied = await signedOut(
      new Request("http://127.0.0.1:43820/api/music/netease/daily"),
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "请先使用网易云音乐扫码登录" });

    const noLikes = await signedOut(
      new Request("http://127.0.0.1:43820/api/music/netease/liked/random"),
    );
    expect(noLikes.status).toBe(404);
    expect((await noLikes.json()).error).toContain("还没有喜欢的歌曲");
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
    //
    // BYTE-FOR-BYTE REGRESSION LOCK. The sideload parser in LyricsPage.cpp
    // splits on the first tab and treats any key that is not "DUR" as a start
    // time, so a new record type would land as a garbage line at 0 ms and an
    // extra column would render as literal tab-separated text. A device that
    // has not been reflashed must keep receiving exactly this.
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

  test("serves the word-level lyric timeline only to a firmware that asked for it", async () => {
    // 孤勇者's reported line, plus a wordless one, on the sideload wire.
    const glyphs = [..."谁说站在光里的才算英雄"];
    const provider = {
      status: () => ({ loggedIn: true, profile: { provider: "netease", id: "1", nickname: "听众" } }),
      trackDetail: async (id: string) => ({
        track: { id, title: "孤勇者", artists: ["陈奕迅"], durationMs: 260_000 },
        lyrics: [
          {
            startMs: 110_330,
            endMs: 115_620,
            text: "谁说站在光里的才算英雄",
            endSource: "words",
            words: [
              [110_330, 350], [110_680, 250], [110_930, 460], [111_390, 400], [111_790, 400],
              [112_190, 400], [112_590, 640], [113_230, 380], [113_610, 390], [114_000, 340],
              [114_340, 1_280],
            ].map(([startMs, durationMs], index) => ({
              startMs: startMs!,
              endMs: startMs! + durationMs!,
              text: glyphs[index]!,
            })),
          },
          { startMs: 128_880, endMs: 131_000, text: "他们说", endSource: "estimate" },
        ],
      }),
    };
    resetDeviceMusicSelection("netease");
    const handler = createControlHandler(fakeWorkspaceController(), {
      music: fakeMusicHub(provider),
    });
    await handler(new Request("http://127.0.0.1:43820/api/music/device/select", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify({ trackId: "1901371647" }),
    }));

    // Unversioned: the old format, unchanged, with no end and no table — which
    // is why the sideload player still derives the end from the next start.
    const legacy = await handler(new Request("http://127.0.0.1:43820/api/music/device/now"));
    expect(await legacy.text())
      .toBe("DUR\t260000\n110330\t谁说站在光里的才算英雄\n128880\t他们说\n");

    const v2 = await handler(new Request("http://127.0.0.1:43820/api/music/device/now?v=2"));
    const lines = (await v2.text()).split("\n").filter(Boolean);
    // A version record first, so a firmware flashed with the wrong build can
    // tell the two formats apart instead of rendering tabs as text.
    expect(lines[0]).toBe("V\t2");
    expect(lines[1]).toBe("DUR\t260000");
    // The sung end now travels with the line: 5.29 s, not the 18.55 s to the
    // next one.
    expect(lines[2]).toBe("L\t110330\t115620\t谁说站在光里的才算英雄");
    const table = lines[3]!;
    expect(table.startsWith("W\t0,350,350,250,")).toBe(true);
    expect(table.slice(2).split(",")).toHaveLength(22);
    // A line with no word timings simply carries no table, and the panel sweeps
    // it exactly as it always did.
    expect(lines[4]).toBe("L\t128880\t131000\t他们说");
    expect(lines).toHaveLength(5);
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
    expect(catalogBody.contents).toHaveLength(35);
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

  test("serves the full device information page fields, and surfaces an unreachable clock", async () => {
    const info = {
      serialNumber: "B0D26I008U3670972",
      ssid: "xiaoya-2.4G",
      ip: "192.0.2.240",
      mac: "ccc4b277a772",
      mcuVersion: "V1.0.17",
      appVersion: "1.0.8",
    };
    const handler = createControlHandler(fakeWorkspaceController(), {
      deviceInfo: { read: async () => info },
    });
    const response = await handler(new Request("http://127.0.0.1:43820/api/device/info"));
    expect(response.status).toBe(200);
    expect((await response.json()).info).toEqual(info);

    // The tab keys its address-recovery UI off this failure, so it must not be
    // flattened into an empty 200.
    const downHandler = createControlHandler(fakeWorkspaceController(), {
      deviceInfo: {
        read: async () => {
          throw new ClockRequestError("clock request failed: timed out after 5000ms");
        },
      },
    });
    const down = await downHandler(new Request("http://127.0.0.1:43820/api/device/info"));
    expect(down.status).toBe(503);
    expect((await down.json()).error).toContain("clock request failed");

    const missing = await createControlHandler(fakeWorkspaceController(), {})(
      new Request("http://127.0.0.1:43820/api/device/info"),
    );
    expect(missing.status).toBe(404);
  });

  test("repoints the clock host through a same-origin adapter and probes the new address", async () => {
    let current = "192.0.2.240";
    const envHost = "192.0.2.240";
    let cleared = false;
    let reachable = false;
    const handler = createControlHandler(fakeWorkspaceController(), {
      deviceInfo: {
        read: async () => {
          if (!reachable) throw new ClockRequestError("clock request failed: no route to host");
          return { ip: current, mcuVersion: "V1.0.17", appVersion: "1.0.8" };
        },
      },
      deviceHost: {
        read: () => ({ host: current, envHost, source: cleared || current === envHost ? "env" : "override" }),
        write: async (host) => {
          current = host;
          cleared = false;
          return { host: current, envHost, source: "override" };
        },
        reset: async () => {
          current = envHost;
          cleared = true;
          return { host: current, envHost, source: "env" };
        },
      },
    });

    const initial = await handler(new Request("http://127.0.0.1:43820/api/device/host"));
    expect(initial.status).toBe(200);
    expect((await initial.json()).host).toEqual({ host: "192.0.2.240", envHost, source: "env" });

    // A save must still succeed when the clock does not answer — it may be off —
    // but it has to report the probe rather than pretend the address works.
    const saved = await handler(new Request("http://127.0.0.1:43820/api/device/host", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify({ host: "192.0.2.77" }),
    }));
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody.host).toEqual({ host: "192.0.2.77", envHost, source: "override" });
    expect(savedBody.probe.ok).toBe(false);
    expect(savedBody.probe.error).toContain("no route to host");

    reachable = true;
    const retried = await handler(new Request("http://127.0.0.1:43820/api/device/host", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify({ host: "192.0.2.88" }),
    }));
    expect((await retried.json()).probe).toEqual({
      ok: true,
      info: { ip: "192.0.2.88", mcuVersion: "V1.0.17", appVersion: "1.0.8" },
    });

    const invalid = await handler(new Request("http://127.0.0.1:43820/api/device/host", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify({ host: "http://192.0.2.88:80" }),
    }));
    expect(invalid.status).toBe(400);

    const crossOrigin = await handler(new Request("http://127.0.0.1:43820/api/device/host", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ host: "192.0.2.99" }),
    }));
    // Same-origin failures use the house 400 + SettingsValidationError funnel.
    expect(crossOrigin.status).toBe(400);
    expect((await crossOrigin.json()).error).toContain("cross-origin");

    const reset = await handler(new Request("http://127.0.0.1:43820/api/device/host", {
      method: "DELETE",
      headers: { Origin: "http://127.0.0.1:43820" },
    }));
    expect((await reset.json()).host).toEqual({ host: envHost, envHost, source: "env" });
  });
});

describe("tc002-os console routes", () => {
  // The console cannot compare a service timestamp against its own clock: the
  // two are not the same clock, and a browser a few seconds out of step reports
  // a live stream as stale — or paints a two-minute-old frame as current, which
  // is what actually happened before these fields existed.
  test("mirror and state carry a service-measured age", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });

    // No frame yet, but the lease state is still reportable.
    const empty = await handler(new Request("http://127.0.0.1/api/os/mirror"));
    const emptyBody = await empty.json() as { frame: unknown; wanted: boolean };
    expect(emptyBody.frame).toBeNull();
    expect(emptyBody.wanted).toBe(true); // asking IS the subscription

    osLink.putMirrorFrame(Buffer.alloc(52 * 16 * 3).toString("base64"));
    const mirror = await handler(new Request("http://127.0.0.1/api/os/mirror"));
    const frame = (await mirror.json() as { frame: { ageMs: number } }).frame;
    expect(typeof frame.ageMs).toBe("number");
    expect(frame.ageMs).toBeGreaterThanOrEqual(0);

    osLink.report({
      screen: "launcher",
      focus: "",
      wifi: "net",
      ip: "192.168.8.240",
      uptimeMs: 1_000,
      freeKb: 16_000,
      supplicantRestarts: 0,
      proto: 0,
      batteryPercent: 87,
      charging: false,
      flashed: false,
    });
    const state = await handler(new Request("http://127.0.0.1/api/os/state"));
    const body = await state.json() as {
      telemetry: { ageMs: number };
      live: boolean;
      mirrorWanted: boolean;
    };
    expect(typeof body.telemetry.ageMs).toBe("number");
    expect(body.live).toBe(true);
    // Without this the console cannot tell "the device has not started
    // streaming yet" from "the device is not streaming at all".
    expect(body.mirrorWanted).toBe(true);
  });

  // Naming a channel without saying who is driving used to succeed and do
  // nothing: the request was accepted, the response looked plausible, and the
  // device never moved.
  test("a pin request missing `pinned` is refused rather than coerced", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });
    const origin = "http://127.0.0.1";

    const refused = await handler(new Request(`${origin}/api/os/display`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ focus: "btc" }),
    }));
    expect(refused.status).toBe(400);
    expect(osLink.getDisplay()).toEqual({ focus: null, pinned: false });

    const accepted = await handler(new Request(`${origin}/api/os/display`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ focus: "btc", pinned: true }),
    }));
    expect(accepted.status).toBe(200);
    expect(osLink.getDisplay()).toEqual({ focus: "btc", pinned: true });

    // Releasing needs no focus, so it is still a one-field call.
    const released = await handler(new Request(`${origin}/api/os/display`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ focus: null, pinned: false }),
    }));
    expect(released.status).toBe(200);
    expect(osLink.getDisplay()).toEqual({ focus: null, pinned: false });
  });

  // The console has exactly one 主题设置 panel and the device has one panel, so
  // there is one store: sDeviceState, which the sideloaded lyrics player already
  // reads from /api/music/device/state and which ZOS now reads out of its pull
  // document (ADR 0007). A second store would be a copy somebody keeps equal by
  // hand — and the disagreement would be invisible until someone was in the room
  // with the clock.
  test("the console's theme panel reaches ZOS through the same store as the sideload", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });
    const origin = "http://127.0.0.1:43820";

    // Before any click at all: the hub must already agree with sDeviceState,
    // because the device polls from the moment it boots.
    expect(osLink.getLyricTheme().skin).toBe("signal");

    const control = await handler(new Request(`${origin}/api/music/device/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ mode: "cascade", skin: "tape", accent: "FF8844" }),
    }));
    expect(control.status).toBe(200);
    expect(osLink.getLyricTheme()).toEqual({
      mode: "cascade", skin: "tape", accent: "ff8844",
    });
    const doc = osLink.serialize().split("\n");
    expect(doc).toContain("mode\tcascade");
    expect(doc).toContain("skin\ttape");
    expect(doc).toContain("accent\tff8844");

    // A key press on the sideloaded player is the same authority as a click.
    await handler(new Request(`${origin}/api/music/device/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skin: "arcade" }),
    }));
    expect(osLink.getLyricTheme().skin).toBe("arcade");

    // Readable without parsing the pull document, which is what the ZOS panel
    // and these tests need.
    const state = await handler(new Request(`${origin}/api/os/state`));
    expect((await state.json() as { lyricTheme: unknown }).lyricTheme).toEqual({
      mode: "cascade", skin: "arcade", accent: "ff8844",
    });

    // An invalid patch is refused at the handler and must not reach the device:
    // an unknown mode on the wire would repaint the panel with the fallback,
    // which is not what the console is showing.
    const refused = await handler(new Request(`${origin}/api/music/device/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ mode: "kaleidoscope" }),
    }));
    expect(refused.status).toBe(400);
    expect(osLink.getLyricTheme().mode).toBe("cascade");

    // A MIXED patch, which is the case that actually broke the invariant: the
    // first field validates, the second throws, and a field-by-field merge left
    // the throw sitting between two applied writes. The sideloaded player's
    // /state then served 走带 while the ZOS document — republished only on the
    // success path — still said 升降, out of ONE store. The console sends one
    // field per click, but /api/music/device/report reaches the same code with
    // no same-origin check.
    const partial = await handler(new Request(`${origin}/api/music/device/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ mode: "ticker", accent: "nothex" }),
    }));
    expect(partial.status).toBe(400);
    const sideload = await handler(new Request(`${origin}/api/music/device/state`));
    expect(await sideload.text()).toContain("MODE\tcascade");
    expect(osLink.getLyricTheme()).toEqual({
      mode: "cascade", skin: "arcade", accent: "ff8844",
    });

    // sDeviceState is module state shared by every test in this file.
    await handler(new Request(`${origin}/api/music/device/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ mode: "spotlight", skin: "signal", accent: null }),
    }));
  });

  // Only this browser knows what a device-audio provider is playing, so it is
  // also the only thing that can say where the current line starts and ends —
  // and without that window every 显示形式 has nothing to animate.
  test("a console now-playing report carries the lyric line's window", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });
    const origin = "http://127.0.0.1:43820";

    const put = await handler(new Request(`${origin}/api/os/now-playing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        track: "夜航", artist: "某人", playing: true,
        positionMs: 41_000, durationMs: 244_000, lyric: "第一行",
        lyricStartMs: 40_500, lyricEndMs: 44_000,
      }),
    }));
    expect(put.status).toBe(200);
    const doc = osLink.serialize().split("\n");
    expect(doc).toContain("lyricat\t40500");
    expect(doc).toContain("lyricend\t44000");

    // An older console sends neither. It must still play — the panel falls back
    // to an untimed sweep rather than to a blank screen.
    await handler(new Request(`${origin}/api/os/now-playing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        track: "夜航", artist: "某人", playing: true,
        positionMs: 60_000, durationMs: 244_000, lyric: "第二行",
      }),
    }));
    const legacy = osLink.serialize().split("\n");
    expect(legacy).toContain("lyric\t第二行");
    expect(legacy.some((line) => line.startsWith("lyricat\t"))).toBe(false);
  });

  test("a console report can carry word timings, and a bad table is dropped not rejected", async () => {
    const { OsLinkHub, OS_PROTO_LYRIC_WINDOW } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });
    const origin = "http://127.0.0.1:43820";
    // The device announces which document revision it can read; without this it
    // is treated as a build from before the split and gets the old encoding.
    await handler(new Request(`${origin}/api/os/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screen: "music", flashed: true, proto: OS_PROTO_LYRIC_WINDOW }),
    }));
    const report = (body: unknown) => handler(new Request(`${origin}/api/os/now-playing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    }));
    const base = {
      track: "孤勇者", artist: "陈奕迅", playing: true,
      positionMs: 113_000, durationMs: 260_000,
      lyric: "谁说站在光里的才算英雄",
      lyricStartMs: 110_330, lyricEndMs: 115_620, lyricUntilMs: 128_880,
    };
    const words = [
      [110_330, 350], [110_680, 250], [110_930, 460], [111_390, 400], [111_790, 400],
      [112_190, 400], [112_590, 640], [113_230, 380], [113_610, 390], [114_000, 340],
      [114_340, 1_280],
    ].map(([startMs, durationMs], index) => ({
      startMs: startMs!,
      endMs: startMs! + durationMs!,
      text: [..."谁说站在光里的才算英雄"][index]!,
    }));

    expect((await report({ ...base, lyricWords: words })).status).toBe(200);
    const doc = osLink.serialize().split("\n");
    expect(doc).toContain("lyricend\t115620");
    expect(doc).toContain("lyricuntil\t128880");
    expect(doc.find((line) => line.startsWith("lyricw\t"))!.slice(7).split(","))
      .toHaveLength(22);

    // A malformed table must never fail the report: the panel falls back to the
    // line-level sweep, which is the honest answer when the timings cannot be
    // trusted, and the line itself still reaches the device.
    for (const broken of [
      [{ startMs: -1, endMs: 100, text: "谁" }],
      [{ startMs: 500, endMs: 100, text: "谁" }],
      [{ startMs: 500, endMs: 900, text: "" }],
      [{ startMs: 900, endMs: 1_000, text: "说" }, { startMs: 500, endMs: 600, text: "谁" }],
      Array.from({ length: 65 }, (_, i) => ({ startMs: i, endMs: i + 1, text: "字" })),
      "not an array",
    ]) {
      const response = await report({ ...base, lyric: "另一句", lyricWords: broken });
      expect(response.status).toBe(200);
      const after = osLink.serialize().split("\n");
      expect(after).toContain("lyric\t另一句");
      expect(after.some((line) => line.startsWith("lyricw\t"))).toBe(false);
      // Reset so the next iteration is not comparing against itself.
      await report({ ...base, lyric: "重置", lyricWords: undefined });
    }
  });

  // A restart used to be indistinguishable from a factory reset for this one
  // setting: sDeviceState is module memory, ZOS applies the document's theme
  // unconditionally (a theme has no second writer on the device, so there is no
  // sequence to gate on), and the device then stages what it was given into
  // /data. So `bun start` repainted the panel 信号绿 AND destroyed the warm-start
  // cache that exists for exactly this — the user's own complaint, one restart
  // later.
  test("the theme survives a restart instead of being reset to the defaults", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const { LyricThemeStore } = await import("../src/lyric-theme-store.ts");
    const { restoreDeviceLyricTheme } = await import("../src/control-api.ts");
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-lyric-theme-"));
    directories.push(directory);
    const path = join(directory, "lyric-theme.json");
    const origin = "http://127.0.0.1:43820";

    const store = new LyricThemeStore(path);
    expect(await store.load()).toBeNull();
    const handler = createControlHandler(fakeWorkspaceController(), {
      osLink: new OsLinkHub(),
      lyricThemeStore: store,
    });
    const chosen = await handler(new Request(`${origin}/api/music/device/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ mode: "cascade", skin: "tape", accent: "FF8844" }),
    }));
    expect(chosen.status).toBe(200);
    // Fire-and-forget: a colour must not be able to fail a request, so the write
    // is not awaited by the handler and is awaited here instead. It is also the
    // SECOND write this store has queued — building the handler saved whatever
    // the defaults were — so this is where an unordered chain would leave the
    // defaults on disk and the user's choice underneath them.
    await store.settled();
    expect(await Bun.file(path).json()).toMatchObject({
      mode: "cascade", skin: "tape", accent: "ff8844",
    });

    // The restart. A brand-new hub — everything the process knew is gone — and
    // the very first document it serves has to carry the user's choice, because
    // the device polls before anybody opens a browser.
    const rebooted = new OsLinkHub();
    restoreDeviceLyricTheme(await new LyricThemeStore(path).load());
    createControlHandler(fakeWorkspaceController(), { osLink: rebooted });
    expect(rebooted.getLyricTheme()).toEqual({
      mode: "cascade", skin: "tape", accent: "ff8844",
    });
    expect(rebooted.serialize().split("\n")).toContain("skin\ttape");

    // A file somebody hand-edited into nonsense is a colour, not a credential:
    // the bad fields are dropped and the service still starts.
    await Bun.write(path, JSON.stringify({ mode: "kaleidoscope", skin: "signal" }));
    restoreDeviceLyricTheme(await new LyricThemeStore(path).load());
    const salvaged = new OsLinkHub();
    createControlHandler(fakeWorkspaceController(), { osLink: salvaged });
    expect(salvaged.getLyricTheme()).toEqual({
      mode: "cascade", skin: "signal", accent: "ff8844",
    });

    // sDeviceState is module state shared by every test in this file.
    await handler(new Request(`${origin}/api/music/device/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ mode: "spotlight", skin: "signal", accent: null }),
    }));
  });
});

describe("tc002-os night sleep", () => {
  // The console half of 夜间休眠. Immediate, like /api/os/settings: no draft/save
  // cycle, because the one thing this endpoint has to be good at is turning the
  // feature OFF for a user whose clock went dark and who is not in the room.
  test("accepts a partial write, echoes the request, and refuses nonsense", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });
    const origin = "http://127.0.0.1:43820";
    const put = (body: unknown, headers: Record<string, string> = {}) =>
      handler(new Request(`${origin}/api/os/sleep`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin, ...headers },
        body: JSON.stringify(body),
      }));

    const ok = await put({ enabled: true, startMin: 1320, endMin: 450, idleSec: 600 });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { requested: unknown }).requested).toEqual({
      enabled: true, startMin: 1320, endMin: 450, idleSec: 600, seq: 1,
    });

    // A minute is 0..1439; 1440 is not "the end of the day", it is a value the
    // firmware would have to wrap, and a console that could send it would make
    // the two sides disagree about what the user asked for.
    expect((await put({ startMin: 1440 })).status).toBe(400);
    expect((await put({ endMin: -1 })).status).toBe(400);
    // Below 30 s the panel blanks while the user is looking at it.
    expect((await put({ idleSec: 10 })).status).toBe(400);
    expect((await put({ idleSec: 7201 })).status).toBe(400);
    expect((await put({ enabled: "yes" })).status).toBe(400);
    // A body that names nothing is a no-op dressed as a request.
    expect((await put({})).status).toBe(400);
    // Nothing above may have reached the hub.
    expect(osLink.getSleep()).toMatchObject({ startMin: 1320, endMin: 450, idleSec: 600 });

    // startMin === endMin is 全天, not a zero-length window: the firmware reads
    // it that way, and rejecting it here would make the whole-day case — the
    // only way to try this at 15:00 — unreachable from the console.
    const allDay = await put({ startMin: 0, endMin: 0 });
    expect(allDay.status).toBe(200);

    // Same-origin, like every other write endpoint (assertSameOrigin refuses
    // with the shared validation status rather than a 403 of its own).
    const crossOrigin = await handler(new Request(`${origin}/api/os/sleep`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ enabled: false }),
    }));
    expect(crossOrigin.status).toBe(400);
    expect(osLink.getSleep().enabled).toBe(true);
  });

  test("a timeout-only PUT reaches the wire as a timeout, not as a whole config", async () => {
    // The end of the blocker, from the route rather than the hub: the spec this
    // endpoint ships tells a console it may send one field, so one field is what
    // the device must receive. Before the hub's fields were nullable, a
    // {idleSec:600} PUT put `sleepon 0 / sleepfrom 1380 / sleeptill 420` on the
    // wire, and the firmware — which reads an ABSENT LINE as "leave it alone" —
    // adopted all four and persisted them to /data. Changing the timeout turned
    // the feature off and lost the user's window.
    const { OsLinkHub } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });
    const origin = "http://127.0.0.1:43820";
    const put = await handler(new Request(`${origin}/api/os/sleep`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ idleSec: 600 }),
    }));
    expect(put.status).toBe(200);
    const lines = osLink.serialize().split("\n").filter((line) => line.startsWith("sleep"));
    expect(lines).toEqual(["sleepseq\t1", "sleepidle\t600"]);
  });

  // The route is the only caller of setSleep, so this is where the durability
  // wired in service.ts is actually exercised end to end. Without it the
  // sequence restarted at 0 on every `bun start` while the device was still up
  // holding the last number it had applied, and the console's next change was
  // refused with a 200 in front of it — see test/os-sleep-request.test.ts for
  // the restart itself.
  test("a sleep PUT is written down, so the sequence outlives the process", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const { OsSleepRequestStore } = await import("../src/os-sleep-request-store.ts");
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-os-sleep-"));
    directories.push(directory);
    const path = join(directory, "os-sleep-request.json");
    const store = new OsSleepRequestStore(path);
    const osLink = new OsLinkHub(() => Date.now(), store);
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });
    const origin = "http://127.0.0.1:43820";

    const put = await handler(new Request(`${origin}/api/os/sleep`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ enabled: true, startMin: 1380, endMin: 420 }),
    }));
    expect(put.status).toBe(200);
    // Fire and forget, so the write is not awaited by the handler: a bedtime
    // must not be able to fail a route.
    await store.settled();
    expect(await Bun.file(path).json()).toMatchObject({
      version: 1, seq: 1, enabled: true, startMin: 1380, endMin: 420, idleSec: null,
    });
  });

  test("state carries the request and the device's own answer separately", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });

    const before = await handler(new Request("http://127.0.0.1/api/os/state"));
    const beforeBody = await before.json() as {
      requestedSleep: { seq: number };
      telemetry: { sleep?: unknown } | null;
    };
    expect(beforeBody.requestedSleep.seq).toBe(0);
    expect(beforeBody.telemetry).toBeNull();

    osLink.setSleep({ enabled: true });
    osLink.report({
      screen: "launcher",
      focus: "",
      wifi: "net",
      ip: "192.168.8.240",
      uptimeMs: 1_000,
      freeKb: 16_000,
      supplicantRestarts: 0,
      proto: 0,
      batteryPercent: 87,
      charging: false,
      flashed: true,
      sleep: {
        on: true, startMin: 0, endMin: 480, idleSec: 1800,
        asleep: true, clockSynced: false,
      },
    });
    const after = await handler(new Request("http://127.0.0.1/api/os/state"));
    const body = await after.json() as {
      requestedSleep: { enabled: boolean | null; startMin: number | null };
      telemetry: {
        sleep: { on: boolean; startMin: number; asleep: boolean; clockSynced: boolean };
      };
    };
    // Two different questions: what the console asked for, and what the knob
    // left the device at. A form that rendered the first would be wrong for as
    // long as somebody had used the clock.
    //
    // `startMin: null` is the point of the shape: the console asked to turn the
    // feature ON and said nothing about the window, so there is no window here
    // to render — the device's is in telemetry, and only that one is real.
    expect(body.requestedSleep).toMatchObject({ enabled: true, startMin: null });
    expect(body.telemetry.sleep).toMatchObject({ startMin: 0, asleep: true });
    // ...and the reason a panel that is not sleeping although sleep is on is
    // not a bug: the clock has not been proven yet.
    expect(body.telemetry.sleep.clockSynced).toBe(false);
  });

  test("a device report without a sleep block leaves the capability absent", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });
    const origin = "http://127.0.0.1:43820";

    // The firmware calls this one, so it carries no same-origin check.
    const posted = await handler(new Request(`${origin}/api/os/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screen: "launcher", uptimeMs: 5, flashed: true }),
    }));
    expect(posted.status).toBe(204);
    // Absence is the capability signal, so a half-understood block must produce
    // NO block rather than a plausible default: showing 休眠中 for a device that
    // cannot sleep would be worse than showing the controls disabled.
    expect(osLink.getTelemetry()?.sleep).toBeUndefined();

    await handler(new Request(`${origin}/api/os/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        screen: "launcher",
        uptimeMs: 6,
        flashed: true,
        sleep: { on: true, startMin: 1380, endMin: 420, idleSec: 300, asleep: false, clockSynced: true },
      }),
    }));
    expect(osLink.getTelemetry()?.sleep).toEqual({
      on: true, startMin: 1380, endMin: 420, idleSec: 300,
      asleep: false, clockSynced: true,
    });

    // A garbled block is clamped rather than failing the heartbeat: telemetry
    // dying entirely over one out-of-range integer is the worse outcome.
    await handler(new Request(`${origin}/api/os/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        screen: "launcher",
        uptimeMs: 7,
        flashed: true,
        sleep: { on: true, startMin: 99999, endMin: -4, idleSec: 1e9, asleep: "yes" },
      }),
    }));
    expect(osLink.getTelemetry()?.sleep).toEqual({
      on: true, startMin: 1439, endMin: 0, idleSec: 7200,
      asleep: false, clockSynced: false,
    });
  });

  test("the cell voltage reaches the console, and older firmware simply omits it", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const osLink = new OsLinkHub();
    const handler = createControlHandler(fakeWorkspaceController(), { osLink });
    const origin = "http://127.0.0.1:43820";
    const post = (body: unknown) => handler(new Request(`${origin}/api/os/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect((await post({
      screen: "launcher", uptimeMs: 5, flashed: true,
      batteryPercent: 54, batteryMillivolts: 3821, charging: false,
    })).status).toBe(204);
    expect(osLink.getTelemetry()?.batteryMillivolts).toBe(3821);
    // 这才是关机保护真正读的量;百分比只是显示。
    expect(osLink.getTelemetry()?.batteryPercent).toBe(54);

    // -1 是真答案(「还没读到」),必须原样留着 —— 和「这台固件根本不会报」是
    // 两件事,控制台对这两件事说的话不一样。
    await post({ screen: "launcher", uptimeMs: 6, flashed: true, batteryMillivolts: -1 });
    expect(osLink.getTelemetry()?.batteryMillivolts).toBe(-1);

    await post({ screen: "launcher", uptimeMs: 7, flashed: true, batteryPercent: 54 });
    expect(osLink.getTelemetry()?.batteryMillivolts).toBeUndefined();
    // 字段乱了也不许把心跳整条打掉,更不许编一个看着像真的数字。
    await post({ screen: "launcher", uptimeMs: 8, flashed: true, batteryMillivolts: "3821" });
    expect(osLink.getTelemetry()?.batteryMillivolts).toBeUndefined();

    const state = await handler(new Request(`${origin}/api/os/state`));
    const body = await state.json() as { telemetry: { batteryMillivolts?: number } };
    expect("batteryMillivolts" in body.telemetry).toBe(false);
  });
});

// Self-update. The chain from the console to a rewritten mtd3 already exists —
// requestUpgrade() bumps a counter, the pull document carries `upgrade\t<seq>`,
// osLogic calls the vendor updater once per boot — but the image still had to
// reach the device by hand. These are the routes that close that gap: the
// device pulls its firmware over the same HTTP it already pulls its pixels on.
describe("tc002-os firmware routes", () => {
  const DIGEST = "0123456789abcdef0123456789abcdef";

  /**
   * A minimal ZKSWE container.
   *
   * The identity these routes publish is read out of the real header layout
   * (device/tc002-os/release/pack-image.ts: magic, hdr[18] = ei offset, a
   * 524-byte ei block, then the payload whose first 16 bytes are the MD5 of what
   * lands in flash), so the fixture has to actually have one — a random blob
   * would only prove the size+mtime fallback.
   */
  function zkswe(digest: string, payload = "res-filesystem"): Buffer {
    const eiOffset = 48; // 20-byte prefix + one 28-byte item descriptor
    const md5At = eiOffset + 524;
    const bytes = Buffer.alloc(md5At + 16 + payload.length);
    bytes.write("ZKSWEV1.0-180127", 0, "ascii");
    bytes[16] = eiOffset;
    bytes[17] = 1;
    bytes[18] = eiOffset;
    Buffer.from(digest, "hex").copy(bytes, md5At);
    bytes.write(payload, md5At + 16, "ascii");
    return bytes;
  }

  async function firmwareHandler() {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-os-firmware-"));
    directories.push(directory);
    const osFirmwarePath = join(directory, "update.img");
    const osLink = new OsLinkHub();
    return {
      osLink,
      osFirmwarePath,
      handler: createControlHandler(fakeWorkspaceController(), { osLink, osFirmwarePath }),
    };
  }

  test("the staged image is served with an identity read out of its own header", async () => {
    const { handler, osFirmwarePath } = await firmwareHandler();

    // Nothing packed yet. A 404 in the usual shape, not an empty 200: the device
    // must be able to tell "no image" from "an image of zero bytes", because it
    // is about to write whatever it gets to a partition with no A/B pair.
    const missing = await handler(new Request("http://127.0.0.1/api/os/firmware"));
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: string }).error).toContain("packed");

    const before = await handler(new Request("http://127.0.0.1/api/os/firmware/status"));
    expect(await before.json()).toEqual({
      packed: false,
      image: null,
      source: null,
      shadowedPacked: null,
      upgradeSeq: 0,
    });

    const image = zkswe(DIGEST);
    await Bun.write(osFirmwarePath, image);

    const served = await handler(new Request("http://127.0.0.1/api/os/firmware"));
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(served.headers.get("Content-Length")).toBe(String(image.byteLength));
    expect(served.headers.get("Cache-Control")).toBe("no-store");
    // Derived from the file rather than invented, and the same number the
    // device's own updater verifies before it erases anything.
    expect(served.headers.get("ETag")).toBe(`"${DIGEST}"`);
    expect(served.headers.get("X-Build-Id")).toBe(DIGEST);
    expect(Buffer.from(await served.arrayBuffer()).equals(image)).toBe(true);

    const status = await handler(new Request("http://127.0.0.1/api/os/firmware/status"));
    const body = await status.json() as {
      image: { bytes: number; buildId: string; builtAt: number };
    };
    expect(body.image.bytes).toBe(image.byteLength);
    expect(body.image.buildId).toBe(DIGEST);
    // The console reads this as "when was this packed", to answer the only
    // question it can answer before the device reboots: is this the build I
    // just made. Fed straight into describeImageAge in web/src/lib/zos-link.ts.
    expect(body.image.builtAt).toBeGreaterThan(0);
    expect(body.image.builtAt).toBeLessThanOrEqual(Date.now());
    // The packer's output is the source when nobody has uploaded anything, and
    // it is named as such: 「这是我刚打的那一份」 and 「这是别人给我的文件」 are
    // different claims and the console must be able to tell them apart.
    const provenance = await (await handler(
      new Request("http://127.0.0.1/api/os/firmware/status"),
    )).json() as { source: { kind: string; fileName: string | null }; shadowedPacked: unknown };
    expect(provenance.source.kind).toBe("packed");
    expect(provenance.source.fileName).toBeNull();
    // Nothing is being shadowed: the packed image IS the armed one.
    expect(provenance.shadowedPacked).toBeNull();
  });

  // The route has no same-origin check — it is device-facing, and the device
  // sends no Origin — so the only thing keeping it from being a file server is
  // that the path is a constant from the composition root. Nothing on the URL
  // may reach it.
  test("nothing on the request can move the route off the packed image", async () => {
    const { handler, osFirmwarePath } = await firmwareHandler();
    await Bun.write(osFirmwarePath, zkswe(DIGEST));

    const steered = await handler(new Request(
      "http://127.0.0.1/api/os/firmware?path=/etc/passwd&app=../../etc/hosts",
    ));
    expect(steered.status).toBe(200);
    expect(steered.headers.get("X-Build-Id")).toBe(DIGEST);
    expect(new TextDecoder().decode(await steered.arrayBuffer())).toContain("res-filesystem");
  });

  test("an upgrade is refused while there is nothing to install", async () => {
    const { handler, osLink, osFirmwarePath } = await firmwareHandler();
    const origin = "http://127.0.0.1:43820";
    const ask = () => handler(new Request(`${origin}/api/os/upgrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    }));

    // 409, not 200: the sequence would reach the device, the device would fetch
    // /api/os/firmware, find a 404 and stop — and the console would be left
    // claiming an install that never started.
    const refused = await ask();
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toContain("packed");
    // Refused means refused: the document must not carry an upgrade the device
    // would honour once per boot for an image that does not exist.
    expect(osLink.getUpgradeSeq()).toBe(0);
    expect(osLink.serialize()).not.toContain("upgrade\t");

    await Bun.write(osFirmwarePath, zkswe(DIGEST));
    const accepted = await ask();
    expect(accepted.status).toBe(200);
    const { seq } = await accepted.json() as { seq: number };
    // Seconds-since-epoch, not a count. The firmware records the id it
    // installed on /data so a reboot does not read the still-standing request
    // as a new one; a counter restarting at 1 with this process would collide
    // with that record and the device could never be asked again.
    expect(seq).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
    expect(osLink.serialize().split("\n")).toContain(`upgrade\t${seq}`);

    // The console's only receipt between the click and a device that vanishes
    // for a minute to rewrite mtd3.
    const state = await handler(new Request(`${origin}/api/os/state`));
    expect((await state.json() as { upgradeSeq: number }).upgradeSeq).toBe(seq);

    // Two presses in the same second must still move forward, or the second
    // one is a request the device has already installed and will ignore.
    const again = await ask();
    expect((await again.json() as { seq: number }).seq).toBeGreaterThan(seq);
  });

  test("the console can ask the clock to open Bluetooth", async () => {
    const { handler, osLink } = await firmwareHandler();
    const origin = "http://127.0.0.1:43820";
    const ask = () => handler(new Request(`${origin}/api/os/ble`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    }));

    // NO PRECONDITION, unlike /api/os/upgrade's 409. That one refuses because a
    // request for an image nobody packed is a guaranteed disappointment; there
    // is nothing equivalent to be missing here, and a clock too offline to read
    // the request is a clock that is already advertising by itself.
    const accepted = await ask();
    expect(accepted.status).toBe(200);
    const { seq } = await accepted.json() as { seq: number };
    // Seconds-since-epoch, not a count: the device acts on an id HIGHER than the
    // last one it acted on this boot, so a counter restarting with this process
    // would hand a long-lived clock an id it has already honoured.
    expect(seq).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
    expect(osLink.getBleOpenSeq()).toBe(seq);
    expect(osLink.serialize().split("\n")).toContain(`bleopen\t${seq}`);

    // Pressing 开始配网 twice in one second must still move forward, or the
    // second press is an id the device has already acted on and ignores.
    const again = await ask();
    expect((await again.json() as { seq: number }).seq).toBeGreaterThan(seq);
  });

  // Opening a radio that is otherwise only reachable by standing in front of the
  // clock does not belong to another origin's page either.
  test("a cross-origin request to open Bluetooth is refused and moves nothing", async () => {
    const { handler, osLink } = await firmwareHandler();

    const crossOrigin = await handler(new Request("http://127.0.0.1:43820/api/os/ble", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: "{}",
    }));
    expect(crossOrigin.status).toBe(400);
    expect((await crossOrigin.json() as { error: string }).error).toContain("cross-origin");
    expect(osLink.getBleOpenSeq()).toBe(0);

    // JSON-only for the same reason: a form POST cannot set the header without a
    // preflight the browser will not send.
    const formPost = await handler(new Request("http://127.0.0.1:43820/api/os/ble", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "http://127.0.0.1:43820" },
      body: "{}",
    }));
    expect(formPost.status).toBe(400);
    expect(osLink.getBleOpenSeq()).toBe(0);
    expect(osLink.serialize()).not.toContain("bleopen");
  });

  // --- the owner's own image ------------------------------------------------
  //
  // Before this route existed, the only image the console could install was
  // whatever `mise run os-image` last packed — a developer's button rather than
  // a feature. Uploading turns it into one, and everything below exists to keep
  // the two claims apart: "this file arrived intact" and "this is the build I
  // meant". Only the owner can make the second one, and only by pressing 安装.

  const ORIGIN = "http://127.0.0.1:43820";

  /** A container that actually passes the validator, unlike `zkswe()` above. */
  async function realImage(type = 3, mark = 0x5a): Promise<Buffer> {
    const { packContainer } = await import("../device/tc002-os/release/zkswe-image.ts");
    const image = Buffer.alloc(8192, mark);
    image.writeUInt32LE(0x73717368, 0); // squashfs magic
    image.writeUInt32LE(1_780_910_006, 8); // mkfs time
    return packContainer(image, type);
  }

  function uploadRequest(bytes: Buffer, fileName = "zos-update.img"): Request {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], fileName));
    return new Request(`${ORIGIN}/api/os/firmware`, {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: form,
    });
  }

  test("an uploaded image is armed, described by its own bytes, and served to the device", async () => {
    const { handler, osFirmwarePath } = await firmwareHandler();
    const bytes = await realImage();

    const uploaded = await handler(uploadRequest(bytes, "zos-2026.08.15.img"));
    expect(uploaded.status).toBe(200);
    const body = await uploaded.json() as {
      packed: boolean;
      image: {
        bytes: number;
        md5: string;
        partitionType: number;
        partitionLabel: string;
        zosBuildId: string | null;
      };
      source: { kind: string; fileName: string; at: number };
    };

    // The answer is the same document the status route serves, so the console
    // shows what ARRIVED rather than what it believes it sent.
    expect(body.packed).toBe(true);
    expect(body.image.bytes).toBe(bytes.byteLength);
    expect(body.image.md5).toBe(createHash("md5").update(bytes).digest("hex"));
    expect(body.image.partitionType).toBe(3);
    expect(body.image.partitionLabel).toBe("res");
    // Not recoverable through xz, and therefore null — which the console renders
    // as 未知. An invented version here would be read as a real one.
    expect(body.image.zosBuildId).toBeNull();
    expect(body.source.kind).toBe("upload");
    expect(body.source.fileName).toBe("zos-2026.08.15.img");

    // The device gets the uploaded bytes, and gets them under the digest its own
    // updater verifies rather than the one the console displays.
    const served = await handler(new Request("http://127.0.0.1/api/os/firmware"));
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);

    // And it did NOT land on the packer's path: that file is a different
    // writer's, and this route must never be able to overwrite it.
    expect(await Bun.file(osFirmwarePath).exists()).toBe(false);
  });

  // THE SEPARATION. Uploading is not installing: the second act erases mtd3, a
  // partition with no A/B pair and no recovery slot, and it happens only when a
  // human presses the button.
  test("an upload does not arm an install by itself", async () => {
    const { handler, osLink } = await firmwareHandler();

    const uploaded = await handler(uploadRequest(await realImage()));
    expect(uploaded.status).toBe(200);

    // Nothing was asked of the device: no sequence, and nothing in the document
    // the firmware polls. A clock that read an upgrade line here would fetch the
    // image and rewrite its own flash because somebody picked a file.
    expect(osLink.getUpgradeSeq()).toBe(0);
    expect(osLink.serialize()).not.toContain("upgrade\t");

    const state = await handler(new Request(`${ORIGIN}/api/os/state`));
    expect((await state.json() as { upgradeSeq: number }).upgradeSeq).toBe(0);

    // The install is still available — it just has to be asked for.
    const asked = await handler(new Request(`${ORIGIN}/api/os/upgrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: "{}",
    }));
    expect(asked.status).toBe(200);
    expect(osLink.getUpgradeSeq()).toBeGreaterThan(0);
  });

  // The failure this whole storage scheme exists to prevent: `mise run os-image`
  // runs on every build, and a naive upload-into-that-path would mean the next
  // build silently becomes the image the owner "chose".
  test("a later local pack cannot replace the uploaded image, and is reported as shadowed", async () => {
    const { handler, osFirmwarePath } = await firmwareHandler();
    const uploaded = await realImage(3, 0x11);
    await handler(uploadRequest(uploaded, "mine.img"));

    // Somebody packs locally afterwards.
    const packed = zkswe(DIGEST);
    await Bun.write(osFirmwarePath, packed);

    const served = await handler(new Request("http://127.0.0.1/api/os/firmware"));
    expect(Buffer.from(await served.arrayBuffer()).equals(uploaded)).toBe(true);

    const status = await (await handler(
      new Request("http://127.0.0.1/api/os/firmware/status"),
    )).json() as {
      source: { kind: string; fileName: string };
      shadowedPacked: { bytes: number; builtAt: number } | null;
    };
    expect(status.source.kind).toBe("upload");
    expect(status.source.fileName).toBe("mine.img");
    // Not silently ignored — named, with its size, so the person who just ran
    // the packer can see that their build is on disk and is not the one armed.
    expect(status.shadowedPacked?.bytes).toBe(packed.byteLength);

    // And the way back is in the console rather than only in a shell.
    const removed = await handler(new Request(`${ORIGIN}/api/os/firmware`, {
      method: "DELETE",
      headers: { Origin: ORIGIN },
    }));
    expect(removed.status).toBe(200);
    const after = await removed.json() as {
      removed: boolean;
      source: { kind: string };
      shadowedPacked: unknown;
    };
    expect(after.removed).toBe(true);
    expect(after.source.kind).toBe("packed");
    expect(after.shadowedPacked).toBeNull();
    const back = await handler(new Request("http://127.0.0.1/api/os/firmware"));
    expect(Buffer.from(await back.arrayBuffer()).equals(packed)).toBe(true);
  });

  // The refusal that is not about a broken file. This container is perfect in
  // every other way; the updater is a bitmask over partition type and would do
  // exactly what it says. That is not a failed install, it is a brick.
  test("an image aimed at a partition other than res is refused, and arms nothing", async () => {
    const { handler } = await firmwareHandler();

    const refused = await handler(uploadRequest(await realImage(1), "boot.img"));
    expect(refused.status).toBe(400);
    const body = await refused.json() as { error: string; reason: string };
    expect(body.reason).toBe("partition");
    expect(body.error).toContain("boot");
    expect(body.error).toContain("res");

    // Nothing armed, so nothing to install and nothing to serve.
    const status = await (await handler(
      new Request("http://127.0.0.1/api/os/firmware/status"),
    )).json() as { packed: boolean };
    expect(status.packed).toBe(false);
    expect((await handler(new Request("http://127.0.0.1/api/os/firmware"))).status).toBe(404);
  });

  test("a damaged or oversized upload is refused, and the armed image is left alone", async () => {
    const { handler } = await firmwareHandler();
    const good = await realImage(3, 0x22);
    await handler(uploadRequest(good, "good.img"));

    // Not a container at all.
    const notAnImage = await handler(uploadRequest(Buffer.alloc(9000, 0x99), "holiday.jpg"));
    expect(notAnImage.status).toBe(400);
    expect((await notAnImage.json() as { reason: string }).reason).toBe("magic");

    // A container that arrived damaged: header intact, payload digest moved.
    const damaged = Buffer.from(await realImage(3, 0x33));
    damaged[damaged.length - 32] = damaged[damaged.length - 32]! ^ 0xff;
    const corrupt = await handler(uploadRequest(damaged, "truncated.img"));
    expect(corrupt.status).toBe(400);
    expect((await corrupt.json() as { reason: string }).reason).toBe("digest");

    // Too big for mtd3, refused on the declared length before the body is read.
    const huge = await handler(new Request(`${ORIGIN}/api/os/firmware`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "multipart/form-data; boundary=x",
        "Content-Length": String(64 * 1024 * 1024),
      },
      body: "--x--",
    }));
    expect(huge.status).toBe(413);

    // Three refusals, and the image armed before them is still the armed one:
    // a rejected upload must not leave the clock with nothing to install.
    const served = await handler(new Request("http://127.0.0.1/api/os/firmware"));
    expect(Buffer.from(await served.arrayBuffer()).equals(good)).toBe(true);
  });

  // Same reasoning as the upgrade below: arming the image a clock will write to
  // flash does not belong to another origin's page either.
  test("a cross-origin upload or removal is refused and moves nothing", async () => {
    const { handler } = await firmwareHandler();
    const bytes = await realImage();

    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], "evil.img"));
    const crossOrigin = await handler(new Request(`${ORIGIN}/api/os/firmware`, {
      method: "POST",
      headers: { Origin: "http://evil.example" },
      body: form,
    }));
    expect(crossOrigin.status).toBe(400);
    expect((await crossOrigin.json() as { error: string }).error).toContain("cross-origin");

    await handler(uploadRequest(bytes));
    const crossDelete = await handler(new Request(`${ORIGIN}/api/os/firmware`, {
      method: "DELETE",
      headers: { Origin: "http://evil.example" },
    }));
    expect(crossDelete.status).toBe(400);
    expect((await handler(new Request("http://127.0.0.1/api/os/firmware"))).status).toBe(200);
  });

  // Flashing a partition with no recovery slot behind it is the last thing that
  // should be reachable from another origin's page.
  test("a cross-origin upgrade is refused and moves nothing", async () => {
    const { handler, osLink, osFirmwarePath } = await firmwareHandler();
    await Bun.write(osFirmwarePath, zkswe(DIGEST));

    const crossOrigin = await handler(new Request("http://127.0.0.1:43820/api/os/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: "{}",
    }));
    expect(crossOrigin.status).toBe(400);
    expect((await crossOrigin.json() as { error: string }).error).toContain("cross-origin");
    expect(osLink.getUpgradeSeq()).toBe(0);

    // JSON-only for the same reason, since a form POST cannot set the header
    // without a preflight the browser will not send.
    const formPost = await handler(new Request("http://127.0.0.1:43820/api/os/upgrade", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "http://127.0.0.1:43820" },
      body: "{}",
    }));
    expect(formPost.status).toBe(400);
    expect(osLink.getUpgradeSeq()).toBe(0);
  });
});

describe("vibe usage routes", () => {
  const ORIGIN = "http://127.0.0.1:43820";

  function fakeSnapshot(): VibeUsageSnapshot {
    return {
      fetchedAt: "2026-08-14T09:00:00.000Z",
      generatedAt: "2026-08-14T08:59:58.000Z",
      providers: [{
        id: "claude",
        displayName: "Claude",
        plan: "max",
        fetchedAt: "2026-08-14T09:00:00.000Z",
        stale: false,
        metrics: [{
          key: "session",
          label: "Session",
          kind: "consumption",
          unit: "percent",
          utilization: 0.42,
        }],
        spendLines: [{ label: "Today", value: "$1.20" }],
      }],
      errors: [],
    };
  }

  // The real VibeStore behind the option, so the PUT rejections under test are
  // the ones production actually raises rather than a stub's own opinion. Only
  // `status` is faked — it is the half that talks to the vendors.
  async function vibeOption(status: {
    snapshot?: VibeUsageSnapshot | null;
    error?: string | null;
  } = {}) {
    const { VibeStore } = await import("../src/vibe/vibe-store.ts");
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-control-vibe-"));
    directories.push(directory);
    const store = new VibeStore(join(directory, "vibe.json"));
    await store.load();
    const refreshCalls: boolean[] = [];
    return {
      store,
      refreshCalls,
      option: {
        status: async (refresh: boolean) => {
          refreshCalls.push(refresh);
          return {
            // Empty: all four agents borrow a CLI login, so no vendor takes a key.
            starred: store.getStarred(),
            snapshot: status.snapshot === undefined ? fakeSnapshot() : status.snapshot,
            error: status.error ?? null,
          };
        },
        setStarred: (providerId: string, starred: unknown) => store.setStarred(providerId, starred),
        setKey: async () => {},
      },
    };
  }

  test("status carries the whole catalog, the starred defaults, and the snapshot", async () => {
    const { option, refreshCalls } = await vibeOption();
    const handler = createControlHandler(fakeWorkspaceController(), { vibe: option });

    const response = await handler(new Request(`${ORIGIN}/api/vibe/status`));
    expect(response.status).toBe(200);
    const body = await response.json();

    // The GUI renders the catalog itself, so the route must ship all four
    // providers in the catalog's own order — not just the ones that answered
    // for (the snapshot here only carries claude).
    expect(body.catalog).toHaveLength(4);
    expect(body.catalog.map((entry: { id: string }) => entry.id)).toEqual([
      "claude", "codex", "grok", "opencode",
    ]);
    expect(body.catalog.map((entry: { order: number }) => entry.order))
      .toEqual([1, 2, 3, 4]);
    expect(body.catalog[0]).toEqual({
      id: "claude",
      displayName: "Claude",
      order: 1,
      percentKeys: ["session", "weekly", "sonnet", "fable"],
      defaultStarred: ["session", "weekly"],
      metricLabels: {
        session: "Session",
        weekly: "Weekly",
        sonnet: "Sonnet",
        fable: "Fable",
        extraUsage: "Extra Usage",
      },
    });

    // A fresh store has pinned nothing, so every provider reports the catalog
    // default — the table is complete rather than empty.
    expect(Object.keys(body.starred)).toHaveLength(4);
    expect(body.starred.claude).toEqual(["session", "weekly"]);
    expect(body.starred.grok).toEqual(["weekly"]);
    // baseUrl is gone with the third-party app; what the console needs now is
    // which key-based vendors have a key, never the key itself — and all four
    // agents borrow a CLI login, so no vendor takes a key today.
    // No `keys` envelope any more: the whole API-key feature existed for
    // openrouter and z.ai alone, and both are gone. All four survivors borrow a
    // CLI login, so there was nothing left for it to hold.
    expect(body).not.toHaveProperty("keys");
    expect(body.error).toBeNull();
    expect(body.snapshot.providers[0].metrics[0].key).toBe("session");

    // ?refresh=1 is the console's "重新读取" button; anything else must use the
    // cache, or a chart that repaints on focus would hammer the vendors.
    await handler(new Request(`${ORIGIN}/api/vibe/status?refresh=1`));
    await handler(new Request(`${ORIGIN}/api/vibe/status?refresh=0`));
    expect(refreshCalls).toEqual([false, true, false]);
  });

  test("nothing signed in is a 200 carrying the reason, not an error status", async () => {
    const { option } = await vibeOption({
      snapshot: null,
      error: "no AI coding agent is signed in on this machine",
    });
    const handler = createControlHandler(fakeWorkspaceController(), { vibe: option });

    const response = await handler(new Request(`${ORIGIN}/api/vibe/status`));
    // The console shows its install guide off this shape; a 503 would surface as
    // an error toast and hide the one instruction that fixes it.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.snapshot).toBeNull();
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("signed in");
    // The catalog and the stars still render with nothing signed in.
    expect(body.catalog).toHaveLength(4);
    expect(body.starred.claude).toEqual(["session", "weekly"]);
  });

  test("starring a provider echoes the merged table and leaves the others on defaults", async () => {
    const { option, store } = await vibeOption();
    const handler = createControlHandler(fakeWorkspaceController(), { vibe: option });

    const response = await handler(new Request(`${ORIGIN}/api/vibe/starred`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ providerId: "claude", starred: ["weekly", "sonnet"] }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.starred.claude).toEqual(["weekly", "sonnet"]);
    expect(body.starred.codex).toEqual(["session", "weekly"]);
    expect(Object.keys(body.starred)).toHaveLength(4);

    // Emptying a provider is a legal state, not a reset to the default: the
    // menu-bar strip is allowed to drop a provider entirely.
    const cleared = await handler(new Request(`${ORIGIN}/api/vibe/starred`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ providerId: "claude", starred: [] }),
    }));
    expect((await cleared.json()).starred.claude).toEqual([]);
    await store.settled();
  });

  test("rejects a third star, an unknown provider, and a cross-origin write", async () => {
    const { option } = await vibeOption();
    const handler = createControlHandler(fakeWorkspaceController(), { vibe: option });

    // Two pins per provider is the LED格 budget as much as OpenUsage's rule.
    const tooMany = await handler(new Request(`${ORIGIN}/api/vibe/starred`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ providerId: "claude", starred: ["session", "weekly", "sonnet"] }),
    }));
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error).toContain("at most 2");

    const unknown = await handler(new Request(`${ORIGIN}/api/vibe/starred`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ providerId: "notaprovider", starred: ["session"] }),
    }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("unknown vibe provider");

    const missingProvider = await handler(new Request(`${ORIGIN}/api/vibe/starred`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ starred: ["session"] }),
    }));
    expect(missingProvider.status).toBe(400);
    expect((await missingProvider.json()).error).toContain("providerId is required");

    const crossOrigin = await handler(new Request(`${ORIGIN}/api/vibe/starred`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ providerId: "claude", starred: ["session"] }),
    }));
    expect(crossOrigin.status).toBe(400);
    expect((await crossOrigin.json()).error).toContain("cross-origin");
  });

  test("both routes 404 when the vibe option is not wired", async () => {
    const handler = createControlHandler(fakeWorkspaceController());

    const status = await handler(new Request(`${ORIGIN}/api/vibe/status`));
    expect(status.status).toBe(404);
    expect((await status.json()).error).toContain("vibe usage is unavailable");

    // The 404 has to come before the same-origin check, or a console probing a
    // service without the collector would read "cross-origin" for a missing feature.
    const starred = await handler(new Request(`${ORIGIN}/api/vibe/starred`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ providerId: "claude", starred: ["session"] }),
    }));
    expect(starred.status).toBe(404);
    expect((await starred.json()).error).toContain("vibe usage is unavailable");
  });
});
