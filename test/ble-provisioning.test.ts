import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import {
  BLE_CHUNK_BYTES,
  BLE_MAX_MESSAGE_BYTES,
  CODE_ATTEMPT_LIMIT,
  LAN_RECOVERY_POLL_MS,
  LAN_RECOVERY_WINDOW_MS,
  ZOS_BLE_ADV_BYTES,
  ZOS_BLE_RX_UUID,
  ZOS_BLE_SERVICE_UUID,
  ZOS_BLE_TX_UUID,
  bleAbortCommand,
  bleCodeCommand,
  bleHelloCommand,
  bleHostIsSafe,
  bleJoinCommand,
  consoleHostForJoin,
  bleScanCommand,
  createBleReassembler,
  createProvisionSession,
  describeBleConnectFailure,
  describeBleSupport,
  describeProgress,
  describeProvisionFailure,
  encodeBleMessage,
  parseBleDoc,
  parseBleEvent,
  signalBars,
  type BleTransport,
  type BleTransportHandlers,
  type ProvisionSession,
  type ProvisionState,
} from "../web/src/lib/ble-provisioning.ts";
import { ZosProvisionBody } from "../web/src/components/zos/zos-provision-dialog";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// --- Test doubles -----------------------------------------------------------

interface FakeClock {
  now(): number;
  advance(ms: number): void;
  pending(): number;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(handle: number): void;
}

/** Deterministic timers: every wait in this module is injected, so none is real. */
function fakeClock(start = 1_000_000): FakeClock {
  let time = start;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    pending: () => timers.size,
    setTimer(callback, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: time + ms, callback });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      const target = time + ms;
      // Fire in due order, letting a callback schedule further work.
      for (;;) {
        let dueHandle: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [handle, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueHandle = handle;
          }
        }
        if (dueHandle === null) break;
        const timer = timers.get(dueHandle)!;
        timers.delete(dueHandle);
        time = timer.at;
        timer.callback();
      }
      time = target;
    },
  };
}

interface FakeTransport extends BleTransport {
  /** Everything the console wrote, reassembled back into message bodies. */
  sent: string[];
  /** Push one device→console message through the framer. */
  emit(body: string): void;
  /** Push one raw chunk, so a malformed notification can be exercised. */
  emitRaw(chunk: Uint8Array): void;
  drop(): void;
  connectError: { name: string; message: string } | null;
  connected: boolean;
}

function fakeTransport(): FakeTransport {
  let handlers: BleTransportHandlers | null = null;
  const reassembler = createBleReassembler();
  const transport: FakeTransport = {
    sent: [],
    connectError: null,
    connected: false,
    async connect(next) {
      if (transport.connectError !== null) {
        const error = new Error(transport.connectError.message);
        error.name = transport.connectError.name;
        throw error;
      }
      handlers = next;
      transport.connected = true;
      next.onStage("chooser");
      next.onStage("connecting");
      next.onStage("service");
      next.onStage("subscribing");
      next.onStage("ready");
    },
    async write(chunk) {
      if (!transport.connected) throw new Error("not connected");
      expect(chunk.length).toBeLessThanOrEqual(BLE_CHUNK_BYTES);
      const result = reassembler.push(chunk);
      if (result.message !== undefined) transport.sent.push(result.message);
    },
    disconnect() {
      transport.connected = false;
    },
    emit(body) {
      for (const chunk of encodeBleMessage(body)) handlers?.onChunk(chunk);
    },
    emitRaw(chunk) {
      handlers?.onChunk(chunk);
    },
    drop() {
      transport.connected = false;
      handlers?.onDisconnect();
    },
  };
  return transport;
}

interface Harness {
  session: ProvisionSession;
  transport: FakeTransport;
  clock: FakeClock;
  state(): ProvisionState;
  osState: { live: boolean; ip: string | null; ssid: string | null; reportSeq: number };
  osReads: number;
}

function harness(): Harness {
  const clock = fakeClock();
  const transport = fakeTransport();
  const context: Harness = {
    clock,
    transport,
    osState: { live: false, ip: null, ssid: null, reportSeq: 0 },
    osReads: 0,
    state: () => context.session.getState(),
    session: null as unknown as ProvisionSession,
  };
  context.session = createProvisionSession({
    transport,
    readOsState: async () => {
      context.osReads += 1;
      return context.osState;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return context;
}

/** Walk the flow to the network list, which is where most cases start. */
async function connectedAndAuthorised(): Promise<Harness> {
  const context = harness();
  await context.session.start();
  context.transport.emit("evt\thello\nname\tZOS-A772\nbuild\tzos-2026-08\nmac\tCC:C4:B2:77:A7:72\n");
  context.transport.emit("evt\tstate\nphase\tidle\n");
  await context.session.submitCode("418327");
  context.transport.emit("evt\tstate\nphase\tscanning\n");
  await Promise.resolve();
  return context;
}

// --- Framing ----------------------------------------------------------------

describe("BLE framing", () => {
  test("a short message is one chunk carrying both FIRST and LAST", () => {
    const chunks = encodeBleMessage("cmd\tscan\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]![0]! & 0x80).toBe(0x80);
    expect(chunks[0]![0]! & 0x40).toBe(0x40);
    expect(chunks[0]![0]! & 0x3f).toBe(0);
    expect(decoder.decode(chunks[0]!.subarray(1))).toBe("cmd\tscan\n");
  });

  test("every chunk fits 20 bytes and only the last one is short", () => {
    // 20 bytes is the payload of the default 23-byte ATT MTU, and Web Bluetooth
    // never reveals a negotiated MTU — so this is the only size both sides know.
    const chunks = encodeBleMessage("cmd\tjoin\nssid\t" + "x".repeat(64) + "\npsk\t" + "y".repeat(40) + "\n");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.length).toBe(BLE_CHUNK_BYTES);
    expect(chunks.at(-1)!.length).toBeLessThanOrEqual(BLE_CHUNK_BYTES);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk[0]! & 0x3f).toBe(index % 64);
      expect((chunk[0]! & 0x80) !== 0).toBe(index === 0);
      expect((chunk[0]! & 0x40) !== 0).toBe(index === chunks.length - 1);
    }
  });

  test("round-trips a multi-chunk message including multi-byte UTF-8", () => {
    const body = "evt\tnet\ni\t0\nn\t3\nssid\t家里的网络 5G 也在这台路由器上\nrssi\t-41\nsec\twpa2\ncached\t0\n";
    const reassembler = createBleReassembler();
    let out: string | undefined;
    for (const chunk of encodeBleMessage(body)) {
      const result = reassembler.push(chunk);
      if (result.message !== undefined) out = result.message;
    }
    expect(out).toBe(body);
  });

  test("a continuation without a FIRST, or a seq gap, drops the buffer", () => {
    const reassembler = createBleReassembler();
    expect(reassembler.push(new Uint8Array([0x01, 0x41])).error).toBe("orphan");

    const chunks = encodeBleMessage("x".repeat(50));
    expect(reassembler.push(chunks[0]!).error).toBeUndefined();
    // Skip chunk 1 — the device must never see a message stitched across a hole.
    expect(reassembler.push(chunks[2]!).error).toBe("sequence");
    expect(reassembler.push(chunks[1]!).error).toBe("orphan");
  });

  test("the 512-byte cap is enforced on both encode and reassembly", () => {
    expect(() => encodeBleMessage("z".repeat(BLE_MAX_MESSAGE_BYTES + 1))).toThrow();
    const reassembler = createBleReassembler();
    // Hand-built oversize stream: FIRST plus continuations that never end.
    let header = 0x80;
    let error: string | undefined;
    for (let index = 0; index < 40; index += 1) {
      const chunk = new Uint8Array(20);
      chunk[0] = header;
      chunk.set(encoder.encode("0123456789012345678"), 1);
      const result = reassembler.push(chunk);
      if (result.error !== undefined) {
        error = result.error;
        break;
      }
      header = (index + 1) % 64;
    }
    expect(error).toBe("overflow");
  });

  test("the advertising payload is exactly the 31-byte legacy budget", () => {
    // 3 + 18 + 10: the 8-character ZOS-xxxx name is what makes it land exactly,
    // and it leaves no room for a scan response the device would have to answer.
    const { flags, serviceUuid, localName, total } = ZOS_BLE_ADV_BYTES;
    expect(flags + serviceUuid + localName).toBe(total);
    expect(total).toBe(31);
  });

  test("the two characteristics share the service's 128-bit base", () => {
    expect(ZOS_BLE_SERVICE_UUID).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(ZOS_BLE_RX_UUID.slice(8)).toBe(ZOS_BLE_SERVICE_UUID.slice(8));
    expect(ZOS_BLE_TX_UUID.slice(8)).toBe(ZOS_BLE_SERVICE_UUID.slice(8));
    expect(new Set([ZOS_BLE_SERVICE_UUID, ZOS_BLE_RX_UUID, ZOS_BLE_TX_UUID]).size).toBe(3);
  });
});

// --- Documents --------------------------------------------------------------

describe("BLE document codec", () => {
  test("commands are KEY\\tVALUE lines, cmd first", () => {
    expect(bleHelloCommand()).toBe("cmd\thello\n");
    expect(bleScanCommand()).toBe("cmd\tscan\n");
    expect(bleAbortCommand()).toBe("cmd\tabort\n");
    expect(bleCodeCommand("418327")).toBe("cmd\tcode\ncode\t418327\n");
    expect(bleJoinCommand("home-2g", "hunter2")).toBe("cmd\tjoin\nssid\thome-2g\npsk\thunter2\n");
  });

  test("the console address rides the join, and only when it is worth sending", () => {
    // The device OVERWRITES /data/zos-host with whatever it is told, so null —
    // "say nothing, keep the address you have" — is the safe answer, and every
    // rule below exists to pick it rather than a confidently wrong address.
    const at = (over: Partial<Parameters<typeof consoleHostForJoin>[0]> = {}) =>
      consoleHostForJoin({
        pageProtocol: "http:",
        pageHost: "192.168.8.108:43820",
        serviceAddress: "192.168.8.108",
        servicePort: 43820,
        ...over,
      });

    // The address the browser reached this page at is ground truth: it proved
    // it routes. It wins over the service's own guess.
    expect(at({ serviceAddress: "10.0.0.9" })).toBe("192.168.8.108:43820");
    // Provisioning is normally done ON the machine running the service — Web
    // Bluetooth is a desktop browser feature — where the page address says
    // 127.0.0.1 and means nothing to the clock. That is the case the service
    // address exists for, and it is the common one.
    expect(at({ pageHost: "127.0.0.1:43820" })).toBe("192.168.8.108:43820");
    expect(at({ pageHost: "localhost:43820" })).toBe("192.168.8.108:43820");
    // A default-port page carries no port; the firmware would fill in 43820 and
    // be wrong, so the scheme default is made explicit instead.
    expect(at({ pageHost: "studio.local" })).toBe("studio.local:80");
    // https is refused outright: the firmware only builds http:// URLs, so
    // adopting a TLS address swaps a working link for a dead one.
    expect(at({ pageProtocol: "https:" })).toBeNull();
    // Nothing usable anywhere: stay quiet.
    expect(at({ pageHost: "127.0.0.1:43820", serviceAddress: null })).toBeNull();
    expect(at({ pageHost: "127.0.0.1:43820", serviceAddress: "127.0.0.1" })).toBeNull();

    // The field is omitted, not sent empty — an absent field is what leaves the
    // device on the address it already knows.
    expect(bleJoinCommand("home-2g", "hunter2", null))
      .toBe("cmd\tjoin\nssid\thome-2g\npsk\thunter2\n");
    expect(bleJoinCommand("home-2g", "hunter2", "192.168.8.108:43820"))
      .toBe("cmd\tjoin\nssid\thome-2g\npsk\thunter2\nhost\t192.168.8.108:43820\n");
  });

  test("bleHostIsSafe mirrors the firmware, so we never send what it would ignore", () => {
    // Same axes as ble::hostIsSafe in BleProtocol.cpp — this pair is the reason
    // an invalid host is a console bug caught here rather than a silent no-op
    // on the device.
    for (const ok of ["192.168.8.108", "192.168.8.108:43820", "studio.local", "a".repeat(64)]) {
      expect([ok, bleHostIsSafe(ok)]).toEqual([ok, true]);
    }
    for (const bad of [
      "", "a".repeat(65), "http://192.168.8.108", "192.168.8.108/pull",
      "host:port", "host:0", "host:65536", "host:", "a:1:2", "a..b", ".a", "-a", "a-", "a b",
    ]) {
      expect([bad, bleHostIsSafe(bad)]).toEqual([bad, false]);
    }
  });

  test("the codec refuses a separator byte rather than rewriting the value around it", () => {
    // It used to substitute spaces and then trim. Both are the same mistake in
    // different clothes: the encoder sits between the validator and the radio,
    // so anything it rewrites makes `pskError`'s answer about a string the
    // device will never see. `"  pass1234  "` validated at 12 bytes and went out
    // as 8 — accepted by the device, handed to wpa_supplicant as the WRONG
    // passphrase, and reported back forever as 密码错误 for a password the user
    // typed correctly.
    expect(() => bleJoinCommand("we\tird", "pass1234")).toThrow();
    expect(() => bleJoinCommand("home-2g", "pa\nss1234")).toThrow();

    // Leading and trailing spaces are legal in both an 802.11 SSID and a WPA
    // passphrase, and they survive to the wire byte for byte.
    expect(bleJoinCommand("home 2g ", "  pass1234  "))
      .toBe("cmd\tjoin\nssid\thome 2g \npsk\t  pass1234  \n");
    expect(parseBleDoc(bleJoinCommand("home 2g ", "  pass1234  ")).psk).toBe("  pass1234  ");
  });

  test("state events parse phase, err and retry; an unknown phase never advances", () => {
    const event = parseBleEvent("evt\tstate\nphase\tjoining\nssid\thome\nip\t\n");
    expect(event).toEqual({ kind: "state", phase: "joining", ssid: "home", ip: "", err: null, retrySec: null });

    const locked = parseBleEvent("evt\tstate\nphase\tfailed\nerr\tlocked-out\nretry\t42\n");
    expect(locked).toMatchObject({ phase: "failed", err: "locked-out", retrySec: 42 });

    // A word this side does not know must read as "no progress", not as progress.
    expect(parseBleEvent("evt\tstate\nphase\tturbo\n")).toMatchObject({ phase: "idle" });
    expect(parseBleEvent("evt\tstate\nphase\tidle\nerr\tsomething-new\n")).toMatchObject({ err: null });
  });

  test("net events carry their own index and total", () => {
    expect(parseBleEvent("evt\tnet\ni\t2\nn\t7\nssid\tcafe\nrssi\t-72\nsec\topen\ncached\t1\n")).toEqual({
      kind: "net", index: 2, total: 7, ssid: "cafe", rssi: -72, sec: "open", cached: true,
    });
  });

  test("a body that is not an event at all parses to null", () => {
    expect(parseBleEvent("cmd\tscan\n")).toBeNull();
    expect(parseBleEvent("")).toBeNull();
    expect(parseBleEvent("evt\tfuture\nx\t1\n")).toEqual({ kind: "unknown", evt: "future" });
  });
});

// --- Browser gate -----------------------------------------------------------

describe("browser support gate", () => {
  test("a LAN origin is reported as the insecure context it is, not as a missing API", () => {
    // Chrome hides navigator.bluetooth on an insecure origin too, so checking the
    // API first would tell a Chrome-on-192.168.x user to install Chrome.
    const support = describeBleSupport({ secureContext: false, hasBluetooth: false, adapterAvailable: null });
    expect(support.code).toBe("insecure-context");
    expect(support.ok).toBe(false);
    expect(support.detail).toContain("127.0.0.1");
  });

  test("Safari and Firefox are named, and the portal is offered", () => {
    const support = describeBleSupport({ secureContext: true, hasBluetooth: false, adapterAvailable: null });
    expect(support.code).toBe("no-api");
    expect(support.detail).toContain("Safari");
    expect(support.detail).toContain("Chrome");
    expect(support.offerPortal).toBe(true);
  });

  test("an adapter that answered false is its own message; unknown is not a refusal", () => {
    expect(describeBleSupport({ secureContext: true, hasBluetooth: true, adapterAvailable: false }).code)
      .toBe("no-adapter");
    // getAvailability is missing on some builds; unknown must not block the flow.
    expect(describeBleSupport({ secureContext: true, hasBluetooth: true, adapterAvailable: null }).ok).toBe(true);
    expect(describeBleSupport({ secureContext: true, hasBluetooth: true, adapterAvailable: true }).ok).toBe(true);
  });

  test("an empty chooser and a cancelled chooser share one DOMException, so the copy says both", () => {
    const failure = describeBleConnectFailure("NotFoundError", "User cancelled");
    expect(failure.detail).toContain("取消");
    // The macOS system Bluetooth grant is the most common dead end and looks
    // exactly like "the clock is not advertising".
    expect(failure.detail).toContain("隐私与安全性");
  });
});

// --- Failure copy -----------------------------------------------------------

describe("failure copy", () => {
  test("密码错误 and 找不到这个网络 are different problems with different next steps", () => {
    const badPsk = describeProvisionFailure("bad-psk", { ssid: "home-2g" });
    const noAp = describeProvisionFailure("no-ap", { ssid: "home-2g" });
    expect(badPsk.title).toBe("密码错误");
    expect(noAp.title).toBe("找不到这个网络");
    expect(badPsk.title).not.toBe(noAp.title);
    expect(badPsk.detail).not.toBe(noAp.detail);
    expect(badPsk.retryTo).toBe("password");
    expect(noAp.retryTo).toBe("networks");
    // 5G is the single most common reason a network is missing from a 2.4G scan.
    expect(noAp.detail).toContain("5G");
  });

  test("associated-without-a-lease is neither of those two", () => {
    const dhcp = describeProvisionFailure("dhcp", { ssid: "home-2g" });
    expect(dhcp.title).not.toBe("密码错误");
    expect(dhcp.detail).toContain("IP");
  });

  test("the guard file is explained as an install state, and has no retry", () => {
    const locked = describeProvisionFailure("link-locked");
    expect(locked.detail).toContain("/tmp/zos-allow-link");
    expect(locked.retryTo).toBeNull();
  });

  test("a BLE drop with no LAN recovery states the ambiguity instead of guessing", () => {
    const dropped = describeProvisionFailure("dropped", { ssid: "home-2g" });
    expect(dropped.detail).toContain("也可能密码不对");
    expect(dropped.detail).toContain("问不出来");
  });
});

// --- Progress ---------------------------------------------------------------

describe("join progress", () => {
  test("steps advance only on the device's own phase", () => {
    expect(describeProgress("idle").map((step) => step.state)).toEqual(["active", "pending", "pending", "pending"]);
    expect(describeProgress("joining").map((step) => step.state)).toEqual(["done", "active", "pending", "pending"]);
    expect(describeProgress("addressing").map((step) => step.state)).toEqual(["done", "done", "active", "pending"]);
    expect(describeProgress("online").map((step) => step.state)).toEqual(["done", "done", "done", "active"]);
  });

  test("a device that never sends `addressing` simply holds at 正在关联", () => {
    // joining covers association AND the DHCP request on the firmware side, so
    // holding is honest; inventing a third step on a timer would not be.
    const steps = describeProgress("joining");
    expect(steps[1]!.label).toBe("正在关联");
    expect(steps[1]!.state).toBe("active");
  });

  test("signal bars are monotonic in RSSI", () => {
    expect(signalBars(-40)).toBe(4);
    expect(signalBars(-60)).toBe(3);
    expect(signalBars(-72)).toBe(2);
    expect(signalBars(-90)).toBe(1);
  });
});

// --- Session ----------------------------------------------------------------

describe("provision session", () => {
  test("subscribing is followed by hello, and the device's state opens the code screen", async () => {
    const context = harness();
    await context.session.start();
    expect(context.transport.sent).toEqual(["cmd\thello\n"]);
    expect(context.state().step).toBe("connecting");

    context.transport.emit("evt\thello\nname\tZOS-A772\nbuild\tzos-2026-08\nmac\tCC:C4:B2:77:A7:72\n");
    context.transport.emit("evt\tstate\nphase\tidle\n");
    expect(context.state().step).toBe("code");
    expect(context.state().device).toEqual({
      name: "ZOS-A772", build: "zos-2026-08", mac: "CC:C4:B2:77:A7:72",
    });
  });

  test("a locked link is reported before a password is ever asked for", async () => {
    // The device's guard refusal used to surface only after a submit; with a
    // panel that can say 未解锁 up front, the console says it up front too.
    const context = harness();
    await context.session.start();
    context.transport.emit("evt\tstate\nphase\tlocked\n");
    expect(context.state().step).toBe("failed");
    expect(context.state().linkLocked).toBe(true);
    expect(context.state().failure?.code).toBe("link-locked");
    expect(context.state().failure?.retryTo).toBeNull();
  });

  test("no reply at all after subscribing fails rather than spinning forever", async () => {
    const context = harness();
    await context.session.start();
    context.clock.advance(9_000);
    expect(context.state().step).toBe("failed");
    expect(context.state().failure?.code).toBe("no-reply");
  });

  test("a wrong code keeps the field and counts attempts; a lockout carries its countdown", async () => {
    const context = harness();
    await context.session.start();
    context.transport.emit("evt\tstate\nphase\tidle\n");

    await context.session.submitCode("000000");
    expect(context.transport.sent).toContain("cmd\tcode\ncode\t000000\n");
    context.transport.emit("evt\tstate\nphase\tidle\nerr\tno-code\n");
    expect(context.state().step).toBe("code");
    expect(context.state().codeAttempts).toBe(1);
    expect(context.state().codeError).toContain("数字不对");

    await context.session.submitCode("000001");
    context.transport.emit("evt\tstate\nphase\tidle\nerr\tlocked-out\nretry\t60\n");
    expect(context.state().lockedOutUntilMs).toBe(context.clock.now() + 60_000);
    // While locked out the console must not let the user keep hammering.
    const before = context.transport.sent.length;
    await context.session.submitCode("000002");
    expect(context.transport.sent.length).toBe(before);
    expect(CODE_ATTEMPT_LIMIT).toBe(5);
  });

  test("a good code moves to the list and asks the device to scan", async () => {
    const context = await connectedAndAuthorised();
    expect(context.state().step).toBe("networks");
    expect(context.transport.sent).toContain("cmd\tscan\n");
    expect(context.state().scanning).toBe(true);
  });

  test("the list fills against the device's own total and the cache is labelled", async () => {
    const context = await connectedAndAuthorised();
    context.transport.emit("evt\tnet\ni\t0\nn\t2\nssid\thome-2g\nrssi\t-41\nsec\twpa2\ncached\t1\n");
    expect(context.state().networkTotal).toBe(2);
    expect(context.state().scanning).toBe(true);
    expect(context.state().scanCached).toBe(true);

    context.transport.emit("evt\tnet\ni\t1\nn\t2\nssid\tcafe\nrssi\t-80\nsec\topen\ncached\t1\n");
    expect(context.state().scanning).toBe(false);
    expect(context.state().networks.map((network) => network.ssid)).toEqual(["home-2g", "cafe"]);
    expect(context.state().networks[1]!.secured).toBe(false);
  });

  test("an empty sweep ends instead of spinning, and manual entry still works", async () => {
    const context = await connectedAndAuthorised();
    context.transport.emit("evt\tnet\ni\t-1\nn\t0\n");
    expect(context.state().scanning).toBe(false);
    expect(context.state().networks).toHaveLength(0);

    context.session.useManualSsid("hidden-2g");
    expect(context.state().step).toBe("password");
    expect(context.state().ssid).toBe("hidden-2g");
    expect(context.state().manualSsid).toBe(true);
    // A hidden SSID is always assumed secured — the scan never saw its flags.
    expect(context.state().secured).toBe(true);
  });

  test("an open network is remembered as open so the password screen can say so", async () => {
    const context = await connectedAndAuthorised();
    context.transport.emit("evt\tnet\ni\t0\nn\t1\nssid\tcafe\nrssi\t-60\nsec\topen\ncached\t0\n");
    context.session.chooseNetwork("cafe");
    expect(context.state().secured).toBe(false);

    await context.session.submitPassword("");
    expect(context.transport.sent).toContain("cmd\tjoin\nssid\tcafe\npsk\t\n");
  });

  test("a join that succeeds over a live BLE link reports the address it was given", async () => {
    const context = await connectedAndAuthorised();
    context.transport.emit("evt\tnet\ni\t0\nn\t1\nssid\thome-2g\nrssi\t-41\nsec\twpa2\ncached\t0\n");
    context.session.chooseNetwork("home-2g");
    await context.session.submitPassword("hunter22");
    expect(context.transport.sent).toContain("cmd\tjoin\nssid\thome-2g\npsk\thunter22\n");

    context.transport.emit("evt\tstate\nphase\tjoining\nssid\thome-2g\n");
    expect(context.state().phase).toBe("joining");
    context.transport.emit("evt\tstate\nphase\tonline\nssid\thome-2g\nip\t192.168.8.42\n");
    expect(context.state().step).toBe("done");
    expect(context.state().ip).toBe("192.168.8.42");
    // Holding the GATT link open after the point of it is just radio time.
    expect(context.transport.connected).toBe(false);
  });

  test("a BLE drop during the join is ambiguous, and the LAN settles it", async () => {
    // One aic8800 carries both radios, so the link dying at exactly this moment
    // is the expected shape of SUCCESS. Reporting failure here would report
    // failure on every successful join.
    const context = await connectedAndAuthorised();
    context.session.chooseNetwork("home-2g");
    await context.session.submitPassword("hunter22");
    context.transport.emit("evt\tstate\nphase\tjoining\nssid\thome-2g\n");

    context.transport.drop();
    expect(context.state().step).toBe("joining");
    expect(context.state().bleDropped).toBe(true);
    expect(context.state().waitingForLan).toBe(true);
    expect(context.state().failure).toBeNull();

    context.osState = { live: true, ip: "192.168.8.42", ssid: "home-2g", reportSeq: 1 };
    context.clock.advance(LAN_RECOVERY_POLL_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(context.osReads).toBeGreaterThan(0);
    expect(context.state().step).toBe("done");
    expect(context.state().ip).toBe("192.168.8.42");
  });

  test("a drop with no LAN recovery inside the window fails, and says why it cannot tell", async () => {
    const context = await connectedAndAuthorised();
    context.session.chooseNetwork("home-2g");
    await context.session.submitPassword("hunter22");
    context.transport.drop();

    for (let elapsed = 0; elapsed <= LAN_RECOVERY_WINDOW_MS + LAN_RECOVERY_POLL_MS; elapsed += LAN_RECOVERY_POLL_MS) {
      context.clock.advance(LAN_RECOVERY_POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(context.state().step).toBe("failed");
    expect(context.state().failure?.code).toBe("dropped");
  });

  test("a device-reported failure keeps its own cause all the way to the screen", async () => {
    const context = await connectedAndAuthorised();
    context.session.chooseNetwork("home-2g");
    await context.session.submitPassword("wrongpass");
    context.transport.emit("evt\tstate\nphase\tfailed\nssid\thome-2g\nerr\tbad-psk\n");
    expect(context.state().step).toBe("failed");
    expect(context.state().failure?.code).toBe("bad-psk");
    expect(context.state().failure?.title).toBe("密码错误");
    expect(context.state().failure?.retryTo).toBe("password");

    await context.session.retry();
    expect(context.state().step).toBe("password");
    expect(context.state().ssid).toBe("home-2g");
  });

  test("no-ap sends the user back to a fresh scan, not back to the password", async () => {
    const context = await connectedAndAuthorised();
    context.session.chooseNetwork("home-5g-only");
    await context.session.submitPassword("hunter22");
    context.transport.emit("evt\tstate\nphase\tfailed\nssid\thome-5g-only\nerr\tno-ap\n");
    expect(context.state().failure?.retryTo).toBe("networks");

    const before = context.transport.sent.length;
    await context.session.retry();
    expect(context.state().step).toBe("networks");
    expect(context.transport.sent.slice(before)).toContain("cmd\tscan\n");
  });

  test("a stale live report is not a witness: re-provisioning an online clock", async () => {
    // The primary use case, not an edge case. bleWanted() keeps the radio up
    // for five minutes when a user asks for it from 设置 → 蓝牙, so "move my
    // working clock to a new network" ALWAYS starts from a clock that is online
    // and reporting. `live` is then true from the first poll — at the old
    // network's address — and the console used to call that success.
    const context = await connectedAndAuthorised();
    context.osState = { live: true, ip: "192.168.1.50", ssid: "old-2g", reportSeq: 7 };
    context.session.chooseNetwork("new-2g");
    await context.session.submitPassword("wrongpass");
    context.transport.emit("evt\tstate\nphase\tjoining\nssid\tnew-2g\n");
    context.transport.drop();
    expect(context.state().waitingForLan).toBe(true);

    // Poll after poll of a device that never left the old network.
    for (
      let elapsed = LAN_RECOVERY_POLL_MS;
      elapsed < LAN_RECOVERY_WINDOW_MS;
      elapsed += LAN_RECOVERY_POLL_MS
    ) {
      context.clock.advance(LAN_RECOVERY_POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(context.state().step).toBe("joining");
    }
    context.clock.advance(LAN_RECOVERY_POLL_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(context.state().step).toBe("failed");
    expect(context.state().failure?.code).toBe("dropped");
    expect(context.state().ip).toBeNull();
  });

  test("a report that is both newer and on the right network completes the join", async () => {
    const context = await connectedAndAuthorised();
    context.osState = { live: true, ip: "192.168.1.50", ssid: "old-2g", reportSeq: 7 };
    context.session.chooseNetwork("new-2g");
    await context.session.submitPassword("goodpass");
    context.transport.drop();

    // A heartbeat from the new network, after the join was submitted.
    context.osState = { live: true, ip: "192.168.9.31", ssid: "new-2g", reportSeq: 8 };
    context.clock.advance(LAN_RECOVERY_POLL_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(context.state().step).toBe("done");
    expect(context.state().ip).toBe("192.168.9.31");
  });

  test("a password the device would reject never reaches the radio", async () => {
    const context = await connectedAndAuthorised();
    context.session.chooseNetwork("home-2g");
    const before = context.transport.sent.length;
    await context.session.submitPassword("short");
    expect(context.transport.sent.slice(before)).toHaveLength(0);
    expect(context.state().step).toBe("password");
    expect(context.state().credentialError).toBe("Wi-Fi 密码至少 8 位");

    await context.session.submitPassword("longenough");
    expect(context.state().credentialError).toBeNull();
    expect(context.transport.sent).toContain("cmd\tjoin\nssid\thome-2g\npsk\tlongenough\n");
  });

  test("a manual SSID the device would reject never becomes the target", async () => {
    const context = await connectedAndAuthorised();
    context.session.useManualSsid('quo"te');
    expect(context.state().step).toBe("networks");
    expect(context.state().ssid).toBe("");
    expect(context.state().credentialError).toBe("网络名称不能包含引号或反斜杠");

    context.session.useManualSsid("hidden-2g");
    expect(context.state().step).toBe("password");
    expect(context.state().credentialError).toBeNull();
  });

  test("`arg` answering a join is a credential to fix, not a firmware to upgrade", async () => {
    // Its only reachable cause on the device is ssidIsSafe/pskIsSafe rejecting
    // the join it answers. Treating it as a version mismatch cost the user the
    // GATT link AND the six-digit code, which the device re-mints on every new
    // advertising session.
    const context = await connectedAndAuthorised();
    context.session.chooseNetwork("home-2g");
    await context.session.submitPassword("longenough");
    context.transport.emit("evt\terr\ncode\targ\n");
    expect(context.state().step).toBe("failed");
    expect(context.state().failure?.code).toBe("bad-field");
    expect(context.state().failure?.retryTo).toBe("password");

    await context.session.retry();
    expect(context.state().step).toBe("password");
    expect(context.transport.connected).toBe(true);
  });

  test("`doc` fails fast; `frame` stays silent because the next FIRST resynchronises", async () => {
    // The device separates them: `doc` is a document its parser refused, which
    // is permanent, and `frame` is a lost chunk, which is not. Reading `doc` as
    // recoverable left the reply timer to expire and reported 时钟没有应答 —
    // false about a device that answered at once and said no.
    const silent = await connectedAndAuthorised();
    silent.transport.emit("evt\terr\ncode\tframe\n");
    expect(silent.state().step).toBe("networks");
    expect(silent.state().failure).toBeNull();

    const loud = await connectedAndAuthorised();
    loud.transport.emit("evt\terr\ncode\tdoc\n");
    expect(loud.state().step).toBe("failed");
    expect(loud.state().failure?.code).toBe("protocol");
  });

  test("a chooser cancellation is a failure the user can act on, not a dead dialog", async () => {
    const context = harness();
    context.transport.connectError = { name: "NotFoundError", message: "User cancelled the requestDevice() chooser." };
    await context.session.start();
    expect(context.state().step).toBe("failed");
    expect(context.state().failure?.title).toBe("没有选中时钟");
    expect(context.state().failure?.retryTo).toBe("discover");
  });

  test("closing aborts on the device and leaves nothing running", async () => {
    const context = await connectedAndAuthorised();
    context.session.close();
    expect(context.transport.sent).toContain("cmd\tabort\n");
    expect(context.transport.connected).toBe(false);
    expect(context.state().step).toBe("ready");
    expect(context.clock.pending()).toBe(0);
  });

  test("a corrupt notification is dropped, never rendered as data", async () => {
    const context = await connectedAndAuthorised();
    context.transport.emit("evt\tnet\ni\t0\nn\t2\nssid\treal\nrssi\t-41\nsec\twpa2\ncached\t0\n");
    expect(context.state().networks).toHaveLength(1);

    // A continuation chunk with no FIRST — the tail of a message whose head was
    // lost. Rendering it would paint a real-looking network with a mangled SSID.
    context.transport.emitRaw(new Uint8Array([0x47, 0x41, 0x42]));
    expect(context.state().networks).toHaveLength(1);
    expect(context.state().step).toBe("networks");

    // And the very next well-formed message still lands: FIRST resynchronises.
    context.transport.emit("evt\tnet\ni\t1\nn\t2\nssid\tsecond\nrssi\t-70\nsec\topen\ncached\t0\n");
    expect(context.state().networks.map((network) => network.ssid)).toEqual(["real", "second"]);
  });
});

// --- Rendering --------------------------------------------------------------

function body(overrides: Partial<Parameters<typeof ZosProvisionBody>[0]>): string {
  const base: Parameters<typeof ZosProvisionBody>[0] = {
    support: describeBleSupport({ secureContext: true, hasBluetooth: true, adapterAvailable: true }),
    state: createProvisionSession({
      transport: fakeTransport(),
      readOsState: async () => ({ live: false, ip: null, ssid: null, reportSeq: 0 }),
    }).getState(),
    code: "",
    psk: "",
    revealPsk: false,
    manualDraft: "",
    lockoutSeconds: 0,
    onCodeChange: () => {},
    onPskChange: () => {},
    onRevealChange: () => {},
    onManualDraftChange: () => {},
    onStart: () => {},
    onSubmitCode: () => {},
    onRescan: () => {},
    onPickNetwork: () => {},
    onUseManual: () => {},
    onSubmitPassword: () => {},
    onBackToNetworks: () => {},
    onRetry: () => {},
  };
  return renderToStaticMarkup(createElement(
    CladdProvider,
    null,
    createElement(ZosProvisionBody, { ...base, ...overrides }),
  ));
}

function stateWith(overrides: Partial<ProvisionState>): ProvisionState {
  const base = createProvisionSession({
    transport: fakeTransport(),
    readOsState: async () => ({ live: false, ip: null, ssid: null, reportSeq: 0 }),
  }).getState();
  return { ...base, ...overrides };
}

describe("provision dialog body", () => {
  test("an unsupported browser gets the explanation and the fallback, never a button", () => {
    const markup = body({
      support: describeBleSupport({ secureContext: true, hasBluetooth: false, adapterAvailable: null }),
    });
    expect(markup).toContain("当前浏览器不支持网页蓝牙");
    expect(markup).toContain("8080");
    expect(markup).not.toContain("选择时钟");
  });

  test("the network list states the 2.4G-only limit before anyone can pick wrong", () => {
    const markup = body({
      state: stateWith({
        step: "networks",
        scanning: false,
        networkTotal: 1,
        networks: [{ ssid: "home-2g", rssi: -41, sec: "wpa2", secured: true, cached: false }],
      }),
    });
    expect(markup).toContain("2.4G");
    expect(markup).toContain("home-2g");
    expect(markup).toContain("找不到？直接输入网络名称");
  });

  test("the ambiguous BLE drop is explained on the progress screen, not shown as failure", () => {
    const markup = body({
      state: stateWith({ step: "joining", phase: "joining", bleDropped: true, waitingForLan: true }),
    });
    expect(markup).toContain("蓝牙断开了，这在连上 Wi-Fi 时是正常的");
    expect(markup).toContain("正在关联");
  });

  test("a failure screen carries the device's own words plus the on-device log path", () => {
    const markup = body({
      state: stateWith({
        step: "failed",
        ssid: "home-2g",
        failure: describeProvisionFailure("bad-psk", { ssid: "home-2g" }),
      }),
    });
    expect(markup).toContain("密码错误");
    expect(markup).toContain("/data/zos-provision.log");
  });
});
