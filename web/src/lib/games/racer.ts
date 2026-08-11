// Lane racer for the 52x16 LED panel.
// This one was written for the firmware first: a line-for-line port of
// device/tc002-arcade/app/src/games/racer.{h,cpp} (same constants, same fixed
// step, same PRNG) so the console panel and the device can later be driven in
// lockstep off one input stream.
// DOM-free and deterministic — pass `seed` to pin the traffic exactly the way
// RacerEngine::seedRandom() pins it on the device.

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

export const RACER_STEP_MS = 1_000 / 120;
/** Left edge of the 4x3 player car; it never moves horizontally. */
export const RACER_PLAYER_X = 4;
export const RACER_CAR_WIDTH = 4;
export const RACER_CAR_HEIGHT = 3;
/** px/s at 0 dodged cars. */
export const RACER_BASE_SPEED = 14;
export const RACER_MAX_SPEED = 34;
export const RACER_SPEED_STEP = 1.08;
export const RACER_DODGE_PER_STEP = 10;
export const RACER_DODGE_SCORE = 10;
/** Wave interval at base speed: 0.9..1.6s, scaled down as the traffic speeds up. */
export const RACER_SPAWN_MIN_MS = 900;
export const RACER_SPAWN_RANGE_MS = 700;
/** Four lanes, 4px apart; a 3px car centred in one can only ever overlap its own. */
export const RACER_LANE_CENTERS = [2, 6, 10, 14] as const;
export const RACER_LANE_COUNT = RACER_LANE_CENTERS.length;

const LANE_DIVIDER_Y = [4, 8, 12] as const;
const RESTART_LOCK_MS = 600;
/** Impact flash: 2 frames at the device's 30ms shell tick. */
const CRASH_FLASH_MS = 60;
/** arcadegames::GameRandom's state before seed() is called. */
const DEFAULT_SEED = 0x9e_37_79_b9;

// Full-screen fill: on the LED panel a dark grey road lights every pixel, so keep it truly off.
const BG = "#000000";
const PLAYER_BODY = "#c1ff3d";
const PLAYER_WINDOW = "#ffffff";
const CRASH_WHITE = "#ffffff";
// Secondary-tier traffic tints, one picked per car.
const CAR_COLORS = ["#ff4d5a", "#ff8a2a", "#b66cff"] as const;
// Dark tier: road texture and exhaust are never information.
const LANE_DOT = "#2e3a46";
const EXHAUST = "#73401e";
const OVER_TITLE = "#ff4d5a";
const SCORE = "#ffffff";
const PROMPT = "#c1ff3d";

export interface RacerCar {
  /** Left edge; floats so the scroll stays smooth. */
  x: number;
  /** 0..3, top lane first. */
  lane: number;
  /** 0..2 into the traffic palette. */
  colorIndex: number;
  scored: boolean;
}

export interface RacerOptions {
  /**
   * Traffic seed. Mirrors RacerEngine::seedRandom(): the same seed replays the
   * same waves on the console and on the device, because the PRNG below is a
   * bit-for-bit port of arcadegames::GameRandom.
   */
  seed?: number;
  /** Raw [0,1) source, as in the other engines' tests; takes over from `seed`. */
  random?: () => number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * xorshift32 mapped to [0,1) — the port of arcadegames::GameRandom (support.h).
 * `>>> 0` after every shift keeps the state an unsigned 32-bit word, which is
 * what the C++ uint32_t arithmetic does implicitly.
 */
class GameRandom {
  private state = DEFAULT_SEED;

  constructor(seed: number) {
    this.seed(seed);
  }

  seed(value: number): void {
    const next = value >>> 0;
    this.state = next === 0 ? 1 : next;
  }

  next(): number {
    let x = this.state;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.state = x;
    return (x >>> 8) * (1 / 16_777_216);
  }
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

/**
 * The device paints through Surface::setPixel, which silently drops
 * out-of-bounds writes; a car leaving the screen is drawn from x = -5. Clip
 * here so the mirrored frame buffer never receives a negative column.
 */
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

function setPixel(ctx: PixelDrawContext, x: number, y: number, color: string): void {
  if (x < 0 || x >= GAME_SCREEN_WIDTH || y < 0 || y >= GAME_SCREEN_HEIGHT) return;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

export class RacerGame implements GameEngine {
  readonly meta = {
    id: "racer",
    title: "像素赛车",
    hint: "空格开始，↑ ↓ 或 ← → 换车道，每躲开一辆车加 10 分",
  } as const;

  score = 0;
  /** Cars already passed; drives both the score and the speed tier. */
  dodged = 0;
  phase: GamePhase = "ready";
  /** 0..3, starts on lane index 1 (lane 2 of 4). */
  lane = 1;
  cars: RacerCar[] = [];
  /** Total scrolled distance, used for the lane-divider parallax. */
  scrolled = 0;

  private spawnInMs = 0;
  /** Left edge and lane of the car that was hit, for the impact flash. */
  private crashX = 0;
  private crashLane = 0;
  private accumulatorMs = 0;
  private elapsedMs = 0;
  private overMs = 0;
  /**
   * Last sampled direction. The device engine changes lane on the *down edge*
   * of Left/Right and on each knob detent, and never integrates how long a
   * button is held; the shell hands us a level instead, so an edge is a change
   * in that level. A press shorter than one frame is missed — the price of a
   * sampled input, and the only place the two input models can disagree.
   */
  private lastDirection: GameInput["direction"] = null;
  private readonly rng: GameRandom;
  private readonly random: () => number;

  constructor(options: RacerOptions = {}) {
    this.rng = new GameRandom(options.seed ?? DEFAULT_SEED);
    this.random = options.random ?? (() => this.rng.next());
    this.reset();
  }

  tick(dtMs: number, input: GameInput): void {
    const dt = clamp(dtMs, 0, 250);
    this.elapsedMs += dt;
    // Sampled before the phase switches, so a direction already held while the
    // run starts stays inert until it is pressed again — as on the device.
    this.steer(input.direction);
    const confirm = input.pressedEdge;

    if (this.phase === "ready") {
      this.scrolled += RACER_BASE_SPEED * (dt / 1_000); // road idles under the car
      if (confirm) this.phase = "playing";
      return;
    }
    if (this.phase === "game-over") {
      this.overMs += dt;
      if (confirm && this.overMs >= RESTART_LOCK_MS) this.reset();
      return;
    }

    this.accumulatorMs += dt;
    while (this.accumulatorMs >= RACER_STEP_MS && this.phase === "playing") {
      this.accumulatorMs -= RACER_STEP_MS;
      this.step(RACER_STEP_MS / 1_000);
    }
  }

  restart(): void {
    this.reset();
  }

  hud(): GameHud {
    // No `lives`: the device reports lives = -1, its "no lives concept" value.
    return {
      score: this.score,
      level: this.level(),
      phase: this.phase,
      message: this.phase === "ready"
        ? "按空格或点击开始"
        : this.phase === "playing"
        ? `第 ${this.level()} 档车速`
        : `撞车了，得分 ${this.score}，再按一次重开`,
    };
  }

  /** Traffic speed in px/s — +8% per 10 dodged cars, capped so lanes stay readable. */
  speed(): number {
    return Math.min(
      RACER_MAX_SPEED,
      RACER_BASE_SPEED * RACER_SPEED_STEP ** Math.floor(this.dodged / RACER_DODGE_PER_STEP),
    );
  }

  /** HUD-only speed tier; the device HUD has no level field, but this is its exponent. */
  level(): number {
    return Math.floor(this.dodged / RACER_DODGE_PER_STEP) + 1;
  }

  /** Re-pins the traffic mid-session; mirrors RacerEngine::seedRandom(). */
  seedRandom(seed: number): void {
    this.rng.seed(seed);
  }

  render(ctx: PixelDrawContext): void {
    // The device is handed a cleared surface by its shell; the canvas is not.
    ctx.clearRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);

    if (this.phase === "game-over") {
      if (this.overMs < CRASH_FLASH_MS) { // impact: 2 white frames
        this.renderRoad(ctx);
        this.renderCars(ctx, true);
        this.renderPlayer(ctx, true);
        return;
      }
      this.renderGameOver(ctx);
      return;
    }

    this.renderRoad(ctx);
    this.renderCars(ctx, false);
    this.renderPlayer(ctx, false);

    if (this.phase === "ready") {
      // Idle exhaust puff behind the car (texture blink).
      if (this.blink(300)) setPixel(ctx, RACER_PLAYER_X - 1, RACER_LANE_CENTERS[this.lane]!, EXHAUST);
      if (this.blink(500)) drawCenteredText(ctx, "RACER", 5, PROMPT);
    }
  }

  private reset(): void {
    this.score = 0;
    this.dodged = 0;
    this.phase = "ready";
    this.lane = 1; // lane 2 of 4, centre y=6
    this.cars = [];
    this.crashX = 0;
    this.crashLane = 0;
    this.scrolled = 0;
    this.accumulatorMs = 0;
    this.elapsedMs = 0;
    this.overMs = 0;
    this.lastDirection = null;
    // Note the PRNG is deliberately *not* reseeded here, matching resetState().
    this.scheduleWave();
  }

  /**
   * Input map, discrete device events → the shell's sampled level:
   *   knob ccw / Left button  → lane -1 (up)    ← direction "up" or "left"
   *   knob cw  / Right button → lane +1 (down)  ← direction "down" or "right"
   *   knob press / Middle     → confirm         ← pressedEdge
   * Left/Right keep the device's button orientation (Left = up the lanes) so the
   * arrow pairs steer identically whichever axis the player reaches for.
   */
  private steer(direction: GameInput["direction"]): void {
    const changed = direction !== this.lastDirection;
    this.lastDirection = direction;
    if (!changed || direction === null || this.phase !== "playing") return;
    this.changeLane(direction === "up" || direction === "left" ? -1 : 1);
  }

  private changeLane(delta: number): void {
    this.lane = clamp(this.lane + delta, 0, RACER_LANE_COUNT - 1);
  }

  private scheduleWave(): void {
    // Constant pixel gap between waves; the time interval shrinks as the
    // traffic speeds up (0.9..1.6s at 14 px/s).
    this.spawnInMs = (RACER_SPAWN_MIN_MS + this.random() * RACER_SPAWN_RANGE_MS)
      * (RACER_BASE_SPEED / this.speed());
  }

  private spawnWave(): void {
    // One random lane, or two adjacent lanes; a wave never blocks more than
    // two of the four lanes, so a free lane always exists.
    const pair = this.pick(2) === 1;
    const first = pair ? this.pick(RACER_LANE_COUNT - 1) : this.pick(RACER_LANE_COUNT);
    const lanes = pair ? [first, first + 1] : [first];
    for (const lane of lanes) {
      this.cars.push({
        x: GAME_SCREEN_WIDTH,
        lane,
        colorIndex: this.pick(CAR_COLORS.length),
        scored: false,
      });
    }
  }

  private step(dtSeconds: number): void {
    const distance = this.speed() * dtSeconds;
    this.scrolled += distance;

    for (const car of this.cars) {
      car.x -= distance;
      // Scored the moment the car's tail clears the player's front bumper.
      if (!car.scored && car.x + RACER_CAR_WIDTH <= RACER_PLAYER_X) {
        car.scored = true;
        this.score += RACER_DODGE_SCORE;
        this.dodged += 1;
      }
    }
    this.cars = this.cars.filter((car) => car.x + RACER_CAR_WIDTH > -1);

    this.spawnInMs -= dtSeconds * 1_000;
    if (this.spawnInMs <= 0) {
      this.spawnWave();
      this.scheduleWave();
    }

    // AABB against the player: lanes are 4px apart and cars 3px tall, so a
    // y overlap is exactly a same-lane overlap.
    for (const car of this.cars) {
      if (car.lane !== this.lane) continue;
      if (car.x < RACER_PLAYER_X + RACER_CAR_WIDTH && RACER_PLAYER_X < car.x + RACER_CAR_WIDTH) {
        this.crashX = car.x;
        this.crashLane = car.lane;
        this.phase = "game-over";
        this.overMs = 0;
        this.accumulatorMs = 0;
        return;
      }
    }
  }

  /** Uniform integer in [0, bound) — mirrors GameRandom::pick(). */
  private pick(bound: number): number {
    if (bound <= 0) return 0;
    return Math.min(bound - 1, Math.floor(clamp(this.random(), 0, 0.999_999) * bound));
  }

  private blink(periodMs: number): boolean {
    return Math.floor(this.elapsedMs / periodMs) % 2 === 0;
  }

  private renderRoad(ctx: PixelDrawContext): void {
    // Sparse dashed lane dividers, scrolling with the traffic. Dark tier by
    // design: road texture only, never information.
    const offset = Math.floor(this.scrolled) % 6;
    for (const y of LANE_DIVIDER_Y) {
      for (let x = 0; x < GAME_SCREEN_WIDTH; x += 1) {
        if ((x + offset) % 6 < 2) setPixel(ctx, x, y, LANE_DOT);
      }
    }
  }

  private renderPlayer(ctx: PixelDrawContext, white: boolean): void {
    const cy = RACER_LANE_CENTERS[this.lane]!;
    fillRect(
      ctx,
      RACER_PLAYER_X,
      cy - 1,
      RACER_CAR_WIDTH,
      RACER_CAR_HEIGHT,
      white ? CRASH_WHITE : PLAYER_BODY,
    );
    if (white) return;
    setPixel(ctx, RACER_PLAYER_X + 1, cy, PLAYER_WINDOW); // cabin
    setPixel(ctx, RACER_PLAYER_X + 2, cy, PLAYER_WINDOW);
  }

  private renderCars(ctx: PixelDrawContext, white: boolean): void {
    for (const car of this.cars) {
      const left = Math.round(car.x);
      const flash = white && car.lane === this.crashLane && Math.abs(car.x - this.crashX) < 0.5;
      fillRect(
        ctx,
        left,
        RACER_LANE_CENTERS[car.lane]! - 1,
        RACER_CAR_WIDTH,
        RACER_CAR_HEIGHT,
        flash ? CRASH_WHITE : CAR_COLORS[car.colorIndex]!,
      );
    }
  }

  private renderGameOver(ctx: PixelDrawContext): void {
    drawCenteredText(ctx, "OVER", 1, OVER_TITLE);
    drawCenteredText(ctx, String(this.score), 9, SCORE);
    if (this.overMs < RESTART_LOCK_MS || !this.blink(420)) return;
    ctx.fillStyle = PROMPT;
    for (let x = 0; x < GAME_SCREEN_WIDTH; x += 2) ctx.fillRect(x, GAME_SCREEN_HEIGHT - 1, 1, 1);
  }
}

export function createRacerGame(options: RacerOptions = {}): RacerGame {
  return new RacerGame(options);
}
