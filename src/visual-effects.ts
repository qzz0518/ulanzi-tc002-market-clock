import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  PixelCanvas,
  type Rgb,
} from "./pixel-ui.ts";
import { drawPixelText, measurePixelText, sanitizePixelText } from "./pixel-font.ts";
import { cjkTextWidth, drawCjkText } from "./pixel-cjk.ts";
import { GLYPH_HEIGHT } from "../web/src/lib/pixel-glyphs.ts";
import { drawBigClockText } from "./tool-renderers.ts";
import type { WeatherCondition } from "./weather/client.ts";

export const VISUAL_EFFECT_IDS = [
  "ant",
  "aquarium",
  "fire",
  "fireworks",
  "flipclock",
  "flux",
  "life",
  "matrixclock",
  "maze",
  "pet",
  "sand",
  "starfield",
  "suncolor",
  "weather",
] as const;

export type VisualEffectId = (typeof VISUAL_EFFECT_IDS)[number];

export interface VisualAnimation {
  frames: PixelCanvas[];
  frameDelaysMs: number[];
  label: string;
}

/** Current conditions the weather particles read; the renderer never fetches anything itself. */
export interface WeatherVisualInput {
  condition: WeatherCondition;
  temperatureC: number;
  precipitationMm: number;
  cloudCoverPercent: number;
}

export interface VisualEffectOptions {
  speed?: number;
  petAction?: "idle" | "walk" | "run" | "attack" | "random";
  lifeStart?: "digits" | "soup";
  fluxPalette?: "cycle" | "cyan" | "violet" | "ember" | "mint";
  fluxBurst?: "always" | "minute" | "never";
  fireworkDensity?: number;
  weather?: WeatherVisualInput;
  /** Short CJK hint drawn instead of the particles when weather data is unavailable. */
  weatherNotice?: string;
  /** Geocoded place name drawn top-left on the weather panel; empty draws nothing. */
  weatherPlace?: string;
  latitude?: number;
  longitude?: number;
}

type Random = () => number;

function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function animationPlan(durationMs: number, tickMs: number, maximumFrames = 120): number[] {
  const count = Math.max(1, Math.min(maximumFrames, Math.ceil(durationMs / tickMs)));
  const base = Math.floor(durationMs / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? durationMs - base * (count - 1) : base
  );
}

function color(packed: number): Rgb {
  return [packed >> 16 & 255, packed >> 8 & 255, packed & 255];
}

function setPacked(canvas: PixelCanvas, x: number, y: number, packed: number): void {
  if (packed !== 0) canvas.setPixel(x, y, color(packed));
}

function mixColor(from: Rgb, to: Rgb, ratio: number): Rgb {
  const amount = Math.max(0, Math.min(1, ratio));
  return [0, 1, 2].map((channel) =>
    Math.round(from[channel]! + (to[channel]! - from[channel]!) * amount)
  ) as unknown as Rgb;
}

function scaleColor(value: Rgb, factor: number): Rgb {
  return value.map((channel) => Math.max(0, Math.min(255, Math.round(channel * factor)))) as unknown as Rgb;
}

/** Fully saturated HSV ramp; `value` doubles as the particle brightness. */
function hueColor(hue: number, value: number): Rgb {
  const sector = ((hue % 360) + 360) % 360 / 60;
  const peak = Math.max(0, Math.min(1, value));
  const ramp = peak * (1 - Math.abs(sector % 2 - 1));
  const channels = sector < 1
    ? [peak, ramp, 0]
    : sector < 2
      ? [ramp, peak, 0]
      : sector < 3
        ? [0, peak, ramp]
        : sector < 4
          ? [0, ramp, peak]
          : sector < 5
            ? [ramp, 0, peak]
            : [peak, 0, ramp];
  return channels.map((channel) => Math.round(channel * 255)) as unknown as Rgb;
}

function dimRegion(canvas: PixelCanvas, x: number, y: number, width: number, height: number, factor: number): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      if (column < 0 || row < 0 || column >= canvas.width || row >= canvas.height) continue;
      canvas.setPixel(column, row, scaleColor(canvas.getPixel(column, row), factor));
    }
  }
}

function drawCjkNotice(text: string, tint: Rgb): PixelCanvas {
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  const width = cjkTextWidth(text);
  drawCjkText(
    canvas,
    text,
    Math.floor((DISPLAY_WIDTH - width) / 2),
    Math.floor((DISPLAY_HEIGHT - GLYPH_HEIGHT) / 2),
    tint,
  );
  return canvas;
}

function renderAnt(durationMs: number, random: Random, speed: number): VisualAnimation {
  const delays = animationPlan(durationMs, 70 / speed);
  const grid = Array.from({ length: DISPLAY_HEIGHT }, () => new Uint8Array(DISPLAY_WIDTH));
  let x = DISPLAY_WIDTH >> 1;
  let y = DISPLAY_HEIGHT >> 1;
  let direction = 0;
  const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
  const step = () => {
    if (grid[y]![x]) {
      direction = (direction + 1) % 4;
      grid[y]![x] = 0;
    } else {
      direction = (direction + 3) % 4;
      grid[y]![x] = 1;
    }
    const [dx, dy] = directions[direction]!;
    x = (x + dx + DISPLAY_WIDTH) % DISPLAY_WIDTH;
    y = (y + dy + DISPLAY_HEIGHT) % DISPLAY_HEIGHT;
  };
  for (let index = 0; index < 240 + Math.floor(random() * 80); index += 1) step();
  const frames = delays.map(() => {
    for (let index = 0; index < Math.max(1, Math.round(3 * speed)); index += 1) step();
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (let row = 0; row < DISPLAY_HEIGHT; row += 1) {
      for (let column = 0; column < DISPLAY_WIDTH; column += 1) {
        if (grid[row]![column]) canvas.setPixel(column, row, [0, 255, 102]);
      }
    }
    canvas.setPixel(x, y, [255, 48, 48]);
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "兰顿蚂蚁" };
}

interface Fish {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: Rgb;
}

function renderAquarium(durationMs: number, random: Random, speed: number): VisualAnimation {
  const delays = animationPlan(durationMs, 120 / speed);
  const fishColors: Rgb[] = [[255, 100, 0], [255, 208, 0], [0, 229, 255], [255, 111, 181], [0, 255, 102]];
  const fish: Fish[] = Array.from({ length: 4 }, () => ({
    x: 4 + random() * (DISPLAY_WIDTH - 8),
    y: 2 + random() * (DISPLAY_HEIGHT - 5),
    vx: (random() < 0.5 ? -1 : 1) * (0.4 + random() * 0.5) * speed,
    vy: -0.2 + random() * 0.4,
    color: fishColors[Math.floor(random() * fishColors.length)]!,
  }));
  const bubbles: Array<[number, number]> = [];
  let tick = 0;
  const frames = delays.map(() => {
    for (const item of fish) {
      item.x += item.vx;
      item.y += item.vy;
      if (item.x < 3 || item.x > DISPLAY_WIDTH - 4) item.vx *= -1;
      if (item.y < 1 || item.y > DISPLAY_HEIGHT - 3) item.vy *= -1;
      item.x = Math.max(3, Math.min(DISPLAY_WIDTH - 4, item.x));
      item.y = Math.max(1, Math.min(DISPLAY_HEIGHT - 3, item.y));
      if (random() < 0.05) item.vy = -0.3 + random() * 0.6;
    }
    for (const bubble of bubbles) bubble[1] -= 1;
    for (let index = bubbles.length - 1; index >= 0; index -= 1) {
      if (bubbles[index]![1] < 0) bubbles.splice(index, 1);
    }
    if (random() < 0.25) bubbles.push([2 + Math.floor(random() * (DISPLAY_WIDTH - 4)), 14]);
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (let wx = 2; wx < DISPLAY_WIDTH; wx += 6) {
      const height = 2 + wx % 3;
      for (let index = 0; index < height; index += 1) {
        canvas.setPixel(wx + (index % 2 && (tick >> 2) % 2 ? 1 : 0), 15 - index, [10, 122, 42]);
      }
    }
    for (const [bx, by] of bubbles) canvas.setPixel(bx, by, [102, 204, 255]);
    for (const item of fish) {
      const fx = Math.round(item.x);
      const fy = Math.round(item.y);
      const direction = item.vx >= 0 ? 1 : -1;
      for (let part = 0; part < 3; part += 1) canvas.setPixel(fx - direction * part, fy, item.color);
      canvas.setPixel(fx - direction * 3, fy - 1, item.color);
      canvas.setPixel(fx - direction * 3, fy + 1, item.color);
    }
    tick += 1;
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "鱼缸" };
}

function firePalette(): Rgb[] {
  const stops = [[0, [0, 0, 0]], [6, [60, 0, 0]], [12, [180, 30, 0]], [20, [255, 100, 0]], [28, [255, 200, 30]], [36, [255, 255, 220]]] as const;
  return Array.from({ length: 37 }, (_, heat) => {
    const pair = stops.find((stop, index) => index < stops.length - 1 && heat >= stop[0] && heat <= stops[index + 1]![0])!;
    const index = stops.indexOf(pair);
    const next = stops[index + 1]!;
    const ratio = (heat - pair[0]) / (next[0] - pair[0]);
    return pair[1].map((value, channel) => Math.round(value + (next[1][channel]! - value) * ratio)) as unknown as Rgb;
  });
}

function renderFire(durationMs: number, random: Random, speed: number): VisualAnimation {
  const delays = animationPlan(durationMs, 80 / speed);
  const palette = firePalette();
  const heat = Array.from({ length: DISPLAY_HEIGHT }, () => new Uint8Array(DISPLAY_WIDTH));
  const step = () => {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) heat[15]![x] = random() < 0.18 ? 0 : 36;
    for (let y = 0; y < DISPLAY_HEIGHT - 1; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        const below = heat[y + 1]![x]! * 2;
        const left = heat[y + 1]![(x + DISPLAY_WIDTH - 1) % DISPLAY_WIDTH]!;
        const right = heat[y + 1]![(x + 1) % DISPLAY_WIDTH]!;
        heat[y]![x] = Math.max(0, Math.floor((below + left + right) / 4) - 1 - Math.floor(random() * 3));
      }
    }
  };
  for (let index = 0; index < 18; index += 1) step();
  const frames = delays.map(() => {
    step();
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) canvas.setPixel(x, y, palette[heat[y]![x]!]!);
    }
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "火焰" };
}

interface Rocket { x: number; y: number; vy: number; hue: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; hue: number }

const SPARK_LIMIT = 140;

function renderFireworks(durationMs: number, random: Random, speed: number, density: number): VisualAnimation {
  const delays = animationPlan(durationMs, 60 / speed);
  const maxRockets = Math.max(1, Math.min(3, Math.round(density)));
  const rockets: Rocket[] = [];
  const sparks: Spark[] = [];
  const burst = (rocket: Rocket) => {
    const count = 12 + Math.floor(random() * 10);
    for (let index = 0; index < count && sparks.length < SPARK_LIMIT; index += 1) {
      const angle = random() * Math.PI * 2;
      const velocity = 0.35 + random() * 0.95;
      const maxLife = 14 + Math.floor(random() * 12);
      sparks.push({
        x: rocket.x,
        y: rocket.y,
        vx: Math.cos(angle) * velocity * 1.6,
        vy: Math.sin(angle) * velocity,
        life: maxLife,
        maxLife,
        hue: rocket.hue + random() * 40 - 20,
      });
    }
  };
  const step = () => {
    if (rockets.length < maxRockets && random() < 0.16 + 0.05 * maxRockets) {
      rockets.push({
        x: 5 + random() * (DISPLAY_WIDTH - 10),
        y: DISPLAY_HEIGHT - 1,
        vy: -(0.85 + random() * 0.45),
        hue: random() * 360,
      });
    }
    for (let index = rockets.length - 1; index >= 0; index -= 1) {
      const rocket = rockets[index]!;
      rocket.y += rocket.vy;
      rocket.vy += 0.05;
      if (rocket.vy >= -0.3 || rocket.y <= 1) {
        burst(rocket);
        rockets.splice(index, 1);
      }
    }
    for (let index = sparks.length - 1; index >= 0; index -= 1) {
      const spark = sparks[index]!;
      spark.x += spark.vx;
      spark.y += spark.vy;
      spark.vy += 0.055;
      spark.vx *= 0.985;
      spark.life -= 1;
      if (spark.life <= 0 || spark.y >= DISPLAY_HEIGHT + 2) sparks.splice(index, 1);
    }
  };
  const frames = delays.map(() => {
    step();
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (const spark of sparks) {
      const fade = spark.life / spark.maxLife;
      canvas.setPixel(Math.round(spark.x), Math.round(spark.y), hueColor(spark.hue, 0.2 + fade * 0.8));
    }
    for (const rocket of rockets) {
      const x = Math.round(rocket.x);
      const y = Math.round(rocket.y);
      canvas.setPixel(x, y + 2, hueColor(rocket.hue, 0.18));
      canvas.setPixel(x, y + 1, hueColor(rocket.hue, 0.45));
      canvas.setPixel(x, y, [255, 255, 235]);
    }
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "烟花" };
}

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function renderFlipClock(durationMs: number, nowMs: number): VisualAnimation {
  const delays = animationPlan(durationMs, 1_000, 90);
  let elapsed = 0;
  const frames = delays.map((delay) => {
    const timestamp = nowMs + elapsed;
    const label = timeLabel(timestamp);
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    const cardX = [3, 13, 30, 40];
    const digits = label.replace(":", "");
    for (let index = 0; index < cardX.length; index += 1) {
      const x = cardX[index]!;
      canvas.fillRect(x, 1, 9, 14, [18, 34, 46]);
      canvas.fillRect(x, 8, 9, 1, [5, 8, 12]);
      drawPixelText(canvas, digits[index]!, x + 1, 3, [255, 255, 255], 2, 0);
    }
    if (Math.floor(timestamp / 1_000) % 2 === 0) {
      canvas.setPixel(25, 5, [62, 224, 138]);
      canvas.setPixel(25, 10, [62, 224, 138]);
    }
    if (new Date(timestamp).getSeconds() === 0) {
      const sweep = 3 + Math.floor((elapsed % 400) / 100) * 3;
      canvas.fillRect(30, sweep, 19, 1, [156, 255, 214]);
    }
    elapsed += delay;
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "翻页钟" };
}

// 7-segment geometry for six digits on the 52px panel: 7x14 boxes with a 2px
// stroke and 1px colons keep HH:MM:SS readable while every glyph pixel stays
// dense enough that per-particle twinkle reads as stardust at 52x16.
const FLUX_SEGMENT_RECTS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  a: [2, 0, 3, 2],
  b: [5, 2, 2, 4],
  c: [5, 8, 2, 4],
  d: [2, 12, 3, 2],
  e: [0, 8, 2, 4],
  f: [0, 2, 2, 4],
  g: [2, 6, 3, 2],
};
const FLUX_DIGIT_SEGMENTS = [
  "abcdef", "bc", "abged", "abgcd", "fgbc", "afgcd", "afgecd", "abc", "abcdefg", "abcfgd",
] as const;
const FLUX_DIGIT_X = [1, 9, 19, 27, 37, 45] as const;
const FLUX_COLON_X = [17, 35] as const;
// Pixel count of "8", the densest glyph: every region keeps this many particle
// slots so digit changes only flip slots between active and parked.
const FLUX_DIGIT_CAPACITY = 50;

function fluxGlyphTargets(char: string, originX: number): Array<readonly [number, number]> {
  const targets: Array<readonly [number, number]> = [];
  for (const segment of FLUX_DIGIT_SEGMENTS[Number(char)] ?? "") {
    const [sx, sy, sw, sh] = FLUX_SEGMENT_RECTS[segment]!;
    for (let dy = 0; dy < sh; dy += 1) {
      for (let dx = 0; dx < sw; dx += 1) targets.push([originX + sx + dx, 1 + sy + dy]);
    }
  }
  return targets;
}

function timeLabelSeconds(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

interface FluxPalette { core: Rgb; tip: Rgb; sparkle: Rgb }

const FLUX_PALETTES: Readonly<Record<"cyan" | "violet" | "ember" | "mint", FluxPalette>> = {
  cyan: { core: [24, 120, 255], tip: [110, 235, 255], sparkle: [225, 250, 255] },
  violet: { core: [150, 40, 255], tip: [255, 110, 225], sparkle: [255, 225, 250] },
  ember: { core: [255, 96, 12], tip: [255, 205, 96], sparkle: [255, 245, 215] },
  mint: { core: [16, 200, 110], tip: [150, 255, 200], sparkle: [230, 255, 240] },
};
const FLUX_CYCLE = [
  FLUX_PALETTES.cyan, FLUX_PALETTES.violet, FLUX_PALETTES.ember, FLUX_PALETTES.mint,
] as const;

interface FluxParticle {
  targetX: number; targetY: number;
  x: number; y: number;
  vx: number; vy: number;
  prevX: number; prevY: number;
  prev2X: number; prev2Y: number;
  glideFromX: number; glideFromY: number;
  glideStart: number;
  activatedAt: number;
  deactivatedAt: number;
  active: boolean;
  holdX: number; holdY: number;
  regionCenterX: number;
  tint: number;
  twinkleRate: number;
  twinklePhase: number;
  launchFrame: number;
}

function renderFlux(
  durationMs: number,
  nowMs: number,
  random: Random,
  speed: number,
  paletteId: NonNullable<VisualEffectOptions["fluxPalette"]>,
  burstMode: NonNullable<VisualEffectOptions["fluxBurst"]>,
): VisualAnimation {
  const delays = animationPlan(durationMs, 84 / speed);
  const total = delays.length;
  const elapsedAt: number[] = [];
  let elapsed = 0;
  for (const delay of delays) {
    elapsedAt.push(elapsed);
    elapsed += delay;
  }
  // Both morph windows are wall-time budgets, not frame counts: long items cap
  // at 120 frames and stretch the delay to seconds, where a multi-frame glide
  // would never finish (the seconds column retargets every frame) and a fixed
  // 4-frame afterglow would smear old digits for half a minute. Past the
  // budget the morph snaps and the vacated slot goes dark immediately.
  const glideFrames = delays[0]! >= 450 ? 1 : Math.max(2, Math.round(450 / delays[0]!));
  const fadeFrames = delays[0]! >= 450 ? 0 : 4;

  // The burst is scheduled around the first minute flip inside the window when
  // there is one, so the explosion doubles as the minute-change transition:
  // old digits erupt, the glitter rain crosses the flip, new digits condense.
  const minute0 = new Date(nowMs).getMinutes();
  let flipFrame = -1;
  for (let index = 1; index < total; index += 1) {
    if (new Date(nowMs + elapsedAt[index]!).getMinutes() !== minute0) {
      flipFrame = index;
      break;
    }
  }
  const swellLen = Math.max(2, Math.round(total * 0.033));
  const eruptLen = Math.max(3, Math.round(total * 0.066));
  const rainLen = Math.max(4, Math.round(total * 0.166));
  const gatherLen = Math.max(4, Math.round(total * 0.166));
  const tail = Math.max(2, Math.round(total * 0.08));
  let swellStart = total;
  if (total >= 30 && burstMode !== "never" && (burstMode === "always" || flipFrame >= 0)) {
    const latest = total - (swellLen + eruptLen + rainLen + gatherLen) - tail;
    if (latest >= 2) {
      const preferred = flipFrame >= 0
        ? flipFrame - swellLen - eruptLen - Math.round(rainLen / 2)
        : Math.round(total * 0.32);
      swellStart = Math.max(2, Math.min(latest, preferred));
    }
  }
  const hasBurst = swellStart < total;
  const burstStart = hasBurst ? swellStart + swellLen : total;
  const driftStart = hasBurst ? burstStart + eruptLen : total;
  const gatherStart = hasBurst ? driftStart + rainLen : total;
  const settleStart = hasBurst ? gatherStart + gatherLen : total;

  const paletteAt = (timestamp: number): FluxPalette => {
    if (paletteId !== "cycle") return FLUX_PALETTES[paletteId];
    const date = new Date(timestamp);
    const minuteIndex = date.getHours() * 60 + date.getMinutes();
    const current = FLUX_CYCLE[minuteIndex % FLUX_CYCLE.length]!;
    const intoMinuteMs = date.getSeconds() * 1_000 + date.getMilliseconds();
    if (intoMinuteMs >= 700) return current;
    const previous = FLUX_CYCLE[(minuteIndex + FLUX_CYCLE.length - 1) % FLUX_CYCLE.length]!;
    const blend = intoMinuteMs / 700;
    return {
      core: mixColor(previous.core, current.core, blend),
      tip: mixColor(previous.tip, current.tip, blend),
      sparkle: mixColor(previous.sparkle, current.sparkle, blend),
    };
  };

  // Eight regions — six digit slots and two fixed colons — each with a fixed
  // particle pool; a digit change flips slots active/parked and glides them.
  interface FluxRegion {
    char: string;
    base: number;
    capacity: number;
    centerX: number;
    centerY: number;
    targets: Array<readonly [number, number]>;
    digitIndex: number;
  }
  const regions: FluxRegion[] = [];
  const particles: FluxParticle[] = [];
  const label0 = timeLabelSeconds(nowMs);
  const digits0 = label0.replace(/:/g, "");
  const addRegion = (char: string, targets: Array<readonly [number, number]>, capacity: number, centerX: number, digitIndex: number) => {
    regions.push({ char, base: particles.length, capacity, centerX, centerY: 8, targets, digitIndex });
    for (let slot = 0; slot < capacity; slot += 1) {
      const target = targets[slot];
      const parked = target ?? ([centerX, 8] as const);
      particles.push({
        targetX: parked[0], targetY: parked[1],
        x: parked[0], y: parked[1],
        vx: 0, vy: 0,
        prevX: parked[0], prevY: parked[1],
        prev2X: parked[0], prev2Y: parked[1],
        glideFromX: parked[0], glideFromY: parked[1],
        glideStart: -1,
        activatedAt: -1,
        deactivatedAt: -1,
        active: target !== undefined,
        holdX: parked[0], holdY: parked[1],
        regionCenterX: centerX,
        tint: random() ** 1.5,
        twinkleRate: 0.5 + random() * 1.2,
        twinklePhase: random(),
        launchFrame: 0,
      });
    }
  };
  for (let index = 0; index < 6; index += 1) {
    addRegion(digits0[index]!, fluxGlyphTargets(digits0[index]!, FLUX_DIGIT_X[index]!), FLUX_DIGIT_CAPACITY, FLUX_DIGIT_X[index]! + 3, index);
  }
  for (const colonX of FLUX_COLON_X) {
    const dots: Array<readonly [number, number]> = [[colonX, 4], [colonX, 5], [colonX, 10], [colonX, 11]];
    addRegion(":", dots, dots.length, colonX, -1);
  }
  for (const particle of particles) particle.launchFrame = burstStart + Math.floor(random() * 3);
  const centerX = DISPLAY_WIDTH / 2;
  const centerY = DISPLAY_HEIGHT / 2;

  let previousLabel = label0;
  const frames = delays.map((delay, frameIndex) => {
    const timestamp = nowMs + elapsedAt[frameIndex]!;
    const seconds = elapsedAt[frameIndex]! / 1_000;
    const dt = Math.min(0.12, Math.max(0.03, delay / 1_000)) * speed;
    const inSwell = hasBurst && frameIndex >= swellStart && frameIndex < burstStart;
    const inFlight = hasBurst && frameIndex >= burstStart && frameIndex < gatherStart;
    const inGather = hasBurst && frameIndex >= gatherStart && frameIndex < settleStart;
    const inShimmer = !inSwell && !inFlight && !inGather;
    const palette = paletteAt(timestamp);

    // Retarget on every wall-clock digit change; the seconds column morphs
    // once a second while the rest of the face stays put.
    const label = timeLabelSeconds(timestamp);
    if (label !== previousLabel) {
      const digits = label.replace(/:/g, "");
      for (const region of regions) {
        if (region.digitIndex < 0 || digits[region.digitIndex] === region.char) continue;
        region.char = digits[region.digitIndex]!;
        region.targets = fluxGlyphTargets(region.char, FLUX_DIGIT_X[region.digitIndex]!);
        for (let slot = 0; slot < region.capacity; slot += 1) {
          const particle = particles[region.base + slot]!;
          const target = region.targets[slot];
          if (target) {
            if (!particle.active) {
              particle.active = true;
              particle.activatedAt = frameIndex;
              particle.deactivatedAt = -1;
            }
            if (particle.targetX !== target[0] || particle.targetY !== target[1]) {
              particle.glideFromX = particle.x;
              particle.glideFromY = particle.y;
              particle.glideStart = inShimmer ? frameIndex : -1;
              particle.targetX = target[0];
              particle.targetY = target[1];
            }
          } else if (particle.active) {
            particle.active = false;
            particle.deactivatedAt = inShimmer ? frameIndex : -1;
          }
        }
      }
      previousLabel = label;
    }

    const glow = new Float32Array(DISPLAY_WIDTH * DISPLAY_HEIGHT * 3);
    const splat = (x: number, y: number, tone: Rgb, gain: number) => {
      const baseX = Math.floor(x);
      const baseY = Math.floor(y);
      const fractionX = x - baseX;
      const fractionY = y - baseY;
      for (const [px, py, weight] of [
        [baseX, baseY, (1 - fractionX) * (1 - fractionY)],
        [baseX + 1, baseY, fractionX * (1 - fractionY)],
        [baseX, baseY + 1, (1 - fractionX) * fractionY],
        [baseX + 1, baseY + 1, fractionX * fractionY],
      ] as const) {
        if (px < 0 || px >= DISPLAY_WIDTH || py < 0 || py >= DISPLAY_HEIGHT || weight < 0.02) continue;
        const offset = (py * DISPLAY_WIDTH + px) * 3;
        glow[offset] += tone[0] * gain * weight;
        glow[offset + 1] += tone[1] * gain * weight;
        glow[offset + 2] += tone[2] * gain * weight;
      }
    };

    for (const particle of particles) {
      let brightness = 0;
      let tone = mixColor(palette.core, palette.tip, particle.tint);
      let trailGain = 0;
      particle.prev2X = particle.prevX;
      particle.prev2Y = particle.prevY;
      particle.prevX = particle.x;
      particle.prevY = particle.y;

      if (inShimmer) {
        if (!particle.active) {
          // Parked slots stay dark; a just-vacated slot fades where it stood.
          if (particle.deactivatedAt < 0 || frameIndex - particle.deactivatedAt >= fadeFrames) continue;
          brightness = 0.5 * (1 - (frameIndex - particle.deactivatedAt) / fadeFrames);
        } else {
          if (particle.glideStart >= 0 && frameIndex - particle.glideStart < glideFrames) {
            const step = (frameIndex - particle.glideStart + 1) / glideFrames;
            const eased = step * step * (3 - 2 * step);
            particle.x = particle.glideFromX + (particle.targetX - particle.glideFromX) * eased
              + (random() - 0.5) * 0.8 * (1 - eased);
            particle.y = particle.glideFromY + (particle.targetY - particle.glideFromY) * eased;
          } else {
            particle.glideStart = -1;
            particle.x = particle.targetX;
            particle.y = particle.targetY;
          }
          const wave = Math.sin(Math.PI * 2 * (particle.twinkleRate * seconds * speed + particle.twinklePhase));
          brightness = 0.5 + 0.4 * (wave * 0.5 + 0.5);
          if (particle.activatedAt >= 0) {
            brightness *= Math.min(1, (frameIndex - particle.activatedAt + 1) / glideFrames);
          }
          const sparkle = Math.sin(frameIndex * 12.9898 + particle.x * 78.233 + particle.y * 37.719) * 43758.5453;
          if (sparkle - Math.floor(sparkle) > 0.982) {
            tone = palette.sparkle;
            brightness = 1;
          }
        }
      } else if (inSwell) {
        // The face boils in place and flares white-hot before letting go —
        // parked slots materialise inside the flare so the eruption reads
        // denser than the digits it destroys.
        const swell = (frameIndex - swellStart + 1) / swellLen;
        particle.x = particle.targetX + (particle.targetX - particle.regionCenterX) * 0.3 * swell
          + (random() - 0.5) * 1.4 * swell;
        particle.y = particle.targetY + (particle.targetY - centerY) * 0.4 * swell
          + (random() - 0.5) * swell;
        brightness = (particle.active ? 0.9 : 0.5) + 0.4 * swell;
        tone = mixColor(tone, palette.sparkle, 0.35 + 0.4 * swell);
      } else if (inFlight) {
        if (frameIndex === particle.launchFrame) {
          particle.vx = (random() - 0.5) * 22 + (particle.x - centerX) * 0.35;
          particle.vy = -(10 + random() * 26);
        }
        if (frameIndex >= particle.launchFrame) {
          const gravity = frameIndex < driftStart ? 16 : 9;
          const dragRate = frameIndex < driftStart ? 1.0 : 2.1;
          particle.vy += gravity * dt;
          const drag = Math.exp(-dragRate * dt);
          particle.vx *= drag;
          particle.vy *= drag;
          particle.x += particle.vx * dt;
          particle.y += particle.vy * dt;
          const restitution = 0.2 + 0.2 * particle.twinklePhase;
          if (particle.x < 0) { particle.x = 0; particle.vx = Math.abs(particle.vx) * restitution; }
          if (particle.x > DISPLAY_WIDTH - 1) { particle.x = DISPLAY_WIDTH - 1; particle.vx = -Math.abs(particle.vx) * restitution; }
          if (particle.y < 0) { particle.y = 0; particle.vy = Math.abs(particle.vy) * restitution; }
          if (particle.y > DISPLAY_HEIGHT - 1) { particle.y = DISPLAY_HEIGHT - 1; particle.vy = -Math.abs(particle.vy) * restitution; }
        }
        brightness = 0.65 + 0.35 * Math.sin(seconds * 7 + particle.twinklePhase * Math.PI * 2);
        if (frameIndex < particle.launchFrame + 3) tone = mixColor(tone, palette.sparkle, 0.5);
        // Streaks only while moving fast: eruption trails, twinkling rain dots.
        const velocity = Math.hypot(particle.vx, particle.vy);
        trailGain = velocity > 6 ? Math.min(1, velocity / 26) : 0;
        const sparkle = Math.sin(frameIndex * 9.171 + particle.twinklePhase * 91.7) * 43758.5453;
        if (frameIndex >= driftStart && sparkle - Math.floor(sparkle) > 0.93) {
          tone = palette.sparkle;
          brightness = 1;
        }
      } else {
        if (frameIndex === gatherStart) {
          particle.holdX = particle.x;
          particle.holdY = particle.y;
          particle.glideStart = -1;
        }
        // Orbit-condense: the swarm spirals into a boiling clump that tightens
        // onto the digits instead of flying home in straight lines.
        const progress = (frameIndex - gatherStart + 1) / gatherLen;
        const eased = progress * progress * (3 - 2 * progress);
        const orbit = particle.twinklePhase * Math.PI * 2 + frameIndex * 0.5;
        const radius = 1 - eased;
        const swirlX = particle.targetX + Math.sin(orbit) * 2.4 * radius;
        const swirlY = particle.targetY + Math.cos(orbit) * 1.2 * radius;
        particle.x = particle.holdX + (swirlX - particle.holdX) * eased;
        particle.y = particle.holdY + (swirlY - particle.holdY) * eased;
        brightness = (0.5 + 0.5 * eased) * (particle.active ? 1 : 1 - eased);
        if (brightness < 0.03) continue;
      }

      splat(particle.x, particle.y, tone, brightness);
      if (trailGain > 0) {
        splat(particle.prevX, particle.prevY, tone, brightness * 0.4 * trailGain);
        splat(particle.prev2X, particle.prev2Y, tone, brightness * 0.16 * trailGain);
      }
    }

    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        const offset = (y * DISPLAY_WIDTH + x) * 3;
        const red = Math.min(255, Math.round(glow[offset]!));
        const green = Math.min(255, Math.round(glow[offset + 1]!));
        const blue = Math.min(255, Math.round(glow[offset + 2]!));
        if (red + green + blue > 0) canvas.setPixel(x, y, [red, green, blue]);
      }
    }
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "流光时钟" };
}

const LIFE_CELLS = DISPLAY_WIDTH * DISPLAY_HEIGHT;
const LIFE_NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const;

function seedLife(mode: "digits" | "soup", nowMs: number, random: Random): Uint8Array {
  const cells = new Uint8Array(LIFE_CELLS);
  if (mode === "digits") {
    const label = timeLabel(nowMs);
    const stamp = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    const width = measurePixelText(label, 2, 2);
    drawPixelText(stamp, label, Math.floor((DISPLAY_WIDTH - width) / 2), 3, [255, 255, 255], 2, 2);
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        if (stamp.getPixel(x, y)[0] > 0) cells[y * DISPLAY_WIDTH + x] = 1;
      }
    }
    return cells;
  }
  for (let index = 0; index < LIFE_CELLS; index += 1) cells[index] = random() < 0.34 ? 1 : 0;
  return cells;
}

function hashCells(cells: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < cells.length; index += 1) {
    hash = Math.imul(hash ^ cells[index]!, 0x01000193);
  }
  return hash >>> 0;
}

function renderLife(
  durationMs: number,
  nowMs: number,
  random: Random,
  speed: number,
  start: "digits" | "soup",
): VisualAnimation {
  const delays = animationPlan(durationMs, 130 / speed);
  let cells = seedLife(start, nowMs, random);
  let ages = new Uint8Array(LIFE_CELLS);
  // Life on a torus settles into still lifes or short oscillators quickly; a
  // small ring of recent hashes catches both and reseeds with fresh soup.
  let history: number[] = [hashCells(cells)];
  const step = () => {
    const next = new Uint8Array(LIFE_CELLS);
    const nextAges = new Uint8Array(LIFE_CELLS);
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        let neighbours = 0;
        for (const [dx, dy] of LIFE_NEIGHBORS) {
          const nx = (x + dx + DISPLAY_WIDTH) % DISPLAY_WIDTH;
          const ny = (y + dy + DISPLAY_HEIGHT) % DISPLAY_HEIGHT;
          neighbours += cells[ny * DISPLAY_WIDTH + nx]!;
        }
        const index = y * DISPLAY_WIDTH + x;
        const alive = cells[index] === 1;
        const survives = alive ? neighbours === 2 || neighbours === 3 : neighbours === 3;
        next[index] = survives ? 1 : 0;
        nextAges[index] = survives && alive ? Math.min(255, ages[index]! + 1) : 0;
      }
    }
    cells = next;
    ages = nextAges;
    const hash = hashCells(cells);
    if (history.includes(hash)) {
      cells = seedLife("soup", nowMs, random);
      ages = new Uint8Array(LIFE_CELLS);
      history = [hashCells(cells)];
      return;
    }
    history.push(hash);
    if (history.length > 16) history.shift();
  };
  const frames = delays.map(() => {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        const index = y * DISPLAY_WIDTH + x;
        if (!cells[index]) continue;
        const age = ages[index]!;
        canvas.setPixel(x, y, age === 0
          ? [186, 255, 214]
          : age < 3
            ? [0, 255, 120]
            : age < 8
              ? [0, 188, 92]
              : [0, 118, 58]);
      }
    }
    step();
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: start === "digits" ? "生命游戏 · 时间" : "生命游戏" };
}

interface RainDrop { y: number; speed: number; length: number }

function renderMatrixClock(durationMs: number, nowMs: number, random: Random, speed: number): VisualAnimation {
  const delays = animationPlan(durationMs, 110 / speed);
  const drops: Array<RainDrop | undefined> = Array.from({ length: DISPLAY_WIDTH }, () =>
    random() < 0.6 ? { y: -random() * DISPLAY_HEIGHT, speed: (0.4 + random() * 0.7) * speed, length: 4 + Math.floor(random() * 8) } : undefined
  );
  let elapsed = 0;
  const frames = delays.map((delay) => {
    for (let x = 0; x < drops.length; x += 1) {
      const drop = drops[x];
      if (!drop) {
        if (random() < 0.04) drops[x] = { y: -4, speed: 0.4 + random() * 0.7, length: 4 + Math.floor(random() * 8) };
      } else {
        drop.y += drop.speed;
        if (drop.y - drop.length > DISPLAY_HEIGHT) drops[x] = undefined;
      }
    }
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (let x = 0; x < drops.length; x += 1) {
      const drop = drops[x];
      if (!drop) continue;
      for (let trail = 0; trail < drop.length; trail += 1) {
        const y = Math.floor(drop.y) - trail;
        if (y < 0 || y >= DISPLAY_HEIGHT) continue;
        const intensity = trail === 0 ? 255 : Math.max(30, 220 - trail * 24);
        canvas.setPixel(x, y, trail === 0 ? [204, 255, 204] : [intensity / 5, intensity, intensity / 5]);
      }
    }
    const label = timeLabel(nowMs + elapsed);
    const scale = 2;
    const spacing = 2;
    const width = measurePixelText(label, scale, spacing);
    const height = 5 * scale;
    const labelX = Math.floor((DISPLAY_WIDTH - width) / 2);
    const labelY = Math.floor((DISPLAY_HEIGHT - height) / 2);
    for (let y = labelY - 1; y < labelY + height + 1; y += 1) {
      for (let x = labelX - 1; x < labelX + width + 1; x += 1) {
        const [red, green, blue] = canvas.getPixel(x, y);
        canvas.setPixel(x, y, [
          Math.floor(red / 6),
          Math.floor(green / 6),
          Math.floor(blue / 6),
        ]);
      }
    }
    drawPixelText(canvas, label, labelX, labelY, [255, 255, 255], scale, spacing);
    elapsed += delay;
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "数字雨时钟" };
}

interface MazeState { maze: number[][]; path: Array<[number, number]> }

function createMaze(random: Random): MazeState {
  const width = 51;
  const height = 15;
  const maze = Array.from({ length: height }, () => Array(width).fill(0));
  maze[0]![0] = 1;
  const stack: Array<[number, number]> = [[0, 0]];
  while (stack.length > 0) {
    const [x, y] = stack.at(-1)!;
    const neighbors: Array<[number, number, number, number]> = [];
    for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && maze[ny]![nx] === 0) neighbors.push([nx, ny, dx, dy]);
    }
    if (neighbors.length === 0) {
      stack.pop();
      continue;
    }
    const [nx, ny, dx, dy] = neighbors[Math.floor(random() * neighbors.length)]!;
    maze[y + dy / 2]![x + dx / 2] = 1;
    maze[ny]![nx] = 1;
    stack.push([nx, ny]);
  }
  const queue: Array<[number, number]> = [[0, 0]];
  const previous = new Map<string, [number, number] | undefined>([["0,0", undefined]]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [x, y] = queue[cursor]!;
    if (x === width - 1 && y === height - 1) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && maze[ny]![nx] && !previous.has(key)) {
        previous.set(key, [x, y]);
        queue.push([nx, ny]);
      }
    }
  }
  const path: Array<[number, number]> = [];
  let current: [number, number] | undefined = [width - 1, height - 1];
  while (current) {
    path.push(current);
    current = previous.get(`${current[0]},${current[1]}`);
  }
  path.reverse();
  return { maze, path };
}

function renderMaze(durationMs: number, random: Random, speed: number): VisualAnimation {
  const delays = animationPlan(durationMs, 120 / speed);
  const state = createMaze(random);
  const frames = delays.map((_, frameIndex) => {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (let y = 0; y < 15; y += 1) {
      for (let x = 0; x < 51; x += 1) if (!state.maze[y]![x]) canvas.setPixel(x, y, [30, 90, 255]);
    }
    const pathIndex = Math.min(state.path.length - 1, Math.floor(frameIndex / Math.max(1, delays.length - 1) * state.path.length));
    for (const [x, y] of state.path.slice(0, pathIndex)) canvas.setPixel(x, y, [10, 64, 32]);
    const goal = state.path.at(-1)!;
    canvas.setPixel(goal[0], goal[1], [255, 48, 48]);
    const current = state.path[pathIndex]!;
    canvas.setPixel(current[0], current[1], [255, 208, 0]);
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "走迷宫" };
}

function renderPet(durationMs: number, random: Random, speed: number, requested: VisualEffectOptions["petAction"]): VisualAnimation {
  const delays = animationPlan(durationMs, 180 / speed);
  const actions = ["idle", "walk", "run", "attack"] as const;
  const action = requested && requested !== "random" ? requested : actions[Math.floor(random() * actions.length)]!;
  const frames = delays.map((_, index) => {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    const moving = action === "walk" || action === "run";
    const stride = action === "run" ? 2 : 1;
    const x = moving ? (index * stride) % (DISPLAY_WIDTH + 14) - 12 : 20;
    const bob = moving && index % 2 ? 1 : 0;
    const y = 5 + bob;
    const orange: Rgb = [242, 139, 53];
    const light: Rgb = [255, 190, 105];
    canvas.fillRect(x + 3, y + 2, 8, 5, orange);
    canvas.fillRect(x + 9, y, 4, 5, orange);
    canvas.setPixel(x + 9, y - 1, orange);
    canvas.setPixel(x + 12, y - 1, orange);
    canvas.setPixel(x + 12, y + 2, [24, 20, 18]);
    canvas.setPixel(x + 2, y + 2, orange);
    canvas.setPixel(x + 1, y + 1 + index % 3, orange);
    canvas.fillRect(x + 5, y + 3, 4, 2, light);
    if (action === "idle") {
      canvas.fillRect(x + 4, y + 7, 7, 1, orange);
      if (index % 6 < 3) canvas.setPixel(x + 13, y + 2, [255, 255, 255]);
    } else {
      canvas.setPixel(x + 4 + index % 2 * 2, y + 7, orange);
      canvas.setPixel(x + 9 - index % 2 * 2, y + 7, orange);
    }
    if (action === "attack" && index % 4 < 2) {
      canvas.fillRect(x + 13, y + 4, 3, 1, light);
      canvas.setPixel(x + 16, y + 3, [255, 208, 0]);
      canvas.setPixel(x + 16, y + 5, [255, 208, 0]);
    }
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: `像素宠物 · ${action}` };
}

function renderSand(durationMs: number, random: Random, speed: number): VisualAnimation {
  const delays = animationPlan(durationMs, 90 / speed);
  let grid = Array.from({ length: DISPLAY_HEIGHT }, () => new Uint32Array(DISPLAY_WIDTH));
  const colors = [0xffd000, 0xff6400, 0xff3030, 0x00e5ff, 0x00ff66, 0xff6fb5];
  const step = () => {
    for (let y = DISPLAY_HEIGHT - 2; y >= 0; y -= 1) {
      const offset = random() < 0.5 ? 0 : 1;
      for (let stepX = 0; stepX < DISPLAY_WIDTH; stepX += 1) {
        const x = offset ? DISPLAY_WIDTH - 1 - stepX : stepX;
        const grain = grid[y]![x]!;
        if (!grain) continue;
        if (!grid[y + 1]![x]) {
          grid[y + 1]![x] = grain;
          grid[y]![x] = 0;
        } else {
          const first = random() < 0.5 ? -1 : 1;
          for (const dx of [first, -first]) {
            if (x + dx >= 0 && x + dx < DISPLAY_WIDTH && !grid[y + 1]![x + dx]) {
              grid[y + 1]![x + dx] = grain;
              grid[y]![x] = 0;
              break;
            }
          }
        }
      }
    }
    if ([...grid[0]!].filter(Boolean).length > DISPLAY_WIDTH * 0.6) {
      grid = Array.from({ length: DISPLAY_HEIGHT }, () => new Uint32Array(DISPLAY_WIDTH));
    }
    for (let spawn = 0; spawn < 3; spawn += 1) {
      const x = Math.floor(random() * DISPLAY_WIDTH);
      if (!grid[0]![x]) grid[0]![x] = colors[Math.floor(random() * colors.length)]!;
    }
  };
  for (let index = 0; index < 24; index += 1) step();
  const frames = delays.map(() => {
    step();
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) setPacked(canvas, x, y, grid[y]![x]!);
    }
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "落沙" };
}

interface Star { angle: number; radius: number; speed: number }

function renderStarfield(durationMs: number, random: Random, speed: number): VisualAnimation {
  const delays = animationPlan(durationMs, 80 / speed);
  const stars: Star[] = Array.from({ length: 40 }, () => ({
    angle: random() * Math.PI * 2,
    radius: 1 + random() * 3,
    speed: (0.15 + random() * 0.45) * speed,
  }));
  const reset = (star: Star) => {
    star.angle = random() * Math.PI * 2;
    star.radius = 1 + random() * 3;
    star.speed = (0.15 + random() * 0.45) * speed;
  };
  const frames = delays.map(() => {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    for (const star of stars) {
      star.radius += star.speed * (0.5 + star.radius * 0.25);
      const x = Math.floor(DISPLAY_WIDTH / 2 + star.radius * Math.cos(star.angle));
      const y = Math.floor(DISPLAY_HEIGHT / 2 + star.radius * Math.sin(star.angle));
      if (x < 0 || x >= DISPLAY_WIDTH || y < 0 || y >= DISPLAY_HEIGHT) {
        reset(star);
        continue;
      }
      const shade = Math.floor(80 + 175 * Math.min(1, star.radius / 26));
      canvas.setPixel(x, y, [shade, shade, shade]);
    }
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "星空穿梭" };
}

const DEGREES = Math.PI / 180;

export interface SolarPosition {
  elevationDegrees: number;
  /** -180..180, negative before local solar noon. */
  hourAngleDegrees: number;
}

/**
 * NOAA General Solar Position Calculations, reduced to elevation and hour
 * angle. Fourier terms for the equation of time and declination give roughly
 * ±0.5° accuracy; atmospheric refraction near the horizon is not corrected,
 * which is well inside what a 52x16 colour ramp can express.
 */
export function solarPosition(
  timestampMs: number,
  latitude: number,
  longitude: number,
): SolarPosition {
  const date = new Date(timestampMs);
  const dayOfYear = Math.floor(
    (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
      - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000,
  ) + 1;
  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const gamma = 2 * Math.PI / 365 * (dayOfYear - 1 + (minutesUtc / 60 - 12) / 24);
  const equationOfTime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );
  const declination = 0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);
  const trueSolarMinutes = minutesUtc + equationOfTime + 4 * longitude;
  const rawHourAngle = trueSolarMinutes / 4 - 180;
  const cosZenith = Math.sin(latitude * DEGREES) * Math.sin(declination)
    + Math.cos(latitude * DEGREES) * Math.cos(declination) * Math.cos(rawHourAngle * DEGREES);
  return {
    elevationDegrees: 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) / DEGREES,
    hourAngleDegrees: ((rawHourAngle + 180) % 360 + 360) % 360 - 180,
  };
}

// Warm white: full daylight on an LED panel should feel like sunlight, not office grey.
const DAYLIGHT: Rgb = [255, 244, 224];
const DAWN: Rgb = [255, 122, 28];
const DUSK: Rgb = [214, 46, 62];

function skyColor(position: SolarPosition): Rgb {
  const horizon = position.hourAngleDegrees < 0 ? DAWN : DUSK;
  const stops: Array<[number, Rgb]> = [
    // Astronomical night maps to true black so the LEDs switch off entirely
    // instead of glowing as a faint grey-blue panel.
    [-90, [0, 0, 0]],
    [-18, [0, 0, 0]],
    [-12, [9, 13, 46]],
    [-6, [48, 30, 94]],
    [0, horizon],
    [8, mixColor(horizon, DAYLIGHT, 0.55)],
    [24, DAYLIGHT],
    [90, DAYLIGHT],
  ];
  const elevation = Math.max(-90, Math.min(90, position.elevationDegrees));
  for (let index = 0; index < stops.length - 1; index += 1) {
    const [low, lowColor] = stops[index]!;
    const [high, highColor] = stops[index + 1]!;
    if (elevation >= low && elevation <= high) {
      return mixColor(lowColor, highColor, high === low ? 0 : (elevation - low) / (high - low));
    }
  }
  return DAYLIGHT;
}

// Deep night maps the sky ramp to pure black; the digits still have to read,
// so they bottom out at a faint night-reading blue instead of vanishing.
const NIGHT_DIGIT_FLOOR: Rgb = [22, 30, 72];

function renderSunColor(
  durationMs: number,
  nowMs: number,
  latitude: number,
  longitude: number,
): VisualAnimation {
  const delays = animationPlan(durationMs, 1_000, 90);
  let elapsed = 0;
  const frames = delays.map((delay) => {
    const timestamp = nowMs + elapsed;
    // Black panel, colour only on the ink: the sky tint lives in the digits.
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    const ramp = skyColor(solarPosition(timestamp, latitude, longitude));
    const luminance = ramp[0] * 0.3 + ramp[1] * 0.59 + ramp[2] * 0.11;
    drawBigClockText(canvas, timeLabel(timestamp), 2, luminance < 18 ? NIGHT_DIGIT_FLOOR : ramp);
    // Colour-temperature axis: column x is the moment (x/52)*24h of the local
    // day, so the row fades night-day-night on its own; a white dot marks now.
    const date = new Date(timestamp);
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      const columnMs = midnight + x / DISPLAY_WIDTH * 86_400_000;
      canvas.setPixel(x, 13, skyColor(solarPosition(columnMs, latitude, longitude)));
    }
    const dayFraction = Math.max(0, Math.min(1, (timestamp - midnight) / 86_400_000));
    canvas.setPixel(
      Math.min(DISPLAY_WIDTH - 1, Math.floor(dayFraction * DISPLAY_WIDTH)),
      13,
      [255, 255, 255],
    );
    elapsed += delay;
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: "日出日落" };
}

interface Particle { x: number; y: number; vx: number; vy: number; seed: number }

function weatherParticles(
  condition: WeatherCondition,
  precipitationMm: number,
  random: Random,
  speed: number,
): Particle[] {
  const count = condition === "snow"
    ? 20 + Math.round(Math.min(1, precipitationMm / 4) * 16)
    : Math.round(Math.max(14, Math.min(54, 14 + precipitationMm * 8)));
  return Array.from({ length: count }, () => ({
    x: random() * DISPLAY_WIDTH,
    y: random() * DISPLAY_HEIGHT,
    vx: condition === "snow" ? 0 : 0.28 * speed,
    vy: (condition === "snow" ? 0.22 + random() * 0.22 : 1.1 + random() * 1.1) * speed,
    seed: random() * Math.PI * 2,
  }));
}

function temperatureLeftX(temperatureC: number): number {
  return DISPLAY_WIDTH - measurePixelText(`${Math.round(temperatureC)}C`, 1, 1) - 1;
}

function drawTemperature(canvas: PixelCanvas, temperatureC: number): void {
  const text = `${Math.round(temperatureC)}C`;
  const x = temperatureLeftX(temperatureC);
  dimRegion(canvas, x - 1, 0, measurePixelText(text, 1, 1) + 2, 7, 0.25);
  drawPixelText(canvas, text, x, 1, [214, 224, 240], 1, 1);
}

// Same blue-grey family as the temperature ink, a step dimmer so the place
// name reads as a caption rather than competing with the data.
const PLACE_COLOR: Rgb = [154, 168, 187];

/**
 * Uppercase ASCII form of the geocoded place, trimmed until it fits in
 * `limitWidth` pixels of 3x5 type. Diacritics fold to their base letters so
 * "São Paulo" stays readable instead of dissolving into "?" glyphs.
 */
function fitPlaceText(place: string, limitWidth: number): string {
  const folded = place.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let text = sanitizePixelText(folded, 16).trim();
  // A name with no drawable letters at all (e.g. un-geocoded CJK input) would
  // render as a row of "?"; better to show nothing than noise.
  if (!/[^?\s]/.test(text)) return "";
  if (measurePixelText(text, 1, 1) <= limitWidth) return text;
  while (text.length > 0 && measurePixelText(text, 1, 1) > limitWidth) {
    text = text.slice(0, -1);
  }
  // A cut that lands on a separator would dangle ("SHANGHAI," …); drop it.
  return text.replace(/[ ,.]+$/, "");
}

function renderWeather(
  durationMs: number,
  random: Random,
  speed: number,
  weather: WeatherVisualInput | undefined,
  notice: string | undefined,
  place: string,
): VisualAnimation {
  if (!weather) {
    return {
      frames: [drawCjkNotice(notice ?? "未配置", [255, 176, 32])],
      frameDelaysMs: [durationMs],
      label: `天气 · ${notice ?? "未配置"}`,
    };
  }
  // Static per render: the caption must stop two switched-off pixels short of
  // the temperature block so the two top-row texts never collide.
  const placeText = place ? fitPlaceText(place, temperatureLeftX(weather.temperatureC) - 2) : "";
  const delays = animationPlan(durationMs, 90 / speed);
  const condition = weather.condition;
  const particles = condition === "rain" || condition === "snow" || condition === "thunder"
    ? weatherParticles(condition, weather.precipitationMm, random, speed)
    : [];
  const clouds = Array.from({ length: 3 }, (_, index) => ({
    x: random() * DISPLAY_WIDTH,
    y: 2 + index * 4,
    width: 12 + Math.floor(random() * 8),
    drift: (0.12 + index * 0.06) * speed,
  }));
  const flashFrames = new Set<number>();
  if (condition === "thunder") {
    for (let index = 6; index < delays.length; index += 24 + Math.floor(random() * 10)) {
      flashFrames.add(index);
      flashFrames.add(index + 1);
    }
  }
  const frames = delays.map((_, index) => {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    if (condition === "clear") {
      const pulse = 0.72 + 0.28 * Math.sin(index * 0.35);
      const centre: [number, number] = [15, 8];
      for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
        for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
          const distance = Math.hypot(x - centre[0], y - centre[1]);
          if (distance <= 3.2) canvas.setPixel(x, y, [255, 226, 96]);
          else if (distance <= 5.4) canvas.setPixel(x, y, scaleColor([255, 176, 32], pulse * (1 - (distance - 3.2) / 2.2)));
        }
      }
      for (let ray = 0; ray < 8; ray += 1) {
        const angle = ray * Math.PI / 4 + index * 0.06;
        const reach = 6.5 + Math.sin(index * 0.3 + ray) * 1.2;
        canvas.setPixel(
          Math.round(centre[0] + Math.cos(angle) * reach),
          Math.round(centre[1] + Math.sin(angle) * reach),
          scaleColor([255, 208, 64], pulse),
        );
      }
      // Warm motes drifting off the halo keep the empty right half alive.
      for (let mote = 0; mote < 9; mote += 1) {
        const x = 22 + (mote * 7 + index * (0.4 + mote % 3 * 0.2) * speed) % 30;
        const y = 3 + (mote * 5 + Math.sin(index * 0.12 + mote) * 2) % 11;
        canvas.setPixel(Math.round(x), Math.round(y), scaleColor([255, 164, 48], 0.3 + 0.25 * Math.sin(index * 0.2 + mote)));
      }
    } else if (condition === "cloud" || condition === "fog") {
      const shade = condition === "fog" ? 96 : Math.round(70 + weather.cloudCoverPercent * 1.1);
      for (const cloud of clouds) {
        const offset = (cloud.x + index * cloud.drift) % (DISPLAY_WIDTH + cloud.width);
        for (let dx = 0; dx < cloud.width; dx += 1) {
          const x = Math.round(offset - cloud.width + dx);
          const thickness = condition === "fog" ? 1 : 1 + (dx > 2 && dx < cloud.width - 3 ? 1 : 0);
          for (let dy = 0; dy < thickness; dy += 1) {
            const tint = Math.round(shade * (0.65 + 0.35 * Math.sin((dx + index) * 0.4)));
            canvas.setPixel(x, cloud.y + dy, [tint, tint, Math.min(255, tint + 24)]);
          }
        }
      }
    }
    if (flashFrames.has(index)) {
      for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
        for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
          canvas.setPixel(x, y, mixColor(canvas.getPixel(x, y), [188, 200, 255], 0.8));
        }
      }
    }
    for (const particle of particles) {
      particle.x += particle.vx + (condition === "snow" ? Math.sin(particle.seed + index * 0.18) * 0.4 : 0);
      particle.y += particle.vy;
      if (particle.y >= DISPLAY_HEIGHT) {
        particle.y -= DISPLAY_HEIGHT + random() * 4;
        particle.x = random() * DISPLAY_WIDTH;
      }
      const x = Math.round(particle.x) % DISPLAY_WIDTH;
      const y = Math.round(particle.y);
      if (condition === "snow") {
        canvas.setPixel(x, y, [236, 244, 255]);
      } else {
        canvas.setPixel(x, y, [96, 176, 255]);
        canvas.setPixel(x, y - 1, [36, 96, 190]);
      }
    }
    drawTemperature(canvas, weather.temperatureC);
    if (placeText) drawPixelText(canvas, placeText, 0, 0, PLACE_COLOR, 1, 1);
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: `天气 · ${condition}` };
}

export function renderVisualEffect(
  effectId: VisualEffectId,
  durationMs: number,
  nowMs = Date.now(),
  options: VisualEffectOptions = {},
): VisualAnimation {
  const speed = Number.isFinite(options.speed)
    ? Math.max(0.5, Math.min(2, Number(options.speed)))
    : 1;
  const seed = Math.floor(nowMs / 10_000) ^ effectId.split("").reduce((sum, char) => sum * 31 + char.charCodeAt(0), 17);
  const random = seededRandom(seed);
  if (effectId === "ant") return renderAnt(durationMs, random, speed);
  if (effectId === "aquarium") return renderAquarium(durationMs, random, speed);
  if (effectId === "fire") return renderFire(durationMs, random, speed);
  if (effectId === "fireworks") {
    return renderFireworks(durationMs, random, speed, options.fireworkDensity ?? 2);
  }
  if (effectId === "flipclock") return renderFlipClock(durationMs, nowMs);
  if (effectId === "flux") {
    return renderFlux(
      durationMs,
      nowMs,
      random,
      speed,
      options.fluxPalette ?? "cycle",
      options.fluxBurst ?? "always",
    );
  }
  if (effectId === "life") {
    return renderLife(durationMs, nowMs, random, speed, options.lifeStart ?? "digits");
  }
  if (effectId === "matrixclock") return renderMatrixClock(durationMs, nowMs, random, speed);
  if (effectId === "maze") return renderMaze(durationMs, random, speed);
  if (effectId === "pet") return renderPet(durationMs, random, speed, options.petAction);
  if (effectId === "sand") return renderSand(durationMs, random, speed);
  if (effectId === "suncolor") {
    return renderSunColor(durationMs, nowMs, options.latitude ?? 0, options.longitude ?? 0);
  }
  if (effectId === "weather") {
    return renderWeather(
      durationMs,
      random,
      speed,
      options.weather,
      options.weatherNotice,
      options.weatherPlace ?? "",
    );
  }
  return renderStarfield(durationMs, random, speed);
}
