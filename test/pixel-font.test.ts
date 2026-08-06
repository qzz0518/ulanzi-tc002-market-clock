import { describe, expect, test } from "bun:test";
import { renderPixelText } from "../web/src/lib/pixel-font";

describe("canvas pixel font", () => {
  test("supports the migrated punctuation set", () => {
    const bitmap = renderPixelText("%+#,()*=", 5);
    expect(bitmap.width).toBe(31);
    expect(bitmap.on.some((value) => value === 1)).toBe(true);
  });

  test("doubles glyphs and spacing at 10 pixels", () => {
    const small = renderPixelText("AB", 5);
    const large = renderPixelText("AB", 10);
    expect(large.width).toBe(small.width * 2);
    expect(large.height).toBe(small.height * 2);
  });

  test("unsupported characters stay blank", () => {
    const bitmap = renderPixelText("你好", 5);
    expect(bitmap.on.every((value) => value === 0)).toBe(true);
  });
});
