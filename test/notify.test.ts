import { describe, expect, test } from "bun:test";
import { createControlHandler } from "../src/control-api.ts";
import type { WorkspaceController } from "../src/workspace-controller.ts";
import {
  NotifyManager,
  parseNotifyMessage,
  renderNotifyMessage,
  type NotifyMessage,
} from "../src/notify.ts";
import { cjkTextWidth } from "../src/pixel-cjk.ts";
import { glyphCellWidth, glyphRows } from "../web/src/lib/pixel-glyphs.ts";

const controller = {} as WorkspaceController;

function notifyRequest(body: unknown, token?: string): Request {
  return new Request("http://clock.test:43820/api/notify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://external.example",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("webhook notifications", () => {
  test("validates defaults and renders a centered CJK glyph bitmap", () => {
    const input = parseNotifyMessage({ message: "外卖" });
    expect(input).toEqual({
      message: "外卖",
      color: "#00ff66",
      background: "#000000",
      fontScale: 2,
      speed: 12,
      holdSeconds: 45,
    });

    const animation = renderNotifyMessage(input);
    expect(animation.frames).toHaveLength(1);
    expect(cjkTextWidth(input.message)).toBe(24);
    const canvas = animation.frames[0]!;
    let cellX = Math.floor((52 - cjkTextWidth(input.message)) / 2);
    for (const character of input.message) {
      const codepoint = character.codePointAt(0)!;
      const width = glyphCellWidth(codepoint);
      const rows = glyphRows(codepoint)!;
      for (let row = 0; row < rows.length; row += 1) {
        for (let column = 0; column < width; column += 1) {
          const lit = (rows[row]! >> (width - 1 - column)) & 1;
          expect(canvas.getPixel(cellX + column, row + 2)).toEqual(
            lit ? [0, 255, 102] : [0, 0, 0]
          );
        }
      }
      cellX += width;
    }
  });

  test("bounds scrolling frames and replaces the automatic cleanup timer", async () => {
    const payloads: Array<{ duration: number; image: Array<{ data: string }> }> = [];
    const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
    let clears = 0;
    const manager = new NotifyManager({
      pushPayload: async (payload) => {
        payloads.push(payload as never);
        return { status: 200 };
      },
      clearApp: async () => {
        clears += 1;
        return { status: 200 };
      },
      schedule: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false };
        timers.push(timer);
        return timer;
      },
      cancel: (handle) => {
        (handle as typeof timers[number]).cancelled = true;
      },
    });
    const longMessage = parseNotifyMessage({
      message: "这是一条需要滚动显示的中文通知",
      speed: 4,
      holdSeconds: 5,
    });
    const animation = renderNotifyMessage(longMessage);
    expect(animation.frames.length).toBeGreaterThan(1);
    expect(animation.frames.length).toBeLessThanOrEqual(120);

    await manager.push(longMessage);
    expect(payloads[0]?.duration).toBe(5);
    expect(payloads[0]?.image[0]?.data).toStartWith("data:image/gif;base64,");
    expect(timers[0]?.delayMs).toBe(5_000);

    await manager.push(parseNotifyMessage({ message: "新的通知", holdSeconds: 6 }));
    expect(timers[0]?.cancelled).toBe(true);
    expect(timers[1]?.delayMs).toBe(6_000);
    timers[1]!.callback();
    await Promise.resolve();
    expect(clears).toBe(1);
  });

  test("accepts cross-origin token auth and rejects invalid notification fields", async () => {
    const pushed: NotifyMessage[] = [];
    let cleared = 0;
    const handler = createControlHandler(controller, {
      notifyToken: "secret",
      notify: {
        push: async (input) => {
          pushed.push(input);
          return { status: 200 };
        },
        clear: async () => {
          cleared += 1;
          return { status: 200 };
        },
      },
    });

    expect((await handler(notifyRequest({ message: "外卖到了" }))).status).toBe(401);
    const accepted = await handler(notifyRequest({ message: "外卖到了", holdSeconds: 9 }, "secret"));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, holdSeconds: 9 });
    expect(pushed[0]?.message).toBe("外卖到了");

    const queryToken = await handler(new Request(
      "http://clock.test:43820/api/notify?token=secret",
      {
        method: "DELETE",
        headers: { Origin: "https://external.example" },
      },
    ));
    expect(queryToken.status).toBe(200);
    expect(cleared).toBe(1);

    for (const body of [
      {},
      { message: "x".repeat(97) },
      { message: "x", holdSeconds: 4 },
      { message: "x", holdSeconds: 301 },
      { message: "x", fontScale: 3 },
    ]) {
      expect((await handler(notifyRequest(body, "secret"))).status).toBe(400);
    }
  });

  test("limits a burst to six accepted notifications per token bucket", async () => {
    let now = 1_000;
    let pushes = 0;
    const handler = createControlHandler(controller, {
      notifyNow: () => now,
      notify: {
        push: async () => {
          pushes += 1;
          return { status: 200 };
        },
        clear: async () => ({ status: 200 }),
      },
    });
    for (let index = 0; index < 6; index += 1) {
      expect((await handler(notifyRequest({ message: `通知 ${index}` }))).status).toBe(200);
    }
    expect((await handler(notifyRequest({ message: "第七条" }))).status).toBe(429);
    expect(pushes).toBe(6);

    now += 10_000;
    expect((await handler(notifyRequest({ message: "下一轮" }))).status).toBe(200);
  });

  test("refuses instead of writing into ZOS, and a refusal costs no rate budget", async () => {
    let now = 1_000;
    let pushes = 0;
    let clears = 0;
    let suspended = true;
    const handler = createControlHandler(controller, {
      notifyNow: () => now,
      notifyToken: "secret",
      notify: {
        push: async () => {
          pushes += 1;
          return { status: 200 };
        },
        clear: async () => {
          clears += 1;
          return { status: 200 };
        },
        suspended: () => suspended,
      },
    });

    // The short message is the one that used to lie: under ZOS the provisioning
    // page answers it with the config page and HTTP 200, so the caller saw
    // {ok:true} for pixels that never reached a screen.
    const refused = await handler(notifyRequest({ message: "构建失败" }, "secret"));
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: "the clock is running ZOS, which has no notification receiver",
    });
    expect((await handler(new Request(
      "http://clock.test:43820/api/notify?token=secret",
      { method: "DELETE", headers: { Origin: "https://external.example" } },
    ))).status).toBe(503);
    expect(pushes).toBe(0);
    expect(clears).toBe(0);

    // Auth is still decided first: a refusal must not tell an unauthenticated
    // caller what firmware the device is running.
    expect((await handler(notifyRequest({ message: "构建失败" }))).status).toBe(401);

    // Six refusals in the same 10s window, then a real one — the bucket was
    // never touched, so the accepted push is not a 429.
    for (let index = 0; index < 6; index += 1) {
      expect((await handler(notifyRequest({ message: `重试 ${index}` }, "secret"))).status).toBe(503);
    }
    suspended = false;
    const accepted = await handler(notifyRequest({ message: "构建失败" }, "secret"));
    expect(accepted.status).toBe(200);
    expect(pushes).toBe(1);
  });
});
