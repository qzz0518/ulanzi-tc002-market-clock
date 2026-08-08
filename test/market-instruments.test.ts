import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InstrumentStore,
  canonicalInstrumentKey,
  type MarketInstrumentDraft,
} from "../src/market/instruments.ts";
import { MarketIconStore } from "../src/market/icon-store.ts";
import type { PixelLogoBitmap } from "../src/market/pixel-logo.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function cryptoDraft(symbol = "BTC"): MarketInstrumentDraft {
  return {
    canonicalKey: canonicalInstrumentKey({
      kind: "crypto",
      provider: "coinbase",
      symbol: `${symbol}-USD`,
    }),
    kind: "crypto",
    displayName: `${symbol} / US Dollar`,
    displaySymbol: symbol,
    baseCode: symbol,
    quoteCode: "USD",
    decimals: 2,
    changePeriod: "24H",
    routes: [{ provider: "coinbase", symbol: `${symbol}-USD` }],
    sourceNote: "Coinbase Exchange public market data.",
  };
}

describe("runtime market instrument storage", () => {
  test("normalizes canonical identities and restores independent atomic records", async () => {
    expect(canonicalInstrumentKey({
      kind: "fx",
      base: " eur ",
      quote: "usd",
    })).toBe("fx:EUR/USD");
    expect(canonicalInstrumentKey({
      kind: "stock",
      exchange: "nasdaq",
      symbol: " msft ",
    })).toBe("stock:NASDAQ:MSFT");

    const directory = await mkdtemp(join(tmpdir(), "ulanzi-instruments-"));
    directories.push(directory);
    const store = new InstrumentStore(directory, { now: () => Date.parse("2026-08-07T00:00:00Z") });
    await store.load();
    const ref = store.allocateRef();
    const saved = await store.save({
      ...cryptoDraft(),
      ref,
      iconRef: `ico_${"1".repeat(32)}`,
    });
    const duplicate = await store.save({
      ...cryptoDraft(),
      ref: store.allocateRef(),
      iconRef: `ico_${"2".repeat(32)}`,
    });
    expect(duplicate.ref).toBe(saved.ref);
    expect(store.list()).toHaveLength(1);

    const reloaded = new InstrumentStore(directory);
    await reloaded.load();
    expect(reloaded.get(saved.ref)).toEqual(saved);
    expect(reloaded.getByCanonicalKey(saved.canonicalKey)?.ref).toBe(saved.ref);
    expect(reloaded.getIssues()).toEqual([]);
    expect(JSON.parse(await readFile(join(directory, `${saved.ref}.json`), "utf8")).ref)
      .toBe(saved.ref);
    expect(() => canonicalInstrumentKey({
      kind: "fx",
      base: "EUR<script>",
      quote: "USD",
    })).toThrow("base currency is invalid");
  });

  test("isolates corrupt records instead of replacing them with another asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-instruments-corrupt-"));
    directories.push(directory);
    await Bun.write(join(directory, "ins_deadbeefdeadbeefdeadbeef.json"), "{broken");
    const store = new InstrumentStore(directory);
    await store.load();
    expect(store.list()).toEqual([]);
    expect(store.getIssues()).toHaveLength(1);
    expect(store.get("ins_deadbeefdeadbeefdeadbeef")).toBeUndefined();
  });

});

describe("deterministic pixel logo store", () => {
  test("creates stable 16x16 fallbacks and keeps per-instrument provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-market-icons-"));
    directories.push(directory);
    const store = new MarketIconStore(directory, {
      now: () => Date.parse("2026-08-07T00:00:00Z"),
    });
    await store.load();
    const first = {
      ...cryptoDraft("ABC"),
      ref: "ins_aaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const second = {
      ...cryptoDraft("ABC"),
      ref: "ins_bbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const firstIcon = await store.saveFallback(first);
    const repeated = await store.saveFallback(first);
    const secondIcon = await store.saveFallback(second);

    expect(repeated.ref).toBe(firstIcon.ref);
    expect(secondIcon.ref).not.toBe(firstIcon.ref);
    expect(secondIcon.pixelSha256).toBe(firstIcon.pixelSha256);
    expect(secondIcon.blobRef).toBe(firstIcon.blobRef);
    expect((await store.getPng(firstIcon.ref)).subarray(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const canvas = await store.getCanvas(firstIcon.ref);
    expect([canvas.width, canvas.height]).toEqual([16, 16]);
    expect(canvas.pixels.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);

    const restored = new MarketIconStore(directory);
    await restored.load();
    expect((await restored.getPng(secondIcon.ref)).length).toBeGreaterThan(32);

    await Bun.write(join(directory, "blobs", `${firstIcon.blobRef}.png`), "corrupt");
    const corrupted = new MarketIconStore(directory);
    await corrupted.load();
    expect(corrupted.has(firstIcon.ref)).toBe(false);
    expect(corrupted.getIssues().length).toBeGreaterThan(0);
  });

  test("deduplicates catalog pixel blobs without merging per-instrument provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-market-catalog-icons-"));
    directories.push(directory);
    const store = new MarketIconStore(directory, { now: () => Date.parse("2026-08-07T00:00:00Z") });
    await store.load();
    const pixels = new Uint8Array(16 * 16 * 4);
    for (let y = 3; y < 13; y += 1) {
      for (let x = 3; x < 13; x += 1) {
        const offset = (y * 16 + x) * 4;
        pixels.set([25, 170, 240, 255], offset);
      }
    }
    const bitmap: PixelLogoBitmap = { width: 16, height: 16, pixels };
    const sourceSha256 = "a".repeat(64);
    const first = await store.saveCatalog({
      instrumentRef: "ins_aaaaaaaaaaaaaaaaaaaaaaaa",
      bitmap,
      sourceCatalog: "spothq/cryptocurrency-icons",
      sourceVersion: "0.18.1",
      licenseSpdx: "CC0-1.0",
      sourceAssetId: "BTC",
      sourceAssetName: "Bitcoin",
      sourceSha256,
      sourceWidth: 64,
      sourceHeight: 64,
      variantId: "balanced",
    });
    const second = await store.saveCatalog({
      instrumentRef: "ins_bbbbbbbbbbbbbbbbbbbbbbbb",
      bitmap,
      sourceCatalog: "spothq/cryptocurrency-icons",
      sourceVersion: "0.18.1",
      licenseSpdx: "CC0-1.0",
      sourceAssetId: "BTC",
      sourceAssetName: "Bitcoin",
      sourceSha256,
      sourceWidth: 64,
      sourceHeight: 64,
      variantId: "balanced",
    });
    expect(first.mode).toBe("catalog");
    expect(first.ref).not.toBe(second.ref);
    expect(first.blobRef).toBe(second.blobRef);
    expect(first.pixelSha256).toBe(second.pixelSha256);

    const restored = new MarketIconStore(directory);
    await restored.load();
    expect(restored.get(first.ref)?.instrumentRef).toBe("ins_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(restored.get(second.ref)?.instrumentRef).toBe("ins_bbbbbbbbbbbbbbbbbbbbbbbb");
  });
});
