import { describe, expect, test } from "bun:test";
import {
  emptyInput,
  GAME_SCREEN_HEIGHT,
  GAME_SCREEN_WIDTH,
  type GameInput,
  type PixelDrawContext,
} from "../web/src/lib/games/engine.ts";
import {
  PONG_AI_SPEED,
  PONG_BASE_SPEED,
  PONG_PADDLE_HEIGHT,
  PONG_SERVE_DELAY_MS,
  PONG_SPEED_STEP,
  PONG_STEP_MS,
  PONG_WIN_SCORE,
  PongGame,
  pongPaddleTop,
} from "../web/src/lib/games/pong.ts";
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

  cellsOf(color: string): (readonly [number, number])[] {
    return [...this.pixels.entries()]
      .filter(([, value]) => value === color)
      .map(([key]) => [key % GAME_SCREEN_WIDTH, Math.floor(key / GAME_SCREEN_WIDTH)] as const);
  }

  gridOf(color: string): string[] {
    const cells = this.cellsOf(color);
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
const SCORE_DIM = "#1d4368";

describe("pong engine", () => {
  test("declares itself a two player game and opens on the attract screen", () => {
    const game = new PongGame({ random: () => 0.5 });

    expect(game.meta.id).toBe("pong");
    expect(game.meta.twoPlayers).toBe(true);
    expect(game.phase).toBe("ready");
    expect(game.scoreLeft).toBe(0);
    expect(game.scoreRight).toBe(0);
    expect(game.speed()).toBe(PONG_BASE_SPEED);
    expect(game.hud()).toMatchObject({ score: 0, level: 1, phase: "ready" });
  });

  test("tracks the vertical pointer on the left paddle and takes p2PointerY straight", () => {
    const game = new PongGame({ random: () => 0.5 });

    game.tick(0, { ...emptyInput(), pointerY: 0 });
    expect(game.leftY).toBe(0);
    game.tick(0, { ...emptyInput(), pointerY: GAME_SCREEN_HEIGHT });
    expect(game.leftY).toBe(16 - PONG_PADDLE_HEIGHT);
    game.tick(0, { ...emptyInput(), pointerY: GAME_SCREEN_HEIGHT / 2 });
    expect(game.leftY).toBe(pongPaddleTop(8));
    expect(game.leftY).toBe(6);

    expect(game.padConnected()).toBe(false);
    game.tick(0, { ...emptyInput(), p2PointerY: 12 });
    expect(game.rightY).toBe(pongPaddleTop(12));
    expect(game.padConnected()).toBe(true);
  });

  test("serves on a press edge and keeps the ball speed through a paddle bounce", () => {
    const game = new PongGame({ random: () => 0.5 });

    game.tick(0, press());
    expect(game.phase).toBe("playing");
    // random 0.5 serves to the right at a flat angle.
    expect(game.ball.vx).toBeCloseTo(PONG_BASE_SPEED, 8);
    expect(game.ball.vy).toBeCloseTo(0, 8);

    game.ball = { x: 1.05, y: 7.5, vx: -PONG_BASE_SPEED, vy: 0 };
    game.tick(PONG_STEP_MS, { ...emptyInput(), pointerY: GAME_SCREEN_HEIGHT / 2 });
    expect(game.ball.vx).toBeGreaterThan(0);
    expect(Math.hypot(game.ball.vx, game.ball.vy)).toBeCloseTo(PONG_BASE_SPEED, 8);

    game.ball = { x: 49.95, y: 7.5, vx: PONG_BASE_SPEED, vy: 0 };
    game.tick(PONG_STEP_MS, { ...emptyInput(), p2PointerY: 8 });
    expect(game.ball.vx).toBeLessThan(0);
    expect(Math.hypot(game.ball.vx, game.ball.vy)).toBeCloseTo(PONG_BASE_SPEED, 8);
  });

  test("the AI paddle chases the ball at a capped speed and stands down for a gamepad", () => {
    const game = new PongGame({ random: () => 0.5 });
    game.tick(0, press());
    game.ball = { x: 26, y: 15, vx: 0, vy: 0 };

    const before = game.rightY;
    game.tick(100, emptyInput());
    expect(game.rightY).toBeGreaterThan(before);
    expect(game.rightY - before).toBeCloseTo(PONG_AI_SPEED * 0.1, 8);

    game.tick(100, { ...emptyInput(), p2PointerY: 4 });
    expect(game.rightY).toBe(pongPaddleTop(4));
  });

  test("awards the point when the ball leaves the field and speeds the next round up 5%", () => {
    const game = new PongGame({ random: () => 0.5 });
    game.tick(0, press());
    game.leftY = 0;
    game.ball = { x: 0.4, y: 15, vx: -PONG_BASE_SPEED, vy: 0 };

    game.tick(60, emptyInput());
    expect(game.scoreRight).toBe(1);
    expect(game.scoreLeft).toBe(0);
    expect(game.rounds()).toBe(1);
    expect(game.speed()).toBeCloseTo(PONG_BASE_SPEED * PONG_SPEED_STEP, 8);
    expect(game.serveDelayMs).toBeGreaterThan(0);
    expect(game.ball.vx).toBe(0);
    expect(game.hud().message).toContain("0 : 1");

    // dt is clamped to 250ms, so the serve delay burns off over several frames.
    game.tick(250, emptyInput());
    game.tick(250, emptyInput());
    game.tick(250, emptyInput());
    expect(game.serveDelayMs).toBeLessThanOrEqual(0);
    // The round loser receives, so the ball heads back towards the left paddle.
    expect(game.ball.vx).toBeLessThan(0);
    expect(Math.hypot(game.ball.vx, game.ball.vy)).toBeCloseTo(PONG_BASE_SPEED * PONG_SPEED_STEP, 6);
  });

  test("draws both 3x5 scores in the top band on either side of the dashed centre line", () => {
    const game = new PongGame({ random: () => 0.5 });
    game.scoreLeft = 3;
    game.scoreRight = 5;

    const recorder = new Recorder();
    game.render(recorder);
    const digits = recorder.cellsOf(SCORE_DIM);
    expect(digits.length).toBeGreaterThan(0);
    expect(digits.every(([, y]) => y >= 1 && y <= 5)).toBe(true);
    expect(digits.some(([x]) => x < GAME_SCREEN_WIDTH / 2)).toBe(true);
    expect(digits.some(([x]) => x > GAME_SCREEN_WIDTH / 2)).toBe(true);
    // Dashed centre line: two lit rows then a gap.
    expect(recorder.at(26, 0)).toBe("#16324e");
    expect(recorder.at(26, 1)).toBe("#16324e");
    expect(recorder.at(26, 2)).not.toBe("#16324e");
  });

  test("ends the match at nine points and shows the winner with the final score", () => {
    const game = new PongGame({ random: () => 0.5 });
    game.tick(0, press());
    game.scoreLeft = PONG_WIN_SCORE - 1;
    game.rightY = 12;
    game.ball = { x: 50.4, y: 1, vx: PONG_BASE_SPEED, vy: 0 };

    game.tick(60, emptyInput());
    expect(game.scoreLeft).toBe(PONG_WIN_SCORE);
    expect(game.phase).toBe("game-over");
    expect(game.leftWon()).toBe(true);
    expect(game.hud().message).toContain("你赢了");

    const recorder = new Recorder();
    game.render(recorder);
    expect(recorder.gridOf("#ffffff")).toEqual(glyphRows(`${PONG_WIN_SCORE}-0`));
    // Winner banner is painted in the left paddle colour.
    expect(recorder.gridOf("#5b8cff").length).toBe(5);
  });

  test("restarts after the press lock and via restart()", () => {
    const game = new PongGame({ random: () => 0.5 });
    game.tick(0, press());
    game.scoreLeft = PONG_WIN_SCORE - 1;
    game.rightY = 12;
    game.ball = { x: 50.4, y: 1, vx: PONG_BASE_SPEED, vy: 0 };
    game.tick(60, emptyInput());
    expect(game.phase).toBe("game-over");

    game.tick(100, press());
    expect(game.phase).toBe("game-over");
    game.tick(250, emptyInput());
    game.tick(250, emptyInput());
    game.tick(0, press());
    expect(game.phase).toBe("ready");
    expect(game.scoreLeft).toBe(0);
    expect(game.scoreRight).toBe(0);
    expect(game.speed()).toBe(PONG_BASE_SPEED);

    game.tick(0, press());
    game.scoreRight = 4;
    game.restart();
    expect(game.phase).toBe("ready");
    expect(game.scoreRight).toBe(0);
    expect(game.serveDelayMs).toBe(0);
    expect(game.leftY).toBe(pongPaddleTop(8));
  });

  test("parks the ball on the centre spot for the whole serve delay", () => {
    const game = new PongGame({ random: () => 0.5 });
    game.tick(0, press());
    game.leftY = 0;
    game.ball = { x: 0.4, y: 15, vx: -PONG_BASE_SPEED, vy: 0 };

    game.tick(60, emptyInput());
    expect(game.scoreRight).toBe(1);
    expect(game.serveDelayMs).toBeGreaterThan(PONG_SERVE_DELAY_MS - 2 * PONG_STEP_MS);
    expect(game.serveDelayMs).toBeLessThanOrEqual(PONG_SERVE_DELAY_MS);

    game.tick(200, emptyInput());
    expect(game.serveDelayMs).toBeGreaterThan(0);
    expect(game.ball.x).toBe(GAME_SCREEN_WIDTH / 2);
    expect(game.ball.vx).toBe(0);
  });
});
