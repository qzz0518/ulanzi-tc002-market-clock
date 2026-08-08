import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketCatalogService } from "../src/market/catalog-service.ts";
import { MarketIconStore } from "../src/market/icon-store.ts";
import {
  InstrumentStore,
  canonicalInstrumentKey,
  type MarketInstrumentDraft,
} from "../src/market/instruments.ts";
import { processLogoPng } from "../src/market/pixel-logo.ts";
import { DynamicMarketDataClient } from "../src/market/quotes.ts";
import { MarketSearchService } from "../src/market/search.ts";
import { BundledCryptoLogoCatalog } from "../src/market/logo-catalog.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function json(value: unknown): Response {
  return Response.json(value);
}

describe("zero-key market discovery", () => {
  test("searches crypto, currency pairs, and metals then registers an opaque local identity", async () => {
    const requests: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/products")) {
        return json([
          {
            id: "BTC-USD",
            base_currency: "BTC",
            quote_currency: "USD",
            display_name: "BTC/USD",
            status: "online",
            quote_increment: "0.01",
          },
          {
            id: "ETH-USD",
            base_currency: "ETH",
            quote_currency: "USD",
            display_name: "ETH/USD",
            status: "online",
            quote_increment: "0.01",
          },
          {
            id: "USDC-EUR",
            base_currency: "USDC",
            quote_currency: "EUR",
            display_name: "USDC/EUR",
            status: "online",
            quote_increment: "0.0001",
          },
          {
            id: "AAVE-BTC",
            base_currency: "AAVE",
            quote_currency: "BTC",
            display_name: "AAVE-BTC",
            status: "online",
            quote_increment: "0.00000001",
          },
        ]);
      }
      if (url.endsWith("/currencies")) {
        return json([
          { id: "BTC", name: "Bitcoin", default_network: "bitcoin", supported_networks: [] },
          { id: "ETH", name: "Ethereum", default_network: "ethereum", supported_networks: [] },
          { id: "USDC", name: "USD Coin", default_network: "ethereum", supported_networks: [] },
          { id: "AAVE", name: "Aave", default_network: "ethereum", supported_networks: [] },
        ]);
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-market-catalog-"));
    directories.push(directory);
    const instruments = new InstrumentStore(join(directory, "instruments"), { now: () => 0 });
    const icons = new MarketIconStore(join(directory, "icons"), { now: () => 0 });
    await Promise.all([instruments.load(), icons.load()]);
    const search = new MarketSearchService({ fetcher, now: () => 0 });
    const catalog = new MarketCatalogService({
      instruments,
      icons,
      search,
      logos: new BundledCryptoLogoCatalog(join(
        import.meta.dir,
        "../node_modules/cryptocurrency-icons",
      )),
    });

    const btc = await catalog.search("btc", "crypto");
    expect(btc.results.map((result) => result.pair)).toContain("BTC/USD");
    expect(btc.results.every((result) => result.baseCode === "BTC")).toBe(true);
    const registered = await catalog.register(btc.results[0]!.candidateRef);
    expect(registered.ref).toMatch(/^ins_[a-f0-9]{24}$/);
    expect(registered.iconRef).toMatch(/^ico_[a-f0-9]{32}$/);
    expect(registered.canonicalKey).toBe("crypto:COINBASE:BTC-USD");
    expect(registered.displayName).toBe("Bitcoin");
    expect(registered.logoIdentity).toMatchObject({ assetId: "BTC", name: "Bitcoin" });
    expect(icons.get(registered.iconRef)).toMatchObject({
      mode: "catalog",
      sourceCatalog: "spothq/cryptocurrency-icons",
      sourceAssetId: "BTC",
      licenseSpdx: "CC0-1.0",
      variantId: "compact",
    });
    expect((await catalog.register(btc.results[0]!.candidateRef)).ref).toBe(registered.ref);

    const fx = await catalog.search("USD/CNY", "fx");
    expect(fx.results[0]?.canonicalKey).toBe("fx:USD/CNY");
    const unambiguous = await catalog.search("USD/CNY");
    expect(unambiguous.results.map((result) => result.canonicalKey)).toEqual(["fx:USD/CNY"]);
    const eurUsd = await catalog.search("EUR/USD");
    expect(eurUsd.results.map((result) => result.canonicalKey)).toEqual(["fx:EUR/USD"]);
    const metal = await catalog.search("silver", "metal");
    expect(metal.results[0]?.displaySymbol).toBe("XAG");
    expect(requests.filter((url) => url.endsWith("/products"))).toHaveLength(1);
    expect(requests.filter((url) => url.endsWith("/currencies"))).toHaveLength(1);
  });

  test("searches Yahoo stocks with mapped listing currencies and registers a fallback-icon instrument", async () => {
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith("https://query1.finance.yahoo.com/v1/finance/search?")) {
        throw new Error(`unexpected URL: ${url}`);
      }
      return json({
        quotes: [
          {
            symbol: "TSLA",
            exchange: "NMS",
            exchDisp: "NASDAQ",
            quoteType: "EQUITY",
            isYahooFinance: true,
            longname: "Tesla, Inc.",
            shortname: "Tesla",
          },
          {
            symbol: "0700.HK",
            exchange: "HKG",
            exchDisp: "Hong Kong",
            quoteType: "EQUITY",
            isYahooFinance: true,
            longname: "Tencent Holdings Limited",
          },
          {
            symbol: "TSLI.L",
            exchange: "LSE",
            exchDisp: "London",
            quoteType: "ETF",
            isYahooFinance: true,
            longname: "Pence-priced London listing",
          },
          {
            symbol: "TSLAX",
            exchange: "PNK",
            exchDisp: "OTC Markets",
            quoteType: "EQUITY",
            isYahooFinance: true,
            longname: "OTC listing",
          },
          { symbol: "GC=F", exchange: "CMX", exchDisp: "COMEX", quoteType: "FUTURE", isYahooFinance: true },
          { symbol: "TSLA-USD", exchange: "CCC", exchDisp: "CCC", quoteType: "CRYPTOCURRENCY", isYahooFinance: true },
          { symbol: "FAKE", exchange: "NMS", exchDisp: "NASDAQ", quoteType: "EQUITY", isYahooFinance: false },
        ],
      });
    };
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-market-stocks-"));
    directories.push(directory);
    const instruments = new InstrumentStore(join(directory, "instruments"), { now: () => 0 });
    const icons = new MarketIconStore(join(directory, "icons"), { now: () => 0 });
    await Promise.all([instruments.load(), icons.load()]);
    const catalog = new MarketCatalogService({
      instruments,
      icons,
      search: new MarketSearchService({ fetcher, now: () => 0 }),
    });

    const result = await catalog.search("tsla", "stock");
    expect(result.results.map((candidate) => candidate.canonicalKey))
      .toEqual(["stock:NMS:TSLA", "stock:HKG:0700.HK"]);
    expect(result.results[0]).toMatchObject({
      pair: "TSLA/USD",
      displayName: "Tesla, Inc.",
      sourceLabel: "Yahoo Finance · NASDAQ",
    });
    expect(result.results[1]).toMatchObject({ baseCode: "0700.HK", quoteCode: "HKD" });
    expect(result.notice).toBeUndefined();

    const registered = await catalog.register(result.results[0]!.candidateRef);
    expect(registered.kind).toBe("stock");
    expect(registered.canonicalKey).toBe("stock:NMS:TSLA");
    expect(registered.routes).toEqual([{ provider: "yahoo", symbol: "TSLA" }]);
    expect(registered.changePeriod).toBe("1D");
    expect(icons.get(registered.iconRef)).toMatchObject({
      mode: "fallback",
      pipelineVersion: "fallback-v2",
    });
    expect((await catalog.register(result.results[0]!.candidateRef)).ref).toBe(registered.ref);
  });

  test("keeps stocks visible when earlier asset kinds fill the mixed-search cap", async () => {
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/products")) {
        return json(Array.from({ length: 26 }, (_, index) => ({
          id: `T${index}A-USD`,
          base_currency: `T${index}A`,
          quote_currency: "USD",
          display_name: `T${index}A/USD`,
          status: "online",
          quote_increment: "0.01",
        })));
      }
      if (url.endsWith("/currencies")) return json([]);
      if (url.startsWith("https://query1.finance.yahoo.com/v1/finance/search?")) {
        return json({
          quotes: [{
            symbol: "T",
            exchange: "NYQ",
            exchDisp: "NYSE",
            quoteType: "EQUITY",
            isYahooFinance: true,
            longname: "AT&T Inc.",
          }],
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const search = new MarketSearchService({ fetcher, now: () => 0 });
    const mixed = await search.search("t");
    expect(mixed.results.length).toBeLessThanOrEqual(24);
    expect(mixed.results.map((candidate) => candidate.canonicalKey)).toContain("stock:NYQ:T");
  });

  test("refreshes legacy wide catalog icons to the compact automatic variant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-market-logo-refresh-"));
    directories.push(directory);
    const instruments = new InstrumentStore(join(directory, "instruments"), { now: () => 0 });
    const icons = new MarketIconStore(join(directory, "icons"), { now: () => 0 });
    await Promise.all([instruments.load(), icons.load()]);
    const logos = new BundledCryptoLogoCatalog(join(
      import.meta.dir,
      "../node_modules/cryptocurrency-icons",
    ));
    const draft: MarketInstrumentDraft = {
      canonicalKey: canonicalInstrumentKey({
        kind: "crypto",
        provider: "coinbase",
        symbol: "BTC-USD",
      }),
      kind: "crypto",
      displayName: "Bitcoin",
      displaySymbol: "BTC",
      baseCode: "BTC",
      quoteCode: "USD",
      decimals: 2,
      changePeriod: "24H",
      routes: [{ provider: "coinbase", symbol: "BTC-USD" }],
      logoIdentity: { provider: "coinbase", assetId: "BTC", name: "Bitcoin" },
      sourceNote: "Coinbase Exchange public market data.",
    };
    const ref = "ins_aaaaaaaaaaaaaaaaaaaaaaaa";
    const source = await logos.resolve(draft);
    expect(source).toBeDefined();
    const processed = processLogoPng(source!.png);
    const balanced = processed.variants.find((variant) => variant.id === "balanced")!;
    const legacyIcon = await icons.saveCatalog({
      instrumentRef: ref,
      bitmap: balanced.bitmap,
      sourceCatalog: source!.catalog,
      sourceVersion: source!.catalogVersion,
      licenseSpdx: source!.licenseSpdx,
      sourceAssetId: source!.assetId,
      sourceAssetName: source!.assetName,
      sourceSha256: processed.sourceSha256,
      sourceWidth: processed.sourceWidth,
      sourceHeight: processed.sourceHeight,
      variantId: balanced.id,
    });
    await instruments.save({ ...draft, ref, iconRef: legacyIcon.ref });
    const legacyManifestPath = join(
      directory,
      "icons",
      "manifests",
      `${legacyIcon.ref}.json`,
    );
    const legacyManifest = await Bun.file(legacyManifestPath).json();
    legacyManifest.pipelineVersion = "catalog-png-v1";
    await Bun.write(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    const restoredInstruments = new InstrumentStore(join(directory, "instruments"), { now: () => 1_000 });
    const restoredIcons = new MarketIconStore(join(directory, "icons"), { now: () => 1_000 });
    await Promise.all([restoredInstruments.load(), restoredIcons.load()]);
    expect(restoredIcons.has(legacyIcon.ref)).toBe(true);
    const catalog = new MarketCatalogService({
      instruments: restoredInstruments,
      icons: restoredIcons,
      logos,
      search: new MarketSearchService({ fetcher: async () => json([]) }),
    });

    expect(await catalog.reconcileGeneratedIcons()).toEqual([ref]);
    const refreshed = restoredInstruments.get(ref)!;
    expect(refreshed.iconRef).not.toBe(legacyIcon.ref);
    expect(restoredIcons.get(refreshed.iconRef)).toMatchObject({ mode: "catalog", variantId: "compact" });
    const canvas = await restoredIcons.getCanvas(refreshed.iconRef);
    const visible = Array.from({ length: 16 * 16 }, (_, index) => ({
      x: index % 16,
      y: Math.floor(index / 16),
      color: canvas.getPixel(index % 16, Math.floor(index / 16)),
    })).filter((pixel) => pixel.color.some((channel) => channel > 0));
    expect(Math.max(...visible.map((pixel) => pixel.x)) - Math.min(...visible.map((pixel) => pixel.x)) + 1)
      .toBe(12);
    expect(Math.max(...visible.map((pixel) => pixel.y)) - Math.min(...visible.map((pixel) => pixel.y)) + 1)
      .toBe(12);

    const reloaded = new InstrumentStore(join(directory, "instruments"));
    await reloaded.load();
    expect(reloaded.get(ref)?.iconRef).toBe(refreshed.iconRef);
  });

  test("refreshes legacy fallback-v1 icons to the v2 badge design", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdir } = await import("node:fs/promises");
    const { PixelCanvas } = await import("../src/pixel-ui.ts");
    const { renderInstrumentFallbackIcon } = await import("../src/market/fallback-icon.ts");
    const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

    const directory = await mkdtemp(join(tmpdir(), "ulanzi-market-fallback-refresh-"));
    directories.push(directory);
    const draft: MarketInstrumentDraft = {
      canonicalKey: "stock:NMS:MU",
      kind: "stock",
      displayName: "Micron Technology, Inc.",
      displaySymbol: "MU",
      baseCode: "MU",
      quoteCode: "USD",
      decimals: 2,
      changePeriod: "1D",
      routes: [{ provider: "yahoo", symbol: "MU" }],
      sourceNote: "Yahoo Finance 公开行情（NASDAQ），价格可能延迟，仅供展示。",
    };
    const ref = "ins_bbbbbbbbbbbbbbbbbbbbbbbb";

    // 忠实还原 v1 时代的产物：老设计像素 + fallback-v1 派生键推导出的 ref。
    const legacyCanvas = new PixelCanvas(16, 16);
    legacyCanvas.fillRect(0, 0, 2, 1, [50, 87, 143]);
    legacyCanvas.fillRect(3, 12, 10, 1, [50, 87, 143]);
    const legacyPng = legacyCanvas.toPng();
    const legacyPixelSha = sha256(legacyCanvas.pixels);
    const legacyBlobRef = sha256(legacyPng);
    const legacyDerivationKey = sha256(`${draft.canonicalKey}:fallback-v1:16x16`);
    const legacyIconRef = `ico_${sha256(`${ref}:${legacyPixelSha}:${legacyDerivationKey}`).slice(0, 32)}`;
    await mkdir(join(directory, "icons", "manifests"), { recursive: true });
    await mkdir(join(directory, "icons", "blobs"), { recursive: true });
    await Bun.write(join(directory, "icons", "blobs", `${legacyBlobRef}.png`), legacyPng);
    await Bun.write(
      join(directory, "icons", "manifests", `${legacyIconRef}.json`),
      `${JSON.stringify({
        version: 1,
        ref: legacyIconRef,
        instrumentRef: ref,
        mode: "fallback",
        pipelineVersion: "fallback-v1",
        sourceType: "fallback",
        licensePolicy: "generated-local",
        reviewStatus: "auto",
        width: 16,
        height: 16,
        pixelSha256: legacyPixelSha,
        blobRef: legacyBlobRef,
        derivationKey: legacyDerivationKey,
        createdAt: "2026-08-01T00:00:00.000Z",
      }, null, 2)}\n`,
    );
    await mkdir(join(directory, "instruments"), { recursive: true });
    await Bun.write(
      join(directory, "instruments", `${ref}.json`),
      `${JSON.stringify({
        ...draft,
        version: 1,
        ref,
        iconRef: legacyIconRef,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }, null, 2)}\n`,
    );

    const instruments = new InstrumentStore(join(directory, "instruments"), { now: () => 1_000 });
    const icons = new MarketIconStore(join(directory, "icons"), { now: () => 1_000 });
    await Promise.all([instruments.load(), icons.load()]);
    expect(instruments.getIssues()).toEqual([]);
    expect(icons.getIssues()).toEqual([]);
    const catalog = new MarketCatalogService({
      instruments,
      icons,
      search: new MarketSearchService({ fetcher: async () => json([]) }),
    });

    expect(await catalog.reconcileGeneratedIcons()).toEqual([ref]);
    const refreshed = instruments.get(ref)!;
    expect(refreshed.iconRef).not.toBe(legacyIconRef);
    expect(icons.get(refreshed.iconRef)).toMatchObject({
      mode: "fallback",
      pipelineVersion: "fallback-v2",
    });
    const refreshedCanvas = await icons.getCanvas(refreshed.iconRef);
    expect(refreshedCanvas.pixels).toEqual(renderInstrumentFallbackIcon(draft).pixels);
    expect(await catalog.reconcileGeneratedIcons()).toEqual([]);
  });
});

describe("runtime quotes", () => {
  test("reads a live Coinbase quote and optional 24h change by provider route", async () => {
    const now = Date.parse("2026-08-07T00:00:00Z");
    const client = new DynamicMarketDataClient({
      now: () => now,
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("/ticker")) {
          return json({ price: "101.25", time: "2026-08-06T23:59:30Z" });
        }
        if (url.endsWith("/stats")) return json({ open: "100" });
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    const market = await client.getInstrument({
      version: 1,
      ref: "ins_aaaaaaaaaaaaaaaaaaaaaaaa",
      iconRef: `ico_${"1".repeat(32)}`,
      canonicalKey: "crypto:COINBASE:BTC-USD",
      kind: "crypto",
      displayName: "BTC / US Dollar",
      displaySymbol: "BTC",
      baseCode: "BTC",
      quoteCode: "USD",
      decimals: 2,
      changePeriod: "24H",
      routes: [{ provider: "coinbase", symbol: "BTC-USD" }],
      sourceNote: "Coinbase public market data.",
      createdAt: "2026-08-07T00:00:00Z",
      updatedAt: "2026-08-07T00:00:00Z",
    });
    expect(market.price).toBe(101.25);
    expect(market.changePercent).toBeCloseTo(1.25);
    expect(market.changePeriod).toBe("24H");
  });

  test("reads a delayed Yahoo stock quote through the dynamic yahoo route", async () => {
    const now = Date.parse("2026-08-07T00:00:00Z");
    const client = new DynamicMarketDataClient({
      now: () => now,
      fetcher: async (input) => {
        const url = String(input);
        if (!url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/0700.HK")) {
          throw new Error(`unexpected URL: ${url}`);
        }
        return json({
          chart: {
            result: [{
              meta: {
                currency: "HKD",
                symbol: "0700.HK",
                regularMarketPrice: 478.8,
                chartPreviousClose: 479.2,
                regularMarketTime: 1_786_090_091,
              },
            }],
          },
        });
      },
    });
    const market = await client.getInstrument({
      version: 1,
      ref: "ins_bbbbbbbbbbbbbbbbbbbbbbbb",
      iconRef: `ico_${"2".repeat(32)}`,
      canonicalKey: "stock:HKG:0700.HK",
      kind: "stock",
      displayName: "Tencent Holdings Limited",
      displaySymbol: "0700.HK",
      baseCode: "0700.HK",
      quoteCode: "HKD",
      decimals: 2,
      changePeriod: "1D",
      routes: [{ provider: "yahoo", symbol: "0700.HK" }],
      sourceNote: "Yahoo Finance 公开行情（Hong Kong），价格可能延迟，仅供展示。",
      createdAt: "2026-08-07T00:00:00Z",
      updatedAt: "2026-08-07T00:00:00Z",
    });
    expect(market.provider).toBe("yahoo");
    expect(market.price).toBe(478.8);
    expect(market.changePercent).toBeCloseTo(((478.8 - 479.2) / 479.2) * 100);
    expect(market.changePeriod).toBe("1D");
    expect(market.sourceTime).toBe(new Date(1_786_090_091 * 1_000).toISOString());
  });

  const stockInstrument = {
    version: 1,
    ref: "ins_cccccccccccccccccccccccc",
    iconRef: `ico_${"3".repeat(32)}`,
    canonicalKey: "stock:NMS:TSLA",
    kind: "stock",
    displayName: "Tesla, Inc.",
    displaySymbol: "TSLA",
    baseCode: "TSLA",
    quoteCode: "USD",
    decimals: 2,
    changePeriod: "1D",
    routes: [{ provider: "yahoo", symbol: "TSLA" }],
    sourceNote: "Yahoo Finance 公开行情（NASDAQ），价格可能延迟，仅供展示。",
    createdAt: "2026-08-07T00:00:00Z",
    updatedAt: "2026-08-07T00:00:00Z",
  } as const;

  test("throttles Yahoo chart requests to one per symbol per minute", async () => {
    let nowMs = Date.parse("2026-08-07T00:00:00Z");
    let fetches = 0;
    const client = new DynamicMarketDataClient({
      now: () => nowMs,
      fetcher: async () => {
        fetches += 1;
        return json({ chart: { result: [{ meta: { currency: "USD", regularMarketPrice: 200, chartPreviousClose: 190 } }] } });
      },
    });
    await client.getInstrument({ ...stockInstrument, routes: [...stockInstrument.routes] });
    nowMs += 30_000;
    const cachedRead = await client.getInstrument({ ...stockInstrument, routes: [...stockInstrument.routes] });
    expect(fetches).toBe(1);
    expect(cachedRead.price).toBe(200);
    nowMs += 65_000;
    await client.getInstrument({ ...stockInstrument, routes: [...stockInstrument.routes] });
    expect(fetches).toBe(2);
  });

  test("rejects a Yahoo quote whose listing currency contradicts the instrument", async () => {
    const client = new DynamicMarketDataClient({
      now: () => Date.parse("2026-08-07T00:00:00Z"),
      fetcher: async () =>
        json({ chart: { result: [{ meta: { currency: "USD", regularMarketPrice: 0.691, chartPreviousClose: 0.7 } }] } }),
    });
    await expect(client.getInstrument({
      ...stockInstrument,
      canonicalKey: "stock:SHH:900901.SS",
      displaySymbol: "900901.SS",
      baseCode: "900901.SS",
      quoteCode: "CNY",
      routes: [{ provider: "yahoo", symbol: "900901.SS" }],
    })).rejects.toThrow(/trades in USD, not CNY/);
  });

  test("keeps a valid live Yahoo price when the previous close is missing", async () => {
    const client = new DynamicMarketDataClient({
      now: () => Date.parse("2026-08-07T00:00:00Z"),
      fetcher: async () =>
        json({ chart: { result: [{ meta: { currency: "USD", regularMarketPrice: 478.8 } }] } }),
    });
    const market = await client.getInstrument({ ...stockInstrument, routes: [...stockInstrument.routes] });
    expect(market.price).toBe(478.8);
    expect(market.changePercent).toBeUndefined();
    expect(market.changePeriod).toBeUndefined();
  });
});
