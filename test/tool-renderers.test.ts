import { describe, expect, test } from "bun:test";
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  PixelCanvas,
  type Rgb,
} from "../src/pixel-ui.ts";
import { cjkTextWidth, drawCjkText } from "../src/pixel-cjk.ts";
import { FULL_WIDTH_CELL, GLYPH_HEIGHT, glyphRows } from "../web/src/lib/pixel-glyphs.ts";
import { renderCountdown, renderPomodoro, type ToolAnimation } from "../src/tool-renderers.ts";
import type { JsonValue } from "../src/workspace.ts";

const NOW = Date.parse("2026-08-10T09:36:00Z");
const WORK: Rgb = [255, 72, 48];
const BREAK: Rgb = [0, 214, 122];
// drawBigClockText centres "MM:SS" (25px) inside x=13..51, so the colon sits at x=32.
const COLON_X = 32;
const COLON_YS = [5, 9] as const;

function expectPanelContract(animation: ToolAnimation, durationMs: number): void {
  expect(animation.frames.length).toBeGreaterThan(0);
  expect(animation.frames.length).toBeLessThanOrEqual(120);
  expect(animation.frames.length).toBe(animation.frameDelaysMs.length);
  expect(animation.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(durationMs);
  expect(animation.frameDelaysMs.every((delay) => delay > 0)).toBe(true);
  for (const frame of animation.frames) {
    expect(frame.width).toBe(DISPLAY_WIDTH);
    expect(frame.height).toBe(DISPLAY_HEIGHT);
  }
}

function sameColor(left: Rgb, right: Rgb): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function countColor(frame: PixelCanvas, color: Rgb): number {
  let count = 0;
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      if (sameColor(frame.getPixel(x, y), color)) count += 1;
    }
  }
  return count;
}

/** Length of the bottom progress bar: consecutive accent pixels at y=15 from x=0. */
function barLength(frame: PixelCanvas, accent: Rgb): number {
  let length = 0;
  while (length < DISPLAY_WIDTH && sameColor(frame.getPixel(length, 15), accent)) length += 1;
  return length;
}

/** The dead frame border of the old perimeter ring must stay fully unlit. */
function expectDarkPerimeter(frame: PixelCanvas, allowedBottom: number): void {
  for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
    expect(frame.getPixel(x, 0)).toEqual([0, 0, 0]);
    if (x >= allowedBottom) expect(frame.getPixel(x, 15)).toEqual([0, 0, 0]);
  }
  for (let y = 1; y < DISPLAY_HEIGHT - 1; y += 1) {
    expect(frame.getPixel(0, y)).toEqual([0, 0, 0]);
    expect(frame.getPixel(DISPLAY_WIDTH - 1, y)).toEqual([0, 0, 0]);
  }
}

function bytes(animation: ToolAnimation): string {
  return animation.frames.map((frame) => Buffer.from(frame.pixels).toString("base64")).join("|");
}

function isUniform(frame: PixelCanvas): boolean {
  const first = frame.getPixel(0, 0);
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      if (!sameColor(frame.getPixel(x, y), first)) return false;
    }
  }
  return true;
}

describe("pomodoro", () => {
  const options = (extra: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({
    workMinutes: 25,
    breakMinutes: 5,
    running: true,
    startedAtMs: NOW,
    ...extra,
  });

  test("drains the bottom progress bar as the work slice is consumed", () => {
    const early = renderPomodoro(1_000, options({ startedAtMs: NOW - 60_000 }), NOW);
    const late = renderPomodoro(1_000, options({ startedAtMs: NOW - 24 * 60_000 }), NOW);
    expectPanelContract(early, 1_000);
    expectPanelContract(late, 1_000);
    // Bar length is the remaining fraction of the phase, rounded onto 52 columns.
    expect(barLength(early.frames[0]!, WORK)).toBe(Math.round(1_440 / 1_500 * DISPLAY_WIDTH));
    expect(barLength(late.frames[0]!, WORK)).toBe(Math.round(60 / 1_500 * DISPLAY_WIDTH));
    expect(early.label).toBe("番茄钟");
  });

  test("keeps the frame border pure black instead of a grey ring", () => {
    const animation = renderPomodoro(1_000, options({ startedAtMs: NOW - 60_000 }), NOW);
    const frame = animation.frames[0]!;
    expectDarkPerimeter(frame, barLength(frame, WORK));
    // The tomato: red body, green leaf strokes, lighter sheen.
    expect(frame.getPixel(6, 8)).toEqual(WORK);
    expect(frame.getPixel(6, 3)).toEqual([46, 180, 90]);
    expect(frame.getPixel(4, 6)).toEqual([255, 136, 120]);
    // Clipped fruit corners stay dark so the silhouette reads round.
    expect(frame.getPixel(3, 5)).toEqual([0, 0, 0]);
    expect(frame.getPixel(10, 12)).toEqual([0, 0, 0]);
  });

  test("keeps the colon lit across consecutive odd and even seconds", () => {
    const animation = renderPomodoro(4_000, options({ startedAtMs: NOW - 60_000 }), NOW);
    expect(animation.frames.length).toBeGreaterThan(8);
    for (const frame of animation.frames) {
      for (const y of COLON_YS) expect(frame.getPixel(COLON_X, y)).toEqual([255, 255, 255]);
    }
  });

  test("switches to the break accent once the work minutes are spent", () => {
    const animation = renderPomodoro(
      1_000,
      options({ startedAtMs: NOW - (25 * 60 + 60) * 1_000 }),
      NOW,
    );
    const frame = animation.frames[0]!;
    // 4 of 5 break minutes left.
    expect(barLength(frame, BREAK)).toBe(Math.round(240 / 300 * DISPLAY_WIDTH));
    expect(frame.getPixel(6, 8)).toEqual(BREAK);
    expect(countColor(frame, WORK)).toBe(0);
  });

  test("honours the three colour options", () => {
    const work = renderPomodoro(
      1_000,
      options({ startedAtMs: NOW - 60_000, workColor: "#336699", digitColor: "#ffcc00" }),
      NOW,
    ).frames[0]!;
    expect(work.getPixel(6, 8)).toEqual([51, 102, 153]);
    expect(work.getPixel(0, 15)).toEqual([51, 102, 153]);
    for (const y of COLON_YS) expect(work.getPixel(COLON_X, y)).toEqual([255, 204, 0]);

    const rest = renderPomodoro(
      1_000,
      options({ startedAtMs: NOW - (25 * 60 + 60) * 1_000, breakColor: "#8800ff" }),
      NOW,
    ).frames[0]!;
    expect(rest.getPixel(6, 8)).toEqual([136, 0, 255]);
    expect(rest.getPixel(0, 15)).toEqual([136, 0, 255]);
  });

  test("flashes the whole panel on the phase boundary", () => {
    const animation = renderPomodoro(4_000, options({ startedAtMs: NOW - 25 * 60_000 }), NOW);
    expect(isUniform(animation.frames[0]!)).toBe(true);
    // The flash carries the colour of the phase being entered, then strobes.
    expect(animation.frames[0]!.getPixel(0, 0)).toEqual(BREAK);
    expect(animation.frames[1]!.getPixel(0, 0)).toEqual([255, 255, 255]);
    // 1.2s of strobe, then the break ring comes back.
    expect(isUniform(animation.frames.at(-1)!)).toBe(false);
  });

  test("stays still and dims the whole layout to 35% while paused", () => {
    const animation = renderPomodoro(1_000, options({ running: false, startedAtMs: 0 }), NOW);
    expectPanelContract(animation, 1_000);
    const frame = animation.frames[0]!;
    // No full-brightness pixel survives the pause dim.
    expect(countColor(frame, WORK)).toBe(0);
    expect(countColor(frame, [255, 255, 255])).toBe(0);
    // Digits are dimmed digit colour, not a fixed grey swap.
    for (const y of COLON_YS) expect(frame.getPixel(COLON_X, y)).toEqual([89, 89, 89]);
    expect(frame.getPixel(6, 8)).toEqual([89, 25, 16]);
    // A paused phase is untouched, so the bar sits at full width.
    expect(barLength(frame, [89, 25, 16])).toBe(DISPLAY_WIDTH);
    expect(bytes(animation)).toBe(bytes(renderPomodoro(1_000, options({ running: false, startedAtMs: 0 }), NOW)));
    expect(animation.frames.every((candidate) => sameColor(candidate.getPixel(0, 0), frame.getPixel(0, 0)))).toBe(true);
  });

  test("survives the option boundaries", () => {
    const noBreak = renderPomodoro(
      5_000,
      { workMinutes: 1, breakMinutes: 0, running: true, startedAtMs: NOW - 61_000 },
      NOW,
    );
    expectPanelContract(noBreak, 5_000);
    expect(countColor(noBreak.frames.at(-1)!, BREAK)).toBe(0);

    const clamped = renderPomodoro(
      5_000,
      { workMinutes: 9_999, breakMinutes: -20, running: true, startedAtMs: NOW - 1_000 },
      NOW,
    );
    expectPanelContract(clamped, 5_000);

    const garbage = renderPomodoro(
      5_000,
      { workMinutes: "abc", breakMinutes: null, running: "yes", startedAtMs: "x" } as never,
      NOW,
    );
    expectPanelContract(garbage, 5_000);
  });

  test("caps a long slot at the frame budget", () => {
    const animation = renderPomodoro(120_000, options(), NOW);
    expect(animation.frames).toHaveLength(120);
    expectPanelContract(animation, 120_000);
  });
});

describe("countdown", () => {
  test("draws a short title next to the day count in one static frame", () => {
    const animation = renderCountdown(4_000, { title: "生日", targetDate: "2026-08-15" }, NOW);
    expect(animation.frames).toHaveLength(1);
    expect(animation.frameDelaysMs).toEqual([4_000]);
    expect(animation.label).toBe("倒数日 · 生日");
    expectPanelContract(animation, 4_000);
    expect(bytes(animation)).not.toBe(
      bytes(renderCountdown(4_000, { title: "生日", targetDate: "2026-08-16" }, NOW)),
    );
  });

  test("renders two full-width hanzi in clean adjacent cells", () => {
    // 5 days -> one big digit at x=33, title region x=1..30, "倒数" centred at x=4.
    const frame = renderCountdown(4_000, { title: "倒数", targetDate: "2026-08-15" }, NOW).frames[0]!;
    const cells: Array<[string, number]> = [["倒", 4], ["数", 4 + FULL_WIDTH_CELL]];
    for (const [character, cellX] of cells) {
      const rows = glyphRows(character.codePointAt(0)!)!;
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        for (let column = 0; column < FULL_WIDTH_CELL; column += 1) {
          const lit = (rows[row]! >> (FULL_WIDTH_CELL - 1 - column)) & 1;
          const [red, green, blue] = frame.getPixel(cellX + column, 2 + row);
          // Bit-exact per cell: any overlap or ghost column breaks this.
          expect(red + green + blue > 0).toBe(lit === 1);
          if (lit === 1) expect([red, green, blue]).toEqual([235, 240, 248]);
        }
      }
    }
    // The gutters around the centred title stay unlit.
    for (let y = 2; y < 2 + GLYPH_HEIGHT; y += 1) {
      for (const x of [1, 2, 3, 28, 29, 30]) expect(frame.getPixel(x, y)).toEqual([0, 0, 0]);
    }
  });

  test("scrolls an overwide title exactly one pixel per frame", () => {
    const animation = renderCountdown(
      4_000,
      { title: "距离下一次发布还有", targetDate: "2026-08-30" },
      NOW,
    );
    const titleWidth = 24; // two-digit day count -> digits at x=27, region x=1..24
    for (const step of [0, 7, 20]) {
      const current = animation.frames[step]!;
      const next = animation.frames[step + 1]!;
      for (let column = 0; column < titleWidth - 1; column += 1) {
        for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
          expect(next.getPixel(1 + column, 2 + row)).toEqual(current.getPixel(2 + column, 2 + row));
        }
      }
    }
  });

  test("colours the count and the unit from the accent option", () => {
    const frame = renderCountdown(
      4_000,
      { title: "生日", targetDate: "2026-08-15", accentColor: "#ff00aa" },
      NOW,
    ).frames[0]!;
    // Big digit "5" starts at x=33, y=3 with a full top stroke.
    expect(frame.getPixel(33, 3)).toEqual([255, 0, 170]);
    // 「天」cell x=40..51 carries the accent dimmed to 55%.
    const unit = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    drawCjkText(unit, "天", 40, 2, [140, 0, 93]);
    for (let y = 2; y < 2 + GLYPH_HEIGHT; y += 1) {
      for (let x = 40; x < DISPLAY_WIDTH; x += 1) {
        expect(frame.getPixel(x, y)).toEqual(unit.getPixel(x, y));
      }
    }
    // Elapsed days ignore the option and stay warm orange.
    const past = renderCountdown(
      4_000,
      { title: "考试", targetDate: "2026-08-09", accentColor: "#ff00aa" },
      NOW,
    ).frames[0]!;
    expect(past.getPixel(35, 3)).toEqual([255, 140, 40]);
  });

  test("counts whole local days in both directions", () => {
    const tomorrow = renderCountdown(4_000, { title: "考试", targetDate: "2026-08-11" }, NOW);
    const yesterday = renderCountdown(4_000, { title: "考试", targetDate: "2026-08-09" }, NOW);
    // Same magnitude, different accent: elapsed days must not look like remaining ones.
    expect(bytes(tomorrow)).not.toBe(bytes(yesterday));
  });

  test("plays a celebration animation on the day itself", () => {
    const animation = renderCountdown(4_000, { title: "今天", targetDate: "2026-08-10" }, NOW);
    expectPanelContract(animation, 4_000);
    expect(animation.frames.length).toBeGreaterThan(1);
    expect(bytes(animation)).toBe(
      bytes(renderCountdown(4_000, { title: "今天", targetDate: "2026-08-10" }, NOW)),
    );
    expect(Buffer.from(animation.frames[0]!.pixels).toString("base64"))
      .not.toBe(Buffer.from(animation.frames[4]!.pixels).toString("base64"));
  });

  test("scrolls a title that cannot fit beside the digits", () => {
    const animation = renderCountdown(
      4_000,
      { title: "距离下一次发布还有", targetDate: "2026-08-30" },
      NOW,
    );
    expectPanelContract(animation, 4_000);
    expect(animation.frames.length).toBeGreaterThan(1);
    expect(Buffer.from(animation.frames[0]!.pixels).toString("base64"))
      .not.toBe(Buffer.from(animation.frames.at(-1)!.pixels).toString("base64"));
  });

  test("shows a hint frame for a date the calendar does not have", () => {
    for (const targetDate of ["2026-02-30", "not-a-date", "2026-8-1", "", "20261231"]) {
      const animation = renderCountdown(4_000, { title: "生日", targetDate }, NOW);
      expect(animation.frames).toHaveLength(1);
      expect(animation.label).toBe("倒数日 · 日期无效");
      const expected = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
      drawCjkText(
        expected,
        "日期无效",
        Math.floor((DISPLAY_WIDTH - cjkTextWidth("日期无效")) / 2),
        2,
        [255, 176, 32],
      );
      expect(animation.frames[0]!.pixels).toEqual(expected.pixels);
    }
  });

  test("falls back and clips the title at the option boundaries", () => {
    expect(renderCountdown(4_000, { title: "   ", targetDate: "2026-12-25" }, NOW).label)
      .toBe("倒数日 · 倒数日");
    expect(renderCountdown(4_000, { title: 42, targetDate: "2026-12-25" } as never, NOW).label)
      .toBe("倒数日 · 倒数日");
    expect(renderCountdown(
      4_000,
      { title: "一二三四五六七八九十甲乙丙丁戊己庚辛", targetDate: "2026-12-25" },
      NOW,
    ).label).toBe("倒数日 · 一二三四五六七八九十甲乙丙丁戊己");
  });

  test("keeps a four-digit day count inside the panel", () => {
    const animation = renderCountdown(4_000, { title: "远期", targetDate: "2099-01-01" }, NOW);
    expectPanelContract(animation, 4_000);
    let rightmost = 0;
    const frame = animation.frames[0]!;
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        const [red, green, blue] = frame.getPixel(x, y);
        if (red + green + blue > 0) rightmost = Math.max(rightmost, x);
      }
    }
    expect(rightmost).toBeLessThanOrEqual(DISPLAY_WIDTH - 1);
  });
});
