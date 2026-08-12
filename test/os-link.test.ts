import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OsLinkHub, type OsMenuEntry } from "../src/os-link.ts";

const entry = (id: string, label: string, kind: OsMenuEntry["kind"] = "channel"): OsMenuEntry => ({
  id,
  label,
  kind,
});

describe("tc002-os host link", () => {
  test("serializes a document the firmware can parse with a split loop", () => {
    const hub = new OsLinkHub();
    hub.setMenu([entry("btc", "市场轮播"), entry("music", "音乐", "music")]);
    hub.setDisplay({ focus: "btc", pinned: true });

    const body = hub.serialize();
    const lines = body.split("\n");
    expect(body.endsWith("\n")).toBe(true);
    expect(lines[0]).toBe(`seq\t${hub.currentSeq()}`);
    expect(lines).toContain("pinned\t1");
    expect(lines).toContain("mirror\t0");
    expect(lines).toContain("focus\tbtc");
    expect(lines).toContain("menu\t2");
    expect(lines).toContain("item\tchannel\tbtc\t市场轮播");
    expect(lines).toContain("item\tmusic\tmusic\t音乐");
  });

  test("strips separators out of user-authored labels", () => {
    // Channel names come from workspace.json and are unconstrained; a tab in one
    // would silently shift every field after it in the firmware's parser.
    const hub = new OsLinkHub();
    hub.setMenu([entry("x", "a\tb\nc")]);
    const line = hub.serialize().split("\n").find((l) => l.startsWith("item\t"));
    expect(line).toBe("item\tchannel\tx\ta b c");
  });

  test("caps a pathological label instead of shipping it every poll", () => {
    const hub = new OsLinkHub();
    hub.setMenu([entry("x", "字".repeat(200))]);
    const line = hub.serialize().split("\n").find((l) => l.startsWith("item\t"))!;
    expect(Array.from(line.split("\t")[3]!).length).toBe(24);
  });

  test("only bumps the sequence when the document actually changed", () => {
    const hub = new OsLinkHub();
    const start = hub.currentSeq();
    hub.setMenu([entry("btc", "市场")]);
    const afterMenu = hub.currentSeq();
    expect(afterMenu).toBeGreaterThan(start);

    // An idempotent write must not wake every parked poll — the workspace
    // controller re-publishes the menu on each refresh cycle.
    hub.setMenu([entry("btc", "市场")]);
    expect(hub.currentSeq()).toBe(afterMenu);

    hub.setDisplay({ focus: null, pinned: false });
    expect(hub.currentSeq()).toBe(afterMenu);
    hub.setDisplay({ focus: "btc", pinned: false });
    expect(hub.currentSeq()).toBeGreaterThan(afterMenu);
  });

  test("answers a poll that is already behind without parking", async () => {
    const hub = new OsLinkHub();
    hub.setMenu([entry("btc", "市场")]);
    const body = await hub.waitForChange(0, 60_000);
    expect(body).toContain("item\tchannel\tbtc\t市场");
    expect(hub.pendingWaiters()).toBe(0);
  });

  test("parks an up-to-date poll and releases it the moment something changes", async () => {
    const hub = new OsLinkHub();
    const seq = hub.currentSeq();
    const pending = hub.waitForChange(seq, 60_000);
    await Bun.sleep(5);
    expect(hub.pendingWaiters()).toBe(1);

    hub.setMenu([entry("qqq", "纳指")]);
    const body = await pending;
    expect(body).toContain("item\tchannel\tqqq\t纳指");
    expect(hub.pendingWaiters()).toBe(0);
  });

  test("times out with the current document rather than an empty response", async () => {
    // The firmware's poll loop must have exactly one shape to handle; a 204 on
    // timeout would make it branch on status for no benefit.
    const hub = new OsLinkHub();
    const seq = hub.currentSeq();
    const body = await hub.waitForChange(seq, 20);
    expect(body).toContain(`seq\t${seq}`);
    expect(hub.pendingWaiters()).toBe(0);
  });

  test("releases every parked poll on drain", async () => {
    const hub = new OsLinkHub();
    const seq = hub.currentSeq();
    const a = hub.waitForChange(seq, 60_000);
    const b = hub.waitForChange(seq, 60_000);
    await Bun.sleep(5);
    expect(hub.pendingWaiters()).toBe(2);
    hub.drain();
    expect(await a).toContain("seq\t");
    expect(await b).toContain("seq\t");
    expect(hub.pendingWaiters()).toBe(0);
  });

  test("treats a malformed seq as fully behind", async () => {
    const hub = new OsLinkHub();
    const body = await hub.waitForChange(Number.NaN, 60_000);
    expect(body).toContain("seq\t");
    expect(hub.pendingWaiters()).toBe(0);
  });

  test("telemetry never wakes a poll", async () => {
    // Reports flow device->console at a heartbeat cadence; waking every parked
    // poll on one would turn a status ping into a broadcast storm.
    const hub = new OsLinkHub();
    const seq = hub.currentSeq();
    const pending = hub.waitForChange(seq, 40);
    hub.report({
      screen: "launcher",
      focus: "btc",
      wifi: "online",
      ip: "192.168.8.240",
      uptimeMs: 1000,
      freeKb: 900,
      supplicantRestarts: 0,
      batteryPercent: 87,
      charging: false,
      flashed: false,
    });
    expect(hub.pendingWaiters()).toBe(1);
    await pending;
    expect(hub.getTelemetry()?.ip).toBe("192.168.8.240");
  });

  test("still produces the exact bytes the firmware's parser is tested against", () => {
    // device/tc002-os/hostcheck/fixtures/state-doc.txt is parsed by the C++
    // self-check. Without this assertion the two sides could drift: the encoder
    // would change, the fixture would keep passing on the firmware side, and the
    // mismatch would only appear on hardware as a menu that silently went empty.
    const hub = new OsLinkHub();
    hub.setMenu([
      entry("btc", "市场轮播"),
      entry("matrixclock", "数字雨时钟"),
      entry("notice", "通知板"),
      entry("music", "音乐", "music"),
      entry("game", "游戏", "game"),
      entry("settings", "设置", "settings"),
    ]);
    hub.setDisplay({ focus: "notice", pinned: true });

    const fixture = readFileSync(
      join(import.meta.dir, "../device/tc002-os/hostcheck/fixtures/state-doc.txt"),
      "utf8",
    );
    expect(hub.serialize()).toBe(fixture);
  });

  test("mirroring is a lease the console renews, not a session it must tear down", () => {
    let now = 1_000_000;
    const hub = new OsLinkHub(() => now);
    expect(hub.mirrorWanted()).toBe(false);
    expect(hub.getMirrorFrame()).toBeNull();

    const before = hub.currentSeq();
    hub.requestMirror();
    expect(hub.mirrorWanted()).toBe(true);
    // The device only learns to start streaming through the state document, so
    // the first request must wake the parked poll.
    expect(hub.currentSeq()).toBeGreaterThan(before);
    expect(hub.serialize()).toContain("mirror\t1");

    // Renewing an active lease must not bump: the console re-polls every couple
    // of seconds and would otherwise wake every parked poll forever.
    const active = hub.currentSeq();
    now += 2_000;
    hub.requestMirror();
    expect(hub.currentSeq()).toBe(active);

    hub.putMirrorFrame("AAAA");
    expect(hub.getMirrorFrame()?.rgbBase64).toBe("AAAA");

    // A console that simply goes away stops the stream on its own — there is no
    // teardown call to leak if the browser tab is closed.
    now += 20_000;
    expect(hub.mirrorWanted()).toBe(false);
    expect(hub.serialize()).toContain("mirror\t0");
  });

  test("liveness is judged by report age, not by ever having heard from the device", () => {
    let now = 1_000_000;
    const hub = new OsLinkHub(() => now);
    expect(hub.isDeviceLive()).toBe(false);

    hub.report({
      screen: "launcher",
      focus: "",
      wifi: "online",
      ip: "192.168.8.240",
      uptimeMs: 1,
      freeKb: 900,
      supplicantRestarts: 2,
      batteryPercent: 87,
      charging: false,
      flashed: false,
    });
    expect(hub.isDeviceLive()).toBe(true);
    expect(hub.getTelemetry()?.supplicantRestarts).toBe(2);

    now += 60_000;
    expect(hub.isDeviceLive()).toBe(false);
  });
});
