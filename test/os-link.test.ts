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
      lyricStartMs: 40_500, lyricEndMs: 44_000,
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
      lyricStartMs: 40_500, lyricEndMs: 44_000,
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
      lyricStartMs: 0, lyricEndMs: 0,
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
      lyricStartMs, lyricEndMs: lyricStartMs + 3_000,
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
});
