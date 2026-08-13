import { describe, expect, test } from "bun:test";
import type { ZosSleepReport } from "../web/src/lib/zos-link";
import {
  SLEEP_IDLE_OPTIONS,
  SLEEP_WINDOW_MINUTES,
  describeSleepStatus,
  effectiveSleepView,
  reconcileSleepPending,
  sleepIdleLabel,
  sleepMinuteLabel,
  sleepWindowIsAllDay,
} from "../web/src/lib/zos-sleep";

function report(overrides: Partial<ZosSleepReport> = {}): ZosSleepReport {
  return {
    on: true,
    startMin: 1380,
    endMin: 420,
    idleSec: 300,
    asleep: false,
    clockSynced: true,
    ...overrides,
  };
}

describe("夜间息屏 console helpers", () => {
  test("minutes render as the device's own HH:MM, midnight crossing included", () => {
    expect(sleepMinuteLabel(1380)).toBe("23:00");
    expect(sleepMinuteLabel(420)).toBe("07:00");
    expect(sleepMinuteLabel(0)).toBe("00:00");
    // Out-of-range input wraps instead of printing an impossible clock time.
    expect(sleepMinuteLabel(1440)).toBe("00:00");
    expect(sleepMinuteLabel(-30)).toBe("23:30");
  });

  test("the window grid is 48 half-hours and all-day is start === end", () => {
    expect(SLEEP_WINDOW_MINUTES).toHaveLength(48);
    expect(SLEEP_WINDOW_MINUTES[0]).toBe(0);
    expect(SLEEP_WINDOW_MINUTES[47]).toBe(1410);
    expect(sleepWindowIsAllDay(0, 0)).toBe(true);
    expect(sleepWindowIsAllDay(1380, 420)).toBe(false);
  });

  test("idle labels speak the preset's language, and off-preset values honestly", () => {
    for (const option of SLEEP_IDLE_OPTIONS) {
      expect(sleepIdleLabel(option.seconds)).toBe(option.label);
    }
    expect(sleepIdleLabel(420)).toBe("7 分钟");
    expect(sleepIdleLabel(90)).toBe("90 秒");
  });

  test("the status sentence puts the unsynced clock first — it explains the refusal", () => {
    // An enabled window on an unsynced clock will never fire; saying anything
    // else first would make the feature look broken while it is being careful.
    expect(describeSleepStatus(report({ clockSynced: false }), true)).toContain("对时");
    expect(describeSleepStatus(report({ asleep: true }), true)).toContain("息屏状态");
    expect(describeSleepStatus(report({ on: false }), true)).toContain("已关闭");
    expect(describeSleepStatus(report(), true)).toContain("23:00 – 07:00");
    expect(describeSleepStatus(report({ startMin: 0, endMin: 0 }), true)).toContain("全天");
    expect(describeSleepStatus(null, false)).toContain("掉线");
    // Offline outranks everything else: the report is history, not state.
    expect(describeSleepStatus(report({ asleep: true }), false)).toContain("掉线");
  });

  test("a pending edit stays until the device's report agrees, then retires", () => {
    // The round trip is slow by design (device applies on its next poll, the
    // report follows a heartbeat later); the overlay is what keeps the controls
    // from snapping back during those seconds.
    const pending = { enabled: false, idleSec: 600 };
    const before = reconcileSleepPending(pending, report());
    expect(before).toEqual({ enabled: false, idleSec: 600 });
    // The device confirms half the edit: only that half retires.
    const half = reconcileSleepPending(pending, report({ on: false }));
    expect(half).toEqual({ idleSec: 600 });
    const done = reconcileSleepPending(pending, report({ on: false, idleSec: 600 }));
    expect(done).toEqual({});
    // No report yet: nothing retires, nothing is invented.
    expect(reconcileSleepPending(pending, null)).toEqual(pending);
  });

  test("the controls show the overlay where it exists, else the report, else firmware defaults", () => {
    expect(effectiveSleepView({}, report({ idleSec: 420 })).idleSec).toBe(420);
    expect(effectiveSleepView({ idleSec: 600 }, report({ idleSec: 420 })).idleSec).toBe(600);
    // A device that has never reported opens on the firmware's own defaults, so
    // the dialog and the device's 设置 row show the same numbers.
    expect(effectiveSleepView({}, null)).toEqual({
      enabled: false,
      startMin: 1380,
      endMin: 420,
      idleSec: 300,
    });
  });
});
