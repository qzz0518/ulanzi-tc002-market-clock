import type { ZosSleepReport } from "@/lib/zos-link";

/**
 * The console face of 夜间息屏.
 *
 * Unlike volume and brightness, sleep IS read back: the firmware carries its
 * whole config in every telemetry report, so this panel shows device truth and
 * edits it — no 未下发 language needed. The knob can still change everything on
 * the device side; the report brings that back within a heartbeat, which is why
 * the pending overlay below retires against the report instead of on a timer.
 */

/** Minutes-since-midnight rendered the way the device's own row renders it. */
export function sleepMinuteLabel(minute: number): string {
  const clamped = ((Math.round(minute) % 1440) + 1440) % 1440;
  const hours = String(Math.floor(clamped / 60)).padStart(2, "0");
  const minutes = String(clamped % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Half-hour steps, the resolution a bedtime is actually chosen at. The wire
 * takes any minute, so a value set elsewhere (the knob's presets, an older
 * console) may fall between steps — the select must carry it rather than snap
 * it, or opening this dialog would silently edit the device.
 */
export const SLEEP_WINDOW_MINUTES: readonly number[] = Array.from(
  { length: 48 },
  (_, index) => index * 30,
);

/** startMin === endMin is the whole day by protocol — see the firmware note. */
export function sleepWindowIsAllDay(startMin: number, endMin: number): boolean {
  return startMin === endMin;
}

export interface SleepIdleOption {
  seconds: number;
  label: string;
}

/** The device row cycles these same magnitudes; 30s..2h is the wire's range. */
export const SLEEP_IDLE_OPTIONS: readonly SleepIdleOption[] = [
  { seconds: 30, label: "30 秒" },
  { seconds: 60, label: "1 分钟" },
  { seconds: 120, label: "2 分钟" },
  { seconds: 300, label: "5 分钟" },
  { seconds: 600, label: "10 分钟" },
  { seconds: 1200, label: "20 分钟" },
  { seconds: 1800, label: "30 分钟" },
  { seconds: 3600, label: "1 小时" },
  { seconds: 7200, label: "2 小时" },
];

export function sleepIdleLabel(seconds: number): string {
  const preset = SLEEP_IDLE_OPTIONS.find((option) => option.seconds === seconds);
  if (preset) return preset.label;
  // A knob- or API-set value between presets still has to be said honestly.
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

/**
 * The one status sentence under the controls. Priority order is what a person
 * needs first: an unsynced clock explains why nothing will happen, 已息屏 is
 * live state worth knowing, and only then the summary of what is configured.
 */
export function describeSleepStatus(sleep: ZosSleepReport | null, live: boolean): string {
  if (!live || sleep === null) {
    return "时钟掉线中，下面显示的是它最后上报的配置；改动会在它回来后生效。";
  }
  if (sleep.on && !sleep.clockSynced) {
    return "时钟还没对上网络时间，在对时成功前不会息屏——避免按错误的时间黑屏。";
  }
  if (sleep.asleep) return "屏幕现在处于息屏状态，转一下旋钮或任何操作都会点亮。";
  if (!sleep.on) return "已关闭。时段和等待时间会保留，打开即恢复。";
  if (sleepWindowIsAllDay(sleep.startMin, sleep.endMin)) {
    return `全天生效：无操作 ${sleepIdleLabel(sleep.idleSec)} 后息屏。`;
  }
  return `${sleepMinuteLabel(sleep.startMin)} – ${sleepMinuteLabel(sleep.endMin)} 内，` +
    `无操作 ${sleepIdleLabel(sleep.idleSec)} 后息屏。`;
}

/** A partial edit; only named fields travel, matching PUT /api/os/sleep. */
export interface SleepPatch {
  enabled?: boolean;
  startMin?: number;
  endMin?: number;
  idleSec?: number;
}

/**
 * Merge the pending overlay onto the report, and drop the parts of the overlay
 * the report now agrees with.
 *
 * The round trip is slow on purpose — the device applies on its next poll and
 * the report follows a heartbeat later — so an edit must stay visible in the
 * controls for those seconds. But a pending value that never retired would pin
 * the UI forever, hiding a knob change the device is faithfully reporting. The
 * report is the arbiter: agreement retires the override, field by field.
 */
export function reconcileSleepPending(
  pending: SleepPatch,
  sleep: ZosSleepReport | null,
): SleepPatch {
  if (sleep === null) return pending;
  const next: SleepPatch = { ...pending };
  if (next.enabled !== undefined && next.enabled === sleep.on) delete next.enabled;
  if (next.startMin !== undefined && next.startMin === sleep.startMin) delete next.startMin;
  if (next.endMin !== undefined && next.endMin === sleep.endMin) delete next.endMin;
  if (next.idleSec !== undefined && next.idleSec === sleep.idleSec) delete next.idleSec;
  return next;
}

/** What the controls should show: the overlay where it exists, else the report. */
export function effectiveSleepView(
  pending: SleepPatch,
  sleep: ZosSleepReport | null,
): { enabled: boolean; startMin: number; endMin: number; idleSec: number } {
  return {
    enabled: pending.enabled ?? sleep?.on ?? false,
    // The firmware's own defaults, so a device that has never reported still
    // opens on the same numbers its 设置 row would show.
    startMin: pending.startMin ?? sleep?.startMin ?? 1380,
    endMin: pending.endMin ?? sleep?.endMin ?? 420,
    idleSec: pending.idleSec ?? sleep?.idleSec ?? 300,
  };
}
