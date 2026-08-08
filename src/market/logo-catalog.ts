import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MarketInstrumentDraft } from "./instruments.ts";

const CATALOG_NAME = "spothq/cryptocurrency-icons" as const;
const CATALOG_VERSION = "0.18.1" as const;
const CATALOG_LICENSE = "CC0-1.0" as const;

interface ManifestEntry {
  symbol: string;
  name: string;
}

export interface ResolvedCatalogLogo {
  catalog: typeof CATALOG_NAME;
  catalogVersion: typeof CATALOG_VERSION;
  licenseSpdx: typeof CATALOG_LICENSE;
  assetId: string;
  assetName: string;
  png: Uint8Array;
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function manifestEntry(value: unknown): ManifestEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.symbol !== "string" || typeof input.name !== "string") return undefined;
  const symbol = input.symbol.trim().toUpperCase();
  const name = input.name.trim();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(symbol) || !name || name.length > 120) return undefined;
  return { symbol, name };
}

/**
 * Fixed-version, locally bundled crypto logo catalog.
 *
 * Symbol-only matching is intentionally rejected: Coinbase must also provide
 * the asset's canonical name, and the catalog must contain exactly one entry
 * whose normalized name agrees with it. An uncertain identity falls back to a
 * generated icon instead of silently selecting the wrong brand.
 */
export class BundledCryptoLogoCatalog {
  private entriesPromise?: Promise<Map<string, ManifestEntry[]>>;
  private readonly issues = new Set<string>();

  constructor(readonly directory: string) {}

  getIssues(): string[] {
    return [...this.issues];
  }

  private entries(): Promise<Map<string, ManifestEntry[]>> {
    this.entriesPromise ??= (async () => {
      const parsed = JSON.parse(await readFile(join(this.directory, "manifest.json"), "utf8"));
      if (!Array.isArray(parsed)) throw new Error("crypto logo manifest must be an array");
      const entries = new Map<string, ManifestEntry[]>();
      for (const value of parsed) {
        const entry = manifestEntry(value);
        if (!entry) continue;
        const matches = entries.get(entry.symbol) ?? [];
        matches.push(entry);
        entries.set(entry.symbol, matches);
      }
      return entries;
    })();
    return this.entriesPromise;
  }

  async resolve(draft: MarketInstrumentDraft): Promise<ResolvedCatalogLogo | undefined> {
    if (draft.kind !== "crypto" || !draft.logoIdentity) return undefined;
    const { assetId, name } = draft.logoIdentity;
    if (assetId !== draft.baseCode) return undefined;
    try {
      const candidates = (await this.entries()).get(assetId) ?? [];
      const expectedName = normalizedName(name);
      const exact = candidates.filter((candidate) => normalizedName(candidate.name) === expectedName);
      if (exact.length !== 1) return undefined;
      return {
        catalog: CATALOG_NAME,
        catalogVersion: CATALOG_VERSION,
        licenseSpdx: CATALOG_LICENSE,
        assetId,
        assetName: exact[0]!.name,
        png: new Uint8Array(await readFile(
          join(this.directory, "128/color", `${assetId.toLowerCase()}.png`),
        )),
      };
    } catch (error) {
      this.issues.add(`crypto logo catalog: ${error instanceof Error ? error.message : "unavailable"}`);
      return undefined;
    }
  }
}
