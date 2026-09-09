import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLE_OPEN_WINDOW_SEC,
  OsLinkHub,
  OS_PROTO_LYRIC_WINDOW,
  OS_VIBE_MAX_PAGE_INTERVAL_SEC,
  OS_VIBE_MIN_CELL_DWELL_MS,
  OS_VIBE_MIN_PAGE_INTERVAL_SEC,
  type OsMenuEntry,
} from "../src/os-link.ts";

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

  test("a content revision is a change even when the id and label are not", () => {
    // The whole reported bug in one assertion: editing 灯牌's colour moves
    // neither the app name nor the channel name, so a menu keyed on those alone
    // compared equal, the sequence never bumped, and the device — which caches a
    // channel's frames — was never told there were new pixels to fetch.
    const hub = new OsLinkHub();
    hub.setMenu([{ ...entry("sign", "灯牌"), rev: "aaaaaaaaaaaa", ttlMs: 30_000 }]);
    const seq = hub.currentSeq();
    hub.setMenu([{ ...entry("sign", "灯牌"), rev: "aaaaaaaaaaaa", ttlMs: 30_000 }]);
    expect(hub.currentSeq()).toBe(seq);

    hub.setMenu([{ ...entry("sign", "灯牌"), rev: "bbbbbbbbbbbb", ttlMs: 30_000 }]);
    expect(hub.currentSeq()).toBeGreaterThan(seq);
    expect(hub.serialize()).toContain("rev\tsign\tbbbbbbbbbbbb");
  });

  test("keeps the item line at exactly four fields", () => {
    // StateDoc::parse matches `fields[0] == "item" && n == 4` — a strict arity
    // check — and ignores keys it does not recognise. Annotating the entry with
    // a fifth tab field would make every deployed firmware drop the whole menu
    // and lose its channel ring until it is reflashed; a new key is invisible to
    // it instead.
    const hub = new OsLinkHub();
    hub.setMenu([{ ...entry("sign", "灯牌"), rev: "abc123", ttlMs: 10_000 }]);
    const lines = hub.serialize().split("\n");
    const item = lines.find((line) => line.startsWith("item\t"))!;
    expect(item.split("\t").length).toBe(4);
    // Directly after their item, so a firmware that annotates the entry it just
    // parsed needs no lookup — and each still names the id, so one that indexes
    // instead is not relying on ordering it never agreed to.
    expect(lines.slice(lines.indexOf(item), lines.indexOf(item) + 3)).toEqual([
      "item\tchannel\tsign\t灯牌",
      "rev\tsign\tabc123",
      "ttl\tsign\t10000",
    ]);
  });

  test("emits nothing extra for an entry that has no frames of its own", () => {
    // 音乐 / 游戏 / 设置 are screens, not channels: there is no bundle to cache
    // and no render to age out, so annotating them would be bytes on every poll
    // for a question that does not apply.
    const hub = new OsLinkHub();
    hub.setMenu([entry("music", "音乐", "music")]);
    const lines = hub.serialize().split("\n");
    expect(lines.some((line) => line.startsWith("rev\t"))).toBe(false);
    expect(lines.some((line) => line.startsWith("ttl\t"))).toBe(false);
  });

  test("clamps a ttl instead of trusting the caller", () => {
    const hub = new OsLinkHub();
    // Zero would turn a clock face into a download loop on a single-core device
    // with a 15 ms panel; a week would not survive the firmware's atoi as an
    // int32 count of milliseconds.
    hub.setMenu([
      { ...entry("a", "A"), ttlMs: 0 },
      { ...entry("b", "B"), ttlMs: 7 * 86_400_000 },
      { ...entry("c", "C"), ttlMs: Number.NaN },
    ]);
    const lines = hub.serialize().split("\n");
    expect(lines).toContain("ttl\ta\t1000");
    expect(lines).toContain("ttl\tb\t86400000");
    expect(lines.some((line) => line.startsWith("ttl\tc\t"))).toBe(false);
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
      proto: 0,
      batteryPercent: 87,
      charging: false,
      flashed: false,
    });
    expect(hub.pendingWaiters()).toBe(1);
    await pending;
    expect(hub.getTelemetry()?.ip).toBe("192.168.8.240");
  });

  test("the device's own record retires the request, even with uptime rising", () => {
    // The uptime heuristic is wrong in a case that really happens: an upgrade
    // early in a boot, where the last report before the reboot carries a
    // SMALLER uptime than the first report after it. The device's record is
    // the evidence; the heuristic is only for firmware that cannot send one.
    const hub = new OsLinkHub();
    const beat = (uptimeMs: number, upgradeSeqInstalled?: number) => hub.report({
      screen: "launcher",
      focus: "btc",
      wifi: "online",
      ip: "192.168.8.240",
      uptimeMs,
      freeKb: 900,
      supplicantRestarts: 0,
      proto: 0,
      batteryPercent: 87,
      charging: false,
      flashed: true,
      ...(upgradeSeqInstalled === undefined ? {} : { upgradeSeqInstalled }),
    });

    beat(3_000, 0);
    const asked = hub.requestUpgrade();
    expect(hub.getUpgradeSeq()).toBe(asked);

    // The reboot happened, and the first report after it has a LARGER uptime
    // than the last one before it — the heuristic sees nothing.
    beat(9_000, asked);
    expect(hub.getUpgradeSeq()).toBe(0);
    expect(hub.serialize()).not.toContain("upgrade\t");
  });

  test("a device that has installed nothing does not retire the request", () => {
    // 0 is a real answer, not a missing one. A device still working on the
    // request keeps reporting 0, and the request has to survive that.
    const hub = new OsLinkHub();
    const beat = (uptimeMs: number, upgradeSeqInstalled: number) => hub.report({
      screen: "launcher", focus: "btc", wifi: "online", ip: "192.168.8.240",
      uptimeMs, freeKb: 900, supplicantRestarts: 0, proto: 0,
      batteryPercent: 87, charging: false, flashed: true, upgradeSeqInstalled,
    });

    beat(3_000, 0);
    const asked = hub.requestUpgrade();
    beat(13_000, 0);
    expect(hub.getUpgradeSeq()).toBe(asked);
    // An older record — the device installed something, but not this.
    beat(23_000, asked - 1);
    expect(hub.getUpgradeSeq()).toBe(asked);
    beat(33_000, asked);
    expect(hub.getUpgradeSeq()).toBe(0);
  });

  test("a reboot withdraws a standing install request", () => {
    // The vendor updater ends in a restart, so an uptime that went backwards
    // while a request stood means the device already acted on it. Leaving the
    // request up is the whole boot loop: the panel cannot remember across the
    // reboot, so the process holding the request has to.
    const hub = new OsLinkHub();
    const beat = (uptimeMs: number) => hub.report({
      screen: "launcher",
      focus: "btc",
      wifi: "online",
      ip: "192.168.8.240",
      uptimeMs,
      freeKb: 900,
      supplicantRestarts: 0,
      proto: 0,
      batteryPercent: 87,
      charging: false,
      flashed: true,
    });

    beat(900_000);
    const asked = hub.requestUpgrade();
    expect(asked).toBeGreaterThan(0);
    expect(hub.serialize().split("\n")).toContain(`upgrade\t${asked}`);

    beat(905_000);
    expect(hub.getUpgradeSeq()).toBe(asked);

    beat(4_000);
    expect(hub.getUpgradeSeq()).toBe(0);
    expect(hub.serialize()).not.toContain("upgrade\t");

    // And the next press is still a NEWER id than the withdrawn one, or the
    // device's own /data record would read it as one it already installed.
    const again = hub.requestUpgrade();
    expect(again).toBeGreaterThan(asked);
  });

  test("asks the clock to open Bluetooth, and only once it has been asked", () => {
    // The console's 蓝牙配网 wizard can only SCAN. ZOS advertises while it is
    // offline, or for five minutes after somebody presses 设置 → 配网 on the
    // device itself — so on a clock that is online and working, which is exactly
    // the one whose owner is moving it to a new router, the browser's chooser is
    // empty. This key is the console asking for that window from the LAN.
    const hub = new OsLinkHub();
    expect(hub.getBleOpenSeq()).toBe(0);
    // Withheld until asked, like `upgrade`: a firmware that has never heard of
    // the key ignores it, and one that has must not see it on every document.
    expect(hub.serialize()).not.toContain("bleopen");

    const seq = hub.requestBleOpen();
    expect(hub.getBleOpenSeq()).toBe(seq);
    expect(hub.serialize().split("\n")).toContain(`bleopen\t${seq}`);

    // Two presses in one second must still move forward: the device honours a
    // RISING sequence, so a repeated id is a request it silently ignores.
    const again = hub.requestBleOpen();
    expect(again).toBeGreaterThan(seq);
    expect(hub.serialize().split("\n")).toContain(`bleopen\t${again}`);

    // And it keeps being carried, because the document is PULLED: a request the
    // device has not polled for yet has to still be in it. Which is why the
    // device gates on the rising edge rather than on the key being present.
    hub.setDisplay({ focus: "btc", pinned: false });
    expect(hub.serialize().split("\n")).toContain(`bleopen\t${again}`);
  });

  test("but it STOPS being carried once the device's own window has closed", () => {
    // The firmware opens the radio for five minutes and then closes it. A
    // request that outlives that is asking for something that is no longer
    // happening — and it is worse than useless: the device arms on an id
    // greater than the one it last acted on, and that memory dies with a power
    // cycle. A standing request is therefore a clock that opens its radio and
    // jumps to the provisioning screen on EVERY boot, with nobody present.
    // Exactly the shape of the install request's boot loop.
    let clock = 1_700_000_000_000;
    const hub = new OsLinkHub(() => clock);
    const seq = hub.requestBleOpen();
    expect(hub.serialize().split("\n")).toContain(`bleopen\t${seq}`);

    clock += (BLE_OPEN_WINDOW_SEC - 5) * 1000;
    expect(hub.serialize().split("\n")).toContain(`bleopen\t${seq}`);

    clock += 10_000;
    expect(hub.serialize()).not.toContain("bleopen");

    // And asking again re-opens it, rather than being permanently spent.
    const again = hub.requestBleOpen();
    expect(again).toBeGreaterThan(seq);
    expect(hub.serialize().split("\n")).toContain(`bleopen\t${again}`);
  });

  test("the open-Bluetooth id survives a service restart", () => {
    // Seconds-since-epoch, not a count, for the same reason requestUpgrade is:
    // the device compares against the highest id it has already acted on, and a
    // counter that restarts at 1 with this Bun process would hand a device that
    // stayed up an id it has already honoured — the request would be dropped and
    // the user would press 开始配网 forever with nothing happening on the clock.
    const before = new OsLinkHub();
    const asked = before.requestBleOpen();
    expect(asked).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);

    const restarted = new OsLinkHub();
    expect(restarted.getBleOpenSeq()).toBe(0);
    // A counter would answer 1 here, which is below every id the device has seen.
    expect(restarted.requestBleOpen()).toBeGreaterThanOrEqual(asked);
  });

  test("still produces the exact bytes the firmware's parser is tested against", () => {
    // device/tc002-os/hostcheck/fixtures/state-doc.txt is parsed by the C++
    // self-check. Without this assertion the two sides could drift: the encoder
    // would change, the fixture would keep passing on the firmware side, and the
    // mismatch would only appear on hardware as a menu that silently went empty.
    //
    // The channels carry a revision and a ttl because that is the shape a
    // current service actually emits, and because the placement of those two
    // records — their own keys, after their item, each repeating its id — is
    // what the firmware's parser is written against. A fifth field on `item`
    // instead would make a deployed build drop every menu entry.
    const hub = new OsLinkHub();
    hub.setMenu([
      { ...entry("btc", "市场轮播"), rev: "9f14c0b2ae31", ttlMs: 60_000 },
      { ...entry("matrixclock", "数字雨时钟"), rev: "e90a8dc5b287", ttlMs: 10_000 },
      { ...entry("notice", "通知板"), rev: "0c33d18a7b45", ttlMs: 30_000 },
      entry("music", "音乐", "music"),
      entry("game", "游戏", "game"),
      entry("vibe", "VIBE", "vibe"),
      entry("settings", "设置", "settings"),
    ]);
    hub.setDisplay({ focus: "notice", pinned: true });
    // A live interval rather than the 0 default, so the cross-language check
    // covers a value the parser has to clamp and read rather than a field it
    // could drop without either side noticing.
    hub.setVibePageInterval(15);
    // The VIBE block is in the fixture for the same reason the channels' rev and
    // ttl are: its records are what the firmware's parser is written against —
    // one `vibea` per agent, an optional `vibes`, then that agent's metric rows,
    // each repeating the id so the parser may index rather than trust ordering.
    hub.setVibe([
      {
        id: "claude",
        label: "Claude",
        plan: "Max 20x",
        stale: false,
        metrics: [
          { label: "Session", used: 11, limit: 100, resetSec: 18_000 },
          { label: "Weekly", used: 72, limit: 100, resetSec: 259_200 },
        ],
      },
      {
        id: "codex",
        label: "Codex",
        plan: "Plus",
        stale: true,
        metrics: [{ label: "Weekly", used: 4, limit: 100, resetSec: -1 }],
      },
    ]);

    const fixture = readFileSync(
      join(import.meta.dir, "../device/tc002-os/hostcheck/fixtures/state-doc.txt"),
      "utf8",
    );
    expect(hub.serialize()).toBe(fixture);
  });

  test("the vibe block is idempotent, so a five-minute republish wakes nobody", () => {
    const hub = new OsLinkHub();
    const agents = () => [{
      id: "claude",
      label: "Claude",
      plan: "Max 20x",
      stale: false,
      metrics: [{ label: "Session", used: 11, limit: 100, resetSec: 18_000 }],
    }];
    hub.setVibe(agents());
    const afterFirst = hub.currentSeq();
    // The publisher runs on a timer; an unchanged payload must not bump the
    // sequence or every parked long poll wakes for nothing every five minutes.
    hub.setVibe(agents());
    expect(hub.currentSeq()).toBe(afterFirst);

    const moved = agents();
    moved[0]!.metrics[0]!.used = 12;
    hub.setVibe(moved);
    expect(hub.currentSeq()).toBe(afterFirst + 1);
  });

  test("the VIBE page dwell survives a round where nobody is signed in", () => {
    const hub = new OsLinkHub();
    hub.setVibePageInterval(20);
    // The collector failing is `setVibe([])` — src/service.ts does exactly that
    // in its catch — and the block collapses to a bare `vibe\t0`. The dwell is
    // a setting, not an agent row, so it has to still be in the document: this
    // is why the key is emitted from serialize() and not from serializeVibe().
    hub.setVibe([]);
    const doc = hub.serialize();
    expect(doc).toContain("vibeauto\t20");
    expect(doc).toContain("vibe\t0");
  });

  test("the page dwell is 0 or in range, and an equal write wakes nobody", () => {
    const hub = new OsLinkHub();
    expect(hub.getVibePageInterval()).toBe(0);

    hub.setVibePageInterval(15);
    const afterFirst = hub.currentSeq();
    hub.setVibePageInterval(15);
    expect(hub.currentSeq()).toBe(afterFirst);

    // Clamped rather than rejected — the route rejects first, and the hub does
    // not trust its caller. 0 is the off state and stays 0 rather than being
    // floored up to the minimum.
    hub.setVibePageInterval(1);
    expect(hub.getVibePageInterval()).toBe(OS_VIBE_MIN_PAGE_INTERVAL_SEC);
    hub.setVibePageInterval(99_999);
    expect(hub.getVibePageInterval()).toBe(OS_VIBE_MAX_PAGE_INTERVAL_SEC);
    hub.setVibePageInterval(0);
    expect(hub.getVibePageInterval()).toBe(0);
    hub.setVibePageInterval(Number.NaN);
    expect(hub.getVibePageInterval()).toBe(0);
    expect(hub.serialize()).toContain("vibeauto\t0");
  });

  test("页内那一格的时间分配也在线上，默认值也照发", () => {
    const hub = new OsLinkHub();
    // Emitted even untouched: the panel's shipped 3200/1600 are what a fresh
    // install must keep drawing, and absence is what an OLD service looks like.
    expect(hub.serialize()).toContain("vibedwell\t3200\t1600");

    hub.setVibeCellDwell(5_000, 0);
    expect(hub.getVibeCellDwell()).toEqual({ valueMs: 5_000, resetMs: 0 });
    // 0 passes through on the countdown half — that is "just the number" — but
    // the value half is floored, because a cell that never shows it is not a row.
    hub.setVibeCellDwell(1, 1);
    expect(hub.getVibeCellDwell()).toEqual({
      valueMs: OS_VIBE_MIN_CELL_DWELL_MS,
      resetMs: OS_VIBE_MIN_CELL_DWELL_MS,
    });

    const afterFirst = hub.currentSeq();
    hub.setVibeCellDwell(OS_VIBE_MIN_CELL_DWELL_MS, OS_VIBE_MIN_CELL_DWELL_MS);
    expect(hub.currentSeq()).toBe(afterFirst);
  });

  test("vibe values are clamped and separators can never reach the wire", () => {
    const hub = new OsLinkHub();
    hub.setVibe([{
      // A label carrying a tab would split into fields the parser never agreed
      // to; channel names already taught us that (sanitizeField).
      id: "claude",
      label: "Cla\tude",
      plan: "Max\n20x",
      stale: false,
      metrics: [
        { label: "Ses\tsion", used: 4_000, limit: -5, resetSec: Number.NaN },
        { label: "Weekly", used: 72, limit: 100, resetSec: 60 },
        { label: "Third", used: 1, limit: 100, resetSec: 60 },
      ],
    }]);
    const doc = hub.serialize();
    expect(doc).toContain("vibea\tclaude\tCla ude\tMax 20x");
    // 999 is what three digit cells can hold; a negative limit is no ceiling.
    expect(doc).toContain("vibem\tclaude\tSes sion\t999\t0\t-1");
    // Two starred metrics is the panel's budget, so a third never ships.
    expect(doc).not.toContain("Third");
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
      proto: 0,
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

describe("device settings requested from the console", () => {
  test("a write bumps a sequence the device can compare against", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const hub = new OsLinkHub();
    expect(hub.serialize()).not.toContain("setseq");

    hub.setDeviceSettings({ volume: 4 });
    const first = hub.serialize();
    expect(first).toContain("setseq\t1");
    expect(first).toContain("setvol\t4");
    expect(first).not.toContain("setbri");

    hub.setDeviceSettings({ brightness: 7 });
    const second = hub.serialize();
    // The sequence is what lets the knob win afterwards: the document still
    // carries the console's old volume, and a device that re-applied it on
    // every poll would make the physical control unusable.
    expect(second).toContain("setseq\t2");
    expect(second).toContain("setvol\t4");
    expect(second).toContain("setbri\t7");
  });

  // --- which field moved -----------------------------------------------------
  // The document carrying BOTH levels forever is what makes the values right and
  // the FEEDBACK wrong: from "volume 4, brightness 7" the device cannot tell
  // which slider the user just touched, so it acted on both — a zero-sized
  // brightness nudge, and a brightness bar drawn over the volume one. Every
  // change of volume from the console showed the brightness screen.

  test("each level carries the sequence it was last asked for at", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const hub = new OsLinkHub();

    hub.setDeviceSettings({ volume: 4 });
    expect(hub.serialize()).toContain("setvolseq\t1");

    hub.setDeviceSettings({ brightness: 7 });
    const second = hub.serialize();
    // Volume is still in the document — it has to be, so a device that reads
    // two writes as one poll applies both — but its sequence has not moved, and
    // that is the whole difference the panel needs.
    expect(second).toContain("setvol\t4");
    expect(second).toContain("setvolseq\t1");
    expect(second).toContain("setbri\t7");
    expect(second).toContain("setbriseq\t2");

    hub.setDeviceSettings({ volume: 2 });
    const third = hub.serialize();
    expect(third).toContain("setvolseq\t3");
    expect(third).toContain("setbriseq\t2");
  });

  test("re-requesting the level already set still moves its sequence", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const hub = new OsLinkHub();
    hub.setDeviceSettings({ volume: 4 });
    hub.setDeviceSettings({ volume: 4 });
    // The sequence means "the user moved this control", not "this number
    // differs". A slider dragged back to where it started must still raise the
    // bar, or the console gets no answer at all — the failure mode that makes
    // "only show a bar when the value changed" the wrong fix.
    expect(hub.serialize()).toContain("setvolseq\t2");
    expect(hub.getDeviceSettings().seq).toBe(2);
  });

  test("a write naming both levels stamps both", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const hub = new OsLinkHub();
    hub.setDeviceSettings({ volume: 5, brightness: 9 });
    const doc = hub.serialize();
    expect(doc).toContain("setseq\t1");
    expect(doc).toContain("setvolseq\t1");
    expect(doc).toContain("setbriseq\t1");
  });

  test("the settings block is the byte sequence the firmware self-check parses", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const hub = new OsLinkHub();
    hub.setDeviceSettings({ brightness: 7 });
    hub.setDeviceSettings({ brightness: 7 });
    hub.setDeviceSettings({ brightness: 7 });
    hub.setDeviceSettings({ volume: 4 });
    // Order and adjacency, not just presence: device/tc002-os/hostcheck asserts
    // this exact block, so the two halves of the wire contract are pinned from
    // both sides rather than from one idealisation of it.
    expect(hub.serialize()).toContain(
      "setseq\t4\nsetvol\t4\nsetvolseq\t4\nsetbri\t7\nsetbriseq\t3\n",
    );
  });

  test("values are clamped to the device's own scales, not the caller's", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const hub = new OsLinkHub();
    hub.setDeviceSettings({ volume: 99, brightness: -5 });
    expect(hub.getDeviceSettings()).toMatchObject({ volume: 6, brightness: 1 });
  });

  test("a write with nothing in it neither bumps nor wakes the parked polls", async () => {
    const { OsLinkHub } = await import("../src/os-link.ts");
    const hub = new OsLinkHub();
    const before = hub.currentSeq();
    hub.setDeviceSettings({});
    expect(hub.currentSeq()).toBe(before);
    expect(hub.getDeviceSettings().seq).toBe(0);
  });

  // --- 主题设置 --------------------------------------------------------------
  // One theme store for two firmwares (ADR 0007): the console's panel writes
  // sDeviceState, the sideloaded lyrics player reads it from
  // /api/music/device/state, and ZOS reads the same three values out of here.

  test("carries the theme even before anyone has chosen one", () => {
    const hub = new OsLinkHub();
    const lines = hub.serialize().split("\n");
    // The defaults are sDeviceState's, so the two agree before the first write
    // rather than only after one.
    expect(hub.getLyricTheme()).toEqual({ mode: "spotlight", skin: "signal", accent: null });
    expect(lines).toContain("mode\tspotlight");
    expect(lines).toContain("skin\tsignal");
    expect(lines.some((line) => line.startsWith("accent\t"))).toBe(false);
  });

  test("emits the theme outside the np block, so the empty states keep their colour", () => {
    const hub = new OsLinkHub();
    hub.setLyricTheme({ mode: "cascade", skin: "tape", accent: "FF8844" });
    const lines = hub.serialize().split("\n");
    // Nothing is playing here at all. A theme nested under `np` would drop back
    // to the defaults the moment the user pressed pause — the colour would walk
    // off the panel with the music, and the three empty states (未配置 / 离线 /
    // 未播放) would never have one.
    expect(lines.some((line) => line.startsWith("np\t"))).toBe(false);
    expect(lines).toContain("mode\tcascade");
    expect(lines).toContain("skin\ttape");
    // Lower-cased on the way in, because the firmware compares six hex digits
    // and the console's colour picker does not promise a case.
    expect(lines).toContain("accent\tff8844");
  });

  test("the theme survives a track ending", () => {
    const hub = new OsLinkHub();
    hub.setLyricTheme({ skin: "arcade" });
    hub.setNowPlaying({
      track: "One Last Kiss", artist: "Hikaru Utada", playing: true,
      positionMs: 41_000, durationMs: 244_000, lyric: "Wasurerarenai hito",
      lyricStartMs: 40_500, lyricEndMs: 44_000, lyricUntilMs: 44_000,
    });
    hub.setNowPlaying(null);
    expect(hub.serialize()).toContain("skin\tarcade");
  });

  test("ignores a value it does not recognise instead of failing the write", () => {
    const hub = new OsLinkHub();
    hub.setLyricTheme({ skin: "tape" });
    const before = hub.currentSeq();
    // Defence in depth behind applyControlPatch, which has already rejected
    // these. A hub is not a request handler: dropping one bad field beats
    // failing an update that also carried a good one.
    hub.setLyricTheme({ mode: "kaleidoscope" as never, skin: "vaporwave" as never });
    hub.setLyricTheme({ accent: "ff88" });
    hub.setLyricTheme({ accent: "ff8844aa" });
    hub.setLyricTheme({ accent: 0xff8844 as never });
    expect(hub.getLyricTheme()).toEqual({ mode: "spotlight", skin: "tape", accent: null });
    expect(hub.currentSeq()).toBe(before);
  });

  test("a theme write that changes nothing does not wake every parked poll", async () => {
    const hub = new OsLinkHub();
    hub.setLyricTheme({ mode: "ticker", skin: "blueprint", accent: "00ff99" });
    const seq = hub.currentSeq();
    const pending = hub.waitForChange(seq, 40);
    // The control handler re-publishes this on every /control and /report, and
    // the console re-sends its restored theme after the first poll. Bumping for
    // an unchanged value would turn that into a broadcast storm.
    hub.setLyricTheme({ mode: "ticker", skin: "blueprint", accent: "00FF99" });
    expect(hub.currentSeq()).toBe(seq);
    expect(hub.pendingWaiters()).toBe(1);
    await pending;
  });

  test("clearing the accent is a change, not a missing field", () => {
    const hub = new OsLinkHub();
    hub.setLyricTheme({ accent: "ff8844" });
    const seq = hub.currentSeq();
    hub.setLyricTheme({ accent: null });
    expect(hub.currentSeq()).toBeGreaterThan(seq);
    expect(hub.serialize().split("\n").some((line) => line.startsWith("accent\t"))).toBe(false);
    // A patch that simply omits `accent` must not clear it — the console sends
    // one key per click, so every write is a patch of exactly one field.
    hub.setLyricTheme({ accent: "112233" });
    hub.setLyricTheme({ mode: "skyline" });
    expect(hub.getLyricTheme().accent).toBe("112233");
  });

  // --- the lyric window ------------------------------------------------------

  test("carries the current line's window, which is what the modes animate against", () => {
    const hub = new OsLinkHub();
    hub.setNowPlaying({
      track: "One Last Kiss", artist: "Hikaru Utada", playing: true,
      positionMs: 41_000, durationMs: 244_000, lyric: "Wasurerarenai hito",
      lyricStartMs: 40_500, lyricEndMs: 44_000, lyricUntilMs: 44_000,
    });
    const lines = hub.serialize().split("\n");
    expect(lines).toContain("lyric\tWasurerarenai hito");
    expect(lines).toContain("lyricat\t40500");
    expect(lines).toContain("lyricend\t44000");
  });

  test("omits the window rather than sending a degenerate one", () => {
    const hub = new OsLinkHub();
    hub.setNowPlaying({
      track: "Her Majesty", artist: "The Beatles", playing: true,
      positionMs: 1_000, durationMs: 23_000, lyric: "a pretty nice girl",
      // A caller that cannot answer — an untimed lyric, or a console that
      // predates this field. The absence carries the meaning, which is also
      // exactly what an older service looks like to a newer firmware.
      lyricStartMs: 0, lyricEndMs: 0, lyricUntilMs: 0,
    });
    const lines = hub.serialize().split("\n");
    expect(lines).toContain("lyric\ta pretty nice girl");
    expect(lines.some((line) => line.startsWith("lyricat\t"))).toBe(false);
    expect(lines.some((line) => line.startsWith("lyricend\t"))).toBe(false);
  });

  test("a repeated chorus line still wakes the device", () => {
    let now = 1_000_000;
    const hub = new OsLinkHub(() => now);
    const line = (lyricStartMs: number) => ({
      track: "T", artist: "A", playing: true,
      positionMs: lyricStartMs, durationMs: 200_000, lyric: "啦啦啦",
      lyricStartMs, lyricEndMs: lyricStartMs + 3_000, lyricUntilMs: lyricStartMs + 3_000,
    });
    hub.setNowPlaying(line(30_000));
    const seq = hub.currentSeq();
    now += 3_000;
    // Same words, new line. Keyed on the text alone this would not bump, the
    // device would never see the new window, and it would keep animating the
    // previous line with progress pinned at 1 — the line sitting there fully
    // sung while the song moved on.
    hub.setNowPlaying(line(33_000));
    expect(hub.currentSeq()).toBeGreaterThan(seq);
    expect(hub.serialize()).toContain("lyricat\t33000");
  });

  // The reported bug, on the wire. 孤勇者's "谁说站在光里的才算英雄" is sung from
  // 110330 for 5.29 s and the next line does not arrive until 128880.
  const GUYONGZHE = {
    track: "孤勇者", artist: "陈奕迅", playing: true as const,
    positionMs: 113_000, durationMs: 260_000,
    lyric: "谁说站在光里的才算英雄",
    lyricStartMs: 110_330,
    lyricEndMs: 115_620,
    lyricUntilMs: 128_880,
    lyricWords: [
      { startMs: 110_330, endMs: 110_680, text: "谁" },
      { startMs: 110_680, endMs: 110_930, text: "说" },
      { startMs: 110_930, endMs: 111_390, text: "站" },
      { startMs: 111_390, endMs: 111_790, text: "在" },
      { startMs: 111_790, endMs: 112_190, text: "光" },
      { startMs: 112_190, endMs: 112_590, text: "里" },
      { startMs: 112_590, endMs: 113_230, text: "的" },
      { startMs: 113_230, endMs: 113_610, text: "才" },
      { startMs: 113_610, endMs: 114_000, text: "算" },
      { startMs: 114_000, endMs: 114_340, text: "英" },
      { startMs: 114_340, endMs: 115_620, text: "雄" },
    ],
  };

  /** A device that has said it understands the sung/display split. */
  function reportProto(hub: OsLinkHub, proto: number): void {
    hub.report({
      screen: "music", focus: "", wifi: "online", ip: "192.168.8.240",
      uptimeMs: 1_000, freeKb: 900, supplicantRestarts: 0, proto,
      batteryPercent: 87, charging: false, flashed: true,
    });
  }

  test("separates when the line stops being sung from when it leaves the panel", () => {
    const hub = new OsLinkHub();
    reportProto(hub, OS_PROTO_LYRIC_WINDOW);
    hub.setNowPlaying(GUYONGZHE);
    const lines = hub.serialize().split("\n");
    // The sung end, which is 13.26 s earlier than the successor.
    expect(lines).toContain("lyricend\t115620");
    // The display window is the NEW key, and only the cascade choreography may
    // read it — the line has to stay on the panel through the instrumental
    // rather than flying off the instant the voice stops.
    expect(lines).toContain("lyricuntil\t128880");
  });

  test("sends a firmware that has not announced itself the document it was built for", () => {
    // ZOS is flashed, so a device in the field keeps its build across service
    // restarts. Its MusicScreen::lineProgress() feeds `lyricend` straight into
    // cascadeBandY, whose exit ramp reaches y = -16 at progress 1 — tightening
    // the key underneath it would blank 升降 for the whole 13.26 s instrumental.
    // Silence therefore means "the old encoding", byte for byte.
    const hub = new OsLinkHub();
    hub.setNowPlaying(GUYONGZHE);
    const before = hub.serialize().split("\n");
    expect(before).toContain("lyricend\t128880");
    expect(before.some((line) => line.startsWith("lyricuntil\t"))).toBe(false);
    // A per-glyph table is up to 207 bytes on every document; a renderer that
    // cannot read it should not be paying for it either.
    expect(before.some((line) => line.startsWith("lyricw\t"))).toBe(false);

    // …and the moment it does announce itself, without waiting for the next
    // lyric line to move.
    const seq = hub.currentSeq();
    reportProto(hub, OS_PROTO_LYRIC_WINDOW);
    expect(hub.currentSeq()).toBeGreaterThan(seq);
    const after = hub.serialize().split("\n");
    expect(after).toContain("lyricend\t115620");
    expect(after).toContain("lyricuntil\t128880");
    expect(after.some((line) => line.startsWith("lyricw\t"))).toBe(true);

    // A downgrade takes it away again: the field describes the build that is on
    // the device now, not the best one ever seen.
    reportProto(hub, 0);
    expect(hub.serialize().split("\n")).toContain("lyricend\t128880");
  });

  test("omits the display window when it says nothing the sung end does not", () => {
    const hub = new OsLinkHub();
    reportProto(hub, OS_PROTO_LYRIC_WINDOW);
    hub.setNowPlaying({ ...GUYONGZHE, lyricUntilMs: 115_620 });
    const lines = hub.serialize().split("\n");
    expect(lines).toContain("lyricend\t115620");
    expect(lines.some((line) => line.startsWith("lyricuntil\t"))).toBe(false);
  });

  test("the cell table has exactly one entry per glyph the panel will draw", () => {
    const hub = new OsLinkHub();
    reportProto(hub, OS_PROTO_LYRIC_WINDOW);
    hub.setNowPlaying(GUYONGZHE);
    const table = hub.serialize().split("\n").find((line) => line.startsWith("lyricw\t"))!;
    const payload = table.slice("lyricw\t".length);
    // One field, comma separated: StateDoc::splitTabs stops after three tabs,
    // so a tab-separated table would arrive truncated.
    expect(table.split("\t")).toHaveLength(2);
    const pairs = payload.split(",").map(Number);
    expect(pairs.length % 2).toBe(0);
    expect(pairs.length / 2).toBe([...GUYONGZHE.lyric].length);
    // Offsets are relative to `lyricat`, which is already on the wire.
    expect(pairs[0]).toBe(0);
    expect(pairs[1]).toBe(350);
    // The last glyph is the held one — 1.28 s of 雄 against 350 ms of 谁. This
    // is exactly what a uniform sweep cannot express.
    expect(pairs[pairs.length - 2]).toBe(114_340 - 110_330);
    expect(pairs[pairs.length - 1]).toBe(1_280);
  });

  test("truncates the cell table with the label, never independently", () => {
    // clampLabel keeps 24 cells. The table's index IS the glyph index, so a
    // table built against the untruncated line would light the wrong character
    // for the rest of the song.
    const text = "一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾佰仟万亿零";
    const words = [...text].map((glyph, index) => ({
      startMs: 1_000 + index * 100,
      endMs: 1_100 + index * 100,
      text: glyph,
    }));
    const hub = new OsLinkHub();
    reportProto(hub, OS_PROTO_LYRIC_WINDOW);
    hub.setNowPlaying({
      track: "T", artist: "A", playing: true,
      positionMs: 1_500, durationMs: 90_000,
      lyric: text, lyricStartMs: 1_000, lyricEndMs: 1_000 + words.length * 100,
      lyricUntilMs: 40_000, lyricWords: words,
    });
    const lines = hub.serialize().split("\n");
    const label = lines.find((line) => line.startsWith("lyric\t"))!.slice("lyric\t".length);
    const pairs = lines.find((line) => line.startsWith("lyricw\t"))!
      .slice("lyricw\t".length).split(",");
    expect([...label]).toHaveLength(24);
    expect(pairs.length / 2).toBe(24);
  });

  test("drops the table rather than shipping one that does not fit its line", () => {
    // Words that do not rebuild the text exactly cannot be mapped to glyphs, and
    // a table one cell out of step is invisible on a screenshot and impossible
    // to diagnose. Falling back to the line-level sweep is the honest answer.
    const hub = new OsLinkHub();
    reportProto(hub, OS_PROTO_LYRIC_WINDOW);
    hub.setNowPlaying({
      ...GUYONGZHE,
      lyricWords: [{ startMs: 110_330, endMs: 115_620, text: "谁说站在光" }],
    });
    const lines = hub.serialize().split("\n");
    expect(lines.some((line) => line.startsWith("lyricw\t"))).toBe(false);
    // The sung end still stands — it did not come from the cell table.
    expect(lines).toContain("lyricend\t115620");
  });

  test("a cell table arriving after its own line still reaches the device", () => {
    let now = 1_000_000;
    const hub = new OsLinkHub(() => now);
    reportProto(hub, OS_PROTO_LYRIC_WINDOW);
    // The console reports on a 4 s timer and a track switch can land a wordless
    // report first. Keyed on the line's start alone this refinement would never
    // bump the sequence, the parked poll would never be released, and the panel
    // would sweep a line it could have been walking word by word.
    const { lyricWords, ...wordless } = GUYONGZHE;
    hub.setNowPlaying(wordless);
    const seq = hub.currentSeq();
    expect(hub.serialize()).not.toContain("lyricw\t");
    now += 500;
    hub.setNowPlaying(GUYONGZHE);
    expect(hub.currentSeq()).toBeGreaterThan(seq);
    expect(hub.serialize()).toContain("lyricw\t");
  });
});

// --- 夜间休眠 ----------------------------------------------------------------
//
// A night window, an idle timeout inside it, and a dark panel. The service's
// half is three things: carrying the request on the pull document, carrying the
// device's answer back on telemetry, and — the one that is easy to get wrong —
// NOT counting its own polling as the user operating the clock.

describe("night sleep on the pull document", () => {
  const report = (
    hub: OsLinkHub,
    sleep?: {
      on: boolean;
      startMin: number;
      endMin: number;
      idleSec: number;
      asleep: boolean;
      clockSynced: boolean;
    },
  ) =>
    hub.report({
      screen: "launcher",
      focus: "",
      wifi: "net",
      ip: "192.168.8.240",
      uptimeMs: 1_000,
      freeKb: 16_000,
      supplicantRestarts: 0,
      proto: 0,
      batteryPercent: 87,
      charging: false,
      flashed: true,
      ...(sleep === undefined ? {} : { sleep }),
    });

  test("emits nothing until the console has written one, then only what it wrote", () => {
    const hub = new OsLinkHub();
    // Withheld before the first write for the same reason the settings block
    // is: an unwritten default sitting in every document would be a request the
    // device could act on, and the 设置 rows own this until a console says
    // otherwise.
    expect(hub.serialize()).not.toContain("sleep");
    // NULL, not the firmware's defaults. The hub is not a shadow copy of the
    // device's config; it carries requests, and "never asked" has to be
    // representable or it gets sent as an answer.
    expect(hub.getSleep()).toEqual({
      enabled: null, startMin: null, endMin: null, idleSec: null, seq: 0,
    });

    hub.setSleep({ enabled: true });
    // Order and adjacency, not just presence: the firmware self-check parses
    // this exact block, so the wire contract is pinned from both sides — and
    // its "an enable-only request leaves the window alone" case is only
    // testing something real if THIS is what an enable-only write emits.
    expect(hub.serialize()).toContain("sleepseq\t1\nsleepon\t1\n");
    const lines = hub.serialize().split("\n").filter((line) => line.startsWith("sleep"));
    expect(lines).toEqual(["sleepseq\t1", "sleepon\t1"]);

    // Naming a field keeps it named: the device may coalesce several writes
    // into one poll, so the document has to keep repeating everything asked
    // for so far.
    hub.setSleep({ idleSec: 600 });
    expect(hub.serialize().split("\n").filter((line) => line.startsWith("sleep"))).toEqual([
      "sleepseq\t2", "sleepon\t1", "sleepidle\t600",
    ]);
  });

  test("one sequence for four fields, bumped on every write", async () => {
    const hub = new OsLinkHub();
    const seq = hub.currentSeq();
    const parked = hub.waitForChange(seq, 40);
    hub.setSleep({ enabled: true, startMin: 1320, endMin: 450, idleSec: 600 });
    // A write releases the parked poll: the device has to learn about it before
    // its 8 s hold expires, or the panel keeps the old window for that long.
    expect(hub.pendingWaiters()).toBe(0);
    expect(await parked).toContain("sleepfrom\t1320");
    expect(hub.getSleep()).toEqual({
      enabled: true, startMin: 1320, endMin: 450, idleSec: 600, seq: 1,
    });

    // Re-asking for what the hub already holds STILL bumps. The device's knob
    // is a second writer, so "did the number change" is the wrong question —
    // only a rising sequence can overrule a window the knob set.
    hub.setSleep({ enabled: true, startMin: 1320, endMin: 450, idleSec: 600 });
    expect(hub.getSleep().seq).toBe(2);

    // ...but a write naming nothing is not a write.
    const before = hub.currentSeq();
    hub.setSleep({});
    expect(hub.currentSeq()).toBe(before);
    expect(hub.getSleep().seq).toBe(2);
  });

  test("a partial write leaves the rest of the window alone", () => {
    const hub = new OsLinkHub();
    hub.setSleep({ startMin: 90, endMin: 200, idleSec: 1800 });
    hub.setSleep({ enabled: false });
    expect(hub.getSleep()).toMatchObject({
      enabled: false, startMin: 90, endMin: 200, idleSec: 1800,
    });
  });

  test("a partial write emits only the field it named, and cannot clobber the device", () => {
    // THE BUG THIS EXISTS FOR. The hub used to hold concrete defaults and emit
    // all five keys once the sequence rose, so a console following the spec —
    // "telemetry.sleep is the truth, send at least one field" — that PUT
    // {idleSec:600} alone also shipped `sleepon 0 / sleepfrom 1380 /
    // sleeptill 420`. The firmware reads an absent LINE as "leave this alone",
    // not a sentinel, so it adopted all four and wrote them to /data: adjusting
    // the timeout turned 夜间息屏 off and threw away the window. Inspecting
    // getSleep() could never have caught it — only the wire can.
    const hub = new OsLinkHub();
    hub.setSleep({ idleSec: 600 });
    const lines = hub.serialize().split("\n").filter((line) => line.startsWith("sleep"));
    expect(lines).toEqual(["sleepseq\t1", "sleepidle\t600"]);
    expect(hub.serialize()).not.toContain("sleepon");
    expect(hub.serialize()).not.toContain("sleepfrom");
    expect(hub.serialize()).not.toContain("sleeptill");
    expect(hub.getSleep()).toEqual({
      enabled: null, startMin: null, endMin: null, idleSec: 600, seq: 1,
    });
  });

  test("carries the device's own answer back, and its absence means an old firmware", () => {
    const hub = new OsLinkHub();
    report(hub);
    // The PRESENCE of the block is the capability signal. A firmware from
    // before the feature sends none, and the console must render its controls
    // disabled rather than guessing from `proto` — which this firmware does not
    // send at all.
    expect(hub.getTelemetry()?.sleep).toBeUndefined();

    report(hub, {
      on: true, startMin: 1380, endMin: 420, idleSec: 300,
      asleep: true, clockSynced: true,
    });
    // `asleep` is the whole answer to "a black panel is ambiguous": the console
    // says 休眠中 off this flag rather than inferring sleep from black pixels,
    // which are indistinguishable from a dead clock.
    expect(hub.getTelemetry()?.sleep).toEqual({
      on: true, startMin: 1380, endMin: 420, idleSec: 300,
      asleep: true, clockSynced: true,
    });
  });

  test("the device's report is the truth, and may disagree with the request", () => {
    const hub = new OsLinkHub();
    hub.setSleep({ enabled: true, startMin: 1380, endMin: 420, idleSec: 300 });
    // The knob then set something else. Both are readable, and a console that
    // rendered the request as the truth would show the wrong window for as long
    // as somebody had used the clock.
    report(hub, {
      on: true, startMin: 0, endMin: 480, idleSec: 1800,
      asleep: false, clockSynced: true,
    });
    expect(hub.getSleep()).toMatchObject({ startMin: 1380, idleSec: 300 });
    expect(hub.getTelemetry()?.sleep).toMatchObject({ startMin: 0, idleSec: 1800 });
  });

  test("watching is not operating: a console tab left open changes nothing", () => {
    let now = 1_000_000;
    const hub = new OsLinkHub(() => now);
    hub.setSleep({ enabled: true, startMin: 1380, endMin: 420, idleSec: 300 });
    const seq = hub.getSleep().seq;
    const sleepLines = (): string[] =>
      hub.serialize().split("\n").filter((line) => line.startsWith("sleep"));
    const before = sleepLines();
    expect(before).toHaveLength(5);

    // The console polls the mirror every 250 ms and the state every 2 s while
    // its tab is open — which is most of the time. If any of that reached the
    // device as activity the panel would never sleep for exactly the person
    // most likely to have configured it. The device-side half (that no `sleep*`
    // line and no poll touches lastActivityMs) is asserted in the firmware
    // self-check's eight-hour case.
    for (let i = 0; i < 200; i += 1) {
      now += 250;
      hub.requestMirror();
      hub.putMirrorFrame("AAAA");
      hub.getTelemetry();
      hub.getSleep();
      report(hub, {
        on: true, startMin: 1380, endMin: 420, idleSec: 300,
        asleep: true, clockSynced: true,
      });
    }
    expect(hub.getSleep().seq).toBe(seq);
    // The mirror lease legitimately moves the DOCUMENT's own sequence — that is
    // how the device learns to start streaming. What must not move is the sleep
    // block, because that is the only thing the device reads as a console
    // request, and a request is the only console traffic it counts as activity.
    expect(sleepLines()).toEqual(before);
  });
});
