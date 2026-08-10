import { renderPixelText } from "@/lib/pixel-font";
import {
  GAME_SCREEN_HEIGHT,
  GAME_SCREEN_WIDTH,
  type GameEngine,
  type GameHud,
  type GameInput,
  type GamePhase,
  type PixelDrawContext,
} from "@/lib/games/engine";

export const BREAKOUT_WIDTH = GAME_SCREEN_WIDTH;
export const BREAKOUT_HEIGHT = GAME_SCREEN_HEIGHT;
export const BREAKOUT_FIXED_STEP_MS = 1_000 / 120;
export const BREAKOUT_PADDLE_WIDTHS = [6, 8, 10] as const;

const START_SPEED = 16;
const MAX_SPEED = 30;
const RAINBOW = [
  "#ff4d5a",
  "#ff8a2a",
  "#ffd43b",
  "#58d68d",
  "#35c7d4",
  "#5b8cff",
  "#b66cff",
] as const;

export type BreakoutPhase = "playing" | "game-over";
export type BreakoutBrickKind = "normal" | "digit";
export type BreakoutPaddleWidth = typeof BREAKOUT_PADDLE_WIDTHS[number];

export interface BreakoutBrick {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  kind: BreakoutBrickKind;
}

export interface BreakoutBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface BreakoutRenderContext {
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clockText(now: Date): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function timeBrickRows(now: Date): string[] {
  const bitmap = renderPixelText(clockText(now), 5);
  return Array.from({ length: bitmap.height }, (_, y) =>
    Array.from({ length: bitmap.width }, (_, x) => bitmap.on[y * bitmap.width + x] ? "#" : ".")
      .join("")
  );
}

export function createTimeBricks(now: Date): BreakoutBrick[] {
  const bitmap = renderPixelText(clockText(now), 5);
  const startX = Math.floor((BREAKOUT_WIDTH - bitmap.width) / 2);
  const bricks: BreakoutBrick[] = [];

  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      if (!bitmap.on[y * bitmap.width + x]) continue;
      bricks.push({
        id: `digit-${x}-${y}`,
        x: startX + x,
        y,
        width: 1,
        height: 1,
        color: RAINBOW[y % RAINBOW.length]!,
        kind: "digit",
      });
    }
  }

  const sideGap = 1;
  const rightStart = startX + bitmap.width + sideGap;
  for (let y = 0; y <= 5; y += 1) {
    for (let x = 0; x < startX - sideGap; x += 4) {
      bricks.push({
        id: `normal-left-${x}-${y}`,
        x,
        y,
        width: Math.min(3, startX - sideGap - x),
        height: 1,
        color: RAINBOW[y % RAINBOW.length]!,
        kind: "normal",
      });
    }
    for (let x = rightStart; x < BREAKOUT_WIDTH; x += 4) {
      bricks.push({
        id: `normal-right-${x}-${y}`,
        x,
        y,
        width: Math.min(3, BREAKOUT_WIDTH - x),
        height: 1,
        color: RAINBOW[y % RAINBOW.length]!,
        kind: "normal",
      });
    }
  }
  return bricks;
}

interface BreakoutOptions {
  paddleWidth?: BreakoutPaddleWidth;
  now?: () => Date;
}

export class BreakoutGame {
  score = 0;
  lives = 3;
  level = 1;
  phase: BreakoutPhase = "playing";
  paddleX: number;
  paddleWidth: BreakoutPaddleWidth;
  ball: BreakoutBall;
  bricks: BreakoutBrick[];
  destroyed = 0;

  private accumulatorMs = 0;
  private readonly now: () => Date;

  constructor(options: BreakoutOptions = {}) {
    this.paddleWidth = options.paddleWidth ?? 8;
    this.paddleX = Math.floor((BREAKOUT_WIDTH - this.paddleWidth) / 2);
    this.now = options.now ?? (() => new Date());
    this.bricks = createTimeBricks(this.now());
    this.ball = this.startBall();
  }

  tick(dtMs: number, paddleTargetX: number): void {
    if (this.phase !== "playing") return;
    const target = Number.isFinite(paddleTargetX)
      ? paddleTargetX
      : this.paddleX + this.paddleWidth / 2;
    this.paddleX = clamp(target - this.paddleWidth / 2, 0, BREAKOUT_WIDTH - this.paddleWidth);
    this.accumulatorMs += clamp(dtMs, 0, 250);
    while (this.accumulatorMs >= BREAKOUT_FIXED_STEP_MS && this.phase === "playing") {
      this.step(BREAKOUT_FIXED_STEP_MS / 1_000);
      this.accumulatorMs -= BREAKOUT_FIXED_STEP_MS;
    }
  }

  setPaddleWidth(width: BreakoutPaddleWidth): void {
    this.paddleWidth = width;
    this.paddleX = clamp(this.paddleX, 0, BREAKOUT_WIDTH - width);
  }

  restart(): void {
    this.score = 0;
    this.lives = 3;
    this.level = 1;
    this.phase = "playing";
    this.destroyed = 0;
    this.accumulatorMs = 0;
    this.paddleX = Math.floor((BREAKOUT_WIDTH - this.paddleWidth) / 2);
    this.bricks = createTimeBricks(this.now());
    this.ball = this.startBall();
  }

  render(context: BreakoutRenderContext): void {
    context.clearRect(0, 0, BREAKOUT_WIDTH, BREAKOUT_HEIGHT);
    context.fillStyle = "#000000";
    context.fillRect(0, 0, BREAKOUT_WIDTH, BREAKOUT_HEIGHT);
    for (const brick of this.bricks) {
      context.fillStyle = brick.color;
      context.fillRect(brick.x, brick.y, brick.width, brick.height);
    }
    context.fillStyle = "#c1ff3d";
    context.fillRect(Math.round(this.paddleX), 15, this.paddleWidth, 1);
    context.fillStyle = "#ffffff";
    context.fillRect(
      clamp(Math.round(this.ball.x), 0, BREAKOUT_WIDTH - 1),
      clamp(Math.round(this.ball.y), 0, BREAKOUT_HEIGHT - 1),
      1,
      1,
    );
  }

  private startBall(): BreakoutBall {
    const angle = (this.level % 2 === 0 ? -1 : 1) * Math.PI / 9;
    const speed = this.speed();
    return {
      x: BREAKOUT_WIDTH / 2,
      y: 12.5,
      vx: Math.sin(angle) * speed,
      vy: -Math.cos(angle) * speed,
    };
  }

  private step(dtSeconds: number): void {
    let nextX = this.ball.x + this.ball.vx * dtSeconds;
    let nextY = this.ball.y + this.ball.vy * dtSeconds;

    if (nextX < 0) {
      nextX = -nextX;
      this.ball.vx = Math.abs(this.ball.vx);
    } else if (nextX > BREAKOUT_WIDTH - 1) {
      nextX = 2 * (BREAKOUT_WIDTH - 1) - nextX;
      this.ball.vx = -Math.abs(this.ball.vx);
    }
    if (nextY < 0) {
      nextY = -nextY;
      this.ball.vy = Math.abs(this.ball.vy);
    }

    if (this.ball.vy > 0 && this.ball.y < 14.5 && nextY >= 14.5) {
      const hitX = nextX;
      if (hitX >= this.paddleX - 0.5 && hitX <= this.paddleX + this.paddleWidth - 0.5) {
        nextY = 14.5 - (nextY - 14.5);
        const center = this.paddleX + this.paddleWidth / 2 - 0.5;
        const offset = clamp((hitX - center) / (this.paddleWidth / 2), -1, 1);
        const angle = offset * Math.PI / 3;
        const speed = this.speed();
        this.ball.vx = Math.sin(angle) * speed;
        this.ball.vy = -Math.cos(angle) * speed;
      }
    }

    const hitIndex = this.bricks.findIndex((brick) =>
      nextX >= brick.x - 0.5
      && nextX <= brick.x + brick.width - 0.5
      && nextY >= brick.y - 0.5
      && nextY <= brick.y + brick.height - 0.5
    );
    if (hitIndex >= 0) {
      const [brick] = this.bricks.splice(hitIndex, 1);
      if (brick) {
        this.score += brick.kind === "digit" ? 30 : 10;
        this.destroyed += 1;
        this.ball.vy *= -1;
        this.applySpeed(this.speed());
        nextY = this.ball.y + this.ball.vy * dtSeconds;
      }
    }

    this.ball.x = nextX;
    this.ball.y = nextY;
    if (this.ball.y > BREAKOUT_HEIGHT - 0.5) this.loseLife();
    else if (this.bricks.length === 0) this.nextLevel();
  }

  private speed(): number {
    return Math.min(MAX_SPEED, START_SPEED * 1.06 ** Math.floor(this.destroyed / 8));
  }

  private applySpeed(speed: number): void {
    const current = Math.hypot(this.ball.vx, this.ball.vy) || 1;
    this.ball.vx = this.ball.vx / current * speed;
    this.ball.vy = this.ball.vy / current * speed;
  }

  private loseLife(): void {
    this.lives -= 1;
    if (this.lives <= 0) {
      this.lives = 0;
      this.phase = "game-over";
      return;
    }
    this.paddleX = Math.floor((BREAKOUT_WIDTH - this.paddleWidth) / 2);
    this.ball = this.startBall();
  }

  private nextLevel(): void {
    this.level += 1;
    this.bricks = createTimeBricks(this.now());
    this.paddleX = Math.floor((BREAKOUT_WIDTH - this.paddleWidth) / 2);
    this.ball = this.startBall();
  }
}

// ---------------------------------------------------------------------------
// GameEngine adapter — wraps the verified physics above with the shared shell
// contract: an attract screen in `ready`, the settlement screen in `game-over`
// (moved here from the v1 game view), and HUD mapping.
// ---------------------------------------------------------------------------

export const BREAKOUT_GAME_OVER_MS = 3_000;
// A press right after dying should not silently skip the settlement screen.
const RESTART_LOCKOUT_MS = 800;
// Held ←/→ moves the paddle at a speed that can still chase a max-speed ball.
const KEY_PADDLE_SPEED = 40;

function drawCenteredLabel(
  context: PixelDrawContext,
  text: string,
  y: number,
  color: string,
): void {
  const bitmap = renderPixelText(text, 5);
  const startX = Math.floor((BREAKOUT_WIDTH - bitmap.width) / 2);
  context.fillStyle = color;
  for (let row = 0; row < bitmap.height; row += 1) {
    for (let column = 0; column < bitmap.width; column += 1) {
      if (bitmap.on[row * bitmap.width + column]) {
        context.fillRect(startX + column, y + row, 1, 1);
      }
    }
  }
}

export class BreakoutEngine implements GameEngine {
  readonly meta = {
    id: "breakout",
    title: "时间打砖块",
    hint: "拖动屏幕或按 ← → 控制挡板，点按 / 空格开始",
  } as const;

  private readonly now: () => Date;
  private paddleWidth: BreakoutPaddleWidth;
  private game: BreakoutGame;
  private phase: GamePhase = "ready";
  private elapsedMs = 0;
  private gameOverAtMs = 0;
  private keyTargetX = BREAKOUT_WIDTH / 2;
  private readyBoardTime: string;

  constructor(options: BreakoutOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.paddleWidth = options.paddleWidth ?? 8;
    this.game = new BreakoutGame({ now: this.now, paddleWidth: this.paddleWidth });
    this.readyBoardTime = clockText(this.now());
  }

  tick(dtMs: number, input: GameInput): void {
    const dt = clamp(dtMs, 0, 250);
    this.elapsedMs += dt;

    if (this.phase === "ready") {
      // The attract board shows the live clock; rebuild it when the minute rolls.
      const current = clockText(this.now());
      if (current !== this.readyBoardTime) {
        this.readyBoardTime = current;
        this.game = new BreakoutGame({ now: this.now, paddleWidth: this.paddleWidth });
      }
      if (input.pressedEdge) this.begin();
      return;
    }

    if (this.phase === "playing") {
      this.game.tick(dt, this.resolvePaddleTarget(dt, input));
      if (this.game.phase === "game-over") {
        this.phase = "game-over";
        this.gameOverAtMs = this.elapsedMs;
      }
      return;
    }

    // game-over: hold the settlement screen briefly, then a press replays.
    if (input.pressedEdge && this.elapsedMs - this.gameOverAtMs >= RESTART_LOCKOUT_MS) {
      this.begin();
    }
  }

  render(context: PixelDrawContext): void {
    if (this.phase === "game-over") {
      this.renderGameOver(context);
      return;
    }
    this.game.render(context);
    if (this.phase === "ready") {
      // Attract overlay in the free band between bricks (y ≤ 5) and paddle.
      const blink = Math.floor(this.elapsedMs / 500) % 2 === 0;
      drawCenteredLabel(context, "PLAY!", 8, blink ? "#c1ff3d" : "#ffffff");
    }
  }

  hud(): GameHud {
    return {
      score: this.game.score,
      lives: this.game.lives,
      level: this.game.level,
      phase: this.phase,
      message: this.phase === "ready"
        ? "点按屏幕或按空格开始"
        : this.phase === "game-over"
          ? "点按屏幕或按空格再来一局"
          : undefined,
    };
  }

  restart(): void {
    this.game = new BreakoutGame({ now: this.now, paddleWidth: this.paddleWidth });
    this.readyBoardTime = clockText(this.now());
    this.phase = "ready";
    this.gameOverAtMs = 0;
    this.keyTargetX = BREAKOUT_WIDTH / 2;
  }

  /** Direct access to the wrapped simulation for tests and diagnostics. */
  get simulation(): BreakoutGame {
    return this.game;
  }

  /** Difficulty option surfaced by the shell — narrower paddle, harder game. */
  setPaddleWidth(width: BreakoutPaddleWidth): void {
    this.paddleWidth = width;
    this.game.setPaddleWidth(width);
  }

  getPaddleWidth(): BreakoutPaddleWidth {
    return this.paddleWidth;
  }

  private begin(): void {
    this.game = new BreakoutGame({ now: this.now, paddleWidth: this.paddleWidth });
    this.phase = "playing";
    this.keyTargetX = BREAKOUT_WIDTH / 2;
  }

  private resolvePaddleTarget(dtMs: number, input: GameInput): number {
    if (input.pointerX !== null) {
      // Keep the keyboard target in step so releasing the pointer never jumps.
      this.keyTargetX = clamp(input.pointerX, 0, BREAKOUT_WIDTH);
      return this.keyTargetX;
    }
    if (input.direction === "left" || input.direction === "right") {
      const sign = input.direction === "left" ? -1 : 1;
      this.keyTargetX = clamp(
        this.keyTargetX + sign * KEY_PADDLE_SPEED * (dtMs / 1_000),
        0,
        BREAKOUT_WIDTH,
      );
    }
    return this.keyTargetX;
  }

  private renderGameOver(context: PixelDrawContext): void {
    const elapsed = this.elapsedMs - this.gameOverAtMs;
    context.fillStyle = "#000000";
    context.fillRect(0, 0, BREAKOUT_WIDTH, BREAKOUT_HEIGHT);
    const pulse = Math.floor(elapsed / 250) % 2 === 0;
    drawCenteredLabel(context, "GAME OVER", 1, pulse ? "#ff4d5a" : "#ff8a2a");
    drawCenteredLabel(context, `S ${this.game.score}`, 9, "#c1ff3d");
    context.fillStyle = "#284b2c";
    context.fillRect(0, 15, BREAKOUT_WIDTH, 1);
    context.fillStyle = "#c1ff3d";
    context.fillRect(
      0,
      15,
      Math.round(BREAKOUT_WIDTH * Math.min(1, elapsed / BREAKOUT_GAME_OVER_MS)),
      1,
    );
  }
}
