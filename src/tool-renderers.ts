import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  PixelCanvas,
  type Rgb,
} from "./pixel-ui.ts";
import { drawPixelText, measurePixelText, sanitizePixelText } from "./pixel-font.ts";
import { cjkTextWidth, drawCjkText } from "./pixel-cjk.ts";
import { FULL_WIDTH_CELL, GLYPH_HEIGHT } from "../web/src/lib/pixel-glyphs.ts";
import type { JsonValue } from "./workspace.ts";

export interface ToolAnimation {
  frames: PixelCanvas[];
  frameDelaysMs: number[];
  label: string;
}

function optionNumber(
  options: Record<string, JsonValue>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(options[key]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function parseColor(value: JsonValue | undefined, fallback: Rgb): Rgb {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function animationPlan(durationMs: number, preferredFrames: number): number[] {
  const count = Math.max(1, Math.min(120, preferredFrames, Math.floor(durationMs / 20)));
  const base = Math.floor(durationMs / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? durationMs - base * (count - 1) : base
  );
}

export function renderNoticeBoard(
  durationMs: number,
  options: Record<string, JsonValue>,
): ToolAnimation {
  const message = sanitizePixelText(
    typeof options.message === "string" ? options.message : "HELLO PIXEL",
    96,
  );
  const foreground = parseColor(options.color, [0, 255, 102]);
  const background = parseColor(options.background, [0, 0, 0]);
  const scale = optionNumber(options, "fontScale", 2, 1, 2);
  const width = measurePixelText(message, scale, 1);
  const shouldScroll = options.scroll !== false && width > DISPLAY_WIDTH - 4;
  if (!shouldScroll) {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT, background);
    drawPixelText(
      canvas,
      message,
      Math.floor((DISPLAY_WIDTH - width) / 2),
      Math.floor((DISPLAY_HEIGHT - 5 * scale) / 2),
      foreground,
      scale,
      1,
    );
    return { frames: [canvas], frameDelaysMs: [durationMs], label: `通知 · ${message}` };
  }
  const distance = DISPLAY_WIDTH + width + 2;
  const speed = optionNumber(options, "speed", 12, 4, 40);
  const preferredFrames = Math.max(2, Math.ceil(distance / Math.max(1, speed / 8)));
  const delays = animationPlan(durationMs, preferredFrames);
  const frames = delays.map((_, index) => {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT, background);
    const progress = delays.length === 1 ? 1 : index / (delays.length - 1);
    const x = Math.round(DISPLAY_WIDTH + 1 - progress * distance);
    drawPixelText(
      canvas,
      message,
      x,
      Math.floor((DISPLAY_HEIGHT - 5 * scale) / 2),
      foreground,
      scale,
      1,
    );
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: `通知 · ${message}` };
}

const BIG_DIGITS: Readonly<Record<string, readonly string[]>> = {
  "0": ["#####", "#...#", "#...#", "#...#", "#...#", "#...#", "#...#", "#...#", "#####"],
  "1": ["..#..", "..#..", "..#..", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "2": ["#####", "....#", "....#", "....#", "#####", "#....", "#....", "#....", "#####"],
  "3": ["#####", "....#", "....#", "....#", "#####", "....#", "....#", "....#", "#####"],
  "4": ["#...#", "#...#", "#...#", "#...#", "#####", "....#", "....#", "....#", "....#"],
  "5": ["#####", "#....", "#....", "#....", "#####", "....#", "....#", "....#", "#####"],
  "6": ["#####", "#....", "#....", "#....", "#####", "#...#", "#...#", "#...#", "#####"],
  "7": ["#####", "....#", "....#", "....#", "....#", "....#", "....#", "....#", "....#"],
  "8": ["#####", "#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#", "#####"],
  "9": ["#####", "#...#", "#...#", "#...#", "#####", "....#", "....#", "....#", "#####"],
};

function drawBigDigit(
  canvas: PixelCanvas,
  digit: string,
  x: number,
  y: number,
  scale: number,
  color: Rgb,
): void {
  const glyph = BIG_DIGITS[digit];
  if (!glyph) return;
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row]!.length; column += 1) {
      if (glyph[row]![column] === "#") {
        canvas.fillRect(x + column * scale, y + row * scale, scale, scale, color);
      }
    }
  }
}

interface TimerPhase {
  kind: "work" | "rest";
  durationSeconds: number;
  roundsLeft: number;
}

function timerPhases(work: number, rest: number, rounds: number): TimerPhase[] {
  const phases: TimerPhase[] = [];
  for (let round = 0; round < rounds; round += 1) {
    phases.push({ kind: "work", durationSeconds: work, roundsLeft: rounds - round });
    if (rest > 0 && round < rounds - 1) {
      phases.push({ kind: "rest", durationSeconds: rest, roundsLeft: rounds - round - 1 });
    }
  }
  return phases;
}

function timerState(
  timestamp: number,
  options: Record<string, JsonValue>,
): { phase?: TimerPhase; seconds: number; fraction: number; done: boolean } {
  const work = Math.round(optionNumber(options, "workSeconds", 30, 1, 3_600));
  const rest = Math.round(optionNumber(options, "restSeconds", 15, 0, 3_600));
  const rounds = Math.round(optionNumber(options, "rounds", 8, 1, 99));
  const phases = timerPhases(work, rest, rounds);
  const running = options.running === true;
  const startedAtMs = optionNumber(options, "startedAtMs", timestamp, 0, 9_000_000_000_000);
  let elapsed = running ? Math.max(0, (timestamp - startedAtMs) / 1_000) : 0;
  for (const phase of phases) {
    if (elapsed < phase.durationSeconds) {
      const remaining = phase.durationSeconds - elapsed;
      return {
        phase,
        seconds: Math.ceil(remaining),
        fraction: remaining / phase.durationSeconds,
        done: false,
      };
    }
    elapsed -= phase.durationSeconds;
  }
  return { seconds: 0, fraction: 1, done: true };
}

function dim(color: Rgb, factor: number): Rgb {
  return color.map((channel) => Math.floor(channel * factor)) as unknown as Rgb;
}

function drawTimerLandscape(
  state: ReturnType<typeof timerState>,
  digits: string,
): PixelCanvas {
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  const base: Rgb = state.seconds <= 3
    ? [255, 48, 48]
    : state.phase?.kind === "rest" ? [255, 208, 0] : [0, 255, 102];
  const exact = Math.max(0, Math.min(1, state.fraction)) * DISPLAY_WIDTH;
  canvas.fillRect(0, 14, Math.floor(exact), 2, dim(base, 0.7));
  const text = String(state.seconds);
  if (digits !== "none") {
    let x = 2;
    for (const character of text) {
      drawBigDigit(canvas, character, x, 2, 1, [255, 255, 255]);
      x += 6;
    }
  }
  const dots = Math.min(6, state.phase?.roundsLeft ?? 0);
  for (let index = 0; index < dots; index += 1) canvas.fillRect(49 - index * 3, 1, 2, 1, [74, 85, 96]);
  return canvas;
}

function drawPortraitBuffer(
  state: ReturnType<typeof timerState>,
  digits: string,
): number[] {
  const width = 16;
  const height = 52;
  const pixels = Array(width * height).fill(0);
  const base = state.seconds <= 3 ? 0xff3030 : state.phase?.kind === "rest" ? 0xffd000 : 0x00ff66;
  const baseRgb: Rgb = [base >> 16 & 255, base >> 8 & 255, base & 255];
  const fill = dim(baseRgb, 0.6);
  const packedFill = fill[0] << 16 | fill[1] << 8 | fill[2];
  const exact = Math.max(0, Math.min(1, state.fraction)) * height;
  for (let y = height - Math.floor(exact); y < height; y += 1) {
    for (let x = 0; x < width; x += 1) if (y >= 0) pixels[y * width + x] = packedFill;
  }
  const rounds = Math.min(8, state.phase?.roundsLeft ?? 0);
  const start = Math.floor((width - (rounds * 2 - 1)) / 2);
  for (let index = 0; index < rounds; index += 1) pixels[start + index * 2] = 0x4a5560;
  if (digits !== "none") {
    const text = String(state.seconds);
    const place = (character: string, x0: number, y0: number, scale: number) => {
      const glyph = BIG_DIGITS[character];
      if (!glyph) return;
      for (let row = 0; row < 9; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          if (glyph[row]![column] !== "#") continue;
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              const x = x0 + column * scale + sx;
              const y = y0 + row * scale + sy;
              if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = 0xffffff;
            }
          }
        }
      }
    };
    if (digits === "v" && text.length <= 2) {
      const scale = text.length === 1 ? 3 : 2;
      const gap = 4;
      const totalHeight = text.length === 1 ? 27 : 36 + gap;
      const top = Math.floor((height - totalHeight) / 2);
      [...text].forEach((character, index) => place(character, Math.floor((width - 5 * scale) / 2), top + index * (9 * scale + gap), scale));
    } else {
      const scale = text.length <= 2 ? 1 : 1;
      const totalWidth = text.length * 5 * scale + (text.length - 1) * scale;
      [...text].forEach((character, index) => place(character, Math.floor((width - totalWidth) / 2) + index * 6 * scale, Math.floor((height - 9 * scale) / 2), scale));
    }
  }
  return pixels;
}

function drawTimerPortrait(
  state: ReturnType<typeof timerState>,
  orientation: string,
  digits: string,
): PixelCanvas {
  const portrait = drawPortraitBuffer(state, digits);
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  for (let py = 0; py < 52; py += 1) {
    for (let px = 0; px < 16; px += 1) {
      const packed = portrait[py * 16 + px]!;
      if (!packed) continue;
      const x = orientation === "pv2" ? 51 - py : py;
      const y = orientation === "pv2" ? px : 15 - px;
      canvas.setPixel(x, y, [packed >> 16 & 255, packed >> 8 & 255, packed & 255]);
    }
  }
  return canvas;
}

export function renderTimerColumn(
  durationMs: number,
  options: Record<string, JsonValue>,
  nowMs = Date.now(),
): ToolAnimation {
  const frameCount = Math.max(1, Math.min(90, Math.ceil(durationMs / 500)));
  const delays = animationPlan(durationMs, frameCount);
  const orientation = ["pv", "pv2", "land"].includes(String(options.orientation))
    ? String(options.orientation)
    : "pv";
  const digits = ["v", "h", "none"].includes(String(options.digits))
    ? String(options.digits)
    : "v";
  let elapsed = 0;
  const frames = delays.map((delay) => {
    const state = timerState(nowMs + elapsed, options);
    elapsed += delay;
    return orientation === "land"
      ? drawTimerLandscape(state, digits)
      : drawTimerPortrait(state, orientation, digits);
  });
  return { frames, frameDelaysMs: delays, label: "计时柱" };
}

const POMODORO_FLASH_SECONDS = 1.2;

interface PomodoroState {
  phase: "work" | "break";
  remainingSeconds: number;
  fraction: number;
  running: boolean;
  flash: boolean;
}

/**
 * Stateless extrapolation, like the interval timer: the item stores only the
 * phase lengths and the moment the user pressed start, and every frame derives
 * its own position in the work/break cycle.
 */
function pomodoroState(
  timestamp: number,
  options: Record<string, JsonValue>,
): PomodoroState {
  const workSeconds = Math.round(optionNumber(options, "workMinutes", 25, 1, 180)) * 60;
  const breakSeconds = Math.round(optionNumber(options, "breakMinutes", 5, 0, 60)) * 60;
  const cycleSeconds = workSeconds + breakSeconds;
  const running = options.running === true;
  const startedAtMs = optionNumber(options, "startedAtMs", timestamp, 0, 9_000_000_000_000);
  const elapsed = running ? Math.max(0, (timestamp - startedAtMs) / 1_000) : 0;
  const position = elapsed % cycleSeconds;
  const inWork = position < workSeconds;
  const phaseSeconds = inWork ? workSeconds : breakSeconds;
  const sinceBoundary = inWork ? position : position - workSeconds;
  const remaining = phaseSeconds - sinceBoundary;
  return {
    phase: inWork ? "work" : "break",
    remainingSeconds: Math.ceil(remaining),
    fraction: remaining / phaseSeconds,
    running,
    flash: running && elapsed >= workSeconds && sinceBoundary < POMODORO_FLASH_SECONDS,
  };
}

/** Mix `from` towards `to`; ratio 0 keeps `from`, 1 lands on `to`. */
function mix(from: Rgb, to: Rgb, ratio: number): Rgb {
  return from.map((channel, index) =>
    Math.round(channel + (to[index]! - channel) * ratio)
  ) as unknown as Rgb;
}

export function drawBigClockText(
  canvas: PixelCanvas,
  text: string,
  y: number,
  color: Rgb,
  regionX = 0,
  regionWidth = DISPLAY_WIDTH,
): void {
  let width = 0;
  for (const character of text) width += (character === ":" ? 1 : 5) + 1;
  width -= 1;
  let x = regionX + Math.floor((regionWidth - width) / 2);
  for (const character of text) {
    if (character === ":") {
      canvas.setPixel(x, y + 2, color);
      canvas.setPixel(x, y + 6, color);
      x += 2;
      continue;
    }
    drawBigDigit(canvas, character, x, y, 1, color);
    x += 6;
  }
}

interface PomodoroPalette {
  work: Rgb;
  rest: Rgb;
  digit: Rgb;
}

const POMODORO_LEAF: Rgb = [46, 180, 90];

/** 10x10 tomato at x=2..11,y=3..12: round fruit, sheen, two leaf strokes. */
function drawTomatoIcon(canvas: PixelCanvas, body: Rgb, sheen: Rgb, leaf: Rgb): void {
  canvas.fillRect(3, 5, 8, 8, body);
  for (const [x, y] of [[3, 5], [10, 5], [3, 12], [10, 12]] as const) {
    canvas.setPixel(x, y, [0, 0, 0]);
  }
  canvas.fillRect(4, 6, 2, 2, sheen);
  canvas.fillRect(6, 3, 3, 1, leaf);
  canvas.fillRect(5, 4, 3, 1, leaf);
}

function drawPomodoro(
  state: PomodoroState,
  palette: PomodoroPalette,
  frameIndex: number,
): PixelCanvas {
  const accent = state.phase === "work" ? palette.work : palette.rest;
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  if (state.flash) {
    canvas.fillRect(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, frameIndex % 2 ? [255, 255, 255] : accent);
    return canvas;
  }
  // Paused keeps the whole layout and just sinks it to 35% brightness.
  const tone = (color: Rgb): Rgb => (state.running ? color : dim(color, 0.35));
  drawTomatoIcon(canvas, tone(accent), tone(mix(accent, [255, 255, 255], 0.35)), tone(POMODORO_LEAF));
  const minutes = Math.floor(state.remainingSeconds / 60);
  const seconds = state.remainingSeconds % 60;
  // The colon stays lit: a blinking separator reads as a glitch on the panel.
  const text = minutes > 99
    ? String(minutes)
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  drawBigClockText(canvas, text, 3, tone(palette.digit), 13, DISPLAY_WIDTH - 13);
  // Bottom row: remaining share of the phase; unlit pixels stay pure black.
  const barLength = Math.round(Math.max(0, Math.min(1, state.fraction)) * DISPLAY_WIDTH);
  if (barLength > 0) canvas.fillRect(0, 15, barLength, 1, tone(accent));
  return canvas;
}

export function renderPomodoro(
  durationMs: number,
  options: Record<string, JsonValue>,
  nowMs = Date.now(),
): ToolAnimation {
  const palette: PomodoroPalette = {
    work: parseColor(options.workColor, [255, 72, 48]),
    rest: parseColor(options.breakColor, [0, 214, 122]),
    digit: parseColor(options.digitColor, [255, 255, 255]),
  };
  const delays = animationPlan(durationMs, Math.max(1, Math.ceil(durationMs / 250)));
  let elapsed = 0;
  const frames = delays.map((delay, index) => {
    const state = pomodoroState(nowMs + elapsed, options);
    elapsed += delay;
    return drawPomodoro(state, palette, index);
  });
  return { frames, frameDelaysMs: delays, label: "番茄钟" };
}

const TARGET_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONFETTI_COLORS: readonly Rgb[] = [
  [255, 72, 48],
  [255, 208, 0],
  [0, 255, 102],
  [0, 229, 255],
  [255, 111, 181],
  [255, 255, 255],
];

function parseTargetDate(value: JsonValue | undefined): Date | undefined {
  const match = typeof value === "string" ? TARGET_DATE_PATTERN.exec(value.trim()) : null;
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  const valid = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return valid ? date : undefined;
}

function sanitizeCjkTitle(value: JsonValue | undefined, fallback: string): string {
  const characters = typeof value === "string"
    ? [...value].filter((character) => {
        const codepoint = character.codePointAt(0)!;
        return codepoint >= 0x20 && codepoint !== 0x7f;
      })
    : [];
  const text = characters.join("").trim();
  return text.length > 0 ? [...text].slice(0, 16).join("") : fallback;
}

/** Whole local days from today's midnight to the target's midnight. */
function daysUntil(nowMs: number, target: Date): number {
  const now = new Date(nowMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target.getTime() - today) / 86_400_000);
}

function drawScrollingCjk(
  canvas: PixelCanvas,
  text: string,
  regionX: number,
  regionWidth: number,
  y: number,
  color: Rgb,
  offset: number,
): void {
  const width = cjkTextWidth(text);
  if (width <= regionWidth) {
    drawCjkText(canvas, text, regionX + Math.floor((regionWidth - width) / 2), y, color);
    return;
  }
  const stripWidth = width + 12;
  const strip = new PixelCanvas(stripWidth, GLYPH_HEIGHT);
  drawCjkText(strip, text, 0, 0, color);
  const shift = ((offset % stripWidth) + stripWidth) % stripWidth;
  for (let column = 0; column < regionWidth; column += 1) {
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      const pixel = strip.getPixel((shift + column) % stripWidth, row);
      if (pixel[0] || pixel[1] || pixel[2]) canvas.setPixel(regionX + column, y + row, pixel);
    }
  }
}

const COUNTDOWN_TITLE_COLOR: Rgb = [235, 240, 248];
const COUNTDOWN_PAST_ACCENT: Rgb = [255, 140, 40];

interface CountdownLayout {
  /** Left edge of the 12x12「天」cell, flush with the right border. */
  unitX: number;
  digitsX: number;
  /** Scroll region for the title, starting at x=1. */
  titleWidth: number;
}

/** Days-Matter hierarchy, laid out right to left:「天」, big digits, title. */
function countdownLayout(days: number): CountdownLayout {
  const digitsWidth = String(Math.min(9_999, Math.abs(days))).length * 6 - 1;
  const unitX = DISPLAY_WIDTH - FULL_WIDTH_CELL;
  const digitsX = unitX - 2 - digitsWidth;
  return { unitX, digitsX, titleWidth: digitsX - 3 };
}

function drawCountdownDays(title: string, days: number, offset: number, accent: Rgb): PixelCanvas {
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  const layout = countdownLayout(days);
  const text = String(Math.min(9_999, Math.abs(days)));
  drawCjkText(canvas, "天", layout.unitX, 2, dim(accent, 0.55));
  [...text].forEach((character, index) => {
    drawBigDigit(canvas, character, layout.digitsX + index * 6, 3, 1, accent);
  });
  if (layout.titleWidth >= 6) {
    drawScrollingCjk(canvas, title, 1, layout.titleWidth, 2, COUNTDOWN_TITLE_COLOR, offset);
  }
  return canvas;
}

function drawCountdownToday(title: string, frameIndex: number): PixelCanvas {
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  for (let index = 0; index < 26; index += 1) {
    const column = (index * 19 + Math.round(Math.sin(index + frameIndex * 0.2) * 2)) % DISPLAY_WIDTH;
    const speed = 0.3 + (index % 5) * 0.14;
    const y = Math.round((index * 7 + frameIndex * speed) % (DISPLAY_HEIGHT + 4)) - 2;
    canvas.setPixel(column, y, CONFETTI_COLORS[index % CONFETTI_COLORS.length]!);
  }
  const color = CONFETTI_COLORS[Math.floor(frameIndex / 3) % CONFETTI_COLORS.length]!;
  drawScrollingCjk(canvas, title, 1, DISPLAY_WIDTH - 2, 2, color, frameIndex);
  return canvas;
}

export function renderCountdown(
  durationMs: number,
  options: Record<string, JsonValue>,
  nowMs = Date.now(),
): ToolAnimation {
  const title = sanitizeCjkTitle(options.title, "倒数日");
  const target = parseTargetDate(options.targetDate);
  if (!target) {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    const notice = "日期无效";
    drawCjkText(
      canvas,
      notice,
      Math.floor((DISPLAY_WIDTH - cjkTextWidth(notice)) / 2),
      Math.floor((DISPLAY_HEIGHT - GLYPH_HEIGHT) / 2),
      [255, 176, 32],
    );
    return { frames: [canvas], frameDelaysMs: [durationMs], label: "倒数日 · 日期无效" };
  }
  const days = daysUntil(nowMs, target);
  // Elapsed days keep their warm-orange meaning; the accent option colours the rest.
  const accent = days < 0 ? COUNTDOWN_PAST_ACCENT : parseColor(options.accentColor, [0, 229, 255]);
  const scrolling = cjkTextWidth(title) > countdownLayout(days).titleWidth;
  if (days !== 0 && !scrolling) {
    return {
      frames: [drawCountdownDays(title, days, 0, accent)],
      frameDelaysMs: [durationMs],
      label: `倒数日 · ${title}`,
    };
  }
  const delays = animationPlan(durationMs, Math.max(2, Math.ceil(durationMs / 80)));
  // Exactly one strip column per frame: uneven steps smear on the LED matrix.
  const frames = delays.map((_, index) =>
    days === 0 ? drawCountdownToday(title, index) : drawCountdownDays(title, days, index, accent)
  );
  return { frames, frameDelaysMs: delays, label: `倒数日 · ${title}` };
}

export function renderCanvasContent(
  durationMs: number,
  options: Record<string, JsonValue>,
): ToolAnimation {
  const raw = options.pixels;
  if (!Array.isArray(raw) || raw.length !== DISPLAY_WIDTH * DISPLAY_HEIGHT) {
    throw new Error(`canvas pixels must contain exactly ${DISPLAY_WIDTH * DISPLAY_HEIGHT} colors`);
  }
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  raw.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffff) {
      throw new Error("canvas pixels must be RGB integers between 0 and 16777215");
    }
    if (value === 0) return;
    canvas.setPixel(index % DISPLAY_WIDTH, Math.floor(index / DISPLAY_WIDTH), [
      value >> 16 & 255,
      value >> 8 & 255,
      value & 255,
    ]);
  });
  return { frames: [canvas], frameDelaysMs: [durationMs], label: "画板" };
}
