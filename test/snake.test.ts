import { describe, expect, test } from "bun:test";
import {
  emptyInput,
  GAME_SCREEN_WIDTH,
  type GameInput,
  type PixelDrawContext,
} from "../web/src/lib/games/engine.ts";
import {
  SNAKE_BASE_SPEED,
  SNAKE_DIGIT_FOOD_GROWTH,
  SNAKE_DIGIT_FOOD_SCORE,
  SNAKE_FOOD_PER_LEVEL,
  SNAKE_MAX_SPEED,
  SNAKE_SPEED_STEP,
  SNAKE_START_LENGTH,
  SnakeGame,
} from "../web/src/lib/games/snake.ts";
import { PIXEL_FONT, renderPixelText } from "../web/src/lib/pixel-font.ts";

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

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length]!;
}

const press = (): GameInput => ({ ...emptyInput(), pressedEdge: true });
const steer = (direction: "up" | "down" | "left" | "right"): GameInput => ({ ...emptyInput(), direction });
/** One grid step at level 1. */
const STEP_MS = 1_000 / SNAKE_BASE_SPEED;

describe("snake engine", () => {
  test("opens ready with a four cell snake and a single blinking food pixel", () => {
    const game = new SnakeGame({ random: () => 0.5 });

    expect(game.phase).toBe("ready");
    expect(game.cells.length).toBe(SNAKE_START_LENGTH);
    expect(game.cells[0]).toEqual({ x: 8, y: 8 });
    expect(game.direction).toBe("right");
    expect(game.food.kind).toBe("dot");
    expect(game.food.cells.length).toBe(1);
    expect(game.cells).not.toContainEqual(game.food.cells[0]);
    expect(game.hud()).toMatchObject({ score: 0, level: 1, phase: "ready" });
  });

  test("advances one cell per step and paints the body as a head to tail gradient", () => {
    const game = new SnakeGame({ random: () => 0.5 });
    game.tick(0, press());
    expect(game.phase).toBe("playing");
    expect(game.stepMs()).toBeCloseTo(STEP_MS, 8);

    game.tick(STEP_MS, emptyInput());
    expect(game.cells[0]).toEqual({ x: 9, y: 8 });
    expect(game.cells.length).toBe(SNAKE_START_LENGTH);

    const recorder = new Recorder();
    game.render(recorder);
    const head = recorder.at(9, 8);
    const tail = recorder.at(6, 8);
    expect(head).toBe("#d6ff5c");
    expect(tail).toBe("#0e9c6a");
    expect(head).not.toBe(tail);
  });

  test("drops a 180 degree reversal against the direction actually being travelled", () => {
    const game = new SnakeGame({ random: () => 0.5 });
    game.tick(0, press());

    game.tick(0, steer("left"));
    expect(game.pendingDirection).toBe("right");

    game.tick(0, steer("up"));
    expect(game.pendingDirection).toBe("up");
    // Still travelling right, so "down" is a legal re-queue before the step commits.
    game.tick(0, steer("down"));
    expect(game.pendingDirection).toBe("down");

    game.tick(STEP_MS, emptyInput());
    expect(game.direction).toBe("down");
    expect(game.cells[0]).toEqual({ x: 8, y: 9 });

    game.tick(0, steer("up"));
    expect(game.pendingDirection).toBe("down");
  });

  test("a direction key also starts the run from the attract screen", () => {
    const game = new SnakeGame({ random: () => 0.5 });
    game.tick(0, steer("up"));
    expect(game.phase).toBe("playing");
    expect(game.pendingDirection).toBe("up");
  });

  test("eating a dot scores one point and grows the snake by one cell", () => {
    const game = new SnakeGame({ random: () => 0.5 });
    game.tick(0, press());
    game.food = { kind: "dot", digit: null, cells: [{ x: 9, y: 8 }] };

    game.tick(STEP_MS, emptyInput());
    expect(game.score).toBe(1);
    expect(game.eaten).toBe(1);
    expect(game.cells.length).toBe(SNAKE_START_LENGTH + 1);
    expect(game.food.cells[0]).not.toEqual({ x: 9, y: 8 });
  });

  test("spawns the 3x5 digit bonus food and pays five points for it", () => {
    // chance roll, digit pick, then the origin x/y of the first placement attempt.
    const game = new SnakeGame({ random: sequence([0.05, 0.3, 0, 0]) });

    expect(game.food.kind).toBe("digit");
    expect(game.food.digit).toBe("3");
    expect(game.food.cells.length).toBe(
      PIXEL_FONT["3"]!.join("").split("").filter((pixel) => pixel === "#").length,
    );
    expect(game.food.cells).toContainEqual({ x: 0, y: 0 });

    game.tick(0, press());
    game.cells = [{ x: 3, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 0 }];
    game.direction = "left";
    game.pendingDirection = "left";

    game.tick(STEP_MS, emptyInput());
    expect(game.score).toBe(SNAKE_DIGIT_FOOD_SCORE);
    expect(game.growth).toBe(SNAKE_DIGIT_FOOD_GROWTH - 1);
    expect(game.cells.length).toBe(4);
  });

  test("ends on a wall and on biting itself, but lets the head chase the vacating tail", () => {
    const wall = new SnakeGame({ random: () => 0.5 });
    wall.tick(0, press());
    wall.cells = [{ x: 51, y: 8 }, { x: 50, y: 8 }];
    wall.tick(STEP_MS, emptyInput());
    expect(wall.phase).toBe("game-over");

    const bite = new SnakeGame({ random: () => 0.5 });
    bite.tick(0, press());
    bite.cells = [
      { x: 10, y: 8 },
      { x: 9, y: 8 },
      { x: 9, y: 9 },
      { x: 10, y: 9 },
      { x: 11, y: 9 },
    ];
    bite.tick(0, steer("down"));
    bite.tick(STEP_MS, emptyInput());
    expect(bite.phase).toBe("game-over");

    const chase = new SnakeGame({ random: () => 0.5 });
    chase.tick(0, press());
    chase.cells = [{ x: 10, y: 8 }, { x: 9, y: 8 }, { x: 9, y: 9 }, { x: 10, y: 9 }];
    chase.tick(0, steer("down"));
    chase.tick(STEP_MS, emptyInput());
    expect(chase.phase).toBe("playing");
  });

  test("levels up every five foods and caps the speed", () => {
    const game = new SnakeGame({ random: () => 0.5 });
    expect(game.level()).toBe(1);
    expect(game.speed()).toBe(SNAKE_BASE_SPEED);

    game.eaten = SNAKE_FOOD_PER_LEVEL;
    expect(game.level()).toBe(2);
    expect(game.speed()).toBeCloseTo(SNAKE_BASE_SPEED * SNAKE_SPEED_STEP, 8);
    expect(game.stepMs()).toBeLessThan(STEP_MS);

    game.eaten = SNAKE_FOOD_PER_LEVEL * 40;
    expect(game.speed()).toBe(SNAKE_MAX_SPEED);
  });

  test("draws the final score as 3x5 digits and restarts after the press lock", () => {
    const game = new SnakeGame({ random: () => 0.5 });
    game.tick(0, press());
    game.cells = [{ x: 51, y: 8 }, { x: 50, y: 8 }];
    game.tick(STEP_MS, emptyInput());
    game.score = 8;
    expect(game.phase).toBe("game-over");

    const recorder = new Recorder();
    game.render(recorder);
    expect(recorder.gridOf("#ffffff")).toEqual(glyphRows("8"));

    game.tick(100, press());
    expect(game.phase).toBe("game-over");

    game.tick(250, emptyInput());
    game.tick(250, emptyInput());
    game.tick(0, press());
    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.eaten).toBe(0);
    expect(game.cells.length).toBe(SNAKE_START_LENGTH);
    expect(game.direction).toBe("right");
  });

  test("restart() drops straight back to the attract screen", () => {
    const game = new SnakeGame({ random: () => 0.5 });
    game.tick(0, press());
    game.score = 30;
    game.eaten = 12;
    game.growth = 4;

    game.restart();
    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.growth).toBe(0);
    expect(game.level()).toBe(1);
    expect(game.cells[0]).toEqual({ x: 8, y: 8 });
  });
});
