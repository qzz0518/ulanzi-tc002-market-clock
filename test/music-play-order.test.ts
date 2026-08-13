import { describe, expect, test } from "bun:test";
import {
  isMusicPlayOrder,
  MUSIC_PLAY_ORDER_LABELS,
  nextMusicPlayOrder,
  nextQueueMove,
  readStoredPlayOrder,
  shufflePass,
  shufflePassFrom,
  writeStoredPlayOrder,
  type MusicPlayOrder,
  type PlayOrderStorage,
  type QueueMoveReason,
} from "../web/src/lib/music-play-order";

/**
 * 播放模式 is only worth having if the ends of the queue behave. These tests are
 * where each mode's promise is written down: what a finished track does, what a
 * button press does, and that 随机播放 never plays a song twice in one pass.
 */

/** xorshift32 — a reproducible stand-in for Math.random. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const ORDERS: MusicPlayOrder[] = ["sequence", "repeat-one", "shuffle"];
const REASONS: QueueMoveReason[] = ["manual-next", "manual-prev", "track-ended"];

function move(
  order: MusicPlayOrder,
  reason: QueueMoveReason,
  queueLength: number,
  currentIndex: number,
  shuffle: readonly number[] = [],
  random: () => number = seededRandom(7),
) {
  return nextQueueMove({ queueLength, currentIndex, order, reason, shuffle, random });
}

describe("the play-mode cycle", () => {
  test("cycles 顺序播放 → 单曲循环 → 随机播放 and back", () => {
    expect(nextMusicPlayOrder("sequence")).toBe("repeat-one");
    expect(nextMusicPlayOrder("repeat-one")).toBe("shuffle");
    expect(nextMusicPlayOrder("shuffle")).toBe("sequence");
  });

  test("every mode has a Chinese name", () => {
    for (const order of ORDERS) expect(MUSIC_PLAY_ORDER_LABELS[order]).toMatch(/播放|循环/);
  });

  test("only the three known modes are accepted", () => {
    for (const order of ORDERS) expect(isMusicPlayOrder(order)).toBe(true);
    expect(isMusicPlayOrder("random")).toBe(false);
    expect(isMusicPlayOrder(null)).toBe(false);
  });
});

describe("an empty queue", () => {
  test("has nothing to play in any mode, for any reason", () => {
    for (const order of ORDERS) {
      for (const reason of REASONS) {
        const result = move(order, reason, 0, -1);
        expect(result.index).toBeNull();
        expect(result.restart).toBe(false);
      }
    }
  });
});

describe("顺序播放", () => {
  test("hands a finished track to the next one", () => {
    expect(move("sequence", "track-ended", 4, 1).index).toBe(2);
  });

  test("stops at the end of the list instead of wrapping", () => {
    const result = move("sequence", "track-ended", 4, 3);
    expect(result.index).toBeNull();
    expect(result.restart).toBe(false);
  });

  test("a button press still wraps at both ends — it was asked for a song", () => {
    expect(move("sequence", "manual-next", 4, 3).index).toBe(0);
    expect(move("sequence", "manual-prev", 4, 0).index).toBe(3);
    expect(move("sequence", "manual-prev", 4, 2).index).toBe(1);
  });

  test("a one-track queue ends after that track", () => {
    expect(move("sequence", "track-ended", 1, 0).index).toBeNull();
  });
});

describe("单曲循环", () => {
  test("replays the finished track from the top", () => {
    const result = move("repeat-one", "track-ended", 4, 2);
    expect(result.index).toBe(2);
    expect(result.restart).toBe(true);
  });

  test("下一首 gives the next song, not the same one again", () => {
    const result = move("repeat-one", "manual-next", 4, 2);
    expect(result.index).toBe(3);
    expect(result.restart).toBe(false);
  });

  test("its manual moves wrap like 顺序播放's", () => {
    expect(move("repeat-one", "manual-next", 4, 3).index).toBe(0);
    expect(move("repeat-one", "manual-prev", 4, 0).index).toBe(3);
  });

  test("a one-track queue repeats that track forever", () => {
    const result = move("repeat-one", "track-ended", 1, 0);
    expect(result.index).toBe(0);
    expect(result.restart).toBe(true);
  });
});

describe("随机播放", () => {
  test("plays every track exactly once before any of them comes back", () => {
    const queueLength = 8;
    const random = seededRandom(20_260_813);
    let pass = shufflePass(queueLength, random);
    let current = pass[0];
    const played = [current];
    for (let step = 1; step < queueLength; step += 1) {
      const result = nextQueueMove({
        queueLength,
        currentIndex: current,
        order: "shuffle",
        reason: "track-ended",
        shuffle: pass,
        random,
      });
      expect(result.index).not.toBeNull();
      current = result.index as number;
      pass = result.shuffle as number[];
      played.push(current);
    }
    expect(played).toHaveLength(queueLength);
    expect(new Set(played).size).toBe(queueLength);
    // A shuffle that hands back the list in order is not a shuffle.
    expect(played).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("reshuffles at the end of a pass and never opens on the song just heard", () => {
    const queueLength = 6;
    // Every seed, not one lucky one: the seam is the only place 随机播放 could
    // play the same song twice in a row, so it has to hold every time.
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = seededRandom(seed);
      const pass = shufflePass(queueLength, random);
      const last = pass[queueLength - 1];
      const result = nextQueueMove({
        queueLength,
        currentIndex: last,
        order: "shuffle",
        reason: "track-ended",
        shuffle: pass,
        random,
      });
      expect(result.index).not.toBe(last);
      expect(result.restart).toBe(false);
      expect([...result.shuffle].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    }
  });

  test("上一首 walks back through the same pass", () => {
    const pass = [3, 1, 0, 2];
    expect(move("shuffle", "manual-prev", 4, 0, pass).index).toBe(1);
    expect(move("shuffle", "manual-next", 4, 0, pass).index).toBe(2);
    // Backwards off the front of the pass wraps to its end.
    expect(move("shuffle", "manual-prev", 4, 3, pass).index).toBe(2);
  });

  test("rebuilds a pass left over from a different queue", () => {
    const stale = [4, 0, 3, 1, 2];
    const result = move("shuffle", "manual-next", 3, 0, stale);
    expect(result.shuffle).toHaveLength(3);
    expect([...result.shuffle].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(result.index).toBeLessThan(3);
  });

  test("a pass built mid-song opens on the song that is playing", () => {
    // Switching to 随机播放 halfway through a track must not put that track at
    // the end of the new pass — it would be the next thing to come back round.
    for (let seed = 1; seed <= 40; seed += 1) {
      const pass = shufflePassFrom(7, 4, seededRandom(seed));
      expect(pass[0]).toBe(4);
      expect([...pass].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
    // Nothing is playing yet: any pass will do.
    expect(shufflePassFrom(4, -1, seededRandom(3))).toHaveLength(4);
  });

  test("a one-track queue is that track, over and over", () => {
    const result = move("shuffle", "track-ended", 1, 0, [0]);
    expect(result.index).toBe(0);
    expect(result.restart).toBe(true);
  });
});

describe("a track that is not in the current list", () => {
  test("a button press starts the list from the top", () => {
    expect(move("sequence", "manual-next", 4, -1).index).toBe(0);
    expect(move("repeat-one", "manual-prev", 4, -1).index).toBe(0);
  });

  test("but a track running out does not hijack a list the user only searched", () => {
    for (const order of ORDERS) {
      expect(move(order, "track-ended", 4, -1).index).toBeNull();
    }
  });
});

describe("remembering the mode", () => {
  function fakeStorage(initial?: string): PlayOrderStorage & { value: string | null } {
    return {
      value: initial ?? null,
      getItem() {
        return this.value;
      },
      setItem(_key, next) {
        this.value = next;
      },
    };
  }

  test("defaults to 顺序播放 with nothing stored", () => {
    expect(readStoredPlayOrder(fakeStorage())).toBe("sequence");
    expect(readStoredPlayOrder(null)).toBe("sequence");
  });

  test("round-trips a chosen mode", () => {
    const storage = fakeStorage();
    writeStoredPlayOrder("shuffle", storage);
    expect(storage.value).toBe("shuffle");
    expect(readStoredPlayOrder(storage)).toBe("shuffle");
  });

  test("ignores a value it did not write", () => {
    expect(readStoredPlayOrder(fakeStorage("单曲"))).toBe("sequence");
  });

  test("survives a storage that throws", () => {
    const hostile: PlayOrderStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(readStoredPlayOrder(hostile)).toBe("sequence");
    expect(() => writeStoredPlayOrder("shuffle", hostile)).not.toThrow();
  });
});
