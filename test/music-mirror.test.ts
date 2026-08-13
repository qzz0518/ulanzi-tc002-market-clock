import { describe, expect, test } from "bun:test";
import { mirrorFrameSchedule, renderMirrorFrames } from "../web/src/lib/music-mirror.ts";
import { lyricCells } from "../web/src/lib/lyric-cursor.ts";
import type { PixelLyricLine } from "../web/src/components/music/pixel-lyrics-preview.tsx";

const fps = (delayMs: number) => 1_000 / delayMs;

// A 52 × 16 canvas is a byte array and four methods. Stubbing it here rather
// than pulling in a DOM keeps the mirrored GIF — the thing the clock actually
// receives — under assertion instead of under a comment.
function installStubCanvas(): void {
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const width = 52;
      const height = 16;
      const rgba = new Uint8ClampedArray(width * height * 4);
      let fill = "#000000";
      const paint = (x: number, y: number, w: number, h: number) => {
        const red = Number.parseInt(fill.slice(1, 3), 16);
        const green = Number.parseInt(fill.slice(3, 5), 16);
        const blue = Number.parseInt(fill.slice(5, 7), 16);
        for (let row = y; row < y + h; row += 1) {
          for (let column = x; column < x + w; column += 1) {
            if (row < 0 || row >= height || column < 0 || column >= width) continue;
            const at = (row * width + column) * 4;
            rgba[at] = red;
            rgba[at + 1] = green;
            rgba[at + 2] = blue;
            rgba[at + 3] = 255;
          }
        }
      };
      return {
        width,
        height,
        getContext: () => ({
          imageSmoothingEnabled: true,
          get fillStyle() {
            return fill;
          },
          set fillStyle(value: string) {
            fill = value;
          },
          clearRect: (x: number, y: number, w: number, h: number) => {
            const keep = fill;
            fill = "#000000";
            paint(x, y, w, h);
            fill = keep;
          },
          fillRect: paint,
          getImageData: () => ({ data: rgba }),
        }),
      };
    },
  };
}

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

describe("mirrored lyric frames", () => {
  const TEXT = "谁说站在光里的才算英雄";
  const LINE: PixelLyricLine = {
    startMs: 110_330,
    endMs: 115_620,
    untilMs: 128_880,
    cells: lyricCells({
      startMs: 110_330,
      endMs: 115_620,
      text: TEXT,
      words: [
        [110_330, 350], [110_680, 250], [110_930, 460], [111_390, 400], [111_790, 400],
        [112_190, 400], [112_590, 640], [113_230, 380], [113_610, 390], [114_000, 340],
        [114_340, 1_280],
      ].map(([startMs, durationMs], index) => ({
        startMs: startMs!,
        endMs: startMs! + durationMs!,
        text: [...TEXT][index]!,
      })),
    }),
  };

  const render = (line: PixelLyricLine) => {
    installStubCanvas();
    return renderMirrorFrames({
      text: TEXT,
      hasLyric: true,
      line,
      mode: "ticker",
      skin: "signal",
      trackProgress: 0.4,
      playing: true,
    });
  };

  test("the GIF covers the display window, not the singing", () => {
    // The device loops the bundle until a new one arrives, so its length has to
    // be the time the line owns the panel. Cut to the 5.29 s of singing, the
    // whole karaoke wipe would replay three times over the 13.26 s instrumental
    // — the reported defect again, only faster.
    const frames = render(LINE);
    const totalMs = frames.reduce((sum, frame) => sum + frame.delayMs, 0);
    expect(totalMs).toBeGreaterThanOrEqual(18_000);
    expect(totalMs).toBeLessThanOrEqual(19_000);
  });

  test("the wipe finishes with the singer and the rest of the loop holds still", () => {
    const frames = render(LINE);
    const delayMs = frames[0]!.delayMs;
    // 115620 − 110330 = 5290 ms of singing.
    const sungFrames = Math.ceil((115_620 - 110_330) / delayMs);
    const tail = frames.slice(sungFrames + 1);
    expect(tail.length).toBeGreaterThan(100);
    for (const frame of tail) {
      expect(frame.pixels).toBe(tail[0]!.pixels);
    }
    // And it really did animate before that, so this is not a blank GIF.
    expect(new Set(frames.slice(0, sungFrames).map((frame) => frame.pixels)).size)
      .toBeGreaterThan(3);
  });

  test("a line-level-only line still wipes across its whole window", () => {
    // No cells: the untimed path, which is the entire Spotify catalogue. Here
    // the sung end IS the window, and the sweep must reach the last glyph.
    const frames = render({ startMs: 0, endMs: 4_000, untilMs: 4_000 });
    expect(frames.at(-1)!.pixels).not.toBe(frames[0]!.pixels);
    expect(new Set(frames.map((frame) => frame.pixels)).size).toBeGreaterThan(5);
  });
});
