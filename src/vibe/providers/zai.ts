/**
 * Z.ai (Zhipu GLM Coding Plan) usage, from the user's own API key.
 *
 * Two undocumented endpoints behind Z.ai's own subscription page: the quota call
 * is required and carries the meters, the subscription call is best-effort and
 * only names the plan — a failure there must never blank the meters.
 *
 * Two traps live in this payload and both are load-bearing below. The Session /
 * Weekly split is derived from each entry's own `(unit, number)` window rather
 * than its position in the array, and on a TIME_LIMIT entry the field names are
 * inverted: `usage` is the ceiling and `currentValue` is what has been spent.
 */

import { request, requireSuccess } from "./http.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  consumptionMetric,
  epochMs,
  PERIOD_MS,
  type JsonRecord,
} from "./parse.ts";
import {
  VibeCredentialsMissingError,
  VibeRequestError,
  type VibeAdapterContext,
  type VibeMetric,
  type VibeProviderAdapter,
  type VibeProviderResult,
} from "./types.ts";

const PROVIDER_ID = "zai";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";

/**
 * Z.ai encodes a window as a `(unit, number)` pair. Only these four unit codes
 * have ever been observed; an unknown one skips the entry instead of failing, so
 * a future window cannot hide the meters we do understand.
 */
const UNIT_MS: Readonly<Record<number, number>> = {
  3: 60 * 60 * 1000, // hours
  4: PERIOD_MS.day,
  5: PERIOD_MS.month, // Z.ai's "month" is a flat 30 days
  6: PERIOD_MS.week,
};

export const zaiAdapter: VibeProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "Z.ai",

  async detect(context: VibeAdapterContext): Promise<boolean> {
    return readKey(context) !== undefined;
  },

  async fetchUsage(context: VibeAdapterContext): Promise<VibeProviderResult> {
    const apiKey = readKey(context);
    if (apiKey === undefined) {
      throw new VibeCredentialsMissingError(PROVIDER_ID, "no Z.ai API key");
    }

    // The plan lookup cannot fail the refresh, so both calls fly together and only
    // the quota's rejection propagates.
    const [root, plan] = await Promise.all([
      fetchQuota(context, apiKey),
      fetchPlan(context, apiKey),
    ]);

    // A valid key on an account without a coding plan gets a 2xx carrying
    // `{"success":false,"msg":"…coding plan"}`. Say so rather than showing three
    // blank meters that do not explain themselves.
    if (isNoCodingPlan(root)) {
      throw new VibeRequestError(PROVIDER_ID, "no active GLM Coding Plan");
    }

    const metrics = mapQuota(root);
    return {
      plan,
      metrics,
      // An empty `limits` array is a valid state (plan active, nothing metered yet),
      // distinct from the invalid-response throws above.
      note: metrics.length === 0 ? "这个套餐没有可读的用量指标。" : undefined,
    };
  },
};

function readKey(context: VibeAdapterContext): string | undefined {
  const key = context.apiKey(PROVIDER_ID)?.trim();
  return key ? key : undefined;
}

async function fetchQuota(context: VibeAdapterContext, apiKey: string): Promise<JsonRecord> {
  const response = await request(QUOTA_URL, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: PROVIDER_ID,
  });
  const root = asRecord(requireSuccess(response, PROVIDER_ID, context.now()));
  if (root === undefined) throw invalidResponse();
  return root;
}

/**
 * Plan name only, and never fatal: a throw, a non-2xx or a rejected key here all
 * just mean "no plan name this refresh".
 */
async function fetchPlan(context: VibeAdapterContext, apiKey: string): Promise<string | undefined> {
  try {
    const response = await request(SUBSCRIPTION_URL, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      timeoutMs: context.timeoutMs,
      fetch: context.fetch,
      providerId: PROVIDER_ID,
    });
    if (!response.ok) return undefined;
    const body: unknown = JSON.parse(response.text);
    const list = asArray(asRecord(body)?.data);
    // Verbatim vendor wording ("GLM Coding Pro"), first entry only — Z.ai lists the
    // active subscription first and the rest are expired cycles.
    return asString(asRecord(list?.[0])?.productName);
  } catch {
    return undefined;
  }
}

function isNoCodingPlan(root: JsonRecord): boolean {
  // Both halves are required: a real boolean `false` plus the ASCII phrase that
  // survives Z.ai's localisation, so an unrelated `success:false` cannot trip it.
  if (root.success !== false) return false;
  const message = typeof root.msg === "string" ? root.msg.toLowerCase() : "";
  return message.includes("coding plan");
}

function mapQuota(root: JsonRecord): VibeMetric[] {
  // The array lives at `data.limits`, but older revisions put it at the root.
  let container = root;
  if ("data" in root) {
    const data = asRecord(root.data);
    if (data === undefined) throw invalidResponse();
    container = data;
  }
  const rawLimits = asArray(container.limits);
  if (rawLimits === undefined) throw invalidResponse();
  const limits: JsonRecord[] = [];
  for (const entry of rawLimits) {
    const record = asRecord(entry);
    if (record === undefined) throw invalidResponse();
    limits.push(record);
  }
  if (limits.length === 0) return [];

  const metrics: VibeMetric[] = [];
  const seen = new Set<string>();
  for (const entry of limits) {
    if (!matchesType(entry, "TOKENS_LIMIT")) continue;
    const window = classifyTokenWindow(entry);
    if (window === undefined) continue; // unknown unit: forward compatibility
    // Sub-daily is the rolling session pool, anything longer is the weekly one.
    const key = window < PERIOD_MS.day ? "session" : "weekly";
    // Z.ai sends one entry per window; a duplicate would collide on the key, so
    // the first (the live one) wins rather than the last silently overwriting it.
    if (seen.has(key)) continue;
    seen.add(key);
    metrics.push(percentMetric(entry, key, key === "session" ? "Session" : "Weekly", window));
  }

  const webSearch = limits.find((entry) => matchesType(entry, "TIME_LIMIT"));
  if (webSearch !== undefined) metrics.push(webSearchMetric(webSearch));

  return metrics;
}

/** Z.ai has used `type` and `name` for the same field across revisions. */
function matchesType(entry: JsonRecord, type: string): boolean {
  return entry.type === type || entry.name === type;
}

/** The entry's window in ms, or undefined when its unit code is one we don't know. */
function classifyTokenWindow(entry: JsonRecord): number | undefined {
  const unit = asNumber(entry.unit);
  const number = asNumber(entry.number);
  // A recognised entry with no window is a broken payload, not a skippable one.
  if (unit === undefined || number === undefined || number <= 0) throw invalidResponse();
  const unitMs = UNIT_MS[unit];
  if (unitMs === undefined) return undefined;
  const duration = unitMs * number;
  if (!Number.isFinite(duration) || duration < 1) throw invalidResponse();
  return duration;
}

function percentMetric(entry: JsonRecord, key: string, label: string, windowMs: number): VibeMetric {
  const percentage = asNumber(entry.percentage);
  // Missing percentage must never render as 0% — that would read as "plenty left".
  if (percentage === undefined) throw invalidResponse();
  const metric = consumptionMetric({
    key,
    label,
    unit: "percent",
    used: percentage,
    limit: 100,
    resetsAtMs: epochMs(entry.nextResetTime),
    windowSeconds: Math.round(windowMs / 1000),
  });
  if (metric === undefined) throw invalidResponse();
  return metric;
}

/** TIME_LIMIT is the monthly web-search / reader pool — with its field names inverted. */
function webSearchMetric(entry: JsonRecord): VibeMetric {
  const used = asNumber(entry.currentValue);
  const limit = asNumber(entry.usage);
  if (used === undefined || limit === undefined || used < 0 || limit < 0) throw invalidResponse();
  const metric = consumptionMetric({
    key: "webSearches",
    label: "Web Searches",
    unit: "searches",
    used,
    limit,
    resetsAtMs: epochMs(entry.nextResetTime),
    // The cadence is the monthly renewal regardless of the entry's own unit code,
    // which describes the counting window rather than the billing cycle.
    windowSeconds: PERIOD_MS.month / 1000,
  });
  if (metric === undefined) throw invalidResponse();
  return metric;
}

function invalidResponse(): VibeRequestError {
  return new VibeRequestError(PROVIDER_ID, "usage response invalid");
}
