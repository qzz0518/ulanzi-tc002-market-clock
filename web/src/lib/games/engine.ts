// Shared contract between the game shell and every game engine.
// Engines are DOM-free and deterministic so `bun test` can drive them directly.
// See docs/design/pixel-playground.md §3.1 — keep this file in sync with it.

export interface GameInput {
  /** 0..52 continuous pointer coordinate for paddle/movement games; null = no pointer. */
  pointerX: number | null;
  /** 0..16 vertical pointer coordinate for games with vertical paddles (pong); null = no pointer. */
  pointerY: number | null;
  /** Whether the primary action key is currently held. */
  pressed: boolean;
  /** A press edge happened since the previous tick; the shell clears it after each tick. */
  pressedEdge: boolean;
  /** Discrete direction input (snake). */
  direction: "up" | "down" | "left" | "right" | null;
  /** 0..16 second-player coordinate injected by the WS gamepad; null = not connected. */
  p2PointerY: number | null;
}

export type GamePhase = "ready" | "playing" | "game-over";

export interface GameHud {
  score: number;
  lives?: number;
  level?: number;
  phase: GamePhase;
  /** Short status line, e.g. a start hint on the ready screen. */
  message?: string;
}

/** 52×16 drawing surface — a compatible subset of CanvasRenderingContext2D. */
export interface PixelDrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

export interface GameEngine {
  readonly meta: {
    id: "breakout" | "flappy" | "snake" | "pong";
    title: string;
    hint: string;
    twoPlayers?: boolean;
  };
  /** Advance the simulation. Implementations clamp dtMs to ≤250ms and use a fixed inner step. */
  tick(dtMs: number, input: GameInput): void;
  /** Draw the current state, including the ready (attract) and game-over screens. */
  render(ctx: PixelDrawContext): void;
  hud(): GameHud;
  restart(): void;
}

export const GAME_SCREEN_WIDTH = 52;
export const GAME_SCREEN_HEIGHT = 16;

export function emptyInput(): GameInput {
  return {
    pointerX: null,
    pointerY: null,
    pressed: false,
    pressedEdge: false,
    direction: null,
    p2PointerY: null,
  };
}
