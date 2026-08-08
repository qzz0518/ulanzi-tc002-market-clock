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
 */
export function spotlightOffsetPx(textWidth: number, lyricProgress: number): number {
  return 26 - Math.round(unit(lyricProgress) * Math.max(0, textWidth));
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
): number {
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
 */
export function beatKick(
  playing: boolean,
  hasLyricTiming: boolean,
  lyricProgress: number,
  glyphCount: number,
  timeMs: number,
): number {
  if (!playing) return 0;
  if (hasLyricTiming && glyphCount > 0) {
    return (1 - fract(unit(lyricProgress) * glyphCount)) ** 2;
  }
  return (1 - fract(timeMs / 500)) ** 2 * 0.7;
}
