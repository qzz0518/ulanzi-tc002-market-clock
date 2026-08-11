// Side-scrolling space shooter for the 52x16 LED panel.
// Port of device/tc002-arcade/app/src/games/shooter.{h,cpp} — this one was
// written for the firmware's knob first, so the C++ is the source of truth and
// every constant, the 120 Hz inner step, the wave PRNG and the palette are
// copied verbatim. The console mirrors the device panel and the two are meant
// to be driven in lockstep, so a divergence here shows up as two different
// pictures on the same frame.
// DOM-free and deterministic — pin `seed` to reproduce a wave layout in tests.

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

export const SHOOTER_STEP_MS = 1_000 / 120;
/** Left edge of the 5x3 sprite; column 2 is the engine flame. */
export const SHOOTER_SHIP_X = 2;
export const SHOOTER_SHIP_WIDTH = 5;
export const SHOOTER_SHIP_HEIGHT = 3;
export const SHOOTER_START_SHIP_TOP = 6;
/** px/s while a direction is held. */
export const SHOOTER_KEY_SHIP_SPEED = 24;
/** One knob detent, doubled when the next detent lands inside the accel window. */
export const SHOOTER_KNOB_STEP_PX = 2;
export const SHOOTER_KNOB_FAST_STEP_PX = 4;
export const SHOOTER_KNOB_ACCEL_WINDOW_MS = 150;
export const SHOOTER_FIRE_COOLDOWN_MS = 140;
export const SHOOTER_BULLET_WIDTH = 3;
/** px/s rightward. */
export const SHOOTER_BULLET_SPEED = 34;
export const SHOOTER_MAX_BULLETS = 4;
export const SHOOTER_ENEMY_WIDTH = 4;
export const SHOOTER_ENEMY_HEIGHT = 3;
/** px/s at 0 kills. */
export const SHOOTER_ENEMY_BASE_SPEED = 10;
export const SHOOTER_ENEMY_MAX_SPEED = 26;
export const SHOOTER_ENEMY_SPEED_STEP = 1.07;
export const SHOOTER_KILLS_PER_STEP = 10;
export const SHOOTER_KILL_SCORE = 10;
export const SHOOTER_WAVE_BASE_MS = 1_200;
export const SHOOTER_WAVE_FACTOR = 0.95;
export const SHOOTER_WAVE_FLOOR_MS = 500;
export const SHOOTER_START_LIVES = 3;
/** 3 frames -> a 120ms spark. */
export const SHOOTER_BOOM_FRAME_MS = 40;
/**
 * The device seeds from `time(0) ^ 0x5107733B`; the console has no clock it is
 * allowed to read, so it starts from GameRandom's own default state. Pass a
 * seed (or call `seedRandom`) to line both sides up on the same waves.
 */
export const SHOOTER_DEFAULT_SEED = 0x9e37_79b9;

const RESTART_LOCK_MS = 600;

// Full-screen fill: on the LED panel a dark grey background lights every pixel, so keep it truly off.
const BG = "#000000";
/** Primary tier: bright ice-blue hull. */
const HULL = "#d6f4ff";
/** Secondary tier: engine flame, 2-frame blink. */
const FLAME_A = "#ff8a2a";
const FLAME_B = "#ffd43b";
const BULLET = "#ffffff";
const ENEMY_BODY = "#ff4d5a";
/** Dark tier: cockpit texture dot. */
const ENEMY_CORE = "#7b2930";
const BOOM_CORE = "#ffffff";
const BOOM_MID = "#ff8a2a";
const BOOM_END = "#b33a43";
/** Dark tier: attract backdrop texture. */
const STAR_DIM = "#2e3a46";
const STAR_BRIGHT = "#ffffff";
const OVER_TITLE = "#55b7e8";
const SCORE = "#ffffff";
const PROMPT = "#c1ff3d";

const STARS: readonly (readonly [number, number])[] = [
  [9, 2], [20, 12], [30, 4], [44, 9], [15, 8],
  [38, 14], [48, 3], [25, 1], [6, 13], [41, 6],
];

export interface ShooterBullet {
  /** Left edge of the 3x1 shot. */
  x: number;
  y: number;
}

export interface ShooterEnemy {
  /** Left edge of the 4x3 hull. */
  x: number;
  /** Top edge. */
  y: number;
}

export interface ShooterBoom {
  /** Centre. */
  x: number;
  y: number;
  ageMs: number;
}

export interface ShooterOptions {
  /** Wave PRNG seed; identical seeds give identical waves on device and here. */
  seed?: number;
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

/** Mirrors the device `Surface::setPixel`, which silently drops out-of-bounds writes. */
function setPixel(ctx: PixelDrawContext, x: number, y: number, color: string): void {
  if (x < 0 || x >= GAME_SCREEN_WIDTH || y < 0 || y >= GAME_SCREEN_HEIGHT) return;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

/** Mirrors `arcadegames::fillRect`, i.e. a rect of clipped setPixel writes. */
function fillRect(
  ctx: PixelDrawContext,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(GAME_SCREEN_WIDTH, x + width);
  const bottom = Math.min(GAME_SCREEN_HEIGHT, y + height);
  if (right <= left || bottom <= top) return;
  ctx.fillStyle = color;
  ctx.fillRect(left, top, right - left, bottom - top);
}

/**
 * xorshift32 in [0,1) — a byte-for-byte port of `arcadegames::GameRandom`, so a
 * seed replays the same waves on the firmware and in the console.
 */
class ShooterRandom {
  private state = SHOOTER_DEFAULT_SEED;

  seed(value: number): void {
    // The C++ maps seed 0 to 1 so the generator can never collapse to zero.
    this.state = (value >>> 0) || 1;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return (this.state >>> 8) * (1 / 16_777_216);
  }

  /** Uniform integer in [0, bound). */
  pick(bound: number): number {
    if (bound <= 0) return 0;
    return Math.min(bound - 1, Math.floor(clamp(this.next(), 0, 0.999_999) * bound));
  }
}

export class ShooterGame implements GameEngine {
  readonly meta = {
    id: "shooter",
    title: "太空射击",
    hint: "上下键移动飞船，空格开火，别让敌机溜过左边",
  } as const;

  score = 0;
  lives = SHOOTER_START_LIVES;
  kills = 0;
  phase: GamePhase = "ready";
  /** Top edge of the 5x3 ship, 0..13. */
  shipY = SHOOTER_START_SHIP_TOP;
  bullets: ShooterBullet[] = [];
  enemies: ShooterEnemy[] = [];
  booms: ShooterBoom[] = [];

  private cooldownMs = 0;
  private spawnInMs = SHOOTER_WAVE_BASE_MS;
  private accumulatorMs = 0;
  private elapsedMs = 0;
  private overMs = 0;
  private fireHeld = false;
  private lastKnobDir = 0;
  private lastKnobAtMs = -1_000;
  private lastDirection: GameInput["direction"] = null;
  private readonly random = new ShooterRandom();

  constructor(options: ShooterOptions = {}) {
    if (options.seed !== undefined) this.random.seed(options.seed);
    this.reset();
  }

  /**
   * Input mapping — the device engine takes discrete knob/button events, the
   * console only has a pointer-shaped `GameInput`:
   *   Middle / KnobPress down  -> `pressedEdge` (confirm on ready/over, fire while playing)
   *   Middle / KnobPress up    -> `pressed` going false (stops autofire)
   *   Left button held (= up)  -> `direction` "up" or "left" held
   *   Right button held (= down) -> `direction` "down" or "right" held
   *   one knob detent          -> a *fresh* direction (the tick where `direction`
   *                               changes), including the 150ms x2 accel window
   * The device separates a knob nudge from a held button; a keyboard has one
   * axis, so a tap reads as a detent and keeping the key down additionally
   * glides at 24 px/s. Left/right are accepted as up/down because that is what
   * the physical Left/Right buttons mean on the clock — a relayed device event
   * therefore lands on the same code path.
   */
  tick(dtMs: number, input: GameInput): void {
    const dt = clamp(dtMs, 0, 250);
    this.elapsedMs += dt;

    // The fire button only arms autofire while playing: a press that starts the
    // run must not keep shooting once it is held (device behaviour — the down
    // event is consumed as a confirm and no second edge ever arrives).
    let confirm = false;
    let fire = false;
    if (input.pressedEdge) {
      if (this.phase === "playing") {
        fire = true;
        this.fireHeld = true;
      } else {
        confirm = true;
      }
    }
    if (!input.pressed) this.fireHeld = false;

    const steer = directionSign(input.direction);
    const steerEdge = input.direction === this.lastDirection ? 0 : steer;
    this.lastDirection = input.direction;

    if (this.phase === "ready") {
      if (confirm) this.phase = "playing";
      return;
    }
    if (this.phase === "game-over") {
      this.overMs += dt;
      if (confirm && this.overMs >= RESTART_LOCK_MS) this.reset();
      return;
    }

    // Detent first, then the held glide — same order as the device, where
    // onInput lands before the tick that integrates the buttons.
    if (steerEdge !== 0) {
      const accelerated = steerEdge === this.lastKnobDir
        && this.elapsedMs - this.lastKnobAtMs <= SHOOTER_KNOB_ACCEL_WINDOW_MS;
      this.lastKnobDir = steerEdge;
      this.lastKnobAtMs = this.elapsedMs;
      this.shipY = clamp(
        this.shipY + steerEdge * (accelerated ? SHOOTER_KNOB_FAST_STEP_PX : SHOOTER_KNOB_STEP_PX),
        0,
        GAME_SCREEN_HEIGHT - SHOOTER_SHIP_HEIGHT,
      );
    }
    if (steer !== 0) {
      this.shipY = clamp(
        this.shipY + steer * SHOOTER_KEY_SHIP_SPEED * (dt / 1_000),
        0,
        GAME_SCREEN_HEIGHT - SHOOTER_SHIP_HEIGHT,
      );
    }

    // Fire: the edge shoots immediately, holding autofires at the cooldown rate.
    this.cooldownMs = Math.max(0, this.cooldownMs - dt);
    if (
      (fire || this.fireHeld) && this.cooldownMs <= 0
      && this.bullets.length < SHOOTER_MAX_BULLETS
    ) {
      this.bullets.push({
        x: SHOOTER_SHIP_X + SHOOTER_SHIP_WIDTH,
        y: clamp(Math.round(this.shipY) + 1, 0, GAME_SCREEN_HEIGHT - 1), // nose row
      });
      this.cooldownMs = SHOOTER_FIRE_COOLDOWN_MS;
    }

    // Explosion sparks age out on wall time, not on the fixed step.
    for (const boom of this.booms) boom.ageMs += dt;
    this.booms = this.booms.filter((boom) => boom.ageMs < 3 * SHOOTER_BOOM_FRAME_MS);

    this.accumulatorMs += dt;
    while (this.accumulatorMs >= SHOOTER_STEP_MS && this.phase === "playing") {
      this.accumulatorMs -= SHOOTER_STEP_MS;
      this.step(SHOOTER_STEP_MS / 1_000);
    }
  }

  restart(): void {
    this.reset();
  }

  hud(): GameHud {
    return {
      score: this.score,
      lives: this.lives,
      level: this.level(),
      phase: this.phase,
      message: this.phase === "ready"
        ? "按空格开始，上下键移动飞船"
        : this.phase === "playing"
        ? `击落 ${this.kills} · 第 ${this.level()} 档速度`
        : `防线失守，得分 ${this.score}，再按一次重开`,
    };
  }

  /** Difficulty tier — enemies speed up and waves tighten every ten kills. */
  level(): number {
    return Math.floor(this.kills / SHOOTER_KILLS_PER_STEP) + 1;
  }

  /** px/s — +7% per ten kills, capped so the panel stays readable. */
  enemySpeed(): number {
    return Math.min(
      SHOOTER_ENEMY_MAX_SPEED,
      SHOOTER_ENEMY_BASE_SPEED * SHOOTER_ENEMY_SPEED_STEP ** (this.level() - 1),
    );
  }

  /** Gap between waves in ms — -5% per ten kills, floored at half a second. */
  waveIntervalMs(): number {
    return Math.max(
      SHOOTER_WAVE_FLOOR_MS,
      SHOOTER_WAVE_BASE_MS * SHOOTER_WAVE_FACTOR ** (this.level() - 1),
    );
  }

  /** Pins the wave sequence; the device exposes the same hook for its selfcheck. */
  seedRandom(seed: number): void {
    this.random.seed(seed);
  }

  render(ctx: PixelDrawContext): void {
    ctx.clearRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);

    if (this.phase === "game-over") {
      this.renderGameOver(ctx);
      return;
    }

    if (this.phase === "ready") {
      // Star backdrop (dark texture) with two brighter twinkles.
      STARS.forEach(([x, y], index) => {
        const twinkle = (index === 2 || index === 7) && this.blink(400);
        setPixel(ctx, x, y, twinkle ? STAR_BRIGHT : STAR_DIM);
      });
      const bob = Math.sin(this.elapsedMs / 300) * 1.5;
      this.renderShip(
        ctx,
        clamp(
          Math.round(SHOOTER_START_SHIP_TOP + bob),
          0,
          GAME_SCREEN_HEIGHT - SHOOTER_SHIP_HEIGHT,
        ),
      );
      if (this.blink(500)) drawCenteredText(ctx, "SHOOTER", 5, PROMPT);
      return;
    }

    for (const foe of this.enemies) {
      const left = Math.round(foe.x);
      fillRect(ctx, left, foe.y, SHOOTER_ENEMY_WIDTH, SHOOTER_ENEMY_HEIGHT, ENEMY_BODY);
      setPixel(ctx, left + 1, foe.y + 1, ENEMY_CORE);
    }
    for (const shot of this.bullets) {
      fillRect(ctx, Math.round(shot.x), shot.y, SHOOTER_BULLET_WIDTH, 1, BULLET);
    }
    this.renderBooms(ctx);
    this.renderShip(ctx, Math.round(this.shipY));
  }

  private reset(): void {
    // The wave PRNG deliberately keeps running across a restart, as on device:
    // resetState() never re-seeds, so a replay is not a rerun of the same waves.
    this.score = 0;
    this.lives = SHOOTER_START_LIVES;
    this.kills = 0;
    this.phase = "ready";
    this.shipY = SHOOTER_START_SHIP_TOP;
    this.bullets = [];
    this.enemies = [];
    this.booms = [];
    this.cooldownMs = 0;
    this.spawnInMs = SHOOTER_WAVE_BASE_MS;
    this.accumulatorMs = 0;
    this.elapsedMs = 0;
    this.overMs = 0;
    this.fireHeld = false;
    this.lastKnobDir = 0;
    this.lastKnobAtMs = -1_000;
    this.lastDirection = null;
  }

  private step(dtSeconds: number): void {
    for (const shot of this.bullets) shot.x += SHOOTER_BULLET_SPEED * dtSeconds;
    const speed = this.enemySpeed();
    for (const foe of this.enemies) foe.x -= speed * dtSeconds;

    // Bullet vs enemy: first overlap wins, both despawn, a spark blooms.
    const bulletDead = this.bullets.map(() => false);
    const enemyDead = this.enemies.map(() => false);
    this.bullets.forEach((shot, b) => {
      for (let e = 0; e < this.enemies.length; e += 1) {
        if (enemyDead[e]) continue;
        const foe = this.enemies[e]!;
        if (
          shot.x < foe.x + SHOOTER_ENEMY_WIDTH && foe.x < shot.x + SHOOTER_BULLET_WIDTH
          && shot.y >= foe.y && shot.y <= foe.y + SHOOTER_ENEMY_HEIGHT - 1
        ) {
          bulletDead[b] = true;
          enemyDead[e] = true;
          this.score += SHOOTER_KILL_SCORE;
          this.kills += 1;
          this.booms.push({ x: foe.x + SHOOTER_ENEMY_WIDTH / 2, y: foe.y + 1, ageMs: 0 });
          break;
        }
      }
    });

    this.bullets = this.bullets.filter(
      (shot, index) => !bulletDead[index] && shot.x < GAME_SCREEN_WIDTH,
    );
    this.enemies = this.enemies.filter((foe, index) => {
      if (enemyDead[index]) return false;
      if (foe.x + SHOOTER_ENEMY_WIDTH <= 0) { // escaped past the left edge
        this.lives -= 1;
        return false;
      }
      return true;
    });

    if (this.lives <= 0) {
      this.lives = 0;
      this.phase = "game-over";
      this.overMs = 0;
      this.accumulatorMs = 0;
      return;
    }

    this.spawnInMs -= dtSeconds * 1_000;
    if (this.spawnInMs <= 0) {
      this.spawnWave();
      this.spawnInMs = this.waveIntervalMs();
    }
  }

  private spawnWave(): void {
    const count = 1 + this.random.pick(2);
    const y1 = this.random.pick(GAME_SCREEN_HEIGHT - SHOOTER_ENEMY_HEIGHT + 1);
    this.enemies.push({ x: GAME_SCREEN_WIDTH, y: y1 });
    if (count !== 2) return;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const y2 = this.random.pick(GAME_SCREEN_HEIGHT - SHOOTER_ENEMY_HEIGHT + 1);
      if (y2 >= y1 - 2 && y2 <= y1 + 2) continue; // would overlap in y
      this.enemies.push({ x: GAME_SCREEN_WIDTH, y: y2 });
      break;
    }
  }

  private blink(periodMs: number): boolean {
    return Math.floor(this.elapsedMs / periodMs) % 2 === 0;
  }

  private renderShip(ctx: PixelDrawContext, top: number): void {
    // Hull: compact arrow pointing right; the leftmost column is the engine.
    fillRect(ctx, SHOOTER_SHIP_X + 1, top, 2, 1, HULL);
    fillRect(ctx, SHOOTER_SHIP_X + 1, top + 1, 4, 1, HULL); // spine, nose at x=6
    fillRect(ctx, SHOOTER_SHIP_X + 1, top + 2, 2, 1, HULL);
    setPixel(ctx, SHOOTER_SHIP_X, top + 1, this.blink(70) ? FLAME_A : FLAME_B);
  }

  private renderBooms(ctx: PixelDrawContext): void {
    for (const boom of this.booms) {
      const cx = Math.round(boom.x);
      const cy = boom.y;
      const frame = Math.floor(boom.ageMs / SHOOTER_BOOM_FRAME_MS);
      if (frame <= 0) {
        setPixel(ctx, cx, cy, BOOM_CORE);
      } else if (frame === 1) {
        setPixel(ctx, cx, cy, BOOM_CORE);
        setPixel(ctx, cx - 1, cy, BOOM_MID);
        setPixel(ctx, cx + 1, cy, BOOM_MID);
        setPixel(ctx, cx, cy - 1, BOOM_MID);
        setPixel(ctx, cx, cy + 1, BOOM_MID);
      } else {
        setPixel(ctx, cx - 1, cy - 1, BOOM_END);
        setPixel(ctx, cx + 1, cy - 1, BOOM_END);
        setPixel(ctx, cx - 1, cy + 1, BOOM_END);
        setPixel(ctx, cx + 1, cy + 1, BOOM_END);
      }
    }
  }

  private renderGameOver(ctx: PixelDrawContext): void {
    drawCenteredText(ctx, "OVER", 1, OVER_TITLE);
    drawCenteredText(ctx, `${this.score} K${this.kills}`, 9, SCORE);
    if (this.overMs < RESTART_LOCK_MS || !this.blink(420)) return;
    for (let x = 0; x < GAME_SCREEN_WIDTH; x += 2) {
      setPixel(ctx, x, GAME_SCREEN_HEIGHT - 1, PROMPT);
    }
  }
}

/** Left = up and Right = down, matching the clock's two side buttons. */
function directionSign(direction: GameInput["direction"]): number {
  if (direction === "down" || direction === "right") return 1;
  if (direction === "up" || direction === "left") return -1;
  return 0;
}

export function createShooterGame(options: ShooterOptions = {}): ShooterGame {
  return new ShooterGame(options);
}
