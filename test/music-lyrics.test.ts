import { describe, expect, test } from "bun:test";
import type { MusicLyricLine, MusicTrack } from "../src/music/core.ts";
import { buildLyricLines, LrclibLyricsClient, parseLrc } from "../src/music/lyrics.ts";
import { parseLrcEndMarkers } from "../src/music/lyric-timing.ts";

const TRACK: MusicTrack = {
  id: "4uLU6hMCjMI75M1A2tKUQC",
  title: "夜航",
  artists: ["像素乐队"],
  album: "十六行",
  durationMs: 200_000,
};

function jsonFetcher(
  handler: (url: URL) => unknown | null,
): { fetcher: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input : new URL(String(input));
    urls.push(url);
    const body = handler(url);
    if (body === null) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, urls };
}

describe("lyric parsing", () => {
  test("expands repeated timestamps and orders lines", () => {
    expect(parseLrc("[00:03.5]副歌\n[00:01.20][00:05.00]主歌")).toEqual([
      { startMs: 1_200, text: "主歌" },
      { startMs: 3_500, text: "副歌" },
      { startMs: 5_000, text: "主歌" },
    ]);
    expect(parseLrc("[ti:no timestamps]")).toEqual([]);
    expect(parseLrc(undefined)).toEqual([]);
  });

  test("closes each line where the singing stops, never past the next one", () => {
    const lines = buildLyricLines(
      [{ startMs: 1_000, text: "一" }, { startMs: 4_000, text: "二" }],
      9_000,
      new Map([[1_000, "one"]]),
    );
    // One glyph is one unit, so the rate cap is the 900 ms floor. Both lines are
    // held far longer than they are sung — the first by 3 s, the last by 8 s —
    // and neither highlight is asked to crawl across that.
    expect(lines).toEqual([
      { startMs: 1_000, endMs: 1_900, text: "一", translation: "one", endSource: "estimate" },
      { startMs: 4_000, endMs: 4_900, text: "二", endSource: "estimate" },
    ]);
  });

  test("takes the next line's start when the singing would run past it", () => {
    // Six syllables at 630 ms would be 3.78 s but the successor is 700 ms away,
    // so nothing had to be guessed and the source says so.
    const lines = buildLyricLines(
      [{ startMs: 0, text: "I've been tryna call" }, { startMs: 700, text: "next" }],
      60_000,
    );
    expect(lines[0]).toEqual({ startMs: 0, endMs: 700, text: "I've been tryna call", endSource: "next" });
  });

  test("takes the source's own bare end mark when it is tighter than the estimate", () => {
    // A real lrclib response shape: a text line, a bare timestamp marking where
    // it stopped, then a 12 s gap before the next line. The naive rule gave this
    // line 8.53 s, and the rate cap would have allowed 5 syllables x 630 =
    // 3.15 s. The source says 2.48 s — the tightest of the three bounds — so it
    // is used, labelled as the measurement it is.
    const synced = "[00:13.42] I've been tryna call\n[00:15.90]\n[00:21.95] Yeah";
    const lines = buildLyricLines(parseLrc(synced), 200_000, undefined, {
      endMarkersMs: parseLrcEndMarkers(synced),
    });
    expect(lines[0]).toEqual({
      startMs: 13_420,
      endMs: 15_900,
      text: "I've been tryna call",
      endSource: "marker",
    });
  });

  test("ignores an end mark that is really a separator on the next line", () => {
    // A bare timestamp sitting exactly on the successor's start says nothing
    // about where the singing stopped; taking it would be the old bug wearing a
    // different hat.
    const synced = "[00:01.00]一二三四五六七八\n[00:20.00]\n[00:20.00]下一句";
    const lines = buildLyricLines(parseLrc(synced), 200_000, undefined, {
      endMarkersMs: parseLrcEndMarkers(synced),
    });
    expect(lines[0]!.endSource).toBe("estimate");
    expect(lines[0]!.endMs).toBe(1_000 + 8 * 630);
  });

  test("a separator one millisecond short of the next line is still a separator", () => {
    // The real one, from 孤勇者's own LRC: the mark after 谁说站在光里的才算英雄
    // sits 300 ms before the successor and claims 18.06 s for a line `yrc`
    // measures at 5.27 s. It is inside the gap, so an "is it before the next
    // line?" guard passes it — only the singing-rate cap catches it.
    const synced = "[01:50.35]谁说站在光里的才算英雄\n[02:08.41]\n[02:08.71]他们说";
    const lines = buildLyricLines(parseLrc(synced), 260_000, undefined, {
      endMarkersMs: parseLrcEndMarkers(synced),
    });
    expect(lines[0]!.endSource).toBe("estimate");
    expect(lines[0]!.endMs - lines[0]!.startMs).toBe(11 * 630);
    // What the marker would have bought had it won: 18.06 s of highlight for a
    // line that stops 12.8 s earlier.
    expect(128_410 - 110_350).toBe(18_060);
  });
});

describe("LRCLIB lyric lookup", () => {
  test("uses the exact match and asks with the track's own metadata", async () => {
    const { fetcher, urls } = jsonFetcher((url) =>
      url.pathname === "/api/get"
        ? { syncedLyrics: "[00:01.00]第一行\n[00:03.00]第二行", duration: 200 }
        : null
    );
    const client = new LrclibLyricsClient({ fetcher });

    // The Spotify path is line-level LRC — three glyphs each, so 1.89 s of
    // singing. The second line is the one that mattered: it used to be handed
    // the remaining 197 seconds of the track.
    expect(await client.lyrics(TRACK)).toEqual([
      { startMs: 1_000, endMs: 1_000 + 3 * 630, text: "第一行", endSource: "estimate" },
      { startMs: 3_000, endMs: 3_000 + 3 * 630, text: "第二行", endSource: "estimate" },
    ]);
    expect(urls[0]!.host).toBe("lrclib.net");
    expect(urls[0]!.searchParams.get("track_name")).toBe("夜航");
    expect(urls[0]!.searchParams.get("artist_name")).toBe("像素乐队");
    expect(urls[0]!.searchParams.get("duration")).toBe("200");
  });

  test("falls back to search and picks the closest recording", async () => {
    const { fetcher, urls } = jsonFetcher((url) => {
      if (url.pathname === "/api/get") return null;
      return [
        { syncedLyrics: "[00:02.00]远的那版", duration: 400 },
        { syncedLyrics: "[00:01.00]对的那版", duration: 203 },
        { plainLyrics: "无时间轴", duration: 200 },
      ];
    });
    const client = new LrclibLyricsClient({ fetcher });

    expect(await client.lyrics(TRACK)).toEqual([
      { startMs: 1_000, endMs: 1_000 + 4 * 630, text: "对的那版", endSource: "estimate" },
    ]);
    expect(urls.map((url) => url.pathname)).toEqual(["/api/get", "/api/search"]);
  });

  test("treats instrumentals as having no lyrics", async () => {
    const { fetcher } = jsonFetcher((url) =>
      url.pathname === "/api/get" ? { instrumental: true, syncedLyrics: null } : []
    );
    expect(await new LrclibLyricsClient({ fetcher }).lyrics(TRACK)).toEqual([]);
  });

  test("hands a miss to the fallback source instead of failing", async () => {
    const fallbackLines: MusicLyricLine[] = [
      { startMs: 0, endMs: 200_000, text: "网易云补上的歌词", endSource: "next" },
    ];
    const { fetcher } = jsonFetcher(() => null);
    const client = new LrclibLyricsClient({
      fetcher,
      fallback: { lyrics: async () => fallbackLines },
    });
    expect(await client.lyrics(TRACK)).toEqual(fallbackLines);
  });

  test("never lets an upstream failure break the player", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await new LrclibLyricsClient({ fetcher: failing }).lyrics(TRACK)).toEqual([]);
  });
});
