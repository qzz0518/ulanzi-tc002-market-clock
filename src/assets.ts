export const ASSET_IDS = ["btc", "eth", "bnb", "sol", "gold", "usdcny"] as const;

export type AssetId = (typeof ASSET_IDS)[number];
export type AssetKind = "crypto" | "metal" | "fx";
export type ChangePeriod = "24H" | "1D";

export interface AssetPreset {
  id: AssetId;
  name: string;
  symbol: string;
  pair: string;
  kind: AssetKind;
  decimals: number;
  changePeriod?: ChangePeriod;
  coinbaseProduct?: string;
  krakenPair?: string;
  sourceLabel: string;
  sourceNote: string;
}

export const ASSET_PRESETS: readonly AssetPreset[] = [
  {
    id: "btc",
    name: "Bitcoin",
    symbol: "BTC",
    pair: "BTC / USD",
    kind: "crypto",
    decimals: 0,
    changePeriod: "24H",
    coinbaseProduct: "BTC-USD",
    krakenPair: "BTCUSD",
    sourceLabel: "Coinbase · Kraken 备用",
    sourceNote: "最新成交价与 24 小时开盘价",
  },
  {
    id: "eth",
    name: "Ethereum",
    symbol: "ETH",
    pair: "ETH / USD",
    kind: "crypto",
    decimals: 1,
    changePeriod: "24H",
    coinbaseProduct: "ETH-USD",
    krakenPair: "ETHUSD",
    sourceLabel: "Coinbase · Kraken 备用",
    sourceNote: "最新成交价与 24 小时开盘价",
  },
  {
    id: "bnb",
    name: "BNB",
    symbol: "BNB",
    pair: "BNB / USD",
    kind: "crypto",
    decimals: 1,
    changePeriod: "24H",
    coinbaseProduct: "BNB-USD",
    krakenPair: "BNBUSD",
    sourceLabel: "Coinbase · Kraken 备用",
    sourceNote: "最新成交价与 24 小时开盘价",
  },
  {
    id: "sol",
    name: "Solana",
    symbol: "SOL",
    pair: "SOL / USD",
    kind: "crypto",
    decimals: 2,
    changePeriod: "24H",
    coinbaseProduct: "SOL-USD",
    krakenPair: "SOLUSD",
    sourceLabel: "Coinbase · Kraken 备用",
    sourceNote: "最新成交价与 24 小时开盘价",
  },
  {
    id: "gold",
    name: "Gold",
    symbol: "XAU",
    pair: "XAU / USD",
    kind: "metal",
    decimals: 0,
    sourceLabel: "Gold API",
    sourceNote: "实时黄金现货参考价；无免费 24H 开盘字段",
  },
  {
    id: "usdcny",
    name: "美元 / 人民币",
    symbol: "USD/CNY",
    pair: "USD / CNY",
    kind: "fx",
    decimals: 3,
    changePeriod: "1D",
    sourceLabel: "Frankfurter",
    sourceNote: "多家央行日参考汇率，并非逐笔外汇报价",
  },
] as const;

const PRESET_BY_ID = new Map(ASSET_PRESETS.map((preset) => [preset.id, preset]));

export function isAssetId(value: unknown): value is AssetId {
  return typeof value === "string" && PRESET_BY_ID.has(value as AssetId);
}

export function getAssetPreset(id: AssetId): AssetPreset {
  const preset = PRESET_BY_ID.get(id);
  if (!preset) throw new Error(`unknown asset preset: ${id}`);
  return preset;
}
