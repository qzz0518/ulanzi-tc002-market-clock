import { describe, expect, test } from "bun:test";
import type { MusicLyricLine, MusicTrack } from "../src/music/core.ts";
import { buildLyricLines, LrclibLyricsClient, parseLrc } from "../src/music/lyrics.ts";

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

  test("closes each line at the next one and the last at the track end", () => {
    const lines = buildLyricLines(
      [{ startMs: 1_000, text: "一" }, { startMs: 4_000, text: "二" }],
      9_000,
      new Map([[1_000, "one"]]),
    );
    expect(lines).toEqual([
      { startMs: 1_000, endMs: 4_000, text: "一", translation: "one" },
      { startMs: 4_000, endMs: 9_000, text: "二" },
    ]);
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

    expect(await client.lyrics(TRACK)).toEqual([
      { startMs: 1_000, endMs: 3_000, text: "第一行" },
      { startMs: 3_000, endMs: 200_000, text: "第二行" },
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
      { startMs: 1_000, endMs: 200_000, text: "对的那版" },
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
      { startMs: 0, endMs: 200_000, text: "网易云补上的歌词" },
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
