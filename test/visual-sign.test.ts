import { describe, expect, test } from "bun:test";
import {
  paginateSignText,
  renderSign,
  SIGN_PALETTES,
} from "../src/visual/sign.ts";
import { cjkTextWidth } from "../src/pixel-cjk.ts";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, type Rgb } from "../src/pixel-ui.ts";
import { glyphRows } from "../web/src/lib/pixel-glyphs.ts";

const GREEN = SIGN_PALETTES.green.field;
const INK: Rgb = [0, 0, 0];

function samePixel(actual: Rgb, expected: Rgb): boolean {
  return actual[0] === expected[0] && actual[1] === expected[1] && actual[2] === expected[2];
}

describe("sign pagination", () => {
  test("the canonical five-character phrase cannot fit and splits modifier-first", () => {
    // The layout fact that forces paging: five full-width cells are 60px on a
    // 52px panel, and glyph ink spans 11/12 columns so kerning cannot close it.
    expect(cjkTextWidth("被迫营业中")).toBe(60);
    expect(paginateSignText("被迫营业中")).toEqual(["被迫", "营业中"]);
    expect(paginateSignText("努力搬砖中")).toEqual(["努力", "搬砖中"]);
  });

  test("explicit separators win, including the full-width slash", () => {
    expect(paginateSignText("被迫/营业中")).toEqual(["被迫", "营业中"]);
    expect(paginateSignText("被迫／营业中")).toEqual(["被迫", "营业中"]);
    expect(paginateSignText("摸鱼中/会议中")).toEqual(["摸鱼中", "会议中"]);
  });

  test("text that fits stays one page", () => {
    expect(paginateSignText("请勿打扰")).toEqual(["请勿打扰"]);
    expect(paginateSignText("摸鱼中")).toEqual(["摸鱼中"]);
    expect(paginateSignText("OPEN")).toEqual(["OPEN"]);
    // Half-width ASCII mixes in at 6px per cell: 12 + 12 + 3*6 = 42 <= 52.
    expect(paginateSignText("摸鱼ing")).toEqual(["摸鱼ing"]);
  });

  test("seven characters balance into 3 + 4", () => {
    expect(paginateSignText("外出中请勿打扰")).toEqual(["外出中", "请勿打扰"]);
  });

  test("blank or separator-only input falls back to the canonical phrase", () => {
    expect(paginateSignText("")).toEqual(["被迫", "营业中"]);
    expect(paginateSignText("  ")).toEqual(["被迫", "营业中"]);
    expect(paginateSignText("///")).toEqual(["被迫", "营业中"]);
  });

  test("input is capped at 32 characters and every page fits the panel", () => {
    const pages = paginateSignText("字".repeat(40));
    const total = pages.reduce((sum, page) => sum + [...page].length, 0);
    expect(total).toBe(32);
    for (const page of pages) {
      expect(cjkTextWidth(page)).toBeLessThanOrEqual(DISPLAY_WIDTH);
    }
  });
});

describe("sign rendering", () => {
  test("default render is two pages splitting the duration evenly", () => {
    const animation = renderSign(10_000);
    expect(animation.frames).toHaveLength(2);
    expect(animation.frameDelaysMs).toEqual([5_000, 5_000]);
    expect(animation.label).toBe("灯牌 · 被迫/营业中");
  });

  test("a fitting phrase is one static frame holding the whole duration", () => {
    const animation = renderSign(10_000, "摸鱼中");
    expect(animation.frames).toHaveLength(1);
    expect(animation.frameDelaysMs).toEqual([10_000]);
  });

  test("three pages sum exactly to the duration", () => {
    const animation = renderSign(10_000, "摸鱼中/会议中/休息中");
    expect(animation.frameDelaysMs).toEqual([3_333, 3_333, 3_334]);
  });

  test("the field is edge-to-edge sign colour with black type punched out", () => {
    const [frame] = renderSign(10_000).frames;
    // Corners are field, not background: the lightbox reaches every edge.
    expect(frame!.getPixel(0, 0)).toEqual(GREEN);
    expect(frame!.getPixel(DISPLAY_WIDTH - 1, 0)).toEqual(GREEN);
    expect(frame!.getPixel(0, DISPLAY_HEIGHT - 1)).toEqual(GREEN);
    expect(frame!.getPixel(DISPLAY_WIDTH - 1, DISPLAY_HEIGHT - 1)).toEqual(GREEN);
  });

  test("被 lands bit-for-bit at the centred origin of page one", () => {
    // Page "被迫" is 24px wide: x0 = (52-24)/2 = 14, y = (16-12)/2 = 2.
    const [frame] = renderSign(10_000).frames;
    const rows = glyphRows("被".codePointAt(0)!)!;
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 12; column += 1) {
        const lit = ((rows[row]! >> (11 - column)) & 1) === 1;
        const pixel = frame!.getPixel(14 + column, 2 + row);
        expect(samePixel(pixel, lit ? INK : GREEN)).toBe(true);
      }
    }
  });

  test("page two centres the three-character half at x=8", () => {
    const frames = renderSign(10_000).frames;
    const second = frames[1]!;
    const rows = glyphRows("营".codePointAt(0)!)!;
    // "营业中" is 36px wide: x0 = (52-36)/2 = 8; probe the first ink pixel
    // the font actually sets (the glyph's top rows may be blank padding).
    let probed = false;
    for (let row = 0; row < 12 && !probed; row += 1) {
      for (let column = 0; column < 12 && !probed; column += 1) {
        if ((rows[row]! >> (11 - column)) & 1) {
          expect(second.getPixel(8 + column, 2 + row)).toEqual(INK);
          probed = true;
        }
      }
    }
    expect(probed).toBe(true);
    // Left of the text block the field is untouched.
    expect(second.getPixel(7, 8)).toEqual(GREEN);
  });

  test("type is vertically centred with clear 2px field margins", () => {
    for (const frame of renderSign(10_000).frames) {
      for (const row of [0, 1, 14, 15]) {
        for (let column = 0; column < DISPLAY_WIDTH; column += 1) {
          expect(samePixel(frame.getPixel(column, row), GREEN)).toBe(true);
        }
      }
    }
  });

  test("ASCII text keeps all ink inside its centred 24px block", () => {
    const [frame] = renderSign(10_000, "OPEN").frames;
    let inkCount = 0;
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        if (!samePixel(frame!.getPixel(x, y), INK)) continue;
        inkCount += 1;
        expect(x).toBeGreaterThanOrEqual(14);
        expect(x).toBeLessThanOrEqual(37);
        expect(y).toBeGreaterThanOrEqual(2);
        expect(y).toBeLessThanOrEqual(13);
      }
    }
    expect(inkCount).toBeGreaterThan(0);
  });

  test("a glyph outside the charset renders as a tofu outline, not a hole", () => {
    // Traditional 營 is not in the 5195-glyph simplified set. Single page,
    // 12px cell at x0 = 20; box spans (21,3)-(29,12).
    const [frame] = renderSign(10_000, "營").frames;
    expect(frame!.getPixel(21, 3)).toEqual(INK);
    expect(frame!.getPixel(29, 3)).toEqual(INK);
    expect(frame!.getPixel(21, 12)).toEqual(INK);
    expect(frame!.getPixel(29, 12)).toEqual(INK);
    // Box interior and the cell's lead column stay field.
    expect(frame!.getPixel(25, 7)).toEqual(GREEN);
    expect(frame!.getPixel(20, 2)).toEqual(GREEN);
  });

  test("palette selects the field colour and unknown ids fall back to green", () => {
    const red = renderSign(10_000, "休息中", "red").frames[0]!;
    expect(red.getPixel(0, 0)).toEqual(SIGN_PALETTES.red.field);
    const fallback = renderSign(10_000, "休息中", "hotpink").frames[0]!;
    expect(fallback.getPixel(0, 0)).toEqual(GREEN);
  });
});
