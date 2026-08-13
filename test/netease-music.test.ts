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
    recommendSongs: async () => ({ body: { code: 200, data: { dailySongs: [] } } }),
    likedSongIds: async () => ({ body: { code: 200, ids: [] } }),
    ...overrides,
  };
}

// A service whose session file already holds a signed-in account, which both
// 每日推荐 and 喜欢的歌曲 require.
async function signedInService(
  gateway: NeteaseGateway,
  extra: { random?: () => number } = {},
): Promise<NeteaseMusicService> {
  const { store } = await sessionStore();
  await store.save("MUSIC_U=secret-value; os=pc", {
    provider: "netease",
    id: "42",
    nickname: "像素听众",
  });
  const service = new NeteaseMusicService({ gateway, sessionStore: store, ...extra });
  await service.initialize();
  return service;
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

  test("reads 每日推荐 from the account's own list and refuses to answer signed out", async () => {
    const daily = [
      { id: 3345803350, name: "361°", ar: [{ name: "水中スピカ" }], al: { name: "361°" }, dt: 331_533 },
      { id: 2, name: "第二首", ar: [{ name: "乐队" }], al: { name: "专辑" }, dt: 200_000 },
      // Not a song: the parser drops it rather than showing a nameless row.
      { id: 0, name: "" },
    ];
    let observedCookie = "";
    const service = await signedInService(fakeGateway({
      recommendSongs: async (input) => {
        observedCookie = input.cookie;
        return { body: { code: 200, data: { dailySongs: daily } } };
      },
    }));

    expect(await service.dailyRecommendations()).toEqual([
      { id: "3345803350", title: "361°", artists: ["水中スピカ"], album: "361°", durationMs: 331_533 },
      { id: "2", title: "第二首", artists: ["乐队"], album: "专辑", durationMs: 200_000 },
    ]);
    // 推荐是按登录 Cookie 算的，不带凭据就不是这个账号的推荐。
    expect(observedCookie).toBe("MUSIC_U=secret-value; os=pc");

    const { store } = await sessionStore();
    const signedOut = new NeteaseMusicService({ gateway: fakeGateway(), sessionStore: store });
    await signedOut.initialize();
    await expect(signedOut.dailyRecommendations()).rejects.toMatchObject({
      status: 401,
      message: "请先使用网易云音乐扫码登录",
    });
  });

  // NetEase answers a failed call with HTTP 200 and a non-200 body code — a
  // transient `code: 400` from user_playlist was measured on a healthy session.
  // Reading such a body for its list field yields [], and rendering that is a
  // claim about the account ("you have no recommendations") we cannot support.
  test("reports a NetEase failure instead of rendering it as an empty library", async () => {
    const failing = await signedInService(fakeGateway({
      recommendSongs: async () => ({ body: { code: 400, message: "请求过于频繁" } }),
    }));
    await expect(failing.dailyRecommendations()).rejects.toMatchObject({
      status: 502,
      message: "网易云每日推荐接口返回 400：请求过于频繁",
    });

    // An expired cookie is a different instruction to the user, so it gets its
    // own status and its own words.
    const expired = await signedInService(fakeGateway({
      likedSongIds: async () => ({ body: { code: 301 } }),
    }));
    await expect(expired.randomLikedTrack()).rejects.toMatchObject({
      status: 401,
      message: "网易云登录已失效，请重新扫码登录",
    });

    // 200 with nothing in it is a delivery that failed, not an empty account.
    const empty = await signedInService(fakeGateway());
    await expect(empty.dailyRecommendations()).rejects.toMatchObject({ status: 502 });
  });

  test("draws a random liked song from the whole like list, then makes it playable", async () => {
    const ids = [562594185, 1938019211, 560693602, 757761, 2048604695];
    let observedUid = 0;
    let requestedIds = "";
    let detailCalls = 0;
    const gateway = fakeGateway({
      likedSongIds: async (input) => {
        observedUid = input.uid;
        return { body: { code: 200, ids } };
      },
      songDetail: async (input) => {
        detailCalls += 1;
        requestedIds = input.ids;
        const requested = input.ids.split(",").map(Number);
        return {
          body: {
            code: 200,
            songs: requested.map((id) => ({
              id,
              name: `曲目 ${id}`,
              ar: [{ name: "像素乐队" }],
              al: { name: "十六行", picUrl: "https://p.example/cover.jpg" },
              dt: 180_000,
            })),
            privileges: requested.map((id) => ({ id, pl: 320_000 })),
          },
        };
      },
    });

    // likelist returns IDs only, so the draw still has to be resolved — in ONE
    // song_detail, which is what makes drawing several free.
    const middle = await signedInService(gateway, { random: () => 0.5 });
    expect(await middle.randomLikedTrack()).toEqual({
      id: "560693602",
      title: "曲目 560693602",
      artists: ["像素乐队"],
      album: "十六行",
      durationMs: 180_000,
      coverUrl: "https://p.example/cover.jpg",
    });
    expect(observedUid).toBe(42);
    expect(requestedIds).toBe("560693602");
    expect(detailCalls).toBe(1);

    const first = await signedInService(gateway, { random: () => 0 });
    expect((await first.randomLikedTrack()).id).toBe("562594185");
    // Math.random() is [0, 1), but a value of 1 must not index past the end.
    const last = await signedInService(gateway, { random: () => 1 });
    expect((await last.randomLikedTrack()).id).toBe("2048604695");

    // A walking draw resolves several ids at once and still returns the FIRST
    // one drawn — the pick has to stay random, not "whichever NetEase listed
    // first".
    let step = 0;
    const walking = await signedInService(gateway, { random: () => [0.6, 0, 0.2][step++ % 3]! });
    expect((await walking.randomLikedTrack()).id).toBe("757761");
    expect(requestedIds.split(",")).toEqual(["757761", "562594185", "1938019211"]);
  });

  // The button promises playback, not a track. A like list this old holds songs
  // that have since been taken down — the first real click landed on 729638,
  // whose stream 404s — and song_detail already says so in `privileges.pl`.
  test("skips liked songs this account can no longer play", async () => {
    const ids = [729638, 26092657, 28287116];
    let step = 0;
    const gateway = fakeGateway({
      likedSongIds: async () => ({ body: { code: 200, ids } }),
      songDetail: async (input) => {
        const requested = input.ids.split(",").map(Number);
        return {
          body: {
            code: 200,
            songs: requested.map((id) => ({ id, name: `曲目 ${id}`, ar: [], al: {}, dt: 1_000 })),
            // 729638 measured on the real account: st -200, pl 0.
            privileges: requested.map((id) => ({ id, pl: id === 729638 ? 0 : 999_000 })),
          },
        };
      },
    });
    const service = await signedInService(gateway, {
      random: () => [0, 0.4, 0.9][step++ % 3]!,
    });
    expect((await service.randomLikedTrack()).id).toBe("26092657");

    // Everything drawn is dead: say so, rather than handing back a track that
    // will fail to stream a second later.
    const allDead = await signedInService(fakeGateway({
      likedSongIds: async () => ({ body: { code: 200, ids: [729638] } }),
      songDetail: async () => ({
        body: {
          code: 200,
          songs: [{ id: 729638, name: "鉱山町マインツ", ar: [], al: {}, dt: 1_000 }],
          privileges: [{ id: 729638, pl: 0 }],
        },
      }),
    }));
    await expect(allDead.randomLikedTrack()).rejects.toThrow(/都无法播放/);

    // No privileges at all is "not stated", not "nothing is playable".
    const silent = await signedInService(fakeGateway({
      likedSongIds: async () => ({ body: { code: 200, ids: [757761] } }),
      songDetail: async () => ({
        body: { code: 200, songs: [{ id: 757761, name: "无版权信息", ar: [], al: {}, dt: 1_000 }] },
      }),
    }));
    expect((await silent.randomLikedTrack()).id).toBe("757761");
  });

  test("says the account has no liked songs rather than playing nothing", async () => {
    const service = await signedInService(fakeGateway({
      likedSongIds: async () => ({ body: { code: 200, ids: [] } }),
    }));
    await expect(service.randomLikedTrack()).rejects.toMatchObject({ status: 404 });
    await expect(service.randomLikedTrack()).rejects.toThrow(/还没有喜欢的歌曲/);

    // The ID exists but NetEase would not describe it: still an error, never a
    // half-built track.
    const unresolvable = await signedInService(fakeGateway({
      likedSongIds: async () => ({ body: { code: 200, ids: [757761] } }),
      songDetail: async () => ({ body: { code: 200, songs: [] } }),
    }));
    await expect(unresolvable.randomLikedTrack()).rejects.toBeInstanceOf(MusicServiceError);

    const { store } = await sessionStore();
    const signedOut = new NeteaseMusicService({ gateway: fakeGateway(), sessionStore: store });
    await signedOut.initialize();
    await expect(signedOut.randomLikedTrack()).rejects.toMatchObject({ status: 401 });
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
