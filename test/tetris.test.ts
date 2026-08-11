import { describe, expect, test } from "bun:test";
import {
  emptyInput,
  GAME_SCREEN_WIDTH,
  type GameInput,
  type PixelDrawContext,
} from "../web/src/lib/games/engine.ts";
import {
  TETRIS_BASE_INTERVAL_MS,
  TETRIS_COLUMNS_PER_LEVEL,
  TETRIS_MIN_INTERVAL_MS,
  TETRIS_PIECE_COLORS,
  TETRIS_SOFT_DROP_FACTOR,
  TETRIS_SPAWN_X,
  TETRIS_SPAWN_Y,
  TetrisGame,
  TetrisRandom,
  createTetrisGame,
} from "../web/src/lib/games/tetris.ts";
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

  countOf(color: string): number {
    return [...this.pixels.values()].filter((value) => value === color).length;
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
const hold = (direction: NonNullable<GameInput["direction"]>): GameInput => ({
  ...emptyInput(),
  direction,
});

/** One knob detent: the rising direction edge, then the release. */
function detent(game: TetrisGame, direction: NonNullable<GameInput["direction"]>): void {
  game.tick(0, hold(direction));
  game.tick(0, emptyInput());
}

/** The Right button is a hard drop, so its detent locks the piece. */
function hardDrop(game: TetrisGame): void {
  detent(game, "right");
}

function rotate(game: TetrisGame): void {
  game.tick(0, press());
}

function begin(seed: number): TetrisGame {
  const game = createTetrisGame({ seed });
  game.tick(0, press());
  return game;
}

/** tick() clamps dt to 250ms, so walk longer waits forward in slices. */
function wait(game: TetrisGame, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    game.tick(Math.min(250, ms - elapsed), emptyInput());
  }
}

// Seeds whose bag opens with the pieces a scenario needs, found the same way the
// firmware selfcheck finds them (device/tc002-arcade/hostcheck/selfcheck.cpp
// findTetrisSeed): 0 = I, 3 = O.
const SEED_I = 1;
const SEED_IIO = 6;
const SEED_IIIIO = 385;

describe("tetris bag", () => {
  test("reproduces the firmware xorshift32 sequence bit for bit", () => {
    const random = new TetrisRandom();
    random.seed(SEED_I);
    const drawn = Array.from({ length: 12 }, () => random.pick(7));
    // Captured from arcadegames::GameRandom on the host — a divergence here
    // would desynchronise the piece sequence and make lockstep impossible.
    expect(drawn).toEqual([0, 0, 4, 0, 3, 1, 1, 0, 3, 4, 4, 2]);

    // seed(0) would freeze xorshift, so the firmware substitutes 1.
    random.seed(0);
    expect(random.state).toBe(1);
  });

  test("draws exactly one piece per spawn, in spawn order", () => {
    const replay = new TetrisRandom();
    replay.seed(SEED_IIO);
    const expected = Array.from({ length: 4 }, () => replay.pick(7));

    const game = begin(SEED_IIO);
    expect([game.piece, game.nextPiece]).toEqual([expected[0]!, expected[1]!]);
    hardDrop(game);
    expect([game.piece, game.nextPiece]).toEqual([expected[1]!, expected[2]!]);
    hardDrop(game);
    expect([game.piece, game.nextPiece]).toEqual([expected[2]!, expected[3]!]);
  });
});

describe("tetris engine", () => {
  test("opens on the attract screen with the well outline and a blinking title", () => {
    const game = createTetrisGame({ seed: SEED_I });
    expect(game.meta.id).toBe("tetris");
    expect(game.phase).toBe("ready");
    expect(game.hud()).toMatchObject({ score: 0, level: 1, phase: "ready", message: "按空格开始" });
    expect(game.hud().lives).toBeUndefined();
    expect(game.filledCount()).toBe(0);

    const recorder = new Recorder();
    game.render(recorder);
    // Dark-tier outline: floor column at x=7, rails at y=2 and y=13.
    expect(recorder.at(7, 2)).toBe("#1c3550");
    expect(recorder.at(7, 12)).toBe("#1c3550");
    expect(recorder.at(47, 13)).toBe("#1c3550");
    expect(recorder.at(48, 13)).toBe("#000000");  // the rails stop at the entry
    expect(recorder.countOf("#c1ff3d")).toBeGreaterThan(0);

    // Idles without input, and the title blinks off on the second 500ms window.
    wait(game, 500);
    expect(game.phase).toBe("ready");
    const blinked = new Recorder();
    game.render(blinked);
    expect(blinked.countOf("#c1ff3d")).toBe(0);
    expect(blinked.at(7, 2)).toBe("#1c3550");
  });

  test("spawns the 4x4 box at the entry zone and stops shifts at the far rail", () => {
    const game = begin(SEED_I);
    expect(game.phase).toBe("playing");
    expect(game.piece).toBe(0);  // I
    expect([game.pieceX, game.pieceY]).toEqual([TETRIS_SPAWN_X, TETRIS_SPAWN_Y]);

    rotate(game);
    rotate(game);
    expect(game.rotation).toBe(2);
    for (let i = 0; i < 5; i += 1) detent(game, "down");
    expect(game.pieceY).toBe(7);  // the fifth detent is rejected at the rail

    // 2 -> L: the base position and the +1y kick both fail, -1y lands.
    rotate(game);
    expect(game.rotation).toBe(3);
    expect(game.pieceY).toBe(6);
  });

  test("treats a held direction key as a single knob detent", () => {
    const game = begin(SEED_I);
    game.tick(0, hold("down"));
    expect(game.pieceY).toBe(TETRIS_SPAWN_Y + 1);
    // Still held: a knob detent has no repeat, so neither does the key.
    game.tick(0, hold("down"));
    expect(game.pieceY).toBe(TETRIS_SPAWN_Y + 1);

    game.tick(0, emptyInput());
    game.tick(0, hold("down"));
    expect(game.pieceY).toBe(TETRIS_SPAWN_Y + 2);
    game.tick(0, emptyInput());
    game.tick(0, hold("up"));
    expect(game.pieceY).toBe(TETRIS_SPAWN_Y + 1);
  });

  test("falls left one cell per interval and 8x faster while ← is held", () => {
    const game = begin(SEED_I);
    expect(game.intervalMs()).toBe(TETRIS_BASE_INTERVAL_MS);
    wait(game, TETRIS_BASE_INTERVAL_MS - 10);
    expect(game.pieceX).toBe(TETRIS_SPAWN_X);
    game.tick(10, emptyInput());
    expect(game.pieceX).toBe(TETRIS_SPAWN_X - 1);

    const soft = begin(SEED_I);
    expect(soft.stepMs()).toBe(TETRIS_BASE_INTERVAL_MS);
    // 15 device-sized ticks of 30ms = 450ms = four 100ms soft-drop steps.
    for (let slice = 0; slice < 450; slice += 30) soft.tick(30, hold("left"));
    expect(soft.softDropping()).toBe(true);
    expect(soft.stepMs()).toBe(TETRIS_BASE_INTERVAL_MS / TETRIS_SOFT_DROP_FACTOR);
    expect(soft.pieceX).toBe(TETRIS_SPAWN_X - 4);
  });

  test("hard drops to the floor, flashes the landing and respawns at the entry", () => {
    const game = begin(SEED_I);
    hardDrop(game);
    // The I bar rests on the floor column (internal x=0..3, screen x=8..11).
    expect(game.filledCount()).toBe(4);
    expect(game.cellAt(0, 4)).toBe(0);
    expect(game.score).toBe(0);
    expect([game.pieceX, game.pieceY]).toEqual([TETRIS_SPAWN_X, TETRIS_SPAWN_Y]);

    const recorder = new Recorder();
    game.render(recorder);
    // 60ms landing flash over all four cells of the bar.
    for (let x = 8; x <= 11; x += 1) expect(recorder.at(x, 7)).toBe("#ffffff");
    // HUD panel: 'N' label, the next piece thumb, the level digit.
    expect(recorder.at(0, 0)).toBe("#55b7e8");
    expect(recorder.at(1, 7)).toBe(TETRIS_PIECE_COLORS[game.nextPiece]);
    expect(recorder.at(3, 11)).toBe("#ffffff");

    // Two device frames later the flash is gone and the bar shows its own colour.
    game.tick(30, emptyInput());
    game.tick(30, emptyInput());
    const settled = new Recorder();
    game.render(settled);
    expect(settled.at(8, 7)).toBe(TETRIS_PIECE_COLORS[0]);
  });

  test("clears a full column for 100 x level and shifts the rest toward the floor", () => {
    // I, I, O: two upright bars fill lanes 0..7 of column 0, the O caps 8..9.
    const game = begin(SEED_IIO);
    rotate(game);
    for (let i = 0; i < 3; i += 1) detent(game, "up");
    hardDrop(game);
    rotate(game);
    detent(game, "down");
    hardDrop(game);
    expect(game.filledCount()).toBe(8);
    expect(game.score).toBe(0);

    for (let i = 0; i < 5; i += 1) detent(game, "down");
    hardDrop(game);
    expect(game.score).toBe(100);
    expect(game.cleared).toBe(1);
    // Only the O's outer column survives, shifted onto the emptied floor.
    expect(game.filledCount()).toBe(2);
    expect(game.cellAt(0, 8)).toBe(3);
    expect(game.cellAt(1, 8)).toBe(-1);
  });

  test("pays 300 for a double clear and leaves the well empty", () => {
    const game = begin(SEED_IIIIO);
    for (let piece = 0; piece < 4; piece += 1) {
      rotate(game);
      if (piece % 2 === 0) for (let i = 0; i < 3; i += 1) detent(game, "up");
      else detent(game, "down");
      hardDrop(game);
    }
    for (let i = 0; i < 5; i += 1) detent(game, "down");
    hardDrop(game);

    expect(game.score).toBe(300);
    expect(game.cleared).toBe(2);
    expect(game.filledCount()).toBe(0);
  });

  test("levels up every four columns and floors the interval", () => {
    const game = createTetrisGame({ seed: SEED_I });
    expect(game.level()).toBe(1);
    expect(game.intervalMs()).toBe(TETRIS_BASE_INTERVAL_MS);

    game.cleared = TETRIS_COLUMNS_PER_LEVEL;
    expect(game.level()).toBe(2);
    expect(game.intervalMs()).toBe(740);

    game.cleared = TETRIS_COLUMNS_PER_LEVEL * 40;
    expect(game.intervalMs()).toBe(TETRIS_MIN_INTERVAL_MS);
  });

  test("ends when the stack reaches the entry zone and replays after the lockout", () => {
    // Mindless hard drops never fill lanes 0..2 and 7..9, so the well silts up.
    const game = begin(1);
    for (let drop = 0; drop < 300 && game.phase === "playing"; drop += 1) hardDrop(game);
    expect(game.phase).toBe("game-over");
    expect(game.filledCount()).toBe(52);
    expect(game.hud().message).toContain("再按一次重开");

    const recorder = new Recorder();
    game.render(recorder);
    expect(recorder.gridOf("#ffd43b")).toEqual(glyphRows("OVER"));
    expect(recorder.gridOf("#ffffff")).toEqual(glyphRows(`${game.score} L${game.cleared}`));
    expect(recorder.countOf("#1c3550")).toBe(0);  // settlement screen drops the well

    // Inside the lockout a press is ignored; after it, the run starts over.
    game.tick(100, press());
    expect(game.phase).toBe("game-over");
    wait(game, 750);
    game.tick(0, press());
    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.filledCount()).toBe(0);
  });

  test("restart() returns to the attract screen but keeps the bag running", () => {
    const game = createTetrisGame({ seed: SEED_I });
    expect([game.piece, game.nextPiece]).toEqual([0, 0]);
    game.tick(0, press());
    hardDrop(game);
    expect(game.filledCount()).toBe(4);

    game.restart();
    expect(game.phase).toBe("ready");
    expect(game.score).toBe(0);
    expect(game.cleared).toBe(0);
    expect(game.filledCount()).toBe(0);
    expect([game.pieceX, game.pieceY]).toEqual([TETRIS_SPAWN_X, TETRIS_SPAWN_Y]);
    // The firmware's reset() leaves mRandom alone, so the sequence carries on
    // from wherever the previous run left it — here picks 4 and 5 of seed 1.
    expect([game.piece, game.nextPiece]).toEqual([0, 3]);
  });
});
