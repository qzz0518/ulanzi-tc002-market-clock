import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServerWebSocket, WebSocketHandler } from "bun";

// WebSocket rooms for the arcade gamepad and the doodle wall.
// Design: docs/design/pixel-playground.md §6 (relay + rooms) and §7 (doodle).
//
// Game rooms are a pure relay: pad messages go to the host, host messages go
// to the pads, and the server never interprets the payload. The doodle room
// ("draw") is the one stateful exception — the server owns the authoritative
// 52×16 canvas so late joiners can catch up from a snapshot and the wall
// survives restarts via a debounced JSON file.

export const GAME_SOCKET_PATH = "/api/game/socket";
export const DRAW_ROOM = "draw";
export const ROOM_MAX_HOSTS = 1;
export const ROOM_MAX_PADS = 2;
/** The doodle wall has no host/pad roles to enforce, only a sanity ceiling. */
export const DRAW_ROOM_MAX_MEMBERS = 16;
export const ROOM_IDLE_MS = 10 * 60_000;
export const DOODLE_PERSIST_DELAY_MS = 30_000;
export const DOODLE_WIDTH = 52;
export const DOODLE_HEIGHT = 16;
export const DOODLE_PIXEL_COUNT = DOODLE_WIDTH * DOODLE_HEIGHT;
/** Covers a full doodle snapshot (~7KB) with headroom; larger frames are dropped. */
const MAX_MESSAGE_CHARS = 40_000;
const ROOM_CODE_PATTERN = /^[a-z0-9]{4}$/;

export type GameSocketRole = "host" | "pad";

export interface GameSocketData {
  room: string;
  role: GameSocketRole;
}

interface Room {
  code: string;
  /** Slot reservations made at upgrade time; sockets join the set on open. */
  hosts: number;
  pads: number;
  sockets: Set<ServerWebSocket<GameSocketData>>;
  lastActiveAt: number;
}

export interface GameSocketUpgradeResult {
  /** True when the request targeted the socket path and was consumed here. */
  matched: boolean;
  /** Rejection response; undefined after a successful upgrade. */
  response?: Response;
}

/** The slice of Bun.Server the hub needs, kept structural so tests can stub it. */
export interface GameSocketServer {
  upgrade(request: Request, options: { data: GameSocketData }): boolean;
}

export interface GameSocketHubOptions {
  doodlePath?: string;
  idleMs?: number;
  sweepIntervalMs?: number;
  persistDelayMs?: number;
  now?: () => number;
  onError?: (scope: string, error: unknown) => void;
}

export interface GameSocketHub {
  handleUpgrade(request: Request, server: GameSocketServer): GameSocketUpgradeResult;
  websocket: WebSocketHandler<GameSocketData>;
  roomCount(): number;
  /** Current authoritative doodle canvas (copy). */
  doodlePixels(): number[];
  /** Close every socket, flush the doodle canvas to disk, and stop timers. */
  stop(): Promise<void>;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function sanitizePixel(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff
    ? value
    : 0;
}

function sanitizeCanvas(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== DOODLE_PIXEL_COUNT) return null;
  return value.map(sanitizePixel);
}

function isCellCoordinate(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < limit;
}

export async function createGameSocketHub(
  options: GameSocketHubOptions = {},
): Promise<GameSocketHub> {
  const doodlePath = options.doodlePath ?? ".runtime/doodle.json";
  const idleMs = options.idleMs ?? ROOM_IDLE_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  const persistDelayMs = options.persistDelayMs ?? DOODLE_PERSIST_DELAY_MS;
  const now = options.now ?? (() => Date.now());
  const reportError = options.onError ?? (() => undefined);

  const rooms = new Map<string, Room>();

  // --- Doodle canvas: load once at startup, hold in memory forever after. ---
  let doodle: number[] = new Array<number>(DOODLE_PIXEL_COUNT).fill(0);
  try {
    const raw = JSON.parse(await readFile(doodlePath, "utf8")) as { pixels?: unknown };
    const stored = sanitizeCanvas(Array.isArray(raw) ? raw : raw?.pixels);
    if (stored) doodle = stored;
  } catch {
    // Missing or corrupt file → a blank wall, never a failed service.
  }

  let doodleDirty = false;
  let doodleTimer: ReturnType<typeof setTimeout> | null = null;
  let doodleWriteQueue: Promise<unknown> = Promise.resolve();

  const flushDoodle = (): Promise<void> => {
    if (!doodleDirty) return Promise.resolve();
    doodleDirty = false;
    const payload = `${JSON.stringify({ pixels: doodle })}\n`;
    const write = async () => {
      // temp+rename atomic write, same pattern as WorkspaceStore.
      await mkdir(dirname(doodlePath), { recursive: true });
      const temporaryPath = `${doodlePath}.${process.pid}.tmp`;
      await Bun.write(temporaryPath, payload);
      await rename(temporaryPath, doodlePath);
    };
    const result = doodleWriteQueue.then(write, write);
    doodleWriteQueue = result.catch(() => undefined);
    return result.catch((error) => reportError("doodle_persist", error));
  };

  // Trailing throttle: the first stroke schedules a write, further strokes ride
  // along, so a busy wall persists at most once per window with the latest state.
  const scheduleDoodlePersist = (): void => {
    doodleDirty = true;
    if (doodleTimer) return;
    doodleTimer = setTimeout(() => {
      doodleTimer = null;
      void flushDoodle();
    }, persistDelayMs);
    doodleTimer.unref?.();
  };

  // --- Room bookkeeping. ---
  const releaseSlot = (room: Room, role: GameSocketRole): void => {
    if (role === "host") room.hosts = Math.max(0, room.hosts - 1);
    else room.pads = Math.max(0, room.pads - 1);
    if (room.hosts === 0 && room.pads === 0 && room.sockets.size === 0) {
      rooms.delete(room.code);
    }
  };

  const broadcast = (
    room: Room,
    payload: string,
    except?: ServerWebSocket<GameSocketData>,
  ): void => {
    for (const socket of room.sockets) {
      if (socket !== except) socket.send(payload);
    }
  };

  const openPeers = (room: Room): { hosts: number; pads: number } => {
    let hosts = 0;
    let pads = 0;
    for (const socket of room.sockets) {
      if (socket.data.role === "host") hosts += 1;
      else pads += 1;
    }
    return { hosts, pads };
  };

  // Membership changes are the one server-authored message: /pad needs "is the
  // host there?" and the host needs "did a pad join?" without heartbeat traffic.
  const announcePeers = (room: Room): void => {
    const peers = openPeers(room);
    const payload = room.code === DRAW_ROOM
      ? JSON.stringify({ type: "peers", count: peers.hosts + peers.pads })
      : JSON.stringify({ type: "peers", host: peers.hosts > 0, pads: peers.pads });
    broadcast(room, payload);
  };

  const handleDrawMessage = (
    ws: ServerWebSocket<GameSocketData>,
    room: Room,
    raw: string,
  ): void => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "stroke") {
      if (!isCellCoordinate(message.x, DOODLE_WIDTH)) return;
      if (!isCellCoordinate(message.y, DOODLE_HEIGHT)) return;
      const color = message.color === null ? null : sanitizePixel(message.color);
      doodle[message.y * DOODLE_WIDTH + message.x] = color ?? 0;
      scheduleDoodlePersist();
      broadcast(
        room,
        JSON.stringify({ type: "stroke", x: message.x, y: message.y, color }),
        ws,
      );
      return;
    }
    if (message.type === "snapshot") {
      // Bulk edits from the studio board (clear, undo, text, image) replace the
      // canvas wholesale; the wire shape mirrors the join snapshot.
      const pixels = sanitizeCanvas(message.pixels);
      if (!pixels) return;
      doodle = pixels;
      scheduleDoodlePersist();
      broadcast(room, JSON.stringify({ type: "snapshot", pixels: doodle }), ws);
    }
  };

  const sweepTimer = setInterval(() => {
    const cutoff = now() - idleMs;
    for (const room of [...rooms.values()]) {
      if (room.lastActiveAt > cutoff) continue;
      rooms.delete(room.code);
      for (const socket of room.sockets) {
        socket.close(4000, "room idle");
      }
    }
  }, sweepIntervalMs);
  sweepTimer.unref?.();

  let stopped = false;

  return {
    handleUpgrade(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== GAME_SOCKET_PATH) return { matched: false };
      if (stopped) return { matched: true, response: jsonResponse({ error: "service is stopping" }, 503) };
      const roomCode = (url.searchParams.get("room") ?? "").toLowerCase();
      const role = url.searchParams.get("role");
      if (!ROOM_CODE_PATTERN.test(roomCode)) {
        return { matched: true, response: jsonResponse({ error: "room must be 4 letters or digits" }, 400) };
      }
      if (role !== "host" && role !== "pad") {
        return { matched: true, response: jsonResponse({ error: "role must be host or pad" }, 400) };
      }
      let room = rooms.get(roomCode);
      if (!room) {
        // Either role may create the room: a pad that scans the QR while the
        // host page is still reconnecting must not bounce off a 404.
        room = { code: roomCode, hosts: 0, pads: 0, sockets: new Set(), lastActiveAt: now() };
        rooms.set(roomCode, room);
      }
      if (roomCode === DRAW_ROOM) {
        if (room.hosts + room.pads >= DRAW_ROOM_MAX_MEMBERS) {
          return { matched: true, response: jsonResponse({ error: "doodle room is full" }, 409) };
        }
      } else if (role === "host" && room.hosts >= ROOM_MAX_HOSTS) {
        return { matched: true, response: jsonResponse({ error: "room already has a host" }, 409) };
      } else if (role === "pad" && room.pads >= ROOM_MAX_PADS) {
        return { matched: true, response: jsonResponse({ error: "room already has two pads" }, 409) };
      }
      // Reserve before the upgrade so two racing handshakes cannot both pass
      // the capacity check; a failed upgrade releases the slot immediately.
      if (role === "host") room.hosts += 1;
      else room.pads += 1;
      const upgraded = server.upgrade(request, { data: { room: roomCode, role } });
      if (!upgraded) {
        releaseSlot(room, role);
        return { matched: true, response: jsonResponse({ error: "websocket upgrade required" }, 400) };
      }
      return { matched: true };
    },

    websocket: {
      open(ws) {
        const room = rooms.get(ws.data.room);
        if (!room) {
          // The room was recycled between upgrade and open; nothing to join.
          ws.close(4000, "room idle");
          return;
        }
        room.sockets.add(ws);
        room.lastActiveAt = now();
        if (room.code === DRAW_ROOM) {
          ws.send(JSON.stringify({ type: "snapshot", pixels: doodle }));
        }
        announcePeers(room);
      },
      message(ws, raw) {
        const room = rooms.get(ws.data.room);
        if (!room) return;
        room.lastActiveAt = now();
        if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_MESSAGE_CHARS) return;
        if (room.code === DRAW_ROOM) {
          handleDrawMessage(ws, room, raw);
          return;
        }
        // Pure relay: pads speak to hosts, hosts speak to pads, payload opaque.
        for (const peer of room.sockets) {
          if (peer !== ws && peer.data.role !== ws.data.role) peer.send(raw);
        }
      },
      close(ws) {
        const room = rooms.get(ws.data.room);
        if (!room) return;
        room.sockets.delete(ws);
        releaseSlot(room, ws.data.role);
        if (rooms.has(room.code)) announcePeers(room);
      },
    },

    roomCount() {
      return rooms.size;
    },

    doodlePixels() {
      return doodle.slice();
    },

    async stop() {
      stopped = true;
      clearInterval(sweepTimer);
      if (doodleTimer) {
        clearTimeout(doodleTimer);
        doodleTimer = null;
      }
      for (const room of [...rooms.values()]) {
        rooms.delete(room.code);
        for (const socket of room.sockets) {
          socket.close(1001, "server shutting down");
        }
      }
      await flushDoodle();
    },
  };
}
