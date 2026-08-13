import { describe, expect, test } from "bun:test";
import {
  createMusicPlaybackStore,
  deviceIsLoadingTrack,
  effectiveDurationMs,
  type AudioElementLike,
  type MusicPlaybackStore,
} from "../web/src/lib/music-playback-store";
import type { MusicTrack, MusicTrackDetail } from "../web/src/types";

/**
 * The player used to be an `<audio>` tag inside the music tab's tree. These
 * tests are the reason it can leave it: every transport decision — what plays,
 * what the clock is told, when the device is polled — is exercised here with a
 * stub element and a stub network, no browser involved.
 */

class FakeAudio implements AudioElementLike {
  src = "";
  preload = "";
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  readyState = 0;
  loads = 0;
  playCalls = 0;
  private readonly handlers = new Map<string, (() => void)[]>();

  load(): void {
    this.loads += 1;
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    if (!this.paused) return;
    this.paused = false;
    this.fire("play");
  }

  pause(): void {
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

  /** Metadata arriving, the way a browser announces it. */
  announceDuration(seconds: number): void {
    this.duration = seconds;
    this.readyState = 1;
    this.fire("loadedmetadata");
  }
}

interface Recorded {
  url: string;
  method: string;
  body: string | null;
}

interface Harness {
  store: MusicPlaybackStore;
  audio: FakeAudio;
  calls: Recorded[];
  /** The next `/api/music/device/state` document. */
  setStateDoc(fields: Record<string, string | number>): void;
  /** Run the store's timer for `ms`, letting每 pending request settle. */
  advance(ms: number): Promise<void>;
  urls(prefix: string): string[];
  bodies(prefix: string): unknown[];
}

const TRACK: MusicTrack = {
  id: "42",
  title: "夜航",
  artists: ["示例乐队", "另一位"],
  album: "夜航西飞",
  durationMs: 200_000,
};

const DETAIL: MusicTrackDetail = {
  track: TRACK,
  lyrics: [
    { startMs: 0, endMs: 4_000, text: "第一句", endSource: "marker" },
    { startMs: 10_000, endMs: 14_000, text: "第二句", endSource: "marker" },
    { startMs: 20_000, endMs: 24_000, text: "第三句", endSource: "marker" },
  ],
};

function stateDoc(fields: Record<string, string | number>): string {
  const merged: Record<string, string | number> = {
    SEQ: 0,
    SRC: "netease",
    RMT: 0,
    TID: "-",
    PLAY: 0,
    MODE: "spotlight",
    SKIN: "signal",
    ACCENT: "-",
    SEEK: -1,
    RPOS: -1,
    RDUR: -1,
    RPLAY: 0,
    HBAGE: -1,
    FWPOLL: -1,
    DTRACK: "-",
    DPLAY: 0,
    DPLAYING: 0,
    ...fields,
  };
  return Object.entries(merged).map(([key, value]) => `${key}\t${value}`).join("\n") + "\n";
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { controlSeq?: number } = {}): Harness {
  const audio = new FakeAudio();
  const calls: Recorded[] = [];
  let overrides: Record<string, string | number> = {};
  // The service owns the control sequence: /control hands one out and the next
  // /state serves that same number back. A fake that answered a control with
  // seq 1 while still serving SEQ 0 would look to the store exactly like a
  // device key press, and would replay our own pause onto us.
  let servedSeq = 0;
  let clock = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { handler: () => void; ms: number; due: number }>();

  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (url.startsWith("/api/music/device/state")) {
      return new Response(stateDoc({ SEQ: servedSeq, ...overrides }), { status: 200 });
    }
    if (url.startsWith("/api/music/device/control")) {
      servedSeq = options.controlSeq ?? servedSeq + 1;
      return Response.json({ ok: true, seq: servedSeq });
    }
    const trackMatch = /^\/api\/music\/tracks\/([^/]+)$/.exec(url);
    if (trackMatch) {
      // The detail the service returns is the track that was ASKED for. Always
      // answering with the same id made `skip` look like it had walked the
      // queue when it had not moved at all.
      return Response.json({
        detail: { ...DETAIL, track: { ...DETAIL.track, id: trackMatch[1]! } },
      });
    }
    return Response.json({ ok: true });
  };

  const store = createMusicPlaybackStore({
    fetcher,
    createAudio: () => audio,
    now: () => clock,
    setInterval: (handler, ms) => {
      nextTimerId += 1;
      timers.set(nextTimerId, { handler, ms, due: clock + ms });
      return nextTimerId;
    },
    clearInterval: (id) => {
      timers.delete(id);
    },
  });

  return {
    store,
    audio,
    calls,
    setStateDoc(fields) {
      overrides = fields;
    },
    async advance(ms) {
      const end = clock + ms;
      while (clock < end) {
        clock = Math.min(end, clock + 100);
        for (const timer of [...timers.values()]) {
          while (timer.due <= clock) {
            timer.due += timer.ms;
            timer.handler();
          }
        }
        await settle();
      }
      await settle();
    },
    urls(prefix) {
      return calls.filter((call) => call.url.startsWith(prefix)).map((call) => call.url);
    },
    bodies(prefix) {
      return calls
        .filter((call) => call.url.startsWith(prefix))
        .map((call) => (call.body === null ? null : JSON.parse(call.body) as unknown));
    },
  };
}

describe("music playback store", () => {
  test("stays silent until something engages it", async () => {
    const { store, calls, advance } = harness();
    await advance(10_000);
    expect(calls).toEqual([]);
    store.dispose();
  });

  test("polls device state while a view is mounted and stops when it leaves", async () => {
    const { store, advance, urls } = harness();
    const release = store.retain();
    await settle();
    expect(urls("/api/music/device/state").length).toBe(1);

    await advance(5_000);
    expect(urls("/api/music/device/state").length).toBe(3);

    release();
    const seen = urls("/api/music/device/state").length;
    await advance(10_000);
    expect(urls("/api/music/device/state").length).toBe(seen);
    store.dispose();
  });

  test("keeps polling for a loaded track after the view unmounts", async () => {
    // This is the regression the whole store exists for: switching tabs used to
    // take the player down with the view.
    const { store, advance, urls } = harness();
    const release = store.retain();
    store.setQueue([TRACK], "搜索结果");
    await store.select(TRACK);
    release();

    const seen = urls("/api/music/device/state").length;
    await advance(5_000);
    expect(urls("/api/music/device/state").length).toBeGreaterThan(seen);
    expect(store.getSnapshot().detail?.track.id).toBe("42");
    store.dispose();
  });

  test("selecting a track loads it, points the element at the stream and tells the device", async () => {
    const { store, audio, advance, bodies } = harness();
    store.setQueue([TRACK], "搜索结果");
    await store.select(TRACK);
    await advance(0);

    const snapshot = store.getSnapshot();
    expect(snapshot.detail?.track.title).toBe("夜航");
    expect(snapshot.queueIndex).toBe(0);
    expect(snapshot.positionMs).toBe(0);
    expect(snapshot.durationMs).toBe(200_000);
    expect(snapshot.playing).toBe(false);
    expect(snapshot.loading).toBe(false);
    expect(audio.src).toBe("/api/music/tracks/42/stream");
    // Re-selecting the loaded track has to restart it rather than resume where
    // the previous listen stopped, so the load is explicit.
    expect(audio.loads).toBe(1);
    expect(bodies("/api/music/device/select")).toEqual([{ trackId: "42" }]);
    store.dispose();
  });

  test("a failed track load says so instead of pretending to play", async () => {
    const audio = new FakeAudio();
    const store = createMusicPlaybackStore({
      fetcher: async () => Response.json({ error: "版权限制" }, { status: 403 }),
      createAudio: () => audio,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    store.setQueue([TRACK], "搜索结果");
    await store.select(TRACK);
    expect(store.getSnapshot().error).toBe("版权限制");
    expect(store.getSnapshot().detail).toBeNull();
    store.dispose();
  });

  test("play/pause drives the element and reports the change to the device", async () => {
    const { store, audio, advance, bodies } = harness();
    store.setQueue([TRACK], "搜索结果");
    await store.select(TRACK);
    await store.toggle();
    expect(audio.paused).toBe(false);
    expect(store.getSnapshot().playing).toBe(true);

    await store.toggle();
    await advance(0);
    expect(audio.paused).toBe(true);
    expect(store.getSnapshot().playing).toBe(false);
    expect(bodies("/api/music/device/control")).toEqual([{ playing: true }, { playing: false }]);
    store.dispose();
  });

  test("a device key press echoes into local audio, our own control does not", async () => {
    const { store, audio, advance, setStateDoc } = harness({ controlSeq: 7 });
    store.retain();
    store.setQueue([TRACK], "搜索结果");
    await store.select(TRACK);

    // The service bumped the sequence on our behalf (select starts playback):
    // the echo is what actually starts the browser playing.
    setStateDoc({ SEQ: 3, PLAY: 1 });
    await advance(2_600);
    expect(audio.paused).toBe(false);
    expect(store.getSnapshot().playing).toBe(true);

    // Our own pause records seq 7; a state document carrying it must not be
    // replayed onto us.
    await store.toggle();
    expect(audio.paused).toBe(true);
    setStateDoc({ SEQ: 7, PLAY: 1 });
    await advance(2_600);
    expect(audio.paused).toBe(true);
    store.dispose();
  });

  test("the music firmware's heartbeat anchors the clock and the playhead runs on", async () => {
    const { store, advance, setStateDoc } = harness();
    store.retain();
    store.setQueue([TRACK], "搜索结果");
    await store.select(TRACK);

    setStateDoc({ FWPOLL: 500, HBAGE: 200, DTRACK: "42", DPLAY: 30_000, DPLAYING: 1 });
    await advance(2_600);
    const snapshot = store.getSnapshot();
    expect(snapshot.deviceOnline).toBe(true);
    expect(snapshot.deviceTrackId).toBe("42");
    // 30s reported + 200ms heartbeat age, then interpolated forward.
    expect(snapshot.positionMs).toBeGreaterThanOrEqual(30_200);
    const before = snapshot.positionMs;
    await advance(1_000);
    expect(store.getSnapshot().positionMs).toBeGreaterThanOrEqual(before + 900);
    store.dispose();
  });

  test("holds the clock while the firmware is still fetching the selected track", async () => {
    const { store, advance, setStateDoc } = harness();
    store.retain();
    store.setQueue([TRACK], "搜索结果");
    await store.select(TRACK);
    // Device online but still playing the PREVIOUS track: its playhead must not
    // be shown against the track the user just picked.
    setStateDoc({ FWPOLL: 500, HBAGE: 200, DTRACK: "17", DPLAY: 90_000, DPLAYING: 1 });
    await advance(3_000);
    expect(deviceIsLoadingTrack(store.getSnapshot())).toBe(true);
    expect(store.getSnapshot().positionMs).toBe(0);
    store.dispose();
  });

  test("follows a Connect player that moved on its own", async () => {
    const { store, advance, setStateDoc } = harness();
    store.setSource("spotify", "remote");
    // Before `retain`: mounting the view polls immediately and then not again
    // for 2.5 s, so a document published after that first poll would not be
    // read inside this window at all.
    setStateDoc({ RMT: 1, RPOS: 45_000, RDUR: 200_000, RPLAY: 1, TID: "42" });
    store.retain();
    await advance(600);

    const snapshot = store.getSnapshot();
    expect(snapshot.remoteLive).toBe(true);
    expect(snapshot.playing).toBe(true);
    expect(snapshot.detail?.track.id).toBe("42");
    expect(snapshot.durationMs).toBe(200_000);
    expect(snapshot.positionMs).toBeGreaterThanOrEqual(45_000);
    store.dispose();
  });

  test("skip walks the queue locally and the Connect queue remotely", async () => {
    const second: MusicTrack = { ...TRACK, id: "43", title: "第二首" };
    const { store, advance, bodies } = harness();
    store.setQueue([TRACK, second], "我的歌单");
    await store.select(TRACK);
    store.skip(1);
    await advance(0);
    expect(bodies("/api/music/device/select")).toEqual([{ trackId: "42" }, { trackId: "43" }]);

    // Wrapping backwards from the first track lands on the last one.
    store.skip(-1);
    await advance(0);
    expect(bodies("/api/music/device/select").at(-1)).toEqual({ trackId: "42" });

    store.setSource("spotify", "remote");
    store.skip(1);
    await advance(0);
    expect(bodies("/api/music/remote").at(-1)).toEqual({ action: "next" });
    store.dispose();
  });

  test("a seek before metadata is replayed once the element knows the duration", async () => {
    const { store, audio, advance } = harness();
    store.setQueue([TRACK], "搜索结果");
    await store.select(TRACK);

    store.seek(61_250);
    expect(store.getSnapshot().positionMs).toBe(61_250);
    expect(audio.currentTime).toBe(0);

    audio.announceDuration(240);
    await advance(0);
    expect(audio.currentTime).toBe(61.25);
    expect(store.getSnapshot().durationMs).toBe(240_000);
    store.dispose();
  });

  test("seeking in device mode nudges a repeated target so the firmware cannot dedup it", async () => {
    const { store, advance, setStateDoc, bodies } = harness();
    store.retain();
    store.setQueue([TRACK], "搜索结果");
    await store.select(TRACK);
    setStateDoc({ FWPOLL: 500, HBAGE: 200, DTRACK: "42", DPLAY: 0, DPLAYING: 1 });
    await advance(2_600);

    store.seek(30_000);
    store.seek(30_000);
    await advance(0);
    const seeks = bodies("/api/music/device/control").filter(
      (body): body is { seekMs: number } =>
        typeof body === "object" && body !== null && "seekMs" in body,
    );
    expect(seeks.map((body) => body.seekMs)).toEqual([30_000, 29_999]);
    store.dispose();
  });

  test("clear forgets the queue and stops the audio", async () => {
    const { store, audio, advance } = harness();
    store.setQueue([TRACK], "我的歌单");
    await store.select(TRACK);
    await store.toggle();
    expect(audio.paused).toBe(false);

    store.clear();
    await advance(0);
    expect(audio.paused).toBe(true);
    const snapshot = store.getSnapshot();
    expect(snapshot.detail).toBeNull();
    expect(snapshot.queue).toEqual([]);
    expect(snapshot.queueLabel).toBe("搜索结果");
    expect(snapshot.playing).toBe(false);
    store.dispose();
  });

  test("subscribers are told once per change, not once per tick", async () => {
    const { store, advance } = harness();
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    store.retain();
    await advance(1_000);
    // Nothing is playing and the state document says nothing new: a poll that
    // changes no field must not re-render the console ten times a second.
    expect(notifications).toBe(0);
    store.dispose();
  });
});

describe("now-playing reporting", () => {
  const reports = (h: Harness): unknown[] => h.bodies("/api/os/now-playing");

  test("a page that has never played anything says nothing at all", async () => {
    // The hub arbitrates by source and every console tab writes as the same
    // "console" source, so a `PUT null` from here would release the panel a
    // DIFFERENT tab is feeding. Opening a second console on ZOS used to blank
    // the clock for seconds; silence is not ownership.
    const h = harness();
    h.store.setNowPlayingReporting(true);
    await h.advance(9_000);
    expect(reports(h)).toEqual([]);

    // Nor on the way out — neither leaving ZOS nor closing the page.
    h.store.setNowPlayingReporting(false);
    await h.advance(0);
    expect(reports(h)).toEqual([]);
    h.store.dispose();
  });

  test("gives the panel back exactly once, then goes quiet again", async () => {
    // Having released it (the track went away), this page owns nothing either,
    // so leaving ZOS afterwards must not fire a second null at whoever took it.
    const h = harness();
    h.store.setNowPlayingReporting(true);
    h.store.setQueue([TRACK], "搜索结果");
    await h.store.select(TRACK);
    await h.store.toggle();
    h.store.clear();
    await h.advance(0);
    expect(reports(h).at(-1)).toBeNull();

    const seen = reports(h).length;
    h.store.setNowPlayingReporting(false);
    await h.advance(9_000);
    expect(reports(h).length).toBe(seen);
    h.store.dispose();
  });

  test("reports the track, the line and its window while playing", async () => {
    const h = harness();
    h.store.setNowPlayingReporting(true);
    h.store.setQueue([TRACK], "搜索结果");
    await h.store.select(TRACK);
    await h.store.toggle();
    await h.advance(0);

    const last = reports(h).at(-1) as Record<string, unknown>;
    expect(last).toMatchObject({
      track: "夜航",
      artist: "示例乐队 / 另一位",
      playing: true,
      durationMs: 200_000,
      lyric: "第一句",
      lyricStartMs: 0,
      lyricEndMs: 4_000,
      // The next line's start, which is a different moment from the end of the
      // singing — this is what stops the panel crawling through instrumentals.
      lyricUntilMs: 10_000,
    });
    h.store.dispose();
  });

  test("re-reports when the line changes, and keeps the track when paused", async () => {
    const h = harness();
    h.store.setNowPlayingReporting(true);
    h.store.setQueue([TRACK], "搜索结果");
    await h.store.select(TRACK);
    await h.store.toggle();
    const before = reports(h).length;

    h.audio.currentTime = 11;
    h.audio.fire("timeupdate");
    await h.advance(0);
    const afterLine = reports(h);
    expect(afterLine.length).toBe(before + 1);
    expect((afterLine.at(-1) as Record<string, unknown>).lyric).toBe("第二句");

    // A playhead that moves inside the same line is carried by the 4 s timer,
    // not by a report per frame.
    h.audio.currentTime = 12;
    h.audio.fire("timeupdate");
    await h.advance(0);
    expect(reports(h).length).toBe(afterLine.length);

    await h.store.toggle();
    await h.advance(0);
    expect(reports(h).at(-1)).toMatchObject({ track: "夜航", playing: false });
    h.store.dispose();
  });

  test("refreshes every four seconds while playing so the hub never times it out", async () => {
    const h = harness();
    h.store.setNowPlayingReporting(true);
    h.store.setQueue([TRACK], "搜索结果");
    await h.store.select(TRACK);
    await h.store.toggle();
    const before = reports(h).length;
    await h.advance(9_000);
    expect(reports(h).length).toBeGreaterThanOrEqual(before + 2);
    h.store.dispose();
  });

  test("says nothing at all when the clock is not running ZOS", async () => {
    const h = harness();
    h.store.setQueue([TRACK], "搜索结果");
    await h.store.select(TRACK);
    await h.store.toggle();
    await h.advance(5_000);
    expect(reports(h)).toEqual([]);
    h.store.dispose();
  });

  test("releases the panel when the source is switched out from under the track", async () => {
    // Changing 网易云 → Spotify clears the library, and the track that was
    // playing goes with it. The clock must not be left showing a song this
    // console stopped being able to describe.
    const h = harness();
    h.store.setNowPlayingReporting(true);
    h.store.setQueue([TRACK], "搜索结果");
    await h.store.select(TRACK);
    await h.store.toggle();
    expect(reports(h).at(-1)).toMatchObject({ track: "夜航", playing: true });

    h.store.clear();
    await h.advance(0);
    expect(reports(h).at(-1)).toBeNull();
    h.store.dispose();
  });

  test("releases the panel when reporting is turned off mid-song", async () => {
    const h = harness();
    h.store.setNowPlayingReporting(true);
    h.store.setQueue([TRACK], "搜索结果");
    await h.store.select(TRACK);
    await h.store.toggle();
    h.store.setNowPlayingReporting(false);
    await h.advance(0);
    expect(reports(h).at(-1)).toBeNull();

    // And stays quiet afterwards — the panel is no longer ours to drive.
    const seen = reports(h).length;
    await h.advance(9_000);
    expect(reports(h).length).toBe(seen);
    h.store.dispose();
  });
});

describe("music playback derivations", () => {
  const base = createMusicPlaybackStore({
    fetcher: async () => new Response("", { status: 200 }),
    createAudio: () => null,
    setInterval: () => 0,
    clearInterval: () => {},
  }).getSnapshot();

  test("falls back to the source's duration until the element answers", () => {
    expect(effectiveDurationMs({ ...base, detail: DETAIL, durationMs: 0 })).toBe(200_000);
    expect(effectiveDurationMs({ ...base, detail: DETAIL, durationMs: 199_000 })).toBe(199_000);
  });

  test("only the device-audio path has a download to wait for", () => {
    const loading = { ...base, detail: DETAIL, deviceOnline: true, deviceTrackId: "17" };
    expect(deviceIsLoadingTrack(loading)).toBe(true);
    expect(deviceIsLoadingTrack({ ...loading, deviceTrackId: "42" })).toBe(false);
    expect(deviceIsLoadingTrack({ ...loading, playbackMode: "remote" })).toBe(false);
  });
});

/**
 * 播放模式 in the store rather than in the button. The rules themselves are
 * pinned in test/music-play-order.test.ts; what is checked here is that the
 * store obeys them with real audio events — and that it does so without a
 * single view retained, which is what "the queue advances whether or not the
 * music tab is mounted" actually means.
 */
describe("播放模式", () => {
  const SECOND: MusicTrack = { ...TRACK, id: "43", title: "第二首" };

  /** Get a track playing, the way the page does: select, metadata, play. */
  async function playing(
    harnessed: Harness,
    track: MusicTrack,
  ): Promise<void> {
    await harnessed.store.select(track);
    harnessed.audio.announceDuration(200);
    await harnessed.store.toggle();
    expect(harnessed.store.getSnapshot().playing).toBe(true);
  }

  /** The browser's end-of-track: the element stops, then fires. */
  function finishTrack(harnessed: Harness): void {
    harnessed.audio.currentTime = 200;
    harnessed.audio.paused = true;
    harnessed.audio.fire("ended");
  }

  test("defaults to 顺序播放 and cycles to 单曲循环, 随机播放 and back", () => {
    const { store } = harness();
    expect(store.getSnapshot().playOrder).toBe("sequence");
    store.cyclePlayOrder();
    expect(store.getSnapshot().playOrder).toBe("repeat-one");
    store.cyclePlayOrder();
    expect(store.getSnapshot().playOrder).toBe("shuffle");
    store.cyclePlayOrder();
    expect(store.getSnapshot().playOrder).toBe("sequence");
    store.dispose();
  });

  test("顺序播放 hands a finished track to the next one and keeps playing", async () => {
    const held = harness();
    held.store.setQueue([TRACK, SECOND], "我的歌单");
    await playing(held, TRACK);
    const playsBefore = held.audio.playCalls;

    // No retain() anywhere above: nothing is mounted, and the queue still moves.
    finishTrack(held);
    await held.advance(0);

    expect(held.bodies("/api/music/device/select"))
      .toEqual([{ trackId: "42" }, { trackId: "43" }]);
    expect(held.store.getSnapshot().detail?.track.id).toBe("43");
    expect(held.audio.src).toBe("/api/music/tracks/43/stream");
    expect(held.audio.playCalls).toBeGreaterThan(playsBefore);
    expect(held.store.getSnapshot().playing).toBe(true);
    held.store.dispose();
  });

  test("顺序播放 stops at the last track instead of wrapping", async () => {
    const held = harness();
    held.store.setQueue([TRACK, SECOND], "我的歌单");
    await playing(held, SECOND);

    finishTrack(held);
    await held.advance(0);

    expect(held.bodies("/api/music/device/select")).toEqual([{ trackId: "43" }]);
    expect(held.store.getSnapshot().detail?.track.id).toBe("43");
    expect(held.store.getSnapshot().playing).toBe(false);
    held.store.dispose();
  });

  test("单曲循环 replays the track from the top without fetching it again", async () => {
    const held = harness();
    held.store.setPlayOrder("repeat-one");
    held.store.setQueue([TRACK, SECOND], "我的歌单");
    await playing(held, TRACK);
    const playsBefore = held.audio.playCalls;

    finishTrack(held);
    await held.advance(0);

    expect(held.store.getSnapshot().detail?.track.id).toBe("42");
    expect(held.audio.currentTime).toBe(0);
    expect(held.store.getSnapshot().positionMs).toBe(0);
    // One detail fetch and one device select for the whole loop: replaying is
    // not reloading.
    expect(held.urls("/api/music/tracks/42")).toEqual(["/api/music/tracks/42"]);
    expect(held.bodies("/api/music/device/select")).toEqual([{ trackId: "42" }]);
    expect(held.audio.playCalls).toBeGreaterThan(playsBefore);
    held.store.dispose();
  });

  test("下一首 in 单曲循环 still gives the next song", async () => {
    const held = harness();
    held.store.setPlayOrder("repeat-one");
    held.store.setQueue([TRACK, SECOND], "我的歌单");
    await playing(held, TRACK);

    held.store.skip(1);
    await held.advance(0);

    expect(held.store.getSnapshot().detail?.track.id).toBe("43");
    held.store.dispose();
  });

  test("随机播放 leaves the track it just played and keeps the pass honest", async () => {
    const held = harness();
    held.store.setPlayOrder("shuffle");
    held.store.setQueue([TRACK, SECOND], "我的歌单");
    await playing(held, TRACK);

    // A two-track pass anchored on what is playing has exactly one answer, so
    // this holds for every seed: the other track, never the same one again.
    finishTrack(held);
    await held.advance(0);
    expect(held.store.getSnapshot().detail?.track.id).toBe("43");
    held.store.dispose();
  });

  test("skipping while the music plays keeps it playing", async () => {
    const held = harness();
    held.store.setQueue([TRACK, SECOND], "我的歌单");
    await playing(held, TRACK);

    held.store.skip(1);
    await held.advance(0);
    expect(held.store.getSnapshot().playing).toBe(true);
    held.store.dispose();
  });

  test("skipping while paused loads the next track and leaves it paused", async () => {
    const held = harness();
    held.store.setQueue([TRACK, SECOND], "我的歌单");
    await held.store.select(TRACK);

    held.store.skip(1);
    await held.advance(0);
    expect(held.store.getSnapshot().detail?.track.id).toBe("43");
    expect(held.store.getSnapshot().playing).toBe(false);
    held.store.dispose();
  });

  test("with the music firmware playing, a skip tells the clock to play on", async () => {
    const held = harness();
    held.setStateDoc({ HBAGE: 200, DTRACK: "42", DPLAY: 1_000, DPLAYING: 1 });
    held.store.setQueue([TRACK, SECOND], "我的歌单");
    await held.store.select(TRACK);
    await held.advance(3_000);
    expect(held.store.getSnapshot().deviceOnline).toBe(true);
    expect(held.store.getSnapshot().playing).toBe(true);

    // The TC002 is the player here and local audio stays silent, so the browser
    // gets no "ended" — the queue moves on the button, and the resumed play has
    // to reach the device as a control rather than as an element.play().
    held.store.skip(1);
    await held.advance(0);

    expect(held.bodies("/api/music/device/select").at(-1)).toEqual({ trackId: "43" });
    expect(held.bodies("/api/music/device/control")).toContainEqual({ playing: true });
    expect(held.audio.playCalls).toBe(0);
    held.store.dispose();
  });

  test("Connect keeps its own play mode — the studio does not advance its queue", async () => {
    const held = harness();
    held.store.setSource("spotify", "remote");
    held.store.setQueue([TRACK, SECOND], "我的歌单");
    await held.store.select(TRACK);

    finishTrack(held);
    await held.advance(0);
    expect(held.bodies("/api/music/remote")).toEqual([]);

    held.store.skip(1);
    await held.advance(0);
    expect(held.bodies("/api/music/remote")).toEqual([{ action: "next" }]);
    held.store.dispose();
  });
});
