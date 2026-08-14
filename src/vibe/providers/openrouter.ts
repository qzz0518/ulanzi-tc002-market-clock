/**
 * OpenRouter usage, from the user's own API key.
 *
 * No OAuth, no CLI credential file we can piggyback on: the key is whatever the
 * user pasted into the console (or exported as OPENROUTER_API_KEY), and it
 * reaches us through `context.apiKey`. Two public GETs carry everything:
 * `/credits` is the account-wide prepaid pool, `/key` is this key's own spend,
 * cap and tier.
 *
 * The endpoints are mapped independently on purpose. OpenRouter gates some
 * endpoints per key type, so a provisioning key can get 403 on `/credits` while
 * `/key` answers fine — showing half the panel beats blanking it, and "invalid
 * key" is only claimed when BOTH endpoints reject the credential.
 */

import { request, requireSuccess } from "./http.ts";
import { asNumber, asRecord, balanceMetric, consumptionMetric, pick, type JsonRecord } from "./parse.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRequestError,
  type VibeAdapterContext,
  type VibeMetric,
  type VibeProviderAdapter,
  type VibeProviderResult,
  type VibeSpendLine,
} from "./types.ts";

const PROVIDER_ID = "openrouter";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const KEY_URL = "https://openrouter.ai/api/v1/key";

/** Per-endpoint outcome, because one failing must not decide the whole refresh. */
type EndpointResult =
  | { status: "ok"; data: JsonRecord }
  | { status: "auth" }
  | { status: "failed"; error: Error };

/** The spend rows `/key` reports, in the order OpenRouter's own dashboard shows them. */
const SPEND_FIELDS: readonly (readonly [string, string])[] = [
  ["usage_daily", "Today"],
  ["usage_weekly", "This Week"],
  ["usage_monthly", "This Month"],
];

export const openrouterAdapter: VibeProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "OpenRouter",

  async detect(context: VibeAdapterContext): Promise<boolean> {
    return readKey(context) !== undefined;
  },

  async fetchUsage(context: VibeAdapterContext): Promise<VibeProviderResult> {
    const apiKey = readKey(context);
    if (apiKey === undefined) {
      throw new VibeCredentialsMissingError(PROVIDER_ID, "no OpenRouter API key");
    }

    // Independent endpoints, so they run together: neither result gates the other
    // and the round trip is the whole cost of this refresh.
    const [credits, key] = await Promise.all([
      loadEndpoint(CREDITS_URL, apiKey, context),
      loadEndpoint(KEY_URL, apiKey, context),
    ]);

    const metrics: VibeMetric[] = [];
    const spendLines: VibeSpendLine[] = [];
    let plan: string | undefined;

    if (credits.status === "ok") metrics.push(...creditsMetrics(credits.data));
    if (key.status === "ok") {
      const mapped = keyMetrics(key.data);
      plan = mapped.plan;
      metrics.push(...mapped.metrics);
      spendLines.push(...mapped.spendLines);
    }

    // Anything at all from either endpoint is a successful refresh.
    if (metrics.length > 0 || spendLines.length > 0) {
      return {
        plan,
        metrics,
        spendLines: spendLines.length > 0 ? spendLines : undefined,
      };
    }

    // Nothing usable. Only a key both endpoints rejected is actually invalid.
    if (credits.status === "auth" && key.status === "auth") {
      throw new VibeCredentialsExpiredError(PROVIDER_ID, "OpenRouter API key rejected");
    }
    const failure = (credits.status === "failed" ? credits.error : undefined)
      ?? (key.status === "failed" ? key.error : undefined);
    throw failure ?? new VibeRequestError(PROVIDER_ID, "usage data unavailable");
  },
};

function readKey(context: VibeAdapterContext): string | undefined {
  const key = context.apiKey(PROVIDER_ID)?.trim();
  return key ? key : undefined;
}

/**
 * One endpoint call, classified rather than thrown: 401/403 is "this endpoint
 * refused the key" (which alone proves nothing), everything else is kept as the
 * typed error `requireSuccess` already produced so a 429 stays a 429.
 */
async function loadEndpoint(
  url: string,
  apiKey: string,
  context: VibeAdapterContext,
): Promise<EndpointResult> {
  try {
    const response = await request(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      timeoutMs: context.timeoutMs,
      fetch: context.fetch,
      providerId: PROVIDER_ID,
    });
    const body = requireSuccess(response, PROVIDER_ID, context.now());
    // Every OpenRouter payload is wrapped in `{"data": {...}}`; an empty body, an
    // HTML error page or an array root all mean there is nothing to map.
    const data = asRecord(pick(body, "data"));
    if (data === undefined) {
      return { status: "failed", error: new VibeRequestError(PROVIDER_ID, "usage data unavailable") };
    }
    return { status: "ok", data };
  } catch (error) {
    if (error instanceof VibeCredentialsExpiredError) return { status: "auth" };
    return {
      status: "failed",
      error: error instanceof Error ? error : new VibeRequestError(PROVIDER_ID, String(error)),
    };
  }
}

/** `/credits` → the purchased-credits meter and what is left of it. */
function creditsMetrics(data: JsonRecord): VibeMetric[] {
  const totalUsage = asNumber(data.total_usage);
  // No total spend means the payload said nothing, not that nothing was spent.
  if (totalUsage === undefined) return [];

  const used = Math.max(0, totalUsage);
  // `total_credits` is the lifetime amount added to the account, so it is the
  // ceiling; an account that never topped up reports 0 and gets no meter.
  const totalCredits = Math.max(0, asNumber(data.total_credits) ?? 0);

  const metrics: VibeMetric[] = [];
  if (totalCredits > 0) {
    const credits = consumptionMetric({
      key: "credits",
      label: "Credits",
      unit: "usd",
      used,
      limit: totalCredits,
    });
    if (credits) metrics.push(credits);
  }
  // Balance is emitted even at exactly $0.00 — a measured zero, never "no data".
  const balance = balanceMetric({
    key: "balance",
    label: "Balance",
    unit: "usd",
    available: Math.max(0, totalCredits - used),
  });
  if (balance) metrics.push(balance);
  return metrics;
}

/** `/key` → period spend lines, the optional per-key cap, and the tier. */
function keyMetrics(data: JsonRecord): {
  plan?: string;
  metrics: VibeMetric[];
  spendLines: VibeSpendLine[];
} {
  const spendLines: VibeSpendLine[] = [];
  for (const [field, label] of SPEND_FIELDS) {
    const amount = asNumber(data[field]);
    // Absent → the row is dropped; a present 0 is a measured zero and stays.
    if (amount === undefined) continue;
    spendLines.push({ label, value: formatDollars(Math.max(0, amount)) });
  }

  const metrics: VibeMetric[] = [];
  const limit = asNumber(data.limit);
  // Keys without a spend cap report `null` or 0 here — neither is a meter.
  if (limit !== undefined && limit > 0) {
    const keyLimit = consumptionMetric({
      key: "keyLimit",
      label: "Key Limit",
      unit: "usd",
      used: Math.max(0, asNumber(data.usage) ?? 0),
      limit,
    });
    if (keyLimit) metrics.push(keyLimit);
  }

  // Strictly a JSON boolean: a truthy string here would silently invent a tier.
  const freeTier = typeof data.is_free_tier === "boolean" ? data.is_free_tier : undefined;
  const plan = freeTier === undefined ? undefined : freeTier ? "Free tier" : "Pay as you go";
  return { plan, metrics, spendLines };
}

/** Spend lines are pre-formatted for display; OpenRouter bills in whole USD cents. */
function formatDollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
