/**
 * Antigravity (Google's Codeium/Windsurf-derived IDE) quota.
 *
 * Antigravity never reports tokens or dollars — every meter is a *remaining
 * fraction* of a pool, which is why every metric here is a percent built as
 * `used = (1 - fraction) * 100`.
 *
 * The IDE reaches its own local language server over a loopback Connect-RPC
 * port, which is the fastest source when the app is open. Finding that port
 * needs `ps` + `lsof`, i.e. subprocesses, and this contract deliberately gives
 * an adapter no way to spawn one (that is what keeps it testable), so we take
 * the path that works with the app closed as well: the OAuth token the app
 * leaves in the login keychain, spent against Google's Cloud Code REST API.
 *
 * The token is Google's, so it expires hourly and we refresh it with the app's
 * own installed-app OAuth client. Upstream caches the refreshed token in a file
 * of its own; we cannot write files from here, so the refresh is per-fetch —
 * one extra POST every five minutes, which is cheaper than the file lock would
 * be worth.
 */

import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  consumptionMetric,
  epochMs,
  parseJsonWithHexFallback,
  PERIOD_MS,
  pick,
  timestampMs,
  titleCase,
  type JsonRecord,
} from "./parse.ts";
import {
  isAuthFailure,
  parseBody,
  request,
  retryAfterMs,
  withTokenRefresh,
  type RawResponse,
} from "./http.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type VibeAdapterContext,
  type VibeMetric,
  type VibeProviderAdapter,
  type VibeProviderResult,
} from "./types.ts";

const PROVIDER_ID = "antigravity";

// Written by the Antigravity app and by the `agy` CLI. The old SQLite
// `oauthToken` envelope is deliberately not read: it stopped carrying tokens.
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";

// Two hosts serve the same private API; the daily one is the app's first choice.
const CLOUD_CODE_BASES = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
const QUOTA_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";
const FETCH_MODELS_PATH = "/v1internal:fetchAvailableModels";
const LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
const RETRIEVE_QUOTA_PATH = "/v1internal:retrieveUserQuota";

// The server keys some responses off the caller, and the app sends these two
// bare strings — no version, no product suffix — per endpoint.
const UA_APP = "antigravity";
const UA_CLI = "agy";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Verbatim from the Antigravity app bundle: an installed-app OAuth client, so
// the "secret" is shipped to every user and is not a secret in the usual sense.
const OAUTH_CLIENT_ID = "REDACTED-OAUTH-CLIENT-ID";
const OAUTH_CLIENT_SECRET = "REDACTED-OAUTH-CLIENT-SECRET";
/** Spend a token only if it still has a minute of life; clocks drift. */
const REFRESH_BUFFER_MS = 60_000;

const NOT_SIGNED_IN = "start Antigravity or run `agy` and try again";
const INVALID_CREDENTIAL = "Antigravity credentials are invalid — open Antigravity or run `agy` to sign in again";
const KEYCHAIN_UNREADABLE = "couldn't read Antigravity credentials from the keychain — unlock it or sign in again";
const UNAVAILABLE = "Antigravity usage is temporarily unavailable";

interface AntigravityCredential {
  accessToken?: string;
  refreshToken?: string;
  expiryMs?: number;
}

/**
 * The four buckets the quota summary can carry, in the order the panel shows
 * them. Matching is on `bucketId` alone — never on the display name or the
 * window — so a bucket Google adds later (an image pool, say) is skipped rather
 * than silently folded into someone else's meter.
 */
const SUMMARY_BUCKETS = [
  { bucketId: "gemini-5h", key: "geminiSession", label: "Session", periodMs: PERIOD_MS.session },
  { bucketId: "gemini-weekly", key: "geminiWeekly", label: "Weekly", periodMs: PERIOD_MS.week },
  { bucketId: "3p-5h", key: "nonGeminiSession", label: "Claude", periodMs: PERIOD_MS.session },
  { bucketId: "3p-weekly", key: "nonGeminiWeekly", label: "Claude Weekly", periodMs: PERIOD_MS.week },
] as const;

/**
 * Models that exist in the config but have no pool of their own; counting them
 * would drag a pool's worst-case fraction to whatever placeholder they carry.
 */
const MODEL_BLACKLIST = new Set([
  "MODEL_CHAT_20706",
  "MODEL_CHAT_23310",
  "MODEL_GOOGLE_GEMINI_2_5_FLASH",
  "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
  "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE",
  "MODEL_GOOGLE_GEMINI_2_5_PRO",
  "MODEL_PLACEHOLDER_M19",
  "MODEL_PLACEHOLDER_M9",
  "MODEL_PLACEHOLDER_M12",
]);

export const antigravityAdapter: VibeProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "Antigravity",

  async detect(context) {
    try {
      return await context.keychain.read(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) !== null;
    } catch {
      // A locked or denied keychain is not "signed out". Stay enabled so the
      // fetch can show the repair message instead of the row vanishing.
      return true;
    }
  },

  async fetchUsage(context) {
    const credential = await readCredential(context);
    const refresh = credential.refreshToken === undefined
      ? undefined
      : () => refreshAccessToken(context, credential.refreshToken!);

    const usable = credential.accessToken !== undefined
      && isUsable(credential.expiryMs, context.now());
    // An access token we already know is stale is not worth a round trip, and
    // with no refresh token behind it there is nothing left to try: upstream
    // calls that state "not signed in" rather than "expired", and so do we.
    if (!usable && refresh === undefined) {
      throw new VibeCredentialsMissingError(PROVIDER_ID, NOT_SIGNED_IN);
    }
    const startToken = usable ? credential.accessToken! : await refresh!();

    let activeToken = startToken;
    const response = await withTokenRefresh({
      providerId: PROVIDER_ID,
      token: startToken,
      // A token minted seconds ago that still gets a 401 is a dead grant, not a
      // stale one: minting a second would only ask Google the same question.
      refresh: usable ? refresh : undefined,
      attempt: async (token) => {
        activeToken = token;
        return await callCloudCode(context, {
          path: QUOTA_SUMMARY_PATH,
          token,
          userAgent: UA_APP,
          body: {},
        });
      },
    });

    if (response.status === 429) {
      // Both bases are the same quota; the legacy chain would only spend more
      // of it. Hand the cooldown up so the caller serves last-good values.
      throw new VibeRateLimitedError(PROVIDER_ID, retryAfterMs(response, context.now()));
    }

    if (response.ok) {
      const summary = parseQuotaSummary(parseBody(response));
      // A parsed summary ends the probe even when it is empty: falling through
      // to the legacy endpoints would read "no quota info" as "100% spent".
      if (summary !== null) {
        const assist = await loadCodeAssist(context, activeToken);
        return {
          plan: assist.plan,
          metrics: summary,
          note: summary.length === 0 ? "Antigravity 这次没有返回任何额度区间。" : undefined,
        };
      }
    }

    // 404 here is expected on builds without the summary RPC; any other failure
    // is worth one more look through the endpoints that predate it.
    return await fetchLegacy(context, activeToken);
  },
};

// --- credentials ------------------------------------------------------------

async function readCredential(context: VibeAdapterContext): Promise<AntigravityCredential> {
  let raw: string | null;
  try {
    raw = await context.keychain.read(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    throw new VibeRequestError(PROVIDER_ID, KEYCHAIN_UNREADABLE);
  }
  if (raw === null) throw new VibeCredentialsMissingError(PROVIDER_ID, NOT_SIGNED_IN);
  const credential = extractCredential(raw);
  if (credential === undefined) {
    throw new VibeCredentialsExpiredError(PROVIDER_ID, INVALID_CREDENTIAL);
  }
  return credential;
}

const GO_KEYRING_PREFIX = "go-keyring-base64:";

/** Go's keyring library base64s the blob and stamps its own prefix on it. */
function unwrapGoKeyring(raw: string): string | undefined {
  // `trim()` also strips U+FEFF, which the CLI has been seen writing.
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!trimmed.startsWith(GO_KEYRING_PREFIX)) return trimmed;
  const encoded = trimmed.slice(GO_KEYRING_PREFIX.length).trim();
  if (encoded === "") return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
  return decoded === "" ? undefined : decoded;
}

const ACCESS_TOKEN_KEYS = [
  "access_token", "accessToken", "token", "id_token", "idToken", "bearerToken", "auth_token", "authToken",
];
const REFRESH_TOKEN_KEYS = ["refresh_token", "refreshToken"];
const EXPIRY_KEYS = ["expiry", "expires_at", "expiresAt"];
const NESTED_KEYS = ["tokens", "oauth", "oauth2", "credentials", "auth"];

function extractCredential(raw: string): AntigravityCredential | undefined {
  const text = unwrapGoKeyring(raw);
  if (text === undefined) return undefined;

  const parsed = parseJsonWithHexFallback(text);
  const record = asRecord(parsed);
  if (record !== undefined) return credentialFromObject(record);
  if (typeof parsed === "string") {
    const token = parsed.trim();
    return token === "" ? undefined : { accessToken: token };
  }
  // Structured but tokenless (an array, a number, `null`) — nothing to send.
  if (parsed !== undefined) return undefined;
  // Broken JSON must never be posted as a bearer token.
  if (text.startsWith("{") || text.startsWith("[")) return undefined;
  if (text.startsWith("Bearer ")) {
    const token = text.slice("Bearer ".length).trim();
    return token === "" ? undefined : { accessToken: token };
  }
  return { accessToken: text };
}

function credentialFromObject(record: JsonRecord, depth = 0): AntigravityCredential | undefined {
  // The `agy` shape is {"token":{…},"auth_method":"consumer"}; everything else
  // puts the fields at the top level.
  const source = asRecord(record.token) ?? record;
  const accessToken = firstString(source, ACCESS_TOKEN_KEYS);
  const refreshToken = firstString(source, REFRESH_TOKEN_KEYS);
  if (accessToken === undefined && refreshToken === undefined) {
    if (depth >= 4) return undefined;
    for (const key of NESTED_KEYS) {
      const nested = asRecord(record[key]);
      if (nested === undefined) continue;
      const found = credentialFromObject(nested, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return { accessToken, refreshToken, expiryMs: firstTimestamp(source, EXPIRY_KEYS) };
}

function firstString(record: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstTimestamp(record: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    // ISO first (what the app writes), then epoch — Go's oauth2 marshals both.
    const value = timestampMs(record[key]) ?? epochMs(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function isUsable(expiryMs: number | undefined, nowMs: number): boolean {
  // Unknown expiry means "try it": a rejection is cheap, a false negative
  // costs the user their meters.
  return expiryMs === undefined || expiryMs - nowMs > REFRESH_BUFFER_MS;
}

/** RFC 3986: `encodeURIComponent` leaves `!'()*` alone, Google's parser does not. */
function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function refreshAccessToken(context: VibeAdapterContext, refreshToken: string): Promise<string> {
  const body = [
    `client_id=${formEncode(OAUTH_CLIENT_ID)}`,
    `client_secret=${formEncode(OAUTH_CLIENT_SECRET)}`,
    `refresh_token=${formEncode(refreshToken)}`,
    "grant_type=refresh_token",
  ].join("&");

  const response = await request(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: PROVIDER_ID,
  });

  // 408/429 from the token endpoint are congestion, not a dead grant: telling
  // the user to sign in again over a busy minute would be a lie.
  if (response.status === 429) {
    throw new VibeRateLimitedError(PROVIDER_ID, retryAfterMs(response, context.now()));
  }
  if (response.status !== 408 && response.status >= 400 && response.status < 500) {
    throw new VibeCredentialsExpiredError(PROVIDER_ID, "Antigravity sign-in expired — open Antigravity or run `agy` to refresh");
  }
  if (!response.ok) {
    throw new VibeRequestError(PROVIDER_ID, `token refresh failed (HTTP ${response.status})`, response.status);
  }
  const token = asString(pick(parseBody(response), "access_token"));
  if (token === undefined) throw new VibeRequestError(PROVIDER_ID, "token refresh returned no access_token");
  return token;
}

// --- transport --------------------------------------------------------------

interface CloudCodeCall {
  path: string;
  token: string;
  userAgent: string;
  body: JsonRecord;
}

async function callCloudCode(context: VibeAdapterContext, call: CloudCodeCall): Promise<RawResponse> {
  let last: RawResponse | undefined;
  let lastError: unknown;
  for (const base of CLOUD_CODE_BASES) {
    let response: RawResponse;
    try {
      response = await request(`${base}${call.path}`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${call.token}`,
          "User-Agent": call.userAgent,
        },
        body: JSON.stringify(call.body),
        timeoutMs: context.timeoutMs,
        fetch: context.fetch,
        providerId: PROVIDER_ID,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    // One token, one account, one quota: an auth rejection or a rate limit from
    // the first host is the same answer the second would give.
    if (response.ok || isAuthFailure(response) || response.status === 429) return response;
    last = response;
  }
  if (last !== undefined) return last;
  throw lastError ?? new VibeRequestError(PROVIDER_ID, UNAVAILABLE);
}

/** Body of a 2xx, or undefined when the endpoint simply is not there. */
async function tryCloudCode(context: VibeAdapterContext, call: CloudCodeCall): Promise<unknown> {
  let response: RawResponse;
  try {
    response = await callCloudCode(context, call);
  } catch {
    return undefined;
  }
  if (isAuthFailure(response)) throw new VibeCredentialsExpiredError(PROVIDER_ID);
  if (response.status === 429) {
    throw new VibeRateLimitedError(PROVIDER_ID, retryAfterMs(response, context.now()));
  }
  return response.ok ? parseBody(response) : undefined;
}

// --- quota summary ----------------------------------------------------------

/**
 * `null` means "this is not a summary, try the older endpoints"; `[]` means the
 * account really has no buckets, which is an answer and must not be retried.
 */
function parseQuotaSummary(body: unknown): VibeMetric[] | null {
  // The language server wraps it in `response`, the REST endpoint does not.
  const groups = asArray(pick(body, "response", "groups")) ?? asArray(pick(body, "groups"));
  if (groups === undefined) return null;

  const claimed = new Set<string>();
  const found = new Map<string, { fraction: number; resetsAtMs?: number }>();
  for (const group of groups) {
    for (const bucket of asArray(pick(group, "buckets")) ?? []) {
      const bucketId = asString(pick(bucket, "bucketId"));
      if (bucketId === undefined) continue;
      if (!SUMMARY_BUCKETS.some((entry) => entry.bucketId === bucketId)) continue;
      // First copy of a bucket wins, usable or not — preferring whichever copy
      // carries data would make the meter depend on response order.
      if (claimed.has(bucketId)) continue;
      claimed.add(bucketId);
      const fraction = asNumber(pick(bucket, "remainingFraction"));
      if (fraction === undefined) continue; // "no data" is a row, not a 0%.
      found.set(bucketId, { fraction, resetsAtMs: timestampMs(pick(bucket, "resetTime")) });
    }
  }

  const metrics: VibeMetric[] = [];
  for (const entry of SUMMARY_BUCKETS) {
    const bucket = found.get(entry.bucketId);
    if (bucket === undefined) continue;
    const metric = consumptionMetric({
      key: entry.key,
      label: entry.label,
      unit: "percent",
      used: fractionToUsedPercent(bucket.fraction),
      limit: 100,
      resetsAtMs: bucket.resetsAtMs,
      windowSeconds: entry.periodMs / 1000,
    });
    if (metric !== undefined) metrics.push(metric);
  }
  return metrics;
}

/** Remaining fraction → whole percent spent, clamped: the wire has sent 1.5 and -0.2. */
function fractionToUsedPercent(fraction: number): number {
  return Math.round((1 - Math.min(1, Math.max(0, fraction))) * 100);
}

// --- legacy endpoints -------------------------------------------------------

interface ModelQuota {
  label: string;
  modelId?: string;
  fraction: number;
  resetsAtMs?: number;
}

async function fetchLegacy(context: VibeAdapterContext, token: string): Promise<VibeProviderResult> {
  // One lookup serves both purposes: the plan string and the project id that
  // `retrieveUserQuota` wants.
  const assist = await loadCodeAssist(context, token);

  const models = await tryCloudCode(context, {
    path: FETCH_MODELS_PATH, token, userAgent: UA_APP, body: {},
  });
  const modelMetrics = poolModelQuotas(parseCloudCodeModels(models));
  if (modelMetrics.length > 0) return { plan: assist.plan, metrics: modelMetrics };

  let quota = await tryCloudCode(context, {
    path: RETRIEVE_QUOTA_PATH,
    token,
    userAgent: UA_CLI,
    body: assist.project === undefined ? {} : { project: assist.project },
  });
  // Some accounts reject the project scoping they themselves advertised.
  if (quota === undefined && assist.project !== undefined) {
    quota = await tryCloudCode(context, { path: RETRIEVE_QUOTA_PATH, token, userAgent: UA_CLI, body: {} });
  }
  const quotaMetrics = poolModelQuotas(parseQuotaBuckets(quota));
  if (quotaMetrics.length > 0) return { plan: assist.plan, metrics: quotaMetrics };

  throw new VibeRequestError(PROVIDER_ID, UNAVAILABLE);
}

function parseCloudCodeModels(body: unknown): ModelQuota[] {
  const models = asRecord(pick(body, "models"));
  if (models === undefined) return [];
  const configs: ModelQuota[] = [];
  for (const [key, value] of Object.entries(models)) {
    if (asBoolean(pick(value, "isInternal")) === true) continue;
    const label = asString(pick(value, "displayName")) ?? asString(pick(value, "label"));
    if (label === undefined) continue;
    configs.push({
      label,
      modelId: asString(pick(value, "model")) ?? key,
      // A listed model without quotaInfo is one whose pool is gone — that is
      // the app's own reading of this endpoint, not an invented zero.
      fraction: asNumber(pick(value, "quotaInfo", "remainingFraction")) ?? 0,
      resetsAtMs: timestampMs(pick(value, "quotaInfo", "resetTime")),
    });
  }
  return configs;
}

function parseQuotaBuckets(body: unknown): ModelQuota[] {
  const buckets = asArray(pick(body, "buckets"));
  if (buckets === undefined) return [];
  const configs: ModelQuota[] = [];
  for (const bucket of buckets) {
    const modelId = asString(pick(bucket, "modelId"));
    if (modelId === undefined) continue;
    // This endpoint has no display names, so the raw id is what pooling reads.
    configs.push({
      label: modelId,
      modelId,
      fraction: asNumber(pick(bucket, "remainingFraction")) ?? 0,
      resetsAtMs: timestampMs(pick(bucket, "resetTime")),
    });
  }
  return configs;
}

/**
 * The pre-summary endpoints report per model, not per pool, so the app folds
 * them into the two 5-hour meters by keeping each pool's worst model. There is
 * no weekly figure anywhere in this shape — those rows stay absent rather than
 * being guessed at.
 */
function poolModelQuotas(configs: ModelQuota[]): VibeMetric[] {
  const pools = new Map<string, { fraction: number; resetsAtMs?: number }>();
  for (const config of configs) {
    if (config.modelId !== undefined && MODEL_BLACKLIST.has(config.modelId)) continue;
    // "Gemini 3 Pro (High)" and "Gemini 3 Pro (Low)" share one pool.
    const normalized = config.label.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (normalized === "") continue;
    const key = normalized.toLowerCase().includes("gemini") ? "geminiSession" : "nonGeminiSession";
    const current = pools.get(key);
    if (current === undefined || config.fraction < current.fraction) {
      pools.set(key, { fraction: config.fraction, resetsAtMs: config.resetsAtMs });
    }
  }

  const metrics: VibeMetric[] = [];
  for (const entry of SUMMARY_BUCKETS) {
    if (entry.periodMs !== PERIOD_MS.session) continue;
    const pool = pools.get(entry.key);
    if (pool === undefined) continue;
    const metric = consumptionMetric({
      key: entry.key,
      label: entry.label,
      unit: "percent",
      used: fractionToUsedPercent(pool.fraction),
      limit: 100,
      resetsAtMs: pool.resetsAtMs,
      windowSeconds: entry.periodMs / 1000,
    });
    if (metric !== undefined) metrics.push(metric);
  }
  return metrics;
}

// --- plan -------------------------------------------------------------------

interface CodeAssist {
  plan?: string;
  project?: string;
}

async function loadCodeAssist(context: VibeAdapterContext, token: string): Promise<CodeAssist> {
  let body: unknown;
  try {
    body = await tryCloudCode(context, { path: LOAD_CODE_ASSIST_PATH, token, userAgent: UA_CLI, body: {} });
  } catch {
    // The plan is decoration; the meters are the point. Never fail over it.
    return {};
  }
  // paidTier first: currentTier reads "Free" for a subscriber mid-billing-cycle.
  const name = asString(pick(body, "paidTier", "name")) ?? asString(pick(body, "currentTier", "name"));
  return {
    plan: name === undefined ? undefined : formatPlan(name),
    project: asString(pick(body, "cloudaicompanionProject")),
  };
}

const GOOGLE_AI_PREFIX = "Google AI ";
const PLAN_KEYWORDS = ["Ultra", "Pro", "Free"] as const;

/** "Google AI Pro" → "Pro", "…Google One AI Pro" → "Pro", else title case. */
function formatPlan(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith(GOOGLE_AI_PREFIX)) {
    const rest = trimmed.slice(GOOGLE_AI_PREFIX.length).trim();
    if (rest !== "") return titleCase(rest, false);
  }
  const lowered = trimmed.toLowerCase();
  for (const keyword of PLAN_KEYWORDS) {
    if (lowered.includes(keyword.toLowerCase())) return keyword;
  }
  return titleCase(trimmed, false);
}
