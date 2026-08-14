import { describe, expect, test } from "bun:test";
import {
  artworkFor,
  attachMediaSession,
  createMediaSessionBridge,
  defaultMediaSessionPort,
  mediaSessionMetadata,
  mediaSessionPlaybackState,
  mediaSessionPositionState,
  MEDIA_SESSION_ACTIONS,
  musicArtworkSrc,
  type MediaMetadataInitLike,
  type MediaSessionBridge,
  type MediaPositionStateLike,
  type MediaSessionActionName,
  type MediaSessionLike,
  type MediaSessionPlaybackStateLike,
  type MediaSessionPort,
  type MediaSessionSource,
} from "../web/src/lib/media-session";
import type { MusicPlaybackSnapshot } from "../web/src/lib/music-playback-store";
import type { MusicTrack } from "../web/src/types";

/**
 * The lock screen used to say "Pixel Market · Ulanzi TC002" because nothing in
 * this codebase had ever touched `navigator.mediaSession`. These tests hold the
 * fix without a browser: every payload is a pure function over a playback
 * snapshot, and the bridge drives a recorder in place of the real session.
 *
 * The guards around `setPositionState` get the most room on purpose. It throws
 * on a non-finite or zero duration and on a position outside the track, both of
 * which this player produces routinely (a media element's duration is NaN until
 * `loadedmetadata`), and it is called from the store's 100 ms tick — so an
 * exception there would stop the playhead, not just the progress bar.
 */

function track(over: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: "t1",
    title: "反方向的钟",
    artists: ["周杰伦"],
    album: "范特西",
    durationMs: 260_000,
    coverUrl: "https://p1.music.126.net/cover.jpg?param=200y200",
    ...over,
  };
}

function snapshot(over: Partial<MusicPlaybackSnapshot> = {}): MusicPlaybackSnapshot {
  return {
    provider: "netease",
    playbackMode: "device-audio",
    playOrder: "sequence",
    // Two, so the default fixture is a queue you can actually skip inside. The
    // one-track case is its own test now that it decides whether the island
    // even gets arrows.
    queue: [track(), track({ id: "t9", title: "晴天" })],
    queueLabel: "搜索结果",
    queueIndex: 0,
    detail: { track: track(), lyrics: [] },
    positionMs: 12_000,
    durationMs: 260_000,
    playing: true,
    loading: false,
    error: null,
    deviceOnline: false,
    deviceTrackId: null,
    remoteLive: false,
    ...over,
  };
}

/** Records every write the bridge makes, the way a real session would take it. */
class FakeSession implements MediaSessionLike {
  private currentMetadata: unknown = null;
  private currentState: MediaSessionPlaybackStateLike = "none";
  readonly metadataWrites: unknown[] = [];
  readonly stateWrites: MediaSessionPlaybackStateLike[] = [];
  readonly positionWrites: (MediaPositionStateLike | undefined)[] = [];
  readonly handlerWrites: [string, boolean][] = [];
  readonly handlers = new Map<
    string,
    ((details: { seekTime?: number }) => void) | null
  >();

  get metadata(): unknown {
    return this.currentMetadata;
  }

  set metadata(value: unknown) {
    this.currentMetadata = value;
    this.metadataWrites.push(value);
  }

  get playbackState(): MediaSessionPlaybackStateLike {
    return this.currentState;
  }

  set playbackState(value: MediaSessionPlaybackStateLike) {
    this.currentState = value;
    this.stateWrites.push(value);
  }

  setActionHandler(
    action: string,
    handler: ((details: { seekTime?: number }) => void) | null,
  ): void {
    this.handlerWrites.push([action, handler !== null]);
    this.handlers.set(action, handler);
  }

  setPositionState(state?: MediaPositionStateLike): void {
    this.positionWrites.push(state);
  }

  fire(action: MediaSessionActionName, details: { seekTime?: number } = {}): void {
    const handler = this.handlers.get(action);
    if (!handler) throw new Error(`no handler for ${action}`);
    handler(details);
  }
}

interface Harness {
  source: MediaSessionSource;
  session: FakeSession;
  port: MediaSessionPort;
  /** What the transport was asked to do, in order. */
  commands: string[];
  /** The init dictionaries handed to `new MediaMetadata(...)`. */
  inits: MediaMetadataInitLike[];
  push(over: Partial<MusicPlaybackSnapshot>): void;
  advance(ms: number): void;
  clock(): number;
}

function harness(initial: MusicPlaybackSnapshot = snapshot()): Harness {
  let current = initial;
  let clock = 1_000;
  const listeners = new Set<() => void>();
  const commands: string[] = [];
  const inits: MediaMetadataInitLike[] = [];
  const session = new FakeSession();

  return {
    session,
    commands,
    inits,
    source: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => current,
      toggle: async () => {
        commands.push("toggle");
      },
      skip: (direction) => {
        commands.push(`skip:${direction}`);
      },
      seek: (positionMs) => {
        commands.push(`seek:${positionMs}`);
      },
    },
    port: {
      session,
      createMetadata: (init) => {
        inits.push(init);
        // A real MediaMetadata is an opaque object; an identity of our own is
        // all the bridge is allowed to care about.
        return { metadataFor: init.title };
      },
      origin: "http://192.168.1.9:43820",
    },
    push(over) {
      current = { ...current, ...over };
      for (const listener of listeners) listener();
    },
    advance(ms) {
      clock += ms;
    },
    clock: () => clock,
  };
}

/**
 * `attachMediaSession` with a clock we control — the store notifies on its own
 * 100 ms tick, and the position guard's whole job is to decide which of those
 * notifications is worth a call.
 */
function wire(bench: Harness): MediaSessionBridge {
  const bridge = createMediaSessionBridge(bench.source, bench.port, { now: bench.clock });
  bench.source.subscribe(bridge.sync);
  bridge.sync();
  return bridge;
}

describe("media session — what the island says", () => {
  test("the three text fields come straight off the track", () => {
    const metadata = mediaSessionMetadata(snapshot());
    expect(metadata?.title).toBe("反方向的钟");
    expect(metadata?.artist).toBe("周杰伦");
    expect(metadata?.album).toBe("范特西");
  });

  test("several artists read the way every other surface prints them", () => {
    // The mini player, the music view and the device report all join on " / ".
    // A fourth spelling here would show up as the lock screen disagreeing with
    // the page it came from.
    const metadata = mediaSessionMetadata(
      snapshot({ detail: { track: track({ artists: ["林俊杰", "孙燕姿"] }), lyrics: [] } }),
    );
    expect(metadata?.artist).toBe("林俊杰 / 孙燕姿");
  });

  test("a nameless artist is said out loud, not left blank", () => {
    const metadata = mediaSessionMetadata(
      snapshot({ detail: { track: track({ artists: [] }), lyrics: [] } }),
    );
    expect(metadata?.artist).toBe("未知音乐人");
  });

  test("nothing loaded is null, which is the caller's signal to tear down", () => {
    expect(mediaSessionMetadata(snapshot({ detail: null }))).toBeNull();
  });

  test("a track still fetching keeps the previous song on the island", () => {
    // `loading` with the last detail still in place is the gap between the click
    // and the answer. Blanking the card there would flicker every skip.
    const metadata = mediaSessionMetadata(snapshot({ loading: true }));
    expect(metadata?.title).toBe("反方向的钟");
  });
});

describe("media session — the artwork", () => {
  test("it goes through the same-origin proxy, url-encoded", () => {
    // The console's CSP is `img-src 'self' blob:`; a provider CDN URL is not
    // fetchable from this page, and this is the same expression the mini player
    // and the music view build.
    expect(musicArtworkSrc("https://p1.music.126.net/cover.jpg?param=200y200"))
      .toBe("/api/music/art?url=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg%3Fparam%3D200y200");
  });

  test("the origin makes it absolute, because the UA fetches it out of band", () => {
    const artwork = artworkFor(track(), "netease", "http://192.168.1.9:43820");
    expect(artwork[0]?.src).toBe(
      "http://192.168.1.9:43820/api/music/art?url=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg%3Fparam%3D200y200",
    );
  });

  test("no cover means no entry at all, never an empty src", () => {
    expect(artworkFor(track({ coverUrl: undefined }), "netease")).toEqual([]);
    expect(mediaSessionMetadata(
      snapshot({ detail: { track: track({ coverUrl: undefined }), lyrics: [] } }),
    )?.artwork).toEqual([]);
  });

  test("one entry per cover — a second one only buys a second fetch", () => {
    expect(artworkFor(track(), "netease")).toHaveLength(1);
  });

  test("`sizes` is stated only where it is true", () => {
    // Spotify's images[0] is documented as the largest and is 640×640; NetEase's
    // picUrl has no documented size and this codebase never rescales it, so the
    // honest answer there is to say nothing.
    expect(artworkFor(track(), "spotify")[0]?.sizes).toBe("640x640");
    expect(artworkFor(track(), "netease")[0]?.sizes).toBeUndefined();
  });
});

describe("media session — playbackState", () => {
  test("it follows the store, not the element", () => {
    // Two of the three transports (music firmware, Spotify Connect) make no
    // sound in this browser at all, so WebKit's own element tracking would say
    // "paused" while the clock is singing.
    expect(mediaSessionPlaybackState(snapshot())).toBe("playing");
    expect(mediaSessionPlaybackState(snapshot({ playing: false }))).toBe("paused");
    expect(mediaSessionPlaybackState(
      snapshot({ playbackMode: "remote", remoteLive: true }),
    )).toBe("playing");
  });

  test("nothing loaded is `none`", () => {
    expect(mediaSessionPlaybackState(snapshot({ detail: null }))).toBe("none");
  });
});

describe("media session — every setPositionState guard", () => {
  test("milliseconds become seconds, and the rate is always 1", () => {
    expect(mediaSessionPositionState(snapshot())).toEqual({
      duration: 260,
      position: 12,
      playbackRate: 1,
    });
  });

  test("a NaN duration is refused, because that is what an unloaded element has", () => {
    // element.duration is NaN until `loadedmetadata`; effectiveDurationMs falls
    // through to the track's own length, which is NaN here too.
    const state = mediaSessionPositionState(snapshot({
      durationMs: Number.NaN,
      detail: { track: track({ durationMs: Number.NaN }), lyrics: [] },
    }));
    expect(state).toBeNull();
  });

  test("an infinite duration is refused — a live stream has one", () => {
    expect(mediaSessionPositionState(snapshot({ durationMs: Number.POSITIVE_INFINITY })))
      .toBeNull();
  });

  test("a zero duration is refused, which is every track before its detail lands", () => {
    // Zero does not throw by itself, but any non-zero position paired with it
    // does, and a zero-length bar says nothing anyway.
    expect(mediaSessionPositionState(snapshot({
      durationMs: 0,
      detail: { track: track({ durationMs: 0 }), lyrics: [] },
    }))).toBeNull();
  });

  test("a NaN position is refused", () => {
    expect(mediaSessionPositionState(snapshot({ positionMs: Number.NaN }))).toBeNull();
  });

  test("a position past the end is clamped, not thrown away", () => {
    // The device clock extrapolates at wall-clock speed between heartbeats, so
    // it routinely runs a second or two past the last bar of a track.
    expect(mediaSessionPositionState(snapshot({ positionMs: 999_000 }))?.position).toBe(260);
  });

  test("a negative position is clamped to zero", () => {
    expect(mediaSessionPositionState(snapshot({ positionMs: -5_000 }))?.position).toBe(0);
  });

  test("the element's duration wins over the track's once it is known", () => {
    // effectiveDurationMs prefers the loaded value; a provider that lies about
    // the length would otherwise make the bar end early.
    const state = mediaSessionPositionState(snapshot({ durationMs: 240_000 }));
    expect(state?.duration).toBe(240);
  });
});

describe("media session — the bridge", () => {
  test("a first track installs metadata, state, position and every handler", () => {
    const bench = harness();
    wire(bench);

    expect(bench.inits).toHaveLength(1);
    expect(bench.inits[0]?.title).toBe("反方向的钟");
    expect(bench.session.metadata).toEqual({ metadataFor: "反方向的钟" });
    expect(bench.session.playbackState).toBe("playing");
    expect(bench.session.positionWrites).toEqual([
      { duration: 260, position: 12, playbackRate: 1 },
    ]);
    // prev/next are the whole reason the island showed ±10 s: without a handler
    // WebKit fills those two slots with its own default seek.
    expect([...bench.session.handlers.keys()].sort())
      .toEqual([...MEDIA_SESSION_ACTIONS].sort());
    expect(bench.session.handlerWrites.every(([, installed]) => installed)).toBe(true);
  });

  test("pause and resume move the state without rewriting the song", () => {
    const bench = harness();
    wire(bench);
    bench.push({ playing: false });
    bench.push({ playing: true });

    expect(bench.session.stateWrites).toEqual(["playing", "paused", "playing"]);
    // One MediaMetadata for one song: the card must not flicker every time the
    // user touches the play button.
    expect(bench.inits).toHaveLength(1);
  });

  test("a new track gets its own metadata, and keeps the handlers it had", () => {
    const bench = harness();
    wire(bench);
    const installsAfterFirst = bench.session.handlerWrites.length;

    bench.push({
      detail: { track: track({ id: "t2", title: "晴天", album: "叶惠美" }), lyrics: [] },
      positionMs: 0,
    });

    expect(bench.inits).toHaveLength(2);
    expect(bench.inits[1]?.title).toBe("晴天");
    expect(bench.inits[1]?.album).toBe("叶惠美");
    // A fresh instance per track, because whether WebKit repaints an in-place
    // property edit is folklore.
    expect(bench.session.metadata).toEqual({ metadataFor: "晴天" });
    expect(bench.session.handlerWrites).toHaveLength(installsAfterFirst);
  });

  test("the same track re-reported is not a change", () => {
    // The store patches ten times a second and re-emits the same detail every
    // time; a new MediaMetadata per tick would be 600 objects a minute.
    const bench = harness();
    wire(bench);
    for (let step = 0; step < 20; step += 1) {
      bench.advance(100);
      bench.push({ positionMs: 12_000 + step * 100 });
    }
    expect(bench.inits).toHaveLength(1);
  });

  test("an ordinary playhead is left to the UA; a seek is republished", () => {
    const bench = harness();
    wire(bench);
    expect(bench.session.positionWrites).toHaveLength(1);

    // A second of wall clock, a second of playhead: exactly what the UA already
    // extrapolated from playbackRate. Saying it again buys nothing.
    bench.advance(1_000);
    bench.push({ positionMs: 13_000 });
    expect(bench.session.positionWrites).toHaveLength(1);

    // A jump the UA could not have predicted — the user dragged the bar, or the
    // device re-anchored its clock after a heartbeat.
    bench.advance(100);
    bench.push({ positionMs: 90_000 });
    expect(bench.session.positionWrites).toHaveLength(2);
    expect(bench.session.positionWrites[1]).toEqual({
      duration: 260,
      position: 90,
      playbackRate: 1,
    });
  });

  test("an unknown duration CLEARS the bar instead of leaving the last one running", () => {
    // NetEase can report dt 0, and there is also the gap between select() and
    // loadedmetadata. Bailing out looked harmless and is not: a position state
    // keeps being extrapolated by the UA until it is told otherwise, so track
    // A's bar would carry on ticking underneath track B's title. Zeroes are not
    // an option either — the spec rejects duration 0 — so the clear is the
    // argument-less call.
    const bench = harness();
    wire(bench);
    bench.push({
      durationMs: 0,
      detail: { track: track({ id: "t2", durationMs: 0 }), lyrics: [] },
      positionMs: 0,
    });
    expect(bench.session.positionWrites).toHaveLength(2);
    expect(bench.session.positionWrites.at(-1)).toBeUndefined();
    // Idempotent: a second sync in the same state must not spam the clear.
    bench.push({ positionMs: 0 });
    expect(bench.session.positionWrites).toHaveLength(2);
    // And the bar comes back once the length is known.
    bench.push({ durationMs: 200_000, positionMs: 4_000 });
    expect(bench.session.positionWrites[2]).toEqual({
      duration: 200,
      position: 4,
      playbackRate: 1,
    });
  });

  test("clearing the player clears the island", () => {
    const bench = harness();
    wire(bench);
    bench.push({ detail: null, positionMs: 0, durationMs: 0, queue: [] });

    expect(bench.session.metadata).toBeNull();
    expect(bench.session.playbackState).toBe("none");
    // No argument at all: per spec that is the only way to CLEAR a position
    // state, and a stale bar under a stale song is exactly what this fixes.
    // Two writes, the second of them the clear — an empty list would mean the
    // bar was simply never touched.
    // Counted, not toEqual-d against a trailing `undefined`: bun ignores a
    // trailing undefined element, so the obvious spelling of this assertion
    // passes even if teardown never clears the bar at all.
    expect(bench.session.positionWrites).toHaveLength(2);
    expect(bench.session.positionWrites.at(-1)).toBeUndefined();
    for (const action of MEDIA_SESSION_ACTIONS) {
      expect([action, bench.session.handlers.get(action)]).toEqual([action, null]);
    }
  });

  test("teardown is idempotent, and says nothing when it never owned the panel", () => {
    const bench = harness(snapshot({ detail: null }));
    const bridge = wire(bench);
    bridge.sync();
    bridge.teardown();
    expect(bench.session.metadataWrites).toEqual([]);
    expect(bench.session.handlerWrites).toEqual([]);
  });

  test("detaching hands the panel back", () => {
    const bench = harness();
    const detach = attachMediaSession(bench.source, bench.port);
    expect(bench.session.playbackState).toBe("playing");
    detach();
    expect(bench.session.metadata).toBeNull();
    expect(bench.session.playbackState).toBe("none");
    // And it really is detached: a later tick must not resurrect the card.
    bench.push({ positionMs: 40_000 });
    expect(bench.session.metadata).toBeNull();
  });
});

describe("media session — the buttons drive the real transport", () => {
  function wired(over: Partial<MusicPlaybackSnapshot> = {}): Harness {
    const bench = harness(snapshot(over));
    attachMediaSession(bench.source, bench.port);
    return bench;
  }

  test("two pauses in the same tick are one pause", () => {
    // The guard used to read snapshot.playing alone. On the local-audio path
    // that only flips on the element's own event, so a UA that sends pause
    // twice — or a headset button that bounces — would see "still playing" the
    // second time and RESUME. The latch remembers what we asked for until the
    // store agrees.
    const bench = wired();
    bench.session.fire("pause");
    bench.session.fire("pause");
    expect(bench.commands).toEqual(["toggle"]);
    // The store catches up; now the opposite direction works again.
    bench.push({ playing: false });
    bench.session.fire("play");
    expect(bench.commands).toEqual(["toggle", "toggle"]);
  });

  test("previous and next are the store's own skip", () => {
    const bench = wired();
    bench.session.fire("previoustrack");
    bench.session.fire("nexttrack");
    expect(bench.commands).toEqual(["skip:-1", "skip:1"]);
  });

  test("a queue with nowhere to skip hands the two arrows back", () => {
    // The in-page buttons already grey out on a one-track queue (mini-player:
    // "one track is not a list, and previous/next on it would just restart the
    // same song"). The island has to make the same call, and null is the spec's
    // own way to say so — it also releases the slots the platform fills with
    // its own ±10 s controls.
    const bench = wired({ queue: [track()] });
    expect(bench.session.handlers.get("nexttrack")).toBeNull();
    expect(bench.session.handlers.get("previoustrack")).toBeNull();
    // Still a real transport otherwise.
    bench.session.fire("pause");
    expect(bench.commands).toEqual(["toggle"]);

    // 加载更多 / 每日推荐 grow the queue under a playing track, so this is
    // re-evaluated on every sync, not only when the track changes.
    bench.push({ queue: [track(), track({ id: "t9" })] });
    expect(typeof bench.session.handlers.get("nexttrack")).toBe("function");
    bench.session.fire("nexttrack");
    expect(bench.commands).toEqual(["toggle", "skip:1"]);

    // And they go away again when the queue shrinks back.
    bench.push({ queue: [track()] });
    expect(bench.session.handlers.get("nexttrack")).toBeNull();
  });

  test("a Connect queue always keeps the arrows, however short the local list", () => {
    // The remote player owns its own queue; our list is not evidence of what it
    // can do next.
    const bench = wired({ playbackMode: "remote", queue: [] });
    expect(typeof bench.session.handlers.get("nexttrack")).toBe("function");
  });

  test("play and pause are directional, so a doubled action is harmless", () => {
    // The store only has toggle(). If `play` toggled blindly it would PAUSE a
    // track the UA had already resumed on its own — the classic media-session
    // inversion. Guarding on the snapshot makes both handlers idempotent.
    const playing = wired();
    playing.session.fire("play");
    expect(playing.commands).toEqual([]);
    playing.session.fire("pause");
    expect(playing.commands).toEqual(["toggle"]);

    const paused = wired({ playing: false });
    paused.session.fire("pause");
    expect(paused.commands).toEqual([]);
    paused.session.fire("play");
    expect(paused.commands).toEqual(["toggle"]);
  });

  test("stop pauses rather than dropping the queue", () => {
    // A headset's stop key means "end the session", not "forget what I queued".
    const bench = wired();
    bench.session.fire("stop");
    expect(bench.commands).toEqual(["toggle"]);
  });

  test("seekto arrives in seconds and the store wants milliseconds", () => {
    const bench = wired();
    bench.session.fire("seekto", { seekTime: 42.5 });
    expect(bench.commands).toEqual(["seek:42500"]);
  });

  test("a seekto with no usable time is ignored, not seeked to NaN", () => {
    const bench = wired();
    bench.session.fire("seekto", {});
    bench.session.fire("seekto", { seekTime: Number.NaN });
    expect(bench.commands).toEqual([]);
  });
});

describe("media session — nothing here may cost us the player", () => {
  test("a session that throws on every call still leaves playback alone", () => {
    // Safari has validated beyond the spec before. This bridge runs inside the
    // store's subscriber list, on the 100 ms tick — an escaping exception would
    // stop the playhead and the now-playing report, not just the card.
    const angry: MediaSessionLike = {
      get metadata(): unknown {
        throw new Error("nope");
      },
      set metadata(_value: unknown) {
        throw new Error("nope");
      },
      get playbackState(): MediaSessionPlaybackStateLike {
        throw new Error("nope");
      },
      set playbackState(_value: MediaSessionPlaybackStateLike) {
        throw new Error("nope");
      },
      setActionHandler() {
        throw new TypeError("unsupported action");
      },
      setPositionState() {
        throw new TypeError("bad state");
      },
    };
    const bench = harness();
    const bridge = createMediaSessionBridge(
      bench.source,
      { session: angry, createMetadata: (init) => init },
      { now: bench.clock },
    );
    expect(() => {
      bridge.sync();
      bench.push({ playing: false });
      bench.push({ detail: null });
      bridge.teardown();
    }).not.toThrow();
  });

  test("an engine with no setPositionState still gets metadata and buttons", () => {
    // The method postdates MediaSession itself in some engines; prev/next is the
    // half the user actually asked for and must not depend on the bar.
    const installed = new Map<string, unknown>();
    const bare: MediaSessionLike = {
      metadata: null,
      playbackState: "none",
      setActionHandler: (action, handler) => {
        installed.set(action, handler);
      },
    };
    const bench = harness();
    const bridge = createMediaSessionBridge(
      bench.source,
      { session: bare, createMetadata: (init) => init },
      { now: bench.clock },
    );
    expect(() => bridge.sync()).not.toThrow();
    expect((bare.metadata as MediaMetadataInitLike).title).toBe("反方向的钟");
    expect(installed.size).toBe(MEDIA_SESSION_ACTIONS.length);
  });

  test("outside a browser there is no port, so attaching is a no-op", () => {
    // `typeof navigator === "undefined"` is NOT the guard: Bun defines a global
    // navigator, so that check passes here and the next property read would
    // explode. This assertion is what pins the three-part feature test — it
    // fails the moment someone simplifies it.
    expect(typeof navigator).toBe("object");
    expect("mediaSession" in navigator).toBe(false);
    expect(defaultMediaSessionPort()).toBeNull();

    const bench = harness();
    const detach = attachMediaSession(bench.source, null);
    expect(() => detach()).not.toThrow();
    expect(bench.session.metadataWrites).toEqual([]);
  });
});
