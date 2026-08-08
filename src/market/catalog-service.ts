import { MarketIconStore, type MarketIconManifest } from "./icon-store.ts";
import {
  InstrumentStore,
  type MarketInstrument,
  type MarketInstrumentDraft,
  type MarketInstrumentKind,
} from "./instruments.ts";
import { BundledCryptoLogoCatalog } from "./logo-catalog.ts";
import {
  AUTOMATIC_LOGO_VARIANT_ID,
  LOGO_PIPELINE_VERSION,
  processLogoPng,
} from "./pixel-logo.ts";
import { MarketSearchService, type MarketSearchResponse } from "./search.ts";

export interface MarketCatalogServiceOptions {
  instruments: InstrumentStore;
  icons: MarketIconStore;
  search: MarketSearchService;
  logos?: BundledCryptoLogoCatalog;
}

export class MarketCatalogService {
  readonly instruments: InstrumentStore;
  readonly icons: MarketIconStore;
  readonly searchService: MarketSearchService;
  readonly logos?: BundledCryptoLogoCatalog;
  private readonly issues = new Set<string>();

  constructor(options: MarketCatalogServiceOptions) {
    this.instruments = options.instruments;
    this.icons = options.icons;
    this.searchService = options.search;
    this.logos = options.logos;
  }

  list(): MarketInstrument[] {
    return this.instruments.list();
  }

  getIssues(): string[] {
    const issues = [
      ...this.instruments.getIssues(),
      ...this.icons.getIssues(),
      ...(this.logos?.getIssues() ?? []),
      ...this.issues,
    ];
    for (const instrument of this.instruments.list()) {
      const icon = this.icons.get(instrument.iconRef);
      if (!icon) issues.push(`${instrument.ref}: missing icon ${instrument.iconRef}`);
      else if (icon.instrumentRef !== instrument.ref) {
        issues.push(`${instrument.ref}: icon provenance points to ${icon.instrumentRef}`);
      }
    }
    return issues;
  }

  search(query: string, kind?: MarketInstrumentKind): Promise<MarketSearchResponse> {
    return this.searchService.search(query, kind);
  }

  private async createCatalogIcon(
    draft: MarketInstrumentDraft,
    instrumentRef: string,
  ): Promise<MarketIconManifest | undefined> {
    const source = await this.logos?.resolve(draft);
    if (!source) return undefined;
    try {
      const processed = processLogoPng(source.png);
      const selected = processed.variants.find((variant) => variant.id === AUTOMATIC_LOGO_VARIANT_ID)
        ?? processed.variants[0];
      if (!selected) throw new Error("catalog logo has no usable pixel variant");
      return await this.icons.saveCatalog({
        instrumentRef,
        bitmap: selected.bitmap,
        sourceCatalog: source.catalog,
        sourceVersion: source.catalogVersion,
        licenseSpdx: source.licenseSpdx,
        sourceAssetId: source.assetId,
        sourceAssetName: source.assetName,
        sourceSha256: processed.sourceSha256,
        sourceWidth: processed.sourceWidth,
        sourceHeight: processed.sourceHeight,
        variantId: selected.id,
      });
    } catch (error) {
      this.issues.add(`${draft.canonicalKey}: catalog logo rejected: ${
        error instanceof Error ? error.message : "invalid source"
      }`);
      return undefined;
    }
  }

  async reconcileGeneratedIcons(): Promise<string[]> {
    const refreshed: string[] = [];
    for (const instrument of this.instruments.list()) {
      const current = this.icons.get(instrument.iconRef);
      if (
        current?.mode === "catalog"
        && current.pipelineVersion === LOGO_PIPELINE_VERSION
        && current.variantId === AUTOMATIC_LOGO_VARIANT_ID
      ) continue;
      const replacement = await this.createCatalogIcon(instrument, instrument.ref);
      if (!replacement || replacement.ref === instrument.iconRef) continue;
      await this.instruments.replaceGeneratedIcon(
        instrument.ref,
        instrument.iconRef,
        replacement.ref,
      );
      refreshed.push(instrument.ref);
    }
    return refreshed;
  }

  async register(candidateRef: string): Promise<MarketInstrument> {
    if (!/^cand_[a-f0-9]{32}$/.test(candidateRef)) throw new Error("candidateRef is invalid");
    const draft = this.searchService.resolve(candidateRef);
    const existing = this.instruments.getByCanonicalKey(draft.canonicalKey);
    if (existing) return existing;
    const ref = this.instruments.allocateRef();
    let icon = await this.createCatalogIcon(draft, ref);
    icon ??= await this.icons.saveFallback({ ...draft, ref });
    return this.instruments.save({ ...draft, ref, iconRef: icon.ref });
  }
}
