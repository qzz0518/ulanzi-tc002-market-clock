import { lyricCells } from "@/lib/lyric-cursor";
import type { MusicLyricLine, MusicTrackDetail } from "@/types";
// Type only — erased at build, so this stays a React-free module even though
// the shape is declared next to the preview that paints it (music-mirror.ts
// reaches for the same type from the same place).
import type { PixelLyricLine } from "@/components/music/pixel-lyrics-preview";

export function clampPlaybackPositionMs(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || positionMs <= 0) return 0;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return Math.round(positionMs);
  return Math.round(Math.min(positionMs, durationMs));
}

/**
 * Which lyric line is current at `positionMs`, or -1 before the first one.
 *
 * An index rather than the line itself: the index is stable while a line holds,
 * which is what lets the window below be memoised per line instead of per tick.
 * A window rebuilt every frame would re-key the mirror effect and flood the
 * device with identical GIF pushes.
 */
export function activeLyricIndexAt(
  lyrics: readonly MusicLyricLine[] | undefined,
  positionMs: number,
): number {
  if (!lyrics?.length) return -1;
  for (let index = lyrics.length - 1; index >= 0; index -= 1) {
    if (positionMs >= lyrics[index]!.startMs) return index;
  }
  return -1;
}

/**
 * The active line as a window plus a cell table — the one shape every consumer
 * needs, computed once.
 *
 * `untilMs` is the next line's start (or the end of the track); `endMs` is what
 * the provider decided the line's SINGING end was, and the two are the same
 * number only when one line follows another immediately. `endMs` is clamped to
 * the window because a Spotify Connect snapshot can be a different master than
 * the NetEase timeline the lyrics came from.
 *
 * All zeros means "no window", and every consumer reads it that way: the hub
 * omits lyricat/lyricend rather than sending a degenerate one, and
 * `pixelLyricCursor` answers with its idle cursor rather than inventing a
 * window. Nothing downstream may synthesise a substitute.
 */
export function lyricWindowAt(detail: MusicTrackDetail | null, index: number): PixelLyricLine {
  const lyric = detail && index >= 0 ? detail.lyrics[index] : undefined;
  if (!lyric || !detail) return { startMs: 0, endMs: 0, untilMs: 0 };
  const next = detail.lyrics[index + 1];
  const trackMs = detail.track.durationMs;
  const untilMs = next
    ? next.startMs
    : (trackMs > lyric.startMs ? trackMs : lyric.startMs + 4_000);
  const endMs = lyric.endMs > lyric.startMs ? Math.min(lyric.endMs, untilMs) : untilMs;
  // Built from the raw line, not from what the panel happens to show: the
  // table's index IS the glyph index, and lyricCells returns nothing at all
  // rather than a table that would light the wrong character.
  const cells = lyricCells({
    startMs: lyric.startMs,
    endMs,
    text: lyric.text,
    words: lyric.words,
  });
  return {
    startMs: lyric.startMs,
    endMs,
    untilMs,
    ...(cells.length > 0 ? { cells } : {}),
  };
}

/**
 * The body of `PUT /api/os/now-playing`, or null when there is nothing playing.
 *
 * The panel cannot look any of this up: the service polls Spotify but nothing
 * can poll a browser, so for a device-audio provider the console is the only
 * thing in the system that knows what is coming out of the speakers.
 *
 * Four lyric fields rather than two, because the panel needs to tell three
 * moments apart — when the line starts, when the SINGING stops, and when the
 * next line takes over. The words are sent when the source has them; the
 * service turns them into the per-glyph table (after its own truncation, so the
 * indices cannot drift) and the panel walks the line at the rate it was sung.
 */
export function nowPlayingBody(input: {
  detail: MusicTrackDetail | null;
  positionMs: number;
  playing: boolean;
}): Record<string, unknown> | null {
  const detail = input.detail;
  if (!detail) return null;
  const index = activeLyricIndexAt(detail.lyrics, input.positionMs);
  const lyric = index >= 0 ? detail.lyrics[index] : undefined;
  const line = lyricWindowAt(detail, index);
  return {
    track: detail.track.title,
    artist: detail.track.artists.join(" / "),
    // Paused is still "this song", so the clock keeps the title and stops the
    // playhead; only losing the track entirely clears the panel.
    playing: input.playing,
    positionMs: Math.round(input.positionMs),
    durationMs: detail.track.durationMs,
    lyric: lyric?.text ?? "",
    lyricStartMs: line.startMs,
    lyricEndMs: line.endMs,
    lyricUntilMs: line.untilMs,
    ...(lyric?.words?.length ? { lyricWords: lyric.words } : {}),
  };
}
