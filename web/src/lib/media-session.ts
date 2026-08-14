import {
  effectiveDurationMs,
  musicPlaybackStore,
  type MusicPlaybackSnapshot,
} from "@/lib/music-playback-store";
import { canSkipTracks } from "@/lib/mini-player";
import type { MusicProviderId, MusicTrack } from "@/types";

/**
 * The lock screen / 灵动岛 face of the player.
 *
 * iOS was showing "Pixel Market · Ulanzi TC002" because WebKit falls back to
 * `document.title` whenever `navigator.mediaSession.metadata` is null — the API
 * had simply never been called here. The two secondary buttons were ±10 s for
 * the same reason: with no `previoustrack` / `nexttrack` handler the UA fills
 * those slots with the only thing it can do to a media element on its own.
 *
 * Split the way lib/cover-tint.ts is. Everything that can be got wrong — which
 * field goes where, what the artwork URL is, and above all the guards that keep
 * `setPositionState` from throwing — is a pure function over a playback
 * snapshot. The bridge underneath is the twenty lines that need a browser, and
 * it takes `navigator.mediaSession` as an injected port, so the whole thing is
 * driven from `bun test` by a recorder: see test/media-session.test.ts.
 *
 * The bridge deliberately does NOT gate on "is this browser the thing making
 * sound". Only the local-audio path holds an audio session, so on the firmware
 * and Spotify Connect paths the card does not exist and setting metadata is
 * inert — but the mode can flip mid-track (the firmware goes offline and the
 * page takes over), and a card that appears already carrying the right song is
 * worth more than a saved property write.
 */

/** The action slots we claim. Spelled out so the bridge and its test agree. */
export const MEDIA_SESSION_ACTIONS = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekto",
  "stop",
] as const;

export type MediaSessionActionName = (typeof MEDIA_SESSION_ACTIONS)[number];

export type MediaSessionPlaybackStateLike = "none" | "paused" | "playing";

export interface MediaSessionArtworkLike {
  src: string;
  /** Only ever set when the size is actually known — see `artworkFor`. */
  sizes?: string;
}

export interface MediaMetadataInitLike {
  title: string;
  artist: string;
  album: string;
  artwork: MediaSessionArtworkLike[];
}

export interface MediaPositionStateLike {
  duration: number;
  position: number;
  playbackRate: number;
}

/** The one field of the action details we use; `seekTime` is in SECONDS. */
export interface MediaSessionActionDetailsLike {
  seekTime?: number;
}

/** The subset of `navigator.mediaSession` this bridge drives. */
export interface MediaSessionLike {
  metadata: unknown;
  playbackState: MediaSessionPlaybackStateLike;
  setActionHandler(
    action: string,
    handler: ((details: MediaSessionActionDetailsLike) => void) | null,
  ): void;
  /** Optional: it postdates MediaSession itself in some engines. */
  setPositionState?(state?: MediaPositionStateLike): void;
}

export interface MediaSessionPort {
  session: MediaSessionLike;
  /** `new MediaMetadata(init)`. A separate global, so it is a separate port. */
  createMetadata(init: MediaMetadataInitLike): unknown;
  /** Page origin, so artwork resolves absolutely rather than against a base. */
  origin?: string;
}

/** The parts of the player the lock screen reads and drives. */
export interface MediaSessionSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): MusicPlaybackSnapshot;
  toggle(): Promise<void>;
  skip(direction: -1 | 1): void;
  seek(positionMs: number): void;
}

/** Same fallback as the player, the mini player and the device report. */
const UNKNOWN_ARTIST = "未知音乐人";

/**
 * How far the playhead may drift from what the UA would extrapolate before we
 * republish it. The store patches `positionMs` ten times a second; calling
 * `setPositionState` at that rate is both wasteful and, per the platform
 * guidance, wrong — the UA advances the bar itself from `playbackRate`. What it
 * cannot predict is a seek or the device re-anchoring its clock, and both move
 * the playhead by far more than this.
 */
const POSITION_DRIFT_SEC = 1.5;

// ---- pure: snapshot → payloads ---------------------------------------------

/**
 * The same-origin cover proxy. The console's CSP is `img-src 'self' blob:`, so
 * a provider CDN URL is blocked in the page; whether that CSP also governs the
 * UA's own out-of-band artwork fetch is not written down anywhere, and routing
 * through the proxy makes the question moot. The expression is duplicated in
 * music-player.tsx and lib/mini-player.ts — keep the three in step.
 */
export function musicArtworkSrc(coverUrl: string, origin = ""): string {
  const path = `/api/music/art?url=${encodeURIComponent(coverUrl)}`;
  return origin ? `${origin}${path}` : path;
}

/**
 * One entry, or none.
 *
 * A second entry pointing at the same bytes only invites a second fetch, and
 * `sizes` is a hint for CHOOSING between entries — with one entry it does
 * nothing. So it is stated only where it is true: Spotify hands us
 * `images[0]`, which its API documents as the largest and is 640×640 in
 * practice. NetEase's `picUrl` has no documented size and this codebase never
 * appends a `?param=` suffix, so claiming one there would be a guess.
 */
export function artworkFor(
  track: MusicTrack,
  provider: MusicProviderId,
  origin = "",
): MediaSessionArtworkLike[] {
  if (!track.coverUrl) return [];
  const src = musicArtworkSrc(track.coverUrl, origin);
  return [provider === "spotify" ? { src, sizes: "640x640" } : { src }];
}

/** Null when there is nothing loaded — the caller's signal to tear down. */
export function mediaSessionMetadata(
  snapshot: MusicPlaybackSnapshot,
  options: { origin?: string } = {},
): MediaMetadataInitLike | null {
  const track = snapshot.detail?.track;
  if (!track) return null;
  return {
    title: track.title,
    artist: track.artists.join(" / ") || UNKNOWN_ARTIST,
    album: track.album,
    artwork: artworkFor(track, snapshot.provider, options.origin ?? ""),
  };
}

/**
 * WebKit already tracks the element's own play state, but two of the three
 * playback modes make no sound in this browser at all, so `playing` is the only
 * authority — say it out loud rather than letting the panel and the page
 * disagree.
 */
export function mediaSessionPlaybackState(
  snapshot: MusicPlaybackSnapshot,
): MediaSessionPlaybackStateLike {
  if (!snapshot.detail) return "none";
  return snapshot.playing ? "playing" : "paused";
}

/**
 * The position payload, or null when it must not be sent at all.
 *
 * `setPositionState` throws a TypeError on a missing, non-finite or negative
 * duration, on a position outside [0, duration], and on a zero playbackRate —
 * and this is called from the store's subscription, which sits on the 100 ms
 * tick, so an exception here would take the playhead and the now-playing report
 * down with it. Both bad inputs are real: `element.duration` is NaN until
 * `loadedmetadata` (Infinity for a stream), and `effectiveDurationMs` returns 0
 * while the detail is still in flight. Returning null keeps the last good bar
 * on screen, which beats clearing it every time a track loads.
 */
export function mediaSessionPositionState(
  snapshot: MusicPlaybackSnapshot,
): MediaPositionStateLike | null {
  const duration = effectiveDurationMs(snapshot) / 1_000;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const position = snapshot.positionMs / 1_000;
  if (!Number.isFinite(position)) return null;
  return {
    duration,
    // Clamped rather than trusted: the device clock interpolates past the end
    // of a track between the last heartbeat and the next select.
    position: Math.min(Math.max(position, 0), duration),
    // Nothing in this player ever changes speed, and 0 is the one value the
    // spec rejects outright.
    playbackRate: 1,
  };
}

// ---- the bridge -------------------------------------------------------------

export interface MediaSessionBridge {
  /** Push whatever changed since the last call. Idempotent. */
  sync(): void;
  /** Hand the panel back: metadata, state, position and every handler. */
  teardown(): void;
}

/**
 * Swallow anything the platform throws.
 *
 * `setActionHandler` rejects an action name the engine does not know (the
 * argument is a WebIDL enum), and Safari has been known to validate beyond the
 * spec elsewhere. A wrong progress bar is a blemish; an exception escaping into
 * the store's subscriber list would stop playback.
 */
function safely(run: () => void): void {
  try {
    run();
  } catch {
    // The panel is decoration. Losing it must never cost the player.
  }
}

export function createMediaSessionBridge(
  source: MediaSessionSource,
  port: MediaSessionPort,
  options: { now?: () => number } = {},
): MediaSessionBridge {
  const now = options.now ?? (() => Date.now());

  let metadataKey: string | null = null;
  let playbackState: MediaSessionPlaybackStateLike | null = null;
  let positionKey: string | null = null;
  let published: { position: number; at: number } | null = null;
  let handlersInstalled = false;
  let skipInstalled = false;
  // What we last ASKED for, until the store agrees. The local-audio path only
  // flips `playing` on the element's event, so two pause presses inside that
  // window would both read "still playing" and the second would resume.
  let intent: boolean | null = null;

  /**
   * Directional, never `toggle()`.
   *
   * The store only has a toggle, but the panel's actions are one-way: a `play`
   * that flipped state would land on "pause" if the UA had already resumed the
   * element itself, which it is allowed to do. Guarding on the snapshot makes
   * each handler idempotent — pressing play on something already playing does
   * nothing, which is the whole contract.
   */
  /** Reads the intent latch first, so a doubled action really is idempotent. */
  const wants = (playing: boolean) => {
    if ((intent ?? source.getSnapshot().playing) === playing) return;
    intent = playing;
    void source.toggle();
  };

  const handlers: Record<
    MediaSessionActionName,
    (details: MediaSessionActionDetailsLike) => void
  > = {
    play: () => wants(true),
    pause: () => wants(false),
    previoustrack: () => source.skip(-1),
    nexttrack: () => source.skip(1),
    seekto: (details) => {
      const seconds = details?.seekTime;
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) return;
      source.seek(seconds * 1_000);
    },
    // There is no stop in this player and inventing one would mean dropping the
    // queue, which is not what a headset's stop key asks for. Pausing is the
    // honest neighbour: the session ends, the queue survives.
    stop: () => wants(false),
  };

  /**
   * `skippable` is separate because the two skip actions come and go with the
   * queue: null is the spec's own way to say "this transport cannot do that",
   * and the UA greys the arrow out instead of leaving a button that would
   * restart the current song. It also hands those two slots back, which is
   * where the platform's ±10 s controls live.
   */
  const setHandlers = (install: boolean, skippable = false) => {
    for (const action of MEDIA_SESSION_ACTIONS) {
      const live = install
        && (action === "previoustrack" || action === "nexttrack" ? skippable : true);
      // One try/catch per action: an engine that does not know `seekto` must
      // not cost us prev/next, which is what the user actually asked for.
      safely(() => port.session.setActionHandler(action, live ? handlers[action] : null));
    }
    handlersInstalled = install;
    skipInstalled = install && skippable;
  };

  /** Forget what we published, and tell the UA to stop extrapolating from it. */
  const clearPosition = () => {
    if (positionKey === null && published === null) return;
    positionKey = null;
    published = null;
    safely(() => port.session.setPositionState?.());
  };

  const publishPosition = (snapshot: MusicPlaybackSnapshot) => {
    const next = mediaSessionPositionState(snapshot);
    // A track whose duration we do not know yet (NetEase can report 0) must
    // CLEAR the bar, not leave the previous track's state running underneath
    // the new title — the UA keeps extrapolating a position state until it is
    // told otherwise.
    if (next === null) {
      clearPosition();
      return;
    }
    const at = now();
    const key = `${snapshot.detail?.track.id ?? "-"}|${snapshot.playing ? 1 : 0}|${next.duration}`;
    if (key === positionKey && published !== null) {
      const elapsed = snapshot.playing ? (at - published.at) / 1_000 : 0;
      if (Math.abs(next.position - (published.position + elapsed)) <= POSITION_DRIFT_SEC) return;
    }
    positionKey = key;
    published = { position: next.position, at };
    safely(() => port.session.setPositionState?.(next));
  };

  const teardown = () => {
    if (metadataKey === null && !handlersInstalled) return;
    metadataKey = null;
    playbackState = null;
    intent = null;
    clearPosition();
    safely(() => {
      port.session.metadata = null;
    });
    safely(() => {
      port.session.playbackState = "none";
    });
    setHandlers(false);
  };

  const sync = () => {
    const snapshot = source.getSnapshot();
    const metadata = mediaSessionMetadata(snapshot, { origin: port.origin });
    // `detail` is the single source of truth for "is there a song": a failed
    // select leaves the previous track loaded, and that track is still what the
    // island should be showing.
    if (metadata === null) {
      teardown();
      return;
    }
    const key = `${snapshot.detail?.track.id ?? "-"}|${metadata.title}|${metadata.artist}|${metadata.artwork[0]?.src ?? "-"}`;
    if (key !== metadataKey) {
      metadataKey = key;
      // A fresh instance per track. The properties are writable, but whether
      // WebKit repaints on an in-place edit is folklore, and an object costs
      // nothing.
      safely(() => {
        port.session.metadata = port.createMetadata(metadata);
      });
    }
    // Re-evaluated every sync, not just on track change: the queue can grow
    // under a playing track (加载更多, 每日推荐) and the arrows must appear.
    const skippable = canSkipTracks(snapshot);
    if (!handlersInstalled || skippable !== skipInstalled) setHandlers(true, skippable);
    // The store caught up with what we asked for; stop second-guessing it.
    if (intent !== null && intent === snapshot.playing) intent = null;
    const nextState = mediaSessionPlaybackState(snapshot);
    if (nextState !== playbackState) {
      playbackState = nextState;
      safely(() => {
        port.session.playbackState = nextState;
      });
    }
    publishPosition(snapshot);
  };

  return { sync, teardown };
}

/**
 * The real port, or null everywhere it does not exist.
 *
 * `typeof navigator === "undefined"` is NOT enough: Bun defines a global
 * `navigator`, so that check passes under `bun test` and the next line explodes.
 * All three tests are load-bearing — the object, the member, and the separate
 * `MediaMetadata` constructor.
 */
export function defaultMediaSessionPort(): MediaSessionPort | null {
  if (typeof navigator === "undefined") return null;
  if (!("mediaSession" in navigator)) return null;
  if (typeof MediaMetadata === "undefined") return null;
  return {
    session: navigator.mediaSession as unknown as MediaSessionLike,
    createMetadata: (init) => new MediaMetadata(init),
    origin: typeof location === "undefined" ? undefined : location.origin,
  };
}

/**
 * Wire the page's player to the page's media session. Returns the detach.
 *
 * Called once from main.tsx, not from a view: the store is a module singleton
 * and playback outlives every tab switch, so the lock screen has to as well.
 * Subscription only — reading `getSnapshot()` imperatively — because this runs
 * at the store's 10 Hz tick and must not put a React component on that path.
 */
export function attachMediaSession(
  source: MediaSessionSource = musicPlaybackStore(),
  port: MediaSessionPort | null = defaultMediaSessionPort(),
): () => void {
  if (!port) return () => {};
  const bridge = createMediaSessionBridge(source, port);
  const unsubscribe = source.subscribe(bridge.sync);
  bridge.sync();
  return () => {
    unsubscribe();
    bridge.teardown();
  };
}
