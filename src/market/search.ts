import { createHash } from "node:crypto";
import type { FetchLike } from "../price.ts";
import {
  canonicalInstrumentKey,
  type MarketInstrumentDraft,
  type MarketInstrumentKind,
} from "./instruments.ts";

const COINBASE_PRODUCTS_URL = "https://api.exchange.coinbase.com/products";
const COINBASE_CURRENCIES_URL = "https://api.exchange.coinbase.com/currencies";
const CACHE_TTL_MS = 6 * 60 * 60_000;

export interface MarketSearchCandidate extends MarketInstrumentDraft {
  candidateRef: string;
  pair: string;
  sourceLabel: string;
}

export interface MarketSearchResponse {
  query: string;
  kind?: MarketInstrumentKind;
  results: MarketSearchCandidate[];
  notice?: string;
}

interface CoinbaseProduct {
  id: string;
  base: string;
  quote: string;
  name: string;
  decimals: number;
}

interface CoinbaseCurrency {
  id: string;
  name: string;
  network?: string;
  contractAddress?: string;
}

interface Currency {
  code: string;
  name: string;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface CandidateCacheEntry {
  draft: MarketInstrumentDraft;
  expiresAt: number;
}

export interface MarketSearchServiceOptions {
  fetcher?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function code(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const output = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(output) ? output : undefined;
}

function decimalPlaces(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return fallback;
  const decimals = value.split(".")[1]?.replace(/0+$/, "").length ?? 0;
  return Math.max(0, Math.min(8, decimals));
}

function candidateRef(draft: MarketInstrumentDraft): string {
  return `cand_${createHash("sha256").update(JSON.stringify(draft)).digest("hex").slice(0, 32)}`;
}

async function fetchJson(url: string, fetcher: FetchLike, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json", "User-Agent": "ulanzi-tc002-content-studio/3.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`catalog returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const METALS: readonly { code: string; name: string; aliases: string[]; decimals: number }[] = [
  { code: "XAU", name: "Gold", aliases: ["gold", "黄金"], decimals: 2 },
  { code: "XAG", name: "Silver", aliases: ["silver", "白银"], decimals: 3 },
  { code: "XPT", name: "Platinum", aliases: ["platinum", "铂金"], decimals: 2 },
  { code: "XPD", name: "Palladium", aliases: ["palladium", "钯金"], decimals: 2 },
];

export class MarketSearchService {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private products?: CacheEntry<CoinbaseProduct[]>;
  private currencies?: CacheEntry<CoinbaseCurrency[]>;
  private readonly candidates = new Map<string, CandidateCacheEntry>();

  constructor(options: MarketSearchServiceOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  private async coinbaseProducts(): Promise<CoinbaseProduct[]> {
    if (this.products && this.products.expiresAt > this.now()) return this.products.value;
    const body = await fetchJson(COINBASE_PRODUCTS_URL, this.fetcher, this.timeoutMs);
    if (!Array.isArray(body)) throw new Error("Coinbase product catalog is invalid");
    const products: CoinbaseProduct[] = [];
    for (const value of body) {
      const input = asRecord(value);
      const id = code(input?.id);
      const base = code(input?.base_currency);
      const quote = code(input?.quote_currency);
      if (!input || !id || !base || !quote || input.trading_disabled === true) continue;
      if (typeof input.status === "string" && input.status !== "online") continue;
      products.push({
        id,
        base,
        quote,
        name: typeof input.display_name === "string" ? input.display_name.trim() : `${base}/${quote}`,
        decimals: decimalPlaces(input.quote_increment, ["USD", "EUR", "GBP"].includes(quote) ? 2 : 6),
      });
    }
    this.products = { value: products, expiresAt: this.now() + CACHE_TTL_MS };
    return products;
  }

  private async coinbaseCurrencies(): Promise<CoinbaseCurrency[]> {
    if (this.currencies && this.currencies.expiresAt > this.now()) return this.currencies.value;
    const body = await fetchJson(COINBASE_CURRENCIES_URL, this.fetcher, this.timeoutMs);
    if (!Array.isArray(body)) throw new Error("Coinbase currency catalog is invalid");
    const currencies: CoinbaseCurrency[] = [];
    for (const value of body) {
      const input = asRecord(value);
      const id = code(input?.id);
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!input || !id || !name || name.length > 120) continue;
      const network = typeof input.default_network === "string"
        && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.default_network.trim())
        ? input.default_network.trim().toLowerCase()
        : undefined;
      const supportedNetworks = Array.isArray(input.supported_networks)
        ? input.supported_networks.map(asRecord).filter(Boolean) as Record<string, unknown>[]
        : [];
      const defaultNetwork = network
        ? supportedNetworks.find((candidate) =>
          typeof candidate.id === "string" && candidate.id.trim().toLowerCase() === network
        )
        : undefined;
      const rawContractAddress = typeof defaultNetwork?.contract_address === "string"
        ? defaultNetwork.contract_address.trim()
        : "";
      const contractAddress = /^[A-Za-z0-9]{8,160}$/.test(rawContractAddress)
        ? rawContractAddress
        : undefined;
      currencies.push({
        id,
        name,
        ...(network === undefined ? {} : { network }),
        ...(contractAddress === undefined ? {} : { contractAddress }),
      });
    }
    this.currencies = { value: currencies, expiresAt: this.now() + CACHE_TTL_MS };
    return currencies;
  }

  private currencyCatalog(): Currency[] {
    const names = new Intl.DisplayNames(["en"], { type: "currency" });
    return Intl.supportedValuesOf("currency").flatMap((currencyCode) => {
      const normalized = code(currencyCode);
      if (!normalized) return [];
      return [{ code: normalized, name: names.of(normalized) ?? normalized }];
    });
  }

  private remember(draft: MarketInstrumentDraft, sourceLabel: string): MarketSearchCandidate {
    const ref = candidateRef(draft);
    for (const [key, value] of this.candidates) {
      if (value.expiresAt <= this.now()) this.candidates.delete(key);
    }
    this.candidates.delete(ref);
    this.candidates.set(ref, { draft: structuredClone(draft), expiresAt: this.now() + 15 * 60_000 });
    while (this.candidates.size > 512) {
      const oldest = this.candidates.keys().next().value;
      if (!oldest) break;
      this.candidates.delete(oldest);
    }
    return {
      ...structuredClone(draft),
      candidateRef: ref,
      pair: `${draft.baseCode}/${draft.quoteCode}`,
      sourceLabel,
    };
  }

  resolve(candidate: string): MarketInstrumentDraft {
    const cached = this.candidates.get(candidate);
    if (!cached || cached.expiresAt <= this.now()) {
      this.candidates.delete(candidate);
      throw new Error("search candidate expired; search again before adding it");
    }
    return structuredClone(cached.draft);
  }

  private async searchCrypto(query: string): Promise<MarketSearchCandidate[]> {
    const normalized = query.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalized) return [];
    const [products, currencies] = await Promise.all([
      this.coinbaseProducts(),
      this.coinbaseCurrencies(),
    ]);
    const currencyById = new Map(currencies.map((currency) => [currency.id, currency]));
    return products
      .filter((product) => {
        const productId = product.id.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const base = product.base.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const assetName = (currencyById.get(product.base)?.name ?? "")
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "");
        return productId === normalized || base.includes(normalized) || assetName.includes(normalized);
      })
      .sort((left, right) => {
        const score = (product: CoinbaseProduct): number => {
          if (product.id.replace(/[^A-Z0-9]/g, "") === normalized) return 0;
          if (product.base === normalized && product.quote === "USD") return 1;
          if (product.base === normalized) return 2;
          const assetName = currencyById.get(product.base)?.name
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "");
          return assetName === normalized ? 3 : 4;
        };
        const leftExact = score(left);
        const rightExact = score(right);
        return leftExact - rightExact || left.id.localeCompare(right.id);
      })
      .slice(0, 20)
      .map((product) => {
        const currency = currencyById.get(product.base);
        return this.remember({
          canonicalKey: canonicalInstrumentKey({ kind: "crypto", provider: "coinbase", symbol: product.id }),
          kind: "crypto",
          displayName: currency?.name ?? product.name,
          displaySymbol: product.base,
          baseCode: product.base,
          quoteCode: product.quote,
          decimals: product.decimals,
          changePeriod: "24H",
          routes: [{ provider: "coinbase", symbol: product.id }],
          ...(currency ? {
            logoIdentity: {
              provider: "coinbase" as const,
              assetId: currency.id,
              name: currency.name,
              ...(currency.network === undefined ? {} : { network: currency.network }),
              ...(currency.contractAddress === undefined ? {} : { contractAddress: currency.contractAddress }),
            },
          } : {}),
          sourceNote: "Coinbase Exchange 公共市场数据；可用范围以交易所产品目录为准。",
        }, "Coinbase Exchange");
      });
  }

  private fxDraft(base: Currency, quote: Currency): MarketSearchCandidate {
    return this.remember({
      canonicalKey: canonicalInstrumentKey({ kind: "fx", base: base.code, quote: quote.code }),
      kind: "fx",
      displayName: `${base.name} / ${quote.name}`,
      displaySymbol: `${base.code}/${quote.code}`,
      baseCode: base.code,
      quoteCode: quote.code,
      decimals: 4,
      changePeriod: "1D",
      routes: [{ provider: "frankfurter", symbol: `${base.code}/${quote.code}` }],
      sourceNote: "Frankfurter / ECB 参考汇率，不是可执行的交易商报价。",
    }, "Frankfurter / ECB 参考汇率");
  }

  private async searchFx(query: string): Promise<MarketSearchCandidate[]> {
    const currencies = this.currencyCatalog();
    const byCode = new Map(currencies.map((currency) => [currency.code, currency]));
    const tokens = query.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
    const compact = query.toUpperCase().replace(/[^A-Z]/g, "");
    let baseCode: string | undefined;
    let quoteCode: string | undefined;
    if (tokens.length >= 2 && byCode.has(tokens[0]!) && byCode.has(tokens[1]!)) {
      [baseCode, quoteCode] = tokens;
    } else if (compact.length === 6 && byCode.has(compact.slice(0, 3)) && byCode.has(compact.slice(3))) {
      baseCode = compact.slice(0, 3);
      quoteCode = compact.slice(3);
    }
    if (baseCode && quoteCode && baseCode !== quoteCode) {
      return [this.fxDraft(byCode.get(baseCode)!, byCode.get(quoteCode)!)];
    }
    const normalized = query.trim().toLowerCase();
    const matches = currencies.filter((currency) =>
      currency.code.toLowerCase().includes(normalized)
      || currency.name.toLowerCase().includes(normalized)
    ).slice(0, 8);
    const usd = byCode.get("USD");
    if (!usd) return [];
    if (matches.some((currency) => currency.code === "USD")) {
      return ["EUR", "CNY", "JPY", "GBP"]
        .flatMap((currencyCode) => byCode.has(currencyCode) ? [this.fxDraft(usd, byCode.get(currencyCode)!)] : []);
    }
    return matches.flatMap((currency) => [this.fxDraft(usd, currency), this.fxDraft(currency, usd)]).slice(0, 16);
  }

  private searchMetals(query: string): MarketSearchCandidate[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return METALS.filter((metal) =>
      metal.code.toLowerCase().includes(normalized)
      || metal.name.toLowerCase().includes(normalized)
      || metal.aliases.some((alias) => alias.includes(normalized))
    ).map((metal) => this.remember({
      canonicalKey: canonicalInstrumentKey({ kind: "metal", symbol: metal.code }),
      kind: "metal",
      displayName: `${metal.name} / US Dollar`,
      displaySymbol: metal.code,
      baseCode: metal.code,
      quoteCode: "USD",
      decimals: metal.decimals,
      routes: [{ provider: "gold-api", symbol: metal.code }],
      sourceNote: "Gold API 公共现货价格；不同品种的数据覆盖可能不同。",
    }, "Gold API"));
  }

  async search(
    rawQuery: string,
    kind?: MarketInstrumentKind,
  ): Promise<MarketSearchResponse> {
    const query = rawQuery.trim();
    if (query.length < 1 || query.length > 48) throw new Error("search query must contain 1-48 characters");
    if (kind === "stock") {
      return {
        query,
        kind,
        results: [],
        notice: "任意股票搜索需要用户自带合规行情 Key（BYOK）；当前内置股票仍可继续使用。",
      };
    }
    const tasks: Promise<MarketSearchCandidate[]>[] = [];
    if (!kind || kind === "crypto") tasks.push(this.searchCrypto(query));
    if (!kind || kind === "fx") tasks.push(this.searchFx(query));
    if (!kind || kind === "metal") tasks.push(Promise.resolve(this.searchMetals(query)));
    const settled = await Promise.allSettled(tasks);
    const results = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    return {
      query,
      ...(kind ? { kind } : {}),
      results: [...new Map(results.map((result) => [result.canonicalKey, result])).values()].slice(0, 24),
      ...(results.length === 0 && settled.some((result) => result.status === "rejected")
        ? { notice: "部分公共目录暂时不可用，请稍后重试。" }
        : {}),
    };
  }
}
