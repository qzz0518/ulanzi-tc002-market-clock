import { describe, expect, test } from "bun:test";
import {
  emptyInput,
  GAME_SCREEN_WIDTH,
  type GameInput,
  type PixelDrawContext,
} from "../web/src/lib/games/engine.ts";
import {
  RACER_BASE_SPEED,
  RACER_CAR_WIDTH,
  RACER_DODGE_PER_STEP,
  RACER_DODGE_SCORE,
  RACER_LANE_CENTERS,
  RACER_MAX_SPEED,
  RACER_PLAYER_X,
  RACER_SPEED_STEP,
  RACER_STEP_MS,
  RacerGame,
} from "../web/src/lib/games/racer.ts";
import { renderPixelText } from "../web/src/lib/pixel-font.ts";

class Recorder implements PixelDrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  readonly pixels = new Map<number, string>();

  clearRect(): void {
    this.pixels.clear();
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    for (let py = y; py < y + height; py += 1) {
      for (let px = x; px < x + width; px += 1) {
        this.pixels.set(py * GAME_SCREEN_WIDTH + px, String(this.fillStyle));
      }
    }
  }

  at(x: number, y: number): string | undefined {
    return this.pixels.get(y * GAME_SCREEN_WIDTH + x);
  }

  gridOf(color: string): string[] {
    const cells = [...this.pixels.entries()]
      .filter(([, value]) => value === color)
      .map(([key]) => [key % GAME_SCREEN_WIDTH, Math.floor(key / GAME_SCREEN_WIDTH)] as const);
    if (cells.length === 0) return [];
    const minX = Math.min(...cells.map(([x]) => x));
    const maxX = Math.max(...cells.map(([x]) => x));
    const minY = Math.min(...cells.map(([, y]) => y));
    const maxY = Math.max(...cells.map(([, y]) => y));
    const lit = new Set(cells.map(([x, y]) => y * GAME_SCREEN_WIDTH + x));
    return Array.from({ length: maxY - minY + 1 }, (_, row) =>
      Array.from({ length: maxX - minX + 1 }, (_, column) =>
        lit.has((minY + row) * GAME_SCREEN_WIDTH + minX + column) ? "#" : "."
      ).join(""));
  }
}

function glyphRows(text: string): string[] {
  const bitmap = renderPixelText(text, 5);
  return Array.from({ length: bitmap.height }, (_, y) =>
    Array.from({ length: bitmap.width }, (_, x) => bitmap.on[y * bitmap.width + x] ? "#" : ".").join(""));
}

const press = (): GameInput => ({ ...emptyInput(), pressedEdge: true });
const steer = (direction: "up" | "down" | "left" | "right"): GameInput => ({ ...emptyInput(), direction });

/** Starts a run and leaves the road empty so a test can place its own traffic. */
function playing(seed = 11): RacerGame {
  const game = new RacerGame({ seed });
  game.tick(0, press());
  game.cars = [];
  return game;
}

describe("racer engine", () => {
  test("opens on the attract screen with the car parked in lane 2", () => {
    const game = new RacerGame({ seed: 11 });

    expect(game.meta.id).toBe("racer");
    expect(game.phase).toBe("ready");
    expect(game.lane).toBe(1);
    expect(game.cars).toEqual([]);
    // The device HUD reports lives = -1 ("no lives concept"), which is no field here.
    expect(game.hud()).toMatchObject({ score: 0, level: 1, phase: "ready" });
    expect(game.hud().lives).toBeUndefined();

    const recorder = new Recorder();
    game.render(recorder);
    // 4x3 body at the fixed column, white cabin in the middle row.
    expect(recorder.at(RACER_PLAYER_X, 5)).toBe("#c1ff3d");
    expect(recorder.at(RACER_PLAYER_X + 3, 7)).toBe("#c1ff3d");
    expect(recorder.at(RACER_PLAYER_X + 1, 6)).toBe("#ffffff");
    expect(recorder.at(RACER_PLAYER_X + 2, 6)).toBe("#ffffff");
    // Dashed dividers between the four lanes, dark tier: 2 lit of every 6.
    expect(recorder.at(0, 4)).toBe("#2e3a46");
    expect(recorder.at(1, 4)).toBe("#2e3a46");
    expect(recorder.at(2, 8)).toBe("#000000");
    expect(recorder.at(6, 12)).toBe("#2e3a46");
  });

  test("idles on the attract screen until a press edge starts the run", () => {
    const game = new RacerGame({ seed: 11 });
    for (let elapsed = 0; elapsed < 500; elapsed += 30) game.tick(30, emptyInput());

    expect(game.phase).toBe("ready");
    expect(game.cars).toEqual([]);
    // The road still scrolls under the parked car, at base speed.
    expect(game.scrolled).toBeCloseTo(RACER_BASE_SPEED * (510 / 1_000), 8);

    game.tick(30, press());
    expect(game.phase).toBe("playing");
    expect(game.hud().message).toContain("档车速");
  });

  test("moves one lane per direction press and clamps at the outer lanes", () => {
    const game = playing();

    // Left/Right keep the device buttons' meaning: Left = up the lanes.
    game.tick(0, steer("down"));
    expect(game.lane).toBe(2);
    game.tick(0, steer("up"));
    expect(game.lane).toBe(1);
    game.tick(0, steer("left"));
    expect(game.lane).toBe(0);
    game.tick(0, steer("right"));
    expect(game.lane).toBe(1);

    // Holding is not integrated: the level has to change to count as a press.
    game.tick(0, steer("up"));
    game.tick(0, steer("up"));
    game.tick(0, steer("up"));
    expect(game.lane).toBe(0);
    game.tick(0, emptyInput());
    game.tick(0, steer("up"));
    expect(game.lane).toBe(0); // clamped at the top lane

    for (let hop = 0; hop < 6; hop += 1) {
      game.tick(0, emptyInput());
      game.tick(0, steer("down"));
    }
    expect(game.lane).toBe(RACER_LANE_CENTERS.length - 1);
  });

  test("ignores a direction held through the start, as the device ignores the stale edge", () => {
    const game = new RacerGame({ seed: 11 });
    game.tick(16, steer("down")); // pressed on the attract screen: no lane change
    expect(game.phase).toBe("ready");
    expect(game.lane).toBe(1);

    game.tick(16, { ...steer("down"), pressedEdge: true });
    expect(game.phase).toBe("playing");
    expect(game.lane).toBe(1); // still held, so still no edge

    game.tick(16, emptyInput());
    game.tick(16, steer("down"));
    expect(game.lane).toBe(2);
  });

  test("spawns waves of one lane or two adjacent ones, never blocking all four", () => {
    const game = new RacerGame({ seed: 21 });
    game.tick(0, press());

    // A wave can spawn on any of the ~3.6 inner steps a 30ms frame runs, so
    // identify fresh cars by object identity rather than by their spawn x.
    const waves = new Map<number, number[]>();
    const known = new Set<unknown>();
    for (let frame = 0; frame < 400 && game.phase === "playing"; frame += 1) {
      // Park on the lane the car started in; the point here is the layout.
      game.tick(30, emptyInput());
      for (const car of game.cars) {
        if (known.has(car)) continue;
        known.add(car);
        waves.set(frame, [...(waves.get(frame) ?? []), car.lane]);
      }
    }

    expect(waves.size).toBeGreaterThan(3);
    for (const lanes of waves.values()) {
      expect(lanes.length).toBeLessThanOrEqual(2);
      expect(lanes.every((lane) => lane >= 0 && lane < RACER_LANE_CENTERS.length)).toBe(true);
      if (lanes.length === 2) expect(Math.abs(lanes[0]! - lanes[1]!)).toBe(1);
    }
  });

  test("scores ten per dodged car and steps the speed every ten dodges", () => {
    const game = playing();
    expect(game.speed()).toBe(RACER_BASE_SPEED);

    // Tail one pixel past the player's front bumper on the next step.
    game.cars = [{ x: RACER_PLAYER_X - RACER_CAR_WIDTH + 0.1, lane: 3, colorIndex: 0, scored: false }];
    game.tick(RACER_STEP_MS, emptyInput());
    expect(game.score).toBe(RACER_DODGE_SCORE);
    expect(game.dodged).toBe(1);
    // A car is only ever counted once.
    game.tick(RACER_STEP_MS, emptyInput());
    expect(game.score).toBe(RACER_DODGE_SCORE);

    game.dodged = RACER_DODGE_PER_STEP;
    expect(game.level()).toBe(2);
    expect(game.speed()).toBeCloseTo(RACER_BASE_SPEED * RACER_SPEED_STEP, 8);
    game.dodged = RACER_DODGE_PER_STEP * 2;
    expect(game.speed()).toBeCloseTo(RACER_BASE_SPEED * RACER_SPEED_STEP ** 2, 8);
    game.dodged = RACER_DODGE_PER_STEP * 40;
    expect(game.speed()).toBe(RACER_MAX_SPEED);
  });

  test("only the player's own lane can end the run", () => {
    const missed = playing();
    missed.cars = [{ x: RACER_PLAYER_X, lane: 0, colorIndex: 0, scored: false }];
    missed.tick(RACER_STEP_MS, emptyInput());
    expect(missed.phase).toBe("playing");

    const hit = playing();
    hit.cars = [{ x: RACER_PLAYER_X + 3, lane: hit.lane, colorIndex: 1, scored: false }];
    hit.tick(RACER_STEP_MS, emptyInput());
    expect(hit.phase).toBe("game-over");
    expect(hit.hud().message).toContain("重开");

    // Touching bumpers, not overlapping: 4px cars, so x = 8 is still clear.
    const grazed = playing();
    grazed.cars = [{ x: RACER_PLAYER_X + RACER_CAR_WIDTH, lane: grazed.lane, colorIndex: 1, scored: false }];
    grazed.tick(0, emptyInput());
    expect(grazed.phase).toBe("playing");
  });

  test("flashes the impact white for two frames before the settlement screen", () => {
    const game = playing();
    game.score = 40;
    game.cars = [{ x: RACER_PLAYER_X, lane: game.lane, colorIndex: 2, scored: true }];
    game.tick(RACER_STEP_MS, emptyInput());
    expect(game.phase).toBe("game-over");

    const flash = new Recorder();
    game.render(flash);
    // Both the player and the car it hit go white; the road stays underneath.
    expect(flash.at(RACER_PLAYER_X, RACER_LANE_CENTERS[game.lane]!)).toBe("#ffffff");
    expect(flash.at(RACER_PLAYER_X + 3, RACER_LANE_CENTERS[game.lane]! - 1)).toBe("#ffffff");

    // 60ms = 2 device frames later the settlement screen takes over.
    game.tick(30, emptyInput());
    game.tick(30, emptyInput());
    const over = new Recorder();
    game.render(over);
    expect(over.gridOf("#ff4d5a")).toEqual(glyphRows("OVER"));
    expect(over.gridOf("#ffffff")).toEqual(glyphRows("40"));
  });

  test("holds the settlement screen through the restart lock, then replays", () => {
    const game = playing();
    game.cars = [{ x: RACER_PLAYER_X, lane: game.lane, colorIndex: 0, scored: true }];
    game.tick(RACER_STEP_MS, emptyInput());
    expect(game.phase).toBe("game-over");

    game.tick(100, press());
    expect(game.phase).toBe("game-over");

    // dt is clamped to 250ms, so the 600ms lock takes a few frames to burn off.
    game.tick(250, emptyInput());
    game.tick(250, emptyInput());
    game.tick(0, press());
    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.dodged).toBe(0);
    expect(game.lane).toBe(1);
    expect(game.cars).toEqual([]);
  });

  test("clamps a long frame to 250ms of simulation", () => {
    const stalled = new RacerGame({ seed: 7 });
    const steady = new RacerGame({ seed: 7 });
    stalled.tick(0, press());
    steady.tick(0, press());

    stalled.tick(10_000, emptyInput());
    steady.tick(250, emptyInput());

    expect(stalled.scrolled).toBeCloseTo(steady.scrolled, 8);
    expect(stalled.cars).toEqual(steady.cars);
  });

  test("restart() drops straight back to the attract screen", () => {
    const game = playing();
    game.score = 120;
    game.dodged = 12;
    game.lane = 3;

    game.restart();
    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.dodged).toBe(0);
    expect(game.level()).toBe(1);
    expect(game.lane).toBe(1);
    expect(game.scrolled).toBe(0);
  });

  test("replays the device engine frame for frame from the same seed", () => {
    // Fixture captured by compiling device/tc002-arcade/app/src/games/racer.cpp on
    // the host and driving it with this exact script at the arcade's 30ms tick:
    // Middle every 97th frame, Right on every 20th, Left on every 37th. The two
    // engines were compared over 3000 frames on ten seeds — state and the full
    // 52x16 RGB buffer matched everywhere except the 3x5 glyph tables, which
    // differ between the firmware font and web/src/lib/pixel-font.ts.
    const expected = new Map<number, string>([
      [60, "1 0 0 1 |"],
      [120, "1 0 0 3 | 0@31.233333 0@47.800000"],
      [180, "1 0 0 3 | 0@6.033333 0@22.600000 2@45.000000 3@45.000000"],
      [240, "1 20 2 2 | 0@-2.600000 2@19.800000 3@19.800000 2@36.133333 3@36.133333"],
      [269, "2 20 2 3 | 2@7.900000 3@7.900000 2@24.233333 3@24.233333 0@42.316667"],
      [299, "2 20 2 3 | 2@7.900000 3@7.900000 2@24.233333 3@24.233333 0@42.316667"],
    ]);
    const PHASES = { ready: 0, playing: 1, "game-over": 2 } as const;

    const game = new RacerGame({ seed: 11 });
    const seen = new Map<number, string>();
    for (let frame = 0; frame < 300; frame += 1) {
      const down = frame % 20 === 5;
      const up = !down && frame % 37 === 11;
      game.tick(30, {
        ...emptyInput(),
        pressedEdge: frame % 97 === 40,
        direction: down ? "down" : up ? "up" : null,
      });
      if (!expected.has(frame)) continue;
      const cars = game.cars.map((car) => ` ${car.lane}@${car.x.toFixed(6)}`).join("");
      seen.set(
        frame,
        `${PHASES[game.phase]} ${game.score} ${game.dodged} ${game.lane} |${cars}`,
      );
    }
    expect(seen).toEqual(expected);
  });
});
