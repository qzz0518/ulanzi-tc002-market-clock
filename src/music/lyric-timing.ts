/**
 * When a lyric line is actually being SUNG, and which glyph the singer is on.
 *
 * The bug this file exists to remove: a line's end used to be defined as the
 * next line's start. The last line of a verse is followed by a 13-second
 * instrumental, so its highlight was given 18 seconds to cross eleven
 * characters that took 5.3 seconds to sing — it crawled at an eighth speed
 * while the singer had long stopped. Every verse-ending line in every song had
 * it, which is why it is the first thing anyone notices.
 *
 * Two separate answers, because the sources are not equal:
 *
 *   1. NetEase's `yrc` field carries per-word timings (karaoke grade). It was
 *      already being fetched on every track and thrown away. When it is there,
 *      nothing is estimated: the line ends where the last word ends, and the
 *      cursor walks the words at the rate they were actually sung.
 *   2. Everything else — lrclib (the whole Spotify catalogue), and the ~75-80%
 *      of NetEase tracks with no yrc — is line-level LRC. There the sung end is
 *      genuinely unknown, so it is bounded, never invented: the successor's
 *      start, the source's own bare-timestamp end marks, and a singing-rate cap
 *      are min'd together, and `endSource` records which bound answered so no
 *      consumer can mistake a guess for a measurement.
 *
 * Pure functions only. Both the browser preview and (via generated golden
 * vectors) the two firmwares are held to this arithmetic, so it may not touch
 * I/O, Bun APIs or the DOM.
 */

import type { LyricEndSource, MusicLyricLine, MusicLyricWord } from "./core.ts";

/**
 * Milliseconds a singer spends on one unit — one CJK codepoint, or one English
 * syllable.
 *
 * 630 is the measured p90 over a 50-track / 2567-line yrc corpus (per-script
 * p90: 692 Chinese, 610 Latin, 636 mixed — a 12% spread that does not move the
 * scores, so one constant rather than two and a branch).
 *
 * p90 rather than the median on purpose. This number is a CAP, not an estimate:
 * scored against yrc ground truth, using the median rate (420) as the estimate
 * is WORSE than the naive next-line rule, because every line ends on a held
 * note that no rate model predicts. At 630 the lines the user complains about
 * (naive overshoots by >=2 s) drop from 7033 ms mean error to 1903, and the
 * price is that 7.4% more ordinary lines finish >250 ms early.
 */
export const LYRIC_MS_PER_UNIT = 630;

/**
 * Floor for a line's sung duration. A one- or two-character line would
 * otherwise be capped at ~630 ms and read as a flash rather than a line.
 */
export const LYRIC_MIN_LINE_MS = 900;

/**
 * A zero-length word gets stretched to at most this before the next onset.
 * 2.1% of yrc words are declared with duration 0; a glyph that can never be
 * focused reads as a rendering bug.
 */
const ZERO_WORD_MAX_MS = 400;

export interface LyricCell {
  /** Absolute track time, milliseconds. */
  startMs: number;
  /** Absolute track time. Equal to startMs for a whitespace cell — see lyricCells. */
  endMs: number;
  /** Exactly one UTF-8 codepoint. */
  text: string;
}

export type LyricPhase = "pending" | "singing" | "held";

export interface LyricCursor {
  /** Index of the cell being sung, or -1 before the line starts. */
  index: number;
  /** Position inside that cell, 0..1. Pinned at 1 in a word gap and while held. */
  frac: number;
  /** (index + frac) / cellCount — the geometric progress the layout uses. */
  progress: number;
  phase: LyricPhase;
}

export interface LyricLineDraft {
  startMs: number;
  text: string;
  /** Present only when the source really carries word timings. */
  words?: MusicLyricWord[];
}

/* ------------------------------------------------------------------ */
/* yrc — NetEase's word-level format                                    */
/* ------------------------------------------------------------------ */

// `(startMs,durationMs,flag)` immediately before the text it times. The text of
// a word is everything up to the NEXT tuple, which is how both AMLL and LDDC
// read it — a `[^(]*` text class breaks on the full-width parentheses yrc uses
// inside lyrics.
const YRC_WORD = /\((\d+),(\d+),(-?\d+)\)/g;
const YRC_HEADER = /^\[(\d+),(\d+)\]/;

/**
 * Parses NetEase `yrc` into line drafts carrying absolute per-word timings.
 *
 * Deliberately forgiving, because a real album is not clean input:
 *  - the first few lines are bare JSON credit blobs (`{"t":-1000,"c":[…]}`),
 *  - a line may have a `[start,dur]` header that disagrees with its words
 *    (measured on 131 of 2659 lines), and the WORDS win — they are what the
 *    renderer walks,
 *  - words are not guaranteed to butt up against each other (1.2% do not),
 *  - a word may be declared with duration 0 (2.1%),
 *  - a line may have a header and no words at all, or no header at all.
 *
 * The returned `text` is exactly the concatenation of the words' text, with
 * only the outer edges trimmed. That equality is load-bearing: the wire
 * protocol identifies a glyph by its index, so a text that is not the words
 * laid end to end would light the wrong character.
 */
export function parseYrc(raw: string | undefined): LyricLineDraft[] {
  if (!raw) return [];
  const drafts: LyricLineDraft[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    // Credit metadata, not a timed line. The same blobs appear in `lrc`, where
    // parseLrc drops them because they carry no [mm:ss] tag; here they would
    // otherwise parse as a line at time 0 with JSON as its words.
    if (line === "" || line.startsWith("{")) continue;

    const header = YRC_HEADER.exec(line);
    const body = header ? line.slice(header[0].length) : line;
    const matches = [...body.matchAll(YRC_WORD)];
    if (matches.length === 0) continue;

    const words: MusicLyricWord[] = [];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]!;
      const from = match.index + match[0].length;
      const to = index + 1 < matches.length ? matches[index + 1]!.index : body.length;
      const startMs = Number(match[1]);
      const durationMs = Number(match[2]);
      if (!Number.isFinite(startMs) || !Number.isFinite(durationMs)) continue;
      words.push({
        startMs,
        endMs: startMs + Math.max(0, durationMs),
        // Tabs and newlines are record separators on both wire protocols, and a
        // stray one here would desynchronise the cell table from the label.
        text: body.slice(from, to).replace(/[\t\r\n]+/g, " "),
      });
    }
    const trimmed = trimEdgeWhitespace(words);
    if (trimmed.length === 0) continue;
    const text = trimmed.map((word) => word.text).join("");
    if (text.trim() === "") continue;

    drafts.push({
      // The words, not the header: they are what gets rendered, and 4.9% of
      // lines have a header that does not match them.
      startMs: Math.min(...trimmed.map((word) => word.startMs)),
      text,
      words: trimmed,
    });
  }
  return drafts.sort((a, b) => a.startMs - b.startMs);
}

/** Drops leading/trailing whitespace so `text` never needs trimming later. */
function trimEdgeWhitespace(words: MusicLyricWord[]): MusicLyricWord[] {
  const out = words.map((word) => ({ ...word }));
  while (out.length > 0 && out[0]!.text.trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1]!.text.trim() === "") out.pop();
  if (out.length === 0) return out;
  out[0]!.text = out[0]!.text.replace(/^\s+/, "");
  const last = out[out.length - 1]!;
  last.text = last.text.replace(/\s+$/, "");
  return out.filter((word) => word.text.length > 0);
}

/* ------------------------------------------------------------------ */
/* LRC end marks                                                        */
/* ------------------------------------------------------------------ */

const LRC_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/**
 * The bare `[mm:ss.xx]` lines in an LRC — the source's own statement of where
 * a line stopped being sung.
 *
 * Not decoration and not a parser quirk: this is what LDDC writes when it
 * downgrades word-level lyrics to line-level LRC (`add_end_timestamp_line`),
 * and lrclib is full of entries produced that way. `parseLrc` drops these lines
 * because they have no text, which threw away the only end information the
 * Spotify path ever gets.
 *
 * They are SPARSE, and they are not all end marks. Measured over 21 tracks that
 * carry both an LRC and `yrc` for the same recording: 65 of 1057 NetEase LRC
 * lines and 88 of 870 lrclib lines are followed by a usable bare timestamp, and
 * 36 of the 139 scorable ones are section separators overshooting the real sung
 * end by more than 2 s. That is why `estimateSungEndMs` treats a mark as an
 * upper bound rather than as the answer.
 */
export function parseLrcEndMarkers(raw: string | undefined): number[] {
  if (!raw) return [];
  const marks: number[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const tags = [...line.matchAll(LRC_TAG)];
    if (tags.length === 0) continue;
    if (line.replace(/\[[^\]]+\]/g, "").trim() !== "") continue;
    for (const tag of tags) marks.push(lrcTagMs(tag));
  }
  return marks.sort((a, b) => a - b);
}

function lrcTagMs(tag: RegExpMatchArray): number {
  const minutes = Number(tag[1]);
  const seconds = Number(tag[2]);
  const fraction = tag[3] ?? "0";
  const milliseconds = fraction.length === 1
    ? Number(fraction) * 100
    : fraction.length === 2
      ? Number(fraction) * 10
      : Number(fraction.slice(0, 3));
  return (minutes * 60 + seconds) * 1_000 + milliseconds;
}

/* ------------------------------------------------------------------ */
/* Singing-rate estimate                                                */
/* ------------------------------------------------------------------ */

// Everything a singer spends roughly one beat on. CJK ideographs, kana, hangul
// and full-width forms are one unit per codepoint; Latin script is counted in
// syllables, which the corpus shows are the same order of magnitude (415 vs
// 362 ms median), so one rate covers both.
const CJK_UNIT =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/u;

/**
 * How many "beats" of singing a line is worth. Never returns 0, so a line made
 * entirely of punctuation still gets the floor rather than a zero-length window.
 */
export function lyricUnits(text: string): number {
  let units = 0;
  let word = "";
  const flush = () => {
    if (word !== "") units += syllables(word);
    word = "";
  };
  for (const character of text) {
    if (/[A-Za-z'’]/.test(character)) {
      word += character;
      continue;
    }
    flush();
    if (CJK_UNIT.test(character)) units += 1;
    // A spoken digit is about one syllable; punctuation and spaces are silent.
    else if (/[0-9]/.test(character)) units += 1;
  }
  flush();
  return Math.max(1, units);
}

/** Vowel-group syllable count: crude, cheap, and within noise of the corpus. */
function syllables(rawWord: string): number {
  const word = rawWord.toLowerCase().replace(/[^a-z]/g, "");
  if (word === "") return 0;
  // Silent trailing e ("call" 1, "make" 1) but not the "-le" of "table".
  const trimmed = word.replace(/(?:[^laeiouy]e|[^laeiouy]es)$/, "");
  const groups = trimmed.replace(/^y/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 0);
}

/**
 * Where a line without word timings most likely stopped being sung.
 *
 * THREE BOUNDS, MIN'D — none of them is an answer on its own, and the result is
 * never later than `windowEndMs`, so this can only ever shorten a line.
 *
 *   next     — the successor's start. The hard ceiling; also the answer when
 *              nothing below is tighter, in which case nothing was guessed.
 *   marker   — a bare `[mm:ss.xx]` inside the gap, which is what LDDC writes
 *              when it downgrades word-level lyrics to LRC.
 *   estimate — the singing-rate cap, `max(MIN, units * 630)`.
 *
 * The marker is a BOUND, not an answer, and that is a measured decision rather
 * than a cautious one. A bare timestamp is ambiguous in the format: it is
 * either an end mark or a section separator, and nothing distinguishes them.
 * Scored against `yrc` ground truth on 139 marker-bearing lines from 21 tracks
 * that carry both (the LRC and the word timings of the SAME NetEase recording):
 *
 *     rule                    MAE    p90     lines still crawling >2 s
 *     naive (successor)      7545  16740     78 / 139
 *     marker wins outright   1636   3982     36
 *     estimate only          2794   7676     37
 *     min(marker, cap)       1162   2840     15      <- shipped
 *     marker if <= 2x cap    1374   3290     29
 *
 * Letting the marker win outright is the user's own complaint back again: on
 * 孤勇者 the mark after 谁说站在光里的才算英雄 sits 300 ms before the next line,
 * claiming 18.06 s for a line `yrc` measures at 5.27 s. Every tolerance band
 * tried (1.5x to 4x the cap) scored worse than the plain minimum on both error
 * and crawl count, so there is no separator/end-mark discriminator to be had —
 * only the cap.
 *
 * The cap is a guess and an honest one: it cuts a genuinely sustained note
 * short (real sung spans reach 2.42x it). The worst residual measured is
 * "I just wanna let go (I, I just wanna let go)", sung for 48.6 s and estimated
 * at 5.05 s. Accepted deliberately — a line that finishes early and holds beats
 * one crawling at an eighth speed, which is the defect being fixed.
 */
export function estimateSungEndMs(input: {
  startMs: number;
  text: string;
  windowEndMs: number;
  markerMs?: number | undefined;
}): { endMs: number; source: LyricEndSource } {
  const { startMs, windowEndMs } = input;
  const marker = input.markerMs;
  let endMs = windowEndMs;
  let source: LyricEndSource = "next";
  if (marker !== undefined && marker > startMs && marker < endMs) {
    endMs = marker;
    source = "marker";
  }
  const cap = startMs + Math.max(LYRIC_MIN_LINE_MS, lyricUnits(input.text) * LYRIC_MS_PER_UNIT);
  if (cap < endMs) {
    endMs = cap;
    source = "estimate";
  }
  // A mark landing within a few frames of the line's own start is a separator
  // sitting on top of it, not a duration — 50 ms of highlight reads as a
  // dropped line. The floor never binds on the corpus above; it exists so a
  // pathological source cannot produce a line nobody can see.
  const floorMs = Math.min(windowEndMs, startMs + LYRIC_MIN_LINE_MS);
  if (endMs < floorMs) {
    endMs = floorMs;
    source = floorMs >= windowEndMs ? "next" : "estimate";
  }
  return { endMs: Math.round(endMs), source };
}

/* ------------------------------------------------------------------ */
/* Words -> cells                                                       */
/* ------------------------------------------------------------------ */

/**
 * One cell per UTF-8 codepoint of the line, which is exactly how both firmwares
 * lay a row out (`layoutRow`: ASCII 6 px, everything else 12 px, butted
 * together). Splitting here rather than on the device means the split is a pure
 * function with tests, both firmwares get the same answer, and the wire table's
 * index IS the glyph index — no arithmetic on the device to disagree about.
 *
 * A word's time is divided evenly over its non-whitespace codepoints (AMLL's
 * `timePerUnit`). Whitespace gets a zero-width slot so the cursor can never
 * come to rest on a space, and the index still lines up with the glyph row.
 *
 * Returns `[]` — meaning "line-level timing only" — when the words do not
 * reconstruct the line's text exactly. That check is the whole safety of the
 * scheme: a table one cell out of step lights the wrong character, which looks
 * like a firmware bug and is impossible to diagnose from a screenshot.
 */
export function lyricCells(
  line: Pick<MusicLyricLine, "startMs" | "endMs" | "text"> & {
    words?: readonly MusicLyricWord[] | undefined;
  },
): LyricCell[] {
  const words = line.words;
  if (!words || words.length === 0) return [];
  const glyphs = [...line.text];

  const cells: LyricCell[] = [];
  for (const word of words) {
    const codepoints = [...word.text];
    const lit = codepoints.filter((glyph) => glyph.trim() !== "").length;
    const span = Math.max(0, word.endMs - word.startMs);
    if (lit === 0) {
      for (const glyph of codepoints) {
        cells.push({ startMs: word.startMs, endMs: word.startMs, text: glyph });
      }
      continue;
    }
    let done = 0;
    for (const glyph of codepoints) {
      // Boundaries computed from the word's own start each time rather than
      // accumulated, so rounding cannot drift and the last lit cell lands
      // exactly on word.endMs.
      const from = word.startMs + Math.round((done * span) / lit);
      if (glyph.trim() === "") {
        cells.push({ startMs: from, endMs: from, text: glyph });
        continue;
      }
      done += 1;
      cells.push({
        startMs: from,
        endMs: word.startMs + Math.round((done * span) / lit),
        text: glyph,
      });
    }
  }

  if (cells.length !== glyphs.length) return [];
  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index]!.text !== glyphs[index]) return [];
  }
  // Time has to run the same way the row does. The wipe is monotonic in glyph
  // index by construction — that is what a karaoke line IS — so a table whose
  // onsets run backwards cannot drive one, and using it anyway would send the
  // cursor jumping between glyphs. Overlapping words (a duet, which qrc and lys
  // allow even though yrc has not been seen doing it) keep increasing onsets
  // and are fine; only genuinely reordered words are refused.
  for (let index = 1; index < cells.length; index += 1) {
    if (cells[index]!.startMs < cells[index - 1]!.startMs) return [];
  }
  return repairZeroLengthCells(cells, line.endMs);
}

// yrc declares 2.1% of its words with duration 0. Left alone those glyphs can
// never be the focused one, which reads as a dropped character. Stretching to
// the next onset keeps the source's own attack and infers only the release.
function repairZeroLengthCells(cells: LyricCell[], lineEndMs: number): LyricCell[] {
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;
    if (cell.text.trim() === "" || cell.endMs > cell.startMs) continue;
    let nextOnset = Number.POSITIVE_INFINITY;
    for (let ahead = index + 1; ahead < cells.length; ahead += 1) {
      if (cells[ahead]!.startMs > cell.startMs) {
        nextOnset = cells[ahead]!.startMs;
        break;
      }
    }
    if (!Number.isFinite(nextOnset)) {
      nextOnset = lineEndMs > cell.startMs ? lineEndMs : cell.startMs + ZERO_WORD_MAX_MS;
    }
    cell.endMs = Math.min(nextOnset, cell.startMs + ZERO_WORD_MAX_MS);
    if (cell.endMs <= cell.startMs) cell.endMs = cell.startMs + 1;
  }
  return cells;
}

/* ------------------------------------------------------------------ */
/* The cursor                                                           */
/* ------------------------------------------------------------------ */

/**
 * Which glyph is being sung, and how far into it.
 *
 * A strict generalisation of the scalar `progress` the three renderers used to
 * share: with no cell table it reproduces `floor(p * n)` and `p` bit for bit,
 * so a line-level-only track — the whole Spotify catalogue — behaves exactly as
 * it did. With a table the cursor walks the words at their real rate, holds on
 * the glyph that just finished during a gap between words (the semantics of
 * AMLL's per-word `clamp()`), and pins at the last glyph once the line is sung.
 */
export function lyricCursorAt(
  line: {
    startMs: number;
    endMs: number;
    cellCount: number;
    cells?: readonly LyricCell[] | undefined;
  },
  playheadMs: number,
): LyricCursor {
  const count = Math.max(0, Math.floor(line.cellCount));
  if (count <= 0) return { index: -1, frac: 0, progress: 0, phase: "pending" };
  const at = playheadMs;
  const cells = line.cells && line.cells.length === count ? line.cells : undefined;

  if (!cells) {
    // Untimed: today's arithmetic, unchanged.
    const span = Math.max(1, line.endMs - line.startMs);
    if (at < line.startMs) return { index: -1, frac: 0, progress: 0, phase: "pending" };
    const progress = Math.min(1, Math.max(0, (at - line.startMs) / span));
    if (progress >= 1) return { index: count - 1, frac: 1, progress: 1, phase: "held" };
    const index = Math.min(count - 1, Math.floor(progress * count));
    return { index, frac: progress * count - index, progress, phase: "singing" };
  }

  if (at < cells[0]!.startMs) return { index: -1, frac: 0, progress: 0, phase: "pending" };
  let last = -1;
  let lastLit = -1;
  for (let index = 0; index < count; index += 1) {
    const cell = cells[index]!;
    if (cell.endMs > cell.startMs) {
      lastLit = index;
      if (cell.startMs <= at) last = index;
    }
  }
  if (last < 0) return { index: -1, frac: 0, progress: 0, phase: "pending" };
  const cell = cells[last]!;
  if (at >= cell.endMs) {
    if (last >= lastLit && at >= line.endMs) {
      return { index: count - 1, frac: 1, progress: 1, phase: "held" };
    }
    // Between two words. Hold on the glyph that just finished rather than
    // advancing into one the singer has not reached.
    return { index: last, frac: 1, progress: (last + 1) / count, phase: "singing" };
  }
  const frac = (at - cell.startMs) / (cell.endMs - cell.startMs);
  return { index: last, frac, progress: (last + frac) / count, phase: "singing" };
}

/**
 * How far into the line's DISPLAY window the playhead is, as distinct from how
 * far into the singing.
 *
 * Only the cascade mode's entrance/exit choreography may use this. With the
 * sung progress now pinning at 1 the moment the voice stops, keying the exit
 * ramp on it would fly the line off the panel at the start of a 13-second
 * instrumental and leave the screen blank until the next line.
 */
export function lyricWindowProgress(
  line: { startMs: number; endMs: number; untilMs?: number | undefined },
  playheadMs: number,
): number {
  const until = line.untilMs !== undefined && line.untilMs > line.startMs
    ? line.untilMs
    : line.endMs;
  if (until <= line.startMs) return 0;
  return Math.min(1, Math.max(0, (playheadMs - line.startMs) / (until - line.startMs)));
}

/* ------------------------------------------------------------------ */
/* Wire encoding                                                        */
/* ------------------------------------------------------------------ */

/**
 * `d0,w0,d1,w1,…` — offsets and widths relative to the line's start, which is
 * already on the wire as `lyricat`.
 *
 * One field, comma separated, because the ZOS document parser splits at most
 * three tabs per record (`StateDoc::splitTabs(line, fields, 4)`); a tab-
 * separated table would be silently truncated.
 */
export function encodeLyricCells(cells: readonly LyricCell[], startMs: number): string {
  const parts: string[] = [];
  for (const cell of cells) {
    // Clamped to the line's own start BEFORE the width is measured, so the pair
    // still describes the same instants after decoding. Measuring the width
    // from the raw cell and then clamping the offset separately would slide the
    // glyph later by however much it began early — which a foreign timeline
    // (a Connect snapshot of a different master) can genuinely produce.
    const from = Math.max(startMs, cell.startMs);
    parts.push(
      String(Math.round(from - startMs)),
      String(Math.max(0, Math.round(cell.endMs - from))),
    );
  }
  return parts.join(",");
}

/** Inverse of encodeLyricCells; the firmwares implement this same loop. */
export function decodeLyricCells(encoded: string, startMs: number): LyricCell[] {
  if (encoded === "") return [];
  const parts = encoded.split(",");
  if (parts.length % 2 !== 0) return [];
  const cells: LyricCell[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const offset = Number(parts[index]);
    const width = Number(parts[index + 1]);
    if (!Number.isFinite(offset) || !Number.isFinite(width)) return [];
    cells.push({ startMs: startMs + offset, endMs: startMs + offset + width, text: "" });
  }
  return cells;
}
