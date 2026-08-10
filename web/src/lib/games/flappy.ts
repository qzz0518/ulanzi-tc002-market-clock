// Flappy bird for the 52x16 LED panel.
// Tuning table: docs/design/pixel-playground.md §4 (row 2).
// DOM-free and deterministic — inject `random` to reproduce a pipe layout in tests.

import {
  GAME_SCREEN_HEIGHT,
  GAME_SCREEN_WIDTH,
  type GameEngine,
  type GameHud,
  type GameInput,
  type GamePhase,
  type PixelDrawContext,
} from "@/lib/games/engine";
import { renderPixelText } from "@/lib/pixel-font";

export const FLAPPY_STEP_MS = 1_000 / 120;
export const FLAPPY_BIRD_X = 12;
export const FLAPPY_BIRD_SIZE = 2;
/** px/s² */
export const FLAPPY_GRAVITY = 42;
/** px/s, applied as an absolute velocity on every flap. */
export const FLAPPY_JUMP_VELOCITY = -18;
export const FLAPPY_PIPE_WIDTH = 3;
export const FLAPPY_PIPE_SPACING = 18;
/** px/s at score 0. */
export const FLAPPY_BASE_SPEED = 14;
export const FLAPPY_SPEED_STEP = 1.06;
export const FLAPPY_SCORE_PER_STEP = 5;
export const FLAPPY_MAX_GAP = 7;
export const FLAPPY_MIN_GAP = 5;
/** The bottom row is the ground strip, so the playfield is rows 0..14. */
export const FLAPPY_GROUND_Y = GAME_SCREEN_HEIGHT - 1;

const FIELD_HEIGHT = FLAPPY_GROUND_Y;
const PIPES_ON_FIELD = 4;
const RESTART_LOCK_MS = 600;
const START_BIRD_Y = 6;

// Full-screen fill: on the LED panel a dark grey sky lights every pixel, so keep it truly off.
const SKY = "#000000";
const PIPE = "#28c05a";
const PIPE_RIM = "#7dffa8";
const GROUND = "#3a2a12";
const GROUND_DASH = "#7a5a26";
const BIRD = "#ffd43b";
const BIRD_WING = "#ff8a2a";
const DIM_PIPE = "#0f3320";
const DIM_RIM = "#1c5535";
const DIM_GROUND = "#181207";
const DIM_BIRD = "#4a3f14";
const TITLE = "#6f8296";
const SCORE = "#ffffff";
const PROMPT = "#c1ff3d";

export interface FlappyPipe {
  /** Left edge of the pipe column; floats so the scroll stays smooth. */
  x: number;
  /** First row of the gap. */
  gapTop: number;
  /** Gap height frozen at spawn time so difficulty never changes mid-flight. */
  gap: number;
  scored: boolean;
}

export interface FlappyOptions {
  random?: () => number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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

export class FlappyGame implements GameEngine {
  readonly meta = {
    id: "flappy",
    title: "像素小鸟",
    hint: "空格或点击让小鸟起飞，穿过管道得分",
  } as const;

  score = 0;
  phase: GamePhase = "ready";
  /** Top edge of the 2x2 bird. */
  birdY = START_BIRD_Y;
  velocity = 0;
  pipes: FlappyPipe[] = [];
  /** Total scrolled distance, used for the ground dash parallax. */
  scrolled = 0;

  private accumulatorMs = 0;
  private elapsedMs = 0;
  private overMs = 0;
  private readonly random: () => number;

  constructor(options: FlappyOptions = {}) {
    this.random = options.random ?? Math.random;
    this.reset();
  }

  tick(dtMs: number, input: GameInput): void {
    const dt = clamp(dtMs, 0, 250);
    this.elapsedMs += dt;

    if (this.phase === "ready") {
      if (!input.pressedEdge) return;
      this.phase = "playing";
      this.velocity = FLAPPY_JUMP_VELOCITY;
    } else if (this.phase === "game-over") {
      this.overMs += dt;
      if (input.pressedEdge && this.overMs >= RESTART_LOCK_MS) this.restart();
      return;
    } else if (input.pressedEdge) {
      this.velocity = FLAPPY_JUMP_VELOCITY;
    }

    this.accumulatorMs += dt;
    while (this.accumulatorMs >= FLAPPY_STEP_MS && this.phase === "playing") {
      this.accumulatorMs -= FLAPPY_STEP_MS;
      this.step(FLAPPY_STEP_MS / 1_000);
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
        ? "按空格或点击起飞"
        : this.phase === "playing"
        ? `第 ${this.level()} 档速度`
        : `撞上了，得分 ${this.score}，再按一次重开`,
    };
  }

  /** Horizontal scroll speed in px/s — +6% every five points. */
  speed(): number {
    return FLAPPY_BASE_SPEED * FLAPPY_SPEED_STEP ** Math.floor(this.score / FLAPPY_SCORE_PER_STEP);
  }

  /** Gap height for the next pipe — shrinks 7 → 5 as the score climbs. */
  gap(): number {
    return Math.max(FLAPPY_MIN_GAP, FLAPPY_MAX_GAP - Math.floor(this.score / FLAPPY_SCORE_PER_STEP));
  }

  level(): number {
    return Math.floor(this.score / FLAPPY_SCORE_PER_STEP) + 1;
  }

  render(ctx: PixelDrawContext): void {
    ctx.clearRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);
    ctx.fillStyle = SKY;
    ctx.fillRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);

    const dim = this.phase === "game-over";
    this.renderPipes(ctx, dim);
    this.renderGround(ctx, dim);

    if (this.phase === "ready") {
      const bob = Math.sin(this.elapsedMs / 260) * 1.4;
      this.renderBird(ctx, Math.round(START_BIRD_Y + bob), false);
      if (this.blink(420)) drawText(ctx, "FLAP", 30, 5, PROMPT);
      return;
    }

    this.renderBird(ctx, Math.round(this.birdY), dim);
    if (dim) this.renderGameOver(ctx);
  }

  private reset(): void {
    this.score = 0;
    this.phase = "ready";
    this.birdY = START_BIRD_Y;
    this.velocity = 0;
    this.scrolled = 0;
    this.accumulatorMs = 0;
    this.elapsedMs = 0;
    this.overMs = 0;
    this.pipes = [];
    this.refillPipes();
  }

  private step(dtSeconds: number): void {
    this.velocity += FLAPPY_GRAVITY * dtSeconds;
    this.birdY += this.velocity * dtSeconds;
    if (this.birdY < 0) {
      this.birdY = 0;
      this.velocity = 0;
    }

    const distance = this.speed() * dtSeconds;
    this.scrolled += distance;
    for (const pipe of this.pipes) {
      pipe.x -= distance;
      if (!pipe.scored && pipe.x + FLAPPY_PIPE_WIDTH < FLAPPY_BIRD_X) {
        pipe.scored = true;
        this.score += 1;
      }
    }
    this.pipes = this.pipes.filter((pipe) => pipe.x + FLAPPY_PIPE_WIDTH > -1);
    this.refillPipes();

    if (this.hitsGround() || this.hitsPipe()) {
      this.phase = "game-over";
      this.overMs = 0;
      this.accumulatorMs = 0;
    }
  }

  private hitsGround(): boolean {
    return this.birdY + FLAPPY_BIRD_SIZE > FLAPPY_GROUND_Y;
  }

  private hitsPipe(): boolean {
    return this.pipes.some((pipe) => {
      const overlapsX = pipe.x < FLAPPY_BIRD_X + FLAPPY_BIRD_SIZE
        && FLAPPY_BIRD_X < pipe.x + FLAPPY_PIPE_WIDTH;
      if (!overlapsX) return false;
      return this.birdY < pipe.gapTop || this.birdY + FLAPPY_BIRD_SIZE > pipe.gapTop + pipe.gap;
    });
  }

  private refillPipes(): void {
    while (this.pipes.length < PIPES_ON_FIELD) {
      const last = this.pipes[this.pipes.length - 1];
      const x = last ? last.x + FLAPPY_PIPE_SPACING : GAME_SCREEN_WIDTH;
      const gap = this.gap();
      // Keep at least one solid row above and below so both stubs stay visible.
      const span = Math.max(1, FIELD_HEIGHT - gap - 1);
      this.pipes.push({
        x,
        gap,
        gapTop: 1 + Math.floor(clamp(this.random(), 0, 0.999_999) * span),
        scored: false,
      });
    }
  }

  private blink(periodMs: number): boolean {
    return Math.floor(this.elapsedMs / periodMs) % 2 === 0;
  }

  private renderPipes(ctx: PixelDrawContext, dim: boolean): void {
    for (const pipe of this.pipes) {
      const left = Math.round(pipe.x);
      for (let column = left; column < left + FLAPPY_PIPE_WIDTH; column += 1) {
        if (column < 0 || column >= GAME_SCREEN_WIDTH) continue;
        ctx.fillStyle = dim ? DIM_PIPE : PIPE;
        if (pipe.gapTop > 0) ctx.fillRect(column, 0, 1, pipe.gapTop);
        const bottom = pipe.gapTop + pipe.gap;
        if (bottom < FIELD_HEIGHT) ctx.fillRect(column, bottom, 1, FIELD_HEIGHT - bottom);
        ctx.fillStyle = dim ? DIM_RIM : PIPE_RIM;
        if (pipe.gapTop - 1 >= 0) ctx.fillRect(column, pipe.gapTop - 1, 1, 1);
        if (bottom < FIELD_HEIGHT) ctx.fillRect(column, bottom, 1, 1);
      }
    }
  }

  private renderGround(ctx: PixelDrawContext, dim: boolean): void {
    ctx.fillStyle = dim ? DIM_GROUND : GROUND;
    ctx.fillRect(0, FLAPPY_GROUND_Y, GAME_SCREEN_WIDTH, 1);
    if (dim) return;
    ctx.fillStyle = GROUND_DASH;
    const offset = Math.floor(this.scrolled) % 4;
    for (let x = 3 - offset; x < GAME_SCREEN_WIDTH; x += 4) {
      if (x < 0) continue;
      ctx.fillRect(x, FLAPPY_GROUND_Y, 1, 1);
    }
  }

  private renderBird(ctx: PixelDrawContext, top: number, dim: boolean): void {
    const y = clamp(top, 0, FIELD_HEIGHT - FLAPPY_BIRD_SIZE);
    ctx.fillStyle = dim ? DIM_BIRD : BIRD;
    ctx.fillRect(FLAPPY_BIRD_X, y, FLAPPY_BIRD_SIZE, FLAPPY_BIRD_SIZE);
    ctx.fillStyle = dim ? DIM_BIRD : BIRD_WING;
    ctx.fillRect(FLAPPY_BIRD_X, y + 1, 1, 1);
  }

  private renderGameOver(ctx: PixelDrawContext): void {
    drawCenteredText(ctx, "OVER", 1, TITLE);
    drawCenteredText(ctx, String(this.score), 9, SCORE);
    if (this.overMs < RESTART_LOCK_MS || !this.blink(420)) return;
    ctx.fillStyle = PROMPT;
    for (let x = 0; x < GAME_SCREEN_WIDTH; x += 2) ctx.fillRect(x, FLAPPY_GROUND_Y, 1, 1);
  }
}

export function createFlappyGame(options: FlappyOptions = {}): FlappyGame {
  return new FlappyGame(options);
}
