import { describe, expect, test } from "bun:test";
import { mirrorFrameSchedule } from "../web/src/lib/music-mirror.ts";

const fps = (delayMs: number) => 1_000 / delayMs;

describe("music mirror frame schedule", () => {
  test("runs a normal lyric line at the 33fps baseline", () => {
    // 4 秒是最常见的一句：60 帧封顶的旧实现只有 67ms/帧，现在跑满 30ms。
    expect(mirrorFrameSchedule(4_000)).toEqual({ frameCount: 133, delayMs: 30 });
    expect(fps(mirrorFrameSchedule(4_000).delayMs)).toBeCloseTo(33.3, 1);
  });

  test("spends extra frames only where the motion is per-pixel", () => {
    // 聚光模式逐像素扫字：一句 4 秒、文字 240 像素宽，就要 240 个不同位置，
    // 基线的 133 帧不够——升到 50fps。
    expect(mirrorFrameSchedule(4_000, 240)).toEqual({ frameCount: 200, delayMs: 20 });

    // 同样是聚光，文字只有 96 像素宽时基线已经够用，不多花帧。
    expect(mirrorFrameSchedule(4_000, 96)).toEqual({ frameCount: 133, delayMs: 30 });

    // 50fps 是实用上限：面板能到 100fps，但画面没有那么多状态可放。
    expect(mirrorFrameSchedule(4_000, 4_000).delayMs).toBe(20);
  });

  test("keeps long lines well above the device's own 16.7fps", () => {
    // 旧实现在这两档分别掉到 7.5fps 和 5fps——正是同屏「卡」的来源。
    const eightSeconds = mirrorFrameSchedule(8_000);
    expect(fps(eightSeconds.delayMs)).toBeCloseTo(33.3, 1);

    // 12 秒仍在 400 帧的预算内，基线帧率不用退让。
    const twelveSeconds = mirrorFrameSchedule(12_000);
    expect(twelveSeconds).toEqual({ frameCount: 400, delayMs: 30 });

    // 更长的句子才开始退档——退的是间隔，不是覆盖范围。
    const twentySeconds = mirrorFrameSchedule(20_000);
    expect(fps(twentySeconds.delayMs)).toBe(20);
    expect(twentySeconds.frameCount * twentySeconds.delayMs).toBe(20_000);
  });

  test("quantizes every delay to the 10ms GIF grid", () => {
    for (let durationMs = 800; durationMs <= 60_000; durationMs += 137) {
      const { delayMs } = mirrorFrameSchedule(durationMs);
      expect(delayMs % 10).toBe(0);
      expect(delayMs).toBeGreaterThanOrEqual(20);
    }
  });

  test("never exceeds the 400-frame cap the API accepts", () => {
    for (const durationMs of [800, 2_000, 4_000, 7_500, 8_000, 20_000, 60_000]) {
      const { frameCount } = mirrorFrameSchedule(durationMs);
      expect(frameCount).toBeGreaterThanOrEqual(2);
      expect(frameCount).toBeLessThanOrEqual(400);
    }
  });

  test("covers the whole line so the GIF never restarts mid-sentence", () => {
    for (let durationMs = 1_000; durationMs <= 60_000; durationMs += 251) {
      const { frameCount, delayMs } = mirrorFrameSchedule(durationMs);
      // 半帧以内的欠缺算齐（frameCount 是四舍五入的结果）。
      expect(frameCount * delayMs).toBeGreaterThanOrEqual(durationMs - delayMs / 2);
    }
  });

  test("clamps absurd durations instead of throwing", () => {
    expect(mirrorFrameSchedule(0).frameCount).toBeGreaterThan(1);
    expect(mirrorFrameSchedule(Number.NaN).frameCount).toBeGreaterThan(1);
    expect(mirrorFrameSchedule(10_000_000).frameCount).toBeLessThanOrEqual(400);
  });
});
