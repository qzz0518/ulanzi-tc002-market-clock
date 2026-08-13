import {
  asRecord,
  MusicServiceError,
  numberValue,
  readBoundedBody,
  type LyricEndSource,
  type MusicLyricLine,
  type MusicTrack,
} from "./core.ts";
import { estimateSungEndMs, parseLrcEndMarkers, type LyricLineDraft } from "./lyric-timing.ts";

// LRC parsing is shared: NetEase hands us LRC directly, and LRCLIB — the open
// lyric database we use for Spotify, which has no public lyric API — returns the
// same format.

export function parseLrc(raw: string | undefined): Array<{ startMs: number; text: string }> {
  if (!raw) return [];
  const parsed: Array<{ startMs: number; text: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (tags.length === 0) continue;
    const text = line.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;
    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      const fraction = tag[3] ?? "0";
      const milliseconds = fraction.length === 1
        ? Number(fraction) * 100
        : fraction.length === 2
          ? Number(fraction) * 10
          : Number(fraction.slice(0, 3));
      parsed.push({ startMs: (minutes * 60 + seconds) * 1_000 + milliseconds, text });
    }
  }
  return parsed.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Turns timestamped starts into the [startMs, endMs) ranges the players need,
 * optionally zipping in a translation track keyed by identical timestamps.
 *
 * `endMs` is when the line stopped being SUNG, which is the whole point of this
 * function and the one thing it used to get wrong: it read
 * `original[index + 1].startMs`, so the last line before an instrumental was
 * handed the entire break and its karaoke highlight crawled across the glyphs
 * long after the singer had finished. The next line's start is now only the
 * ceiling — the value is never later than it, and usually earlier.
 *
 * Word timings answer outright when the source has them. Everything else is
 * bounded rather than guessed — see `estimateSungEndMs`, which mins the
 * successor's start, the source's own end mark and a singing-rate cap — and the
 * result records which bound answered in `endSource` so nothing downstream can
 * mistake a guess for a measurement.
 */
export function buildLyricLines(
  original: readonly LyricLineDraft[],
  trackDurationMs: number,
  translations = new Map<number, string>(),
  options: { endMarkersMs?: readonly number[] } = {},
): MusicLyricLine[] {
  const markers = options.endMarkersMs ?? [];
  return original.map((line, index) => {
    const translation = translations.get(line.startMs);
    // The display window: where the next line takes over. Unchanged, and still
    // a hard ceiling — nothing below may push a line past its successor.
    const windowEndMs = original[index + 1]?.startMs
      ?? Math.max(line.startMs + 2_000, trackDurationMs);

    let endMs: number;
    let endSource: LyricEndSource;
    if (line.words && line.words.length > 0) {
      const sungEndMs = Math.max(...line.words.map((word) => word.endMs));
      // Words win over any header the source also supplied, but not over the
      // next line: a table that overran its successor would keep animating a
      // line the panel has already replaced.
      if (sungEndMs > line.startMs && sungEndMs <= windowEndMs) {
        endMs = sungEndMs;
        endSource = "words";
      } else {
        endMs = windowEndMs;
        endSource = "next";
      }
    } else {
      const markerMs = firstMarkerAfter(markers, line.startMs);
      const estimated = estimateSungEndMs({
        startMs: line.startMs,
        text: line.text,
        windowEndMs,
        markerMs,
      });
      endMs = estimated.endMs;
      endSource = estimated.source;
    }

    return {
      startMs: line.startMs,
      endMs,
      text: line.text,
      endSource,
      ...(line.words && line.words.length > 0 ? { words: line.words } : {}),
      ...(translation ? { translation } : {}),
    };
  });
}

/** The source's own end mark for this line, if it left one in the gap. */
function firstMarkerAfter(markers: readonly number[], startMs: number): number | undefined {
  for (const marker of markers) if (marker > startMs) return marker;
  return undefined;
}

const LRCLIB_HOST = "lrclib.net";
const MAX_LYRIC_BYTES = 512 * 1024;

export interface LyricsLookup {
  lyrics(track: MusicTrack): Promise<MusicLyricLine[]>;
}

// https://lrclib.net — a community lyric database with no key and no rate-limit
// registration. Spotify exposes no lyric endpoint, so this fills the gap; a
// miss simply yields an empty timeline and the player shows the track title.
export class LrclibLyricsClient implements LyricsLookup {
  constructor(
    private readonly options: {
      fetcher?: typeof fetch;
      timeoutMs?: number;
      // Optional second chance for tracks LRCLIB doesn't carry (Mandarin/Cantopop
      // coverage is much better on NetEase).
      fallback?: LyricsLookup;
    } = {},
  ) {}

  async lyrics(track: MusicTrack): Promise<MusicLyricLine[]> {
    const direct = await this.lookup(track).catch(() => [] as MusicLyricLine[]);
    if (direct.length > 0) return direct;
    if (!this.options.fallback) return [];
    return await this.options.fallback.lyrics(track).catch(() => [] as MusicLyricLine[]);
  }

  private async lookup(track: MusicTrack): Promise<MusicLyricLine[]> {
    const artist = track.artists[0] ?? "";
    if (!track.title.trim() || !artist.trim()) return [];

    const exact = new URL(`https://${LRCLIB_HOST}/api/get`);
    exact.searchParams.set("track_name", track.title);
    exact.searchParams.set("artist_name", artist);
    if (track.album) exact.searchParams.set("album_name", track.album);
    if (track.durationMs > 0) {
      exact.searchParams.set("duration", String(Math.round(track.durationMs / 1_000)));
    }
    const matched = await this.request(exact);
    const fromExact = this.toLines(asRecord(matched), track.durationMs);
    if (fromExact.length > 0) return fromExact;

    // The exact endpoint demands a near-perfect duration match; search is looser.
    const search = new URL(`https://${LRCLIB_HOST}/api/search`);
    search.searchParams.set("track_name", track.title);
    search.searchParams.set("artist_name", artist);
    const results = await this.request(search);
    if (!Array.isArray(results)) return [];
    const best = pickClosestDuration(results, track.durationMs);
    return this.toLines(asRecord(best), track.durationMs);
  }

  private toLines(record: Record<string, unknown>, durationMs: number): MusicLyricLine[] {
    if (record.instrumental === true) return [];
    const synced = typeof record.syncedLyrics === "string" ? record.syncedLyrics : undefined;
    // The bare end-mark lines are the only duration information LRCLIB ever
    // carries — it has no word-level field at all — and parseLrc drops them
    // because they have no text. Reading them separately is what keeps the
    // Spotify catalogue from falling back to a pure estimate on every line.
    return buildLyricLines(parseLrc(synced), durationMs, undefined, {
      endMarkersMs: parseLrcEndMarkers(synced),
    });
  }

  private async request(url: URL): Promise<unknown> {
    const fetcher = this.options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          Accept: "application/json",
          // LRCLIB asks clients to identify themselves.
          "User-Agent": "Pixel-Market-TC002/3 (https://github.com/zerah/ulanzi-tc002)",
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 6_000),
      });
    } catch {
      throw new MusicServiceError("歌词服务暂时不可用", 502);
    }
    if (response.status === 404) {
      response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      throw new MusicServiceError(`歌词服务返回 HTTP ${response.status}`, 502);
    }
    const bytes = await readBoundedBody(response, MAX_LYRIC_BYTES, "歌词服务");
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new MusicServiceError("歌词服务返回了无法解析的内容", 502);
    }
  }
}

function pickClosestDuration(results: unknown[], durationMs: number): unknown {
  let best: unknown = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const entry of results) {
    const record = asRecord(entry);
    if (typeof record.syncedLyrics !== "string" || record.syncedLyrics.length === 0) continue;
    const seconds = numberValue(record.duration) ?? 0;
    const delta = durationMs > 0 ? Math.abs(seconds * 1_000 - durationMs) : 0;
    if (delta < bestDelta) {
      best = entry;
      bestDelta = delta;
    }
  }
  // A wildly different length is a different recording, not this track.
  return durationMs > 0 && bestDelta > 15_000 ? null : best;
}
