import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGameSocketHub,
  DOODLE_PIXEL_COUNT,
  type GameSocketHub,
  type GameSocketHubOptions,
} from "../src/game-socket.ts";
import { connectRoomSocket, gameSocketUrl } from "../web/src/lib/game-socket.ts";

// Every test spins up its own hub behind a real Bun.serve on a random port and
// drives it with Bun's WebSocket client — the production 43820 service and the
// real .runtime/ directory are never touched.

interface TestServer {
  hub: GameSocketHub;
  origin: string;
  wsOrigin: string;
  doodlePath: string;
  url(room: string, role: string): string;
}

const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function startServer(options: Partial<GameSocketHubOptions> = {}): Promise<TestServer> {
  const directory = await mkdtemp(join(tmpdir(), "game-socket-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const doodlePath = options.doodlePath ?? join(directory, "doodle.json");
  const hub = await createGameSocketHub({ ...options, doodlePath });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      const upgrade = hub.handleUpgrade(request, bunServer);
      if (upgrade.matched) return upgrade.response;
      return new Response("not found", { status: 404 });
    },
    websocket: hub.websocket,
  });
  cleanups.push(async () => {
    await hub.stop();
    server.stop(true);
  });
  return {
    hub,
    origin: `http://127.0.0.1:${server.port}`,
    wsOrigin: `ws://127.0.0.1:${server.port}`,
    doodlePath,
    url: (room, role) => `ws://127.0.0.1:${server.port}/api/game/socket?room=${room}&role=${role}`,
  };
}

async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

interface Probe {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  closed: boolean;
  send(message: Record<string, unknown>): void;
  /** Wait for (and consume) the first buffered message matching the predicate. */
  next(what: string, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

function openProbe(url: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const probe: Probe = {
      ws,
      messages: [],
      closed: false,
      send: (message) => ws.send(JSON.stringify(message)),
      next: (what, predicate) => waitFor(() => {
        const index = probe.messages.findIndex(predicate);
        if (index < 0) return undefined;
        return probe.messages.splice(index, 1)[0]!;
      }, what),
    };
    const timer = setTimeout(() => reject(new Error(`timed out opening ${url}`)), 2_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      cleanups.push(() => ws.close());
      resolve(probe);
    });
    ws.addEventListener("close", (event) => {
      probe.closed = true;
      clearTimeout(timer);
      reject(new Error(`closed before open (code ${event.code})`));
    });
    ws.addEventListener("message", (event) => {
      try {
        probe.messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch {
        // Non-JSON frames are not part of the protocol.
      }
    });
    ws.addEventListener("error", () => undefined);
  });
}

/** Resolves true when the handshake is refused before the socket ever opens. */
function connectionRejected(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let opened = false;
    const timer = setTimeout(() => resolve(false), 2_000);
    ws.addEventListener("open", () => {
      opened = true;
      ws.close();
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve(!opened);
    });
    ws.addEventListener("error", () => undefined);
  });
}

describe("game socket rooms", () => {
  test("validates upgrade requests and falls through on other paths", async () => {
    const t = await startServer();
    expect((await fetch(`${t.origin}/api/game/socket?room=toolong&role=host`)).status).toBe(400);
    expect((await fetch(`${t.origin}/api/game/socket?room=ab!2&role=host`)).status).toBe(400);
    expect((await fetch(`${t.origin}/api/game/socket?room=ab12&role=judge`)).status).toBe(400);
    expect((await fetch(`${t.origin}/api/game/socket?role=host`)).status).toBe(400);
    // Valid parameters but a plain GET without the WebSocket handshake:
    expect((await fetch(`${t.origin}/api/game/socket?room=ab12&role=host`)).status).toBe(400);
    // Unrelated paths are not consumed by the hub:
    expect((await fetch(`${t.origin}/api/state`)).status).toBe(404);
    // Failed upgrades must release their reserved slot again.
    expect(t.hub.roomCount()).toBe(0);
  });

  test("relays pad input to the host and host state to the pads verbatim", async () => {
    const t = await startServer();
    const host = await openProbe(t.url("ab12", "host"));
    const pad = await openProbe(t.url("ab12", "pad"));

    // Server-authored membership notes reach both sides.
    await host.next("host peers note", (m) => m.type === "peers" && m.pads === 1);
    await pad.next("pad peers note", (m) => m.type === "peers" && m.host === true);

    pad.send({ type: "input", y: 0.25 });
    const input = await host.next("relayed input", (m) => m.type === "input");
    expect(input.y).toBe(0.25);

    host.send({ type: "state", phase: "playing", score: 3 });
    const state = await pad.next("relayed state", (m) => m.type === "state");
    expect(state).toEqual({ type: "state", phase: "playing", score: 3 });

    // A second pad reaches the host, but pads never hear each other.
    const pad2 = await openProbe(t.url("ab12", "pad"));
    pad2.send({ type: "input", y: 0.9 });
    await host.next("second pad input", (m) => m.type === "input" && m.y === 0.9);
    expect(pad.messages.some((m) => m.type === "input")).toBe(false);
  });

  test("caps a room at one host and two pads with 409s", async () => {
    const t = await startServer();
    await openProbe(t.url("ab12", "host"));
    expect((await fetch(`${t.origin}/api/game/socket?room=ab12&role=host`)).status).toBe(409);
    expect(await connectionRejected(t.url("ab12", "host"))).toBe(true);
    await openProbe(t.url("ab12", "pad"));
    await openProbe(t.url("ab12", "pad"));
    expect((await fetch(`${t.origin}/api/game/socket?room=ab12&role=pad`)).status).toBe(409);
    expect(await connectionRejected(t.url("ab12", "pad"))).toBe(true);
    // Other rooms are unaffected, and codes are case-insensitive.
    await openProbe(t.url("CD34", "host"));
    expect(t.hub.roomCount()).toBe(2);
  });

  test("frees slots on disconnect and drops empty rooms", async () => {
    const t = await startServer();
    const host = await openProbe(t.url("ab12", "host"));
    const pad = await openProbe(t.url("ab12", "pad"));
    host.ws.close();
    // The surviving pad hears that the host left…
    await pad.next("host left note", (m) => m.type === "peers" && m.host === false);
    // …and the freed slot accepts a new host immediately.
    await openProbe(t.url("ab12", "host"));
    await pad.next("host back note", (m) => m.type === "peers" && m.host === true);
    pad.ws.close();
    await waitFor(
      () => (t.hub.roomCount() === 1 ? true : undefined),
      "pad slot release",
    );
  });

  test("recycles rooms that stay silent past the idle window", async () => {
    const t = await startServer({ idleMs: 120, sweepIntervalMs: 25 });
    const host = await openProbe(t.url("ab12", "host"));
    const pad = await openProbe(t.url("ab12", "pad"));
    await waitFor(() => (host.closed && pad.closed ? true : undefined), "idle recycle");
    expect(t.hub.roomCount()).toBe(0);
  });
});

describe("doodle wall room", () => {
  test("sends the authoritative snapshot on join and broadcasts strokes", async () => {
    const t = await startServer();
    const first = await openProbe(t.url("draw", "pad"));
    const blank = await first.next("blank snapshot", (m) => m.type === "snapshot");
    expect(blank.pixels).toHaveLength(DOODLE_PIXEL_COUNT);
    expect((blank.pixels as number[]).every((pixel) => pixel === 0)).toBe(true);

    first.send({ type: "stroke", x: 5, y: 3, color: 0xff3030 });
    await waitFor(
      () => (t.hub.doodlePixels()[3 * 52 + 5] === 0xff3030 ? true : undefined),
      "stroke applied",
    );

    // Late joiners receive the stroke inside their snapshot.
    const second = await openProbe(t.url("draw", "host"));
    const caughtUp = await second.next("join snapshot", (m) => m.type === "snapshot");
    expect((caughtUp.pixels as number[])[3 * 52 + 5]).toBe(0xff3030);

    // Broadcast goes to the other members, never back to the sender.
    second.send({ type: "stroke", x: 5, y: 3, color: null });
    const erased = await first.next("erase broadcast", (m) => m.type === "stroke");
    expect(erased).toEqual({ type: "stroke", x: 5, y: 3, color: null });
    expect(t.hub.doodlePixels()[3 * 52 + 5]).toBe(0);
    expect(second.messages.some((m) => m.type === "stroke")).toBe(false);

    // Out-of-range or malformed strokes are ignored.
    second.send({ type: "stroke", x: 99, y: 0, color: 1 });
    second.send({ type: "stroke", x: 1.5, y: 2, color: 1 });
    second.send({ type: "stroke", x: 1, y: 2, color: 0x1000000 });
    await Bun.sleep(30);
    expect(t.hub.doodlePixels()[2 * 52 + 1]).toBe(0);

    // A full snapshot from a client replaces the wall and reaches the others.
    const wall = new Array<number>(DOODLE_PIXEL_COUNT).fill(0);
    wall[10] = 0xffffff;
    second.send({ type: "snapshot", pixels: wall });
    const replaced = await first.next(
      "snapshot broadcast",
      (m) => m.type === "snapshot" && (m.pixels as number[])[10] === 0xffffff,
    );
    expect((replaced.pixels as number[])).toHaveLength(DOODLE_PIXEL_COUNT);
    expect(t.hub.doodlePixels()[10]).toBe(0xffffff);
  });

  test("persists the wall debounced and atomically, then reloads it", async () => {
    const t = await startServer({ persistDelayMs: 40 });
    const guest = await openProbe(t.url("draw", "pad"));
    await guest.next("snapshot", (m) => m.type === "snapshot");
    guest.send({ type: "stroke", x: 2, y: 1, color: 0x123456 });
    await waitFor(async () => {
      try {
        const raw = JSON.parse(await readFile(t.doodlePath, "utf8")) as { pixels: number[] };
        return raw.pixels[52 + 2] === 0x123456 ? true : undefined;
      } catch {
        return undefined;
      }
    }, "debounced persist");
    // temp+rename leaves no straggler files next to the target.
    const directory = t.doodlePath.slice(0, t.doodlePath.lastIndexOf("/"));
    expect(await readdir(directory)).toEqual(["doodle.json"]);

    // A fresh hub on the same file serves the stored wall to new joiners.
    const reloaded = await startServer({ doodlePath: t.doodlePath });
    const late = await openProbe(reloaded.url("draw", "pad"));
    const snapshot = await late.next("restored snapshot", (m) => m.type === "snapshot");
    expect((snapshot.pixels as number[])[52 + 2]).toBe(0x123456);
  });

  test("stop() flushes a pending debounce before shutdown", async () => {
    const t = await startServer({ persistDelayMs: 60_000 });
    const guest = await openProbe(t.url("draw", "pad"));
    await guest.next("snapshot", (m) => m.type === "snapshot");
    guest.send({ type: "stroke", x: 0, y: 0, color: 0xabcdef });
    await waitFor(
      () => (t.hub.doodlePixels()[0] === 0xabcdef ? true : undefined),
      "stroke applied",
    );
    await t.hub.stop();
    const raw = JSON.parse(await readFile(t.doodlePath, "utf8")) as { pixels: number[] };
    expect(raw.pixels[0]).toBe(0xabcdef);
  });

  test("the doodle canvas survives an idle-room recycle", async () => {
    const t = await startServer({ idleMs: 100, sweepIntervalMs: 25 });
    const guest = await openProbe(t.url("draw", "pad"));
    await guest.next("snapshot", (m) => m.type === "snapshot");
    guest.send({ type: "stroke", x: 7, y: 7, color: 0x00ff66 });
    await waitFor(() => (guest.closed ? true : undefined), "idle recycle");
    expect(t.hub.roomCount()).toBe(0);
    const back = await openProbe(t.url("draw", "pad"));
    const snapshot = await back.next("post-recycle snapshot", (m) => m.type === "snapshot");
    expect((snapshot.pixels as number[])[7 * 52 + 7]).toBe(0x00ff66);
  });
});

describe("web room socket client", () => {
  test("builds the relay url from an explicit origin", () => {
    expect(gameSocketUrl("ab12", "pad", "ws://192.168.1.9:43820"))
      .toBe("ws://192.168.1.9:43820/api/game/socket?room=ab12&role=pad");
  });

  test("exchanges messages with the relay and stops cleanly on dispose", async () => {
    const t = await startServer();
    const received: Record<string, unknown>[] = [];
    let online = false;
    const host = connectRoomSocket({
      room: "ef56",
      role: "host",
      origin: t.wsOrigin,
      reconnectDelayMs: 50,
      onMessage: (message) => received.push(message),
      onOpenChange: (connected) => {
        online = connected;
      },
    });
    cleanups.push(() => host.dispose());
    await waitFor(() => (online ? true : undefined), "host open");

    const pad = await openProbe(t.url("ef56", "pad"));
    pad.send({ type: "input", y: 0.5 });
    await waitFor(
      () => received.find((m) => m.type === "input" && m.y === 0.5),
      "input arrives at host",
    );

    expect(host.send({ type: "state", phase: "ready", score: 0 })).toBe(true);
    const state = await pad.next("state arrives at pad", (m) => m.type === "state");
    expect(state.phase).toBe("ready");

    host.dispose();
    expect(host.send({ type: "state", phase: "ready", score: 0 })).toBe(false);
    // The pad hears the host leave, and the host must not auto-reconnect:
    // drop everything buffered so far, then watch for a fresh "host is back".
    await pad.next("host left", (m) => m.type === "peers" && m.host === false);
    pad.messages.length = 0;
    await Bun.sleep(150);
    expect(pad.messages.some((m) => m.type === "peers" && m.host === true)).toBe(false);
  });
});
