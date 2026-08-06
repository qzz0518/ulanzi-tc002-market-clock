import { getAssetPreset, type AssetId, type ChangePeriod } from "./assets.ts";

export type PriceProvider = "coinbase" | "kraken" | "gold-api" | "frankfurter" | "yahoo";

export interface AssetMarketData {
  assetId: AssetId;
  provider: PriceProvider;
  price: number;
  rawPrice: string;
  fetchedAt: string;
  sourceTime?: string;
  changePercent?: number;
  changePeriod?: ChangePeriod;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const COINBASE_BASE_URL = "https://api.exchange.coinbase.com/products";
const KRAKEN_BASE_URL = "https://api.kraken.com/0/public/Ticker";
const GOLD_URL = "https://api.gold-api.com/price/XAU";
const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v2/rates";
const YAHOO_CHART_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const COINBASE_MAX_TRADE_AGE_MS = 5 * 60_000;
const GOLD_MAX_AGE_MS = 60 * 60_000;

export class PriceSourceError extends Error {
  constructor(
    public readonly assetId: AssetId,
    public readonly provider: PriceProvider,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PriceSourceError";
  }
}

export class AllPriceSourcesUnavailableError extends Error {
  constructor(
    public readonly assetId: AssetId,
    public readonly causes: readonly string[],
  ) {
    super(`all ${assetId.toUpperCase()} price sources are unavailable: ${causes.join("; ")}`);
    this.name = "AllPriceSourcesUnavailableError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parsePositivePrice(
  assetId: AssetId,
  provider: PriceProvider,
  value: unknown,
): { rawPrice: string; price: number } {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new PriceSourceError(assetId, provider, `${provider} returned no numeric price`);
  }
  const rawPrice = String(value);
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0 || price >= 100_000_000) {
    throw new PriceSourceError(assetId, provider, `${provider} returned an invalid price`);
  }
  return { rawPrice, price };
}

async function fetchJson(
  assetId: AssetId,
  provider: PriceProvider,
  url: string,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ulanzi-tc002-content-studio/3.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PriceSourceError(
        assetId,
        provider,
        `${provider} returned HTTP ${response.status}`,
        response.status,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new PriceSourceError(assetId, provider, `${provider} returned invalid JSON`);
    }
  } catch (error) {
    if (error instanceof PriceSourceError) throw error;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `${provider} timed out after ${timeoutMs}ms`
        : `${provider} request failed`;
    throw new PriceSourceError(assetId, provider, message);
  } finally {
    clearTimeout(timer);
  }
}

function percentageChange(price: number, open: number): number | undefined {
  if (!Number.isFinite(open) || open <= 0) return undefined;
  return ((price - open) / open) * 100;
}

export async function fetchCoinbaseAsset(
  assetId: AssetId,
  fetcher: FetchLike = fetch,
  timeoutMs = 5_000,
  nowMs = Date.now(),
): Promise<AssetMarketData> {
  const preset = getAssetPreset(assetId);
  if (!preset.coinbaseProduct) {
    throw new PriceSourceError(assetId, "coinbase", `Coinbase does not support ${assetId}`);
  }
  const tickerUrl = `${COINBASE_BASE_URL}/${preset.coinbaseProduct}/ticker`;
  const ticker = asRecord(await fetchJson(assetId, "coinbase", tickerUrl, fetcher, timeoutMs));
  if (!ticker) {
    throw new PriceSourceError(assetId, "coinbase", "coinbase returned an invalid ticker");
  }
  const { price, rawPrice } = parsePositivePrice(assetId, "coinbase", ticker.price);
  if (typeof ticker.time !== "string") {
    throw new PriceSourceError(assetId, "coinbase", "coinbase returned no trade time");
  }
  const sourceTimeMs = Date.parse(ticker.time);
  if (
    !Number.isFinite(sourceTimeMs) ||
    nowMs - sourceTimeMs > COINBASE_MAX_TRADE_AGE_MS ||
    sourceTimeMs - nowMs > 300_000
  ) {
    throw new PriceSourceError(assetId, "coinbase", "coinbase returned a stale trade");
  }

  let changePercent: number | undefined;
  try {
    const statsUrl = `${COINBASE_BASE_URL}/${preset.coinbaseProduct}/stats`;
    const stats = asRecord(await fetchJson(assetId, "coinbase", statsUrl, fetcher, timeoutMs));
    if (stats) {
      const open = parsePositivePrice(assetId, "coinbase", stats.open).price;
      changePercent = percentageChange(price, open);
    }
  } catch {
    // A valid live price is still useful when the optional 24h stats endpoint fails.
  }

  return {
    assetId,
    provider: "coinbase",
    price,
    rawPrice,
    fetchedAt: new Date(nowMs).toISOString(),
    sourceTime: ticker.time,
    ...(changePercent === undefined
      ? {}
      : { changePercent, changePeriod: preset.changePeriod }),
  };
}

export async function fetchKrakenAsset(
  assetId: AssetId,
  fetcher: FetchLike = fetch,
  timeoutMs = 5_000,
  nowMs = Date.now(),
): Promise<AssetMarketData> {
  const preset = getAssetPreset(assetId);
  if (!preset.krakenPair) {
    throw new PriceSourceError(assetId, "kraken", `Kraken does not support ${assetId}`);
  }
  const url = `${KRAKEN_BASE_URL}?pair=${encodeURIComponent(preset.krakenPair)}`;
  const body = asRecord(await fetchJson(assetId, "kraken", url, fetcher, timeoutMs));
  if (!body || !Array.isArray(body.error) || body.error.length > 0) {
    throw new PriceSourceError(assetId, "kraken", "kraken returned an API error");
  }
  const result = asRecord(body.result);
  const ticker = result ? asRecord(Object.values(result)[0]) : undefined;
  const close = ticker?.c;
  const raw = Array.isArray(close) ? close[0] : undefined;
  const { price, rawPrice } = parsePositivePrice(assetId, "kraken", raw);
  const open = ticker?.o;
  const parsedOpen =
    typeof open === "string" || typeof open === "number"
      ? parsePositivePrice(assetId, "kraken", open).price
      : undefined;
  const changePercent = parsedOpen === undefined ? undefined : percentageChange(price, parsedOpen);
  return {
    assetId,
    provider: "kraken",
    price,
    rawPrice,
    fetchedAt: new Date(nowMs).toISOString(),
    ...(changePercent === undefined
      ? {}
      : { changePercent, changePeriod: preset.changePeriod }),
  };
}

export async function fetchGoldAsset(
  fetcher: FetchLike = fetch,
  timeoutMs = 5_000,
  nowMs = Date.now(),
): Promise<AssetMarketData> {
  const assetId = "gold" as const;
  const body = asRecord(await fetchJson(assetId, "gold-api", GOLD_URL, fetcher, timeoutMs));
  if (!body) {
    throw new PriceSourceError(assetId, "gold-api", "gold-api returned an invalid object");
  }
  const { price, rawPrice } = parsePositivePrice(assetId, "gold-api", body.price);
  const sourceTime = typeof body.updatedAt === "string" ? body.updatedAt : undefined;
  if (sourceTime) {
    const sourceTimeMs = Date.parse(sourceTime);
    if (!Number.isFinite(sourceTimeMs) || nowMs - sourceTimeMs > GOLD_MAX_AGE_MS) {
      throw new PriceSourceError(assetId, "gold-api", "gold-api returned stale data");
    }
  }
  return {
    assetId,
    provider: "gold-api",
    price,
    rawPrice,
    fetchedAt: new Date(nowMs).toISOString(),
    ...(sourceTime ? { sourceTime } : {}),
  };
}

function utcDateDaysAgo(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
}

export async function fetchUsdCnyAsset(
  fetcher: FetchLike = fetch,
  timeoutMs = 5_000,
  nowMs = Date.now(),
): Promise<AssetMarketData> {
  const assetId = "usdcny" as const;
  const url = `${FRANKFURTER_BASE_URL}?base=USD&quotes=CNY&from=${utcDateDaysAgo(nowMs, 7)}`;
  const body = await fetchJson(assetId, "frankfurter", url, fetcher, timeoutMs);
  if (!Array.isArray(body)) {
    throw new PriceSourceError(assetId, "frankfurter", "frankfurter returned an invalid series");
  }
  const rows = body
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== undefined)
    .filter((row) => row.base === "USD" && row.quote === "CNY" && typeof row.date === "string")
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  if (rows.length < 1) {
    throw new PriceSourceError(assetId, "frankfurter", "frankfurter returned no USD/CNY rate");
  }
  const latest = rows.at(-1)!;
  const previous = rows.at(-2);
  const { price, rawPrice } = parsePositivePrice(assetId, "frankfurter", latest.rate);
  const previousRate =
    previous === undefined
      ? undefined
      : parsePositivePrice(assetId, "frankfurter", previous.rate).price;
  const changePercent =
    previousRate === undefined ? undefined : percentageChange(price, previousRate);
  return {
    assetId,
    provider: "frankfurter",
    price,
    rawPrice,
    fetchedAt: new Date(nowMs).toISOString(),
    sourceTime: String(latest.date),
    ...(changePercent === undefined
      ? {}
      : { changePercent, changePeriod: "1D" as const }),
  };
}

export async function fetchYahooStockAsset(
  assetId: AssetId,
  fetcher: FetchLike = fetch,
  timeoutMs = 5_000,
  nowMs = Date.now(),
): Promise<AssetMarketData> {
  const preset = getAssetPreset(assetId);
  if (!preset.yahooSymbol) {
    throw new PriceSourceError(assetId, "yahoo", `Yahoo Finance does not support ${assetId}`);
  }
  const body = asRecord(
    await fetchJson(
      assetId,
      "yahoo",
      `${YAHOO_CHART_BASE_URL}/${encodeURIComponent(preset.yahooSymbol)}`,
      fetcher,
      timeoutMs,
    ),
  );
  const chart = body ? asRecord(body.chart) : undefined;
  const result = chart?.result;
  const firstResult = Array.isArray(result) ? asRecord(result[0]) : undefined;
  const meta = firstResult ? asRecord(firstResult.meta) : undefined;
  if (!meta) {
    throw new PriceSourceError(assetId, "yahoo", "yahoo returned no quote metadata");
  }
  const { price, rawPrice } = parsePositivePrice(
    assetId,
    "yahoo",
    meta.regularMarketPrice,
  );
  const previous = parsePositivePrice(
    assetId,
    "yahoo",
    meta.chartPreviousClose ?? meta.previousClose,
  ).price;
  const sourceTimeSeconds = Number(meta.regularMarketTime);
  const sourceTime = Number.isFinite(sourceTimeSeconds) && sourceTimeSeconds > 0
    ? new Date(sourceTimeSeconds * 1_000).toISOString()
    : undefined;
  return {
    assetId,
    provider: "yahoo",
    price,
    rawPrice,
    fetchedAt: new Date(nowMs).toISOString(),
    ...(sourceTime ? { sourceTime } : {}),
    changePercent: percentageChange(price, previous),
    changePeriod: "1D",
  };
}

export interface MarketDataClientOptions {
  fetcher?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export class MarketDataClient {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: MarketDataClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  async getAsset(assetId: AssetId): Promise<AssetMarketData> {
    const nowMs = this.now();
    if (getAssetPreset(assetId).kind === "stock") {
      return fetchYahooStockAsset(assetId, this.fetcher, this.timeoutMs, nowMs);
    }
    if (assetId === "gold") {
      return fetchGoldAsset(this.fetcher, this.timeoutMs, nowMs);
    }
    if (assetId === "usdcny") {
      return fetchUsdCnyAsset(this.fetcher, this.timeoutMs, nowMs);
    }

    const errors: string[] = [];
    try {
      return await fetchCoinbaseAsset(assetId, this.fetcher, this.timeoutMs, nowMs);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "coinbase failed");
    }
    try {
      return await fetchKrakenAsset(assetId, this.fetcher, this.timeoutMs, nowMs);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "kraken failed");
    }
    throw new AllPriceSourcesUnavailableError(assetId, errors);
  }
}
