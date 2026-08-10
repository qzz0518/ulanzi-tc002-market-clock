import { describe, expect, test } from "bun:test";
import { createControlHandler } from "../src/control-api.ts";
import type { DashboardController } from "../src/controller.ts";
import type { ClockPayload } from "../src/display.ts";

const controller = {} as DashboardController;
const pixels = Buffer.alloc(52 * 16 * 3, 48).toString("base64");

describe("generalized live frame channel", () => {
  test("maps a validated app id to live_<app> and clears it", async () => {
    const writes: Array<{ appName: string; payload?: ClockPayload }> = [];
    const handler = createControlHandler(controller, {
      live: {
        push: async (appName, payload) => {
          writes.push({ appName, payload });
          return { status: 200 };
        },
        clear: async (appName) => {
          writes.push({ appName });
          return { status: 200 };
        },
      },
    });
    const pushed = await handler(new Request("http://clock.test:43820/api/live/frames", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://clock.test:43820",
      },
      body: JSON.stringify({
        app: "game",
        frames: [{ delayMs: 30, pixels }],
        holdSeconds: 6,
      }),
    }));
    expect(pushed.status).toBe(204);
    expect(writes[0]?.appName).toBe("live_game");
    expect(writes[0]?.payload?.duration).toBe(6);
    expect(writes[0]?.payload?.image[0]?.data).toStartWith("data:image/png;base64,");

    const cleared = await handler(new Request(
      "http://clock.test:43820/api/live/frames?app=game",
      { method: "DELETE", headers: { Origin: "http://clock.test:43820" } },
    ));
    expect(cleared.status).toBe(204);
    expect(writes[1]).toEqual({ appName: "live_game" });
  });

  test("uses total frame time plus thirty seconds as the default hold", async () => {
    let payload: ClockPayload | undefined;
    const handler = createControlHandler(controller, {
      live: {
        push: async (_appName, next) => {
          payload = next;
          return { status: 200 };
        },
        clear: async () => ({ status: 200 }),
      },
    });
    const response = await handler(new Request("http://clock.test:43820/api/live/frames", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app: "demo2",
        frames: [
          { delayMs: 400, pixels },
          { delayMs: 900, pixels },
        ],
      }),
    }));
    expect(response.status).toBe(204);
    expect(payload?.duration).toBe(32);
    const gif = Buffer.from(payload!.image[0]!.data.replace("data:image/gif;base64,", ""), "base64");
    expect(gif.includes(Buffer.from("NETSCAPE2.0"))).toBe(false);
  });

  test("rejects invalid app ids, malformed frames, and cross-origin writes", async () => {
    let pushes = 0;
    const handler = createControlHandler(controller, {
      live: {
        push: async () => {
          pushes += 1;
          return { status: 200 };
        },
        clear: async () => ({ status: 200 }),
      },
    });
    for (const app of ["Game", "game-over", "1game", "a".repeat(17), "live_game"]) {
      const response = await handler(new Request("http://clock.test:43820/api/live/frames", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app, frames: [{ delayMs: 30, pixels }] }),
      }));
      expect(response.status).toBe(400);
    }
    const malformed = await handler(new Request("http://clock.test:43820/api/live/frames", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "game", frames: [{ delayMs: 19, pixels }] }),
    }));
    expect(malformed.status).toBe(400);

    const crossOrigin = await handler(new Request("http://clock.test:43820/api/live/frames", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://external.example",
      },
      body: JSON.stringify({ app: "game", frames: [{ delayMs: 30, pixels }] }),
    }));
    expect(crossOrigin.status).toBe(400);
    expect(pushes).toBe(0);
  });

  test("service wires live and notify device writes through native fetch", async () => {
    // The measured root cause of v1 game jank: a curl subprocess per device
    // write costs ~170ms while native fetch is ~16ms. Live/notify must inject
    // fetch; channel pushes stay on curl to keep the CLOCK_HTTP_PROXY path.
    const source = await Bun.file(new URL("../src/service.ts", import.meta.url)).text();
    expect(source).toContain("pushClockPayloadNamed(config, appName, payload, fetch)");
    expect(source).toContain("deleteClockApp(config, appName, fetch)");
    expect(source).toContain("pushClockPayloadNamed(config, NOTIFY_APP, payload, fetch)");
    expect(source).toContain("deleteClockApp(config, NOTIFY_APP, fetch)");
    expect(source).toContain(
      "pushPayload: (appName, payload) => pushClockPayloadNamed(config, appName, payload),",
    );
  });

  test("keeps the mirror response while delegating to the shared live writer", async () => {
    const apps: string[] = [];
    const handler = createControlHandler(controller, {
      live: {
        push: async (appName) => {
          apps.push(appName);
          return { status: 201 };
        },
        clear: async (appName) => {
          apps.push(appName);
          return { status: 202 };
        },
      },
    });
    const pushed = await handler(new Request("http://clock.test:43820/api/music/mirror", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames: [{ delayMs: 30, pixels }] }),
    }));
    expect(pushed.status).toBe(200);
    expect(await pushed.json()).toEqual({ mirror: { status: 201, frames: 1 } });
    const cleared = await handler(new Request("http://clock.test:43820/api/music/mirror", {
      method: "DELETE",
    }));
    expect(await cleared.json()).toEqual({ mirror: { status: 202, frames: 0 } });
    expect(apps).toEqual(["music_lyrics", "music_lyrics"]);
  });
});
