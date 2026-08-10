import { describe, expect, test } from "bun:test";
import {
  BREAKOUT_GAME_OVER_MS,
  BreakoutEngine,
  BreakoutGame,
  createTimeBricks,
  timeBrickRows,
  type BreakoutBrick,
} from "../web/src/lib/games/breakout.ts";
import { emptyInput, type GameInput } from "../web/src/lib/games/engine.ts";

const NOW = new Date(2026, 7, 10, 9, 42);
const dummyBrick = (): BreakoutBrick => ({
  id: "dummy",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  color: "#fff",
  kind: "normal",
});

interface RecordedRect {
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function recordingContext() {
  const rects: RecordedRect[] = [];
  const context = {
    fillStyle: "#000000" as string,
    fillRect(x: number, y: number, width: number, height: number) {
      rects.push({ color: String(this.fillStyle), x, y, width, height });
    },
    clearRect() {},
  };
  return { context, rects };
}

function input(patch: Partial<GameInput> = {}): GameInput {
  return { ...emptyInput(), ...patch };
}

describe("breakout physics", () => {
  test("lays out the current HH:MM as 3x5 digit bricks", () => {
    expect(timeBrickRows(NOW)).toEqual([
      "###.###.....#.#.###",
      "#.#.#.#..#..#.#...#",
      "#.#.###.....###.###",
      "#.#...#..#....#.#..",
      "###.###.......#.###",
    ]);
    const digitBricks = createTimeBricks(NOW).filter((brick) => brick.kind === "digit");
    expect(digitBricks.every((brick) => brick.y >= 0 && brick.y <= 4)).toBe(true);
    expect(new Set(digitBricks.map((brick) => brick.color)).size).toBe(5);
  });

  test("preserves ball speed when reflecting from a wall and paddle", () => {
    const game = new BreakoutGame({ now: () => NOW });
    game.bricks = [dummyBrick()];
    game.ball = { x: 0.05, y: 10, vx: -10, vy: 12 };
    const wallSpeed = Math.hypot(game.ball.vx, game.ball.vy);
    game.tick(20, 26);
    expect(game.ball.vx).toBeGreaterThan(0);
    expect(Math.hypot(game.ball.vx, game.ball.vy)).toBeCloseTo(wallSpeed, 8);

    game.ball = { x: 29, y: 14.4, vx: 0, vy: 16 };
    game.tick(10, 26);
    expect(game.ball.vx).toBeGreaterThan(0);
    expect(game.ball.vy).toBeLessThan(0);
    expect(Math.hypot(game.ball.vx, game.ball.vy)).toBeCloseTo(16, 8);
  });

  test("scores digit bricks and speeds up after every eighth hit", () => {
    const game = new BreakoutGame({ now: () => NOW });
    game.destroyed = 7;
    game.bricks = [
      { id: "target", x: 10, y: 5, width: 1, height: 1, color: "#fff", kind: "digit" },
      dummyBrick(),
    ];
    game.ball = { x: 10, y: 5.6, vx: 0, vy: -16 };
    game.tick(20, 26);
    expect(game.score).toBe(30);
    expect(game.destroyed).toBe(8);
    expect(game.bricks.some((brick) => brick.id === "target")).toBe(false);
    expect(game.ball.vy).toBeGreaterThan(0);
    expect(Math.hypot(game.ball.vx, game.ball.vy)).toBeCloseTo(16 * 1.06, 8);
  });

  test("rebuilds the time bricks on clear and reaches game over after three misses", () => {
    let now = NOW;
    const game = new BreakoutGame({ now: () => now });
    game.bricks = [];
    now = new Date(2026, 7, 10, 9, 43);
    game.tick(10, 26);
    expect(game.level).toBe(2);
    expect(game.bricks.filter((brick) => brick.kind === "digit")).toEqual(
      createTimeBricks(now).filter((brick) => brick.kind === "digit"),
    );

    game.bricks = [dummyBrick()];
    for (const lives of [3, 2, 1]) {
      expect(game.lives).toBe(lives);
      game.ball = { x: 2, y: 15.4, vx: 0, vy: 16 };
      game.tick(20, 26);
    }
    expect(game.lives).toBe(0);
    expect(game.phase).toBe("game-over");
    game.restart();
    expect(game.phase).toBe("playing");
    expect(game.lives).toBe(3);
    expect(game.score).toBe(0);
  });
});

describe("breakout game engine", () => {
  test("boots into an attract screen and starts playing on a press edge", () => {
    const engine = new BreakoutEngine({ now: () => NOW });
    expect(engine.meta.id).toBe("breakout");
    expect(engine.hud()).toMatchObject({
      score: 0,
      lives: 3,
      level: 1,
      phase: "ready",
      message: "点按屏幕或按空格开始",
    });

    const { context, rects } = recordingContext();
    engine.tick(16, input());
    engine.render(context);
    // Attract overlay: bricks up top plus a blinking PLAY! label mid-screen.
    expect(rects.some((rect) => rect.y <= 5 && rect.color !== "#000000")).toBe(true);
    expect(rects.some((rect) => rect.y >= 8 && rect.y <= 12 && rect.color === "#c1ff3d")).toBe(true);

    engine.tick(16, input({ pressedEdge: true }));
    expect(engine.hud().phase).toBe("playing");
    expect(engine.hud().message).toBeUndefined();
  });

  test("steers the paddle from held keyboard direction when no pointer is active", () => {
    const engine = new BreakoutEngine({ now: () => NOW });
    engine.tick(16, input({ pressedEdge: true }));
    const centered = engine.simulation.paddleX;
    for (let step = 0; step < 30; step += 1) {
      engine.tick(16, input({ direction: "right" }));
    }
    expect(engine.simulation.paddleX).toBeGreaterThan(centered);

    // A live pointer overrides and re-anchors the keyboard target.
    engine.tick(16, input({ pointerX: 6 }));
    expect(engine.simulation.paddleX).toBeCloseTo(6 - engine.simulation.paddleWidth / 2, 5);
  });

  test("renders the settlement screen and replays after the lockout", () => {
    const engine = new BreakoutEngine({ now: () => NOW });
    engine.tick(16, input({ pressedEdge: true }));
    const game = engine.simulation;
    game.bricks = [dummyBrick()];
    for (let miss = 0; miss < 3; miss += 1) {
      game.ball = { x: 2, y: 15.4, vx: 0, vy: 16 };
      engine.tick(20, input());
      game.bricks = [dummyBrick()];
    }
    expect(engine.hud().phase).toBe("game-over");
    expect(engine.hud().message).toContain("再来一局");

    const { context, rects } = recordingContext();
    engine.render(context);
    // Full-screen settlement: black backdrop, pulsing headline, progress bar.
    expect(rects[0]).toMatchObject({ x: 0, y: 0, width: 52, height: 16 });
    expect(rects.some((rect) => rect.color === "#ff4d5a" || rect.color === "#ff8a2a")).toBe(true);
    expect(rects.some((rect) => rect.y === 15 && rect.color === "#284b2c")).toBe(true);

    // Inside the lockout a press is ignored; after it, the game restarts fresh.
    engine.tick(100, input({ pressedEdge: true }));
    expect(engine.hud().phase).toBe("game-over");
    // tick clamps dt to 250ms, so walk time forward in slices past the lockout.
    for (let elapsed = 0; elapsed < BREAKOUT_GAME_OVER_MS; elapsed += 250) {
      engine.tick(250, input());
    }
    engine.tick(16, input({ pressedEdge: true }));
    expect(engine.hud()).toMatchObject({ phase: "playing", score: 0, lives: 3 });

    engine.restart();
    expect(engine.hud().phase).toBe("ready");
  });
});
