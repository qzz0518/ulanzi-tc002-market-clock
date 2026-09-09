import { describe, expect, test } from "bun:test";
import {
  emptyInput,
  GAME_SCREEN_WIDTH,
  type GameInput,
  type PixelDrawContext,
} from "../web/src/lib/games/engine.ts";
import {
  createShooterGame,
  SHOOTER_ENEMY_BASE_SPEED,
  SHOOTER_ENEMY_MAX_SPEED,
  SHOOTER_ENEMY_SPEED_STEP,
  SHOOTER_KILL_SCORE,
  SHOOTER_KILLS_PER_STEP,
  SHOOTER_MAX_BULLETS,
  SHOOTER_START_LIVES,
  SHOOTER_START_SHIP_TOP,
  SHOOTER_STEP_MS,
  SHOOTER_WAVE_BASE_MS,
  SHOOTER_WAVE_FACTOR,
  SHOOTER_WAVE_FLOOR_MS,
  ShooterGame,
} from "../web/src/lib/games/shooter.ts";

class Recorder implements PixelDrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  readonly pixels = new Map<number, string>();

  clearRect(): void {
    this.pixels.clear();
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    for (let py = y; py < y + height; py += 1) {
      for (let px = x; px < x + width; px += 1) {
        // The engine paints the backdrop black, which on the panel is "off".
        if (String(this.fillStyle) === "#000000") this.pixels.delete(py * GAME_SCREEN_WIDTH + px);
        else this.pixels.set(py * GAME_SCREEN_WIDTH + px, String(this.fillStyle));
      }
    }
  }

  at(x: number, y: number): string | undefined {
    return this.pixels.get(y * GAME_SCREEN_WIDTH + x);
  }

  countOf(color: string): number {
    return [...this.pixels.values()].filter((value) => value === color).length;
  }

  rowOf(color: string, y: number): number[] {
    return [...this.pixels.entries()]
      .filter(([key, value]) => value === color && Math.floor(key / GAME_SCREEN_WIDTH) === y)
      .map(([key]) => key % GAME_SCREEN_WIDTH)
      .sort((a, b) => a - b);
  }
}

function input(patch: Partial<GameInput> = {}): GameInput {
  return { ...emptyInput(), ...patch };
}

const press = (): GameInput => input({ pressed: true, pressedEdge: true });
/** Middle held down with no new edge — the autofire case. */
const holdFire = (): GameInput => input({ pressed: true });
const steer = (direction: "up" | "down" | "left" | "right"): GameInput => input({ direction });

function paint(game: ShooterGame): Recorder {
  const recorder = new Recorder();
  game.render(recorder);
  return recorder;
}

/** Starts a run and leaves the ship parked at its opening row. */
function playing(seed: number): ShooterGame {
  const game = createShooterGame({ seed });
  game.tick(30, press());
  return game;
}

describe("shooter engine", () => {
  test("opens on the attract screen with a star field and the bobbing ship", () => {
    const game = createShooterGame({ seed: 5 });

    expect(game.meta.id).toBe("shooter");
    expect(game.phase).toBe("ready");
    expect(game.shipY).toBe(SHOOTER_START_SHIP_TOP);
    expect(game.enemies).toEqual([]);
    expect(game.hud()).toMatchObject({
      score: 0,
      lives: SHOOTER_START_LIVES,
      level: 1,
      phase: "ready",
    });

    const recorder = paint(game);
    // Ten fixed stars, two of which twinkle white on the even blink.
    expect(recorder.at(9, 2)).toBe("#2e3a46");
    expect(recorder.at(30, 4)).toBe("#ffffff");
    // Ship spine plus the engine flame in the left column.
    expect(recorder.at(6, 7)).toBe("#d6f4ff");
    expect(recorder.at(2, 7)).toBe("#ff8a2a");
  });

  test("a direction alone never leaves the attract screen — only the fire button does", () => {
    const game = createShooterGame({ seed: 5 });
    game.tick(30, steer("down"));
    expect(game.phase).toBe("ready");
    // The knob is dead on the attract screen, so the ship stays put.
    expect(game.shipY).toBe(SHOOTER_START_SHIP_TOP);

    game.tick(30, press());
    expect(game.phase).toBe("playing");
    expect(game.hud().message).toContain("击落");
  });

  test("a fresh direction is one knob detent, doubled inside the 150ms window", () => {
    const game = playing(5);
    expect(game.shipY).toBe(SHOOTER_START_SHIP_TOP);

    game.tick(0, steer("down"));
    expect(game.shipY).toBe(8);
    // Releasing and re-pressing inside the accel window is the x2 detent.
    game.tick(0, input());
    game.tick(0, steer("down"));
    expect(game.shipY).toBe(12);

    // Same detents on the device trace: 6 -> 8 -> 12.
    game.tick(100, steer("down"));
    expect(game.shipY).toBe(13); // clamped to GAME_SCREEN_HEIGHT - ship height
  });

  test("a held direction glides at 24 px/s and left/right read as the clock's side buttons", () => {
    const game = playing(5);
    game.tick(0, steer("up")); // detent: 6 -> 4
    expect(game.shipY).toBe(4);
    game.tick(100, steer("up")); // held: -24 px/s * 0.1s
    expect(game.shipY).toBeCloseTo(1.6, 8);

    const sideButtons = playing(5);
    sideButtons.tick(0, steer("right")); // Right button = down
    expect(sideButtons.shipY).toBe(8);
    sideButtons.tick(0, input());
    sideButtons.tick(200, steer("left")); // Left button = up
    expect(sideButtons.shipY).toBeCloseTo(8 - 2 - 24 * 0.2, 8);
  });

  test("holding fire autofires on the 140ms cooldown up to the four bullet cap", () => {
    const game = playing(5);
    const counts: number[] = [];
    game.tick(30, press());
    counts.push(game.bullets.length);
    for (let t = 30; t < 600; t += 30) {
      game.tick(30, holdFire());
      counts.push(game.bullets.length);
    }
    // Verbatim from the C++ selfcheck trace at 30ms ticks.
    expect(counts).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4]);
    expect(game.bullets.length).toBe(SHOOTER_MAX_BULLETS);
    // Shots leave the nose row (ship top + 1) just past the hull.
    expect(game.bullets[0]!.y).toBe(SHOOTER_START_SHIP_TOP + 1);

    // Releasing stops the autofire even though the cooldown keeps draining.
    game.tick(300, input());
    expect(game.bullets.length).toBeLessThanOrEqual(SHOOTER_MAX_BULLETS);
  });

  test("a shot that overlaps an enemy kills it, scores ten and blooms a spark", () => {
    const game = playing(5);
    game.bullets = [{ x: 8, y: 7 }];
    game.enemies = [{ x: 10, y: 6 }]; // rows 6..8 cover the bullet row

    game.tick(SHOOTER_STEP_MS, input());
    expect(game.score).toBe(SHOOTER_KILL_SCORE);
    expect(game.kills).toBe(1);
    expect(game.bullets).toEqual([]);
    expect(game.enemies).toEqual([]);
    expect(game.booms.length).toBe(1);
    // Spark centre = enemy centre, drawn as a single core pixel on frame 0.
    expect(game.booms[0]!.y).toBe(7);
    expect(paint(game).at(12, 7)).toBe("#ffffff");

    // A shot passing above the hull misses.
    const miss = playing(5);
    miss.bullets = [{ x: 8, y: 4 }];
    miss.enemies = [{ x: 10, y: 6 }];
    miss.tick(SHOOTER_STEP_MS, input());
    expect(miss.score).toBe(0);
    expect(miss.enemies.length).toBe(1);
  });

  test("enemies that slip past the left edge cost lives and end the run at zero", () => {
    const game = playing(5);
    game.enemies = [{ x: -4, y: 5 }];
    game.tick(SHOOTER_STEP_MS, input());
    expect(game.lives).toBe(SHOOTER_START_LIVES - 1);
    expect(game.enemies).toEqual([]);
    expect(game.phase).toBe("playing");

    // Three leaking in one step drains the rest and settles the run.
    game.enemies = [{ x: -4, y: 0 }, { x: -4, y: 6 }, { x: -4, y: 12 }];
    game.tick(SHOOTER_STEP_MS, input());
    expect(game.lives).toBe(0);
    expect(game.phase).toBe("game-over");
    expect(game.hud().message).toContain("防线失守");
  });

  test("replays the device's wave layout for a pinned seed", () => {
    // Every number below is the C++ ShooterEngine trace for seedRandom(5),
    // ticked at the firmware's 30ms UI period — the two engines must not drift.
    const game = playing(5);
    for (let t = 0; t < 1_800; t += 30) game.tick(30, input());
    expect(game.enemies.length).toBe(1);
    expect(game.enemies[0]!.y).toBe(1);
    expect(game.enemies[0]!.x).toBeCloseTo(46.083_333, 5);

    for (let t = 1_800; t < 3_000; t += 30) game.tick(30, input());
    expect(game.enemies.map((foe) => foe.y)).toEqual([1, 11, 4]);
    expect(game.enemies.map((foe) => Number(foe.x.toFixed(4)))).toEqual([34.0833, 46.0833, 46.0833]);

    // Unopposed, the leaks drain all three lives and reach the settlement.
    for (let t = 3_000; t < 7_200; t += 30) game.tick(30, input());
    expect(game.lives).toBe(2);
    let elapsed = 7_200;
    while (game.phase !== "game-over" && elapsed < 30_000) {
      game.tick(30, input());
      elapsed += 30;
    }
    expect(game.phase).toBe("game-over");
    expect(game.hud()).toMatchObject({ score: 0, lives: 0, phase: "game-over" });
  });

  test("the same seed replays identically, a different one does not", () => {
    const run = (seed: number): string => {
      const game = playing(seed);
      for (let t = 0; t < 4_000; t += 30) game.tick(30, input());
      return JSON.stringify(game.enemies.map((foe) => [foe.y, foe.x.toFixed(4)]));
    };
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(77));
  });

  test("difficulty steps every ten kills and stops at the speed cap and wave floor", () => {
    const game = createShooterGame({ seed: 5 });
    expect(game.level()).toBe(1);
    expect(game.enemySpeed()).toBe(SHOOTER_ENEMY_BASE_SPEED);
    expect(game.waveIntervalMs()).toBe(SHOOTER_WAVE_BASE_MS);

    game.kills = SHOOTER_KILLS_PER_STEP;
    expect(game.level()).toBe(2);
    expect(game.enemySpeed()).toBeCloseTo(SHOOTER_ENEMY_BASE_SPEED * SHOOTER_ENEMY_SPEED_STEP, 8);
    expect(game.waveIntervalMs()).toBeCloseTo(SHOOTER_WAVE_BASE_MS * SHOOTER_WAVE_FACTOR, 8);

    game.kills = SHOOTER_KILLS_PER_STEP * 40;
    expect(game.enemySpeed()).toBe(SHOOTER_ENEMY_MAX_SPEED);
    expect(game.waveIntervalMs()).toBe(SHOOTER_WAVE_FLOOR_MS);
  });

  test("settles on an OVER screen and locks the replay press for 600ms", () => {
    const game = playing(5);
    game.score = 40;
    game.kills = 4;
    game.enemies = [{ x: -4, y: 0 }, { x: -4, y: 6 }, { x: -4, y: 12 }];
    game.tick(SHOOTER_STEP_MS, input());
    expect(game.phase).toBe("game-over");

    // Headline in the ice-blue tier, the "<score> K<kills>" line below it, and
    // no restart prompt until the lock expires.
    const settled = paint(game);
    expect(settled.countOf("#55b7e8")).toBeGreaterThan(0);
    expect(settled.countOf("#ffffff")).toBeGreaterThan(0);
    expect(settled.rowOf("#c1ff3d", 15)).toEqual([]);

    game.tick(250, press());
    expect(game.phase).toBe("game-over"); // inside the lockout

    game.tick(250, input());
    game.tick(250, input());
    // Past the lockout the restart prompt blinks on every other 420ms window.
    const dashFrames: number[] = [];
    for (let sample = 0; sample < 12; sample += 1) {
      game.tick(100, input());
      dashFrames.push(paint(game).rowOf("#c1ff3d", 15).length);
    }
    expect(dashFrames).toContain(GAME_SCREEN_WIDTH / 2);
    expect(dashFrames).toContain(0);

    game.tick(0, press());
    expect(game.phase).toBe("ready");
    expect(game.hud()).toMatchObject({ score: 0, lives: SHOOTER_START_LIVES, phase: "ready" });
  });

  test("restart() drops straight back to the attract screen", () => {
    const game = playing(5);
    game.score = 120;
    game.kills = 12;
    game.bullets = [{ x: 20, y: 7 }];
    game.enemies = [{ x: 30, y: 2 }];

    game.restart();
    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.kills).toBe(0);
    expect(game.lives).toBe(SHOOTER_START_LIVES);
    expect(game.shipY).toBe(SHOOTER_START_SHIP_TOP);
    expect(game.bullets).toEqual([]);
    expect(game.enemies).toEqual([]);
    expect(game.level()).toBe(1);
  });
});
