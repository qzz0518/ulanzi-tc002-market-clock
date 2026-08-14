/**
 * Defensive readers for vendor JSON.
 *
 * Every vendor here ships an undocumented, private usage endpoint, so nothing
 * about a response is guaranteed except that it will change without notice.
 * These helpers narrow one field at a time and return undefined rather than
 * guessing, which is what lets the panel skip a metric instead of printing a
 * number nobody sent (the never-fabricate rule the market path already keeps).
 */

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Numbers arrive as numbers or as numeric strings depending on the vendor and
 * the day. Booleans are rejected on purpose: `true` coercing to 1 would turn a
 * feature flag into a quota.
 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : undefined;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "1") return true;
    if (lowered === "false" || lowered === "0") return false;
  }
  return undefined;
}

/** Walks a dotted path, stopping at the first non-object. */
export function pick(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Some CLIs store their credential file hex-encoded rather than as plain JSON
 * (a leftover from writing the blob through a shell). Try JSON, then hex.
 */
export function parseJsonWithHexFallback(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the hex attempt
  }
  const hex = trimmed.replace(/^0[xX]/, "");
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** Decodes a JWT's payload without verifying it — we only read claims we own. */
export function jwtPayload(token: string): JsonRecord | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  const base64 = parts[1]!.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  try {
    return asRecord(JSON.parse(Buffer.from(padded, "base64").toString("utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Vendors stamp timestamps in half a dozen dialects — a space instead of the
 * `T`, a trailing " UTC", nanosecond fractions, no zone at all. Normalise to
 * something `Date.parse` agrees with, treating a missing zone as UTC.
 */
export function normalizeTimestamp(value: string): string {
  let text = value.trim();
  if (text === "") return text;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) text = text.replace(" ", "T");
  if (text.endsWith(" UTC")) text = `${text.slice(0, -4)}Z`;
  const zoned = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (zoned) {
    const fraction = (zoned[2] ?? "").slice(1, 4).padEnd(3, "0");
    return `${zoned[1]}${fraction === "" ? "" : `.${fraction}`}${zoned[3]}`;
  }
  const naive = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(text);
  if (naive) {
    const fraction = (naive[2] ?? "").slice(1, 4).padEnd(3, "0");
    return `${naive[1]}${fraction === "" ? "" : `.${fraction}`}Z`;
  }
  return text;
}

/** Parses a vendor timestamp to epoch ms, or undefined when it is unusable. */
export function timestampMs(value: unknown): number | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(normalizeTimestamp(text));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Epoch seconds or milliseconds — vendors disagree, and both appear. */
export function epochMs(value: unknown): number | undefined {
  const raw = asNumber(value);
  if (raw === undefined || raw <= 0) return undefined;
  // Anything below this is seconds: 10^11 ms is the year 5138, 10^11 s is not a date.
  return raw < 1e11 ? raw * 1000 : raw;
}

export function isoFromMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** "pro_20x" / "pro-20x" / "pro 20x" → "Pro 20x". */
export function titleCase(value: string, lowercaseTail = true): string {
  return value
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + (lowercaseTail ? word.slice(1).toLowerCase() : word.slice(1)))
    .join(" ");
}

/**
 * Builds a bounded consumption metric from a used/limit pair, dropping it
 * entirely when the vendor did not send enough to say anything true.
 */
export function consumptionMetric(input: {
  key: string;
  label: string;
  unit: string;
  used: number | undefined;
  limit: number | undefined;
  resetsAtMs?: number;
  windowSeconds?: number;
}): VibeMetricLike | undefined {
  const { key, label, unit, used, limit } = input;
  if (used === undefined) return undefined;
  const boundedUsed = Math.max(0, used);
  const boundedLimit = limit === undefined ? undefined : Math.max(0, limit);
  return {
    key,
    label,
    kind: "consumption",
    unit,
    used: unit === "percent" ? clampPercent(boundedUsed) : boundedUsed,
    limit: boundedLimit,
    remaining: boundedLimit === undefined ? undefined : Math.max(0, boundedLimit - boundedUsed),
    utilization: boundedLimit !== undefined && boundedLimit > 0
      ? Math.min(1, Math.max(0, boundedUsed / boundedLimit))
      : undefined,
    resetsAt: isoFromMs(input.resetsAtMs),
    windowSeconds: input.windowSeconds,
  };
}

/** Same, for a "how much is left" pool. */
export function balanceMetric(input: {
  key: string;
  label: string;
  unit: string;
  available: number | undefined;
  resetsAtMs?: number;
}): VibeMetricLike | undefined {
  if (input.available === undefined) return undefined;
  return {
    key: input.key,
    label: input.label,
    kind: "balance",
    unit: input.unit,
    available: input.available,
    resetsAt: isoFromMs(input.resetsAtMs),
  };
}

// Structural mirror of VibeMetric; kept local so this module stays importable
// from tests without dragging the adapter contract along.
interface VibeMetricLike {
  key: string;
  label: string;
  kind: "consumption" | "balance";
  unit: string;
  used?: number;
  limit?: number;
  remaining?: number;
  utilization?: number;
  available?: number;
  resetsAt?: string;
  windowSeconds?: number;
}

export const PERIOD_MS = {
  session: 5 * 60 * 60 * 1000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
} as const;
