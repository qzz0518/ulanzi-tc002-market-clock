import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PIXEL_FONT_3X5 } from "../src/pixel-font.ts";

/**
 * The panel's numerals and the console's must be the same numerals.
 *
 * `VibeScreen.cpp` carries its own 3x5 table because ZOS's shared glyphs are
 * 12 px tall — one row on a 16 px panel, where this screen needs two. That copy
 * is transcribed from `PIXEL_FONT_3X5`, and a transcription is a chance to
 * drift: a "5" that lost a pixel would look fine in isolation and only be wrong
 * next to the console's preview of the same page. So this reads the C++ table
 * back and compares it to the TypeScript one, the same guard
 * `test/vibe-icons-parity.test.ts` puts on the marks.
 */
const SCREEN = "device/tc002-os/app/src/ui/VibeScreen.cpp";

/** Parses `{'0', {7, 5, 5, 5, 7}}` records out of the firmware table. */
function readFirmwareFont(): Record<string, number[]> {
  const text = readFileSync(SCREEN, "utf8");
  const start = text.indexOf("const TinyGlyph kTinyFont[]");
  expect(start, "the firmware table moved or was renamed").toBeGreaterThan(-1);
  const body = text.slice(start, text.indexOf("};", start));
  const table: Record<string, number[]> = {};
  for (const match of body.matchAll(/\{'(\\?.)',\s*\{([^}]*)\}\}/g)) {
    const character = match[1] === "\\'" ? "'" : match[1]!;
    table[character] = match[2]!.split(",").map((entry) => Number.parseInt(entry.trim(), 10));
  }
  return table;
}

/** "###" / ".#." rows → 3-bit masks, bit2 = leftmost, as the firmware packs them. */
function packGlyph(rows: readonly string[]): number[] {
  return rows.map((row) => {
    let bits = 0;
    for (let column = 0; column < row.length; column += 1) {
      if (row[column] !== ".") bits |= 1 << (row.length - 1 - column);
    }
    return bits;
  });
}

describe("vibe tiny font parity — the same numerals on both panels", () => {
  const firmware = readFirmwareFont();

  test("every character the firmware carries matches the console's face", () => {
    for (const [character, rows] of Object.entries(firmware)) {
      const reference = PIXEL_FONT_3X5[character];
      expect(reference, `${character} is not in PIXEL_FONT_3X5`).toBeDefined();
      expect(rows, `glyph "${character}"`).toEqual(packGlyph(reference!));
    }
  });

  test("it carries everything a quota row can contain", () => {
    // Digits and the percent sign are what this screen exists to draw; the
    // letters are metric-label initials, which are the vendor's own words.
    const required = [..."0123456789%- ", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
    for (const character of required) {
      expect(firmware[character], `the firmware table is missing "${character}"`).toBeDefined();
    }
  });

  test("every glyph is five rows of three bits", () => {
    for (const [character, rows] of Object.entries(firmware)) {
      expect(rows, `${character} row count`).toHaveLength(5);
      for (const row of rows) expect(row, `${character} row width`).toBeLessThanOrEqual(0b111);
    }
  });
});
