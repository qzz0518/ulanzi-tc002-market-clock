import { describe, expect, test } from "bun:test";
import {
  ZOS_MIRROR_IDLE_POLL_MS,
  ZOS_MIRROR_POLL_MS,
  ZOS_MIRROR_RGB_BYTES,
  ZOS_STATE_POLL_MS,
  createZosLink,
  decodeMirrorFrame,
  describeDriver,
  describeMirror,
  describeTelemetry,
  formatUptime,
  nextPollDelayMs,
  type ZosMenuEntry,
  type ZosState,
  type ZosTelemetry,
} from "../web/src/lib/zos-link.ts";

const MENU: ZosMenuEntry[] = [
  { id: "btc", label: "市场轮播", kind: "channel" },
  { id: "qqq", label: "QQQ", kind: "channel" },
  { id: "music", label: "音乐", kind: "music" },
];

function telemetry(overrides: Partial<ZosTelemetry> = {}): ZosTelemetry {
  return {
    screen: "launcher",
    focus: "btc",
    wifi: "xiaoya-2.4G",
    ip: "192.168.8.240",
    uptimeMs: 310_501,
    freeKb: 16_568,
    supplicantRestarts: 0,
    receivedAt: 1_000_000,
    ...overrides,
  };
}

function state(overrides: Partial<ZosState> = {}): ZosState {
  return {
    seq: 12,
    menu: MENU,
    display: { focus: null, pinned: false },
    telemetry: telemetry(),
    live: true,
    ...overrides,
  };
}

function base64Frame(fill: (index: number) => number): string {
  let binary = "";
  for (let index = 0; index < ZOS_MIRROR_RGB_BYTES; index += 1) {
    binary += String.fromCharCode(fill(index) & 0xff);
  }
  return btoa(binary);
}

describe("zos mirror frame decoding", () => {
  test("expands 52×16 RGB into opaque RGBA in pixel order", () => {
    const rgba = decodeMirrorFrame(base64Frame((index) => index))!;
    expect(rgba).not.toBeNull();
    expect(rgba.length).toBe(52 * 16 * 4);
    // First pixel: bytes 0,1,2 of the payload, alpha forced opaque.
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([0, 1, 2, 255]);
    // Second pixel starts at payload byte 3 — no stride drift.
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([3, 4, 5, 255]);
    const last = (52 * 16 - 1) * 4;
    expect(rgba[last + 3]).toBe(255);
  });

  test("refuses anything that is not exactly one frame", () => {
    // These are the bytes the panel received; a short or malformed payload must
    // produce nothing rather than a plausible-looking partial picture.
    expect(decodeMirrorFrame("")).toBeNull();
    expect(decodeMirrorFrame(btoa("nope"))).toBeNull();
    expect(decodeMirrorFrame("!!!not base64!!!")).toBeNull();
    expect(decodeMirrorFrame(base64Frame(() => 7))).not.toBeNull();
  });
});

describe("zos poll backoff", () => {
  test("stays on cadence until something fails, then doubles up to the cap", () => {
    expect(nextPollDelayMs(250, 0)).toBe(250);
    expect(nextPollDelayMs(250, 1)).toBe(500);
    expect(nextPollDelayMs(250, 2)).toBe(1_000);
    expect(nextPollDelayMs(2_000, 3)).toBe(10_000);
    // Capped: a service that stays down must not push the retry beyond the
    // point where restarting it reconnects the console on its own.
    expect(nextPollDelayMs(2_000, 40)).toBe(10_000);
  });
});

describe("zos mirror status", () => {
  test("an offline device never shows a picture", () => {
    const status = describeMirror({ live: false, frameReceivedAt: 900_000, now: 1_000_000 });
    expect(status.phase).toBe("offline");
    expect(status.showsFrame).toBe(false);
    expect(status.label).toBe("设备离线");
    expect(status.notice).toContain("不是实时画面");
  });

  test("a live device with no frame yet says so instead of showing black", () => {
    const status = describeMirror({ live: true, frameReceivedAt: null, now: 1_000_000 });
    expect(status.phase).toBe("waiting");
    expect(status.showsFrame).toBe(false);
    expect(status.notice).not.toBeNull();
  });

  test("a stalled stream keeps the last frame but names its age", () => {
    const status = describeMirror({ live: true, frameReceivedAt: 1_000_000, now: 1_009_000 });
    expect(status.phase).toBe("stale");
    expect(status.showsFrame).toBe(true);
    expect(status.notice).toContain("9 秒前");
  });

  test("a fresh frame is the only state with no caveat", () => {
    const status = describeMirror({ live: true, frameReceivedAt: 1_000_000, now: 1_000_200 });
    expect(status.phase).toBe("live");
    expect(status.showsFrame).toBe(true);
    expect(status.notice).toBeNull();
  });
});

describe("zos telemetry readout", () => {
  test("offline collapses every field rather than showing stale numbers", () => {
    // A stale IP and uptime read exactly like current ones; the whole row set
    // has to say 离线 or the readout is lying.
    const rows = describeTelemetry(state({ live: false }), 1_000_000);
    expect(rows.every((row) => row.value === "离线")).toBe(true);
    expect(rows.map((row) => row.key)).toContain("supplicant");
  });

  test("no telemetry at all is treated the same as offline", () => {
    expect(describeTelemetry(null, 1_000_000).every((row) => row.value === "离线")).toBe(true);
    expect(
      describeTelemetry(state({ telemetry: null }), 1_000_000).every((row) => row.value === "离线"),
    ).toBe(true);
  });

  test("a live device renders the numbers plus the heartbeat age", () => {
    const rows = describeTelemetry(state(), 1_006_000);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("screen")?.value).toBe("启动器");
    expect(byKey.get("focus")?.value).toBe("btc");
    expect(byKey.get("ip")?.value).toBe("192.168.8.240");
    expect(byKey.get("uptime")?.value).toBe("5 分 10 秒");
    expect(byKey.get("free")?.value).toBe("16568 KB");
    expect(byKey.get("heartbeat")?.value).toBe("6 秒前");
  });

  test("zero supplicant restarts is reported as the safety property it is", () => {
    // Zero means the firmware adopted the link the official app had already
    // brought up — that is why a sideload does not cost the user their Wi-Fi.
    const quiet = describeTelemetry(state(), 1_000_000).find((row) => row.key === "supplicant")!;
    expect(quiet.value).toBe("0 次");
    expect(quiet.note).toContain("没有重启过 supplicant");

    const noisy = describeTelemetry(
      state({ telemetry: telemetry({ supplicantRestarts: 3 }) }),
      1_000_000,
    ).find((row) => row.key === "supplicant")!;
    expect(noisy.value).toBe("3 次");
    expect(noisy.note).toContain("留意 Wi-Fi 配置");
  });

  test("formats uptime at the scale it is actually read at", () => {
    expect(formatUptime(45_000)).toBe("45 秒");
    expect(formatUptime(310_501)).toBe("5 分 10 秒");
    expect(formatUptime(7_400_000)).toBe("2 小时 3 分");
    expect(formatUptime(-5)).toBe("0 秒");
  });
});

describe("zos driver status", () => {
  test("an unpinned display hands the knob back to the device", () => {
    const driver = describeDriver({ focus: null, pinned: false }, MENU, telemetry(), true);
    expect(driver.pinned).toBe(false);
    expect(driver.label).toBe("旋钮自由");
  });

  test("a pin the device has not confirmed yet is named as pending", () => {
    // The firmware heartbeats every ~10s, so `display` and `telemetry.focus`
    // legitimately disagree right after a pin. Claiming it landed would be a lie.
    const driver = describeDriver({ focus: "qqq", pinned: true }, MENU, telemetry(), true);
    expect(driver.pinned).toBe(true);
    expect(driver.detail).toContain("等下一次心跳确认");
    expect(driver.detail).toContain("QQQ");
  });

  test("a pin the telemetry agrees with reads as locked", () => {
    const driver = describeDriver(
      { focus: "qqq", pinned: true },
      MENU,
      telemetry({ focus: "qqq" }),
      true,
    );
    expect(driver.detail).toContain("已锁定");
  });

  test("an id missing from the menu still names something", () => {
    const driver = describeDriver({ focus: "gone", pinned: true }, MENU, null, true);
    expect(driver.detail).toContain("gone");
  });
});

interface FakeTimer {
  handle: number;
  callback: () => void;
  ms: number;
}

function fakeTimers() {
  const pending: FakeTimer[] = [];
  let nextHandle = 1;
  return {
    pending,
    setTimer: (callback: () => void, ms: number) => {
      const handle = nextHandle++;
      pending.push({ handle, callback, ms });
      return handle;
    },
    clearTimer: (handle: number) => {
      const index = pending.findIndex((timer) => timer.handle === handle);
      if (index >= 0) pending.splice(index, 1);
    },
    /** Fire every currently scheduled timer once, in schedule order. */
    fire: () => {
      const due = pending.splice(0, pending.length);
      for (const timer of due) timer.callback();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("zos link polling", () => {
  test("starts both loops and keeps asking for the mirror — asking is the subscription", async () => {
    const urls: string[] = [];
    const timers = fakeTimers();
    const link = createZosLink({
      fetcher: (url) => {
        urls.push(url);
        return Promise.resolve(Response.json(
          url === "/api/os/state"
            ? state()
            : { frame: { rgbBase64: base64Frame(() => 1), receivedAt: 1_000_000 } },
        ));
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    link.start();
    await settle();
    expect(urls).toContain("/api/os/state");
    expect(urls).toContain("/api/os/mirror");

    // The device only streams while someone keeps polling, so the loop must
    // reschedule itself rather than settle after the first read.
    const scheduled = timers.pending.map((timer) => timer.ms).sort((a, b) => a - b);
    expect(scheduled).toEqual([ZOS_MIRROR_POLL_MS, ZOS_STATE_POLL_MS]);

    timers.fire();
    await settle();
    expect(urls.filter((url) => url === "/api/os/mirror").length).toBe(2);
    link.stop();
  });

  test("polls the mirror slowly while nothing is live, but never stops", async () => {
    // The lease is 10s, so an idle cadence still keeps mirror=1 in the state
    // document — that is how the firmware learns to start streaming when it
    // finally comes up.
    const timers = fakeTimers();
    const link = createZosLink({
      fetcher: (url) => Promise.resolve(Response.json(
        url === "/api/os/state" ? state({ live: false, telemetry: null }) : { frame: null },
      )),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    link.start();
    await settle();
    timers.fire();
    await settle();
    expect(timers.pending.map((timer) => timer.ms).sort((a, b) => a - b))
      .toEqual([ZOS_MIRROR_IDLE_POLL_MS, ZOS_STATE_POLL_MS]);
    expect(ZOS_MIRROR_IDLE_POLL_MS).toBeLessThan(10_000);
    link.stop();
  });

  test("reports a failing link and backs off instead of hammering it", async () => {
    const errors: string[] = [];
    const timers = fakeTimers();
    const link = createZosLink({
      fetcher: () => Promise.resolve(Response.json({ error: "os link is unavailable" }, { status: 404 })),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onStateError: (message) => errors.push(message),
    });

    link.start();
    await settle();
    expect(errors[0]).toBe("os link is unavailable");
    const stateTimer = timers.pending.find((timer) => timer.ms === ZOS_STATE_POLL_MS * 2);
    expect(stateTimer).toBeDefined();
    link.stop();
  });

  test("stop cancels the loops so a closed panel drops the mirror lease", async () => {
    const urls: string[] = [];
    const timers = fakeTimers();
    const link = createZosLink({
      fetcher: (url) => {
        urls.push(url);
        return Promise.resolve(Response.json(url === "/api/os/state" ? state() : { frame: null }));
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    link.start();
    await settle();
    const before = urls.length;
    link.stop();
    timers.fire();
    await settle();
    expect(urls.length).toBe(before);
    expect(timers.pending).toHaveLength(0);
  });

  test("setDisplay puts the command and returns what the service accepted", async () => {
    const requests: { url: string; method: string; body: unknown }[] = [];
    const link = createZosLink({
      fetcher: (url, init) => {
        requests.push({
          url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return Promise.resolve(Response.json({ display: { focus: "qqq", pinned: true }, seq: 13 }));
      },
      setTimer: () => 0,
      clearTimer: () => {},
    });

    const display = await link.setDisplay("qqq", true);
    expect(requests[0]).toMatchObject({
      url: "/api/os/display",
      method: "PUT",
      body: { focus: "qqq", pinned: true },
    });
    expect(display).toEqual({ focus: "qqq", pinned: true });

    await link.setDisplay(null, false);
    expect(requests[1]?.body).toEqual({ focus: null, pinned: false });
  });

  test("a rejected display command surfaces the service's own message", async () => {
    const link = createZosLink({
      fetcher: () => Promise.resolve(Response.json({ error: "focus must be a string or null" }, { status: 400 })),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(link.setDisplay("x", true)).rejects.toThrow("focus must be a string or null");
  });
});
