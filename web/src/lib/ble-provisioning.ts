// Console side of ZOS 蓝牙配网 (BLE provisioning).
//
// Pure and DOM-free on purpose — same split as firmware-mode.ts / zos-link.ts.
// Everything that can be wrong lives here (the 20-byte ATT framer, the
// KEY\tVALUE document codec, the browser gate, the guided flow's state machine)
// and is unit-tested against a fake transport; the component owns
// `navigator.bluetooth` and paints. Web Bluetooth cannot be driven from bun:test
// at all, so any rule that leaks into the component is a rule nothing verifies.
//
// Why BLE at all: the device's only other provisioning path is a SoftAP portal,
// and bringing that hotspot up stops wpa_supplicant — which is the one process
// that can scan or join. BLE leaves the station radio alone, so the clock can
// scan and join *while* this flow is connected to it.

// --- GATT layout ------------------------------------------------------------
//
// One 128-bit service, two characteristics, UART-shaped: one write pipe and one
// notify pipe. A 16-bit alias was rejected on purpose — unassigned 16-bit values
// collide with real SIG assignments and with every other peripheral in the
// chooser, and the chooser is where the user has to recognise their own clock.
//
// The two characteristic UUIDs are the service's base with the first 32 bits
// incremented (the Nordic-UART convention), so the advertisement only ever has
// to carry the one service UUID.

// These three strings are the same bytes as `kServiceUuid` / `kRxUuid` /
// `kTxUuid` in device/tc002-os/app/src/net/BleProtocol.cpp, in canonical text
// order. Web Bluetooth wants them lowercase.
export const ZOS_BLE_SERVICE_UUID = "7a1f5b60-2c8e-4f3a-9d51-0b4e6c8a2d10";
/** Console → device. Write **with response**: ordered and acknowledged. */
export const ZOS_BLE_RX_UUID = "7a1f5b61-2c8e-4f3a-9d51-0b4e6c8a2d10";
/** Device → console. Notify (+ CCCD). Subscribing IS the request for state. */
export const ZOS_BLE_TX_UUID = "7a1f5b62-2c8e-4f3a-9d51-0b4e6c8a2d10";

/** Advertised local name, and the SoftAP SSID: one identity, two transports. */
export const ZOS_BLE_NAME_PREFIX = "ZOS-";

/**
 * The 31-byte advertising payload, itemised, so the device side and this side
 * agree without either measuring the other's bytes:
 *
 *   Flags                      3 B
 *   Complete 128-bit svc UUID 18 B
 *   Complete Local Name       10 B  ("ZOS-A772", 8 ASCII)
 *                           ─────
 *                             31 B  ← the whole legacy AD budget, no scan response
 *
 * The 8-character name is what makes this land exactly, which is why the name is
 * `ZOS-` plus the MAC's last four hex digits and not something friendlier.
 */
export const ZOS_BLE_ADV_BYTES = {
  flags: 3,
  serviceUuid: 18,
  localName: 10,
  total: 31,
} as const;

// --- Framing ----------------------------------------------------------------
//
// 20-byte chunks, unconditionally. Web Bluetooth never exposes the negotiated
// ATT MTU and offers no way to request one (WebBluetoothCG#284), so the default
// 23-byte MTU's 20-byte payload is the only number both sides can be sure of.
// Framing at the application layer also means the peripheral does not have to
// implement Prepare/Execute Write.
//
//   byte 0   bit7 = FIRST, bit6 = LAST, bits5..0 = seq mod 64
//   bytes 1..19  payload
//
// Only the final chunk of a message may be shorter than 20 bytes.

export const BLE_CHUNK_BYTES = 20;
export const BLE_CHUNK_PAYLOAD_BYTES = 19;
export const BLE_SEQ_MODULO = 64;
/**
 * Hard cap per reassembled message, both directions. A 36 MB device must never
 * grow a buffer from the air, and nothing this protocol carries comes close:
 * the largest message is one `evt net` at ~60 bytes.
 */
export const BLE_MAX_MESSAGE_BYTES = 512;

const FRAME_FIRST = 0x80;
const FRAME_LAST = 0x40;
const FRAME_SEQ_MASK = 0x3f;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Split a message body into ATT-writable chunks.
 *
 * Each message restarts the sequence at 0, so a FIRST chunk always carries
 * seq 0. That is a stronger invariant than a session-wide counter — the device
 * can assert it — and loss inside a message is still caught by the +1 rule.
 */
export function encodeBleMessage(body: string): Uint8Array[] {
  const bytes = encoder.encode(body);
  if (bytes.length > BLE_MAX_MESSAGE_BYTES) {
    throw new Error(`message over ${BLE_MAX_MESSAGE_BYTES} bytes`);
  }
  const chunks: Uint8Array[] = [];
  const count = Math.max(1, Math.ceil(bytes.length / BLE_CHUNK_PAYLOAD_BYTES));
  for (let index = 0; index < count; index += 1) {
    const slice = bytes.subarray(
      index * BLE_CHUNK_PAYLOAD_BYTES,
      (index + 1) * BLE_CHUNK_PAYLOAD_BYTES,
    );
    const chunk = new Uint8Array(1 + slice.length);
    let header = index % BLE_SEQ_MODULO;
    if (index === 0) header |= FRAME_FIRST;
    if (index === count - 1) header |= FRAME_LAST;
    chunk[0] = header;
    chunk.set(slice, 1);
    chunks.push(chunk);
  }
  return chunks;
}

export type BleFrameError = "orphan" | "sequence" | "overflow" | "empty";

export interface BleReassembly {
  /** A complete message, when this chunk carried LAST. */
  message?: string;
  /** Why the buffer was dropped. The caller surfaces it; it never throws. */
  error?: BleFrameError;
}

export interface BleReassembler {
  push(chunk: Uint8Array): BleReassembly;
  reset(): void;
}

/**
 * The receive half of the framer.
 *
 * Tolerant of either sequence convention on the device side: FIRST adopts
 * whatever seq it carries, and only continuity (+1 mod 64) is enforced after.
 * A discontinuity, an orphan continuation, or an over-long message drops the
 * buffer rather than emitting a half-message — a truncated `evt net` would
 * render as a real network with a mangled SSID.
 */
export function createBleReassembler(): BleReassembler {
  let parts: Uint8Array[] = [];
  let total = 0;
  let expectSeq: number | null = null;

  const drop = (error: BleFrameError): BleReassembly => {
    parts = [];
    total = 0;
    expectSeq = null;
    return { error };
  };

  return {
    reset() {
      parts = [];
      total = 0;
      expectSeq = null;
    },
    push(chunk) {
      if (chunk.length === 0) return drop("empty");
      const header = chunk[0]!;
      const first = (header & FRAME_FIRST) !== 0;
      const last = (header & FRAME_LAST) !== 0;
      const seq = header & FRAME_SEQ_MASK;
      const payload = chunk.subarray(1);

      if (first) {
        parts = [];
        total = 0;
      } else {
        if (expectSeq === null) return drop("orphan");
        if (seq !== expectSeq) return drop("sequence");
      }
      total += payload.length;
      if (total > BLE_MAX_MESSAGE_BYTES) return drop("overflow");
      parts.push(payload);
      expectSeq = (seq + 1) % BLE_SEQ_MODULO;

      if (!last) return {};
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
      }
      parts = [];
      total = 0;
      expectSeq = null;
      return { message: decoder.decode(joined) };
    },
  };
}

// --- Document codec ---------------------------------------------------------
//
// `KEY\tVALUE\n` lines — the format `net/StateDoc` already parses on the device
// and `src/os-link.ts` already emits. Zero new parser on a firmware with ~1 MB
// free, and StateDoc's sanitisation rules carry over unchanged.

/**
 * Tabs and newlines are the separators, so they can never appear in a value.
 *
 * This REJECTS rather than rewrites, and that is the whole point. A codec that
 * quietly repairs a value sits between the validator and the radio: `pskError`
 * counts the bytes the user typed, the device counts the bytes that arrived,
 * and the two stop being the same string. The trim that used to live here was
 * the worst version of it — `"  pass1234  "` validated at 12 bytes, went on the
 * wire as 8, was accepted by the device, and was handed to wpa_supplicant as a
 * passphrase the user never chose. The console then reported 密码错误 forever,
 * for a password typed correctly. Trailing spaces are legal in both an 802.11
 * SSID and a WPA passphrase; nothing here gets to decide otherwise.
 */
export function bleFieldError(value: string): string | null {
  return /[\t\r\n]/.test(value) ? "不能包含制表符或换行" : null;
}

export function encodeBleDoc(fields: Array<[string, string]>): string {
  return fields.map(([key, value]) => {
    if (bleFieldError(value) !== null) {
      // Unreachable from the UI — ssidError/pskError reject every control
      // character first — and a hard stop rather than a repair if it ever is.
      throw new Error(`ble field ${key} contains a separator byte`);
    }
    return `${key}\t${value}\n`;
  }).join("");
}

/** Last value wins; a line with no tab is ignored rather than half-parsed. */
export function parseBleDoc(body: string): Record<string, string> {
  const doc: Record<string, string> = {};
  for (const line of body.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    doc[line.slice(0, tab)] = line.slice(tab + 1);
  }
  return doc;
}

// --- Commands (console → device) --------------------------------------------
//
// Every command leads with a `cmd` line, so a device-side parser can switch on
// one field. `cmd code` additionally carries the digits under their own `code`
// key, which is also what a parser that only looks for `code` would find.

export function bleHelloCommand(): string {
  return encodeBleDoc([["cmd", "hello"]]);
}

export function bleCodeCommand(code: string): string {
  return encodeBleDoc([["cmd", "code"], ["code", code]]);
}

export function bleScanCommand(): string {
  return encodeBleDoc([["cmd", "scan"]]);
}

export function bleJoinCommand(ssid: string, psk: string): string {
  // The PSK is a value like any other here; it never reaches a log, a toast, or
  // an `evt` — see the device-side rule this mirrors (ProvisionLog cannot
  // structurally receive it).
  return encodeBleDoc([["cmd", "join"], ["ssid", ssid], ["psk", psk]]);
}

export function bleAbortCommand(): string {
  return encodeBleDoc([["cmd", "abort"]]);
}

// --- Events (device → console) ----------------------------------------------

/**
 * The device's own vocabulary.
 *
 * `joining` covers association *and* the DHCP request — the firmware's
 * `kConnecting` and `kObtainingIp` are one wire phase. `addressing` is an
 * optional refinement: a device that sends it lights the third progress step,
 * a device that never does simply keeps the second lit until `online`. Neither
 * is a lie, and no step ever advances on a timer.
 */
export type ProvisionPhase =
  | "locked"
  | "idle"
  | "scanning"
  | "joining"
  | "addressing"
  | "online"
  | "failed";

export type ProvisionErr =
  | "no-code"
  | "locked-out"
  | "bad-psk"
  | "no-ap"
  | "dhcp"
  | "link-locked"
  | "scan-empty"
  | "frame";

export interface BleStateEvent {
  kind: "state";
  phase: ProvisionPhase;
  /** Last attempted SSID; may be empty. */
  ssid: string;
  ip: string;
  err: ProvisionErr | null;
  /** Seconds of lockout remaining; only meaningful with `err=locked-out`. */
  retrySec: number | null;
}

export interface BleNetEvent {
  kind: "net";
  index: number;
  total: number;
  ssid: string;
  rssi: number;
  sec: string;
  /** From /data/zos-scan-cache.txt rather than a fresh sweep. */
  cached: boolean;
}

export interface BleHelloEvent {
  kind: "hello";
  name: string;
  build: string;
  mac: string;
}

/**
 * `evt err`, the device's protocol-level complaint — distinct from the `err`
 * field on `evt state`, which is about the *link*. Codes the firmware emits:
 * `frame` (a message it could not parse), `cmd` (a verb it does not know),
 * `arg` (a field it rejected, e.g. an SSID with a quote in it), `busy`.
 */
export interface BleErrEvent {
  kind: "err";
  code: string;
}

export interface BleUnknownEvent {
  kind: "unknown";
  evt: string;
}

export type BleEvent =
  | BleStateEvent
  | BleNetEvent
  | BleHelloEvent
  | BleErrEvent
  | BleUnknownEvent;

const PHASES: readonly ProvisionPhase[] = [
  "locked", "idle", "scanning", "joining", "addressing", "online", "failed",
];
const ERRS: readonly ProvisionErr[] = [
  "no-code", "locked-out", "bad-psk", "no-ap", "dhcp", "link-locked", "scan-empty", "frame",
];

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Null for a body that is not an event at all; never a guessed shape. */
export function parseBleEvent(body: string): BleEvent | null {
  const doc = parseBleDoc(body);
  const evt = doc.evt;
  if (evt === undefined) return null;
  if (evt === "state") {
    const phase = doc.phase as ProvisionPhase | undefined;
    const err = doc.err as ProvisionErr | undefined;
    return {
      kind: "state",
      // An unrecognised phase reads as `idle` rather than as progress: the flow
      // must never advance on a word it does not understand.
      phase: phase !== undefined && PHASES.includes(phase) ? phase : "idle",
      ssid: doc.ssid ?? "",
      ip: doc.ip ?? "",
      err: err !== undefined && ERRS.includes(err) ? err : null,
      retrySec: doc.retry === undefined ? null : toInt(doc.retry, 0),
    };
  }
  if (evt === "net") {
    return {
      kind: "net",
      index: toInt(doc.i, -1),
      total: toInt(doc.n, 0),
      ssid: doc.ssid ?? "",
      rssi: toInt(doc.rssi, -100),
      sec: doc.sec ?? "open",
      cached: doc.cached === "1",
    };
  }
  if (evt === "hello") {
    return { kind: "hello", name: doc.name ?? "", build: doc.build ?? "", mac: doc.mac ?? "" };
  }
  if (evt === "err") {
    return { kind: "err", code: doc.code ?? "" };
  }
  return { kind: "unknown", evt };
}

// --- Browser gate -----------------------------------------------------------
//
// Web Bluetooth ships in Chrome/Edge on macOS, Windows, ChromeOS and Android.
// Safari and Firefox have never implemented it and have no plans; Chrome on
// Linux needs a flag. The user is on a Mac, where Safari is the default browser,
// so the very first thing this flow does is decide whether it can run at all.
// The four outcomes get four different sentences: one disabled button with a
// tooltip cannot tell someone which of four completely different fixes applies.

export type BleSupportCode = "ok" | "insecure-context" | "no-api" | "no-adapter";

export interface BleSupport {
  code: BleSupportCode;
  ok: boolean;
  title: string;
  detail: string;
  /** Whether to offer the 8080 hotspot/portal path instead. */
  offerPortal: boolean;
}

export interface BleEnvironment {
  /** `window.isSecureContext`. */
  secureContext: boolean;
  /** `"bluetooth" in navigator`. */
  hasBluetooth: boolean;
  /** `await navigator.bluetooth.getAvailability()`; null before it answers. */
  adapterAvailable: boolean | null;
}

/**
 * Order matters and is not arbitrary: on an insecure origin Chrome *also* hides
 * `navigator.bluetooth`, so "no API" is ambiguous between Safari and a LAN URL.
 * Only the secure-context check can tell those apart, so it goes first.
 */
export function describeBleSupport(env: BleEnvironment): BleSupport {
  if (!env.secureContext) {
    return {
      code: "insecure-context",
      ok: false,
      title: "这个页面不能用蓝牙",
      detail:
        "浏览器只允许安全上下文使用网页蓝牙。这一页是从局域网地址打开的，"
        + "请在跑时钟服务的那台电脑上打开 http://127.0.0.1:43820 再来配网。",
      offerPortal: true,
    };
  }
  if (!env.hasBluetooth) {
    return {
      code: "no-api",
      ok: false,
      title: "当前浏览器不支持网页蓝牙",
      detail:
        "Safari 和 Firefox 都没有实现网页蓝牙，也没有计划实现。"
        + "请换 Chrome 或 Edge 打开这一页；不想换浏览器就走时钟自带的配网页。",
      offerPortal: true,
    };
  }
  if (env.adapterAvailable === false) {
    return {
      code: "no-adapter",
      ok: false,
      title: "这台电脑没有可用的蓝牙",
      detail:
        "浏览器报告找不到蓝牙适配器，或者蓝牙被关掉了。打开系统蓝牙后重进这一页；"
        + "macOS 还要在「系统设置 → 隐私与安全性 → 蓝牙」里允许浏览器使用蓝牙。",
      offerPortal: true,
    };
  }
  return {
    code: "ok",
    ok: true,
    title: "可以用蓝牙配网",
    detail: "系统会弹出设备列表，选名字以 ZOS- 开头的那台；时钟面板上正显示同一个名字。",
    offerPortal: false,
  };
}

/**
 * Chooser / connect failures, mapped to something a person can act on.
 *
 * `NotFoundError` is the one that strands people: it means *either* "the user
 * pressed cancel" *or* "nothing matched", and nothing in the API distinguishes
 * them. So the copy says both, and leads with the macOS permission dead end —
 * a Chrome without the system Bluetooth grant produces an empty chooser that
 * looks exactly like a clock that is not advertising.
 */
export function describeBleConnectFailure(name: string, message: string): { title: string; detail: string } {
  if (name === "NotFoundError") {
    return {
      title: "没有选中时钟",
      detail:
        "你可能点了取消。如果列表里一台都没有：先确认时钟面板正在显示「配网」和 ZOS- 开头的名字；"
        + "macOS 上还要在「系统设置 → 隐私与安全性 → 蓝牙」里允许浏览器使用蓝牙。",
    };
  }
  if (name === "SecurityError") {
    return {
      title: "浏览器拒绝了蓝牙请求",
      detail: "这一页不在安全上下文里，或者请求不是由点击触发的。请在 http://127.0.0.1:43820 上重试。",
    };
  }
  if (name === "NetworkError") {
    return {
      title: "连不上这台时钟",
      detail: "选中了设备但 GATT 连接没建立。让时钟离电脑近一点，再点一次重试。",
    };
  }
  if (name === "NotSupportedError") {
    return {
      title: "时钟没有提供配网服务",
      detail: "连上了，但读不到 ZOS 的配网服务。确认时钟面板停在配网页，而不是已经连上网络了。",
    };
  }
  return { title: "蓝牙连接失败", detail: message || "浏览器没有说明原因。" };
}

// --- Networks ---------------------------------------------------------------

export interface ProvisionNetwork {
  ssid: string;
  rssi: number;
  sec: string;
  /** Anything but `open` needs a password. */
  secured: boolean;
  cached: boolean;
}

export function networkFromEvent(event: BleNetEvent): ProvisionNetwork {
  return {
    ssid: event.ssid,
    rssi: event.rssi,
    sec: event.sec,
    secured: event.sec !== "open",
    cached: event.cached,
  };
}

/** 1..4 bars. -55 and better is full; below -85 the join is unlikely to hold. */
export function signalBars(rssi: number): 1 | 2 | 3 | 4 {
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -78) return 2;
  return 1;
}

export function signalLabel(rssi: number): string {
  const bars = signalBars(rssi);
  return bars === 4 ? "很强" : bars === 3 ? "良好" : bars === 2 ? "一般" : "很弱";
}

export function securityLabel(sec: string): string {
  if (sec === "open") return "开放";
  if (sec === "wep") return "WEP";
  if (sec === "wpa") return "WPA";
  if (sec === "wpa2") return "WPA2";
  if (sec === "wpa3") return "WPA3";
  return sec.toUpperCase();
}

// --- Credential validation --------------------------------------------------
//
// Mirrors `ble::ssidIsSafe` / `ble::pskIsSafe` in
// device/tc002-os/app/src/net/BleProtocol.h, field for field and in the same
// order so the two can be diffed by eye. The firmware stays authoritative — it
// re-checks on its own doorstep because a GATT write is the one input this
// device takes from a stranger — but a locally-catchable mistake should not
// cost a BLE round trip and come back as an opaque `evt err code=arg`.

const utf8 = new TextEncoder();

/** null when this SSID would be accepted; a sentence when it would not. */
export function ssidError(ssid: string): string | null {
  const bytes = utf8.encode(ssid).length;
  if (bytes === 0) return "请填写网络名称";
  // 802.11 says 32 octets, not 32 characters — a Chinese SSID runs out sooner.
  if (bytes > 32) return "网络名称超过 32 字节（中文一个字算 3 字节）";
  if (/[\u0000-\u001f\u007f]/.test(ssid)) return "网络名称不能包含控制字符";
  // A quote or a backslash would close the argument early in the supplicant's
  // `SET_NETWORK %d ssid "%s"` — the firmware rejects it for that reason.
  if (/["\\]/.test(ssid)) return "网络名称不能包含引号或反斜杠";
  return null;
}

export function pskError(psk: string, secured: boolean): string | null {
  if (psk === "") return secured ? "这个网络需要密码" : null;
  const bytes = utf8.encode(psk).length;
  if (bytes < 8) return "Wi-Fi 密码至少 8 位";
  // 64 would be a raw hex PSK; this path quotes it as a passphrase, so it would
  // be accepted here and then silently fail to associate on the device.
  if (bytes > 63) return "Wi-Fi 密码最多 63 字节";
  if (/[\u0000-\u001f\u007f]/.test(psk)) return "密码不能包含控制字符";
  if (/["\\]/.test(psk)) return "密码不能包含引号或反斜杠";
  return null;
}

// --- Failure copy -----------------------------------------------------------

export type ProvisionFailureCode =
  | ProvisionErr
  /** `evt err code=arg` answering a join: the device rejected the SSID or PSK. */
  | "bad-field"
  | "dropped"
  | "no-reply"
  | "transport"
  | "protocol"
  | "unknown";

/** Where 重试 goes back to. `null` means the failure is terminal for this session. */
export type ProvisionRetryTarget = "discover" | "networks" | "password" | null;

export interface ProvisionFailure {
  code: ProvisionFailureCode;
  title: string;
  detail: string;
  retryTo: ProvisionRetryTarget;
  retryLabel: string;
}

/**
 * One `err` value, one sentence, one next action.
 *
 * 密码错误 and 找不到这个网络 are different problems with different fixes, so
 * they never share a message — and neither is ever guessed: the device only
 * says `bad-psk` when the supplicant actually reported an auth/4-way failure.
 */
export function describeProvisionFailure(
  code: ProvisionFailureCode,
  context: { ssid?: string; detail?: string; manualSsid?: boolean } = {},
): ProvisionFailure {
  const ssid = context.ssid?.trim() ?? "";
  const named = ssid === "" ? "这个网络" : `「${ssid}」`;
  switch (code) {
    case "bad-field":
      // The device re-checks credentials on its own doorstep — a GATT write is
      // the one input it takes from a stranger — so this is reachable even
      // though ssidError/pskError ran first. It is a field to fix, not a
      // firmware to upgrade, and it costs neither the link nor the code.
      return {
        code,
        title: "时钟不接受这个网络名称或密码",
        detail:
          "时钟按自己的规则复核了这条指令：网络名称 1–32 字节、密码 8–63 字节，"
          + "两者都不能带引号或反斜杠。改一处再提交，蓝牙连接不用重来。",
        retryTo: context.manualSsid === true ? "networks" : "password",
        retryLabel: context.manualSsid === true ? "重新选网络" : "重新输密码",
      };
    case "bad-psk":
      return {
        code,
        title: "密码错误",
        detail: `时钟关联${named}时被路由器拒绝了，是密码不对。重新输一次，注意大小写。`,
        retryTo: "password",
        retryLabel: "重新输密码",
      };
    case "no-ap":
      return {
        code,
        title: "找不到这个网络",
        detail: `时钟没能找到${named}。它可能是 5G 频段（时钟只有 2.4G），也可能刚好关掉了或改了名字。`,
        retryTo: "networks",
        retryLabel: "重新扫描",
      };
    case "dhcp":
      return {
        code,
        title: "连上了，但没拿到地址",
        detail: `时钟已经关联${named}，路由器却没有分配 IP。时钟会自己继续要地址，也可以在路由器上确认 DHCP 是否开着。`,
        retryTo: "password",
        retryLabel: "重试",
      };
    case "link-locked":
      return {
        code,
        title: "这台设备的链路改动被锁着",
        detail:
          "ZOS 把所有会改变无线链路的动作锁在守卫文件后面，这是安装态而不是故障。"
          + "执行 adb shell touch /tmp/zos-allow-link 武装一次实验，断电自动解除。",
        retryTo: null,
        retryLabel: "重试",
      };
    case "no-code":
      return {
        code,
        title: "验证码不对",
        detail: "面板上正在显示的六位数字才是这一次会话的验证码，它每次配网都会变。",
        retryTo: "discover",
        retryLabel: "重新连接",
      };
    case "locked-out":
      return {
        code,
        title: "验证码试错太多次",
        detail: "时钟暂时不再接受验证码。等面板上的倒计时走完，再重新连接一次。",
        retryTo: "discover",
        retryLabel: "重新连接",
      };
    case "frame":
      return {
        code,
        title: "蓝牙数据损坏",
        detail: "时钟收到的分片对不上，这一条指令已经丢弃。重连一次通常就好。",
        retryTo: "discover",
        retryLabel: "重新连接",
      };
    case "scan-empty":
      return {
        code,
        title: "这一轮没有扫到网络",
        detail: "时钟的射频只有 2.4G。手机上看得到的 5G 网络它听不见，也连不上。",
        retryTo: "networks",
        retryLabel: "重新扫描",
      };
    case "protocol":
      return {
        code,
        title: "时钟不认识这条指令",
        detail:
          context.detail
          ?? "控制台和时钟固件的配网协议对不上。多半是两边版本不一致——更新固件，或者刷新这一页。",
        retryTo: "discover",
        retryLabel: "重新连接",
      };
    case "dropped":
      return {
        code,
        title: "时钟没有回到网络上",
        detail:
          `蓝牙在时钟连接${named}时断开了，之后它也没有在局域网上出现。`
          + "它可能连上了但没拿到地址，也可能密码不对——蓝牙已经断开，这一轮问不出来了。"
          + "时钟面板上会写着真正的原因。",
        retryTo: "discover",
        retryLabel: "重新连接",
      };
    case "no-reply":
      return {
        code,
        title: "时钟没有应答",
        detail: "蓝牙连上了，但时钟没有回状态。确认它停在配网页，然后重连一次。",
        retryTo: "discover",
        retryLabel: "重新连接",
      };
    case "transport":
      return {
        code,
        title: "蓝牙链路中断",
        detail: context.detail ?? "指令没有发出去。重新连接一次。",
        retryTo: "discover",
        retryLabel: "重新连接",
      };
    default:
      return {
        code: "unknown",
        title: "配网没有完成",
        detail: context.detail ?? "时钟没有说明原因。重连一次，并留意面板上的提示。",
        retryTo: "discover",
        retryLabel: "重新连接",
      };
  }
}

// --- Progress ---------------------------------------------------------------

export type ProvisionProgressKey = "submitted" | "associating" | "addressing" | "online";

export interface ProvisionProgressStep {
  key: ProvisionProgressKey;
  label: string;
  state: "done" | "active" | "pending";
}

const PROGRESS_ORDER: readonly { key: ProvisionProgressKey; label: string }[] = [
  { key: "submitted", label: "已提交" },
  { key: "associating", label: "正在关联" },
  { key: "addressing", label: "正在获取地址" },
  { key: "online", label: "已连接" },
];

/**
 * The four steps, driven only by what the device said. Nothing here reads a
 * clock — a progress bar that advances on a timer is the console-side twin of
 * the panel printing a code it never put on the air.
 */
export function describeProgress(phase: ProvisionPhase): ProvisionProgressStep[] {
  const reached: Record<ProvisionProgressKey, number> = {
    submitted: 0, associating: 1, addressing: 2, online: 3,
  };
  const current = phase === "online"
    ? reached.online
    : phase === "addressing"
      ? reached.addressing
      : phase === "joining"
        ? reached.associating
        : reached.submitted;
  return PROGRESS_ORDER.map((step, index) => ({
    key: step.key,
    label: step.label,
    state: index < current ? "done" : index === current ? "active" : "pending",
  }));
}

// --- Transport seam ---------------------------------------------------------

export type BleConnectStage = "chooser" | "connecting" | "service" | "subscribing" | "ready";

export const BLE_CONNECT_STAGE_LABELS: Record<BleConnectStage, string> = {
  chooser: "等待你在系统弹窗里选一台时钟",
  connecting: "正在连接",
  service: "正在打开配网服务",
  subscribing: "正在订阅设备状态",
  ready: "已连接，等待时钟回状态",
};

export interface BleTransportHandlers {
  /** One ATT notification, raw. */
  onChunk(chunk: Uint8Array): void;
  /** Connection dropped, for any reason, including a deliberate disconnect. */
  onDisconnect(): void;
  /** Progress inside `connect`, so the UI line advances on real events only. */
  onStage(stage: BleConnectStage): void;
}

export interface BleTransport {
  /** Chooser → GATT → service → characteristics → subscribe. Resolves subscribed. */
  connect(handlers: BleTransportHandlers): Promise<void>;
  /** One chunk, write-with-response. */
  write(chunk: Uint8Array): Promise<void>;
  disconnect(): void;
}

// --- Session ----------------------------------------------------------------

export type ProvisionStep =
  | "ready"
  | "connecting"
  | "code"
  | "networks"
  | "password"
  | "joining"
  | "done"
  | "failed";

export interface ProvisionState {
  step: ProvisionStep;
  connectStage: BleConnectStage | null;
  device: { name: string; build: string; mac: string } | null;
  /** The device reported `phase=locked` on hello: say so before asking for anything. */
  linkLocked: boolean;
  codeError: string | null;
  codeAttempts: number;
  /** Epoch ms the device will accept codes again, from `retry`. */
  lockedOutUntilMs: number | null;
  busy: boolean;
  networks: ProvisionNetwork[];
  /** `n` from the first `evt net`; null until the device says how many. */
  networkTotal: number | null;
  scanning: boolean;
  scanCached: boolean;
  ssid: string;
  manualSsid: boolean;
  secured: boolean;
  phase: ProvisionPhase;
  /** A locally-caught SSID/password problem. The device was never asked. */
  credentialError: string | null;
  /** BLE died mid-join. Ambiguous, not a failure — see the note in `onDisconnect`. */
  bleDropped: boolean;
  waitingForLan: boolean;
  ip: string | null;
  failure: ProvisionFailure | null;
}

/**
 * kConnectTimeoutMs on the device is 25 s; DHCP adds a few more. 40 s is that
 * plus margin — long enough that a slow router still lands in success, short
 * enough that a real failure is not left spinning.
 */
export const LAN_RECOVERY_WINDOW_MS = 40_000;
export const LAN_RECOVERY_POLL_MS = 2_000;
/** No `evt state` at all after subscribing means the device is not listening. */
export const HELLO_TIMEOUT_MS = 8_000;
/** A code that draws no reply while BLE is still up. */
export const REPLY_TIMEOUT_MS = 8_000;
/**
 * Ceiling on a whole sweep, armed once the device acknowledges `cmd scan` with
 * `phase=scanning`. A real sweep on this radio takes seconds, and the device
 * ends it by moving off `scanning` — this only exists so a device that dies
 * mid-sweep leaves a list rather than a spinner.
 */
export const SCAN_TIMEOUT_MS = 30_000;
/** BLE stayed up through the whole join and the device never concluded. */
export const JOIN_TIMEOUT_MS = 60_000;
/** After this the device locks out; the authority is still `err=locked-out`. */
export const CODE_ATTEMPT_LIMIT = 5;

export interface ProvisionSessionOptions {
  transport: BleTransport;
  /**
   * `GET /api/os/state`, reduced. The only way to finish the flow when BLE dies
   * the moment the clock joins Wi-Fi — one aic8800 carries both radios and ZOS
   * has never had both up at once.
   *
   * `reportSeq` is `telemetry.seq`: how many reports the service has ever
   * received. It is what makes this a witness instead of a memory — see
   * `startLanRecovery`. `ssid` is `telemetry.wifi`, the network the clock says
   * it is actually on.
   */
  readOsState: () => Promise<{
    live: boolean;
    ip: string | null;
    ssid: string | null;
    reportSeq: number;
  }>;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  onChange?: (state: ProvisionState) => void;
}

export interface ProvisionSession {
  getState(): ProvisionState;
  /** S1 → S2: chooser, connect, subscribe, hello. */
  start(): Promise<void>;
  submitCode(code: string): Promise<void>;
  rescan(): Promise<void>;
  chooseNetwork(ssid: string): void;
  useManualSsid(ssid: string): void;
  /** S5 → S6. An open network submits an empty password. */
  submitPassword(psk: string): Promise<void>;
  /** S5 → S4 without touching the device. */
  backToNetworks(): void;
  /** S8's action, per `failure.retryTo`. */
  retry(): Promise<void>;
  /** Abort + disconnect + reset. Safe to call at any point. */
  close(): void;
}

function initialState(): ProvisionState {
  return {
    step: "ready",
    connectStage: null,
    device: null,
    linkLocked: false,
    codeError: null,
    codeAttempts: 0,
    lockedOutUntilMs: null,
    busy: false,
    networks: [],
    networkTotal: null,
    scanning: false,
    scanCached: false,
    ssid: "",
    manualSsid: false,
    secured: true,
    phase: "idle",
    credentialError: null,
    bleDropped: false,
    waitingForLan: false,
    ip: null,
    failure: null,
  };
}

export function createProvisionSession(options: ProvisionSessionOptions): ProvisionSession {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer
    ?? ((callback: () => void, ms: number) => window.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: number) => window.clearTimeout(handle));

  let state = initialState();
  let connected = false;
  // What the flow is currently waiting for the device to answer. Everything is
  // event-driven off this rather than promise plumbing, so a reply that arrives
  // late (or twice) lands in exactly one place.
  let awaiting: "hello" | "code" | "scan" | "join" | null = null;
  let replyTimer: number | null = null;
  let lanTimer: number | null = null;
  let lanDeadline = 0;
  // `telemetry.seq` as it stood when the join was handed to the radio; null when
  // the probe could not be taken. See `witnessesJoin`.
  let lanWatermark: number | null = null;
  const reassembler = createBleReassembler();

  const emit = () => options.onChange?.({ ...state });
  const patch = (next: Partial<ProvisionState>) => {
    state = { ...state, ...next };
    emit();
  };

  const clearReplyTimer = () => {
    if (replyTimer !== null) clearTimer(replyTimer);
    replyTimer = null;
  };
  const clearLanTimer = () => {
    if (lanTimer !== null) clearTimer(lanTimer);
    lanTimer = null;
  };

  const armReply = (what: NonNullable<typeof awaiting>, ms: number, onTimeout: () => void) => {
    awaiting = what;
    clearReplyTimer();
    replyTimer = setTimer(() => {
      replyTimer = null;
      if (awaiting !== what) return;
      awaiting = null;
      onTimeout();
    }, ms);
  };

  const fail = (code: ProvisionFailureCode, detail?: string) => {
    clearReplyTimer();
    clearLanTimer();
    awaiting = null;
    patch({
      step: "failed",
      busy: false,
      scanning: false,
      waitingForLan: false,
      failure: describeProvisionFailure(code, {
        ssid: state.ssid,
        detail,
        manualSsid: state.manualSsid,
      }),
    });
  };

  const send = async (body: string): Promise<boolean> => {
    try {
      for (const chunk of encodeBleMessage(body)) await options.transport.write(chunk);
      return true;
    } catch (error) {
      fail("transport", error instanceof Error ? error.message : undefined);
      return false;
    }
  };

  const succeed = (ip: string | null) => {
    clearReplyTimer();
    clearLanTimer();
    awaiting = null;
    patch({
      step: "done",
      busy: false,
      waitingForLan: false,
      phase: "online",
      ip: ip === null || ip === "" ? state.ip : ip,
    });
    // The link is the point; holding the GATT connection open after it is up
    // keeps the radio busy for nothing.
    try {
      options.transport.disconnect();
    } catch {
      // Already gone. Success does not depend on a clean teardown.
    }
  };

  /**
   * Does this `/api/os/state` answer prove that THIS join worked?
   *
   * `live` alone does not, and the case where it does not is the main one:
   * "move my working clock to a new network" starts from a clock that is online
   * and reporting, and the firmware keeps BLE up for two minutes after it comes
   * online precisely so that flow is possible. Its last report is then well
   * inside the 15 s liveness window, so the very first poll after a FAILED join
   * would report success — at the old network's IP.
   *
   * Two independent conditions, both cheap:
   *   - a report that arrived after the join was submitted, and
   *   - that report naming the network we asked for.
   * When the watermark could not be taken the SSID carries it alone; when
   * neither can speak, the poll simply runs out and `dropped` says so, which is
   * the honest answer and already has copy.
   */
  const witnessesJoin = (
    osState: { live: boolean; ssid: string | null; reportSeq: number },
  ): boolean => {
    if (!osState.live) return false;
    if (lanWatermark !== null && osState.reportSeq <= lanWatermark) return false;
    if (state.ssid !== "") return osState.ssid === state.ssid;
    return lanWatermark !== null;
  };

  const startLanRecovery = () => {
    lanDeadline = now() + LAN_RECOVERY_WINDOW_MS;
    const poll = () => {
      lanTimer = null;
      void options.readOsState().then((osState) => {
        if (state.step !== "joining" || !state.waitingForLan) return;
        if (witnessesJoin(osState)) {
          succeed(osState.ip);
          return;
        }
        if (now() >= lanDeadline) {
          fail("dropped");
          return;
        }
        lanTimer = setTimer(poll, LAN_RECOVERY_POLL_MS);
      }).catch(() => {
        if (state.step !== "joining" || !state.waitingForLan) return;
        if (now() >= lanDeadline) {
          fail("dropped");
          return;
        }
        lanTimer = setTimer(poll, LAN_RECOVERY_POLL_MS);
      });
    };
    lanTimer = setTimer(poll, LAN_RECOVERY_POLL_MS);
  };

  const onStateEvent = (event: BleStateEvent) => {
    if (event.phase === "locked" || event.err === "link-locked") {
      clearReplyTimer();
      awaiting = null;
      patch({ linkLocked: true, busy: false });
      fail("link-locked");
      return;
    }

    if (awaiting === "hello") {
      clearReplyTimer();
      awaiting = null;
      patch({ step: "code", busy: false, phase: event.phase, connectStage: "ready" });
      return;
    }

    if (awaiting === "code") {
      clearReplyTimer();
      awaiting = null;
      if (event.err === "locked-out") {
        const seconds = event.retrySec ?? 60;
        patch({
          busy: false,
          lockedOutUntilMs: now() + seconds * 1000,
          codeError: `验证码试错太多次，请等 ${seconds} 秒后再试。`,
        });
        return;
      }
      if (event.err === "no-code") {
        patch({
          busy: false,
          codeAttempts: state.codeAttempts + 1,
          codeError: "数字不对。面板上正在显示的六位数字才是这一次的验证码。",
        });
        return;
      }
      // Anything that is not a code rejection means the code was taken; the
      // device moves itself to 扫描中 (panel state D) at the same moment.
      patch({
        step: "networks",
        busy: false,
        codeError: null,
        phase: event.phase,
        networks: [],
        networkTotal: null,
        scanning: true,
        scanCached: false,
      });
      void requestScan();
      return;
    }

    if (state.step === "joining") {
      if (event.phase === "online") {
        succeed(event.ip);
        return;
      }
      if (event.phase === "failed" || event.err !== null) {
        fail(event.err ?? "unknown");
        return;
      }
      if (awaiting === "join") {
        clearReplyTimer();
        awaiting = null;
        // BLE may die the instant the clock joins, so the join gets its own
        // ceiling rather than an unbounded wait for a reply that cannot come.
        armReply("join", JOIN_TIMEOUT_MS, () => fail("unknown"));
      }
      patch({ phase: event.phase, ssid: event.ssid || state.ssid });
      return;
    }

    if (state.step === "networks") {
      if (event.phase === "scanning") {
        // The device acknowledged the request. Swap the short "did it hear me"
        // timeout for the sweep's own ceiling.
        if (awaiting === "scan") {
          clearReplyTimer();
          armReply("scan", SCAN_TIMEOUT_MS, () => {
            patch({ scanning: false, networkTotal: state.networks.length });
          });
        }
        patch({ phase: event.phase, scanning: true });
        return;
      }
      // Moving off `scanning` ENDS the sweep, whatever arrived. The device drops
      // networks whose SSID it cannot round-trip safely, so `n` can legitimately
      // exceed the number of `evt net` messages — waiting for the count to match
      // would leave the spinner up forever on exactly those scans.
      if (state.scanning) {
        clearReplyTimer();
        if (awaiting === "scan") awaiting = null;
        patch({
          phase: event.phase,
          scanning: false,
          networkTotal: state.networkTotal ?? state.networks.length,
        });
        return;
      }
      patch({ phase: event.phase });
      return;
    }

    patch({ phase: event.phase });
  };

  const onNetEvent = (event: BleNetEvent) => {
    // The scan ceiling is deliberately left armed here: the sweep is over when
    // the device says it is over (a state event off `scanning`), not when the
    // last row this side happened to receive arrived.
    //
    // `n 0` with no SSID is the empty-result terminator: there is no other
    // message that could carry the total when the sweep found nothing.
    if (event.total === 0 || event.ssid === "") {
      patch({ scanning: false, networkTotal: event.total, scanCached: event.cached || state.scanCached });
      return;
    }
    const networks = state.networks.slice();
    const network = networkFromEvent(event);
    const existing = networks.findIndex((candidate) => candidate.ssid === network.ssid);
    if (existing >= 0) networks[existing] = network;
    else networks.push(network);
    const total = event.total > 0 ? event.total : state.networkTotal;
    patch({
      networks,
      networkTotal: total,
      scanCached: event.cached || state.scanCached,
      scanning: total === null ? true : networks.length < total,
    });
  };

  /**
   * `evt err` is the device saying it could not act on what it was sent.
   *
   * `frame` and `busy` are recoverable and deliberately silent: a dropped chunk
   * resynchronises on the next FIRST, and `busy` only ever answers a second
   * scan the UI already disables. `doc` is the device rejecting a whole
   * document its parser would not accept — permanent, since resending the same
   * bytes fails the same way — so it is NOT silent, or the outstanding reply
   * timer would expire and report 时钟没有应答 about a device that answered
   * immediately and said no.
   *
   * `arg` is the one that matters in practice. Its only reachable cause is
   * `ssidIsSafe`/`pskIsSafe` rejecting the join it is answering, so it is a
   * credential problem, not a version skew — and sending the user back to the
   * chooser for it would cost them the GATT link and a six-digit code the
   * device has by then re-minted. `cmd` genuinely does mean the two halves
   * disagree, and keeps the version copy.
   */
  const onErrEvent = (event: BleErrEvent) => {
    if (event.code === "frame" || event.code === "busy") return;
    const wasJoining = awaiting === "join" || state.step === "joining";
    clearReplyTimer();
    awaiting = null;
    patch({ busy: false, scanning: false });
    if (event.code === "arg" && wasJoining) {
      fail("bad-field");
      return;
    }
    fail("protocol", event.code === "arg"
      ? "时钟拒绝了这条指令里的某个字段。多半是网络名称或密码里有它不接受的字符。"
      : event.code === "doc"
        ? "时钟没能解析这条指令的格式。多半是两边版本不一致——更新固件，或者刷新这一页。"
        : undefined);
  };

  const onMessage = (body: string) => {
    const event = parseBleEvent(body);
    if (event === null) return;
    if (event.kind === "hello") {
      patch({ device: { name: event.name, build: event.build, mac: event.mac } });
      return;
    }
    if (event.kind === "state") {
      onStateEvent(event);
      return;
    }
    if (event.kind === "net") {
      onNetEvent(event);
      return;
    }
    if (event.kind === "err") onErrEvent(event);
  };

  const handlers: BleTransportHandlers = {
    onStage: (stage) => patch({ connectStage: stage }),
    onChunk: (chunk) => {
      const result = reassembler.push(chunk);
      if (result.error !== undefined) {
        // A dropped buffer is not worth ending the session over — the next
        // FIRST chunk resynchronises — but it must never be shown as data.
        return;
      }
      if (result.message !== undefined) onMessage(result.message);
    },
    onDisconnect: () => {
      connected = false;
      if (state.step === "done" || state.step === "failed" || state.step === "ready") return;
      if (state.step === "joining") {
        // NOT a failure. One aic8800 carries Wi-Fi and BLE, and ZOS has never
        // had both up at once, so losing the link at exactly this moment is the
        // expected shape of success. The LAN is the only remaining witness.
        clearReplyTimer();
        awaiting = null;
        patch({ bleDropped: true, waitingForLan: true });
        startLanRecovery();
        return;
      }
      fail("dropped");
    },
  };

  async function requestScan(): Promise<void> {
    if (!connected) return;
    patch({ scanning: true, networks: [], networkTotal: null, scanCached: false });
    armReply("scan", REPLY_TIMEOUT_MS, () => patch({ scanning: false, networkTotal: 0 }));
    await send(bleScanCommand());
  }

  const session: ProvisionSession = {
    getState: () => ({ ...state }),

    async start() {
      if (state.busy) return;
      reassembler.reset();
      state = { ...initialState(), step: "connecting", busy: true, connectStage: "chooser" };
      emit();
      try {
        await options.transport.connect(handlers);
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        const message = error instanceof Error ? error.message : "";
        const described = describeBleConnectFailure(name, message);
        patch({
          step: "failed",
          busy: false,
          connectStage: null,
          failure: {
            code: "transport",
            title: described.title,
            detail: described.detail,
            retryTo: "discover",
            retryLabel: "重新选择时钟",
          },
        });
        return;
      }
      connected = true;
      patch({ connectStage: "ready" });
      // Subscribing is the request; `cmd hello` is what makes the device answer
      // with a state it may have been holding since boot (including 未解锁).
      armReply("hello", HELLO_TIMEOUT_MS, () => fail("no-reply"));
      await send(bleHelloCommand());
    },

    async submitCode(code) {
      if (state.busy || !connected) return;
      if (state.lockedOutUntilMs !== null && now() < state.lockedOutUntilMs) return;
      patch({ busy: true, codeError: null });
      armReply("code", REPLY_TIMEOUT_MS, () => {
        patch({ busy: false, codeError: "时钟没有回应这次验证。再试一次。" });
      });
      await send(bleCodeCommand(code));
    },

    async rescan() {
      await requestScan();
    },

    chooseNetwork(ssid) {
      const network = state.networks.find((candidate) => candidate.ssid === ssid);
      patch({
        step: "password",
        ssid,
        manualSsid: false,
        secured: network?.secured ?? true,
        credentialError: null,
        failure: null,
      });
    },

    useManualSsid(ssid) {
      // A hidden SSID and an empty list must never be a dead end — the device's
      // own portal page already argues this, and it is doubly true here where
      // the list can only ever be what the clock's radio happened to hear.
      //
      // Validated here rather than only in the dialog: a disabled button is a
      // rendering choice, and the rule it enforces has to live where the tests
      // can reach it and where every caller passes through.
      const invalid = ssidError(ssid);
      if (invalid !== null) {
        patch({ credentialError: invalid });
        return;
      }
      patch({
        step: "password",
        ssid,
        manualSsid: true,
        secured: true,
        credentialError: null,
        failure: null,
      });
    },

    async submitPassword(psk) {
      if (state.busy || !connected) return;
      const invalid = ssidError(state.ssid) ?? pskError(psk, state.secured);
      if (invalid !== null) {
        patch({ credentialError: invalid });
        return;
      }
      patch({
        step: "joining",
        busy: true,
        phase: "idle",
        bleDropped: false,
        credentialError: null,
        failure: null,
      });
      // Taken BEFORE the join goes out, and awaited: the answer is a local HTTP
      // call to the same service that served this page. A watermark taken after
      // the drop would already include a report from the network we are trying
      // to leave. A probe that resolves late is safe in the only direction that
      // matters — it can cost one extra 10 s heartbeat, never a false success.
      lanWatermark = await options.readOsState()
        .then((osState) => osState.reportSeq)
        .catch(() => null);
      armReply("join", REPLY_TIMEOUT_MS, () => fail("no-reply"));
      await send(bleJoinCommand(state.ssid, psk));
    },

    backToNetworks() {
      patch({ step: "networks", credentialError: null, failure: null });
    },

    async retry() {
      const target = state.failure?.retryTo ?? "discover";
      if (target === "password" && connected) {
        patch({ step: "password", failure: null, credentialError: null, busy: false });
        return;
      }
      if (target === "networks" && connected) {
        patch({ step: "networks", failure: null, credentialError: null, busy: false });
        await requestScan();
        return;
      }
      // Web Bluetooth has no silent reconnect — `getDevices()` and
      // `watchAdvertisements()` are both behind a flag — so every retry that
      // needs a fresh link starts at the chooser again. Design for that.
      session.close();
      await session.start();
    },

    close() {
      clearReplyTimer();
      clearLanTimer();
      awaiting = null;
      if (connected) {
        // Best effort: the device should stop advertising a live session rather
        // than wait out a timeout, but a closing dialog must never block on it.
        for (const chunk of encodeBleMessage(bleAbortCommand())) {
          void options.transport.write(chunk).catch(() => undefined);
        }
        try {
          options.transport.disconnect();
        } catch {
          // Nothing to tear down.
        }
      }
      connected = false;
      reassembler.reset();
      state = initialState();
      emit();
    },
  };

  return session;
}
