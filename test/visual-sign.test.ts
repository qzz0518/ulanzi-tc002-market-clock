import { describe, expect, test } from "bun:test";
import {
  paginateSignText,
  renderSign,
  SIGN_PALETTES,
  signPages,
} from "../src/visual/sign.ts";
import { cjkTextWidth } from "../src/pixel-cjk.ts";
import {
  CONDENSED_FULL_CELL,
  CONDENSED_INK_WIDTH,
  condensedGlyph,
  condensedTextWidth,
} from "../src/visual/condensed-glyphs.ts";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, type PixelCanvas, type Rgb } from "../src/pixel-ui.ts";
import { glyphRows } from "../web/src/lib/pixel-glyphs.ts";

const GREEN = SIGN_PALETTES.green.field;
const INK: Rgb = [0, 0, 0];

function samePixel(actual: Rgb, expected: Rgb): boolean {
  return actual[0] === expected[0] && actual[1] === expected[1] && actual[2] === expected[2];
}

function isInk(frame: PixelCanvas, x: number, y: number): boolean {
  return samePixel(frame.getPixel(x, y), INK);
}

function columnHasInk(frame: PixelCanvas, x: number): boolean {
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) if (isInk(frame, x, y)) return true;
  return false;
}

describe("sign pagination", () => {
  test("five hanzi now hold one screen by switching to the condensed face", () => {
    // The arithmetic that used to force paging: 5 x 12px = 60px on a 52px
    // panel. The condensed face is 10px per cell, so 5 x 10 = 50px fits.
    expect(cjkTextWidth("被迫营业中")).toBe(60);
    expect(condensedTextWidth("被迫营业中")).toBe(50);
    const pages = signPages("被迫营业中");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toBe("被迫营业中");
    expect(pages[0]!.condensed).toBe(true);
  });

  test("all five of the phrases the user typed land on one screen", () => {
    for (const phrase of ["被迫营业中", "请勿打扰", "会议中勿扰", "摸鱼进行中", "今日已下班"]) {
      expect(paginateSignText(phrase)).toEqual([phrase]);
    }
  });

  test("a page that already fits keeps the full 12px face", () => {
    // Condensing what fits only costs strokes for nothing.
    for (const phrase of ["请勿打扰", "摸鱼中", "OPEN", "摸鱼ing"]) {
      const [page] = signPages(phrase);
      expect(page!.text).toBe(phrase);
      expect(page!.condensed).toBe(false);
    }
  });

  test("six hanzi are still one character too many and split", () => {
    expect(condensedTextWidth("今天不想上班")).toBe(60);
    expect(paginateSignText("今天不想上班")).toEqual(["今天不", "想上班"]);
  });

  test("ten hanzi become two condensed screens instead of three full ones", () => {
    const pages = signPages("字".repeat(10));
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect([...page.text]).toHaveLength(5);
      expect(page.condensed).toBe(true);
    }
  });

  test("explicit separators still win, including the full-width slash", () => {
    expect(paginateSignText("被迫/营业中")).toEqual(["被迫", "营业中"]);
    expect(paginateSignText("被迫／营业中")).toEqual(["被迫", "营业中"]);
    expect(paginateSignText("摸鱼中/会议中")).toEqual(["摸鱼中", "会议中"]);
  });

  test("seven characters balance into 3 + 4", () => {
    expect(paginateSignText("外出中请勿打扰")).toEqual(["外出中", "请勿打扰"]);
  });

  test("blank or separator-only input falls back to the canonical phrase", () => {
    expect(paginateSignText("")).toEqual(["被迫营业中"]);
    expect(paginateSignText("  ")).toEqual(["被迫营业中"]);
    expect(paginateSignText("///")).toEqual(["被迫营业中"]);
  });

  test("input is capped at 32 characters and every page fits in its own face", () => {
    const pages = signPages("字".repeat(40));
    const total = pages.reduce((sum, page) => sum + [...page.text].length, 0);
    expect(total).toBe(32);
    for (const page of pages) {
      const width = page.condensed ? condensedTextWidth(page.text) : cjkTextWidth(page.text);
      expect(width).toBeLessThanOrEqual(DISPLAY_WIDTH);
    }
  });

  test("crowded characters are reported so the studio can warn about them", () => {
    // 删 loses seven stroke runs to the squeeze and reads close to 田.
    const [crowded] = signPages("请勿删改中");
    expect(crowded!.condensed).toBe(true);
    expect(crowded!.crowded).toEqual(["删"]);
    // A phrase of open characters squeezes cleanly and reports nothing.
    const [clean] = signPages("今日已下班");
    expect(clean!.condensed).toBe(true);
    expect(clean!.crowded).toEqual([]);
    // A full-face page is never flagged, however dense its characters.
    const [full] = signPages("删除");
    expect(full!.condensed).toBe(false);
    expect(full!.crowded).toEqual([]);
  });
});

describe("sign rendering", () => {
  test("the default phrase is now a single static frame", () => {
    const animation = renderSign(10_000);
    expect(animation.frames).toHaveLength(1);
    expect(animation.frameDelaysMs).toEqual([10_000]);
    expect(animation.label).toBe("灯牌 · 被迫营业中");
  });

  test("an explicitly split sign still pages and splits the duration evenly", () => {
    const animation = renderSign(10_000, "被迫/营业中");
    expect(animation.frames).toHaveLength(2);
    expect(animation.frameDelaysMs).toEqual([5_000, 5_000]);
  });

  test("three pages sum exactly to the duration", () => {
    const animation = renderSign(10_000, "摸鱼中/会议中/休息中");
    expect(animation.frameDelaysMs).toEqual([3_333, 3_333, 3_334]);
  });

  test("the field is edge-to-edge sign colour with black type punched out", () => {
    const [frame] = renderSign(10_000).frames;
    expect(frame!.getPixel(0, 0)).toEqual(GREEN);
    expect(frame!.getPixel(DISPLAY_WIDTH - 1, 0)).toEqual(GREEN);
    expect(frame!.getPixel(0, DISPLAY_HEIGHT - 1)).toEqual(GREEN);
    expect(frame!.getPixel(DISPLAY_WIDTH - 1, DISPLAY_HEIGHT - 1)).toEqual(GREEN);
  });

  test("中 lands bit-for-bit in the fifth condensed cell", () => {
    // Five 10px cells are 50px wide: x0 = (52-50)/2 = 1, so the cells start at
    // 1, 11, 21, 31, 41 and each inks nine columns. y = (16-12)/2 = 2.
    const [frame] = renderSign(10_000, "被迫营业中").frames;
    const rows = condensedGlyph("中".codePointAt(0)!)!.rows;
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < CONDENSED_INK_WIDTH; column += 1) {
        const lit = ((rows[row]! >> (CONDENSED_INK_WIDTH - 1 - column)) & 1) === 1;
        expect(samePixel(frame!.getPixel(41 + column, 2 + row), lit ? INK : GREEN)).toBe(true);
      }
    }
  });

  test("every one of the five cells carries ink and the kerning columns stay clear", () => {
    // This is the whole point of the 9px ink box: five characters that are
    // still five characters, not one 50px smear.
    const [frame] = renderSign(10_000, "被迫营业中").frames;
    for (const cell of [1, 11, 21, 31, 41]) {
      let inCell = 0;
      for (let column = cell; column < cell + CONDENSED_INK_WIDTH; column += 1) {
        if (columnHasInk(frame!, column)) inCell += 1;
      }
      expect(inCell).toBeGreaterThan(3);
    }
    for (const gap of [0, 10, 20, 30, 40, 50, 51]) {
      expect(columnHasInk(frame!, gap)).toBe(false);
    }
  });

  test("请 still lands bit-for-bit at the full-face origin when four fit", () => {
    // "请勿打扰" is 48px wide: x0 = (52-48)/2 = 2, cells every 12px.
    const [frame] = renderSign(10_000, "请勿打扰").frames;
    const rows = glyphRows("请".codePointAt(0)!)!;
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 12; column += 1) {
        const lit = ((rows[row]! >> (11 - column)) & 1) === 1;
        expect(samePixel(frame!.getPixel(2 + column, 2 + row), lit ? INK : GREEN)).toBe(true);
      }
    }
  });

  test("营 lands bit-for-bit at x=8 on an explicitly split three-character page", () => {
    const second = renderSign(10_000, "被迫/营业中").frames[1]!;
    const rows = glyphRows("营".codePointAt(0)!)!;
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 12; column += 1) {
        const lit = ((rows[row]! >> (11 - column)) & 1) === 1;
        expect(samePixel(second.getPixel(8 + column, 2 + row), lit ? INK : GREEN)).toBe(true);
      }
    }
    expect(second.getPixel(7, 8)).toEqual(GREEN);
  });

  test("type is vertically centred with clear 2px field margins in both faces", () => {
    for (const text of ["被迫营业中", "请勿打扰"]) {
      for (const frame of renderSign(10_000, text).frames) {
        for (const row of [0, 1, 14, 15]) {
          for (let column = 0; column < DISPLAY_WIDTH; column += 1) {
            expect(samePixel(frame.getPixel(column, row), GREEN)).toBe(true);
          }
        }
      }
    }
  });

  test("ASCII text keeps all ink inside its centred 24px block", () => {
    const [frame] = renderSign(10_000, "OPEN").frames;
    let inkCount = 0;
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        if (!isInk(frame!, x, y)) continue;
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
    // Traditional 營 is not in the 5195-glyph simplified set. Single 12px page,
    // cell at x0 = 20; box spans (21,3)-(29,12).
    const [frame] = renderSign(10_000, "營").frames;
    expect(frame!.getPixel(21, 3)).toEqual(INK);
    expect(frame!.getPixel(29, 3)).toEqual(INK);
    expect(frame!.getPixel(21, 12)).toEqual(INK);
    expect(frame!.getPixel(29, 12)).toEqual(INK);
    expect(frame!.getPixel(25, 7)).toEqual(GREEN);
    expect(frame!.getPixel(20, 2)).toEqual(GREEN);
  });

  test("tofu narrows with the cell so the condensed face keeps its kerning", () => {
    // "被迫營业中" still condenses to one screen; the missing glyph sits in the
    // third 10px cell at x = 21, so its box spans (22,3)-(28,12).
    const [frame] = renderSign(10_000, "被迫營业中").frames;
    expect(frame!.getPixel(22, 3)).toEqual(INK);
    expect(frame!.getPixel(28, 3)).toEqual(INK);
    expect(frame!.getPixel(22, 12)).toEqual(INK);
    expect(frame!.getPixel(28, 12)).toEqual(INK);
    expect(frame!.getPixel(25, 7)).toEqual(GREEN);
    // The kerning column on either side of the tofu cell stays field.
    expect(columnHasInk(frame!, 20)).toBe(false);
    expect(columnHasInk(frame!, 30)).toBe(false);
  });

  test("condensed cells advance by exactly CONDENSED_FULL_CELL", () => {
    expect(CONDENSED_FULL_CELL).toBe(10);
    const [frame] = renderSign(10_000, "日日日日日").frames;
    // 日 condenses losslessly, so each cell must show the same nine columns
    // ten pixels apart.
    for (const cell of [1, 11, 21, 31, 41]) {
      expect(isInk(frame!, cell, 3)).toBe(true);
      expect(isInk(frame!, cell + CONDENSED_INK_WIDTH - 1, 3)).toBe(true);
    }
  });

  test("palette selects the field colour and unknown ids fall back to green", () => {
    const red = renderSign(10_000, "休息中", "red").frames[0]!;
    expect(red.getPixel(0, 0)).toEqual(SIGN_PALETTES.red.field);
    const fallback = renderSign(10_000, "休息中", "hotpink").frames[0]!;
    expect(fallback.getPixel(0, 0)).toEqual(GREEN);
  });
});
