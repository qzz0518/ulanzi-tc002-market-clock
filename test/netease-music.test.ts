import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MusicServiceError,
  MusicSessionStore,
  NeteaseMusicService,
  type NeteaseGateway,
} from "../src/netease-music.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function sessionStore(): Promise<{ store: MusicSessionStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "tc002-music-"));
  directories.push(directory);
  const path = join(directory, "session.json");
  return { store: new MusicSessionStore(path), path };
}

function fakeGateway(overrides: Partial<NeteaseGateway> = {}): NeteaseGateway {
  return {
    loginQrKey: async () => ({ body: { data: { unikey: "qr-key" } } }),
    loginQrCreate: async () => ({
      body: { data: { qrurl: "https://music.163.com/login?codekey=qr-key" } },
    }),
    loginQrCheck: async () => ({ body: { code: 801 } }),
    userAccount: async () => ({
      body: { profile: { userId: 42, nickname: "像素听众", avatarUrl: "https://p1.music.126.net/avatar.jpg" } },
    }),
    userPlaylists: async () => ({ body: { playlist: [] } }),
    playlistTracks: async () => ({ body: { songs: [] } }),
    search: async () => ({ body: { result: { songs: [] } } }),
    songDetail: async () => ({ body: { songs: [] } }),
    lyric: async () => ({ body: {} }),
    songUrl: async () => ({ body: { data: [] } }),
    ...overrides,
  };
}

describe("NetEase music service", () => {
  test("keeps QR cookies on the server and restores the protected session", async () => {
    const { store, path } = await sessionStore();
    let qrCode = 801;
    const gateway = fakeGateway({
      loginQrCheck: async () => ({
        body: qrCode === 803
          ? { code: 803, cookie: "MUSIC_U=secret-value; os=pc" }
          : { code: qrCode },
      }),
    });
    const service = new NeteaseMusicService({ gateway, sessionStore: store });
    await service.initialize();
    expect(service.status()).toEqual({ loggedIn: false });

    const login = await service.createQrLogin();
    expect(login.qrUrl).toBe("https://music.163.com/login?codekey=qr-key");
    expect(await service.checkQrLogin(login.id)).toEqual({ state: "waiting" });

    qrCode = 802;
    expect(await service.checkQrLogin(login.id)).toEqual({ state: "scanned" });
    qrCode = 803;
    const confirmed = await service.checkQrLogin(login.id);
    expect(confirmed).toEqual({
      state: "confirmed",
      profile: {
        provider: "netease",
        id: "42",
        nickname: "像素听众",
        avatarUrl: "https://p1.music.126.net/avatar.jpg",
      },
    });
    expect(JSON.stringify(confirmed)).not.toContain("MUSIC_U");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const restored = new NeteaseMusicService({ gateway, sessionStore: store });
    await restored.initialize();
    expect(restored.status().profile?.nickname).toBe("像素听众");
  });

  test("normalizes search results and line-synchronized lyrics", async () => {
    const { store } = await sessionStore();
    const song = {
      id: 123,
      name: "夜航",
      ar: [{ name: "像素乐队" }],
      al: { name: "十六行", picUrl: "https://p.example/cover.jpg" },
      dt: 5_000,
    };
    const service = new NeteaseMusicService({
      sessionStore: store,
      gateway: fakeGateway({
        search: async () => ({ body: { result: { songs: [song] } } }),
        songDetail: async () => ({ body: { songs: [song] } }),
        lyric: async () => ({
          body: {
            lrc: { lyric: "[00:01.20]第一行\n[00:03.000]第二行" },
            tlyric: { lyric: "[00:01.20]First line" },
          },
        }),
      }),
    });
    await service.initialize();

    expect(await service.search("夜航")).toEqual([{
      id: "123",
      title: "夜航",
      artists: ["像素乐队"],
      album: "十六行",
      durationMs: 5_000,
      coverUrl: "https://p.example/cover.jpg",
    }]);
    expect((await service.trackDetail("123")).lyrics).toEqual([
      { startMs: 1_200, endMs: 3_000, text: "第一行", translation: "First line", endSource: "next" },
      // Three glyphs, so 1.89 s of singing rather than the 2 s remaining in the
      // track. This is the ~75-80% of NetEase tracks that have no yrc.
      { startMs: 3_000, endMs: 3_000 + 3 * 630, text: "第二行", endSource: "estimate" },
    ]);
  });

  // `lyric_new` calls itself 新版歌词 - 包含逐字歌词 and asks for yv/ytv/yrv, so the
  // word timings were arriving on every single request and being dropped on the
  // floor. This is the whole fix: when they are there, nothing is estimated.
  test("prefers the word-level yrc timeline, with its own translation track", async () => {
    const { store } = await sessionStore();
    const song = { id: 1, name: "孤勇者", ar: [{ name: "陈奕迅" }], al: { name: "" }, dt: 260_000 };
    const service = new NeteaseMusicService({
      sessionStore: store,
      gateway: fakeGateway({
        songDetail: async () => ({ body: { songs: [song] } }),
        lyric: async () => ({
          body: {
            // The credit blobs really are the first records of the field.
            yrc: {
              lyric: '{"t":-1000,"c":[{"tx":"作词: "},{"tx":"唐恬"}]}\n'
                + "[110330,5290](110330,350,0)谁(110680,250,0)说(110930,460,0)站(111390,400,0)在"
                + "(111790,400,0)光(112190,400,0)里(112590,640,0)的(113230,380,0)才(113610,390,0)算"
                + "(114000,340,0)英(114340,1280,0)雄\n"
                + "[128880,900](128880,320,0)他(129200,120,0)们(129320,460,0)说\n",
            },
            // Aligned to the yrc timeline …
            ytlrc: { lyric: "[01:50.33]Who says only those in the light are heroes" },
            // … while this one is aligned to the INDEPENDENT lrc timeline. On a
            // real track the two share almost no timestamps, so keeping tlyric
            // after switching to yrc hangs translations on the wrong lines.
            lrc: { lyric: "[01:50.35]谁说站在光里的才算英雄" },
            tlyric: { lyric: "[01:50.35]WRONG TIMELINE" },
          },
        }),
      }),
    });
    await service.initialize();

    const lyrics = (await service.trackDetail("1")).lyrics;
    expect(lyrics).toHaveLength(2);
    // The line the user complained about. Sung for 5.29 s; the next line is
    // 18.55 s away, and the old rule handed it all of that.
    expect(lyrics[0]!.startMs).toBe(110_330);
    expect(lyrics[0]!.endMs).toBe(115_620);
    expect(lyrics[0]!.endSource).toBe("words");
    expect(lyrics[0]!.words).toHaveLength(11);
    expect(lyrics[0]!.translation).toBe("Who says only those in the light are heroes");
    expect(JSON.stringify(lyrics)).not.toContain("WRONG TIMELINE");
    // …and the credit blob is not a lyric line.
    expect(lyrics.some((line) => line.text.includes("作词"))).toBe(false);
  });

  test("proxies only trusted NetEase media hosts and preserves byte ranges", async () => {
    const { store } = await sessionStore();
    let observedRange: string | null = null;
    const service = new NeteaseMusicService({
      sessionStore: store,
      gateway: fakeGateway({
        songUrl: async () => ({
          body: { data: [{ url: "https://m10.music.126.net/example.mp3" }] },
        }),
      }),
      fetcher: (async (_input, init) => {
        observedRange = new Headers(init?.headers).get("Range");
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Range": "bytes 0-2/3",
            "Accept-Ranges": "bytes",
          },
        });
      }) as typeof fetch,
    });
    await service.initialize();

    const response = await service.stream("123", "bytes=0-2");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-2/3");
    expect(String(observedRange)).toBe("bytes=0-2");

    const blocked = new NeteaseMusicService({
      sessionStore: store,
      gateway: fakeGateway({
        songUrl: async () => ({ body: { data: [{ url: "http://127.0.0.1/private" }] } }),
      }),
    });
    await blocked.initialize();
    await expect(blocked.stream("123")).rejects.toBeInstanceOf(MusicServiceError);
  });

  test("proxies the signed-in profile avatar without exposing third-party image access", async () => {
    const { store } = await sessionStore();
    await store.save("MUSIC_U=secret-value; os=pc", {
      provider: "netease",
      id: "42",
      nickname: "像素听众",
      avatarUrl: "https://p1.music.126.net/avatar.jpg",
    });
    let observedHost = "";
    let observedAccept = "";
    const service = new NeteaseMusicService({
      sessionStore: store,
      gateway: fakeGateway(),
      fetcher: (async (input, init) => {
        const upstreamUrl = input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
        observedHost = upstreamUrl.hostname;
        observedAccept = new Headers(init?.headers).get("Accept") ?? "";
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          headers: { "Content-Type": "image/jpg", "Content-Length": "4" },
        });
      }) as typeof fetch,
    });
    await service.initialize();

    const response = await service.avatar();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    );
    expect(observedHost).toBe("p1.music.126.net");
    expect(observedAccept).toContain("image/");

    const { store: blockedStore } = await sessionStore();
    await blockedStore.save("MUSIC_U=secret-value; os=pc", {
      provider: "netease",
      id: "7",
      nickname: "不可信头像",
      avatarUrl: "https://example.com/avatar.jpg",
    });
    const blocked = new NeteaseMusicService({ sessionStore: blockedStore });
    await blocked.initialize();
    await expect(blocked.avatar()).rejects.toBeInstanceOf(MusicServiceError);
  });
});
