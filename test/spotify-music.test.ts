import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MusicServiceError } from "../src/music/core.ts";
import {
  SpotifyAppStore,
  SpotifyMusicService,
  SpotifySessionStore,
} from "../src/music/spotify.ts";

const CLIENT_ID = "0123456789abcdef0123456789abcdef";
const REDIRECT_URI = "http://127.0.0.1:43820/api/music/spotify/callback";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function stores(): Promise<{
  appStore: SpotifyAppStore;
  sessionStore: SpotifySessionStore;
  sessionPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "tc002-spotify-"));
  directories.push(directory);
  return {
    appStore: new SpotifyAppStore(join(directory, "app.json")),
    sessionStore: new SpotifySessionStore(join(directory, "session.json")),
    sessionPath: join(directory, "session.json"),
  };
}

interface Call {
  method: string;
  url: URL;
  body: string;
  headers: Headers;
}

// A fetch stand-in that records every call and answers by path prefix.
function recordingFetch(
  routes: Array<[string, (call: Call) => Response]>,
): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : "",
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const key = `${url.origin}${url.pathname}`;
    // Longest prefix wins: /v1/me must not swallow /v1/me/player.
    const route = [...routes]
      .sort((a, b) => b[0].length - a[0].length)
      .find(([prefix]) => key === prefix || key.startsWith(prefix));
    if (!route) return new Response(JSON.stringify({ error: { message: "unrouted" } }), { status: 500 });
    return route[1](call);
  }) as typeof fetch;
  return { fetcher, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

const TOKEN_ROUTE: [string, (call: Call) => Response] = [
  "https://accounts.spotify.com/api/token",
  () => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
];

const ME_ROUTE: [string, (call: Call) => Response] = [
  "https://api.spotify.com/v1/me",
  () => json({
    id: "pixel-listener",
    display_name: "像素听众",
    product: "premium",
    country: "SG",
    images: [{ url: "https://i.scdn.co/image/avatar" }],
  }),
];

async function signedInService(
  routes: Array<[string, (call: Call) => Response]>,
  overrides: { now?: () => number } = {},
): Promise<{ service: SpotifyMusicService; calls: Call[]; sessionPath: string }> {
  const { appStore, sessionStore, sessionPath } = await stores();
  await appStore.save(CLIENT_ID);
  const { fetcher, calls } = recordingFetch([TOKEN_ROUTE, ME_ROUTE, ...routes]);
  const service = new SpotifyMusicService({
    appStore,
    sessionStore,
    redirectUri: REDIRECT_URI,
    lyrics: { lyrics: async () => [] },
    fetcher,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  await service.initialize();
  const login = service.beginLogin();
  const state = new URL(login.authorizeUrl).searchParams.get("state")!;
  await service.completeLogin({ code: "auth-code", state });
  calls.length = 0;
  return { service, calls, sessionPath };
}

describe("Spotify music service", () => {
  test("mints a PKCE challenge and keeps the refresh token off the wire", async () => {
    const { appStore, sessionStore, sessionPath } = await stores();
    await appStore.save(CLIENT_ID);
    const { fetcher, calls } = recordingFetch([TOKEN_ROUTE, ME_ROUTE]);
    const service = new SpotifyMusicService({
      appStore,
      sessionStore,
      redirectUri: REDIRECT_URI,
      lyrics: { lyrics: async () => [] },
      fetcher,
    });
    await service.initialize();
    expect(service.status()).toEqual({ loggedIn: false });
    expect(service.appStatus()).toEqual({
      configured: true,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });

    const login = service.beginLogin();
    const authorize = new URL(login.authorizeUrl);
    expect(authorize.origin).toBe("https://accounts.spotify.com");
    expect(authorize.pathname).toBe("/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const scopes = (authorize.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toContain("user-modify-playback-state");
    expect(scopes).toContain("user-read-playback-state");
    // Playback stays on the user's own Spotify clients, so the studio never asks
    // for the in-browser playback scope or their email address.
    expect(scopes).not.toContain("streaming");
    expect(scopes).not.toContain("user-read-email");

    const profile = await service.completeLogin({
      code: "auth-code",
      state: authorize.searchParams.get("state")!,
    });
    expect(profile).toEqual({
      provider: "spotify",
      id: "pixel-listener",
      nickname: "像素听众",
      avatarUrl: "https://i.scdn.co/image/avatar",
      plan: "premium",
    });
    expect(JSON.stringify(profile)).not.toContain("refresh-1");

    // The verifier that reached Spotify must hash to the challenge we published.
    const tokenCall = calls.find((call) => call.url.pathname === "/api/token")!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"))
      .toBe(authorize.searchParams.get("code_challenge")!);

    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(sessionPath, "utf8")).toContain("refresh-1");

    const restored = new SpotifyMusicService({
      appStore,
      sessionStore,
      redirectUri: REDIRECT_URI,
      lyrics: { lyrics: async () => [] },
      fetcher,
    });
    await restored.initialize();
    expect(restored.status().profile?.nickname).toBe("像素听众");
  });

  test("rejects a callback whose state was never issued", async () => {
    const { appStore, sessionStore } = await stores();
    await appStore.save(CLIENT_ID);
    const { fetcher } = recordingFetch([TOKEN_ROUTE, ME_ROUTE]);
    const service = new SpotifyMusicService({
      appStore,
      sessionStore,
      redirectUri: REDIRECT_URI,
      lyrics: { lyrics: async () => [] },
      fetcher,
    });
    await service.initialize();
    service.beginLogin();
    await expect(service.completeLogin({ code: "auth-code", state: "forged" }))
      .rejects.toBeInstanceOf(MusicServiceError);
  });

  test("refreshes silently and keeps the old refresh token when Spotify omits one", async () => {
    let clock = 1_000_000;
    const { service, calls } = await signedInService(
      [
        [
          "https://api.spotify.com/v1/search",
          () => json({ tracks: { items: [] } }),
        ],
      ],
      { now: () => clock },
    );
    // Past the stored access token's lifetime.
    clock += 4_000_000;

    await service.search("midnight");
    const refresh = calls.find((call) => call.url.pathname === "/api/token")!;
    const form = new URLSearchParams(refresh.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");

    const search = calls.find((call) => call.url.pathname === "/v1/search")!;
    expect(search.headers.get("Authorization")).toBe("Bearer access-1");
    expect(service.status().loggedIn).toBe(true);
  });

  test("shares one token refresh across concurrent requests", async () => {
    let clock = 1_000_000;
    const { service, calls, sessionPath } = await signedInService(
      [
        ["https://api.spotify.com/v1/search", () => json({ tracks: { items: [] } })],
        ["https://api.spotify.com/v1/me/playlists", () => json({ items: [] })],
        ["https://api.spotify.com/v1/me/tracks", () => json({ items: [], total: 0 })],
      ],
      { now: () => clock },
    );
    clock += 4_000_000; // 令牌过期

    // 打开音乐页就是这个形状：几个请求同时出发，全都发现令牌过期了。
    await Promise.all([
      service.search("midnight"),
      service.playlists(),
      service.search("aurora"),
    ]);

    // 只能刷新一次。刷新两次的话，Spotify 轮换 refresh token 后第二次就带着作废的
    // 旧令牌去换，登录会莫名其妙掉线；而且两次刷新会同时去写 session 文件。
    const refreshes = calls.filter((call) => call.url.pathname === "/api/token");
    expect(refreshes).toHaveLength(1);

    // session 文件必须完好落盘——并发写曾经因为 tmp 名撞车而报 ENOENT。
    const stored = JSON.parse(await readFile(sessionPath, "utf8")) as { accessToken: string };
    expect(stored.accessToken).toBe("access-1");
    expect(service.status().loggedIn).toBe(true);
  });

  test("signs out when Spotify rejects the refresh token for good", async () => {
    let clock = 1_000_000;
    const { appStore, sessionStore } = await stores();
    await appStore.save(CLIENT_ID);
    let tokenCalls = 0;
    const { fetcher } = recordingFetch([
      ["https://accounts.spotify.com/api/token", () => {
        tokenCalls += 1;
        return tokenCalls === 1
          ? json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })
          : json({ error: "invalid_grant", error_description: "Refresh token revoked" }, { status: 400 });
      }],
      ME_ROUTE,
    ]);
    const service = new SpotifyMusicService({
      appStore,
      sessionStore,
      redirectUri: REDIRECT_URI,
      lyrics: { lyrics: async () => [] },
      fetcher,
      now: () => clock,
    });
    await service.initialize();
    const login = service.beginLogin();
    await service.completeLogin({
      code: "auth-code",
      state: new URL(login.authorizeUrl).searchParams.get("state")!,
    });
    clock += 4_000_000;

    await expect(service.search("midnight")).rejects.toThrow("Spotify 登录已失效，请重新登录");
    expect(service.status()).toEqual({ loggedIn: false });
  });

  test("normalizes tracks and drops podcast rows", async () => {
    const { service } = await signedInService([
      ["https://api.spotify.com/v1/search", () => json({
        tracks: {
          items: [
            {
              type: "track",
              id: "4uLU6hMCjMI75M1A2tKUQC",
              name: "Never Gonna Give You Up",
              duration_ms: 213_000,
              artists: [{ name: "Rick Astley" }],
              album: {
                name: "Whenever You Need Somebody",
                images: [{ url: "https://i.scdn.co/image/cover" }],
              },
            },
            { type: "episode", id: "ep1", name: "A podcast", duration_ms: 60_000 },
            { type: "track", id: "", name: "local file", duration_ms: 1_000 },
          ],
        },
      })],
    ]);

    expect(await service.search("rick")).toEqual([{
      id: "4uLU6hMCjMI75M1A2tKUQC",
      title: "Never Gonna Give You Up",
      artists: ["Rick Astley"],
      album: "Whenever You Need Somebody",
      durationMs: 213_000,
      coverUrl: "https://i.scdn.co/image/cover",
    }]);
  });

  test("puts liked songs first and counts playlist tracks", async () => {
    const { service } = await signedInService([
      ["https://api.spotify.com/v1/me/playlists", () => json({
        items: [{
          id: "37i9dQZF1DXcBWIGoYBM5M",
          name: "Today's Top Hits",
          tracks: { total: 50 },
          images: [{ url: "https://i.scdn.co/image/list" }],
        }],
      })],
      ["https://api.spotify.com/v1/me/tracks", () => json({ total: 128, items: [] })],
    ]);

    expect(await service.playlists()).toEqual([
      { id: "liked", name: "喜欢的音乐", trackCount: 128 },
      {
        id: "37i9dQZF1DXcBWIGoYBM5M",
        name: "Today's Top Hits",
        trackCount: 50,
        coverUrl: "https://i.scdn.co/image/list",
      },
    ]);
  });

  test("drives Spotify Connect and re-reads the player after each command", async () => {
    let playing = false;
    const { service, calls } = await signedInService([
      ["https://api.spotify.com/v1/me/player/play", () => {
        playing = true;
        return new Response(null, { status: 204 });
      }],
      ["https://api.spotify.com/v1/me/player/devices", () => json({
        devices: [{ id: "device-1", name: "厨房音箱", type: "Speaker", is_active: true, volume_percent: 40 }],
      })],
      ["https://api.spotify.com/v1/me/player", () => json({
        is_playing: playing,
        progress_ms: 42_000,
        device: { id: "device-1", name: "厨房音箱", volume_percent: 40 },
        item: { type: "track", id: "4uLU6hMCjMI75M1A2tKUQC", duration_ms: 213_000 },
      })],
    ]);

    const before = await service.remote.snapshot();
    expect(before.playing).toBe(false);
    expect(before.trackId).toBe("4uLU6hMCjMI75M1A2tKUQC");
    expect(before.positionMs).toBe(42_000);
    expect(before.deviceName).toBe("厨房音箱");

    await service.remote.play({ trackId: "4uLU6hMCjMI75M1A2tKUQC" });
    const playCall = calls.find((call) => call.url.pathname === "/v1/me/player/play")!;
    expect(playCall.method).toBe("PUT");
    expect(JSON.parse(playCall.body)).toEqual({
      uris: ["spotify:track:4uLU6hMCjMI75M1A2tKUQC"],
    });

    // A command invalidates the cache, so the very next read is fresh.
    expect((await service.remote.snapshot()).playing).toBe(true);

    expect(await service.remote.devices()).toEqual([{
      id: "device-1",
      name: "厨房音箱",
      type: "Speaker",
      active: true,
      volumePercent: 40,
    }]);

    await service.remote.transfer("device1", false);
    const transfer = calls.find((call) =>
      call.url.pathname === "/v1/me/player" && call.method === "PUT"
    )!;
    expect(JSON.parse(transfer.body)).toEqual({ device_ids: ["device1"], play: false });
  });

  test("accepts a bare command id from player endpoints instead of JSON", async () => {
    // Spotify answers pause/next/previous with either 204 or 200 carrying an
    // opaque command id — never JSON. Parsing it as JSON surfaced a bogus
    // "unparseable content" error on every pause.
    const { service } = await signedInService([
      ["https://api.spotify.com/v1/me/player/pause", () =>
        new Response("qdhGR4Pmsq611jvG82QZEWiDXAk", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })],
      ["https://api.spotify.com/v1/me/player/next", () =>
        new Response("", { status: 204 })],
      ["https://api.spotify.com/v1/me/player", () => new Response(null, { status: 204 })],
    ]);

    await service.remote.pause();
    await service.remote.next();
  });

  test("treats a no-op transport restriction as success, not a failure", async () => {
    const { service } = await signedInService([
      // Pausing an already-paused player: Spotify says no, the user does not care.
      ["https://api.spotify.com/v1/me/player/pause", () => json(
        { error: { status: 403, message: "Player command failed: Restriction violated", reason: "UNKNOWN" } },
        { status: 403 },
      )],
      // A genuine Premium refusal must still reach the user.
      ["https://api.spotify.com/v1/me/player/next", () => json(
        { error: { status: 403, message: "Player command failed: Premium required", reason: "PREMIUM_REQUIRED" } },
        { status: 403 },
      )],
      ["https://api.spotify.com/v1/me/player", () => new Response(null, { status: 204 })],
    ]);

    await service.remote.pause();
    await expect(service.remote.next()).rejects.toThrow("Premium");
  });

  test("serves the last good snapshot when the player read fails", async () => {
    let healthy = true;
    const { service } = await signedInService([
      ["https://api.spotify.com/v1/me/player", () => healthy
        ? json({
          is_playing: true,
          progress_ms: 1_000,
          item: { type: "track", id: "4uLU6hMCjMI75M1A2tKUQC", duration_ms: 213_000 },
        })
        : new Response("nope", { status: 500 })],
    ]);

    const first = await service.remote.snapshot();
    expect(first.trackId).toBe("4uLU6hMCjMI75M1A2tKUQC");
    healthy = false;
    expect((await service.remote.snapshot(true)).trackId).toBe("4uLU6hMCjMI75M1A2tKUQC");
  });

  test("turns Spotify player failures into answers the user can act on", async () => {
    const { service } = await signedInService([
      ["https://api.spotify.com/v1/me/player/next", () => json(
        { error: { status: 403, message: "Player command failed: Premium required", reason: "PREMIUM_REQUIRED" } },
        { status: 403 },
      )],
      ["https://api.spotify.com/v1/me/player/previous", () => json(
        { error: { status: 404, message: "Player command failed: No active device found", reason: "NO_ACTIVE_DEVICE" } },
        { status: 404 },
      )],
      ["https://api.spotify.com/v1/me/player/pause", () => new Response("", {
        status: 429,
        headers: { "Retry-After": "12" },
      })],
    ]);

    await expect(service.remote.next()).rejects.toThrow("Premium");
    await expect(service.remote.previous()).rejects.toThrow("没有正在活动的 Spotify 播放设备");
    await expect(service.remote.pause()).rejects.toThrow("12 秒后重试");
  });

  test("proxies the avatar only from Spotify's own image hosts", async () => {
    const { service } = await signedInService([
      ["https://i.scdn.co/image", () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { "Content-Type": "image/jpeg", "Content-Length": "4" },
      })],
    ]);

    const response = await service.avatar();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    const { appStore, sessionStore } = await stores();
    await appStore.save(CLIENT_ID);
    await sessionStore.save({
      version: 1,
      refreshToken: "refresh-1",
      profile: {
        provider: "spotify",
        id: "pixel-listener",
        nickname: "像素听众",
        avatarUrl: "https://evil.example/avatar.jpg",
      },
    });
    const untrusted = new SpotifyMusicService({
      appStore,
      sessionStore,
      redirectUri: REDIRECT_URI,
      lyrics: { lyrics: async () => [] },
    });
    await untrusted.initialize();
    await expect(untrusted.avatar()).rejects.toBeInstanceOf(MusicServiceError);
  });

  test("refuses to start a login before the Client ID is configured", async () => {
    const { appStore, sessionStore } = await stores();
    const service = new SpotifyMusicService({
      appStore,
      sessionStore,
      redirectUri: REDIRECT_URI,
      lyrics: { lyrics: async () => [] },
    });
    await service.initialize();
    expect(service.appStatus().configured).toBe(false);
    expect(() => service.beginLogin()).toThrow("Client ID");
    await expect(service.saveApp("not-a-client-id")).rejects.toBeInstanceOf(MusicServiceError);
  });
});
