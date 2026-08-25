import { describe, expect, test } from "bun:test";
import { PUNCTUATION_FALLBACK, applyPunctuationFallback } from "../web/src/lib/pixel-text-block.ts";
import { glyphRows } from "../web/src/lib/pixel-glyphs.ts";

const TEXT_CPP = new URL("../device/tc002-os/app/src/core/Text.cpp", import.meta.url);

/**
 * The device folds fullwidth punctuation onto ASCII before it looks a glyph up,
 * and so does the preview. Two implementations, one rule — the same shape
 * test/pixel-glyphs.test.ts guards for the glyph tables themselves, and for the
 * same reason: a character that renders one way in the browser and another way
 * on the panel makes the preview a lie.
 *
 * Parsed out of the C++ rather than duplicated here, so this test cannot pass by
 * agreeing with a copy of itself.
 */
async function deviceFolds(): Promise<Map<number, string>> {
  const source = await Bun.file(TEXT_CPP).text();
  const table = source.match(/const PunctuationFold kPunctuationFolds\[\] = \{([\s\S]*?)\};/);
  expect(table).not.toBeNull();
  const folds = new Map<number, string>();
  // {0xFF0C, ','} and {0x2018, '\''} — the escaped quote is the only escape used.
  for (const entry of table![1]!.matchAll(/\{\s*0x([0-9A-Fa-f]+)\s*,\s*'(\\?.)'\s*\}/g)) {
    folds.set(parseInt(entry[1]!, 16), entry[2]!.replace(/^\\/, ""));
  }
  return folds;
}

describe("fullwidth punctuation folds identically on device and in preview", () => {
  test("the device table is the web table", async () => {
    const device = await deviceFolds();
    const web = new Map(
      Object.entries(PUNCTUATION_FALLBACK).map(([from, to]) => [from.codePointAt(0)!, to]),
    );
    expect(device.size).toBe(web.size);
    for (const [codepoint, to] of web) {
      expect(device.get(codepoint)).toBe(to);
    }
  });

  test("every substitute is a glyph both sides actually have", async () => {
    for (const [, to] of await deviceFolds()) {
      expect(to.length).toBe(1);
      const codepoint = to.codePointAt(0)!;
      // Half-width ASCII, which is the whole point: 6px instead of 12px.
      expect(codepoint).toBeGreaterThanOrEqual(0x20);
      expect(codepoint).toBeLessThanOrEqual(0x7e);
      expect(glyphRows(codepoint)).not.toBeNull();
    }
  });

  test("the comma a Chinese IME emits by default is covered", async () => {
    // The character this whole mechanism exists for: 「，」 is not in the glyph
    // table, which was generated from song lyrics, and an unmapped codepoint
    // draws nothing rather than falling back to a box.
    expect(glyphRows(0xff0c)).toBeNull();
    expect((await deviceFolds()).get(0xff0c)).toBe(",");
    expect(applyPunctuationFallback("你好，世界")).toBe("你好,世界");
  });

  test("brackets with no honest ASCII equivalent stay unfolded on both sides", async () => {
    const device = await deviceFolds();
    for (const character of "《》〈〉【】") {
      const codepoint = character.codePointAt(0)!;
      expect(device.has(codepoint)).toBe(false);
      expect(PUNCTUATION_FALLBACK[character]).toBeUndefined();
    }
  });
});
