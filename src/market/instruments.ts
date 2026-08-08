import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ChangePeriod } from "../assets.ts";

export type MarketInstrumentKind = "crypto" | "fx" | "metal" | "stock";
export type RuntimePriceProvider = "coinbase" | "frankfurter" | "gold-api" | "yahoo";

export interface InstrumentQuoteRoute {
  provider: RuntimePriceProvider;
  symbol: string;
}

export interface MarketLogoIdentity {
  provider: "coinbase";
  assetId: string;
  name: string;
  network?: string;
  contractAddress?: string;
}

export interface MarketInstrumentDraft {
  canonicalKey: string;
  kind: MarketInstrumentKind;
  displayName: string;
  displaySymbol: string;
  baseCode: string;
  quoteCode: string;
  decimals: number;
  changePeriod?: ChangePeriod;
  routes: InstrumentQuoteRoute[];
  logoIdentity?: MarketLogoIdentity;
  sourceNote: string;
}

export interface MarketInstrument extends MarketInstrumentDraft {
  version: 1;
  ref: string;
  iconRef: string;
  createdAt: string;
  updatedAt: string;
}

export type CanonicalIdentity =
  | { kind: "crypto"; provider: "coinbase"; symbol: string }
  | { kind: "fx"; base: string; quote: string }
  | { kind: "metal"; symbol: string }
  | { kind: "stock"; exchange: string; symbol: string };

export const INSTRUMENT_REF_PATTERN = /^ins_[a-f0-9]{24}$/;
export const ICON_REF_PATTERN = /^ico_[a-f0-9]{32}$/;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;
const CANONICAL_KEY_PATTERN = /^(crypto|fx|metal|stock):[A-Z0-9][A-Z0-9:/._-]{1,95}$/;

function normalizedCode(value: string, label: string): string {
  const code = value.trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) throw new Error(`${label} is invalid`);
  return code;
}

export function canonicalInstrumentKey(identity: CanonicalIdentity): string {
  if (identity.kind === "crypto") {
    return `crypto:${identity.provider.toUpperCase()}:${normalizedCode(identity.symbol, "crypto symbol")}`;
  }
  if (identity.kind === "fx") {
    return `fx:${normalizedCode(identity.base, "base currency")}/${normalizedCode(identity.quote, "quote currency")}`;
  }
  if (identity.kind === "metal") {
    return `metal:${normalizedCode(identity.symbol, "metal symbol")}`;
  }
  return `stock:${normalizedCode(identity.exchange, "stock exchange")}:${normalizedCode(identity.symbol, "stock symbol")}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, label: string, maximum = 160): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const output = value.trim();
  if (!output || output.length > maximum) throw new Error(`${label} is invalid`);
  return output;
}

function parseRoute(value: unknown): InstrumentQuoteRoute {
  const input = asRecord(value);
  if (!input) throw new Error("quote route must be an object");
  if (!["coinbase", "frankfurter", "gold-api", "yahoo"].includes(String(input.provider))) {
    throw new Error("quote route provider is invalid");
  }
  return {
    provider: input.provider as RuntimePriceProvider,
    symbol: boundedString(input.symbol, "quote route symbol", 64),
  };
}

function parseLogoIdentity(value: unknown): MarketLogoIdentity {
  const input = asRecord(value);
  if (!input || input.provider !== "coinbase") throw new Error("logo identity provider is invalid");
  const assetId = normalizedCode(boundedString(input.assetId, "logo assetId", 16), "logo assetId");
  const name = boundedString(input.name, "logo asset name", 120);
  const network = input.network === undefined
    ? undefined
    : boundedString(input.network, "logo asset network", 64).toLowerCase();
  if (network !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(network)) {
    throw new Error("logo asset network is invalid");
  }
  const contractAddress = input.contractAddress === undefined
    ? undefined
    : boundedString(input.contractAddress, "logo contract address", 160);
  if (contractAddress !== undefined && !/^[A-Za-z0-9]{8,160}$/.test(contractAddress)) {
    throw new Error("logo contract address is invalid");
  }
  return {
    provider: "coinbase",
    assetId,
    name,
    ...(network === undefined ? {} : { network }),
    ...(contractAddress === undefined ? {} : { contractAddress }),
  };
}

export function validateMarketInstrument(value: unknown): MarketInstrument {
  const input = asRecord(value);
  if (!input || input.version !== 1) throw new Error("instrument must be a version 1 object");
  if (typeof input.ref !== "string" || !INSTRUMENT_REF_PATTERN.test(input.ref)) {
    throw new Error("instrument ref is invalid");
  }
  if (typeof input.iconRef !== "string" || !ICON_REF_PATTERN.test(input.iconRef)) {
    throw new Error("instrument iconRef is invalid");
  }
  if (!["crypto", "fx", "metal", "stock"].includes(String(input.kind))) {
    throw new Error("instrument kind is invalid");
  }
  const canonicalKey = boundedString(input.canonicalKey, "canonicalKey", 100);
  if (!CANONICAL_KEY_PATTERN.test(canonicalKey)) throw new Error("canonicalKey is invalid");
  const decimals = input.decimals;
  if (!Number.isInteger(decimals) || Number(decimals) < 0 || Number(decimals) > 8) {
    throw new Error("instrument decimals must be an integer between 0 and 8");
  }
  if (!Array.isArray(input.routes) || input.routes.length < 1 || input.routes.length > 4) {
    throw new Error("instrument must contain 1-4 quote routes");
  }
  if (input.changePeriod !== undefined && !["24H", "1D"].includes(String(input.changePeriod))) {
    throw new Error("instrument changePeriod is invalid");
  }
  const createdAt = boundedString(input.createdAt, "createdAt", 40);
  const updatedAt = boundedString(input.updatedAt, "updatedAt", 40);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error("instrument timestamps are invalid");
  }
  const instrument: MarketInstrument = {
    version: 1,
    ref: input.ref,
    iconRef: input.iconRef,
    canonicalKey,
    kind: input.kind as MarketInstrumentKind,
    displayName: boundedString(input.displayName, "displayName", 120),
    displaySymbol: boundedString(input.displaySymbol, "displaySymbol", 24),
    baseCode: normalizedCode(boundedString(input.baseCode, "baseCode", 16), "baseCode"),
    quoteCode: normalizedCode(boundedString(input.quoteCode, "quoteCode", 16), "quoteCode"),
    decimals: Number(decimals),
    ...(input.changePeriod === undefined ? {} : { changePeriod: input.changePeriod as ChangePeriod }),
    routes: input.routes.map(parseRoute),
    ...(input.logoIdentity === undefined ? {} : { logoIdentity: parseLogoIdentity(input.logoIdentity) }),
    sourceNote: boundedString(input.sourceNote, "sourceNote", 240),
    createdAt,
    updatedAt,
  };
  const providerByKind: Readonly<Record<MarketInstrumentKind, RuntimePriceProvider>> = {
    crypto: "coinbase",
    fx: "frankfurter",
    metal: "gold-api",
    stock: "yahoo",
  };
  if (instrument.routes.some((route) => route.provider !== providerByKind[instrument.kind])) {
    throw new Error(`instrument quote route does not match ${instrument.kind} identity`);
  }
  if (instrument.logoIdentity && (
    instrument.kind !== "crypto"
    || instrument.logoIdentity.assetId !== instrument.baseCode
  )) {
    throw new Error("logo identity does not match crypto asset identity");
  }
  const expectedCanonical = instrument.kind === "crypto"
    ? canonicalInstrumentKey({ kind: "crypto", provider: "coinbase", symbol: instrument.routes[0]!.symbol })
    : instrument.kind === "fx"
      ? canonicalInstrumentKey({ kind: "fx", base: instrument.baseCode, quote: instrument.quoteCode })
      : instrument.kind === "metal"
        ? canonicalInstrumentKey({ kind: "metal", symbol: instrument.baseCode })
        : undefined;
  if (expectedCanonical && instrument.canonicalKey !== expectedCanonical) {
    throw new Error("instrument canonical identity does not match its quote route");
  }
  if (
    instrument.kind === "fx"
    && instrument.routes.some((route) => route.symbol.toUpperCase() !== `${instrument.baseCode}/${instrument.quoteCode}`)
  ) {
    throw new Error("FX route does not match base/quote identity");
  }
  if (
    instrument.kind === "metal"
    && instrument.routes.some((route) => route.symbol.toUpperCase() !== instrument.baseCode)
  ) {
    throw new Error("metal route does not match instrument identity");
  }
  if (
    instrument.kind === "stock"
    && instrument.canonicalKey.split(":").at(-1) !== instrument.baseCode
  ) {
    throw new Error("stock canonical identity does not match its symbol");
  }
  return instrument;
}

export interface InstrumentStoreOptions {
  now?: () => number;
}

export class InstrumentStore {
  private readonly now: () => number;
  private readonly byRef = new Map<string, MarketInstrument>();
  private readonly byCanonicalKey = new Map<string, MarketInstrument>();
  private issues: string[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly directory: string, options: InstrumentStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  allocateRef(): string {
    return `ins_${randomBytes(12).toString("hex")}`;
  }

  async load(): Promise<void> {
    this.byRef.clear();
    this.byCanonicalKey.clear();
    this.issues = [];
    await mkdir(this.directory, { recursive: true });
    const entries = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    for (const name of entries) {
      try {
        const instrument = validateMarketInstrument(JSON.parse(await readFile(join(this.directory, name), "utf8")));
        if (name !== `${instrument.ref}.json`) throw new Error("file name does not match instrument ref");
        if (this.byRef.has(instrument.ref)) throw new Error("duplicate instrument ref");
        if (this.byCanonicalKey.has(instrument.canonicalKey)) {
          throw new Error(`duplicate canonical identity ${instrument.canonicalKey}`);
        }
        this.byRef.set(instrument.ref, instrument);
        this.byCanonicalKey.set(instrument.canonicalKey, instrument);
      } catch (error) {
        this.issues.push(`${name}: ${error instanceof Error ? error.message : "invalid instrument"}`);
      }
    }
  }

  list(): MarketInstrument[] {
    return [...this.byRef.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.ref.localeCompare(right.ref))
      .map((instrument) => structuredClone(instrument));
  }

  get(ref: string): MarketInstrument | undefined {
    const instrument = this.byRef.get(ref);
    return instrument ? structuredClone(instrument) : undefined;
  }

  getByCanonicalKey(canonicalKey: string): MarketInstrument | undefined {
    const instrument = this.byCanonicalKey.get(canonicalKey);
    return instrument ? structuredClone(instrument) : undefined;
  }

  has(ref: string): boolean {
    return this.byRef.has(ref);
  }

  getIssues(): string[] {
    return [...this.issues];
  }

  async save(input: MarketInstrumentDraft & { ref: string; iconRef: string }): Promise<MarketInstrument> {
    let result: MarketInstrument | undefined;
    const operation = async () => {
      const existing = this.byCanonicalKey.get(input.canonicalKey);
      if (existing) {
        result = existing;
        return;
      }
      const timestamp = new Date(this.now()).toISOString();
      const instrument = validateMarketInstrument({
        ...structuredClone(input),
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (this.byRef.has(instrument.ref)) throw new Error(`instrument ref already exists: ${instrument.ref}`);
      await mkdir(this.directory, { recursive: true });
      const path = join(this.directory, `${instrument.ref}.json`);
      const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await Bun.write(temporaryPath, `${JSON.stringify(instrument, null, 2)}\n`);
      await rename(temporaryPath, path);
      this.byRef.set(instrument.ref, instrument);
      this.byCanonicalKey.set(instrument.canonicalKey, instrument);
      result = instrument;
    };
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.then(() => undefined, () => undefined);
    await queued;
    return structuredClone(result!);
  }

  async replaceGeneratedIcon(
    ref: string,
    expectedIconRef: string,
    replacementIconRef: string,
  ): Promise<MarketInstrument> {
    if (!INSTRUMENT_REF_PATTERN.test(ref)) throw new Error("instrument ref is invalid");
    if (!ICON_REF_PATTERN.test(expectedIconRef) || !ICON_REF_PATTERN.test(replacementIconRef)) {
      throw new Error("instrument icon ref is invalid");
    }
    let result: MarketInstrument | undefined;
    const operation = async () => {
      const existing = this.byRef.get(ref);
      if (!existing) throw new Error(`instrument not found: ${ref}`);
      if (existing.iconRef !== expectedIconRef) {
        throw new Error(`instrument icon changed while refreshing: ${ref}`);
      }
      if (existing.iconRef === replacementIconRef) {
        result = existing;
        return;
      }
      const updated = validateMarketInstrument({
        ...structuredClone(existing),
        iconRef: replacementIconRef,
        updatedAt: new Date(this.now()).toISOString(),
      });
      const path = join(this.directory, `${updated.ref}.json`);
      const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await Bun.write(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`);
      await rename(temporaryPath, path);
      this.byRef.set(updated.ref, updated);
      this.byCanonicalKey.set(updated.canonicalKey, updated);
      result = updated;
    };
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.then(() => undefined, () => undefined);
    await queued;
    return structuredClone(result!);
  }

}
