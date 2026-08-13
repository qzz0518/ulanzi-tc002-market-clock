export const MUSIC_MODES = [
  { id: "ticker", name: "走带", note: "整字格变速" },
  { id: "skyline", name: "天际", note: "频谱同屏" },
  { id: "spotlight", name: "聚光", note: "焦点居中" },
  { id: "cascade", name: "升降", note: "整句升降" },
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
