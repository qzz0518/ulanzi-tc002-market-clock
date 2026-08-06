import { describe, expect, test } from "bun:test";
import {
  AllPriceSourcesUnavailableError,
  MarketDataClient,
  fetchCoinbaseAsset,
  fetchGoldAsset,
  fetchKrakenAsset,
  fetchUsdCnyAsset,
  fetchYahooStockAsset,
  type FetchLike,
} from "../src/price.ts";

const NOW = Date.parse("2026-08-06T06:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("multi-asset market data", () => {
  test("combines a fresh Coinbase ticker with 24h stats", async () => {
    const fetcher: FetchLike = async (input) =>
      String(input).endsWith("/stats")
        ? jsonResponse({ open: "600", high: "630", low: "590", last: "618" })
        : jsonResponse({ price: "618", time: "2026-08-06T05:59:50.000Z" });
    const quote = await fetchCoinbaseAsset("bnb", fetcher, 100, NOW);
    expect(quote).toMatchObject({
      assetId: "bnb",
      provider: "coinbase",
      price: 618,
      changePeriod: "24H",
    });
    expect(quote.changePercent).toBeCloseTo(3);
  });

  test("keeps a valid Coinbase price when optional stats fail", async () => {
    const fetcher: FetchLike = async (input) =>
      String(input).endsWith("/stats")
        ? jsonResponse({}, 503)
        : jsonResponse({ price: "73.96", time: "2026-08-06T05:59:50.000Z" });
    const quote = await fetchCoinbaseAsset("sol", fetcher, 100, NOW);
    expect(quote.price).toBe(73.96);
    expect(quote.changePercent).toBeUndefined();
  });

  test("parses Kraken close and opening price", async () => {
    const fetcher: FetchLike = async () =>
      jsonResponse({
        error: [],
        result: { BNBUSD: { c: ["594.70", "0.1"], o: "600.00" } },
      });
    const quote = await fetchKrakenAsset("bnb", fetcher, 100, NOW);
    expect(quote.provider).toBe("kraken");
    expect(quote.price).toBe(594.7);
    expect(quote.changePercent).toBeCloseTo(-0.8833, 3);
  });

  test("parses live XAU/USD without inventing a change value", async () => {
    const fetcher: FetchLike = async () =>
      jsonResponse({ price: 4254.2, updatedAt: "2026-08-06T05:59:55Z" });
    const quote = await fetchGoldAsset(fetcher, 100, NOW);
    expect(quote).toMatchObject({ assetId: "gold", provider: "gold-api", price: 4254.2 });
    expect(quote.changePercent).toBeUndefined();
  });

  test("uses the latest two USD/CNY reference rates for 1D change", async () => {
    const fetcher: FetchLike = async (input) => {
      expect(String(input)).toContain("base=USD&quotes=CNY");
      return jsonResponse([
        { date: "2026-08-04", base: "USD", quote: "CNY", rate: 7.181 },
        { date: "2026-08-05", base: "USD", quote: "CNY", rate: 7.186 },
        { date: "2026-08-06", base: "USD", quote: "CNY", rate: 7.182 },
      ]);
    };
    const quote = await fetchUsdCnyAsset(fetcher, 100, NOW);
    expect(quote).toMatchObject({
      assetId: "usdcny",
      provider: "frankfurter",
      price: 7.182,
      changePeriod: "1D",
      sourceTime: "2026-08-06",
    });
    expect(quote.changePercent).toBeCloseTo(-0.05566, 4);
  });

  test("parses the four PixDeck Yahoo stock presets with previous-close change", async () => {
    const fetcher: FetchLike = async (input, init) => {
      expect(String(input)).toContain("/v8/finance/chart/AAPL");
      expect(new Headers(init?.headers).get("User-Agent")).toContain("ulanzi");
      return jsonResponse({
        chart: {
          result: [{
            meta: {
              regularMarketPrice: 233.19,
              chartPreviousClose: 230,
              regularMarketTime: 1_785_993_590,
            },
          }],
          error: null,
        },
      });
    };
    const quote = await fetchYahooStockAsset("aapl", fetcher, 100, NOW);
    expect(quote).toMatchObject({
      assetId: "aapl",
      provider: "yahoo",
      price: 233.19,
      changePeriod: "1D",
    });
    expect(quote.changePercent).toBeCloseTo(1.3869, 3);
  });

  test("falls back to Kraken and reports a scoped aggregate failure", async () => {
    const fallbackFetcher: FetchLike = async (input) => {
      if (String(input).includes("coinbase")) return jsonResponse({}, 503);
      return jsonResponse({ error: [], result: { XETHZUSD: { c: ["1911", "1"], o: "1900" } } });
    };
    const client = new MarketDataClient({
      fetcher: fallbackFetcher,
      timeoutMs: 100,
      now: () => NOW,
    });
    expect((await client.getAsset("eth")).provider).toBe("kraken");

    const failed = new MarketDataClient({
      fetcher: async () => jsonResponse({}, 503),
      timeoutMs: 100,
      now: () => NOW,
    });
    await expect(failed.getAsset("btc")).rejects.toBeInstanceOf(
      AllPriceSourcesUnavailableError,
    );
  });
});
