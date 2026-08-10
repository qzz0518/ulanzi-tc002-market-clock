// Browser client for the /api/game/socket relay (pixel-playground.md §6/§7).
// One tiny wrapper gives the game shell (Pong host) and the studio canvas
// (doodle host) identical connect/reconnect/JSON semantics, and the socket
// factory is injectable so bun tests can point it at an in-test Bun.serve.

export const GAME_SOCKET_PATH = "/api/game/socket";
const DEFAULT_RECONNECT_DELAY_MS = 2_000;

export type RoomRole = "host" | "pad";

export interface RoomSocketOptions {
  room: string;
  role: RoomRole;
  /** Parsed JSON payloads only; malformed frames are dropped silently. */
  onMessage: (message: Record<string, unknown>) => void;
  /** Fires with true on open and false on close (before any reconnect). */
  onOpenChange?: (connected: boolean) => void;
  /** ws(s) endpoint base, e.g. "ws://192.168.1.2:43820"; defaults to this page. */
  origin?: string;
  reconnectDelayMs?: number;
  makeSocket?: (url: string) => WebSocket;
}

export interface RoomSocket {
  /** Serialize and send; returns false while the socket is not open. */
  send(message: Record<string, unknown>): boolean;
  connected(): boolean;
  dispose(): void;
}

export function gameSocketUrl(room: string, role: RoomRole, origin?: string): string {
  const base = origin
    ?? (typeof location !== "undefined" ? location.origin.replace(/^http/, "ws") : "");
  return `${base}${GAME_SOCKET_PATH}?room=${encodeURIComponent(room)}&role=${role}`;
}

export function connectRoomSocket(options: RoomSocketOptions): RoomSocket {
  const makeSocket = options.makeSocket ?? ((url: string) => new WebSocket(url));
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const connect = (): void => {
    if (disposed) return;
    const attempt = makeSocket(gameSocketUrl(options.room, options.role, options.origin));
    socket = attempt;
    attempt.onopen = () => {
      if (disposed) return;
      options.onOpenChange?.(true);
    };
    attempt.onmessage = (event: MessageEvent) => {
      if (disposed || typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        options.onMessage(parsed as Record<string, unknown>);
      }
    };
    // A rejected upgrade (room full) surfaces as error+close; keep retrying on
    // the same cadence — the slot may free up when the other page leaves.
    attempt.onclose = () => {
      if (socket !== attempt) return;
      socket = null;
      if (disposed) return;
      options.onOpenChange?.(false);
      retryTimer = setTimeout(connect, reconnectDelayMs);
    };
    attempt.onerror = () => undefined;
  };

  connect();

  return {
    send(message) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    connected() {
      return socket?.readyState === WebSocket.OPEN;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const current = socket;
      socket = null;
      current?.close();
    },
  };
}
