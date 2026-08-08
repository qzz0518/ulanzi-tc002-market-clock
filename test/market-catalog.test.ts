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

  test("does not silently invent unrestricted stock search", async () => {
    const search = new MarketSearchService({
      fetcher: async () => json([]),
    });
    const result = await search.search("TSLA", "stock");
    expect(result.results).toEqual([]);
    expect(result.notice).toContain("BYOK");
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
});
