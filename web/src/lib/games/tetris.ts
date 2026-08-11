// Sideways tetris for the 52x16 LED panel — gravity pulls LEFT.
// Straight port of the device engine (device/tc002-arcade/app/src/games/tetris.{h,cpp}),
// which was written for the firmware knob first; every constant, the kick order
// and the xorshift bag are identical so the two can be driven in lockstep.

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

/** Internal x: 0 = floor (screen x=8), 39 = entry zone (screen x=47). */
export const TETRIS_WELL_DEPTH = 40;
/** Internal y: 0..9 → screen y=3..12, the 10 lanes the piece slides between. */
export const TETRIS_WELL_WIDTH = 10;
export const TETRIS_BASE_INTERVAL_MS = 800;
/** One gravity step gets this much faster per level. */
export const TETRIS_INTERVAL_STEP_MS = 60;
export const TETRIS_MIN_INTERVAL_MS = 140;
export const TETRIS_SOFT_DROP_FACTOR = 8;
export const TETRIS_COLUMNS_PER_LEVEL = 4;
export const TETRIS_CLEAR_SCORES = [100, 300, 500, 800] as const;
/** 4x4 spawn box origin, internal coords — screen x=44..47, centred on the well. */
export const TETRIS_SPAWN_X = 36;
export const TETRIS_SPAWN_Y = 3;
/**
 * The firmware seeds its bag with `time(0) ^ 0x7E7215C7`; a web engine must stay
 * deterministic (no clock, no Math.random), so the console starts from that
 * constant alone and `seedRandom()` is how a lockstep driver lines the two bags up.
 */
export const TETRIS_DEFAULT_SEED = 0x7e7215c7;

const WELL_SCREEN_X = 8;
const WELL_SCREEN_Y = 3;
const RESTART_LOCK_MS = 600;
/** Hard-drop landing flash — 60ms is two frames of the device's 30ms shell. */
const FLASH_MS = 60;

// SRS states 0,R,2,L as (cx,cy) cells in the 4x4 box. Screen axes match the
// standard grid (x right, y down), so the standard tables apply verbatim; only
// gravity differs (toward -x instead of +y).
type PieceCell = readonly [number, number];
type PieceRotations = readonly [
  readonly PieceCell[],
  readonly PieceCell[],
  readonly PieceCell[],
  readonly PieceCell[],
];

const PIECE_CELLS: readonly PieceRotations[] = [
  // I
  [[[0, 1], [1, 1], [2, 1], [3, 1]], [[2, 0], [2, 1], [2, 2], [2, 3]],
   [[0, 2], [1, 2], [2, 2], [3, 2]], [[1, 0], [1, 1], [1, 2], [1, 3]]],
  // J
  [[[0, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [1, 2]],
   [[0, 1], [1, 1], [2, 1], [2, 2]], [[1, 0], [1, 1], [0, 2], [1, 2]]],
  // L
  [[[2, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [1, 1], [1, 2], [2, 2]],
   [[0, 1], [1, 1], [2, 1], [0, 2]], [[0, 0], [1, 0], [1, 1], [1, 2]]],
  // O
  [[[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]],
   [[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]]],
  // S
  [[[1, 0], [2, 0], [0, 1], [1, 1]], [[1, 0], [1, 1], [2, 1], [2, 2]],
   [[1, 1], [2, 1], [0, 2], [1, 2]], [[0, 0], [0, 1], [1, 1], [1, 2]]],
  // T
  [[[1, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [1, 1], [2, 1], [1, 2]],
   [[0, 1], [1, 1], [2, 1], [1, 2]], [[1, 0], [0, 1], [1, 1], [1, 2]]],
  // Z
  [[[0, 0], [1, 0], [1, 1], [2, 1]], [[2, 0], [1, 1], [2, 1], [1, 2]],
   [[0, 1], [1, 1], [1, 2], [2, 2]], [[1, 0], [0, 1], [1, 1], [0, 2]]],
];

// Base position, then the three kicks: +1y, -1y, +1x (away from the floor).
const ROTATION_KICKS: readonly PieceCell[] = [[0, 0], [0, 1], [0, -1], [1, 0]];

// High-saturation piece colors (same family as the breakout rainbow).
export const TETRIS_PIECE_COLORS = [
  "#35c7d4", // I cyan
  "#5b8cff", // J blue
  "#ff8a2a", // L orange
  "#ffd43b", // O yellow
  "#58d68d", // S green
  "#b66cff", // T purple
  "#ff4d5a", // Z red
] as const;

// Full-screen fill: on the LED panel a dark grey background lights every pixel, so keep it truly off.
const BG = "#000000";
const WALL = "#1c3550";
const FLASH = "#ffffff";
const HUD_LABEL = "#55b7e8";
const HUD_LEVEL = "#ffffff";
const TITLE = "#ffd43b";
const SCORE = "#ffffff";
const PROMPT = "#c1ff3d";

export interface TetrisOptions {
  /** Pins the piece bag; the same seed yields the same sequence as the firmware. */
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

/**
 * xorshift32 mapped to [0,1) — a bit-for-bit port of `arcadegames::GameRandom`
 * (device/tc002-arcade/app/src/games/support.h). The other web engines take an
 * injectable `random()`, but a divergent bag would make lockstep impossible, so
 * tetris carries the firmware's generator instead of the platform's.
 */
export class TetrisRandom {
  state = 0x9e3779b9;

  seed(value: number): void {
    const next = value >>> 0;
    this.state = next === 0 ? 1 : next;
  }

  /** [0,1) */
  next(): number {
    // Every step is re-normalised to uint32 because JS bitwise ops are int32.
    let x = this.state;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.state = x;
    return (x >>> 8) * (1 / 16_777_216);
  }

  /** Uniform integer in [0,bound). */
  pick(bound: number): number {
    if (bound <= 0) return 0;
    const value = Math.floor(clamp(this.next(), 0, 0.999_999) * bound);
    return value > bound - 1 ? bound - 1 : value;
  }
}

export class TetrisGame implements GameEngine {
  readonly meta = {
    id: "tetris",
    title: "俄罗斯方块",
    hint: "重力向左：↑↓ 平移，空格旋转，← 软降、→ 硬降",
  } as const;

  score = 0;
  /** Total cleared columns — this well is sideways, so a "line" is a column. */
  cleared = 0;
  phase: GamePhase = "ready";
  /** -1 empty, else the piece id that locked there (used as the colour index). */
  board = new Int8Array(TETRIS_WELL_DEPTH * TETRIS_WELL_WIDTH);
  piece = 0;
  nextPiece = 0;
  rotation = 0;
  /** 4x4 box origin in internal well coordinates. */
  pieceX = TETRIS_SPAWN_X;
  pieceY = TETRIS_SPAWN_Y;

  private dropMs = 0;
  private elapsedMs = 0;
  private overMs = 0;
  private flashMs = 0;
  private flashCells: PieceCell[] = [];
  private softHeld = false;
  private heldDirection: GameInput["direction"] = null;
  private readonly random = new TetrisRandom();

  constructor(options: TetrisOptions = {}) {
    this.random.seed(options.seed ?? TETRIS_DEFAULT_SEED);
    this.reset();
  }

  tick(dtMs: number, input: GameInput): void {
    const dt = clamp(dtMs, 0, 250);
    this.elapsedMs += dt;
    // The firmware delivers key events between ticks, so inputs land first.
    const confirm = this.applyInput(input);

    if (this.phase === "ready") {
      if (confirm) this.phase = "playing";
      return;
    }
    if (this.phase === "game-over") {
      this.overMs += dt;
      if (confirm && this.overMs >= RESTART_LOCK_MS) this.reset();
      return;
    }

    if (this.flashMs > 0) {
      this.flashMs -= dt;
      if (this.flashMs < 0) this.flashMs = 0;
    }

    this.dropMs += dt;
    let threshold = this.stepMs();
    while (this.dropMs >= threshold && this.phase === "playing") {
      this.dropMs -= threshold;
      if (this.fits(this.piece, this.rotation, this.pieceX - 1, this.pieceY)) this.pieceX -= 1;
      else this.lockPiece(false);
      // Re-read: the lock may have cleared columns and levelled the drop up.
      threshold = this.stepMs();
    }
  }

  restart(): void {
    // Deliberately keeps the bag running, as the firmware's reset() does — only
    // seedRandom() rewinds the piece sequence.
    this.reset();
  }

  hud(): GameHud {
    return {
      score: this.score,
      // No lives concept (the firmware reports -1); the shell prints "—".
      level: this.level(),
      phase: this.phase,
      message: this.phase === "ready"
        ? "按空格开始"
        : this.phase === "playing"
        ? `第 ${this.level()} 级 · 消列 ${this.cleared}`
        : `结束了，得分 ${this.score}，再按一次重开`,
    };
  }

  level(): number {
    return Math.floor(this.cleared / TETRIS_COLUMNS_PER_LEVEL) + 1;
  }

  /** Gravity period at the current level, before the soft-drop divisor. */
  intervalMs(): number {
    const ms = TETRIS_BASE_INTERVAL_MS - TETRIS_INTERVAL_STEP_MS * (this.level() - 1);
    return ms > TETRIS_MIN_INTERVAL_MS ? ms : TETRIS_MIN_INTERVAL_MS;
  }

  /** Milliseconds per gravity step with soft drop applied. */
  stepMs(): number {
    return this.intervalMs() / (this.softHeld ? TETRIS_SOFT_DROP_FACTOR : 1);
  }

  filledCount(): number {
    let n = 0;
    for (let i = 0; i < this.board.length; i += 1) {
      if (this.board[i] >= 0) n += 1;
    }
    return n;
  }

  /** Internal well coordinates: x = depth from the floor, y = lane. */
  cellAt(x: number, y: number): number {
    return this.board[x * TETRIS_WELL_WIDTH + y];
  }

  /** True while ← is held; exposed because gravity runs 8x faster then. */
  softDropping(): boolean {
    return this.softHeld;
  }

  /** Mirrors the firmware hook the host selfcheck uses to pin a piece sequence. */
  seedRandom(seed: number): void {
    this.random.seed(seed);
  }

  render(ctx: PixelDrawContext): void {
    // The firmware's caller hands the engine a cleared surface; the console's
    // canvas keeps the previous frame, so paint the black ground here.
    ctx.clearRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, GAME_SCREEN_WIDTH, GAME_SCREEN_HEIGHT);

    if (this.phase === "game-over") {
      this.renderGameOver(ctx);
      return;
    }

    this.renderWalls(ctx);
    if (this.phase === "ready") {
      // Empty well + blinking title, centred over the well.
      if (this.blink(500)) drawText(ctx, "TETRIS", 16, 5, PROMPT);
      return;
    }

    for (let x = 0; x < TETRIS_WELL_DEPTH; x += 1) {
      for (let y = 0; y < TETRIS_WELL_WIDTH; y += 1) {
        const cell = this.cellAt(x, y);
        if (cell < 0) continue;
        ctx.fillStyle = TETRIS_PIECE_COLORS[cell]!;
        ctx.fillRect(WELL_SCREEN_X + x, WELL_SCREEN_Y + y, 1, 1);
      }
    }
    ctx.fillStyle = TETRIS_PIECE_COLORS[this.piece]!;
    for (const [cx, cy] of PIECE_CELLS[this.piece]![this.rotation]!) {
      ctx.fillRect(WELL_SCREEN_X + this.pieceX + cx, WELL_SCREEN_Y + this.pieceY + cy, 1, 1);
    }
    if (this.flashMs > 0) {
      ctx.fillStyle = FLASH;
      for (const [gx, gy] of this.flashCells) {
        ctx.fillRect(WELL_SCREEN_X + gx, WELL_SCREEN_Y + gy, 1, 1);
      }
    }
    this.renderHud(ctx);
  }

  /**
   * Firmware→console input mapping (device/tc002-arcade/app/src/games/engine.h):
   *   knob ccw          → direction "up"    → shift the piece one lane to y-1
   *   knob cw           → direction "down"  → shift the piece one lane to y+1
   *   Left button held  → direction "left"  → soft drop at 8x while held
   *   Right button down → direction "right" → hard drop
   *   Middle / knob press down → pressedEdge → rotate cw during a run, and the
   *                                            start/replay confirmation elsewhere
   * A knob detent is a discrete event with no release, so "up"/"down"/"right"
   * only act on their rising edge: holding the arrow key is one detent, exactly
   * as one turn of the knob is. "left" is a real button on the device and keeps
   * both edges, so it is read as a held state.
   * Returns whether this tick carried a confirmation press.
   */
  private applyInput(input: GameInput): boolean {
    const direction = input.direction;
    const previous = this.heldDirection;
    this.heldDirection = direction;

    if (this.phase === "playing") {
      // The firmware drops Left edges that arrive outside a run, so a key
      // already held when the run starts does not latch the soft drop.
      if (direction === "left" && previous !== "left") this.softHeld = true;
      else if (previous === "left" && direction !== "left") this.softHeld = false;
      if (direction !== previous) {
        if (direction === "up") this.tryShift(-1);
        else if (direction === "down") this.tryShift(1);
        else if (direction === "right") this.hardDrop();
      }
    }
    if (!input.pressedEdge) return false;
    // A hard drop above may have just ended the run — re-read the phase.
    if (this.phase !== "playing") return true;
    this.tryRotate();
    return false;
  }

  private reset(): void {
    this.board.fill(-1);
    this.score = 0;
    this.cleared = 0;
    this.phase = "ready";
    this.dropMs = 0;
    this.elapsedMs = 0;
    this.overMs = 0;
    this.flashMs = 0;
    this.flashCells = [];
    this.softHeld = false;
    this.heldDirection = null;
    this.nextPiece = this.random.pick(7);
    this.spawn();
  }

  private fits(piece: number, rotation: number, px: number, py: number): boolean {
    for (const [cx, cy] of PIECE_CELLS[piece]![rotation]!) {
      const gx = px + cx;
      const gy = py + cy;
      if (gx < 0 || gx >= TETRIS_WELL_DEPTH || gy < 0 || gy >= TETRIS_WELL_WIDTH) return false;
      if (this.cellAt(gx, gy) >= 0) return false;
    }
    return true;
  }

  private spawn(): void {
    this.piece = this.nextPiece;
    this.nextPiece = this.random.pick(7);
    this.rotation = 0;
    this.pieceX = TETRIS_SPAWN_X;
    this.pieceY = TETRIS_SPAWN_Y;
    if (!this.fits(this.piece, this.rotation, this.pieceX, this.pieceY)) {
      // Stack reached the entry zone (screen x=47): spawn fails.
      this.phase = "game-over";
      this.overMs = 0;
    }
  }

  private lockPiece(flash: boolean): void {
    this.flashCells = [];
    for (const [cx, cy] of PIECE_CELLS[this.piece]![this.rotation]!) {
      const gx = this.pieceX + cx;
      const gy = this.pieceY + cy;
      this.board[gx * TETRIS_WELL_WIDTH + gy] = this.piece;
      this.flashCells.push([gx, gy]);
    }
    if (flash) this.flashMs = FLASH_MS;
    else this.flashCells = [];
    // A clear shifts everything right of the gap leftwards, which would leave
    // the landing flash painted at stale coordinates — the clear itself is
    // feedback enough, so drop the flash on those locks.
    if (this.clearFullColumns() > 0) {
      this.flashCells = [];
      this.flashMs = 0;
    }
    this.spawn();
  }

  /** Returns the number of cleared columns. */
  private clearFullColumns(): number {
    const full: boolean[] = [];
    let n = 0;
    for (let x = 0; x < TETRIS_WELL_DEPTH; x += 1) {
      full[x] = true;
      for (let y = 0; y < TETRIS_WELL_WIDTH; y += 1) {
        if (this.cellAt(x, y) < 0) {
          full[x] = false;
          break;
        }
      }
      if (full[x]) n += 1;
    }
    if (n === 0) return 0;

    this.score += TETRIS_CLEAR_SCORES[Math.min(n - 1, 3)]! * this.level();  // pre-clear level
    this.cleared += n;

    // Compact toward the floor: everything right of a cleared column moves one
    // column left.
    let dst = 0;
    for (let src = 0; src < TETRIS_WELL_DEPTH; src += 1) {
      if (full[src]) continue;
      if (dst !== src) {
        for (let y = 0; y < TETRIS_WELL_WIDTH; y += 1) {
          this.board[dst * TETRIS_WELL_WIDTH + y] = this.cellAt(src, y);
        }
      }
      dst += 1;
    }
    for (; dst < TETRIS_WELL_DEPTH; dst += 1) {
      for (let y = 0; y < TETRIS_WELL_WIDTH; y += 1) this.board[dst * TETRIS_WELL_WIDTH + y] = -1;
    }
    return n;
  }

  private tryShift(dy: number): void {
    if (this.fits(this.piece, this.rotation, this.pieceX, this.pieceY + dy)) this.pieceY += dy;
  }

  private tryRotate(): void {
    const next = (this.rotation + 1) & 3;
    for (const [dx, dy] of ROTATION_KICKS) {
      const px = this.pieceX + dx;
      const py = this.pieceY + dy;
      if (!this.fits(this.piece, next, px, py)) continue;
      this.rotation = next;
      this.pieceX = px;
      this.pieceY = py;
      return;
    }
  }

  private hardDrop(): void {
    while (this.fits(this.piece, this.rotation, this.pieceX - 1, this.pieceY)) this.pieceX -= 1;
    this.lockPiece(true);
  }

  private blink(periodMs: number): boolean {
    return Math.floor(this.elapsedMs / periodMs) % 2 === 0;
  }

  private renderWalls(ctx: PixelDrawContext): void {
    // Dark-tier outline: floor column at screen x=7, rails at y=2 and y=13.
    ctx.fillStyle = WALL;
    for (let y = 2; y <= 13; y += 1) ctx.fillRect(7, y, 1, 1);
    for (let x = 7; x <= 47; x += 1) {
      ctx.fillRect(x, 2, 1, 1);
      ctx.fillRect(x, 13, 1, 1);
    }
  }

  private renderHud(ctx: PixelDrawContext): void {
    // 7px side panel (x=0..6): 'N' label, next-piece 4x4 thumb, level digits.
    // ("NEXT" is 15px wide in the 3x5 font and cannot fit — abbreviated.)
    drawText(ctx, "N", 0, 0, HUD_LABEL);
    ctx.fillStyle = TETRIS_PIECE_COLORS[this.nextPiece]!;
    for (const [cx, cy] of PIECE_CELLS[this.nextPiece]![0]!) {
      ctx.fillRect(1 + cx, 6 + cy, 1, 1);
    }
    // Centred in the 7px panel; 3x5 widths are 4n-1, so the halving is exact
    // and matches the firmware's integer division even when it goes negative.
    const levelText = String(this.level());
    drawText(ctx, levelText, (7 - textWidth(levelText)) / 2, 11, HUD_LEVEL);
  }

  private renderGameOver(ctx: PixelDrawContext): void {
    drawCenteredText(ctx, "OVER", 1, TITLE);
    drawCenteredText(ctx, `${this.score} L${this.cleared}`, 9, SCORE);
    if (this.overMs < RESTART_LOCK_MS || !this.blink(420)) return;
    ctx.fillStyle = PROMPT;
    for (let x = 0; x < GAME_SCREEN_WIDTH; x += 2) ctx.fillRect(x, GAME_SCREEN_HEIGHT - 1, 1, 1);
  }
}

export function createTetrisGame(options: TetrisOptions = {}): TetrisGame {
  return new TetrisGame(options);
}
