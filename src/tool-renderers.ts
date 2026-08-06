import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  PixelCanvas,
  type Rgb,
} from "./pixel-ui.ts";
import { drawPixelText, measurePixelText, sanitizePixelText } from "./pixel-font.ts";
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
