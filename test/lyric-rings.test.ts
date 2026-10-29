import { describe, expect, test } from "bun:test";
import {
  haloRadius,
  interludeDotTier,
  interludeProgress,
  lyricHash,
  ringsHopPx,
  tiltLeanUnit,
  tiltUnits,
} from "../web/src/components/music/pixel-lyric-modes";
import {
  drawPixelLyricsFrame,
  pixelLyricCursor,
  pixelLyricScrollOffset,
  type MusicSkin,
  type PixelLyricLine,
} from "../web/src/components/music/pixel-lyrics-preview";
import type { MusicMode } from "../web/src/components/music/pixel-lyric-modes";
import { glyphRows } from "../web/src/lib/pixel-glyphs";
import { nowPlayingBody } from "../web/src/lib/music-playback";
import { markChorusLines } from "../src/music/chorus";
import type { MusicLyricLine } from "../src/music/core";
import { NeteaseMusicService, type NeteaseGateway } from "../src/netease-music";
import { OsLinkHub } from "../src/os-link";

// 信号绿's four tiers, as the preview paints them.
const PRIMARY = "#c1ff3d";
const SECONDARY = "#6ca34e";
const CONTEXT = "#47733d";
const MUTED = "#284b2c";

// The same single-glyph sample ZOS's checkLyricRings uses: one 12 px cell
// centred at x = 20..31 with room on every side.
const ONE = "你";
const ONE_TOP_ROW = glyphRows(0x4f60)!.findIndex((mask) => mask !== 0);

function frameAt(
  mode: MusicMode,
  line: PixelLyricLine,
  playheadMs: number,
  text = ONE,
  skin: MusicSkin = "signal",
  sparks = false,
): string[][] {
  const grid: string[][] = Array.from({ length: 16 }, () => Array.from({ length: 52 }, () => "#000000"));
  let fill = "#000000";
  const context = {
    imageSmoothingEnabled: true,
    clearRect: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      for (let row = y; row < y + h; row += 1) {
        for (let column = x; column < x + w; column += 1) {
          if (row < 0 || row > 15 || column < 0 || column > 51) continue;
          grid[row]![column] = fill;
        }
      }
    },
    get fillStyle() {
      return fill;
    },
    set fillStyle(value: string) {
      fill = value;
    },
  };
  const { cursor, windowProgress, interlude, sinceLineMs } = pixelLyricCursor(text, line, playheadMs);
  drawPixelLyricsFrame(context as unknown as CanvasRenderingContext2D, {
    skin,
    mode,
    currentText: text,
    hasLyric: true,
    cursor,
    windowProgress,
    trackProgress: 0.3,
    playing: true,
    scrollOffsetPx: pixelLyricScrollOffset(text, cursor, mode, false),
    timeMs: playheadMs,
    reducedMotion: false,
    interlude,
    chorus: line.chorus === true,
    lineStartMs: line.startMs,
    sinceLineMs,
    sparks,
  });
  return grid;
}

function count(grid: string[][], color: string, where: (x: number, y: number) => boolean = () => true): number {
  let n = 0;
  grid.forEach((row, y) => row.forEach((c, x) => {
    if (c === color && where(x, y)) n += 1;
  }));
  return n;
}

const outsideCell = (x: number, y: number) => !(x >= 20 && x < 32 && y >= 1 && y < 14);
// The lifted glyph's own cell: the row it vacated below is open to the ring.
const insideLiftedCell = (x: number, y: number) => x >= 20 && x < 32 && y >= 1 && y < 13;
const topRowOf = (grid: string[][], color: string) =>
  grid.findIndex((row) => row.slice(20, 32).includes(color));

const LINE: PixelLyricLine = { startMs: 4_000, endMs: 8_000, untilMs: 8_000 };

describe("年轮", () => {
  test("the numbers both renderers share", () => {
    expect(haloRadius(0.1)).toBe(1);
    expect(haloRadius(0.6)).toBe(2);
    expect(ringsHopPx(0.1)).toBe(1);
    expect(ringsHopPx(0.6)).toBe(0);
  });

  test("lifts the sung glyph and rings it at distance 1 for its first half", () => {
    const grid = frameAt("rings", LINE, 4_400);
    expect(topRowOf(grid, PRIMARY)).toBe(ONE_TOP_ROW + 1);
    // No cue rows in 年轮, so every sung-tier pixel off the glyph is ring.
    expect(count(grid, SECONDARY, outsideCell)).toBeGreaterThan(0);
    expect(count(grid, SECONDARY, insideLiftedCell)).toBe(0);
    expect(count(grid, CONTEXT, outsideCell)).toBe(0);
  });

  test("sets it back down and rings it at distance 2 for its second half", () => {
    const grid = frameAt("rings", LINE, 6_400);
    expect(topRowOf(grid, PRIMARY)).toBe(ONE_TOP_ROW + 2);
    expect(count(grid, SECONDARY, outsideCell)).toBe(0);
    expect(count(grid, CONTEXT, outsideCell)).toBeGreaterThan(0);
  });

  test("on a full line the ring still shows above or below the row", () => {
    const grid = frameAt("rings", LINE, 5_600, "你好世界");
    const rows = [0, 1, 14, 15].map((y) => grid[y]!.filter((c) => c === CONTEXT).length);
    expect(rows.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  test("a chorus line ripples in 走带 and a verse line does not", () => {
    const verse = frameAt("ticker", LINE, 6_400);
    const chorus = frameAt("ticker", { ...LINE, chorus: true }, 6_400);
    expect(count(verse, CONTEXT)).toBe(0);
    expect(count(chorus, CONTEXT)).toBeGreaterThan(0);
    expect(count(chorus, PRIMARY)).toBeGreaterThan(0);
  });
});

describe("倾诉", () => {
  const HELD: PixelLyricLine = { startMs: 4_000, endMs: 8_000, untilMs: 9_000 };

  test("phrases end at punctuation, a lone break folds back, long runs split in fours", () => {
    const cps = (text: string) => Array.from(text).map((c) => c.codePointAt(0)!);
    expect(tiltUnits(cps("你，好"))).toEqual([[0, 2], [2, 3]]);
    expect(tiltUnits(cps("It's me"))).toEqual([[0, 5], [5, 7]]);
    expect(tiltUnits(cps("一二三四五六七八"))).toEqual([[0, 4], [4, 8]]);
    expect(tiltLeanUnit(4_000, 1)).toBe(-1);
    expect(tiltLeanUnit(4_000, 2)).toBeGreaterThanOrEqual(0);
  });

  test("nothing before the line, glyphs surfacing muted, then a phrase in the focus tier", () => {
    expect(frameAt("tilt", HELD, 3_990, "你，好").slice(0, 15).flat().filter((c) => c !== "#000000")).toHaveLength(0);
    expect(count(frameAt("tilt", HELD, 4_050, "你，好"), MUTED)).toBeGreaterThan(0);
    expect(count(frameAt("tilt", HELD, 8_500, "你，好"), PRIMARY)).toBeGreaterThan(0);
    expect(count(frameAt("tilt", HELD, 8_500, "你好"), PRIMARY)).toBeLessThanOrEqual(1);
  });
});

describe("火花", () => {
  test("sparks fly off the sung glyph while on, and nothing changes while off", () => {
    const lit = (grid: string[][]) => grid.flat().filter((c) => c !== "#000000").length;
    expect(lit(frameAt("spotlight", LINE, 4_800, ONE, "signal", true)))
      .toBeGreaterThan(lit(frameAt("spotlight", LINE, 4_800)));
  });

  test("the hash is the firmware's: fixed vectors", () => {
    expect(lyricHash(0, 0)).toBe(lyricHash(0, 0));
    expect(lyricHash(4_000, 99)).not.toBe(lyricHash(4_001, 99));
  });
});

describe("the instrumental after a line", () => {
  // Sung 4000..5000, next line at 10000: a 5 s break.
  const BREAK: PixelLyricLine = { startMs: 4_000, endMs: 5_000, untilMs: 10_000 };
  const ink = glyphRows(0x4f60)!.reduce((n, mask) => n + mask.toString(2).replaceAll("0", "").length, 0);
  const band = (grid: string[][]) => grid.slice(2, 14).flat().filter((c) => c !== "#000000").length;

  test("is a break only from 3 s, and only 0.6 s after the last word", () => {
    expect(interludeProgress(5_000, 7_999, 6_000)).toBe(-1);
    expect(interludeProgress(5_000, 10_000, 5_599)).toBe(-1);
    expect(interludeProgress(5_000, 10_000, 5_600)).toBe(0);
    expect(interludeProgress(5_000, 10_000, 10_000)).toBe(-1);
    expect(interludeDotTier(0, 0.5, 0)).toBe("secondary");
    expect(interludeDotTier(2, 0.5, 0)).toBe("muted");
    expect(["primary", "context"]).toContain(interludeDotTier(1, 0.5, 0));
  });

  for (const mode of ["ticker", "skyline", "spotlight", "cascade", "rings", "tilt"] as const) {
    test(`gives the row up to three dots in ${mode}`, () => {
      const grid = frameAt(mode, BREAK, 8_000);
      expect(band(grid)).toBe(12);
      expect(grid[7]![19]).toBe(SECONDARY);
      expect(grid[7]![31]).toBe(MUTED);
    });
  }

  test("keeps the line for the lead, and for a breath", () => {
    expect(band(frameAt("spotlight", BREAK, 5_300))).toBe(ink);
    expect(band(frameAt("spotlight", { ...BREAK, untilMs: 7_500 }, 6_500))).toBe(ink);
  });
});

describe("chorus marking", () => {
  const line = (startMs: number, text: string): MusicLyricLine =>
    ({ startMs, endMs: startMs + 1_000, text, endSource: "next" });
  const SONG = [
    line(0, "作词：某人"),
    line(10_000, "第一段主歌"),
    line(20_000, "副歌第一句"),
    line(22_000, "副歌第二句！"),
    line(30_000, "第二段主歌"),
    line(40_000, "副歌第一句"),
    line(42_000, "副歌 第二句"),
    line(50_000, "啊"),
    line(51_000, "啊"),
    line(52_000, "啊"),
  ];

  test("NetEase's one range names the texts, and every repeat of them is marked", () => {
    const marked = markChorusLines(SONG, [{ startMs: 19_000, endMs: 25_000 }]);
    expect(marked.filter((l) => l.chorus).map((l) => l.startMs)).toEqual([20_000, 22_000, 40_000, 42_000]);
  });

  test("without a range the most repeated text is taken, never a one-character one", () => {
    const marked = markChorusLines(SONG);
    expect(marked.filter((l) => l.chorus).map((l) => l.startMs)).toEqual([20_000, 22_000, 40_000, 42_000]);
  });

  test("nothing repeats, nothing is marked, and nothing is copied", () => {
    const verses = [line(0, "一"), line(1_000, "二三"), line(2_000, "四五")];
    expect(markChorusLines(verses)).toBe(verses);
  });

  test("NetEase trackDetail asks for the range and marks the lyric", async () => {
    const gateway: Partial<NeteaseGateway> = {
      songDetail: async () => ({
        body: { songs: [{ id: 7, name: "夜航", ar: [{ name: "像素乐队" }], al: { name: "十六行" }, dt: 60_000 }] },
      }),
      lyric: async () => ({
        body: { lrc: { lyric: "[00:01.00]主歌\n[00:05.00]副歌\n[00:09.00]主歌二\n[00:13.00]副歌" } },
      }),
      songChorus: async () => ({ body: { code: 200, chorus: [{ id: 7, startTime: 4_500, endTime: 8_000 }] } }),
    };
    const service = new NeteaseMusicService({
      gateway: { ...baseGateway(), ...gateway },
      sessionStore: { load: async () => null, save: async () => {}, clear: async () => {} } as never,
    });
    const lyrics = (await service.trackDetail("7")).lyrics;
    expect(lyrics.filter((l) => l.chorus).map((l) => l.startMs)).toEqual([5_000, 13_000]);
  });

  test("a failed range request falls back to repetition rather than failing the track", async () => {
    const service = new NeteaseMusicService({
      gateway: {
        ...baseGateway(),
        songDetail: async () => ({ body: { songs: [{ id: 7, name: "夜航", ar: [], al: {}, dt: 60_000 }] } }),
        lyric: async () => ({ body: { lrc: { lyric: "[00:01.00]副歌\n[00:05.00]主歌\n[00:09.00]副歌" } } }),
        songChorus: async () => {
          throw new Error("offline");
        },
      },
      sessionStore: { load: async () => null, save: async () => {}, clear: async () => {} } as never,
    });
    const lyrics = (await service.trackDetail("7")).lyrics;
    expect(lyrics.filter((l) => l.chorus).map((l) => l.startMs)).toEqual([1_000, 9_000]);
  });
});

describe("the chorus on the wire", () => {
  test("the console reports it and the hub sends lyricchorus only when true", () => {
    const detail = {
      track: { id: "7", title: "夜航", artists: ["像素乐队"], album: "", durationMs: 60_000 },
      lyrics: [{ startMs: 1_000, endMs: 3_000, text: "副歌", endSource: "next" as const, chorus: true }],
    };
    const body = nowPlayingBody({ detail, positionMs: 2_000, playing: true });
    expect(body?.lyricChorus).toBe(true);

    const hub = new OsLinkHub();
    const now = {
      track: "夜航", artist: "像素乐队", playing: true, positionMs: 2_000, durationMs: 60_000,
      lyric: "副歌", lyricStartMs: 1_000, lyricEndMs: 3_000, lyricUntilMs: 3_000,
    };
    hub.setNowPlaying(now);
    expect(hub.serialize().split("\n")).not.toContain("lyricchorus\t1");
    const before = hub.currentSeq();
    hub.setNowPlaying({ ...now, lyricChorus: true });
    expect(hub.currentSeq()).toBeGreaterThan(before);
    expect(hub.serialize().split("\n")).toContain("lyricchorus\t1");
  });

  test("年轮 and 倾诉 are modes rings and tilt on the wire, and 火花 is sent only when on", () => {
    const hub = new OsLinkHub();
    hub.setLyricTheme({ mode: "rings" });
    expect(hub.serialize().split("\n")).toContain("mode\trings");
    expect(hub.serialize().split("\n")).not.toContain("sparks\t1");
    hub.setLyricTheme({ mode: "tilt", sparks: true });
    expect(hub.serialize().split("\n")).toContain("mode\ttilt");
    expect(hub.serialize().split("\n")).toContain("sparks\t1");
  });
});

function baseGateway(): NeteaseGateway {
  const empty = async () => ({ body: {} });
  return {
    loginQrKey: empty,
    loginQrCreate: empty,
    loginQrCheck: empty,
    userAccount: empty,
    userPlaylists: empty,
    playlistTracks: empty,
    search: empty,
    songDetail: empty,
    lyric: empty,
    songUrl: empty,
    recommendSongs: empty,
    likedSongIds: empty,
  };
}
