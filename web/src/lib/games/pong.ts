// Two-player Pong for the 52x16 LED panel.
// Tuning table: docs/design/pixel-playground.md §4 (row 4).
// DOM-free and deterministic — inject `random` to pin the serve angle in tests.

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

export const PONG_STEP_MS = 1_000 / 120;
export const PONG_PADDLE_HEIGHT = 4;
/** px/s on the opening serve. */
export const PONG_BASE_SPEED = 20;
/** The ball gains 5% for every round already played. */
export const PONG_SPEED_STEP = 1.05;
export const PONG_WIN_SCORE = 9;
/** px/s ceiling for the AI paddle, deliberately slower than the ball. */
export const PONG_AI_SPEED = 13;
export const PONG_SERVE_DELAY_MS = 500;
/** How long a silent gamepad still counts as "player 2" for labels. */
export const PONG_PAD_TIMEOUT_MS = 2_000;

export const PONG_LEFT_COLUMN = 0;
export const PONG_RIGHT_COLUMN = GAME_SCREEN_WIDTH - 1;
const LEFT_PLANE = 1;
const RIGHT_PLANE = GAME_SCREEN_WIDTH - 2;
const MID_X = GAME_SCREEN_WIDTH / 2;
const CENTER_Y = (GAME_SCREEN_HEIGHT - 1) / 2;
const RESTART_LOCK_MS = 600;

// Full-screen fill: on the LED panel a dark grey background lights every pixel, so keep it truly off.
const BG = "#000000";
const MIDLINE = "#16324e";
const DIM_MIDLINE = "#0b1a28";
const SCORE_DIM = "#1d4368";
const LEFT_PADDLE = "#5b8cff";
const RIGHT_PADDLE = "#ff8a2a";
const BALL = "#ffffff";
const TITLE = "#6f8296";
const FINAL_SCORE = "#ffffff";

export interface PongBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface PongOptions {
  random?: () => number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Turns a desired paddle centre into a clamped top edge. */
export function pongPaddleTop(center: number): number {
  return clamp(center - PONG_PADDLE_HEIGHT / 2, 0, GAME_SCREEN_HEIGHT - PONG_PADDLE_HEIGHT);
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

export class PongGame implements GameEngine {
  readonly meta = {
    id: "pong",
    title: "双人 Pong",
    hint: "拖动控制左板，右板由手柄或电脑接管，9 分制",
    twoPlayers: true,
  } as const;

  scoreLeft = 0;
  scoreRight = 0;
  phase: GamePhase = "ready";
  /** Top edge of each paddle. */
  leftY = pongPaddleTop(GAME_SCREEN_HEIGHT / 2);
  rightY = pongPaddleTop(GAME_SCREEN_HEIGHT / 2);
  ball: PongBall = { x: MID_X, y: CENTER_Y, vx: 0, vy: 0 };
  serveDelayMs = 0;

  private serveTowardLeft = true;
  private padLive = false;
  private padIdleMs = Number.POSITIVE_INFINITY;
  private accumulatorMs = 0;
  private elapsedMs = 0;
  private overMs = 0;
  private readonly random: () => number;

  constructor(options: PongOptions = {}) {
    this.random = options.random ?? Math.random;
    this.reset();
  }

  tick(dtMs: number, input: GameInput): void {
    const dt = clamp(dtMs, 0, 250);
    this.elapsedMs += dt;

    this.padLive = input.p2PointerY !== null;
    this.padIdleMs = this.padLive ? 0 : this.padIdleMs + dt;
    // The left paddle tracks the pointer's vertical position directly — mapping
    // the horizontal axis onto a vertical paddle is unusable with a mouse.
    if (input.pointerY !== null) {
      this.leftY = pongPaddleTop(clamp(input.pointerY, 0, GAME_SCREEN_HEIGHT));
    }
    if (input.p2PointerY !== null) {
      this.rightY = pongPaddleTop(clamp(input.p2PointerY, 0, GAME_SCREEN_HEIGHT));
    }

    if (this.phase === "ready") {
      if (!input.pressedEdge) return;
      this.phase = "playing";
      this.serve(this.random() < 0.5);
    } else if (this.phase === "game-over") {
      this.overMs += dt;
      if (input.pressedEdge && this.overMs >= RESTART_LOCK_MS) this.restart();
      return;
    }

    this.accumulatorMs += dt;
    while (this.accumulatorMs >= PONG_STEP_MS && this.phase === "playing") {
      this.accumulatorMs -= PONG_STEP_MS;
      this.step(PONG_STEP_MS / 1_000);
    }
  }

  restart(): void {
    this.reset();
  }

  hud(): GameHud {
    return {
      score: this.scoreLeft,
      level: this.rounds() + 1,
      phase: this.phase,
      message: this.phase === "ready"
        ? "按空格发球，拖动控制左板"
        : this.phase === "playing"
        ? `你 ${this.scoreLeft} : ${this.scoreRight} ${this.rightName()}`
        : this.leftWon()
        ? `你赢了 ${this.scoreLeft} : ${this.scoreRight}`
        : `${this.rightName()}赢了 ${this.scoreRight} : ${this.scoreLeft}`,
    };
  }

  /** Rounds already decided; the ball gains 5% per round. */
  rounds(): number {
    return this.scoreLeft + this.scoreRight;
  }

  speed(): number {
    return PONG_BASE_SPEED * PONG_SPEED_STEP ** this.rounds();
  }

  /** True once a WS gamepad has reported recently. */
  padConnected(): boolean {
    return this.padIdleMs <= PONG_PAD_TIMEOUT_MS;
  }

  leftWon(): boolean {
    return this.scoreLeft > this.scoreRight;
  }

  render(ctx: PixelDrawContext): void {
    ctx.clearRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);

    if (this.phase === "game-over") {
      this.renderMidline(ctx, true);
      const winner = this.leftWon() ? LEFT_PADDLE : RIGHT_PADDLE;
      drawCenteredText(ctx, this.leftWon() ? "P1 WIN" : `${this.rightTag()} WIN`, 2, winner);
      drawCenteredText(ctx, `${this.scoreLeft}-${this.scoreRight}`, 9, FINAL_SCORE);
      return;
    }

    this.renderScores(ctx);
    this.renderMidline(ctx, false);
    ctx.fillStyle = LEFT_PADDLE;
    ctx.fillRect(PONG_LEFT_COLUMN, Math.round(this.leftY), 1, PONG_PADDLE_HEIGHT);
    ctx.fillStyle = RIGHT_PADDLE;
    ctx.fillRect(PONG_RIGHT_COLUMN, Math.round(this.rightY), 1, PONG_PADDLE_HEIGHT);

    // The ball blinks while it waits on the centre spot, and again on the attract screen.
    const waiting = this.phase === "ready" || this.serveDelayMs > 0;
    if (!waiting || this.blink(360)) {
      ctx.fillStyle = BALL;
      ctx.fillRect(
        clamp(Math.round(this.ball.x), 0, GAME_SCREEN_WIDTH - 1),
        clamp(Math.round(this.ball.y), 0, GAME_SCREEN_HEIGHT - 1),
        1,
        1,
      );
    }
    // Sits below the centre spot so the blinking ball stays visible.
    if (this.phase === "ready" && this.blink(500)) drawCenteredText(ctx, "PONG", 10, TITLE);
  }

  private reset(): void {
    this.scoreLeft = 0;
    this.scoreRight = 0;
    this.phase = "ready";
    this.leftY = pongPaddleTop(GAME_SCREEN_HEIGHT / 2);
    this.rightY = pongPaddleTop(GAME_SCREEN_HEIGHT / 2);
    this.ball = { x: MID_X, y: CENTER_Y, vx: 0, vy: 0 };
    this.serveDelayMs = 0;
    this.serveTowardLeft = true;
    this.padIdleMs = Number.POSITIVE_INFINITY;
    this.padLive = false;
    this.accumulatorMs = 0;
    this.elapsedMs = 0;
    this.overMs = 0;
  }

  private rightName(): string {
    return this.padConnected() ? "手柄" : "电脑";
  }

  private rightTag(): string {
    return this.padConnected() ? "P2" : "AI";
  }

  private serve(towardLeft: boolean): void {
    const angle = (this.random() * 2 - 1) * Math.PI / 6;
    const speed = this.speed();
    this.ball = {
      x: MID_X,
      y: CENTER_Y,
      vx: (towardLeft ? -1 : 1) * Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    };
    this.serveDelayMs = 0;
  }

  private step(dtSeconds: number): void {
    if (!this.padLive) this.trackWithAi(dtSeconds);
    if (this.serveDelayMs > 0) {
      this.serveDelayMs -= dtSeconds * 1_000;
      if (this.serveDelayMs <= 0) this.serve(this.serveTowardLeft);
      return;
    }

    let nextX = this.ball.x + this.ball.vx * dtSeconds;
    let nextY = this.ball.y + this.ball.vy * dtSeconds;

    if (nextY < 0) {
      nextY = -nextY;
      this.ball.vy = Math.abs(this.ball.vy);
    } else if (nextY > GAME_SCREEN_HEIGHT - 1) {
      nextY = 2 * (GAME_SCREEN_HEIGHT - 1) - nextY;
      this.ball.vy = -Math.abs(this.ball.vy);
    }

    if (this.ball.vx < 0 && this.ball.x >= LEFT_PLANE && nextX < LEFT_PLANE && this.catches(this.leftY, nextY)) {
      nextX = 2 * LEFT_PLANE - nextX;
      this.bounce(this.leftY, nextY, 1);
    } else if (
      this.ball.vx > 0 && this.ball.x <= RIGHT_PLANE && nextX > RIGHT_PLANE && this.catches(this.rightY, nextY)
    ) {
      nextX = 2 * RIGHT_PLANE - nextX;
      this.bounce(this.rightY, nextY, -1);
    }

    this.ball.x = nextX;
    this.ball.y = nextY;

    if (nextX < -0.5) this.awardPoint(false);
    else if (nextX > GAME_SCREEN_WIDTH - 0.5) this.awardPoint(true);
  }

  private catches(paddleTop: number, y: number): boolean {
    return y >= paddleTop - 0.5 && y <= paddleTop + PONG_PADDLE_HEIGHT - 0.5;
  }

  private bounce(paddleTop: number, y: number, towardRight: 1 | -1): void {
    const center = paddleTop + PONG_PADDLE_HEIGHT / 2 - 0.5;
    const offset = clamp((y - center) / (PONG_PADDLE_HEIGHT / 2), -1, 1);
    const angle = offset * Math.PI / 3;
    const speed = this.speed();
    this.ball.vx = towardRight * Math.cos(angle) * speed;
    this.ball.vy = Math.sin(angle) * speed;
  }

  private awardPoint(leftScored: boolean): void {
    if (leftScored) this.scoreLeft += 1;
    else this.scoreRight += 1;

    this.ball = { x: MID_X, y: CENTER_Y, vx: 0, vy: 0 };
    if (this.scoreLeft >= PONG_WIN_SCORE || this.scoreRight >= PONG_WIN_SCORE) {
      this.phase = "game-over";
      this.overMs = 0;
      this.accumulatorMs = 0;
      this.serveDelayMs = 0;
      return;
    }
    // The loser of the round receives the next serve.
    this.serveTowardLeft = !leftScored;
    this.serveDelayMs = PONG_SERVE_DELAY_MS;
  }

  private trackWithAi(dtSeconds: number): void {
    const center = this.rightY + PONG_PADDLE_HEIGHT / 2;
    const target = this.serveDelayMs > 0 ? CENTER_Y : this.ball.y;
    const reach = PONG_AI_SPEED * dtSeconds;
    this.rightY = clamp(
      this.rightY + clamp(target - center, -reach, reach),
      0,
      GAME_SCREEN_HEIGHT - PONG_PADDLE_HEIGHT,
    );
  }

  private blink(periodMs: number): boolean {
    return Math.floor(this.elapsedMs / periodMs) % 2 === 0;
  }

  private renderMidline(ctx: PixelDrawContext, dim: boolean): void {
    ctx.fillStyle = dim ? DIM_MIDLINE : MIDLINE;
    for (let y = 0; y < GAME_SCREEN_HEIGHT; y += 1) {
      if (y % 3 === 2) continue;
      ctx.fillRect(MID_X, y, 1, 1);
    }
  }

  private renderScores(ctx: PixelDrawContext): void {
    const left = String(this.scoreLeft);
    drawText(ctx, left, MID_X - 4 - textWidth(left), 1, SCORE_DIM);
    drawText(ctx, String(this.scoreRight), MID_X + 4, 1, SCORE_DIM);
  }
}

export function createPongGame(options: PongOptions = {}): PongGame {
  return new PongGame(options);
}
