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
  receivedAt: number;
  /** Report age per the service's clock; see ZosMirrorFrame.ageMs. */
  ageMs?: number;
}

export interface ZosState {
  seq: number;
  menu: ZosMenuEntry[];
  display: ZosDisplay;
  telemetry: ZosTelemetry | null;
  /** Server-side liveness verdict. Trust this over any local clock arithmetic. */
  live: boolean;
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

const SCREEN_LABELS: Record<string, string> = {
  launcher: "启动器",
  channel: "频道",
  music: "音乐",
  // The firmware reports the game list and a running game as two screens; both
  // are reachable from the one 游戏 menu entry, and the readout says which.
  games: "游戏列表",
  game: "游戏中",
  settings: "设置",
  boot: "开机中",
};

export function screenLabel(screen: string): string {
  return SCREEN_LABELS[screen] ?? (screen || "—");
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

/**
 * The telemetry block, resolved to text.
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
      offline("screen", "当前界面"),
      offline("focus", "设备焦点"),
      offline("wifi", "Wi-Fi"),
      offline("ip", "IP 地址"),
      offline("uptime", "运行时长"),
      offline("free", "空闲内存"),
      offline("supplicant", "Wi-Fi 重连"),
      offline("heartbeat", "最近心跳"),
    ];
  }
  const heartbeatAgeMs = telemetry.ageMs !== undefined
    ? Math.max(0, telemetry.ageMs)
    : Math.max(0, now - telemetry.receivedAt);
  return [
    { key: "screen", label: "当前界面", value: screenLabel(telemetry.screen) },
    { key: "focus", label: "设备焦点", value: telemetry.focus || "—" },
    { key: "wifi", label: "Wi-Fi", value: telemetry.wifi || "—" },
    { key: "ip", label: "IP 地址", value: telemetry.ip || "—" },
    { key: "uptime", label: "运行时长", value: formatUptime(telemetry.uptimeMs) },
    { key: "free", label: "空闲内存", value: `${telemetry.freeKb} KB` },
    {
      key: "supplicant",
      label: "Wi-Fi 重连",
      value: `${telemetry.supplicantRestarts} 次`,
      // Zero is the interesting value: it means the firmware adopted the link
      // the official app had already brought up instead of restarting
      // wpa_supplicant, which is what keeps a sideload from costing the user
      // their Wi-Fi config.
      note: telemetry.supplicantRestarts === 0
        ? "固件沿用了现有无线链路，没有重启过 supplicant"
        : "固件重启过无线链路，留意 Wi-Fi 配置是否仍然正确",
    },
    { key: "heartbeat", label: "最近心跳", value: `${Math.round(heartbeatAgeMs / 1000)} 秒前` },
  ];
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
  const name = entry?.label ?? display.focus;
  // Confirmation has to read the same field the firmware moves for this kind of
  // entry — see entryOnScreen. An unknown id (menu not loaded yet) stays
  // unconfirmed rather than being guessed at.
  const confirmed = live && entry !== undefined && entryOnScreen(entry, telemetry);
  return {
    pinned: true,
    label: "控制台接管",
    detail: confirmed
      ? `设备已锁定在「${name}」，旋钮暂时不切台。`
      : `已要求设备固定在「${name}」；等下一次心跳确认。`,
  };
}

export interface ZosLinkOptions {
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
      mirrorLoop.start();
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
  };
}
