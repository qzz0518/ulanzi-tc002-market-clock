import { describe, expect, test } from "bun:test";
import { renderInstrumentFallbackIcon } from "../src/market/fallback-icon.ts";
import type { PixelCanvas } from "../src/pixel-ui.ts";

interface LitPixel {
  x: number;
  y: number;
  color: readonly [number, number, number];
}

function litPixels(canvas: PixelCanvas): LitPixel[] {
  const pixels: LitPixel[] = [];
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const color = canvas.getPixel(x, y);
      if (color.some((channel) => channel > 0)) pixels.push({ x, y, color });
    }
  }
  return pixels;
}

function litRows(canvas: PixelCanvas): Set<number> {
  return new Set(litPixels(canvas).map((pixel) => pixel.y));
}

const stock = (baseCode: string) => ({
  canonicalKey: `stock:NMS:${baseCode}`,
  kind: "stock" as const,
  baseCode,
  quoteCode: "USD",
  displaySymbol: baseCode,
});

describe("instrument fallback icon", () => {
  test("renders a 2-letter stock as a large centered badge with a detached underline", () => {
    const canvas = renderInstrumentFallbackIcon(stock("MU"));
    const rows = litRows(canvas);

    expect([...rows].filter((y) => y < 3 || y > 12)).toEqual([]);
    expect(rows.has(10)).toBe(false);
    expect(rows.has(11)).toBe(false);
    expect(rows.has(12)).toBe(true);

    const text = litPixels(canvas).filter((pixel) => pixel.y <= 9);
    const bar = litPixels(canvas).filter((pixel) => pixel.y === 12);
    expect(new Set(text.map((pixel) => pixel.color.join(","))).size).toBe(1);
    expect(new Set(bar.map((pixel) => pixel.color.join(","))).size).toBe(1);
    expect(Math.min(...text.map((pixel) => pixel.x))).toBe(3);
    expect(Math.max(...text.map((pixel) => pixel.x))).toBe(12);
    expect(bar.map((pixel) => pixel.x)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const accent = text[0]!.color;
    const barColor = bar[0]!.color;
    expect(barColor.every((channel, index) => channel <= accent[index]!)).toBe(true);
    expect(barColor.some((channel, index) => channel < accent[index]!)).toBe(true);
  });

  test("keeps four-letter codes on the compact font without truncating to three", () => {
    const canvas = renderInstrumentFallbackIcon({
      canonicalKey: "crypto:COINBASE:DOGE-USD",
      kind: "crypto",
      baseCode: "DOGE",
      quoteCode: "USD",
      displaySymbol: "DOGE",
    });
    const rows = litRows(canvas);
    expect([...rows].filter((y) => y < 4 || y > 11)).toEqual([]);
    expect(rows.has(9)).toBe(false);
    expect(rows.has(10)).toBe(false);
    expect(litPixels(canvas).filter((pixel) => pixel.y === 11).map((pixel) => pixel.x))
      .toEqual(Array.from({ length: 15 }, (_, index) => index));
  });

  test("stacks FX base over quote with the quote dimmed and no corner decorations", () => {
    const canvas = renderInstrumentFallbackIcon({
      canonicalKey: "fx:EUR/USD",
      kind: "fx",
      baseCode: "EUR",
      quoteCode: "USD",
      displaySymbol: "EUR/USD",
    });
    const rows = litRows(canvas);
    expect([...rows].filter((y) => y < 2 || y === 7 || y === 8 || y > 13)).toEqual([]);

    const base = litPixels(canvas).filter((pixel) => pixel.y <= 6);
    const quote = litPixels(canvas).filter((pixel) => pixel.y >= 9);
    expect(base.length).toBeGreaterThan(0);
    expect(quote.length).toBeGreaterThan(0);
    const baseColor = base[0]!.color;
    const quoteColor = quote[0]!.color;
    expect(quoteColor.every((channel, index) => channel <= baseColor[index]!)).toBe(true);
    expect(quoteColor.some((channel, index) => channel < baseColor[index]!)).toBe(true);
  });

  test("never lets glyphs touch the underline for any single-row label", () => {
    for (const code of ["F", "GM", "TSM", "XAU", "NVDA", "AAPL", "0700HK", "600519SS"]) {
      const canvas = renderInstrumentFallbackIcon(stock(code));
      const rows = [...litRows(canvas)].sort((left, right) => left - right);
      const bar = rows.at(-1)!;
      expect(rows).not.toContain(bar - 1);
      expect(rows).not.toContain(bar - 2);
      expect(canvas.getPixel(0, 0).every((channel) => channel === 0)).toBe(true);
      expect(canvas.getPixel(15, 15).every((channel) => channel === 0)).toBe(true);
    }
  });

  test("renders deterministically for the same canonical identity", () => {
    const first = renderInstrumentFallbackIcon(stock("MU"));
    const second = renderInstrumentFallbackIcon(stock("MU"));
    expect(first.pixels).toEqual(second.pixels);
  });
});
