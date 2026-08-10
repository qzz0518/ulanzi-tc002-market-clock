import type { FetchLike } from "../price.ts";

const OPEN_METEO_BASE_URL = "https://api.open-meteo.com/v1/forecast";
// Open-Meteo refreshes its `current` block roughly every 15 minutes, so one
// request per coordinate per 10 minutes is the fastest useful cadence.
const MIN_REFRESH_MS = 600_000;
const CACHE_LIMIT = 24;

export type WeatherCondition = "clear" | "cloud" | "fog" | "rain" | "snow" | "thunder";

export interface WeatherObservation {
  latitude: number;
  longitude: number;
  condition: WeatherCondition;
  weatherCode: number;
  temperatureC: number;
  precipitationMm: number;
  cloudCoverPercent: number;
  fetchedAt: string;
  sourceTime?: string;
}

export interface WeatherClientOptions {
  fetcher?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  minRefreshMs?: number;
}

/** Thrown when no weather client is wired up, so renderers can show a hint instead of failing. */
export class WeatherNotConfiguredError extends Error {
  constructor(message = "weather client is not configured") {
    super(message);
    this.name = "WeatherNotConfiguredError";
  }
}

export function parseCoordinate(value: unknown, limit: 90 | 180, label: string): number {
  const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
  const number = text.length > 0 ? Number(text) : Number.NaN;
  if (!Number.isFinite(number) || Math.abs(number) > limit) {
    throw new Error(`${label} must be a decimal degree between -${limit} and ${limit}`);
  }
  return Math.round(number * 10_000) / 10_000;
}

/** WMO 4677 code groups, collapsed to the six particle styles the panel can render. */
export function classifyWeatherCode(code: number, cloudCoverPercent: number): WeatherCondition {
  if (code >= 95) return "thunder";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (code >= 2) return "cloud";
  return cloudCoverPercent >= 70 ? "cloud" : "clear";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`open-meteo returned no ${field}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`open-meteo returned an invalid ${field}`);
  }
  return number;
}

export class WeatherClient {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly minRefreshMs: number;
  private readonly cache = new Map<string, { at: number; data: WeatherObservation }>();

  constructor(options: WeatherClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.minRefreshMs = options.minRefreshMs ?? MIN_REFRESH_MS;
  }

  private async json(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json", "User-Agent": "ulanzi-tc002-content-studio/3.0" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`open-meteo returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`open-meteo timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Current conditions for one coordinate; repeat calls inside the minimum refresh window reuse the cache. */
  async getCurrent(latitude: number | string, longitude: number | string): Promise<WeatherObservation> {
    const lat = parseCoordinate(latitude, 90, "latitude");
    const lon = parseCoordinate(longitude, 180, "longitude");
    const nowMs = this.now();
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const cached = this.cache.get(key);
    if (cached && nowMs >= cached.at && nowMs - cached.at < this.minRefreshMs) return cached.data;

    const url = `${OPEN_METEO_BASE_URL}?latitude=${lat}&longitude=${lon}`
      + "&current=temperature_2m,precipitation,weather_code,cloud_cover";
    const body = asRecord(await this.json(url));
    const current = body ? asRecord(body.current) : undefined;
    if (!current) throw new Error("open-meteo returned no current conditions");
    const temperatureC = boundedNumber(current.temperature_2m, -120, 100, "temperature_2m");
    const precipitationMm = boundedNumber(current.precipitation, 0, 500, "precipitation");
    const cloudCoverPercent = boundedNumber(current.cloud_cover, 0, 100, "cloud_cover");
    const weatherCode = Math.round(boundedNumber(current.weather_code, 0, 99, "weather_code"));
    const observation: WeatherObservation = {
      latitude: lat,
      longitude: lon,
      condition: classifyWeatherCode(weatherCode, cloudCoverPercent),
      weatherCode,
      temperatureC,
      precipitationMm,
      cloudCoverPercent,
      fetchedAt: new Date(nowMs).toISOString(),
      ...(typeof current.time === "string" ? { sourceTime: current.time } : {}),
    };
    if (this.cache.size >= CACHE_LIMIT && !this.cache.has(key)) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, { at: nowMs, data: observation });
    return observation;
  }
}
