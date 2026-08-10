import { describe, expect, test } from "bun:test";
import {
  emptyInput,
  GAME_SCREEN_WIDTH,
  type GameInput,
  type PixelDrawContext,
} from "../web/src/lib/games/engine.ts";
import {
  FLAPPY_BASE_SPEED,
  FLAPPY_BIRD_X,
  FLAPPY_GRAVITY,
  FLAPPY_GROUND_Y,
  FLAPPY_JUMP_VELOCITY,
  FLAPPY_MIN_GAP,
  FLAPPY_PIPE_SPACING,
  FLAPPY_SPEED_STEP,
  FLAPPY_STEP_MS,
  FlappyGame,
} from "../web/src/lib/games/flappy.ts";
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

describe("flappy engine", () => {
  test("opens on an attract screen with the bird hovering at its fixed column", () => {
    const game = new FlappyGame({ random: () => 0.5 });

    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.hud()).toMatchObject({ score: 0, level: 1, phase: "ready" });
    expect(game.hud().message).toContain("起飞");

    const recorder = new Recorder();
    game.render(recorder);
    expect(recorder.at(FLAPPY_BIRD_X, 6)).toBe("#ffd43b");
    expect(recorder.at(FLAPPY_BIRD_X + 1, 6)).toBe("#ffd43b");
    expect(recorder.at(0, FLAPPY_GROUND_Y)).toBeTruthy();
    // The "FLAP" prompt sits to the right of the bird.
    expect(recorder.gridOf("#c1ff3d").length).toBe(5);
  });

  test("lays out four pipes 18px apart with a 7px gap at score zero", () => {
    const game = new FlappyGame({ random: () => 0 });

    expect(game.pipes.length).toBe(4);
    expect(game.pipes[0]!.x).toBe(GAME_SCREEN_WIDTH);
    expect(game.pipes[1]!.x - game.pipes[0]!.x).toBe(FLAPPY_PIPE_SPACING);
    expect(game.pipes.every((pipe) => pipe.gap === 7 && pipe.gapTop === 1)).toBe(true);
  });

  test("a press edge launches the bird, then gravity takes over", () => {
    const game = new FlappyGame({ random: () => 0.5 });

    game.tick(0, press());
    expect(game.phase).toBe("playing");
    expect(game.velocity).toBe(FLAPPY_JUMP_VELOCITY);

    game.tick(FLAPPY_STEP_MS, emptyInput());
    const expectedVelocity = FLAPPY_JUMP_VELOCITY + FLAPPY_GRAVITY / 120;
    expect(game.velocity).toBeCloseTo(expectedVelocity, 8);
    expect(game.birdY).toBeCloseTo(6 + expectedVelocity / 120, 8);

    // A mid-air flap resets the velocity to the flat impulse rather than adding to it.
    game.tick(0, press());
    expect(game.velocity).toBe(FLAPPY_JUMP_VELOCITY);
  });

  test("clamps a long frame to 250ms of simulation", () => {
    const stalled = new FlappyGame({ random: () => 0.5 });
    const steady = new FlappyGame({ random: () => 0.5 });
    stalled.tick(0, press());
    steady.tick(0, press());

    stalled.tick(10_000, emptyInput());
    steady.tick(250, emptyInput());

    expect(stalled.birdY).toBeCloseTo(steady.birdY, 8);
    expect(stalled.velocity).toBeCloseTo(steady.velocity, 8);
  });

  test("scores a cleared pipe and tightens the gap and speed with the score", () => {
    const game = new FlappyGame({ random: () => 0.5 });
    game.tick(0, press());
    game.birdY = 6;
    game.velocity = 0;
    game.pipes = [{ x: 9.5, gapTop: 4, gap: 7, scored: false }];

    game.tick(100, emptyInput());
    expect(game.score).toBe(1);
    expect(game.phase).toBe("playing");

    game.score = 5;
    expect(game.gap()).toBe(6);
    expect(game.level()).toBe(2);
    expect(game.speed()).toBeCloseTo(FLAPPY_BASE_SPEED * FLAPPY_SPEED_STEP, 8);

    game.score = 10;
    expect(game.gap()).toBe(5);
    expect(game.speed()).toBeCloseTo(FLAPPY_BASE_SPEED * FLAPPY_SPEED_STEP ** 2, 8);

    game.score = 60;
    expect(game.gap()).toBe(FLAPPY_MIN_GAP);
  });

  test("ends the run on a pipe hit and on the ground", () => {
    const crashed = new FlappyGame({ random: () => 0.5 });
    crashed.tick(0, press());
    crashed.birdY = 1;
    crashed.velocity = 0;
    crashed.pipes = [{ x: FLAPPY_BIRD_X, gapTop: 6, gap: 7, scored: false }];
    crashed.tick(FLAPPY_STEP_MS, emptyInput());
    expect(crashed.phase).toBe("game-over");

    const dropped = new FlappyGame({ random: () => 0.5 });
    dropped.tick(0, press());
    dropped.pipes = [];
    dropped.birdY = 13.5;
    dropped.velocity = 0;
    dropped.tick(FLAPPY_STEP_MS, emptyInput());
    expect(dropped.phase).toBe("game-over");
    expect(dropped.hud().message).toContain("重开");
  });

  test("draws the final score as 3x5 digits and restarts after the press lock", () => {
    const game = new FlappyGame({ random: () => 0.5 });
    game.tick(0, press());
    game.score = 7;
    game.pipes = [];
    game.birdY = 14;
    game.velocity = 0;
    game.tick(FLAPPY_STEP_MS, emptyInput());
    expect(game.phase).toBe("game-over");

    const recorder = new Recorder();
    game.render(recorder);
    expect(recorder.gridOf("#ffffff")).toEqual(glyphRows("7"));

    game.tick(100, press());
    expect(game.phase).toBe("game-over");

    // dt is clamped to 250ms, so the 600ms restart lock takes a few frames to burn off.
    game.tick(250, emptyInput());
    game.tick(250, emptyInput());
    game.tick(0, press());
    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.birdY).toBe(6);
    expect(game.pipes.length).toBe(4);
  });

  test("restart() drops straight back to the attract screen", () => {
    const game = new FlappyGame({ random: () => 0.5 });
    game.tick(0, press());
    game.score = 12;
    game.birdY = 2;

    game.restart();
    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.velocity).toBe(0);
    expect(game.pipes[0]!.x).toBe(GAME_SCREEN_WIDTH);
  });
});
