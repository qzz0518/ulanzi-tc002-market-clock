import { describe, expect, test } from "bun:test";
import { renderInstrumentFallbackIcon } from "../src/market/fallback-icon.ts";
import { renderRuntimeMarketDashboard } from "../src/pixel-ui.ts";

describe("runtime market renderer", () => {
  test("keeps the generated icon visible beside a long sub-dollar price", () => {
    const identity = {
      canonicalKey: "crypto:COINBASE:DOGE-USD",
      kind: "crypto" as const,
      baseCode: "DOGE",
      quoteCode: "USD",
      displaySymbol: "DOGE",
    };
    const rendered = renderRuntimeMarketDashboard(
      { price: 0.06999 },
      {
        symbol: identity.displaySymbol,
        decimals: 5,
        accent: [244, 221, 83],
        icon: renderInstrumentFallbackIcon(identity),
      },
      { priceDurationMs: 15_000, changeDurationMs: 2_500, showChange: false },
    );

    const iconZoneIsVisible = Array.from({ length: 11 }, (_, x) =>
      Array.from({ length: 16 }, (_, y) => rendered.frames[0]!.getPixel(x, y))
        .some((color) => color.some((channel) => channel > 8))
    ).some(Boolean);
    expect(iconZoneIsVisible).toBe(true);
    expect(rendered.label).toBe("DOGE .06999");
  });

  test("uses a non-zero scientific label before sacrificing the icon", () => {
    const identity = {
      canonicalKey: "crypto:COINBASE:MICRO-USD",
      kind: "crypto" as const,
      baseCode: "MICRO",
      quoteCode: "USD",
      displaySymbol: "MICRO",
    };
    const rendered = renderRuntimeMarketDashboard(
      { price: 0.00000001 },
      {
        symbol: identity.displaySymbol,
        decimals: 8,
        accent: [80, 224, 138],
        icon: renderInstrumentFallbackIcon(identity),
      },
      { priceDurationMs: 15_000, changeDurationMs: 2_500, showChange: false },
    );

    expect(rendered.label).toBe("MICRO 1E-8");
    expect(Array.from({ length: 11 }, (_, x) =>
      Array.from({ length: 16 }, (_, y) => rendered.frames[0]!.getPixel(x, y))
        .some((color) => color.some((channel) => channel > 8))
    ).some(Boolean)).toBe(true);
  });

  test("renders a stored fallback icon, price, and change within one item duration", () => {
    const identity = {
      canonicalKey: "fx:EUR/USD",
      kind: "fx" as const,
      baseCode: "EUR",
      quoteCode: "USD",
      displaySymbol: "EUR/USD",
    };
    const rendered = renderRuntimeMarketDashboard(
      { price: 1.1662, changePercent: -0.42, changePeriod: "1D" },
      {
        symbol: identity.displaySymbol,
        decimals: 4,
        accent: [75, 205, 255],
        icon: renderInstrumentFallbackIcon(identity),
      },
      { priceDurationMs: 12_500, changeDurationMs: 2_500, showChange: true },
    );
    expect(rendered.frames).toHaveLength(2);
    expect(rendered.frames.every((frame) => frame.width === 52 && frame.height === 16)).toBe(true);
    expect(rendered.frameDelaysMs).toEqual([12_500, 2_500]);
    expect(rendered.animationDurationMs).toBe(15_000);
    expect(rendered.label).toBe("EUR/USD 1.1662");
  });
});
