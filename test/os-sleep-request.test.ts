import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OsLinkHub } from "../src/os-link.ts";
import { OsSleepRequestStore } from "../src/os-sleep-request-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ulanzi-os-sleep-"));
  directories.push(directory);
  return join(directory, "os-sleep-request.json");
}

/**
 * The device's half of the contract, in the only form a TypeScript test can
 * hold it: tcos::applySleepRequest applies a request only when its sequence
 * EXCEEDS the last one it applied, and osLogic primes that number from the first
 * document after boot.
 *
 * Modelled STRICTLY, without the firmware's "a sequence lower than the applied
 * one means the service restarted" tolerance (SleepPolicy.cpp). That tolerance
 * is a safety net for a service whose file is gone, not a licence for the
 * service to ship a counter the device has to second-guess — and a device
 * flashed before it exists is still out there.
 */
class FakeDevice {
  private appliedSeq = 0;
  applied: { enabled?: boolean; startMin?: number; endMin?: number; idleSec?: number } = {};

  /** Primes from the first document after boot, exactly as osLogic does. */
  boot(document: string): void {
    this.appliedSeq = readSleepSeq(document);
  }

  /** True when this document moved the device's configuration. */
  poll(document: string): boolean {
    const seq = readSleepSeq(document);
    if (seq <= this.appliedSeq) return false;
    this.appliedSeq = seq;
    const field = (key: string): number | undefined => {
      const line = document.split("\n").find((row) => row.startsWith(`${key}\t`));
      return line === undefined ? undefined : Number(line.split("\t")[1]);
    };
    const on = field("sleepon");
    if (on !== undefined) this.applied.enabled = on !== 0;
    const startMin = field("sleepfrom");
    if (startMin !== undefined) this.applied.startMin = startMin;
    const endMin = field("sleeptill");
    if (endMin !== undefined) this.applied.endMin = endMin;
    const idleSec = field("sleepidle");
    if (idleSec !== undefined) this.applied.idleSec = idleSec;
    return true;
  }
}

function readSleepSeq(document: string): number {
  const line = document.split("\n").find((row) => row.startsWith("sleepseq\t"));
  return line === undefined ? 0 : Number(line.split("\t")[1]);
}

function sleepLines(hub: OsLinkHub): string[] {
  return hub.serialize().split("\n").filter((line) => line.startsWith("sleep"));
}

describe("夜间息屏 requests survive a service restart", () => {
  // THE BUG, stated as the device sees it. The hub's sequence was plain module
  // memory, so `bun start` — routine, since every web/ change needs a rebuild —
  // put it back at 0 while the clock was still up holding the last number it had
  // applied. The console's next change shipped seq 1, the device correctly
  // refused it, the route answered 200 anyway, and the user had to make as many
  // changes as the old counter had reached before one took.
  test("a restarted hub with no store hands the device a sequence it refuses", () => {
    const device = new FakeDevice();
    const before = new OsLinkHub();
    before.setSleep({ enabled: true, startMin: 1380, endMin: 420 });
    before.setSleep({ idleSec: 600 });
    before.setSleep({ startMin: 1320 });
    device.boot(before.serialize());
    expect(readSleepSeq(before.serialize())).toBe(3);

    const restarted = new OsLinkHub();
    restarted.setSleep({ enabled: false });
    // seq 1 against an applied 3: the escape hatch for a dark panel, dropped.
    expect(device.poll(restarted.serialize())).toBe(false);
  });

  test("a restart resumes the sequence, so one console change reaches the device", async () => {
    const path = await storePath();
    const device = new FakeDevice();

    const live = new OsSleepRequestStore(path);
    const before = new OsLinkHub(() => Date.now(), live);
    before.setSleep({ enabled: true, startMin: 1380, endMin: 420 });
    before.setSleep({ idleSec: 600 });
    before.setSleep({ startMin: 1320 });
    before.setSleep({ idleSec: 900 });
    // Fire and forget in production, awaited here: the store is reached from a
    // request handler that has already answered.
    await live.settled();
    device.boot(before.serialize());

    // The restart. A brand-new process: nothing but the file is left.
    const store = new OsSleepRequestStore(path);
    const restarted = new OsLinkHub(() => Date.now(), store);
    restarted.restoreSleepRequest(await store.load());

    // ONE change, and the device takes it.
    restarted.setSleep({ enabled: false });
    expect(device.poll(restarted.serialize())).toBe(true);
    expect(device.applied.enabled).toBe(false);
    // ...and the window the console had named before the restart is still in the
    // document, because the device may not have polled since it was set.
    expect(device.applied.startMin).toBe(1320);
    expect(device.applied.idleSec).toBe(900);
  });

  test("the resumed document is the one the device already has, so nothing replays", async () => {
    const path = await storePath();
    const store = new OsSleepRequestStore(path);
    const before = new OsLinkHub(() => Date.now(), store);
    before.setSleep({ enabled: true, startMin: 1380, endMin: 420, idleSec: 600 });
    await store.settled();
    const served = sleepLines(before);

    const device = new FakeDevice();
    device.boot(before.serialize());

    const reloaded = new OsSleepRequestStore(path);
    const restarted = new OsLinkHub(() => Date.now(), reloaded);
    restarted.restoreSleepRequest(await reloaded.load());
    // Resumed AT the saved sequence, never one past it: a hub that started at
    // seq+1 would manufacture a rising edge nobody asked for, and the device —
    // which stays up across a service restart, since restarting the service does
    // not touch the clock — would apply the console's old request over whatever
    // its own 设置 rows now hold.
    expect(sleepLines(restarted)).toEqual(served);
    expect(device.poll(restarted.serialize())).toBe(false);
  });

  test("a device that reboots after the service primes on the resumed sequence", async () => {
    const path = await storePath();
    const store = new OsSleepRequestStore(path);
    const before = new OsLinkHub(() => Date.now(), store);
    before.setSleep({ enabled: true });
    before.setSleep({ idleSec: 1800 });
    await store.settled();

    const reloaded = new OsSleepRequestStore(path);
    const restarted = new OsLinkHub(() => Date.now(), reloaded);
    restarted.restoreSleepRequest(await reloaded.load());

    // Fresh boot: sAppliedSleepSeq comes from the first document, so the resumed
    // request is NOT replayed over a window the knob may have changed.
    const device = new FakeDevice();
    device.boot(restarted.serialize());
    expect(device.poll(restarted.serialize())).toBe(false);
    expect(device.applied).toEqual({});
    restarted.setSleep({ enabled: false });
    expect(device.poll(restarted.serialize())).toBe(true);
    expect(device.applied.enabled).toBe(false);
  });

});

describe("the sleep request store", () => {
  test("the first run has no file and the hub is untouched", async () => {
    const path = await storePath();
    const warnings: string[] = [];
    const store = new OsSleepRequestStore(path, (event) => warnings.push(event));
    expect(await store.load()).toBeNull();
    // A missing file is not a fault: it is what the very first start looks like.
    expect(warnings).toEqual([]);
    const hub = new OsLinkHub(() => Date.now(), store);
    hub.restoreSleepRequest(null);
    expect(hub.getSleep()).toEqual({
      enabled: null, startMin: null, endMin: null, idleSec: null, seq: 0,
    });
    expect(sleepLines(hub)).toEqual([]);
  });

  test("a truncated file still lets the service start", async () => {
    const path = await storePath();
    const warnings: string[] = [];
    const store = new OsSleepRequestStore(path, (event) => warnings.push(event));
    // What a killed process or a hand-edit leaves behind. save() cannot produce
    // it — the rename is atomic — so reaching this means something else wrote.
    await Bun.write(path, '{"version":1,"seq":5,"enab');
    expect(await store.load()).toBeNull();
    expect(warnings).toEqual(["os_sleep_request_unreadable"]);
    const hub = new OsLinkHub(() => Date.now(), store);
    hub.restoreSleepRequest(await store.load());
    expect(hub.getSleep().seq).toBe(0);
  });

  test("a file with no usable sequence is refused whole", async () => {
    const path = await storePath();
    const warnings: string[] = [];
    const store = new OsSleepRequestStore(path, (event) => warnings.push(event));
    // The fields without the sequence are worse than nothing: re-emitting them
    // under a counter that restarts at 0 is a request the device must refuse.
    await Bun.write(path, JSON.stringify({ version: 1, enabled: true, idleSec: 600 }));
    expect(await store.load()).toBeNull();
    expect(warnings).toEqual(["os_sleep_request_unreadable"]);
  });

  test("a file from a later version keeps its four known fields", async () => {
    const path = await storePath();
    const warnings: string[] = [];
    const store = new OsSleepRequestStore(path, (event) => warnings.push(event));
    await Bun.write(path, JSON.stringify({
      version: 9,
      seq: 7,
      enabled: true,
      startMin: 1380,
      endMin: 420,
      idleSec: 600,
      // Two fields this version has never heard of. Refusing the file over them
      // would throw away the sequence, which is the one thing it exists to keep.
      dimPercent: 20,
      weekdaysOnly: true,
    }));
    expect(await store.load()).toEqual({
      seq: 7, enabled: true, startMin: 1380, endMin: 420, idleSec: 600,
    });
    expect(warnings).toEqual([]);
  });

  test("an out-of-range field is dropped rather than clamped", async () => {
    const path = await storePath();
    const store = new OsSleepRequestStore(path);
    await Bun.write(path, JSON.stringify({
      version: 1, seq: 4, enabled: "yes", startMin: 5000, endMin: 420, idleSec: 5,
    }));
    // Null is "the console has never named this", so the field is never emitted
    // and the device keeps what its own 设置 rows hold. A clamp would invent a
    // request the user never made and then ship it on the next rising edge.
    expect(await store.load()).toEqual({
      seq: 4, enabled: null, startMin: null, endMin: 420, idleSec: null,
    });
    const hub = new OsLinkHub(() => Date.now(), store);
    hub.restoreSleepRequest(await store.load());
    expect(sleepLines(hub)).toEqual(["sleepseq\t4", "sleeptill\t420"]);
  });

  test("two saves in flight land in the order they were asked for", async () => {
    const path = await storePath();
    const store = new OsSleepRequestStore(path);
    // Both are queued before either write starts. Unchained they would race
    // their renames — each has its own tmp name, so both succeed — and the loser
    // would leave the LOWER sequence on disk, which is this file's whole bug.
    store.save({ seq: 1, enabled: true, startMin: null, endMin: null, idleSec: null });
    store.save({ seq: 2, enabled: true, startMin: null, endMin: null, idleSec: 600 });
    await store.settled();
    expect(await Bun.file(path).json()).toMatchObject({ seq: 2, idleSec: 600 });
  });

  test("a save that would change nothing does not touch the file", async () => {
    const path = await storePath();
    const store = new OsSleepRequestStore(path);
    const request = { seq: 3, enabled: true, startMin: 1380, endMin: 420, idleSec: 600 };
    store.save(request);
    await store.settled();
    // A sentinel only a real write would destroy.
    await Bun.write(path, JSON.stringify({ version: 1, ...request, sentinel: true }));
    store.save({ ...request });
    await store.settled();
    expect(await Bun.file(path).json()).toMatchObject({ sentinel: true });
  });

  test("a failing write is warned and retried by the next request", async () => {
    const path = await storePath();
    const warnings: string[] = [];
    // A directory where the file should be: every write fails, forever.
    await Bun.write(join(path, "occupied"), "x");
    const store = new OsSleepRequestStore(path, (event) => warnings.push(event));
    const hub = new OsLinkHub(() => Date.now(), store);
    hub.setSleep({ enabled: true });
    await store.settled();
    expect(warnings).toEqual(["os_sleep_request_write_failed"]);
    // The request itself must not fail: a bedtime cannot be allowed to take down
    // a route, and the device still gets the document from memory.
    expect(sleepLines(hub)).toEqual(["sleepseq\t1", "sleepon\t1"]);
    // lastSaved was cleared, so the next change tries again instead of being
    // skipped as already-saved.
    hub.setSleep({ idleSec: 600 });
    await store.settled();
    expect(warnings).toEqual([
      "os_sleep_request_write_failed",
      "os_sleep_request_write_failed",
    ]);
  });

  test("a restore never walks the counter backwards", async () => {
    const path = await storePath();
    const store = new OsSleepRequestStore(path);
    const hub = new OsLinkHub(() => Date.now(), store);
    hub.setSleep({ enabled: true });
    hub.setSleep({ idleSec: 600 });
    // A restore that somehow ran late would otherwise hand the device a sequence
    // it has already refused, which is the failure this whole file is about.
    hub.restoreSleepRequest({ seq: 1, enabled: false, startMin: null, endMin: null, idleSec: null });
    expect(hub.getSleep().seq).toBe(2);
  });
});
