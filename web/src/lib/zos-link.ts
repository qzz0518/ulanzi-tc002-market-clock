// Console side of the tc002-os link. The device pulls (src/os-link.ts explains
// why), so everything here is polling — there is no socket to hold open and no
// address the console could push to.
//
// Three separate cadences, because the three things move at three speeds:
// the state document changes only when a human touches it, the mirror streams
// at whatever the firmware's compositor manages (~4fps measured on hardware),
// and telemetry arrives on the firmware's own 10s heartbeat.

export const ZOS_SCREEN_WIDTH = 52;
export const ZOS_SCREEN_HEIGHT = 16;
export const ZOS_MIRROR_RGB_BYTES = ZOS_SCREEN_WIDTH * ZOS_SCREEN_HEIGHT * 3;

// The menu and the pin state only change when someone acts on them, so this is
// a "did another tab move it" cadence, not an animation one.
export const ZOS_STATE_POLL_MS = 2_000;
// Asking for the frame IS the subscription (GET /api/os/mirror renews a 10s
// lease), so this loop keeps running even while the device is offline —
// otherwise the firmware would never see mirror=1 in the state document and
// would never start streaming when it comes back.
export const ZOS_MIRROR_POLL_MS = 250;
// While nothing is live there is no picture to chase; 2s still renews the 10s
// lease with plenty of margin at an eighth of the request rate.
export const ZOS_MIRROR_IDLE_POLL_MS = 2_000;
// The firmware tees roughly 4 frames a second, so a frame older than this means
// the stream stalled rather than "the panel is showing something static".
export const ZOS_MIRROR_STALE_MS = 2_500;
// Failure backoff ceiling. Long enough that a stopped service does not generate
// traffic, short enough that restarting it reconnects the console on its own.
export const ZOS_MAX_POLL_MS = 10_000;

export interface ZosMenuEntry {
  id: string;
  label: string;
  kind: "channel" | "music" | "game" | "settings";
}

export interface ZosDisplay {
  focus: string | null;
  pinned: boolean;
}

export interface ZosTelemetry {
  screen: string;
  focus: string;
  wifi: string;
  ip: string;
  uptimeMs: number;
  freeKb: number;
  supplicantRestarts: number;
  /** 0..100, or -1 before the device has a reading. Optional: older services omit it. */
  batteryPercent?: number;
  charging?: boolean;
  /** True when ZOS runs from flash rather than a sideload session. */
  flashed?: boolean;
  receivedAt: number;
  /** Report age per the service's clock; see ZosMirrorFrame.ageMs. */
  ageMs?: number;
}

/** What the console last asked the device to adopt — a request, not device truth. */
export interface ZosRequestedSettings {
  volume: number | null;
  brightness: number | null;
  /** Bumped per write; the firmware applies only sequences it has not seen. */
  seq: number;
}

export interface ZosState {
  seq: number;
  menu: ZosMenuEntry[];
  display: ZosDisplay;
  telemetry: ZosTelemetry | null;
  /** Server-side liveness verdict. Trust this over any local clock arithmetic. */
  live: boolean;
  /** Sticky: a flashed ZOS stays true even while the device is off the air. */
  zosFlashed?: boolean;
  requestedSettings?: ZosRequestedSettings;
  /** Service-side event tail. Not drained on consumption, so never shown as "pending". */
  pendingInputs?: ZosInputEvent[];
}

export interface ZosMirrorFrame {
  rgbBase64: string;
  receivedAt: number;
  /**
   * How old the frame was when the service answered, measured against the
   * service's own clock.
   *
   * Preferred over subtracting `receivedAt` from a browser clock, because the
   * two clocks are not the same one: a machine ten seconds out of step would
   * otherwise report a live stream as stale forever, or — the case actually
   * observed — paint a two-minute-old frame as current. Optional so the panel
   * still works against a service that predates the field.
   */
  ageMs?: number;
}

/**
 * Base64 of 52*16*3 raw RGB bytes → an RGBA buffer ImageData can take.
 *
 * These are the bytes the panel actually received, teed on the way out of the
 * firmware's compositor, so a decode failure must produce nothing rather than a
 * plausible-looking picture: painting a half-decoded frame would be exactly the
 * "blank box that looks like a working black screen" this panel exists to avoid.
 */
export function decodeMirrorFrame(rgbBase64: string): Uint8ClampedArray | null {
  let binary: string;
  try {
    binary = atob(rgbBase64);
  } catch {
    return null;
  }
  if (binary.length !== ZOS_MIRROR_RGB_BYTES) return null;
  const pixels = ZOS_SCREEN_WIDTH * ZOS_SCREEN_HEIGHT;
  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    rgba[pixel * 4] = binary.charCodeAt(pixel * 3);
    rgba[pixel * 4 + 1] = binary.charCodeAt(pixel * 3 + 1);
    rgba[pixel * 4 + 2] = binary.charCodeAt(pixel * 3 + 2);
    rgba[pixel * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Exponential backoff on consecutive failures, capped.
 *
 * The console and the service usually share a host, so the common failure is
 * "the service is restarting", not "the network is congested" — the point of
 * the cap is to keep reconnecting without a manual refresh.
 */
export function nextPollDelayMs(baseMs: number, failures: number, maxMs = ZOS_MAX_POLL_MS): number {
  if (failures <= 0) return baseMs;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures, 10));
}

export type ZosMirrorPhase = "offline" | "waiting" | "stale" | "live";

export interface ZosMirrorStatus {
  phase: ZosMirrorPhase;
  /** Short label for the status chip. */
  label: string;
  /** Honest sentence for the overlay; null only when the picture is current. */
  notice: string | null;
  /** Whether the last decoded frame may still be painted. */
  showsFrame: boolean;
}

export function describeMirror(input: {
  live: boolean;
  frameReceivedAt: number | null;
  now: number;
  /** Service-measured age; used in preference to the clock subtraction below. */
  frameAgeMs?: number;
}): ZosMirrorStatus {
  if (!input.live) {
    return {
      phase: "offline",
      label: "设备离线",
      // Never keep the last frame here: a picture from a device that is no
      // longer reporting is indistinguishable from a live one on screen.
      notice: "时钟没有在跑 ZOS 固件，或者已经掉线。这里不是实时画面。",
      showsFrame: false,
    };
  }
  if (input.frameReceivedAt === null) {
    return {
      phase: "waiting",
      label: "等待画面",
      notice: "已在向设备申请镜像；固件下次拉取状态时开始回传。",
      showsFrame: false,
    };
  }
  // The service's own measurement when it offers one; the subtraction is the
  // fallback for an older service, and is the thing that goes wrong when the
  // browser's clock disagrees with the host's.
  const ageMs = input.frameAgeMs !== undefined
    ? Math.max(0, input.frameAgeMs)
    : Math.max(0, input.now - input.frameReceivedAt);
  if (ageMs > ZOS_MIRROR_STALE_MS) {
    return {
      phase: "stale",
      label: "画面已停更",
      notice: `最后一帧是 ${Math.round(ageMs / 1000)} 秒前收到的，可能已经不是设备当前的画面。`,
      showsFrame: true,
    };
  }
  return { phase: "live", label: "实时同步中", notice: null, showsFrame: true };
}

// --- Remote input -----------------------------------------------------------
//
// The device has one knob and three buttons, and every screen the firmware has
// is reachable through them — so the console reproduces exactly those six
// injectable events instead of growing a per-screen remote API. POST /api/os/input queues
// the event at the service; the firmware injects it on its next pull. The seq
// in the response is the only receipt that exists today: the console may say
// "queued #N" and let the mirror show whether the panel actually moved.

export type ZosInputAction = "cw" | "ccw" | "press" | "hold" | "left" | "right";

export interface ZosInputEvent {
  seq: number;
  action: ZosInputAction;
}

/** Receipt copy: what the user just did, named the way the hardware names it. */
export const ZOS_INPUT_LABELS: Record<ZosInputAction, string> = {
  cw: "旋钮右旋",
  ccw: "旋钮左旋",
  press: "按下确认",
  hold: "长按返回",
  left: "左键",
  right: "右键",
};

/**
 * Mirror of HOLD_MS in osLogic.cc. The console's center button must feel like
 * the hardware's: the same 600 ms threshold, and hold fires the moment the
 * threshold passes rather than on release — waiting for the release is what
 * makes a long press feel laggy, on the device and here alike.
 */
export const ZOS_HOLD_MS = 600;

export interface ZosPressTracker {
  down(nowMs: number): void;
  /**
   * Poll while held (rAF cadence). Returns "hold" exactly once when the
   * threshold passes — the firmware fires from the tick that crosses it.
   */
  tick(nowMs: number): ZosInputAction | null;
  /**
   * Release. "press" before the threshold; "hold" when the threshold passed
   * without a tick having fired (a background tab throttles rAF, and the user
   * who held past 600 ms meant BACK regardless of our frame rate); null when
   * the hold already fired — one gesture must never emit both meanings.
   */
  up(nowMs: number): ZosInputAction | null;
  /** Pointer left / capture lost: forget the press without emitting anything. */
  cancel(): void;
  /** 0..1 toward the hold threshold; 1 once fired, 0 when idle. */
  progress(nowMs: number): number;
  isDown(): boolean;
}

export function createPressTracker(holdMs = ZOS_HOLD_MS): ZosPressTracker {
  let downAt: number | null = null;
  let fired = false;
  return {
    down(nowMs) {
      downAt = nowMs;
      fired = false;
    },
    tick(nowMs) {
      if (downAt === null || fired) return null;
      if (nowMs - downAt < holdMs) return null;
      fired = true;
      return "hold";
    },
    up(nowMs) {
      if (downAt === null) return null;
      const heldMs = nowMs - downAt;
      const alreadyFired = fired;
      downAt = null;
      fired = false;
      if (alreadyFired) return null;
      return heldMs >= holdMs ? "hold" : "press";
    },
    cancel() {
      downAt = null;
      fired = false;
    },
    progress(nowMs) {
      if (fired) return 1;
      if (downAt === null) return 0;
      return Math.max(0, Math.min(1, (nowMs - downAt) / holdMs));
    },
    isDown() {
      return downAt !== null;
    },
  };
}

/**
 * One knob detent = 24° of dial, 15 detents per revolution — the coarse,
 * positive click spacing of the hardware encoder rather than a smooth axis.
 * The same accumulator serves pointer-drag degrees and wheel pixels; only the
 * threshold differs.
 */
export const ZOS_KNOB_DETENT_DEG = 24;

/** Wheel travel per detent. One notch of a mouse wheel (~100px) is one detent. */
export const ZOS_WHEEL_DETENT_PX = 100;

/**
 * Pointer position → dial angle in degrees, 0° at 12 o'clock, clockwise
 * positive, range (-180, 180]. atan2 of (dx, -dy) rather than the usual
 * (dy, dx) puts zero at the top, which is where the knob's marker sits.
 */
export function pointerAngleDeg(centerX: number, centerY: number, x: number, y: number): number {
  return (Math.atan2(x - centerX, -(y - centerY)) * 180) / Math.PI;
}

/**
 * Shortest signed rotation from one angle to another, normalized to
 * [-180, 180). A drag crossing the ±180° seam must read as a small step in the
 * direction of travel, not a near-full spin the other way.
 */
export function angleDeltaDeg(fromDeg: number, toDeg: number): number {
  let delta = (toDeg - fromDeg) % 360;
  if (delta >= 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

/**
 * Fold continuous travel into whole detents plus a carried remainder.
 * `steps` is signed (positive = cw); the carry keeps sub-detent travel so a
 * slow drag still clicks over eventually instead of being rounded away.
 */
export function accumulateDetents(
  carry: number,
  delta: number,
  detent = ZOS_KNOB_DETENT_DEG,
): { steps: number; carry: number } {
  const total = carry + delta;
  const steps = Math.trunc(total / detent);
  return { steps, carry: total - steps * detent };
}

/**
 * Keyboard → device input. Arrows are the knob (auto-repeat allowed: a held
 * arrow is a steadily turning knob), Enter/Space the middle button, Backspace
 * and Escape the hold-for-back, A/D the side buttons. Press and hold suppress
 * auto-repeat — the hardware cannot emit five confirms from one finger, so
 * neither may the keyboard.
 */
export function zosInputForKey(key: string, repeat = false): ZosInputAction | null {
  switch (key) {
    case "ArrowRight":
      return "cw";
    case "ArrowLeft":
      return "ccw";
    case "Enter":
    case " ":
      return repeat ? null : "press";
    case "Backspace":
    case "Escape":
      return repeat ? null : "hold";
    case "a":
    case "A":
      return "left";
    case "d":
    case "D":
      return "right";
    default:
      return null;
  }
}

/**
 * Whether the focused element owns this key, so the global remote must stand
 * down. Editables own everything; a focused button owns its activation keys
 * (its native click already routes through the same send path — a global
 * handler would double-fire); a slider owns the arrows it steps by.
 */
export function zosKeyCaptured(
  key: string,
  target: { editable: boolean; button: boolean; slider: boolean },
): boolean {
  if (target.editable) return true;
  if (target.button && (key === "Enter" || key === " ")) return true;
  if (target.slider && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) {
    return true;
  }
  return false;
}

/**
 * The screens a menu entry can legitimately be showing, as the firmware names
 * them in its telemetry (`osLogic.cc`, screenName block).
 *
 * Measured on the device at 192.168.8.108: pinning `music` / `game` / `settings`
 * moved `telemetry.screen` to `music` / `games` / `settings`, and pinning a
 * channel moved it to `channel`.
 */
const KIND_SCREENS: Record<ZosMenuEntry["kind"], readonly string[]> = {
  channel: ["channel"],
  music: ["music"],
  game: ["games", "game"],
  settings: ["settings"],
};

/**
 * Whether the device's last report says this menu entry is what is on the panel.
 *
 * `telemetry.focus` is the *channel ring's* current app and keeps its value
 * while another screen is on top — pinned to 音乐, the device reported
 * `screen: "music"` with `focus: "btc"` throughout. So only a channel row may be
 * matched by focus, and it must also be the screen on top; the other three kinds
 * are matched by screen name alone, because no field ever names them in `focus`.
 * Matching every kind on `focus` (what the panel used to do) meant 音乐/游戏/设置
 * could never be confirmed, no matter what the device did.
 */
export function entryOnScreen(entry: ZosMenuEntry, telemetry: ZosTelemetry | null): boolean {
  if (!telemetry) return false;
  if (!KIND_SCREENS[entry.kind].includes(telemetry.screen)) return false;
  return entry.kind !== "channel" || telemetry.focus === entry.id;
}

/**
 * The device's own music page, as a focus command names it.
 *
 * Not a channel — the ZOS menu carries it as a `music`-kind entry. The firmware
 * used to ignore any focus that was not a channel id, which is why the console
 * shipped a dead chip here; it now honours this one. Measured at
 * 192.168.8.108: `{"focus":"music","pinned":true}` moved `telemetry.screen` to
 * "music" (and `settings` to "settings") within one 10s heartbeat.
 */
export const ZOS_MUSIC_FOCUS = "music";

/** The device's settings page, same non-channel focus family as above. */
export const ZOS_SETTINGS_FOCUS = "settings";

/**
 * One arcade game on the device: `game:<engineId>`.
 *
 * Plain `game` only pushes the games ring (measured: `telemetry.screen` →
 * "games"); the suffix also selects that card and enters the engine. The id is
 * the firmware engine's own `id()` string, which is the same seven-value set as
 * `GameEngine["meta"]["id"]` on this side — that shared vocabulary is the whole
 * reason a console-side pick can name a device-side game.
 */
export function zosGameFocus(engineId: string): string {
  return `game:${engineId}`;
}

/** Whether the console's last accepted command pinned the device on `focus`. */
export function zosPinnedOn(display: ZosDisplay | null, focus: string): boolean {
  return display?.pinned === true && display.focus === focus;
}

/**
 * What a second press on the same target means.
 *
 * Pinning locks the console's choice — the knob stops switching — so the button
 * that took the knob has to be the way back, or the only release left is the
 * 系统 panel the user may never open.
 */
export function zosToggleFocus(display: ZosDisplay | null, focus: string): string | null {
  return zosPinnedOn(display, focus) ? null : focus;
}

export function formatUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export interface ZosReadoutRow {
  key: string;
  label: string;
  value: string;
  /** Extra sentence for rows whose number means more than the number. */
  note?: string;
}

export interface ZosBatteryStatus {
  /** e.g. "82%"; the raw -1 sentinel never reaches here. */
  label: string;
  charging: boolean;
  tone: "ok" | "low" | "critical";
}

/**
 * Battery, or nothing. -1 means the device has no reading yet, and an absent
 * field means an older service — both must render as nothing at all, never as
 * 0%: a wrong battery number reads as "grab the charger" or "all fine", and
 * either can be the opposite of the truth.
 */
export function describeBattery(percent?: number, charging?: boolean): ZosBatteryStatus | null {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return null;
  const clamped = Math.min(100, Math.round(percent));
  return {
    label: `${clamped}%`,
    charging: charging === true,
    tone: clamped <= 15 ? "critical" : clamped <= 40 ? "low" : "ok",
  };
}

/**
 * The glanceable facts: battery, Wi-Fi, uptime. These are what a person looks
 * up in passing, so they live right under the mirror as a strip rather than in
 * a table. Offline means every field is null — the strip shows nothing rather
 * than the last numbers the device happened to send.
 */
export interface ZosVitals {
  battery: ZosBatteryStatus | null;
  wifi: string | null;
  uptime: string | null;
}

export function describeVitals(state: ZosState | null): ZosVitals {
  const telemetry = state?.live === true ? state.telemetry : null;
  if (!telemetry) return { battery: null, wifi: null, uptime: null };
  return {
    battery: describeBattery(telemetry.batteryPercent, telemetry.charging),
    wifi: telemetry.wifi || null,
    uptime: formatUptime(telemetry.uptimeMs),
  };
}

/**
 * What a power cycle restores. Only the device can answer, and the answer is
 * sticky on the service (`zosFlashed`) because it outlives the report: telling
 * a user "power-cycle brings back the stock firmware" while ZOS is in flash is
 * the failure that matters, and it is exactly what falling back to the live
 * telemetry would do the moment the device stops reporting.
 */
export function describeResidency(state: ZosState | null): ZosReadoutRow {
  if (state?.zosFlashed === true) {
    return { key: "residency", label: "固件驻留", value: "已刷入闪存", note: "断电重启后仍是 ZOS。" };
  }
  if (state?.live === true && state.telemetry) {
    return { key: "residency", label: "固件驻留", value: "临时侧载", note: "断电重启会回到原厂固件。" };
  }
  return { key: "residency", label: "固件驻留", value: "未知" };
}

/**
 * The diagnostics block, resolved to text — the facts you only read while
 * something is wrong. Battery / Wi-Fi / uptime live in the status strip, and
 * what the device is showing is the mirror's job: a screen name here would be
 * the same fact twice, in the firmware's vocabulary instead of the picture.
 *
 * Offline means offline: every field collapses to 离线 rather than showing the
 * last numbers the device happened to send, because a stale IP and uptime read
 * exactly like current ones. `live` is the service's verdict on report age —
 * the console must not re-derive it from `receivedAt` against a browser clock
 * that is not the service's clock.
 */
export function describeTelemetry(state: ZosState | null, now: number): ZosReadoutRow[] {
  const telemetry = state?.live === true ? state.telemetry : null;
  const offline = (key: string, label: string): ZosReadoutRow => ({ key, label, value: "离线" });
  if (!telemetry) {
    return [
      offline("ip", "IP 地址"),
      offline("free", "空闲内存"),
      offline("supplicant", "Wi-Fi 重连"),
      offline("heartbeat", "最近心跳"),
    ];
  }
  const heartbeatAgeMs = telemetry.ageMs !== undefined
    ? Math.max(0, telemetry.ageMs)
    : Math.max(0, now - telemetry.receivedAt);
  return [
    { key: "ip", label: "IP 地址", value: telemetry.ip || "—" },
    { key: "free", label: "空闲内存", value: `${telemetry.freeKb} KB` },
    {
      key: "supplicant",
      label: "Wi-Fi 重连",
      value: `${telemetry.supplicantRestarts} 次`,
      // Zero needs no note: the count already says it, and the reason it is
      // zero — the firmware adopted the link rather than restarting
      // wpa_supplicant — is our implementation, not the user's business. A
      // non-zero count does earn one, because it is the only warning they get
      // that the stored Wi-Fi credentials may have been rewritten.
      note: telemetry.supplicantRestarts === 0
        ? undefined
        : "无线链路重启过，建议确认 Wi-Fi 设置仍然正确",
    },
    { key: "heartbeat", label: "最近心跳", value: `${Math.round(heartbeatAgeMs / 1000)} 秒前` },
  ];
}

// Volume and brightness are write-only on purpose: a sequence number lets the
// device's own knob and side buttons win, and the price of that is that the
// console cannot read the current value back. So these are not readouts with a
// missing number — they are controls, and the only honest thing to report is
// what this console has sent.
export const ZOS_VOLUME_MIN = 0;
export const ZOS_VOLUME_MAX = 6;
export const ZOS_BRIGHTNESS_MIN = 1;
export const ZOS_BRIGHTNESS_MAX = 10;
/** Where the steppers start before anything has been sent — mid-scale, so the
 * first press is a nudge in a direction rather than a jump to an extreme. */
export const ZOS_VOLUME_START = 3;
export const ZOS_BRIGHTNESS_START = 5;

/**
 * The device's own volume scale is 0..6 notches; 0 is genuinely mute, not
 * merely quiet, so it gets the word rather than a number.
 */
export function volumeText(level: number | null): string {
  if (level === null) return "未下发";
  return level === 0 ? "静音" : `${level} 级`;
}

/** Brightness is 1..10 — the firmware never lets the panel go fully dark. */
export function brightnessText(level: number | null): string {
  return level === null ? "未下发" : `${level} / ${ZOS_BRIGHTNESS_MAX}`;
}

/**
 * Quick-launch labels for `game:<id>` focus targets. The ids are the firmware
 * engines' own id() strings, duplicated here on purpose (same reasoning as the
 * test suite): importing GAME_REGISTRY would let a console-side rename sail
 * through while the firmware silently ignores the new value.
 */
export const ZOS_GAME_SHORTCUTS: readonly { id: string; label: string }[] = [
  { id: "breakout", label: "打砖块" },
  { id: "flappy", label: "像素小鸟" },
  { id: "snake", label: "贪吃蛇" },
  { id: "pong", label: "Pong" },
  { id: "racer", label: "赛车" },
  { id: "shooter", label: "射击" },
  { id: "tetris", label: "俄罗斯方块" },
];

/**
 * The engine behind a `game:<id>` focus, if it is one.
 *
 * These ids exist only on this side: the service's pull document lists the 游戏
 * ring and nothing under it, so a menu lookup can never name one — and telling
 * the user 「已要求设备固定在「game:snake」」 is the console reading its own wire
 * format out loud.
 */
function gameShortcut(focus: string): { id: string; label: string } | null {
  if (!focus.startsWith("game:")) return null;
  const id = focus.slice("game:".length);
  return ZOS_GAME_SHORTCUTS.find((game) => game.id === id) ?? null;
}

export interface ZosDriverStatus {
  pinned: boolean;
  label: string;
  detail: string;
}

/**
 * Who is driving the panel.
 *
 * `display` is what the console commanded and `telemetry.focus` is what the
 * device last reported — and the firmware heartbeats every 10s, so right after
 * a pin the two disagree for up to ten seconds. Reporting only one of them
 * would make the console look either broken or dishonest, so both are named.
 */
export function describeDriver(
  display: ZosDisplay,
  menu: ZosMenuEntry[],
  telemetry: ZosTelemetry | null,
  live: boolean,
): ZosDriverStatus {
  if (!display.pinned || display.focus === null) {
    return {
      pinned: false,
      label: "旋钮自由",
      detail: live
        ? "设备自己决定显示什么；点下面的频道即可接管。"
        : "设备离线；接管指令会在固件下次拉取时生效。",
    };
  }
  const entry = menu.find((candidate) => candidate.id === display.focus);
  const game = gameShortcut(display.focus);
  const name = entry?.label ?? game?.label ?? display.focus;
  // Confirmation has to read the same field the firmware moves for this kind of
  // entry — see entryOnScreen. An unknown id (menu not loaded yet) stays
  // unconfirmed rather than being guessed at.
  //
  // `game:<id>` is the one focus with no menu entry to check: the pull document
  // carries only the 游戏 ring, and the firmware reports `screen: "game"`
  // without naming the engine. Being in a game is therefore all the confirmation
  // that exists for a game pin — and since this console asked for that engine,
  // it is confirmation enough.
  const confirmed = live && (game !== null
    ? telemetry?.screen === "game"
    : entry !== undefined && entryOnScreen(entry, telemetry));
  return {
    pinned: true,
    label: "控制台接管",
    detail: confirmed
      ? `设备已锁定在「${name}」，旋钮暂时不切台。`
      : `已要求设备固定在「${name}」；等下一次心跳确认。`,
  };
}

export interface ZosLinkOptions {
  /**
   * Whether to drive the mirror loop. Default true.
   *
   * Asking for a frame IS the subscription — every GET /api/os/mirror renews a
   * 10 s streaming lease on the device — so a consumer that never paints the
   * picture must not ask for it, or it makes the firmware tee frames for nobody.
   * A state-only consumer (the settings dialog) still wants this module's
   * cadence, backoff and write semantics, which is why it is a flag here rather
   * than a second hand-rolled poll somewhere else.
   */
  mirror?: boolean;
  /** Injectable transport for tests; defaults to the page's fetch. */
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Injectable timers so the loops are drivable from a test without real time. */
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  onState?: (state: ZosState) => void;
  onStateError?: (message: string) => void;
  onFrame?: (frame: ZosMirrorFrame | null) => void;
  onMirrorError?: (message: string) => void;
}

export interface ZosLink {
  start(): void;
  stop(): void;
  /** One immediate state read, outside the loop's cadence. */
  refreshState(): Promise<void>;
  /** PUT /api/os/display. Resolves with the display the service accepted. */
  setDisplay(focus: string | null, pinned: boolean): Promise<ZosDisplay>;
  /**
   * POST /api/os/input. Resolves with the queued event — the seq is the only
   * receipt: it proves the service accepted the press, not that the device
   * performed it. The mirror is the evidence for that.
   */
  sendInput(action: ZosInputAction): Promise<ZosInputEvent>;
  /** PUT /api/os/settings. Resolves with what the service will now request. */
  setSettings(settings: { volume?: number; brightness?: number }): Promise<ZosRequestedSettings>;
}

async function describeFailure(response: Response): Promise<string> {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // A non-JSON body still leaves the HTTP status above.
  }
  return message;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

export function createZosLink(options: ZosLinkOptions = {}): ZosLink {
  const fetcher = options.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const setTimer = options.setTimer
    ?? ((callback: () => void, ms: number) => window.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: number) => window.clearTimeout(handle));
  const wantsMirror = options.mirror !== false;
  let running = false;
  // The mirror loop needs to know whether the device is live to pick its
  // cadence, and only the state loop learns that.
  let live = false;

  const readJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(path, init);
    if (!response.ok) throw new Error(await describeFailure(response));
    return await response.json() as T;
  };

  const createLoop = (intervalMs: () => number, run: () => Promise<void>) => {
    let handle: number | null = null;
    let failures = 0;
    const tick = async () => {
      handle = null;
      try {
        await run();
        failures = 0;
      } catch {
        // `run` reports through its own callback; the loop only counts.
        failures += 1;
      }
      if (!running) return;
      handle = setTimer(() => void tick(), nextPollDelayMs(intervalMs(), failures));
    };
    return {
      start: () => void tick(),
      stop: () => {
        if (handle !== null) clearTimer(handle);
        handle = null;
      },
    };
  };

  const pollState = async () => {
    try {
      const state = await readJson<ZosState>("/api/os/state");
      live = state.live === true;
      options.onState?.(state);
    } catch (error) {
      live = false;
      options.onStateError?.(errorText(error));
      throw error;
    }
  };

  const pollMirror = async () => {
    try {
      const body = await readJson<{ frame: ZosMirrorFrame | null }>("/api/os/mirror");
      options.onFrame?.(body.frame);
    } catch (error) {
      options.onMirrorError?.(errorText(error));
      throw error;
    }
  };

  const stateLoop = createLoop(() => ZOS_STATE_POLL_MS, pollState);
  const mirrorLoop = createLoop(
    () => (live ? ZOS_MIRROR_POLL_MS : ZOS_MIRROR_IDLE_POLL_MS),
    pollMirror,
  );

  return {
    start() {
      if (running) return;
      running = true;
      stateLoop.start();
      if (wantsMirror) mirrorLoop.start();
    },
    stop() {
      running = false;
      stateLoop.stop();
      mirrorLoop.stop();
    },
    async refreshState() {
      await pollState().catch(() => undefined);
    },
    async setDisplay(focus, pinned) {
      const body = await readJson<{ display: ZosDisplay }>("/api/os/display", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ focus, pinned }),
      });
      // The service echoes the sanitized command, so the console shows what the
      // firmware will actually get rather than what the click asked for.
      return body.display;
    },
    async sendInput(action) {
      const body = await readJson<{ event: ZosInputEvent }>("/api/os/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      return body.event;
    },
    async setSettings(settings) {
      // Only name the field being changed: PUT with both would overwrite the
      // one the user did not touch with whatever this tab last saw.
      const payload: { volume?: number; brightness?: number } = {};
      if (settings.volume !== undefined) payload.volume = settings.volume;
      if (settings.brightness !== undefined) payload.brightness = settings.brightness;
      const body = await readJson<{ requested: ZosRequestedSettings }>("/api/os/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return body.requested;
    },
  };
}
