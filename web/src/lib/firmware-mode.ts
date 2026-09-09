// Which firmware the clock is actually running right now, and what the console
// may honestly say about it.
//
// Pure and DOM-free on purpose (same split as zos-link.ts / live-screen.ts):
// every rule here is about evidence, and the rules are worth unit-testing
// without a browser. The component only picks icons and paints.
//
// The evidence is uneven, so the precedence is too:
//   zos      — the device itself is reporting to /api/os/state right now.
//   music    — the music sideload's own heartbeat endpoint answered recently.
//   official — nothing is reporting; the stock firmware has nothing to report.
// A live ZOS report therefore wins over a sideload guess, and "official" is
// only ever the absence of the other two, never a positive detection.
//
// The arcade sideload used to sit between music and official; it is retired
// (ADR 0014) because ZOS runs the same seven games natively.

export type FirmwareMode = "official" | "music" | "zos";

/** The slice of `GET /api/os/state`'s telemetry this module reads. */
export interface FirmwareTelemetry {
  /** 0..100, or -1 before the device has taken a reading. */
  batteryPercent?: number;
  charging?: boolean;
  /**
   * Report age per the *service's* clock. Present for reference only: `live`
   * below is the service's own verdict on that age, and re-deriving liveness in
   * the browser is the clock-skew bug this project already fixed once.
   */
  ageMs?: number;
}

/** The slice of `GET /api/os/state` this module reads. */
export interface FirmwareOsState {
  /** The service's verdict: ZOS is running and its report is fresh. */
  live: boolean;
  telemetry: FirmwareTelemetry | null;
  /**
   * ZOS lives in this clock's flash. Sticky on the service (`zosEverFlashed` in
   * src/os-link.ts): what is in flash does not change because the device went
   * quiet, so this stays true across a drop-off — unlike `live`, which is
   * exactly the report that stopped.
   */
  zosFlashed?: boolean;
}

export interface FirmwareModeInput {
  /** Latest `/api/os/state`, or null when it has not answered — or failed. */
  osState: FirmwareOsState | null;
  /** The music sideload firmware's heartbeat, as app.tsx already tracks it. */
  musicFirmwareOnline: boolean;
}

export function deriveFirmwareMode(input: FirmwareModeInput): FirmwareMode {
  if (input.osState?.live === true) return "zos";
  if (input.musicFirmwareOnline) return "music";
  return "official";
}

/** Below this, and not charging, the readout is worth flagging. */
export const LOW_BATTERY_PERCENT = 20;

export interface FirmwareBattery {
  /** 0..100, or null when there is nothing honest to show. */
  percent: number | null;
  charging: boolean;
  /** "87%" / "87% 充电中"; null whenever `percent` is null. */
  text: string | null;
  /** Running low on its own cell — false while charging, and false if unknown. */
  low: boolean;
}

const NO_BATTERY: FirmwareBattery = { percent: null, charging: false, text: null, low: false };

/**
 * The battery readout, or nothing.
 *
 * Two ways to be wrong here, and both are worse than showing nothing:
 *
 * - A last-known percentage from a device that stopped reporting looks exactly
 *   like a current one, so the number leaves with the device rather than
 *   lingering as a plausible lie.
 * - The firmware sends -1 until the MCU answers with a real reading (and an
 *   older service omits the field entirely). Rendering that as 0% would report
 *   a flat battery on a fully charged clock.
 */
export function describeBattery(osState: FirmwareOsState | null): FirmwareBattery {
  if (osState?.live !== true) return NO_BATTERY;
  const raw = osState.telemetry?.batteryPercent;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return NO_BATTERY;
  const percent = Math.min(100, Math.round(raw));
  const charging = osState.telemetry?.charging === true;
  return {
    percent,
    charging,
    text: charging ? `${percent}% 充电中` : `${percent}%`,
    low: !charging && percent <= LOW_BATTERY_PERCENT,
  };
}

export interface FirmwareStatus {
  mode: FirmwareMode;
  /** Short label for the indicator chip. */
  label: string;
  /** One honest sentence; the chip carries it as its tooltip. */
  description: string;
  battery: FirmwareBattery;
  /**
   * ZOS is in this clock's flash — a separate question from `mode`.
   *
   * `mode` is about who is reporting *now*, and it has to be: the chip, the
   * mirror and every "the device is running X" sentence would otherwise claim a
   * silent device is live. What a power cycle restores is a different fact, and
   * it survives the silence — a flashed ZOS that fell off the Wi-Fi is still a
   * ZOS clock, and the stock firmware's endpoints will answer 503 on it forever.
   */
  zosFlashed: boolean;
}

const MODE_LABELS: Record<FirmwareMode, string> = {
  official: "官方固件",
  music: "音乐固件",
  zos: "ZOS",
};

const MODE_DESCRIPTIONS: Record<FirmwareMode, string> = {
  official: "时钟运行 Ulanzi 官方固件，频道通过 Custom App 推送上屏。",
  // 侧载只在内存里，断电回到的是**闪存里那一套**——这台设备刷了 ZOS，回到的
  // 就是 ZOS 而不是官方固件。这里没有判断闪存内容的依据，所以只说确定的部分；
  // 具体是哪一套由侧载面板的 restoresTo 说（它见过 ZOS 在跑）。
  music: "侧载的音乐固件正在直连时钟；断电即恢复闪存里的固件。",
  zos: "时钟正在运行 ZOS 自制固件，并持续上报设备状态。",
};

export function firmwareModeLabel(mode: FirmwareMode): string {
  return MODE_LABELS[mode];
}

export function describeFirmware(input: FirmwareModeInput): FirmwareStatus {
  const mode = deriveFirmwareMode(input);
  const battery = describeBattery(input.osState);
  // Only ZOS reports a battery at all, so only ZOS says anything about it —
  // including saying that it has not read one yet, which is a real state on a
  // clock that just booted rather than a blank to be filled with 0%.
  const description = mode === "zos"
    ? `${MODE_DESCRIPTIONS.zos}${battery.text === null ? "电量尚未读到。" : `电量 ${battery.text}。`}`
    : MODE_DESCRIPTIONS[mode];
  return {
    mode,
    label: MODE_LABELS[mode],
    description,
    battery,
    zosFlashed: input.osState?.zosFlashed === true,
  };
}
