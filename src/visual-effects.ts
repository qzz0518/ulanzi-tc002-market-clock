import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  PixelCanvas,
  type Rgb,
} from "./pixel-ui.ts";
import { drawPixelText, measurePixelText } from "./pixel-font.ts";

export const VISUAL_EFFECT_IDS = [
  "ant",
  "aquarium",
  "fire",
  "flipclock",
  "matrixclock",
  "maze",
  "pet",
  "sand",
  "starfield",
] as const;

export type VisualEffectId = (typeof VISUAL_EFFECT_IDS)[number];

export interface VisualAnimation {
  frames: PixelCanvas[];
  frameDelaysMs: number[];
  label: string;
}

export interface VisualEffectOptions {
  speed?: number;
  petAction?: "idle" | "walk" | "run" | "attack" | "random";
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
  if (effectId === "flipclock") return renderFlipClock(durationMs, nowMs);
  if (effectId === "matrixclock") return renderMatrixClock(durationMs, nowMs, random, speed);
  if (effectId === "maze") return renderMaze(durationMs, random, speed);
  if (effectId === "pet") return renderPet(durationMs, random, speed, options.petAction);
  if (effectId === "sand") return renderSand(durationMs, random, speed);
  return renderStarfield(durationMs, random, speed);
}
