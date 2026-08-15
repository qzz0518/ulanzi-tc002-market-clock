import { describe, expect, test } from "bun:test";
import {
  ZOS_GAME_SHORTCUTS,
  ZOS_HOLD_MS,
  ZOS_INPUT_LABELS,
  ZOS_KNOB_DETENT_DEG,
  ZOS_MIRROR_IDLE_POLL_MS,
  ZOS_MIRROR_POLL_MS,
  ZOS_MIRROR_RGB_BYTES,
  ZOS_MUSIC_FOCUS,
  ZOS_SETTINGS_FOCUS,
  ZOS_STATE_POLL_MS,
  accumulateDetents,
  angleDeltaDeg,
  brightnessText,
  createPressTracker,
  createZosLink,
  decodeMirrorFrame,
  describeBattery,
  describeDriver,
  describeMirror,
  describeResidency,
  describeTelemetry,
  describeVitals,
  entryOnScreen,
  formatUptime,
  nextPollDelayMs,
  pointerAngleDeg,
  volumeText,
  zosGameFocus,
  zosInputForKey,
  zosKeyCaptured,
  zosPinnedOn,
  zosToggleFocus,
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
    batteryPercent: 82,
    charging: false,
    flashed: true,
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
    // 「当前界面」被砍掉了:镜像就是那块面板的实况,再用固件的内部词汇复述一遍
    // (launcher / games)只是同一件事换个说法,而且是更难懂的那个说法。
    expect(byKey.has("screen")).toBe(false);
    expect(byKey.get("ip")?.value).toBe("192.168.8.240");
    expect(byKey.get("free")?.value).toBe("16568 KB");
    expect(byKey.get("heartbeat")?.value).toBe("6 秒前");
    // Wi-Fi / 电量 / 运行时长挪去了镜像下方的概况条，详情表不再重复。
    expect(byKey.has("wifi")).toBe(false);
    expect(byKey.has("uptime")).toBe(false);
  });

  test("only a non-zero restart count earns a note", () => {
    // Zero is the good case and the count says so on its own. Explaining WHY it
    // is zero — the firmware adopted the link instead of restarting
    // wpa_supplicant — is our implementation talking to the user, which is what
    // this row used to do. A non-zero count keeps its note: it is the only
    // warning that the stored Wi-Fi credentials may have been rewritten.
    const quiet = describeTelemetry(state(), 1_000_000).find((row) => row.key === "supplicant")!;
    expect(quiet.value).toBe("0 次");
    expect(quiet.note).toBeUndefined();

    const noisy = describeTelemetry(
      state({ telemetry: telemetry({ supplicantRestarts: 3 }) }),
      1_000_000,
    ).find((row) => row.key === "supplicant")!;
    expect(noisy.value).toBe("3 次");
    expect(noisy.note).toContain("确认 Wi-Fi 设置");
  });

  test("formats uptime at the scale it is actually read at", () => {
    expect(formatUptime(45_000)).toBe("45 秒");
    expect(formatUptime(310_501)).toBe("5 分 10 秒");
    expect(formatUptime(7_400_000)).toBe("2 小时 3 分");
    expect(formatUptime(-5)).toBe("0 秒");
  });
});

// 每条断言都对着 192.168.8.108 上跑 ZOS 的真机核过:分别固定 music / game /
// settings / btc,telemetry.screen 依次变成 music / games / settings / channel,
// 而 telemetry.focus 全程停在 btc(频道环的当前项)。
describe("which menu entry the device is actually showing", () => {
  const entry = (id: string): ZosMenuEntry => MENU.find((row) => row.id === id)!;

  test("a channel needs both the ring and the screen", () => {
    expect(entryOnScreen(entry("qqq"), telemetry({ focus: "qqq", screen: "channel" }))).toBe(true);
    expect(entryOnScreen(entry("qqq"), telemetry({ focus: "qqq", screen: "launcher" }))).toBe(false);
    expect(entryOnScreen(entry("qqq"), telemetry({ focus: "btc", screen: "channel" }))).toBe(false);
  });

  test("音乐 is matched by the screen, never by focus", () => {
    expect(entryOnScreen(entry("music"), telemetry({ focus: "btc", screen: "music" }))).toBe(true);
    expect(entryOnScreen(entry("music"), telemetry({ focus: "music", screen: "channel" }))).toBe(false);
  });

  test("游戏 covers both the list and a running game", () => {
    const games: ZosMenuEntry = { id: "game", label: "游戏", kind: "game" };
    expect(entryOnScreen(games, telemetry({ screen: "games" }))).toBe(true);
    expect(entryOnScreen(games, telemetry({ screen: "game" }))).toBe(true);
    expect(entryOnScreen(games, telemetry({ screen: "settings" }))).toBe(false);
  });

  test("设置 matches its own screen only", () => {
    const settings: ZosMenuEntry = { id: "settings", label: "设置", kind: "settings" };
    expect(entryOnScreen(settings, telemetry({ screen: "settings" }))).toBe(true);
    expect(entryOnScreen(settings, telemetry({ screen: "launcher" }))).toBe(false);
  });

  test("no telemetry means no claim", () => {
    expect(entryOnScreen(entry("music"), null)).toBe(false);
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
      // 频道要两项都对上:频道环停在 qqq，且频道页确实在最上层。
      telemetry({ focus: "qqq", screen: "channel" }),
      true,
    );
    expect(driver.detail).toContain("已锁定");
  });

  test("the channel ring pointing at a channel is not the channel being shown", () => {
    // 真机实测:telemetry.focus 是频道环的当前项,别的界面压在上面时它照旧不变。
    // 只按 focus 判断,就会在启动器上宣布「设备已锁定在 QQQ」。
    const driver = describeDriver(
      { focus: "qqq", pinned: true },
      MENU,
      telemetry({ focus: "qqq", screen: "launcher" }),
      true,
    );
    expect(driver.detail).toContain("等下一次心跳确认");
  });

  test("a non-channel pin is confirmed by the screen, since focus never names it", () => {
    // 192.168.8.108 实测:固定「音乐」后 telemetry.screen 变成 music,而
    // telemetry.focus 一直是 btc。只按 focus 判断,音乐/游戏/设置永远确认不了。
    const driver = describeDriver(
      { focus: "music", pinned: true },
      MENU,
      telemetry({ focus: "btc", screen: "music" }),
      true,
    );
    expect(driver.detail).toContain("已锁定");
    expect(driver.detail).toContain("音乐");
  });

  test("an id missing from the menu still names something", () => {
    const driver = describeDriver({ focus: "gone", pinned: true }, MENU, null, true);
    expect(driver.detail).toContain("gone");
  });

  test("a game shortcut is named by its engine, not by the wire format", () => {
    // 拉取文档里只有 游戏 这一环,七个引擎的 id 是控制台自己拼的——所以也只有
    // 控制台能把 game:snake 说成人话。
    const driver = describeDriver({ focus: "game:snake", pinned: true }, MENU, null, true);
    expect(driver.detail).toContain("贪吃蛇");
    expect(driver.detail).not.toContain("game:snake");
  });

  test("being in a game is all the confirmation a game pin can get", () => {
    // 固件报 screen: "game" 时不说是哪一个引擎;而这一台是控制台自己点进去的,
    // 所以「在游戏里」就足以确认。否则这一行会永远停在「等下一次心跳确认」。
    const playing = describeDriver(
      { focus: "game:snake", pinned: true },
      MENU,
      telemetry({ screen: "game" }),
      true,
    );
    expect(playing.detail).toContain("已锁定");

    const notYet = describeDriver(
      { focus: "game:snake", pinned: true },
      MENU,
      telemetry({ screen: "launcher" }),
      true,
    );
    expect(notYet.detail).toContain("等下一次心跳确认");
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

  test("sends the exact focus string the firmware was measured to honour", async () => {
    // Observed on the device at 192.168.8.108 (see zos-link.ts): "music" moved
    // telemetry.screen to "music", "settings" to "settings", "game" to "games".
    // The strings themselves are the contract, so a typo here is a test failure
    // rather than a button that silently leaves the panel where it was.
    const sent: unknown[] = [];
    const link = createZosLink({
      fetcher: (_url, init) => {
        sent.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
        return Promise.resolve(Response.json({ display: { focus: null, pinned: false }, seq: 1 }));
      },
      setTimer: () => 0,
      clearTimer: () => {},
    });

    await link.setDisplay(ZOS_MUSIC_FOCUS, true);
    await link.setDisplay(ZOS_SETTINGS_FOCUS, true);
    await link.setDisplay(zosGameFocus("tetris"), true);
    expect(sent).toEqual([
      { focus: "music", pinned: true },
      { focus: "settings", pinned: true },
      { focus: "game:tetris", pinned: true },
    ]);
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

describe("zos focus targets", () => {
  // The seven ids are the arcade engines' own id() strings on both sides. This
  // list is duplicated on purpose: importing GAME_REGISTRY would let a rename
  // sail through, and the firmware would just silently ignore the new value.
  const GAME_IDS = ["breakout", "flappy", "snake", "pong", "racer", "shooter", "tetris"] as const;

  test("names a game with the device's own engine id", () => {
    expect(GAME_IDS.map(zosGameFocus)).toEqual([
      "game:breakout",
      "game:flappy",
      "game:snake",
      "game:pong",
      "game:racer",
      "game:shooter",
      "game:tetris",
    ]);
    // Plain "game" only opens the ring — measured on hardware. The suffix is
    // what makes it enter the engine, so it can never be dropped.
    expect(zosGameFocus("tetris")).not.toBe("game");
  });

  test("every console engine id has a focus, and they are all distinct", () => {
    const focuses = new Set(GAME_IDS.map(zosGameFocus));
    expect(focuses.size).toBe(GAME_IDS.length);
    expect(focuses.has(ZOS_MUSIC_FOCUS)).toBe(false);
    expect(focuses.has(ZOS_SETTINGS_FOCUS)).toBe(false);
  });

  test("pinned means pinned on THIS target, not merely pinned", () => {
    expect(zosPinnedOn({ focus: "music", pinned: true }, ZOS_MUSIC_FOCUS)).toBe(true);
    // A different screen holding the knob must not light up this button.
    expect(zosPinnedOn({ focus: "game:snake", pinned: true }, ZOS_MUSIC_FOCUS)).toBe(false);
    // The device sitting on a focus it was never pinned to is the knob's own
    // doing; the console has not taken anything and must not claim it did.
    expect(zosPinnedOn({ focus: "music", pinned: false }, ZOS_MUSIC_FOCUS)).toBe(false);
    expect(zosPinnedOn(null, ZOS_MUSIC_FOCUS)).toBe(false);
  });

  test("pressing the target it is already on is the way back", () => {
    // Pinning locks the console's choice, so the same button has to release it
    // — otherwise the knob stays taken with no visible way out.
    expect(zosToggleFocus({ focus: "game:tetris", pinned: true }, zosGameFocus("tetris"))).toBeNull();
    expect(zosToggleFocus({ focus: "game:tetris", pinned: true }, zosGameFocus("snake")))
      .toBe("game:snake");
    expect(zosToggleFocus({ focus: "btc", pinned: true }, ZOS_MUSIC_FOCUS)).toBe("music");
    expect(zosToggleFocus(null, ZOS_MUSIC_FOCUS)).toBe("music");
  });

  test("the quick-launch list names exactly the firmware's seven engines", () => {
    expect(ZOS_GAME_SHORTCUTS.map((game) => game.id)).toEqual([
      "breakout", "flappy", "snake", "pong", "racer", "shooter", "tetris",
    ]);
    // 每个都有可读中文标签，不能把裸 id 打到界面上。
    for (const game of ZOS_GAME_SHORTCUTS) {
      expect(game.label.length).toBeGreaterThan(0);
      expect(game.label).not.toBe(game.id);
    }
  });
});

describe("zos press-vs-hold tracker", () => {
  test("a release before the threshold is a press", () => {
    const tracker = createPressTracker();
    tracker.down(1_000);
    expect(tracker.tick(1_100)).toBeNull();
    expect(tracker.progress(1_300)).toBeCloseTo(0.5);
    expect(tracker.up(1_300)).toBe("press");
    // The gesture is over; nothing lingers.
    expect(tracker.isDown()).toBe(false);
    expect(tracker.progress(2_000)).toBe(0);
  });

  test("hold fires from the tick that crosses the threshold, exactly once", () => {
    // osLogic.cc fires on the tick, not the release — waiting for the release
    // makes every long press feel laggy. Same machine, same timing.
    const tracker = createPressTracker();
    tracker.down(1_000);
    expect(tracker.tick(1_000 + ZOS_HOLD_MS - 1)).toBeNull();
    expect(tracker.tick(1_000 + ZOS_HOLD_MS)).toBe("hold");
    expect(tracker.tick(1_000 + ZOS_HOLD_MS + 50)).toBeNull();
    // The release after a fired hold must not add a press on top.
    expect(tracker.up(1_000 + ZOS_HOLD_MS + 200)).toBeNull();
  });

  test("a release past the threshold without a tick still means hold", () => {
    // A background tab throttles rAF; the user who held past 600 ms meant BACK
    // regardless of our frame rate.
    const tracker = createPressTracker();
    tracker.down(1_000);
    expect(tracker.up(1_000 + ZOS_HOLD_MS + 300)).toBe("hold");
  });

  test("cancel forgets the press without emitting anything", () => {
    const tracker = createPressTracker();
    tracker.down(1_000);
    tracker.cancel();
    expect(tracker.up(3_000)).toBeNull();
    expect(tracker.progress(3_000)).toBe(0);
  });

  test("progress saturates at 1 once fired", () => {
    const tracker = createPressTracker();
    tracker.down(0);
    tracker.tick(ZOS_HOLD_MS);
    expect(tracker.progress(ZOS_HOLD_MS + 5_000)).toBe(1);
  });
});

describe("zos knob geometry", () => {
  test("pointer angles put 0° at 12 o'clock and grow clockwise", () => {
    expect(pointerAngleDeg(0, 0, 0, -10)).toBeCloseTo(0);
    expect(pointerAngleDeg(0, 0, 10, 0)).toBeCloseTo(90);
    expect(pointerAngleDeg(0, 0, 0, 10)).toBeCloseTo(180);
    expect(pointerAngleDeg(0, 0, -10, 0)).toBeCloseTo(-90);
  });

  test("angle deltas take the short way across the ±180° seam", () => {
    expect(angleDeltaDeg(10, 30)).toBe(20);
    expect(angleDeltaDeg(30, 10)).toBe(-20);
    // Dragging through the bottom of the dial must read as a small step in the
    // travel direction, not a near-full spin the other way.
    expect(angleDeltaDeg(170, -170)).toBe(20);
    expect(angleDeltaDeg(-170, 170)).toBe(-20);
  });

  test("detents fold travel into whole clicks and carry the remainder", () => {
    expect(accumulateDetents(0, 10)).toEqual({ steps: 0, carry: 10 });
    expect(accumulateDetents(10, 20)).toEqual({ steps: 1, carry: 6 });
    expect(accumulateDetents(0, -30)).toEqual({ steps: -1, carry: -6 });
    // A fast flick emits several detents at once.
    expect(accumulateDetents(0, ZOS_KNOB_DETENT_DEG * 3 + 3)).toEqual({ steps: 3, carry: 3 });
    // A custom threshold serves the wheel (pixels, not degrees).
    expect(accumulateDetents(90, 20, 100)).toEqual({ steps: 1, carry: 10 });
  });
});

describe("zos keyboard remote", () => {
  test("arrows are the knob, Enter the press, Backspace the hold", () => {
    expect(zosInputForKey("ArrowRight")).toBe("cw");
    expect(zosInputForKey("ArrowLeft")).toBe("ccw");
    expect(zosInputForKey("Enter")).toBe("press");
    expect(zosInputForKey(" ")).toBe("press");
    expect(zosInputForKey("Backspace")).toBe("hold");
    expect(zosInputForKey("Escape")).toBe("hold");
    expect(zosInputForKey("a")).toBe("left");
    expect(zosInputForKey("D")).toBe("right");
    expect(zosInputForKey("x")).toBeNull();
  });

  test("auto-repeat turns the knob but can never machine-gun a confirm", () => {
    // The hardware cannot emit five confirms from one finger.
    expect(zosInputForKey("ArrowRight", true)).toBe("cw");
    expect(zosInputForKey("a", true)).toBe("left");
    expect(zosInputForKey("Enter", true)).toBeNull();
    expect(zosInputForKey("Backspace", true)).toBeNull();
  });

  test("focused controls keep the keys they own", () => {
    const plain = { editable: false, button: false, slider: false };
    expect(zosKeyCaptured("Enter", plain)).toBe(false);
    // An editable owns everything — typing must never drive the clock.
    expect(zosKeyCaptured("a", { ...plain, editable: true })).toBe(true);
    // A focused button owns its activation keys (its click routes through the
    // same send path; a global handler on top would double-fire)…
    expect(zosKeyCaptured("Enter", { ...plain, button: true })).toBe(true);
    expect(zosKeyCaptured(" ", { ...plain, button: true })).toBe(true);
    // …but not the letters, so A/D side keys still work with a button focused.
    expect(zosKeyCaptured("a", { ...plain, button: true })).toBe(false);
    // A slider owns the arrows it steps by.
    expect(zosKeyCaptured("ArrowLeft", { ...plain, slider: true })).toBe(true);
    expect(zosKeyCaptured("Enter", { ...plain, slider: true })).toBe(false);
  });

  test("every action has a human label for the receipt line", () => {
    for (const action of ["cw", "ccw", "press", "hold", "left", "right"] as const) {
      expect(ZOS_INPUT_LABELS[action].length).toBeGreaterThan(0);
    }
  });
});

describe("zos input and settings transport", () => {
  test("sendInput POSTs the action and returns the queued event as receipt", async () => {
    const requests: { url: string; method: string; body: unknown }[] = [];
    const link = createZosLink({
      fetcher: (url, init) => {
        requests.push({
          url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return Promise.resolve(Response.json({ event: { seq: 7, action: "cw" } }));
      },
      setTimer: () => 0,
      clearTimer: () => {},
    });

    const event = await link.sendInput("cw");
    expect(requests[0]).toMatchObject({
      url: "/api/os/input",
      method: "POST",
      body: { action: "cw" },
    });
    // The seq is the only receipt that exists: it proves the service queued the
    // press, not that the device performed it — the mirror is the evidence for
    // that, and the panel's copy must keep the two claims apart.
    expect(event).toEqual({ seq: 7, action: "cw" });
  });

  test("requestBleOpen asks the clock to advertise, and reports what the service recorded", async () => {
    // The wizard can only SCAN, and an ONLINE clock advertises nothing — which
    // is the clock somebody is moving to a new router. This POST is the console
    // pressing 设置 → 配网 from across the LAN.
    const requests: { url: string; method: string; type: string | null; body: unknown }[] = [];
    const link = createZosLink({
      fetcher: (url, init) => {
        requests.push({
          url,
          method: init?.method ?? "GET",
          type: new Headers(init?.headers).get("Content-Type"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return Promise.resolve(Response.json({ seq: 1755000000 }));
      },
      setTimer: () => 0,
      clearTimer: () => {},
    });

    expect(await link.requestBleOpen()).toBe(1755000000);
    expect(requests[0]).toEqual({
      url: "/api/os/ble",
      method: "POST",
      // JSON-only, which is what a cross-origin form cannot produce without a
      // preflight the browser will not send. There are no fields: how long the
      // window stays open is the firmware's constant, not the browser's.
      type: "application/json",
      body: {},
    });
  });

  test("a missing open-Bluetooth receipt is not a failure", async () => {
    // The request still stands whether or not the service named a sequence, and
    // the console must carry the user on to the chooser either way — an offline
    // clock is already advertising, so the old path works untouched.
    const link = createZosLink({
      fetcher: () => Promise.resolve(Response.json({})),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(await link.requestBleOpen()).toBeNull();
  });

  test("a refused open-Bluetooth request surfaces the service's own message", async () => {
    const link = createZosLink({
      fetcher: () => Promise.resolve(Response.json({ error: "os link is unavailable" }, { status: 404 })),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(link.requestBleOpen()).rejects.toThrow("os link is unavailable");
  });

  test("a refused input surfaces the service's own message", async () => {
    const link = createZosLink({
      fetcher: () => Promise.resolve(
        Response.json({ error: "action must be one of cw, ccw, press, hold, left, right" }, { status: 400 }),
      ),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(link.sendInput("cw")).rejects.toThrow("action must be one of");
  });

  test("setSettings PUTs only the field being changed", async () => {
    // Sending both would overwrite the one the user did not touch with whatever
    // this tab last saw — the service merges, so partial writes are the safe shape.
    const bodies: unknown[] = [];
    const link = createZosLink({
      fetcher: (_url, init) => {
        bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
        return Promise.resolve(Response.json({ requested: { volume: 3, brightness: null, seq: 2 } }));
      },
      setTimer: () => 0,
      clearTimer: () => {},
    });

    const requested = await link.setSettings({ volume: 3 });
    await link.setSettings({ brightness: 8 });
    await link.setSettings({ volume: 0, brightness: 1 });
    expect(bodies).toEqual([
      { volume: 3 },
      { brightness: 8 },
      { volume: 0, brightness: 1 },
    ]);
    expect(requested).toEqual({ volume: 3, brightness: null, seq: 2 });
  });

  test("a rejected settings write surfaces the service's own message", async () => {
    const link = createZosLink({
      fetcher: () => Promise.resolve(
        Response.json({ error: "brightness must be between 1 and 10" }, { status: 400 }),
      ),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(link.setSettings({ brightness: 11 })).rejects.toThrow("between 1 and 10");
  });
});

describe("zos battery and vitals", () => {
  test("-1 and absent battery readings render as nothing, never as 0%", () => {
    expect(describeBattery(-1)).toBeNull();
    expect(describeBattery(undefined)).toBeNull();
    expect(describeBattery(Number.NaN)).toBeNull();
    // 0 is a real reading (the device is about to die), only -1 means unknown.
    expect(describeBattery(0)?.label).toBe("0%");
  });

  test("battery tone tracks the reading and charging passes through", () => {
    expect(describeBattery(82, true)).toEqual({ label: "82%", charging: true, tone: "ok" });
    expect(describeBattery(30)?.tone).toBe("low");
    expect(describeBattery(10)?.tone).toBe("critical");
    expect(describeBattery(120)?.label).toBe("100%");
  });

  test("vitals exist only while the device is live", () => {
    // A stale battery percentage reads exactly like a current one.
    expect(describeVitals(state({ live: false }))).toEqual({ battery: null, wifi: null, uptime: null });
    expect(describeVitals(null)).toEqual({ battery: null, wifi: null, uptime: null });

    const vitals = describeVitals(state());
    expect(vitals.battery?.label).toBe("82%");
    expect(vitals.wifi).toBe("xiaoya-2.4G");
    expect(vitals.uptime).toBe("5 分 10 秒");
  });

  test("an empty wifi name collapses to null rather than an empty chip", () => {
    expect(describeVitals(state({ telemetry: telemetry({ wifi: "" }) })).wifi).toBeNull();
  });
});

describe("zos firmware residency", () => {
  test("a flashed ZOS stays flashed even while the device is off the air", () => {
    // What a power cycle restores does not stop being true because the device
    // stopped reporting — the sticky service-side flag is the authority.
    const row = describeResidency(state({ live: false, telemetry: null, zosFlashed: true }));
    expect(row.value).toBe("已刷入闪存");
    expect(row.note).toContain("仍是 ZOS");
  });

  test("a live sideload session names what a power cycle takes away", () => {
    const row = describeResidency(state({ zosFlashed: false }));
    expect(row.value).toBe("临时侧载");
    expect(row.note).toContain("原厂固件");
  });

  test("offline with no flash record admits it does not know", () => {
    expect(describeResidency(state({ live: false, telemetry: null })).value).toBe("未知");
    expect(describeResidency(null).value).toBe("未知");
  });
});

describe("zos settings text", () => {
  // 音量亮度是只写的:序列号让设备旋钮和侧键压过控制台,代价就是读不回来。
  // 所以「没有值」不是「未知」——是这台控制台还没下发过。
  test("volume names mute and the not-yet-sent state", () => {
    expect(volumeText(null)).toBe("未下发");
    expect(volumeText(0)).toBe("静音");
    expect(volumeText(4)).toBe("4 级");
  });

  test("brightness shows the device's own 1..10 scale", () => {
    expect(brightnessText(null)).toBe("未下发");
    expect(brightnessText(7)).toBe("7 / 10");
  });
});
