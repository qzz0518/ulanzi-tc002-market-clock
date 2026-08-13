import { describe, expect, test } from "bun:test";
import {
  DAILY_QUEUE_LABEL,
  loadDailyRecommendations,
  playRandomLikedTrack,
  RANDOM_LIKED_QUEUE_LABEL,
} from "../web/src/lib/netease-discovery";
import {
  createMusicPlaybackStore,
  type AudioElementLike,
  type MusicPlaybackStore,
} from "../web/src/lib/music-playback-store";
import type { MusicTrack } from "../web/src/types";

/**
 * 每日推荐 and 随机播放 against the real playback store — the same one the page
 * runs — with a stub element and a stub network. What is being held here is the
 * sequence: a queue that is set before the selection resolves against it, and a
 * "play" that only fires when there is something that actually loaded.
 */

class FakeAudio implements AudioElementLike {
  src = "";
  preload = "";
  currentTime = 0;
  duration = 180;
  paused = true;
  readyState = 1;
  playCalls = 0;
  pauseCalls = 0;
  private readonly handlers = new Map<string, (() => void)[]>();

  load(): void {}

  async play(): Promise<void> {
    this.playCalls += 1;
    if (!this.paused) return;
    this.paused = false;
    this.fire("play");
  }

  pause(): void {
    this.pauseCalls += 1;
    if (this.paused) return;
    this.paused = true;
    this.fire("pause");
  }

  addEventListener(type: string, handler: () => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  fire(type: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler();
  }
}

const LIKED: MusicTrack = {
  id: "560693602",
  title: "夜航",
  artists: ["像素乐队"],
  album: "十六行",
  durationMs: 180_000,
};

const DAILY: MusicTrack[] = [
  { id: "3345803350", title: "361°", artists: ["水中スピカ"], album: "361°", durationMs: 331_533 },
  { id: "2", title: "第二首", artists: ["乐队"], album: "专辑", durationMs: 200_000 },
];

interface Harness {
  store: MusicPlaybackStore;
  audio: FakeAudio;
  urls: string[];
  requestJson: <T>(path: string) => Promise<T>;
}

function harness(options: { failTrackDetail?: boolean } = {}): Harness {
  const audio = new FakeAudio();
  const urls: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    urls.push(url);
    if (url.startsWith("/api/music/device/state")) return new Response("SEQ\t0\n", { status: 200 });
    if (/^\/api\/music\/tracks\/[^/]+$/.test(url)) {
      if (options.failTrackDetail) {
        return Response.json({ error: "当前账号或地区无法取得这首歌" }, { status: 404 });
      }
      const id = url.split("/").pop()!;
      const track = [LIKED, ...DAILY].find((candidate) => candidate.id === id) ?? LIKED;
      return Response.json({ detail: { track, lyrics: [] } });
    }
    return Response.json({ ok: true });
  };
  const store = createMusicPlaybackStore({
    fetcher,
    createAudio: () => audio,
    now: () => 0,
    // The discovery actions never wait on a tick; a timer that never fires
    // keeps the poll out of the assertions.
    setInterval: () => 1,
    clearInterval: () => {},
  });

  const requestJson = async <T>(path: string): Promise<T> => {
    urls.push(path);
    if (path === "/api/music/netease/daily") return { tracks: DAILY } as T;
    if (path === "/api/music/netease/liked/random") return { track: LIKED } as T;
    throw new Error(`unexpected request: ${path}`);
  };

  return { store, audio, urls, requestJson };
}

describe("NetEase discovery actions", () => {
  test("每日推荐 fills the library and names itself, so it is not read as a search", async () => {
    const { store, requestJson, urls } = harness();

    const tracks = await loadDailyRecommendations({ requestJson, store });

    expect(tracks).toEqual(DAILY);
    const snapshot = store.getSnapshot();
    expect(snapshot.queue).toEqual(DAILY);
    // The library heading is this label; leaving it on the default would tell
    // the user these 30 songs were search results.
    expect(snapshot.queueLabel).toBe(DAILY_QUEUE_LABEL);
    expect(DAILY_QUEUE_LABEL).not.toBe("搜索结果");
    // Filling a list is not playing it — the user still picks.
    expect(snapshot.detail).toBeNull();
    expect(snapshot.playing).toBe(false);
    expect(urls).toEqual(["/api/music/netease/daily"]);
    store.dispose();
  });

  test("每日推荐 surfaces a failure rather than emptying the library", async () => {
    const { store } = harness();
    store.setQueue(DAILY, "歌单：夜车");
    const failing = async <T>(): Promise<T> => {
      throw new Error("网易云每日推荐接口返回 400：请求过于频繁");
    };

    await expect(loadDailyRecommendations({ requestJson: failing, store }))
      .rejects.toThrow("请求过于频繁");
    // The list the user was looking at is still there; nothing was replaced
    // with an empty one that would read as "you have no recommendations".
    expect(store.getSnapshot().queue).toEqual(DAILY);
    expect(store.getSnapshot().queueLabel).toBe("歌单：夜车");
    store.dispose();
  });

  test("随机播放 queues the drawn song before selecting it, then starts playback", async () => {
    const { store, audio, requestJson } = harness();

    const track = await playRandomLikedTrack({ requestJson, store });

    expect(track).toEqual(LIKED);
    const snapshot = store.getSnapshot();
    expect(snapshot.detail?.track.id).toBe(LIKED.id);
    // Order matters: `select` resolves the index against the queue it finds, so
    // queueing after selecting would leave the console at "no track position".
    expect(snapshot.queue).toEqual([LIKED]);
    expect(snapshot.queueIndex).toBe(0);
    expect(snapshot.queueLabel).toBe(RANDOM_LIKED_QUEUE_LABEL);
    // 直接播放 — `select` alone only loads, the way clicking a row does.
    expect(audio.src).toBe(`/api/music/tracks/${LIKED.id}/stream`);
    expect(audio.playCalls).toBe(1);
    expect(snapshot.playing).toBe(true);
    store.dispose();
  });

  test("随机播放 does not press play when the song failed to load", async () => {
    const { store, audio, requestJson } = harness({ failTrackDetail: true });

    await playRandomLikedTrack({ requestJson, store });

    const snapshot = store.getSnapshot();
    expect(snapshot.detail).toBeNull();
    expect(snapshot.error).toBe("当前账号或地区无法取得这首歌");
    // Toggling a failed selection would have started an empty element (or, with
    // something already loaded, paused it).
    expect(audio.playCalls).toBe(0);
    expect(snapshot.playing).toBe(false);
    store.dispose();
  });

  // The two rules, read off the call order rather than off the end state: a
  // device heartbeat landing during `select` can report the track as already
  // playing, and a `toggle` on top of that is a pause the user never asked for.
  test("随机播放 queues, selects, and only then plays — and skips the play if it already is", async () => {
    const calls: string[] = [];
    let snapshot = { detail: null as { track: MusicTrack } | null, playing: false };
    const spyStore = {
      setQueue: (tracks: readonly MusicTrack[], label: string) => {
        calls.push(`setQueue:${label}:${tracks.map((track) => track.id).join(",")}`);
      },
      select: async (track: MusicTrack) => {
        calls.push(`select:${track.id}`);
        // The device answered the selection and started playing on its own.
        snapshot = { detail: { track }, playing: true };
      },
      toggle: async () => {
        calls.push("toggle");
      },
      getSnapshot: () => snapshot,
    };

    await playRandomLikedTrack({
      requestJson: harness().requestJson,
      store: spyStore as never,
    });

    expect(calls).toEqual([
      `setQueue:${RANDOM_LIKED_QUEUE_LABEL}:${LIKED.id}`,
      `select:${LIKED.id}`,
    ]);
    expect(calls).not.toContain("toggle");
  });
});
