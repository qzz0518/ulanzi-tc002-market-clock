import type { MusicLyricLine } from "./core.ts";

/** A stretch of the track the provider itself calls the chorus, in track ms. */
export interface ChorusRange {
  startMs: number;
  endMs: number;
}

// Lines compared as sung, not as typed: case, spaces and punctuation differ
// between repeats of the same chorus line in real NetEase lyrics.
function chorusKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Marks the lines that belong to the chorus, by text.
 *
 * NetEase answers `/song/chorus` with ONE range — the first chorus, the one it
 * uses for previews — so the range only names which texts are the chorus, and
 * every line singing one of those texts anywhere in the song is marked. Without
 * a range (another provider, or the request failed) the most repeated text is
 * taken instead, folia's fallback: the line sung most often is the hook. One
 * occurrence each means nothing repeats, and nothing is marked; a one-character
 * key (an "Oh", a lone "啊") never counts.
 *
 * Returns the same array when nothing is marked, so a verse-only song costs no
 * copy.
 */
export function markChorusLines(
  lines: MusicLyricLine[],
  ranges: readonly ChorusRange[] = [],
): MusicLyricLine[] {
  const keys = lines.map((line) => chorusKey(line.text));
  const chorus = new Set<string>();
  for (const range of ranges) {
    if (!(range.endMs > range.startMs)) continue;
    lines.forEach((line, index) => {
      if (keys[index]!.length >= 2 && line.startMs >= range.startMs && line.startMs < range.endMs) {
        chorus.add(keys[index]!);
      }
    });
  }
  if (chorus.size === 0) {
    const counts = new Map<string, number>();
    for (const key of keys) {
      if (key.length >= 2) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const most = Math.max(0, ...counts.values());
    if (most >= 2) {
      for (const [key, count] of counts) if (count === most) chorus.add(key);
    }
  }
  if (chorus.size === 0) return lines;
  return lines.map((line, index) => (chorus.has(keys[index]!) ? { ...line, chorus: true } : line));
}
