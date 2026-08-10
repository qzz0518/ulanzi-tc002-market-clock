// Snake for the 52x16 LED panel.
// Tuning table: docs/design/pixel-playground.md §4 (row 3).
// DOM-free and deterministic — inject `random` to pin food placement in tests.

import {
  GAME_SCREEN_HEIGHT,
  GAME_SCREEN_WIDTH,
  type GameEngine,
  type GameHud,
  type GameInput,
  type GamePhase,
  type PixelDrawContext,
} from "@/lib/games/engine";
import { PIXEL_FONT, renderPixelText } from "@/lib/pixel-font";

/** Cells per second at level 1. */
export const SNAKE_BASE_SPEED = 12;
export const SNAKE_MAX_SPEED = 26;
export const SNAKE_SPEED_STEP = 1.08;
export const SNAKE_FOOD_PER_LEVEL = 5;
export const SNAKE_START_LENGTH = 4;
/** Odds that the next food spawns as a 3x5 digit bonus instead of a single pixel. */
export const SNAKE_DIGIT_FOOD_CHANCE = 1 / 6;
export const SNAKE_DIGIT_FOOD_SCORE = 5;
export const SNAKE_DIGIT_FOOD_GROWTH = 3;
export const SNAKE_DOT_FOOD_SCORE = 1;

const RESTART_LOCK_MS = 600;
const DIGIT_PLACEMENT_TRIES = 8;
const DIGIT_WIDTH = 3;
const DIGIT_HEIGHT = 5;

// Full-screen fill: on the LED panel a dark grey background lights every pixel, so keep it truly off.
const BG = "#000000";
const HEAD_RGB = [0xd6, 0xff, 0x5c] as const;
const TAIL_RGB = [0x0e, 0x9c, 0x6a] as const;
const DIM_SNAKE = "#173d2a";
const FOOD_BRIGHT = "#ff4d5a";
const FOOD_DIM = "#7a1f27";
const DIGIT_BRIGHT = "#ffd43b";
const DIGIT_DIM = "#8a6a10";
const TITLE = "#6f8296";
const SCORE = "#ffffff";
const PROMPT = "#c1ff3d";

export type SnakeDirection = "up" | "down" | "left" | "right";
export type SnakeFoodKind = "dot" | "digit";

export interface SnakeCell {
  x: number;
  y: number;
}

export interface SnakeFood {
  kind: SnakeFoodKind;
  /** Only set for the digit bonus. */
  digit: string | null;
  cells: SnakeCell[];
}

export interface SnakeOptions {
  random?: () => number;
}

const STEPS: Record<SnakeDirection, SnakeCell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<SnakeDirection, SnakeDirection> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function cellKey(cell: SnakeCell): number {
  return cell.y * GAME_SCREEN_WIDTH + cell.x;
}

function mixHex(from: readonly number[], to: readonly number[], ratio: number): string {
  const channel = (index: number): string =>
    Math.round(from[index]! + (to[index]! - from[index]!) * ratio).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function textWidth(text: string): number {
  return text.length === 0 ? 0 : text.length * 4 - 1;
}

function drawText(ctx: PixelDrawContext, text: string, x: number, y: number, color: string): void {
  const bitmap = renderPixelText(text, 5);
  ctx.fillStyle = color;
  for (let row = 0; row < bitmap.height; row += 1) {
    for (let column = 0; column < bitmap.width; column += 1) {
      if (!bitmap.on[row * bitmap.width + column]) continue;
      const px = x + column;
      const py = y + row;
      if (px < 0 || px >= GAME_SCREEN_WIDTH || py < 0 || py >= GAME_SCREEN_HEIGHT) continue;
      ctx.fillRect(px, py, 1, 1);
    }
  }
}

function drawCenteredText(ctx: PixelDrawContext, text: string, y: number, color: string): void {
  drawText(ctx, text, Math.floor((GAME_SCREEN_WIDTH - textWidth(text)) / 2), y, color);
}

export class SnakeGame implements GameEngine {
  readonly meta = {
    id: "snake",
    title: "贪吃蛇",
    hint: "方向键或滑动改变方向，数字食物加 5 分",
  } as const;

  score = 0;
  eaten = 0;
  phase: GamePhase = "ready";
  /** Head first, tail last. */
  cells: SnakeCell[] = [];
  direction: SnakeDirection = "right";
  pendingDirection: SnakeDirection = "right";
  food!: SnakeFood;
  /** Cells still owed to the snake from the last meal. */
  growth = 0;

  private accumulatorMs = 0;
  private elapsedMs = 0;
  private overMs = 0;
  private readonly random: () => number;

  constructor(options: SnakeOptions = {}) {
    this.random = options.random ?? Math.random;
    this.reset();
  }

  tick(dtMs: number, input: GameInput): void {
    const dt = clamp(dtMs, 0, 250);
    this.elapsedMs += dt;
    if (input.direction) this.queueDirection(input.direction);

    if (this.phase === "ready") {
      // A direction key is the natural first move here, so it starts the run too.
      if (!input.pressedEdge && !input.direction) return;
      this.phase = "playing";
    } else if (this.phase === "game-over") {
      this.overMs += dt;
      if (input.pressedEdge && this.overMs >= RESTART_LOCK_MS) this.restart();
      return;
    }

    this.accumulatorMs += dt;
    let stepMs = this.stepMs();
    while (this.accumulatorMs >= stepMs && this.phase === "playing") {
      this.accumulatorMs -= stepMs;
      this.step();
      stepMs = this.stepMs();
    }
  }

  restart(): void {
    this.reset();
  }

  hud(): GameHud {
    return {
      score: this.score,
      level: this.level(),
      phase: this.phase,
      message: this.phase === "ready"
        ? "按方向键开始"
        : this.phase === "playing"
        ? `第 ${this.level()} 级 · 长度 ${this.cells.length}`
        : `结束了，得分 ${this.score}，再按一次重开`,
    };
  }

  level(): number {
    return Math.floor(this.eaten / SNAKE_FOOD_PER_LEVEL) + 1;
  }

  /** Cells per second — +8% per level, capped so the panel stays readable. */
  speed(): number {
    return Math.min(SNAKE_MAX_SPEED, SNAKE_BASE_SPEED * SNAKE_SPEED_STEP ** (this.level() - 1));
  }

  stepMs(): number {
    return 1_000 / this.speed();
  }

  /** Rejects a 180° reversal against the direction the snake last actually moved. */
  queueDirection(direction: SnakeDirection): void {
    if (direction === OPPOSITE[this.direction]) return;
    this.pendingDirection = direction;
  }

  render(ctx: PixelDrawContext): void {
    ctx.clearRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);

    const dim = this.phase === "game-over";
    this.renderFood(ctx, dim);
    this.renderSnake(ctx, dim);

    if (this.phase === "ready" && this.blink(500)) drawCenteredText(ctx, "SNAKE", 1, TITLE);
    if (dim) this.renderGameOver(ctx);
  }

  private reset(): void {
    this.score = 0;
    this.eaten = 0;
    this.phase = "ready";
    this.growth = 0;
    this.direction = "right";
    this.pendingDirection = "right";
    this.accumulatorMs = 0;
    this.elapsedMs = 0;
    this.overMs = 0;
    this.cells = this.startCells();
    this.food = this.spawnFood();
  }

  private startCells(): SnakeCell[] {
    const y = Math.floor(GAME_SCREEN_HEIGHT / 2);
    return Array.from({ length: SNAKE_START_LENGTH }, (_, index) => ({ x: 8 - index, y }));
  }

  private step(): void {
    this.direction = this.pendingDirection;
    const head = this.cells[0]!;
    const delta = STEPS[this.direction];
    const next: SnakeCell = { x: head.x + delta.x, y: head.y + delta.y };

    if (
      next.x < 0 || next.x >= GAME_SCREEN_WIDTH
      || next.y < 0 || next.y >= GAME_SCREEN_HEIGHT
    ) {
      this.gameOver();
      return;
    }
    // The tail cell frees up on this very step unless the snake is still growing.
    const lastIndex = this.cells.length - 1;
    const bitesSelf = this.cells.some((cell, index) =>
      cell.x === next.x && cell.y === next.y && !(this.growth === 0 && index === lastIndex)
    );
    if (bitesSelf) {
      this.gameOver();
      return;
    }

    this.cells.unshift(next);
    if (this.food.cells.some((cell) => cell.x === next.x && cell.y === next.y)) {
      const bonus = this.food.kind === "digit";
      this.score += bonus ? SNAKE_DIGIT_FOOD_SCORE : SNAKE_DOT_FOOD_SCORE;
      this.growth += bonus ? SNAKE_DIGIT_FOOD_GROWTH : 1;
      this.eaten += 1;
      this.food = this.spawnFood();
    }
    if (this.growth > 0) this.growth -= 1;
    else this.cells.pop();
  }

  private gameOver(): void {
    this.phase = "game-over";
    this.overMs = 0;
    this.accumulatorMs = 0;
  }

  private spawnFood(): SnakeFood {
    if (this.random() < SNAKE_DIGIT_FOOD_CHANCE) {
      const bonus = this.spawnDigitFood();
      if (bonus) return bonus;
    }
    return this.spawnDotFood();
  }

  private spawnDigitFood(): SnakeFood | null {
    const digit = String(this.pick(10));
    const glyph = PIXEL_FONT[digit];
    if (!glyph) return null;
    const occupied = new Set(this.cells.map(cellKey));

    for (let attempt = 0; attempt < DIGIT_PLACEMENT_TRIES; attempt += 1) {
      const originX = this.pick(GAME_SCREEN_WIDTH - DIGIT_WIDTH + 1);
      const originY = this.pick(GAME_SCREEN_HEIGHT - DIGIT_HEIGHT + 1);
      const cells: SnakeCell[] = [];
      for (let row = 0; row < DIGIT_HEIGHT; row += 1) {
        for (let column = 0; column < DIGIT_WIDTH; column += 1) {
          if (glyph[row]?.[column] !== "#") continue;
          cells.push({ x: originX + column, y: originY + row });
        }
      }
      if (cells.every((cell) => !occupied.has(cellKey(cell)))) {
        return { kind: "digit", digit, cells };
      }
    }
    return null;
  }

  private spawnDotFood(): SnakeFood {
    const occupied = new Set(this.cells.map(cellKey));
    const free: SnakeCell[] = [];
    for (let y = 0; y < GAME_SCREEN_HEIGHT; y += 1) {
      for (let x = 0; x < GAME_SCREEN_WIDTH; x += 1) {
        if (!occupied.has(y * GAME_SCREEN_WIDTH + x)) free.push({ x, y });
      }
    }
    const cell = free[this.pick(free.length)] ?? { x: 0, y: 0 };
    return { kind: "dot", digit: null, cells: [cell] };
  }

  /** Uniform integer in [0, bound) from the injected source. */
  private pick(bound: number): number {
    if (bound <= 0) return 0;
    return Math.min(bound - 1, Math.floor(clamp(this.random(), 0, 0.999_999) * bound));
  }

  private blink(periodMs: number): boolean {
    return Math.floor(this.elapsedMs / periodMs) % 2 === 0;
  }

  private renderFood(ctx: PixelDrawContext, dim: boolean): void {
    const bonus = this.food.kind === "digit";
    const on = this.blink(280);
    ctx.fillStyle = dim
      ? (bonus ? DIGIT_DIM : FOOD_DIM)
      : bonus
      ? (on ? DIGIT_BRIGHT : DIGIT_DIM)
      : on
      ? FOOD_BRIGHT
      : FOOD_DIM;
    for (const cell of this.food.cells) ctx.fillRect(cell.x, cell.y, 1, 1);
  }

  private renderSnake(ctx: PixelDrawContext, dim: boolean): void {
    const last = Math.max(1, this.cells.length - 1);
    this.cells.forEach((cell, index) => {
      ctx.fillStyle = dim ? DIM_SNAKE : mixHex(HEAD_RGB, TAIL_RGB, index / last);
      ctx.fillRect(cell.x, cell.y, 1, 1);
    });
  }

  private renderGameOver(ctx: PixelDrawContext): void {
    drawCenteredText(ctx, "OVER", 1, TITLE);
    drawCenteredText(ctx, String(this.score), 9, SCORE);
    if (this.overMs < RESTART_LOCK_MS || !this.blink(420)) return;
    ctx.fillStyle = PROMPT;
    for (let x = 0; x < GAME_SCREEN_WIDTH; x += 2) ctx.fillRect(x, GAME_SCREEN_HEIGHT - 1, 1, 1);
  }
}

export function createSnakeGame(options: SnakeOptions = {}): SnakeGame {
  return new SnakeGame(options);
}
