import {
  activeLyricIndexAt,
  clampPlaybackPositionMs,
  nowPlayingBody,
} from "@/lib/music-playback";
import {
  nextMusicPlayOrder,
  nextQueueMove,
  readStoredPlayOrder,
  shufflePassFrom,
  writeStoredPlayOrder,
  type MusicPlayOrder,
  type QueueMoveReason,
} from "@/lib/music-play-order";
import { errorMessage } from "@/lib/utils";
import type {
  MusicPlaybackMode,
  MusicProviderId,
  MusicTrack,
  MusicTrackDetail,
} from "@/types";

/**
 * Playback, lifted out of the music view.
 *
 * The `<audio>` element used to live inside the music tab's tree, so switching
 * to 内容 unmounted it and every piece of state around it. Nothing was being
 * "forgotten": the player was being demolished and rebuilt empty. Playback is
 * a page-lifetime resource — one element, one queue, one playhead — so it lives
 * here, outside React, and the views subscribe to it.
 *
 * Everything that talks to the network or to the media element goes through an
 * injected port, which is what lets the whole transport be exercised from
 * `bun test` with no browser: see test/music-playback-store.test.ts.
 */

/** The subset of HTMLAudioElement this store drives. */
export interface AudioElementLike {
  src: string;
  preload: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly readyState: number;
  load(): void;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, handler: () => void): void;
}

export interface MusicPlaybackSnapshot {
  /** Which source the loaded track belongs to. */
  provider: MusicProviderId;
  /** "remote" = a Spotify Connect player owns the audio, not this browser. */
  playbackMode: MusicPlaybackMode;
  /** The list previous/next walks — the library list the user is looking at. */
  queue: readonly MusicTrack[];
  /** What that list is ("搜索结果", a playlist name); the library heading. */
  queueLabel: string;
  /** Where we are in the queue, or -1 when the track is not in it. */
  queueIndex: number;
  /** 播放模式 — the rule the queue advances by. See lib/music-play-order.ts. */
  playOrder: MusicPlayOrder;
  /** The loaded track and its lyrics. */
  detail: MusicTrackDetail | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  /** A track detail is being fetched. */
  loading: boolean;
  /** The last transport failure, in the user's words. */
  error: string | null;
  /** The sideloaded music firmware is heartbeating — the TC002 is the player. */
  deviceOnline: boolean;
  /** Which track that firmware says it is playing. */
  deviceTrackId: string | null;
  /** A Connect player answered with a position on the last poll. */
  remoteLive: boolean;
}

/** The parsed `/api/music/device/state` document, for the view's own concerns. */
export interface DeviceStateMeta {
  /** First delivery to this listener — adopt the served theme wholesale. */
  initial: boolean;
  /** The sequence advanced and the change was not ours: a device key press. */
  themeEcho: boolean;
}

export type DeviceStateListener = (
  fields: Readonly<Record<string, string>>,
  meta: DeviceStateMeta,
) => void;

export interface MusicPlaybackStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): MusicPlaybackSnapshot;
  /**
   * Keep the device-state poll running while a view is mounted. The poll also
   * runs on its own whenever a track is loaded, so the mini player stays honest
   * about a Connect player someone is driving from their phone.
   */
  retain(): () => void;
  /** Which source the transport belongs to; the view owns the switch itself. */
  setSource(provider: MusicProviderId, playbackMode: MusicPlaybackMode): void;
  setQueue(tracks: readonly MusicTrack[], label: string): void;
  /**
   * Load a track. `autoplay` continues an already-running session — the queue
   * advancing — rather than starting one, so it needs no user gesture of its
   * own; a click in the library leaves it off and waits for the play button.
   */
  select(track: MusicTrack, options?: { autoplay?: boolean }): Promise<void>;
  toggle(): Promise<void>;
  skip(direction: -1 | 1): void;
  /** Set 播放模式; remembered across reloads. */
  setPlayOrder(order: MusicPlayOrder): void;
  /** 顺序播放 → 单曲循环 → 随机播放 → 顺序播放, for the transport button. */
  cyclePlayOrder(): void;
  seek(positionMs: number): void;
  /** Forget the previous source's tracks, selection and pending seeks. */
  clear(): void;
  /**
   * Surface a transport failure the view found (a Connect device list that
   * would not load, a transfer that was refused) in the same banner the store's
   * own failures use — the user has one player, so one place to be told.
   */
  setError(message: string | null): void;
  /** Report the current line to the clock's own music page (ZOS only). */
  setNowPlayingReporting(enabled: boolean): void;
  /** Push a control patch to the device; the store owns the echo bookkeeping. */
  postControl(patch: Record<string, unknown>): void;
  /** Watch the raw state document (theme echo and source drift stay in the view). */
  onDeviceState(listener: DeviceStateListener): () => void;
  dispose(): void;
}

export interface MusicPlaybackStoreOptions {
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Returns null where there is no DOM (tests, SSR) — the store stays silent. */
  createAudio?: () => AudioElementLike | null;
  setInterval?: (handler: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
  now?: () => number;
  /** Injected so a 随机播放 pass is reproducible under test. */
  random?: () => number;
}

/** One coarse timer drives interpolation, polling and reporting. */
const TICK_MS = 100;
/** Device state cadence, unchanged from when the music view owned the poll. */
const POLL_MS = 2_500;
/**
 * Report cadence. Four seconds sits well inside the hub's 15 s staleness
 * window, so a tab that dies without firing pagehide releases the panel on its
 * own rather than pinning the last lyric there forever.
 */
const REPORT_MS = 4_000;
/** HTMLMediaElement.HAVE_METADATA, spelled out for non-DOM runtimes. */
const HAVE_METADATA = 1;
const AUDIO_ERROR = "音频没有载入。歌曲可能受版权、会员或地区限制。";
const DEFAULT_QUEUE_LABEL = "搜索结果";

const INITIAL: MusicPlaybackSnapshot = {
  provider: "netease",
  playbackMode: "device-audio",
  queue: [],
  queueLabel: DEFAULT_QUEUE_LABEL,
  queueIndex: -1,
  playOrder: "sequence",
  detail: null,
  positionMs: 0,
  durationMs: 0,
  playing: false,
  loading: false,
  error: null,
  deviceOnline: false,
  deviceTrackId: null,
  remoteLive: false,
};

/** Track length once the media element has answered, else what the source said. */
export function effectiveDurationMs(snapshot: MusicPlaybackSnapshot): number {
  return snapshot.durationMs > 0
    ? snapshot.durationMs
    : snapshot.detail?.track.durationMs ?? 0;
}

/**
 * The music firmware is online but still downloading the track we selected.
 * Only the device-audio path has a download to wait for; in remote mode the
 * Connect player is already playing while the clock fetches lyrics.
 */
export function deviceIsLoadingTrack(snapshot: MusicPlaybackSnapshot): boolean {
  return snapshot.playbackMode !== "remote"
    && snapshot.deviceOnline
    && snapshot.detail !== null
    && snapshot.deviceTrackId !== snapshot.detail.track.id;
}

function defaultCreateAudio(): AudioElementLike | null {
  if (typeof document === "undefined") return null;
  return document.createElement("audio");
}

async function describeFailure(response: Response): Promise<string> {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // A non-JSON body still leaves the HTTP status above.
  }
  return message;
}

function parseStateDocument(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) fields[line.slice(0, tab)] = line.slice(tab + 1).trim();
  }
  return fields;
}

export function createMusicPlaybackStore(
  options: MusicPlaybackStoreOptions = {},
): MusicPlaybackStore {
  const fetcher = options.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const createAudio = options.createAudio ?? defaultCreateAudio;
  const startTimer = options.setInterval
    ?? ((handler: () => void, ms: number) => window.setInterval(handler, ms));
  const stopTimer = options.clearInterval ?? ((id: number) => window.clearInterval(id));
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());

  // The mode is the one thing here that survives a reload: it is a preference,
  // not a playhead, and it changes nothing until the queue next moves.
  let state: MusicPlaybackSnapshot = { ...INITIAL, playOrder: readStoredPlayOrder() };
  let disposed = false;
  const listeners = new Set<() => void>();
  const deviceListeners = new Set<{ fn: DeviceStateListener; delivered: boolean }>();

  let media: AudioElementLike | null = null;
  let mediaFailed = false;
  let leases = 0;
  let timer: number | null = null;
  let lastPollAt = 0;
  let lastReportAt = 0;
  let polling = false;
  let reportingEnabled = false;
  let reportedKey: string | null = null;
  // True while the last thing this page PUT was an actual track, i.e. while it
  // is the console page the panel is showing. The hub has one "console" owner
  // for every tab, so this is what keeps one page from clearing another's.
  let panelOwned = false;
  let lastFields: Record<string, string> | null = null;
  let adoptingTrackId: string | null = null;
  // The 随机播放 pass: a permutation of queue indices, walked to its end before
  // any track can come back. Rebuilt whenever the queue it describes changes.
  let shufflePass: readonly number[] = [];

  // A seek issued before the media element had metadata; replayed on load.
  let pendingLocalSeekMs: number | null = null;
  // A device seek heartbeats have not confirmed yet.
  let pendingDeviceSeek: { targetMs: number; at: number } | null = null;
  let lastSentSeekMs: number | null = null;
  let lastLocalSeq = 0;
  let lastSeenSeq = 0;
  // The device's (or Connect player's) playhead when we last heard from it;
  // the tick interpolates from here so the preview tracks real playback
  // instead of racing ahead of push + download + play latency.
  let deviceClock = {
    playheadMs: 0,
    fetchedAt: 0,
    playing: false,
    trackId: null as string | null,
  };

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const indexOfTrack = (queue: readonly MusicTrack[], trackId: string | null): number =>
    trackId === null ? -1 : queue.findIndex((track) => track.id === trackId);

  const patch = (next: Partial<MusicPlaybackSnapshot>) => {
    if (disposed) return;
    let changed = false;
    for (const key of Object.keys(next) as (keyof MusicPlaybackSnapshot)[]) {
      if (next[key] !== state[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...next };
    syncTimer();
    syncNowPlaying();
    emit();
  };

  // ---- the one timer -------------------------------------------------------

  /** Poll while a view is mounted, or while a track is loaded (the mini player). */
  const shouldRun = (): boolean => !disposed && (leases > 0 || state.detail !== null);

  const syncTimer = () => {
    const wanted = shouldRun();
    if (wanted && timer === null) {
      // Poll immediately on the way in; the tick handles every later one.
      lastPollAt = 0;
      timer = startTimer(tick, TICK_MS);
      void poll();
    } else if (!wanted && timer !== null) {
      stopTimer(timer);
      timer = null;
    }
  };

  const tick = () => {
    const at = now();
    interpolate(at);
    if (at - lastPollAt >= POLL_MS) void poll();
    if (reportingEnabled && state.playing && at - lastReportAt >= REPORT_MS) sendReport();
  };

  /**
   * Device / remote mode: interpolate between anchors so the playhead moves at
   * wall-clock speed instead of stepping once per 2.5 s poll. Local audio needs
   * none of this — the media element's own timeupdate is the truth.
   */
  const interpolate = (at: number) => {
    if (!state.deviceOnline && !state.remoteLive) return;
    // Hold the clock while the device is still fetching a just-selected track,
    // so the previous track's stale playhead is never surfaced.
    if (deviceIsLoadingTrack(state)) return;
    let estimate = deviceClock.playheadMs
      + (deviceClock.playing ? Math.max(0, at - deviceClock.fetchedAt) : 0);
    const duration = effectiveDurationMs(state);
    if (duration > 0 && estimate > duration) estimate = duration;
    patch({ positionMs: estimate });
  };

  // ---- device state --------------------------------------------------------

  const poll = async () => {
    if (polling || disposed) return;
    polling = true;
    lastPollAt = now();
    try {
      const response = await fetcher("/api/music/device/state?viewer=web", { cache: "no-store" });
      if (!response.ok || disposed) return;
      applyDeviceState(parseStateDocument(await response.text()));
    } catch {
      // Network hiccup; retry on the next tick.
    } finally {
      polling = false;
    }
  };

  const applyDeviceState = (fields: Record<string, string>) => {
    lastFields = fields;

    // Remote (Connect) transport. The Spotify player is the clock here: RPOS
    // anchors the preview and TID follows whatever the user started, even when
    // they started it from their phone.
    const remoteSource = fields.RMT === "1";
    const remotePositionMs = Number(fields.RPOS);
    // RPOS is -1 when the service could not read the Connect player: keep the
    // last known position rather than snapping the preview to zero.
    const remoteActive = remoteSource
      && Number.isFinite(remotePositionMs) && remotePositionMs >= 0;
    patch({ remoteLive: remoteActive });
    if (remoteActive) {
      const remotePlaying = fields.RPLAY === "1";
      const remoteDurationMs = Number(fields.RDUR);
      const remoteTrackId = fields.TID && fields.TID !== "-" ? fields.TID : null;
      deviceClock = {
        playheadMs: remotePositionMs,
        fetchedAt: now(),
        playing: remotePlaying,
        trackId: remoteTrackId,
      };
      patch({
        playing: remotePlaying,
        ...(Number.isFinite(remoteDurationMs) && remoteDurationMs > 0
          ? { durationMs: remoteDurationMs }
          : {}),
      });
      if (remoteTrackId !== null && remoteTrackId !== state.detail?.track.id) {
        void adoptTrack(remoteTrackId);
      }
    }

    // Heartbeat — every poll, independent of seq. The firmware polls /state
    // every 2 s from boot, long before the first heartbeat (which only starts
    // once a track is selected), so FWPOLL is what flips the page into device
    // mode right after a sideload.
    const hbAge = Number(fields.HBAGE);
    const fwPollAge = Number(fields.FWPOLL);
    const firmwareAlive = Number.isFinite(fwPollAge) && fwPollAge >= 0 && fwPollAge < 8_000;
    // 10s window: the device pauses heartbeats while it blocks on a ~5-7s track
    // download, and we must not flip it to "offline" during that.
    const online = firmwareAlive || (Number.isFinite(hbAge) && hbAge >= 0 && hbAge < 10_000);
    patch({ deviceOnline: online });
    // In remote mode the Connect player above is the authority; the device's
    // own heartbeat only mirrors it, so it must not re-anchor the clock.
    if (online && !remoteActive) {
      const devicePlaying = fields.DPLAYING === "1";
      const dplayMs = Number(fields.DPLAY) || 0;
      const heartbeatTrackId = fields.DTRACK && fields.DTRACK !== "-" ? fields.DTRACK : null;
      // A just-sent seek: the device applies it on its own 2s poll, so a
      // heartbeat can still carry the pre-seek playhead. Keep the optimistic
      // anchor until DPLAY lands near the target, or give up after 8s.
      const pending = pendingDeviceSeek;
      const holdAnchor = pending !== null
        && now() - pending.at < 8_000
        && Math.abs(dplayMs - pending.targetMs) > 3_000;
      if (pending && !holdAnchor) pendingDeviceSeek = null;
      deviceClock = holdAnchor
        ? { ...deviceClock, playing: devicePlaying, trackId: heartbeatTrackId }
        : {
          // Anchor = device playhead when we received this response. Add the
          // heartbeat-age compensation ONLY while playing — when paused the
          // device playhead is frozen, so adding the (varying 0..2000ms)
          // heartbeat age would make the displayed time jitter back and forth.
          playheadMs: dplayMs + (devicePlaying ? Math.max(0, hbAge) : 0),
          fetchedAt: now(),
          playing: devicePlaying,
          trackId: heartbeatTrackId,
        };
      patch({ playing: devicePlaying, deviceTrackId: heartbeatTrackId });
    }

    // Control echo — only when the sequence advances and it wasn't our own
    // change. Playback echo matters in native mode only: music-firmware
    // playback is driven by the heartbeat above and local audio stays silent.
    const seq = Number(fields.SEQ);
    const advanced = Number.isFinite(seq) && seq !== lastSeenSeq;
    if (advanced) lastSeenSeq = seq;
    const themeEcho = advanced && seq !== lastLocalSeq;
    if (themeEcho && !online && !remoteActive) {
      const devicePlaying = fields.PLAY === "1";
      patch({ playing: devicePlaying });
      if (media) {
        if (devicePlaying && media.paused) void media.play().catch(() => {});
        else if (!devicePlaying && !media.paused) media.pause();
      }
    }

    for (const entry of deviceListeners) {
      const initial = !entry.delivered;
      entry.delivered = true;
      entry.fn(fields, { initial, themeEcho });
    }
  };

  /**
   * Follow a track the Connect player moved to on its own (someone hit next on
   * their phone) so the lyric view keeps up without a click in the studio.
   */
  const adoptTrack = async (trackId: string) => {
    // The poll keeps saying "TID is X" for as long as the fetch is in flight;
    // without this every 2.5 s tick would start another one.
    if (adoptingTrackId === trackId) return;
    adoptingTrackId = trackId;
    try {
      const detail = await requestJson<{ detail: MusicTrackDetail }>(
        `/api/music/tracks/${trackId}`,
      );
      patch({
        detail: detail.detail,
        durationMs: detail.detail.track.durationMs,
        queueIndex: indexOfTrack(state.queue, trackId),
        error: null,
      });
    } catch (error) {
      patch({ error: errorMessage(error) });
    } finally {
      if (adoptingTrackId === trackId) adoptingTrackId = null;
    }
  };

  // ---- transport -----------------------------------------------------------

  const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(path, init);
    if (!response.ok) throw new Error(await describeFailure(response));
    return await response.json() as T;
  };

  const postJson = (path: string, body: unknown): Promise<unknown> => requestJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const postRemote = async (patchBody: Record<string, unknown>) => {
    patch({ error: null });
    try {
      await postJson("/api/music/remote", patchBody);
    } catch (error) {
      patch({ error: errorMessage(error) });
    }
  };

  const ensureMedia = (): AudioElementLike | null => {
    if (media || mediaFailed) return media;
    const element = createAudio();
    if (!element) {
      mediaFailed = true;
      return null;
    }
    media = element;
    element.preload = "metadata";
    element.addEventListener("play", () => {
      patch({ positionMs: element.currentTime * 1_000, playing: true });
    });
    element.addEventListener("pause", () => {
      patch({ positionMs: element.currentTime * 1_000, playing: false });
    });
    element.addEventListener("ended", () => {
      patch({ playing: false });
      // The end of a track is the only moment 播放模式 gets to decide anything.
      // It lives in the store, so the queue keeps moving with no music tab
      // mounted — the whole point of the element not being in a React tree.
      advanceQueue("track-ended");
    });
    element.addEventListener("timeupdate", () => {
      patch({ positionMs: element.currentTime * 1_000 });
    });
    element.addEventListener("loadedmetadata", () => applyLoadedMetadata(element));
    element.addEventListener("durationchange", () => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        patch({ durationMs: element.duration * 1_000 });
      }
    });
    element.addEventListener("error", () => {
      // Only a track we asked for can fail; an element with no source has
      // nothing to say.
      if (state.detail) patch({ error: AUDIO_ERROR });
    });
    return element;
  };

  const applyLoadedMetadata = (element: AudioElementLike) => {
    const loadedDurationMs = Number.isFinite(element.duration) && element.duration > 0
      ? element.duration * 1_000
      : state.detail?.track.durationMs ?? 0;
    patch({ durationMs: loadedDurationMs });
    if (pendingLocalSeekMs === null) return;
    const targetMs = clampPlaybackPositionMs(pendingLocalSeekMs, loadedDurationMs);
    element.currentTime = targetMs / 1_000;
    patch({ positionMs: targetMs });
    pendingLocalSeekMs = null;
  };

  const seekLocal = (requestedMs: number) => {
    if (!state.detail) return;
    const element = ensureMedia();
    const loadedDurationMs = element
      && Number.isFinite(element.duration) && element.duration > 0
      ? element.duration * 1_000
      : effectiveDurationMs(state);
    const targetMs = clampPlaybackPositionMs(requestedMs, loadedDurationMs);
    patch({ positionMs: targetMs, error: null });
    if (!element || element.readyState < HAVE_METADATA || !Number.isFinite(element.duration)) {
      pendingLocalSeekMs = targetMs;
      return;
    }
    element.currentTime = targetMs / 1_000;
    pendingLocalSeekMs = null;
  };

  // ---- 播放模式 and the queue ------------------------------------------------

  /** A fresh 随机播放 pass, opening on whatever is playing right now. */
  const rebuildShufflePass = (tracks: readonly MusicTrack[]) => {
    shufflePass = shufflePassFrom(
      tracks.length,
      indexOfTrack(tracks, state.detail?.track.id ?? null),
      random,
    );
  };

  /**
   * Resume the transport on whichever thing is actually the player.
   * Only ever called to continue a session the user already started, so the
   * browser's autoplay gate is not in the way.
   */
  const startPlayback = () => {
    if (state.playbackMode === "remote") return;
    if (state.deviceOnline) {
      patch({ playing: true });
      store.postControl({ playing: true });
      return;
    }
    const element = ensureMedia();
    if (!element) return;
    void element.play().catch((error: unknown) => patch({ error: errorMessage(error) }));
    store.postControl({ playing: true });
  };

  /** 单曲循环: the same track again, without refetching what we already have. */
  const restartCurrent = () => {
    if (!state.detail) return;
    store.seek(0);
    startPlayback();
  };

  const advanceQueue = (reason: QueueMoveReason) => {
    if (state.playbackMode === "remote") {
      // Connect owns its own queue, and its own repeat/shuffle with it. A
      // finished track is its business; a button press is a command to it.
      if (reason !== "track-ended") {
        void postRemote({ action: reason === "manual-next" ? "next" : "previous" });
      }
      return;
    }
    if (!state.detail || state.queue.length === 0) return;
    const move = nextQueueMove({
      queueLength: state.queue.length,
      currentIndex: indexOfTrack(state.queue, state.detail.track.id),
      order: state.playOrder,
      reason,
      shuffle: shufflePass,
      random,
    });
    shufflePass = move.shuffle;
    // 顺序播放 at the end of the list: the session is over. Nothing wraps,
    // nothing restarts — the player just stops where the list stopped.
    if (move.index === null) return;
    if (move.restart) {
      restartCurrent();
      return;
    }
    const next = state.queue[move.index];
    if (!next) return;
    // A finished track hands playback over. A button press keeps doing whatever
    // the transport was doing, so skipping while paused stays paused.
    void store.select(next, { autoplay: reason === "track-ended" || state.playing });
  };

  // ---- now playing ---------------------------------------------------------

  const report = (body: unknown) => {
    lastReportAt = now();
    panelOwned = body !== null;
    void fetcher("/api/os/now-playing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  /**
   * Report, unless this page has nothing to say. The hub arbitrates by SOURCE,
   * and every console page writes as the same "console" source — so any page's
   * `PUT null` releases the panel whichever page is actually feeding it. A
   * second console opened on ZOS with no track loaded used to blank the clock
   * for seconds on open and again on close. Silence is not ownership: a page
   * that has never reported a track stays quiet, and only the page that took
   * the panel can give it back.
   */
  const sendReport = () => {
    const body = nowPlayingBody({
      detail: state.detail,
      positionMs: state.positionMs,
      playing: state.playing,
    });
    if (body === null && !panelOwned) return;
    report(body);
  };

  /**
   * Re-report whenever what the panel shows would change: the track, the
   * play/pause state, or the lyric line. The playhead ticks every frame and is
   * NOT part of the key — the 4 s timer carries it.
   */
  const syncNowPlaying = () => {
    if (!reportingEnabled) return;
    const index = state.detail
      ? activeLyricIndexAt(state.detail.lyrics, state.positionMs)
      : -1;
    const key = `${state.detail?.track.id ?? "-"}|${state.playing ? 1 : 0}|${index}`;
    if (key === reportedKey) return;
    reportedKey = key;
    sendReport();
  };

  // ---- public actions ------------------------------------------------------

  // A closed tab must not leave the last lyric on the clock. keepalive, because
  // a normal fetch is cancelled the moment the page goes away — the same reason
  // lib/live-screen.ts uses it for its own teardown. Registered once for the
  // page, not per view: the music tab is no longer what owns playback.
  const releaseOnPageHide = () => {
    // Only the page holding the panel releases it — see sendReport.
    if (!reportingEnabled || !panelOwned) return;
    panelOwned = false;
    void fetcher("/api/os/now-playing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "null",
      keepalive: true,
    }).catch(() => {});
  };
  if (typeof window !== "undefined") window.addEventListener("pagehide", releaseOnPageHide);

  const store: MusicPlaybackStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return state;
    },

    retain() {
      leases += 1;
      syncTimer();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases = Math.max(0, leases - 1);
        syncTimer();
      };
    },

    setSource(provider, playbackMode) {
      patch({ provider, playbackMode });
    },

    setQueue(tracks, label) {
      rebuildShufflePass(tracks);
      patch({
        queue: tracks,
        queueLabel: label,
        queueIndex: indexOfTrack(tracks, state.detail?.track.id ?? null),
      });
    },

    setPlayOrder(order) {
      if (order === state.playOrder) return;
      // Anchor the new pass on what is playing, so switching to 随机播放 mid-song
      // still means "every other track before this one comes back".
      if (order === "shuffle") rebuildShufflePass(state.queue);
      writeStoredPlayOrder(order);
      patch({ playOrder: order });
    },

    cyclePlayOrder() {
      store.setPlayOrder(nextMusicPlayOrder(state.playOrder));
    },

    async select(track, selectOptions) {
      patch({ loading: true, error: null });
      pendingLocalSeekMs = null;
      pendingDeviceSeek = null;
      lastSentSeekMs = null;
      media?.pause();
      try {
        const result = await requestJson<{ detail: MusicTrackDetail }>(
          `/api/music/tracks/${track.id}`,
        );
        patch({
          detail: result.detail,
          queueIndex: indexOfTrack(state.queue, track.id),
          positionMs: 0,
          durationMs: result.detail.track.durationMs,
          playing: false,
        });
        if (state.playbackMode !== "remote") {
          const element = ensureMedia();
          if (element) {
            element.src = `/api/music/tracks/${track.id}/stream`;
            // Explicit, so re-selecting the track already loaded restarts it
            // instead of leaving the playhead where the last listen ended.
            element.load();
          }
        }
        // Tell the device which track is current so it fetches the matching
        // audio + lyrics. In remote mode this is also the command that starts
        // the track on the Connect player, so its failures have to be visible.
        const select = postJson("/api/music/device/select", { trackId: track.id });
        if (state.playbackMode === "remote") await select;
        else void select.catch(() => {});
        if (selectOptions?.autoplay) startPlayback();
      } catch (error) {
        patch({ error: errorMessage(error) });
      } finally {
        patch({ loading: false });
      }
    },

    async toggle() {
      if (state.playbackMode === "remote") {
        // The Connect player owns playback; the studio only sends the command
        // and waits for the next poll to report what actually happened.
        const willPlay = !state.playing;
        patch({ playing: willPlay });
        await postRemote({ action: willPlay ? "play" : "pause" });
        return;
      }
      if (!state.detail) return;
      patch({ error: null });
      if (state.deviceOnline) {
        // Music-firmware mode: the TC002 is the player. The web is a silent
        // remote — don't touch local audio, just flip state and push it.
        const willPlay = !state.playing;
        patch({ playing: willPlay });
        store.postControl({ playing: willPlay });
        return;
      }
      const element = ensureMedia();
      if (!element) return;
      const willPlay = element.paused;
      try {
        if (willPlay) await element.play();
        else element.pause();
        store.postControl({ playing: willPlay });
      } catch (error) {
        patch({ error: errorMessage(error) });
      }
    },

    skip(direction) {
      // An explicit "give me another song": it moves and it wraps in every
      // mode, 单曲循环 included. Only a track ending by itself obeys 播放模式.
      advanceQueue(direction === 1 ? "manual-next" : "manual-prev");
    },

    seek(positionMs) {
      const clamped = Math.max(0, Math.min(positionMs, effectiveDurationMs(state) || positionMs));
      if (state.playbackMode === "remote") {
        deviceClock = { ...deviceClock, playheadMs: clamped, fetchedAt: now() };
        patch({ positionMs: clamped });
        void postRemote({ action: "seek", positionMs: Math.round(clamped) });
        return;
      }
      if (state.deviceOnline) {
        let sendMs = Math.round(clamped);
        // The firmware dedups consecutive seeks by value, so seeking to the
        // exact same spot again (double-clicking a lyric line) would be
        // silently dropped — nudge repeats by 1ms to keep commands distinct.
        if (lastSentSeekMs === sendMs) sendMs = Math.max(0, sendMs - 1) || sendMs + 1;
        lastSentSeekMs = sendMs;
        store.postControl({ seekMs: sendMs });
        pendingDeviceSeek = { targetMs: clamped, at: now() };
        deviceClock = { ...deviceClock, playheadMs: clamped, fetchedAt: now() };
        patch({ positionMs: clamped });
        return;
      }
      seekLocal(clamped);
    },

    clear() {
      pendingLocalSeekMs = null;
      pendingDeviceSeek = null;
      lastSentSeekMs = null;
      shufflePass = [];
      deviceClock = { playheadMs: 0, fetchedAt: 0, playing: false, trackId: null };
      media?.pause();
      patch({
        queue: [],
        queueLabel: DEFAULT_QUEUE_LABEL,
        queueIndex: -1,
        detail: null,
        positionMs: 0,
        durationMs: 0,
        playing: false,
        error: null,
      });
    },

    setError(message) {
      patch({ error: message });
    },

    setNowPlayingReporting(enabled) {
      if (enabled === reportingEnabled) return;
      reportingEnabled = enabled;
      if (enabled) {
        reportedKey = null;
        syncNowPlaying();
        return;
      }
      // Leaving ZOS (or losing it) must not pin the last lyric on a panel this
      // console no longer feeds — but a page that never fed it releases nothing.
      reportedKey = null;
      if (panelOwned) report(null);
    },

    postControl(controlPatch) {
      // Fire-and-forget: the device polls /state and applies it. We remember
      // the resulting seq so our own poll doesn't echo our own change back.
      void fetcher("/api/music/device/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(controlPatch),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { seq?: number } | null) => {
          if (data && typeof data.seq === "number") {
            lastLocalSeq = data.seq;
            lastSeenSeq = data.seq;
          }
        })
        .catch(() => {});
    },

    onDeviceState(listener) {
      const entry = { fn: listener, delivered: false };
      deviceListeners.add(entry);
      if (lastFields) {
        entry.delivered = true;
        // A view that mounts between polls still adopts the served theme
        // rather than sitting on its localStorage paint cache for 2.5 s.
        listener(lastFields, { initial: true, themeEcho: false });
      }
      return () => deviceListeners.delete(entry);
    },

    dispose() {
      disposed = true;
      if (timer !== null) stopTimer(timer);
      timer = null;
      listeners.clear();
      deviceListeners.clear();
      media?.pause();
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", releaseOnPageHide);
      }
    },
  };

  return store;
}

let singleton: MusicPlaybackStore | null = null;

/**
 * The page's one player.
 *
 * A module singleton rather than a React context: the audio element is exactly
 * as page-scoped as a `<audio>` tag in index.html would be, and nothing above
 * the tabs should have to re-render because the playhead moved. Views reach it
 * through `useMusicPlayback()`; tests build their own with
 * `createMusicPlaybackStore()`.
 */
export function musicPlaybackStore(): MusicPlaybackStore {
  singleton ??= createMusicPlaybackStore();
  return singleton;
}
