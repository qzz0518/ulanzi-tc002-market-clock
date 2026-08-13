/**
 * 播放模式 — the rule that decides which track plays next.
 *
 * The three modes only ever disagree about two things: what happens when a
 * track *ends by itself*, and what order the queue is walked in. A click on
 * 上一首 / 下一首 is an explicit "give me another song", so it always moves and
 * always wraps, in every mode — including 单曲循环, where obeying the mode would
 * mean answering the request with the same song again.
 *
 * All of it is pure: the queue is a length plus an index, the randomness is an
 * injected function. The store calls this and does the playing; test/
 * music-play-order.test.ts pins the rules with no store and no browser.
 */

export type MusicPlayOrder = "sequence" | "repeat-one" | "shuffle";

/** The cycle order of the button, matching NetEase's own. */
export const MUSIC_PLAY_ORDERS: readonly MusicPlayOrder[] = [
  "sequence",
  "repeat-one",
  "shuffle",
];

export const MUSIC_PLAY_ORDER_LABELS: Readonly<Record<MusicPlayOrder, string>> = {
  sequence: "顺序播放",
  "repeat-one": "单曲循环",
  shuffle: "随机播放",
};

/** What each mode promises, for the tooltip — one hover should teach the cycle. */
export const MUSIC_PLAY_ORDER_HINTS: Readonly<Record<MusicPlayOrder, string>> = {
  sequence: "按列表顺序播放，播完最后一首停下",
  "repeat-one": "当前这首循环播放",
  shuffle: "打乱列表播放，一轮之内不重复",
};

export function isMusicPlayOrder(value: unknown): value is MusicPlayOrder {
  return typeof value === "string"
    && (MUSIC_PLAY_ORDERS as readonly string[]).includes(value);
}

export function nextMusicPlayOrder(order: MusicPlayOrder): MusicPlayOrder {
  const index = MUSIC_PLAY_ORDERS.indexOf(order);
  return MUSIC_PLAY_ORDERS[(index + 1) % MUSIC_PLAY_ORDERS.length];
}

/**
 * Why the queue is moving.
 *
 * "track-ended" is the only one the mode gets to answer with "stop" or "play it
 * again" — the other two came from a finger on a button.
 */
export type QueueMoveReason = "manual-next" | "manual-prev" | "track-ended";

export interface QueueMoveInput {
  queueLength: number;
  /** Where the loaded track sits in the queue, or -1 when it is not in it. */
  currentIndex: number;
  order: MusicPlayOrder;
  reason: QueueMoveReason;
  /** The current 随机播放 pass: a permutation of queue indices. */
  shuffle: readonly number[];
  /** Injected so a shuffled pass is reproducible under test. */
  random?: () => number;
}

export interface QueueMove {
  /** The queue index to play next, or null to stop where we are. */
  index: number | null;
  /** The chosen index is the track already loaded: restart it, don't reload. */
  restart: boolean;
  /** The pass to keep — a fresh one when the old was exhausted or stale. */
  shuffle: readonly number[];
}

/** A Fisher-Yates permutation of `0..length-1`. */
export function shufflePass(length: number, random: () => number = Math.random): number[] {
  const pass = Array.from({ length }, (_, index) => index);
  for (let i = length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = pass[i];
    pass[i] = pass[j];
    pass[j] = swap;
  }
  return pass;
}

/**
 * A pass that opens on `startIndex` — the track already playing.
 *
 * Built when the queue changes or 随机播放 is switched on mid-song. Anchoring the
 * pass to what is playing is what makes the promise true from that moment on:
 * every *other* track is heard before this one can come back. A pass that
 * dropped the current track in at random could put it at the end, and the next
 * song would already be starting a fresh pass.
 */
export function shufflePassFrom(
  length: number,
  startIndex: number,
  random: () => number = Math.random,
): number[] {
  const pass = shufflePass(length, random);
  if (startIndex < 0 || startIndex >= length) return pass;
  const at = pass.indexOf(startIndex);
  pass[at] = pass[0];
  pass[0] = startIndex;
  return pass;
}

/**
 * A new pass that does not open on `avoidIndex`.
 *
 * The one place 随机播放 can visibly repeat is across the seam between passes —
 * the last track of one and the first of the next are the only two that can be
 * the same song twice in a row. Re-rolling that one position costs nothing and
 * removes the only repeat a listener would actually notice.
 */
function freshPass(length: number, avoidIndex: number, random: () => number): number[] {
  const pass = shufflePass(length, random);
  if (length > 1 && pass[0] === avoidIndex) {
    const swapWith = 1 + Math.floor(random() * (length - 1));
    const swap = pass[0];
    pass[0] = pass[swapWith];
    pass[swapWith] = swap;
  }
  return pass;
}

/** A pass is only usable while it still describes the queue it was made for. */
function usablePass(
  shuffle: readonly number[],
  queueLength: number,
  random: () => number,
): readonly number[] {
  return shuffle.length === queueLength ? shuffle : shufflePass(queueLength, random);
}

function stepped(index: number, currentIndex: number, shuffle: readonly number[]): QueueMove {
  return { index, restart: index === currentIndex, shuffle };
}

/**
 * The next thing to play.
 *
 * 顺序播放 — list order. A finished track hands over to the next one and the
 *   last track ends the session: nothing restarts, nothing wraps. That is the
 *   whole difference between 顺序播放 and a list on repeat.
 * 单曲循环 — a finished track plays again from the top. 上一首/下一首 still walk
 *   the list, because the user asked for a different song.
 * 随机播放 — the queue is walked in a shuffled pass, so no track comes back
 *   until every other one has played. When the pass runs out it is reshuffled
 *   and playback continues, never opening on the song that just finished.
 */
export function nextQueueMove(input: QueueMoveInput): QueueMove {
  const { queueLength, currentIndex, order, reason } = input;
  const random = input.random ?? Math.random;
  if (queueLength <= 0) return { index: null, restart: false, shuffle: [] };

  const manual = reason !== "track-ended";
  // The loaded track is not in this list — the user searched something new
  // while it played. A button press means "start this list"; a track running
  // out on its own does not, or a stray search would hijack playback.
  if (currentIndex < 0) {
    if (!manual) return { index: null, restart: false, shuffle: input.shuffle };
    const pass = usablePass(input.shuffle, queueLength, random);
    const index = order === "shuffle" ? pass[0] : 0;
    return { index, restart: false, shuffle: pass };
  }

  if (order === "repeat-one" && !manual) {
    return { index: currentIndex, restart: true, shuffle: input.shuffle };
  }

  if (order === "shuffle") {
    const pass = usablePass(input.shuffle, queueLength, random);
    const position = pass.indexOf(currentIndex);
    if (position < 0) return stepped(pass[0], currentIndex, pass);
    if (reason === "manual-prev") {
      // Back through the pass, so 上一首 undoes the jump the user just heard.
      const previous = position === 0 ? pass[queueLength - 1] : pass[position - 1];
      return stepped(previous, currentIndex, pass);
    }
    if (position + 1 < queueLength) return stepped(pass[position + 1], currentIndex, pass);
    const next = freshPass(queueLength, currentIndex, random);
    return stepped(next[0], currentIndex, next);
  }

  // 顺序播放, and 单曲循环's manual moves, walk the list itself.
  if (reason === "manual-prev") {
    const previous = (currentIndex - 1 + queueLength) % queueLength;
    return stepped(previous, currentIndex, input.shuffle);
  }
  if (reason === "manual-next") {
    return stepped((currentIndex + 1) % queueLength, currentIndex, input.shuffle);
  }
  const next = currentIndex + 1;
  return next < queueLength
    ? stepped(next, currentIndex, input.shuffle)
    : { index: null, restart: false, shuffle: input.shuffle };
}

const STORAGE_KEY = "pixel-market.music-play-order";

/** Just enough of Storage to read and write one string. */
export interface PlayOrderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): PlayOrderStorage | null {
  // Private browsing and file:// origins throw on access, not on use.
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The mode is a preference, not a playhead.
 *
 * The store deliberately does not survive a reload — restoring a position
 * mid-track needs an autoplay permission the browser will not grant. None of
 * that applies to 播放模式: it changes nothing until the next track ends, so it
 * is remembered the same way the skin and the pixel theme are.
 */
export function readStoredPlayOrder(
  storage: PlayOrderStorage | null = defaultStorage(),
): MusicPlayOrder {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return isMusicPlayOrder(stored) ? stored : "sequence";
  } catch {
    return "sequence";
  }
}

export function writeStoredPlayOrder(
  order: MusicPlayOrder,
  storage: PlayOrderStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, order);
  } catch {
    // A full or blocked quota must never break the transport.
  }
}
