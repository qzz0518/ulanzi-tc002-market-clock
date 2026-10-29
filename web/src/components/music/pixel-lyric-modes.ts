export const MUSIC_MODES = [
  { id: "ticker", name: "走带", note: "整字格变速" },
  { id: "skyline", name: "天际", note: "频谱同屏" },
  { id: "spotlight", name: "聚光", note: "焦点居中" },
  { id: "cascade", name: "升降", note: "整句升降" },
  { id: "rings", name: "年轮", note: "逐字涟漪" },
  { id: "tilt", name: "倾诉", note: "逐字浮现" },
] as const;

export type MusicMode = typeof MUSIC_MODES[number]["id"];

export function isMusicMode(value: string | null): value is MusicMode {
  return MUSIC_MODES.some((mode) => mode.id === value);
}

export function musicModeNote(mode: MusicMode): string {
  return MUSIC_MODES.find((candidate) => candidate.id === mode)?.note ?? "";
}

function unit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function fract(value: number): number {
  return value - Math.floor(value);
}

/**
 * Spotlight mode locks the currently sung pixel column to the screen center
 * (x = 26): the returned value is the screen x of the bitmap's left edge.
 *
 * Superseded for drawing by `spotlightOffsetForFocusPx`, which takes the pixel
 * the cursor is genuinely on rather than deriving one from a scalar progress.
 * Kept because it is half of the shared numeric core: `LyricModes.h` still
 * carries the same two lines, and this is the copy the parity tests compare it
 * against. Until both firmwares move to the cursor, deleting it here would
 * remove the only thing holding them to the same arithmetic.
 */
export function spotlightOffsetPx(textWidth: number, lyricProgress: number): number {
  return spotlightOffsetForFocusPx(unit(lyricProgress) * Math.max(0, textWidth));
}

/**
 * The same lock, driven by the pixel the cursor is actually on.
 *
 * `progress * textWidth` only finds the sung column when time is spread evenly
 * over the row, which stops being true the moment a line has real word
 * timings — the singer holds one glyph for a second and races through four
 * more. The cursor knows which cell it is in and how far, so the focus pixel
 * comes from the cell table instead.
 */
export function spotlightOffsetForFocusPx(focusPx: number): number {
  return 26 - Math.round(Math.max(0, focusPx));
}

/**
 * Index of the glyph span being sung at a bitmap pixel position. Gaps
 * (spaces) keep the previous glyph focused so the spotlight never goes dark.
 */
export function spanIndexAtPx(
  spans: readonly { start: number; end: number }[],
  px: number,
): number {
  if (spans.length === 0) return -1;
  let index = 0;
  for (let candidate = 0; candidate < spans.length; candidate += 1) {
    if (spans[candidate]!.start > px) break;
    index = candidate;
  }
  return index;
}

const CASCADE_ENTER_END = 0.14;
const CASCADE_EXIT_START = 0.86;

/**
 * Cascade mode's vertical band position: the 12px line rises from below the
 * frame (y = 16) into place (y = 2), holds, then lifts out through the top.
 */
export function cascadeBandY(lyricProgress: number, reducedMotion = false): number {
  const progress = unit(lyricProgress);
  if (reducedMotion || progress <= 0) return 2;
  if (progress < CASCADE_ENTER_END) {
    const t = progress / CASCADE_ENTER_END;
    const eased = 1 - (1 - t) ** 3;
    return Math.round(16 - 14 * eased);
  }
  if (progress > CASCADE_EXIT_START) {
    const t = (progress - CASCADE_EXIT_START) / (1 - CASCADE_EXIT_START);
    return Math.round(2 - 18 * t ** 3);
  }
  return 2;
}

export function cascadePhase(
  lyricProgress: number,
  reducedMotion = false,
): "enter" | "hold" | "exit" {
  const progress = unit(lyricProgress);
  if (reducedMotion || progress <= 0) return "hold";
  if (progress < CASCADE_ENTER_END) return "enter";
  if (progress > CASCADE_EXIT_START) return "exit";
  return "hold";
}

export const SKYLINE_BARS = 17;
const SKYLINE_SLOT_MS = 125;

/**
 * Deterministic pseudo-spectrum level for one skyline bar, quantized to
 * 8 fps slots so the LED refresh stays chunky and reproducible. `kick`
 * (0..1) is the beat impulse — 1 right on a syllable, decaying after it.
 */
export function skylineBarLevel(
  bar: number,
  timeMs: number,
  playing: boolean,
  kick: number,
  maxLevel: number,
  realLevel?: number,
): number {
  if (realLevel !== undefined && Number.isFinite(realLevel)) {
    const energy = playing
      ? unit(realLevel) * 0.9 + unit(kick) * 0.1
      : Math.min(0.18, unit(realLevel));
    return Math.round(Math.min(1, energy) * Math.max(0, maxLevel));
  }
  const slot = Math.floor(Math.max(0, timeMs) / SKYLINE_SLOT_MS);
  const t = slot * (SKYLINE_SLOT_MS / 1000);
  const noise = fract(Math.sin((bar + 1) * 127.1 + slot * 311.7) * 43758.5453);
  const sway = 0.5 + 0.5 * Math.sin(t * 2.4 + bar * 0.9);
  const swell = 0.5 + 0.5 * Math.sin(t * 0.8 + bar * 0.35 + 2.1);
  const center = (SKYLINE_BARS - 1) / 2;
  const stage = 1 - (Math.abs(bar - center) / center) * 0.4;
  const energy = playing ? 0.55 + 0.45 * unit(kick) : 0.18;
  const raw = (0.25 + 0.55 * sway * swell + 0.45 * noise) * stage * energy;
  return Math.round(Math.min(1, raw) * Math.max(0, maxLevel));
}

/**
 * Beat impulse shared by animated modes: snaps to 1 as each glyph starts
 * and decays until the next one; falls back to a 120 BPM pulse without
 * lyric timing.
 *
 * Takes the cursor's position INSIDE the current cell rather than a whole-line
 * progress and a glyph count. It only ever wanted `fract(progress * n)`, and
 * with word-level timing that identity no longer holds — cells are not equal
 * width in time — so the cursor is the only thing that can answer it. Passing
 * the fraction directly also removes the float noise that turned a kick of 1
 * into 0.999 → 0 right on a syllable onset.
 */
export function beatKick(
  playing: boolean,
  hasLyricTiming: boolean,
  cellFrac: number,
  timeMs: number,
): number {
  if (!playing) return 0;
  if (hasLyricTiming) return (1 - unit(cellFrac)) ** 2;
  return (1 - fract(timeMs / 500)) ** 2 * 0.7;
}

/**
 * The break after a line, as a fraction 0..1, or -1 when there is none.
 *
 * A held line used to stay up, complete, for the whole instrumental — thirteen
 * seconds of a frozen row that reads as a stuck panel. Once the gap to the next
 * line is long enough to be an instrumental rather than a breath, the row gives
 * way to three dots that fill as the next line nears. The two numbers are
 * folia's Hanabi break rule: a gap of 3 s or more is a break, and the line is
 * let go 0.6 s after its last word so a trailing syllable is never cut.
 *
 * Mirrored by `lyricInterludeProgress` in ZOS's visual/LyricRings.h.
 */
export const INTERLUDE_MIN_GAP_MS = 3_000;
export const INTERLUDE_LEAD_MS = 600;

export function interludeProgress(endMs: number, untilMs: number, playheadMs: number): number {
  if (untilMs - endMs < INTERLUDE_MIN_GAP_MS) return -1;
  const from = endMs + INTERLUDE_LEAD_MS;
  if (playheadMs < from || playheadMs >= untilMs) return -1;
  return unit((playheadMs - from) / (untilMs - from));
}

/** The three interlude dots: 2 × 2 each, centred on the panel. */
export const INTERLUDE_DOT_X = [19, 25, 31] as const;
export const INTERLUDE_DOT_Y = 7;
export const INTERLUDE_BREATH_MS = 420;

/**
 * Which palette tier a dot is lit in: filled dots in the sung tier, the one
 * filling now breathing between the focus and trailing tiers, the rest waiting.
 * Tiers rather than brightness so the panel never shows a colour the skin does
 * not own.
 */
export function interludeDotTier(
  dot: number,
  progress: number,
  timeMs: number,
): "primary" | "secondary" | "context" | "muted" {
  const lit = unit(progress) * INTERLUDE_DOT_X.length - dot;
  if (lit >= 1) return "secondary";
  if (lit <= 0) return "muted";
  return Math.floor(Math.max(0, timeMs) / INTERLUDE_BREATH_MS) % 2 === 0 ? "primary" : "context";
}

/**
 * 年轮's ripple around the glyph being sung: its Chebyshev distance from the
 * glyph's ink, 1 for the first half of the glyph and 2 for the second, so each
 * sung character throws one ring outward. folia's 52Hz grows a ring from the
 * glyph outlines on every beat; at 12 px glyphs on a 16-row panel only the two
 * nearest rings have anywhere to land, so the ring is a two-step pulse.
 */
export function haloRadius(cellFrac: number): 1 | 2 {
  return unit(cellFrac) < 0.5 ? 1 : 2;
}

/**
 * The ring's tier: the inner ring in the sung tier, the outer one a step down.
 * Bright enough to read on a full line, where it only has the rows above and
 * below the text and the gaps beside the glyph; a 1 px dark gutter around every
 * other glyph's strokes (`paintHalo`) is what keeps it from merging into them.
 */
export function haloTier(radius: number): "secondary" | "context" {
  return radius <= 1 ? "secondary" : "context";
}

/** 年轮 lifts the glyph being sung by a pixel for the first half of it. */
export function ringsHopPx(cellFrac: number): number {
  return unit(cellFrac) < 0.5 ? 1 : 0;
}

// ---- 倾诉 -------------------------------------------------------------------

/**
 * A codepoint a 倾诉 phrase ends on: a space or punctuation, ASCII, CJK or
 * fullwidth. Explicit ranges rather than \p{P}, so ZOS's copy in
 * visual/LyricRings.h agrees codepoint for codepoint. An apostrophe or hyphen
 * joins a word to the next (It's, re-run) rather than ending it.
 */
export function tiltBreaks(cp: number): boolean {
  if (cp === 0x27 || cp === 0x2019 || cp === 0x2d) return false;
  return cp === 0x20 || cp === 0xa0 || cp === 0x3000
    || (cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40)
    || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e)
    || (cp >= 0x2000 && cp <= 0x206f) || (cp >= 0x3001 && cp <= 0x303f)
    || (cp >= 0xff01 && cp <= 0xff0f) || (cp >= 0xff1a && cp <= 0xff20)
    || (cp >= 0xff3b && cp <= 0xff40) || (cp >= 0xff5b && cp <= 0xff65);
}

/**
 * The phrases 倾诉 breaks a line into, as [from, to) cell ranges: up to and
 * including each break, a run of nothing but breaks folded into the phrase
 * before it, and a phrase longer than six glyphs cut into pieces of about four
 * (mygo's stageUnits, which the folia style it ports is built on).
 */
export function tiltUnits(codepoints: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let from = 0;
  for (let index = 0; index < codepoints.length; index += 1) {
    if (!tiltBreaks(codepoints[index]!) && index + 1 < codepoints.length) continue;
    let allBreaks = true;
    for (let k = from; k <= index; k += 1) if (!tiltBreaks(codepoints[k]!)) allBreaks = false;
    if (allBreaks && runs.length > 0) runs[runs.length - 1]![1] = index + 1;
    else runs.push([from, index + 1]);
    from = index + 1;
  }
  const units: Array<[number, number]> = [];
  for (const [start, end] of runs) {
    const length = end - start;
    const pieces = length > 6 ? Math.floor((length + 3) / 4) : 1;
    for (let k = 0; k < pieces; k += 1) {
      units.push([start + Math.floor((length * k) / pieces), start + Math.floor((length * (k + 1)) / pieces)]);
    }
  }
  return units;
}

/**
 * A 32-bit integer hash both renderers compute identically (Math.imul here,
 * uint32_t there), for every choice that has to look random yet land on the
 * same pixel in the browser and on the panel: which phrase leans, where a spark
 * flies.
 */
export function lyricHash(seed: number, salt: number): number {
  let h = Math.imul((seed >>> 0) ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Which phrase leans, or -1: one of them whenever the line has two or more. */
export function tiltLeanUnit(lineStartMs: number, unitCount: number): number {
  if (unitCount < 2) return -1;
  return lyricHash(lineStartMs, 99) % unitCount;
}

/** Glyphs surface one after another, this far apart, in three steps of this long. */
export const TILT_STAGGER_MS = 50;
export const TILT_STEP_MS = 120;

/**
 * How far glyph `index` has surfaced `sinceLineMs` into its line: 0 hidden,
 * 1 a faint outline one pixel low (two for a leaning glyph), 2 settled.
 */
export function tiltStage(index: number, sinceLineMs: number): 0 | 1 | 2 {
  const appear = sinceLineMs - index * TILT_STAGGER_MS;
  if (appear < 0) return 0;
  if (appear < TILT_STEP_MS * 2) return 1;
  return 2;
}

/**
 * Where a leaning glyph sits relative to the row: up and down by turns, one
 * pixel once settled and two while it surfaces.
 */
export function tiltLeanOffset(leanIndex: number, stage: 0 | 1 | 2): number {
  const sign = leanIndex % 2 === 0 ? -1 : 1;
  return stage === 2 ? sign : sign * 2;
}

// ---- 火花 -------------------------------------------------------------------

export const SPARK_COUNT = 6;
export const SPARK_COUNT_LAST = 10;

/**
 * One spark's head and tail, in panel pixels, `t` (0..1) through the glyph it
 * flies off: centre (cx, cy), half extents (hw, hh). folia/mygo's sparks — out
 * from the glyph's edge, each at its own speed and angle, slowing as they go,
 * farther off a line's last glyph. Rounded with floor(v + 0.5) on both sides,
 * never Math.round / lround, which disagree on negative halves.
 */
export function sparkPixels(
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  seed: number,
  spark: number,
  count: number,
  last: boolean,
  t: number,
): { head: [number, number]; tail: [number, number] } {
  const a = (lyricHash(seed, spark * 2) & 0xffff) / 65536;
  const b = (lyricHash(seed, spark * 2 + 1) & 0xffff) / 65536;
  const angle = (2 * Math.PI * (spark + 0.7 * a)) / count;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const edge = hw * 0.7 * Math.abs(dx) + hh * 0.7 * Math.abs(dy);
  const reach = last ? 14 : 9;
  const u = Math.min(1, Math.max(0, t));
  const out = 1 - (1 - u) * (1 - u) * (1 - u);
  const head = edge + reach * (0.55 + 0.45 * b) * out;
  const tail = Math.max(edge, head - 2);
  return {
    head: [Math.floor(cx + dx * head + 0.5), Math.floor(cy + dy * head + 0.5)],
    tail: [Math.floor(cx + dx * tail + 0.5), Math.floor(cy + dy * tail + 0.5)],
  };
}

/** A spark cools as it flies: focus tier, then sung, then trailing. */
export function sparkTier(t: number): "primary" | "secondary" | "context" {
  return t < 0.34 ? "primary" : t < 0.67 ? "secondary" : "context";
}
