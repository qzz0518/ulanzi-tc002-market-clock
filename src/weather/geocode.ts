import type { FetchLike } from "../price.ts";

const GEOCODING_BASE_URL = "https://geocoding-api.open-meteo.com/v1/search";
// Place coordinates never move; the ten-minute TTL only bounds how long a
// transient upstream hiccup (or upstream data fix) can stay pinned in memory.
const CACHE_TTL_MS = 600_000;
const CACHE_LIMIT = 64;
const RESULT_COUNT = 6;

export const GEOCODE_QUERY_MAX_LENGTH = 64;

/** One candidate place, slimmed to what the studio needs to fill the options. */
export interface GeocodePlace {
  name: string;
  admin1?: string;
  country: string;
  latitude: number;
  longitude: number;
}

export interface GeocodeClientOptions {
  fetcher?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  cacheTtlMs?: number;
}

export function parseGeocodeQuery(value: unknown): string {
  const query = typeof value === "string" ? value.trim() : "";
  if (query.length < 1 || query.length > GEOCODE_QUERY_MAX_LENGTH) {
    throw new Error(`q must contain 1-${GEOCODE_QUERY_MAX_LENGTH} characters`);
  }
  return query;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function slimPlace(entry: unknown): GeocodePlace | undefined {
  const record = asRecord(entry);
  const name = optionalText(record?.name);
  const latitude = Number(record?.latitude);
  const longitude = Number(record?.longitude);
  if (
    !name
    || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || !Number.isFinite(longitude) || Math.abs(longitude) > 180
  ) return undefined;
  // Some entries (oceans, dependencies) ship no country name; the ISO code
  // still identifies them well enough for the "Name, Country" display string.
  const country = optionalText(record?.country) || optionalText(record?.country_code).toUpperCase();
  const admin1 = optionalText(record?.admin1);
  return {
    name,
    ...(admin1 ? { admin1 } : {}),
    country,
    latitude: Math.round(latitude * 10_000) / 10_000,
    longitude: Math.round(longitude * 10_000) / 10_000,
  };
}

/** Open-Meteo geocoding (free, no key): free-text place search in English. */
export class GeocodeClient {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { at: number; places: GeocodePlace[] }>();

  constructor(options: GeocodeClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  }

  private async json(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json", "User-Agent": "ulanzi-tc002-content-studio/3.0" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`open-meteo geocoding returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`open-meteo geocoding timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Top matches for one query; repeats inside the TTL are served from memory. */
  async search(query: string): Promise<GeocodePlace[]> {
    const normalized = parseGeocodeQuery(query);
    const key = normalized.toLowerCase();
    const nowMs = this.now();
    const cached = this.cache.get(key);
    if (cached && nowMs >= cached.at && nowMs - cached.at < this.cacheTtlMs) return cached.places;

    const url = `${GEOCODING_BASE_URL}?name=${encodeURIComponent(normalized)}`
      + `&count=${RESULT_COUNT}&language=en&format=json`;
    const body = asRecord(await this.json(url));
    // No `results` field is Open-Meteo's way of saying "no matches".
    const results = Array.isArray(body?.results) ? body.results : [];
    const places = results
      .map(slimPlace)
      .filter((place): place is GeocodePlace => place !== undefined)
      .slice(0, RESULT_COUNT);
    if (this.cache.size >= CACHE_LIMIT && !this.cache.has(key)) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, { at: nowMs, places });
    return places;
  }
}
