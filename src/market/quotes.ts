import type { ChangePeriod } from "../assets.ts";
import type { FetchLike } from "../price.ts";
import type { MarketInstrument, RuntimePriceProvider } from "./instruments.ts";

const COINBASE_BASE_URL = "https://api.exchange.coinbase.com/products";
const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v2/rates";
const GOLD_BASE_URL = "https://api.gold-api.com/price";
const YAHOO_CHART_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
// Yahoo 无鉴权接口按内置股票同款 60s 节流；频道刷新可以更快，但同一 symbol 一分钟内只打一次。
const YAHOO_MIN_REFRESH_MS = 60_000;
const COINBASE_MAX_TRADE_AGE_MS = 5 * 60_000;
const GOLD_MAX_AGE_MS = 60 * 60_000;

export interface RuntimeMarketData {
  instrumentRef: string;
  provider: RuntimePriceProvider;
  price: number;
  rawPrice: string;
  fetchedAt: string;
  sourceTime?: string;
  changePercent?: number;
  changePeriod?: ChangePeriod;
}

export interface DynamicMarketDataClientOptions {
  fetcher?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positivePrice(provider: RuntimePriceProvider, value: unknown): { price: number; rawPrice: string } {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${provider} returned no numeric price`);
  const rawPrice = String(value);
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0 || price >= 100_000_000) {
    throw new Error(`${provider} returned an invalid price`);
  }
  return { price, rawPrice };
}

function change(price: number, open: number): number | undefined {
  return Number.isFinite(open) && open > 0 ? (price - open) / open * 100 : undefined;
}

function daysAgo(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
}

export class DynamicMarketDataClient {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly yahooCache = new Map<string, { at: number; data: Omit<RuntimeMarketData, "instrumentRef"> }>();

  constructor(options: DynamicMarketDataClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  private async json(provider: RuntimePriceProvider, url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json", "User-Agent": "ulanzi-tc002-content-studio/3.0" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${provider} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async coinbase(instrument: MarketInstrument, symbol: string, nowMs: number): Promise<RuntimeMarketData> {
    const ticker = asRecord(await this.json("coinbase", `${COINBASE_BASE_URL}/${encodeURIComponent(symbol)}/ticker`));
    if (!ticker) throw new Error("coinbase returned an invalid ticker");
    const { price, rawPrice } = positivePrice("coinbase", ticker.price);
    if (typeof ticker.time !== "string") throw new Error("coinbase returned no trade time");
    const tradeTime = Date.parse(ticker.time);
    if (!Number.isFinite(tradeTime) || nowMs - tradeTime > COINBASE_MAX_TRADE_AGE_MS || tradeTime - nowMs > 300_000) {
      throw new Error("coinbase returned a stale trade");
    }
    let changePercent: number | undefined;
    try {
      const stats = asRecord(await this.json("coinbase", `${COINBASE_BASE_URL}/${encodeURIComponent(symbol)}/stats`));
      if (stats) changePercent = change(price, positivePrice("coinbase", stats.open).price);
    } catch {
      // A live ticker remains useful when the optional stats endpoint is unavailable.
    }
    return {
      instrumentRef: instrument.ref,
      provider: "coinbase",
      price,
      rawPrice,
      fetchedAt: new Date(nowMs).toISOString(),
      sourceTime: ticker.time,
      ...(changePercent === undefined ? {} : { changePercent, changePeriod: "24H" as const }),
    };
  }

  private async frankfurter(instrument: MarketInstrument, symbol: string, nowMs: number): Promise<RuntimeMarketData> {
    const [base, quote] = symbol.split("/");
    if (!base || !quote) throw new Error("frankfurter route must use BASE/QUOTE");
    const url = `${FRANKFURTER_BASE_URL}?base=${encodeURIComponent(base)}&quotes=${encodeURIComponent(quote)}&from=${daysAgo(nowMs, 7)}`;
    const body = await this.json("frankfurter", url);
    if (!Array.isArray(body)) throw new Error("frankfurter returned an invalid series");
    const rows = body.map(asRecord)
      .filter((row): row is Record<string, unknown> => Boolean(row))
      .filter((row) => row.base === base && row.quote === quote && typeof row.date === "string")
      .sort((left, right) => String(left.date).localeCompare(String(right.date)));
    if (rows.length < 1) throw new Error(`frankfurter returned no ${base}/${quote} rate`);
    const latest = rows.at(-1)!;
    const previous = rows.at(-2);
    const { price, rawPrice } = positivePrice("frankfurter", latest.rate);
    const changePercent = previous ? change(price, positivePrice("frankfurter", previous.rate).price) : undefined;
    return {
      instrumentRef: instrument.ref,
      provider: "frankfurter",
      price,
      rawPrice,
      fetchedAt: new Date(nowMs).toISOString(),
      sourceTime: String(latest.date),
      ...(changePercent === undefined ? {} : { changePercent, changePeriod: "1D" as const }),
    };
  }

  private async gold(instrument: MarketInstrument, symbol: string, nowMs: number): Promise<RuntimeMarketData> {
    const body = asRecord(await this.json("gold-api", `${GOLD_BASE_URL}/${encodeURIComponent(symbol)}`));
    if (!body) throw new Error("gold-api returned an invalid object");
    const { price, rawPrice } = positivePrice("gold-api", body.price);
    const sourceTime = typeof body.updatedAt === "string" ? body.updatedAt : undefined;
    if (sourceTime) {
      const sourceTimeMs = Date.parse(sourceTime);
      if (!Number.isFinite(sourceTimeMs) || nowMs - sourceTimeMs > GOLD_MAX_AGE_MS) {
        throw new Error("gold-api returned stale data");
      }
    }
    return {
      instrumentRef: instrument.ref,
      provider: "gold-api",
      price,
      rawPrice,
      fetchedAt: new Date(nowMs).toISOString(),
      ...(sourceTime ? { sourceTime } : {}),
    };
  }

  private async yahoo(instrument: MarketInstrument, symbol: string, nowMs: number): Promise<RuntimeMarketData> {
    const cached = this.yahooCache.get(symbol);
    if (cached && nowMs - cached.at < YAHOO_MIN_REFRESH_MS && nowMs >= cached.at) {
      return { ...cached.data, instrumentRef: instrument.ref };
    }
    const body = asRecord(await this.json("yahoo", `${YAHOO_CHART_BASE_URL}/${encodeURIComponent(symbol)}`));
    const chart = body ? asRecord(body.chart) : undefined;
    const resultList = chart?.result;
    const result = Array.isArray(resultList) ? asRecord(resultList[0]) : undefined;
    const meta = result ? asRecord(result.meta) : undefined;
    if (!meta) throw new Error("yahoo returned no quote metadata");
    const currency = typeof meta.currency === "string" ? meta.currency.trim() : "";
    if (currency && currency.toUpperCase() !== instrument.quoteCode) {
      throw new Error(`yahoo listing trades in ${currency}, not ${instrument.quoteCode}`);
    }
    const { price, rawPrice } = positivePrice("yahoo", meta.regularMarketPrice);
    let changePercent: number | undefined;
    try {
      changePercent = change(price, positivePrice("yahoo", meta.chartPreviousClose ?? meta.previousClose).price);
    } catch {
      // A valid live price stays useful when the previous close is missing (halts, fresh listings).
    }
    const sourceTimeSeconds = Number(meta.regularMarketTime);
    const sourceTime = Number.isFinite(sourceTimeSeconds) && sourceTimeSeconds > 0
      ? new Date(sourceTimeSeconds * 1_000).toISOString()
      : undefined;
    const data: Omit<RuntimeMarketData, "instrumentRef"> = {
      provider: "yahoo",
      price,
      rawPrice,
      fetchedAt: new Date(nowMs).toISOString(),
      ...(sourceTime ? { sourceTime } : {}),
      ...(changePercent === undefined ? {} : { changePercent, changePeriod: "1D" as const }),
    };
    this.yahooCache.set(symbol, { at: nowMs, data });
    return { ...data, instrumentRef: instrument.ref };
  }

  async getInstrument(instrument: MarketInstrument): Promise<RuntimeMarketData> {
    const nowMs = this.now();
    const errors: string[] = [];
    for (const route of instrument.routes) {
      try {
        if (route.provider === "coinbase") return await this.coinbase(instrument, route.symbol, nowMs);
        if (route.provider === "frankfurter") return await this.frankfurter(instrument, route.symbol, nowMs);
        if (route.provider === "gold-api") return await this.gold(instrument, route.symbol, nowMs);
        return await this.yahoo(instrument, route.symbol, nowMs);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `${route.provider} failed`);
      }
    }
    throw new Error(`all ${instrument.displaySymbol} quote routes are unavailable: ${errors.join("; ")}`);
  }
}
