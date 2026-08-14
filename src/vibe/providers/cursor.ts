/**
 * Cursor.
 *
 * Cursor has no public usage API: the dashboard talks to two different backends
 * with the same credential, and which one answers depends on the account shape.
 * `api2.cursor.sh` speaks Connect-RPC (POST, body `{}`) and serves the plan
 * meter individual seats see; `cursor.com/api/*` is the website's own REST tier,
 * authenticated by a cookie derived from the JWT, and is the only place team and
 * enterprise seats expose numbers at all. So the adapter asks the RPC first and
 * falls back to REST exactly where the payload proves the RPC has nothing —
 * never speculatively, because each fallback is another round trip per refresh.
 *
 * Every money field on the RPC side is integer CENTS; the credit/stripe figures
 * too. They are converted at the point of emission, never earlier, so a rounding
 * choice stays visible.
 */

import {
  parseBody,
  request,
  requireSuccess,
  withTokenRefresh,
  type RawResponse,
} from "./http.ts";
import {
  PERIOD_MS,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  balanceMetric,
  centsToDollars,
  consumptionMetric,
  epochMs,
  jwtPayload,
  pick,
  timestampMs,
  titleCase,
  type JsonRecord,
} from "./parse.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRequestError,
  type VibeAdapterContext,
  type VibeMetric,
  type VibeProviderAdapter,
  type VibeProviderResult,
} from "./types.ts";

const ID = "cursor";

const STATE_DB_PATH = "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb";
const ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const REFRESH_TOKEN_KEY = "cursorAuth/refreshToken";
const MEMBERSHIP_TYPE_KEY = "cursorAuth/stripeMembershipType";
const KEYCHAIN_ACCESS_SERVICE = "cursor-access-token";
const KEYCHAIN_REFRESH_SERVICE = "cursor-refresh-token";

/** Refresh this far before `exp`, so a request never dies mid-flight. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
/** Cursor's own desktop client id; the token endpoint rejects anything else. */
const OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const PLAN_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const CREDITS_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance";
const REFRESH_URL = "https://api2.cursor.sh/oauth/token";
const REST_USAGE_URL = "https://cursor.com/api/usage";
const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const STRIPE_URL = "https://cursor.com/api/auth/stripe";

/** Row names as the catalog spells them (`vibe-catalog.ts` → cursor.metricLabels). */
const LABELS = {
  totalUsage: "Total Usage",
  autoUsage: "Auto Usage",
  apiUsage: "API Usage",
  onDemand: "Extra Usage",
  requests: "Requests",
  credits: "Credits",
} as const;

const UNAVAILABLE = "Cursor request-based usage data unavailable. Try again later.";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface CursorAuth {
  accessToken?: string;
  refreshToken?: string;
}

/**
 * Cursor's tokens live in the editor's `state.vscdb`, which is a SQLite file —
 * and the adapter context hands us `readTextFile` only, on purpose: a real
 * database handle would be filesystem access no test could fake. SQLite writes a
 * row's columns back to back inside the page, and `ItemTable` is `(key, value)`,
 * so the token sits immediately after its key in the decoded bytes. Matching a
 * strict value shape right at that offset is what keeps the *index* copy of the
 * key — which is followed by a rowid, not a token — from being mistaken for a
 * hit. A miss here is harmless: the Keychain copy is checked next.
 */
function readItemValue(text: string, key: string, valuePattern: RegExp): string | undefined {
  let from = 0;
  for (;;) {
    const at = text.indexOf(key, from);
    if (at < 0) return undefined;
    const start = at + key.length;
    // 8 KiB is far past any JWT Cursor issues, and bounds the slice on a file
    // that is tens of megabytes.
    const match = valuePattern.exec(text.slice(start, start + 8192));
    if (match !== null && match[0] !== "") return match[0];
    from = start;
  }
}

const JWT_VALUE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;
const MEMBERSHIP_VALUE = /^[A-Za-z][A-Za-z0-9_+-]{0,31}/;

/** A locked or denied keychain is a real throw upstream; here it just means "no copy". */
async function readKeychain(context: VibeAdapterContext, service: string): Promise<string | undefined> {
  try {
    // Cursor stores its items without an account, which is the reader's fallback shape.
    return (await context.keychain.read(service)) ?? undefined;
  } catch {
    return undefined;
  }
}

function tokenSubject(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  return asString(jwtPayload(token)?.sub);
}

/**
 * Both stores can hold a token, and they disagree after an account switch. The
 * editor's own database wins, except in the one case Cursor itself treats as
 * stale: a `free` membership recorded against a *different* subject than the
 * Keychain holds, which is what a leftover signed-out session looks like.
 */
async function loadAuth(context: VibeAdapterContext): Promise<CursorAuth | undefined> {
  const db = await context.readTextFile(STATE_DB_PATH);
  const sqliteAccess = db === null ? undefined : readItemValue(db, ACCESS_TOKEN_KEY, JWT_VALUE);
  const sqliteRefresh = db === null ? undefined : readItemValue(db, REFRESH_TOKEN_KEY, JWT_VALUE);
  const membership = db === null
    ? undefined
    : readItemValue(db, MEMBERSHIP_TYPE_KEY, MEMBERSHIP_VALUE)?.toLowerCase();

  const keychainAccess = await readKeychain(context, KEYCHAIN_ACCESS_SERVICE);
  const keychainRefresh = await readKeychain(context, KEYCHAIN_REFRESH_SERVICE);

  const hasSqlite = sqliteAccess !== undefined || sqliteRefresh !== undefined;
  const hasKeychain = keychainAccess !== undefined || keychainRefresh !== undefined;

  if (hasSqlite) {
    const sqliteSubject = tokenSubject(sqliteAccess);
    const keychainSubject = tokenSubject(keychainAccess);
    const subjectsDiffer = sqliteSubject !== undefined
      && keychainSubject !== undefined
      && sqliteSubject !== keychainSubject;
    if (hasKeychain && membership === "free" && subjectsDiffer) {
      return { accessToken: keychainAccess, refreshToken: keychainRefresh };
    }
    return { accessToken: sqliteAccess, refreshToken: sqliteRefresh };
  }
  if (hasKeychain) return { accessToken: keychainAccess, refreshToken: keychainRefresh };
  return undefined;
}

/** No `exp` claim is treated as expired — an unreadable token is not a fresh one. */
function needsRefresh(token: string | undefined, nowMs: number): boolean {
  if (token === undefined) return true;
  const expiresAt = epochMs(jwtPayload(token)?.exp);
  if (expiresAt === undefined) return true;
  return expiresAt - nowMs <= REFRESH_BUFFER_MS;
}

/**
 * Returns the rotated access token, or undefined when the endpoint declined to
 * issue one without saying the session is dead (5xx, garbled body) — that case
 * keeps the current token rather than signing the user out over a blip.
 *
 * OpenUsage writes the rotated token back into `state.vscdb`/Keychain. We cannot:
 * the context is read-only by design, so the new token lives for this refresh
 * only and the next tick asks again. Cursor's refresh tokens are long-lived, so
 * the cost is one extra POST per cycle, not a re-login.
 */
async function refreshAccessToken(
  context: VibeAdapterContext,
  refreshToken: string,
): Promise<string | undefined> {
  const response = await request(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: ID,
  });

  if (response.status === 400 || response.status === 401) {
    const body = asRecord(parseBody(response));
    throw new VibeCredentialsExpiredError(
      ID,
      asBoolean(body?.shouldLogout) === true
        ? "session expired, sign in to Cursor again"
        : "token expired, sign in to Cursor again",
    );
  }
  if (!response.ok) return undefined;
  const body = asRecord(parseBody(response));
  if (body === undefined) return undefined;
  // A 200 can still carry the logout flag; it is authoritative wherever it appears.
  if (asBoolean(body.shouldLogout) === true) {
    throw new VibeCredentialsExpiredError(ID, "session expired, sign in to Cursor again");
  }
  return asString(body.access_token);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function connectPost(context: VibeAdapterContext, url: string, token: string): Promise<RawResponse> {
  return request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Connect-RPC unary calls are plain POSTs with this header and an empty
      // JSON message; without it api2 answers 415.
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: ID,
  });
}

interface CursorSession {
  userID: string;
  cookie: string;
}

/**
 * cursor.com authenticates with the session cookie the website sets, which is
 * derivable from the JWT: `sub` is `"<provider>|<userID>"`, and the cookie is
 * `<userID>::<jwt>` with the colons already percent-encoded. Encoding the value
 * again would produce `%253A` and log the request out, so it is spliced raw.
 */
function sessionFrom(accessToken: string): CursorSession | undefined {
  const subject = tokenSubject(accessToken);
  if (subject === undefined) return undefined;
  const parts = subject.split("|");
  const userID = (parts.length > 1 ? parts[1] : parts[0]) ?? "";
  if (userID === "") return undefined;
  return { userID, cookie: `WorkosCursorSessionToken=${userID}%3A%3A${accessToken}` };
}

function restGet(
  context: VibeAdapterContext,
  url: string,
  session: CursorSession,
): Promise<RawResponse> {
  return request(url, {
    headers: { Cookie: session.cookie },
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: ID,
  });
}

/**
 * Every endpoint except the primary usage call is optional: plan, credits,
 * stripe balance, usage-summary, request usage. A failure there costs one row,
 * so it degrades in silence rather than blanking a panel that has real numbers.
 */
async function optionalJson(
  attempt: () => Promise<RawResponse | undefined>,
): Promise<JsonRecord | undefined> {
  try {
    const response = await attempt();
    if (response === undefined || !response.ok) return undefined;
    return asRecord(parseBody(response));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Payload facts
// ---------------------------------------------------------------------------

interface CursorFacts {
  isEnabled: boolean;
  planUsage: JsonRecord | undefined;
  limitCents: number | undefined;
  totalPercentUsed: number | undefined;
  isTeamByShape: boolean;
  planUsageLimitMissing: boolean;
  planUsageUnusable: boolean;
  shouldTryGenericRequestFallback: boolean;
}

function decodeFacts(usage: JsonRecord): CursorFacts {
  // `enabled` is absent on healthy accounts, so only an explicit false counts.
  const isEnabled = asBoolean(usage.enabled) !== false;
  const planUsage = asRecord(usage.planUsage);
  const limitCents = asNumber(planUsage?.limit);
  const totalPercentUsed = asNumber(planUsage?.totalPercentUsed);
  const spendLimit = asRecord(usage.spendLimitUsage);
  const spendLimitType = asString(spendLimit?.limitType)?.toLowerCase();
  const pooledLimit = asNumber(spendLimit?.pooledLimit) ?? 0;
  const planUsageLimitMissing = planUsage !== undefined && limitCents === undefined;
  return {
    isEnabled,
    planUsage,
    limitCents,
    totalPercentUsed,
    isTeamByShape: spendLimitType === "team" || pooledLimit > 0,
    planUsageLimitMissing,
    planUsageUnusable: planUsage === undefined || planUsageLimitMissing,
    shouldTryGenericRequestFallback: isEnabled
      && planUsage !== undefined
      && limitCents === undefined
      && totalPercentUsed === undefined,
  };
}

interface BillingCycle {
  resetsAtMs?: number;
  periodMs: number;
}

/** RPC cycle bounds are epoch milliseconds; a half-filled pair still gives a reset. */
function billingCycle(usage: JsonRecord): BillingCycle {
  const start = epochMs(usage.billingCycleStart);
  const end = epochMs(usage.billingCycleEnd);
  if (start !== undefined && end !== undefined && end > start) {
    return { resetsAtMs: end, periodMs: Math.trunc(end - start) };
  }
  return { resetsAtMs: end, periodMs: PERIOD_MS.month };
}

function planLabel(value: unknown): string | undefined {
  const text = asString(value);
  // Cursor sends free-form plan wording ("pro plan", "Enterprise"); the tail is
  // preserved so an already-cased name survives untouched.
  return text === undefined ? undefined : titleCase(text, false);
}

function push(metrics: VibeMetric[], metric: VibeMetric | undefined): void {
  if (metric !== undefined) metrics.push(metric);
}

// ---------------------------------------------------------------------------
// Mapping — primary (individual / team plan meter)
// ---------------------------------------------------------------------------

interface CreditGrants {
  totalCents: number;
  usedCents: number;
}

/** A grant object is only trusted whole: a partial one would understate what is left. */
function decodeCreditGrants(body: JsonRecord | undefined): CreditGrants | undefined {
  if (body === undefined || asBoolean(body.hasCreditGrants) !== true) return undefined;
  const totalCents = asNumber(body.totalCents);
  const usedCents = asNumber(body.usedCents);
  if (totalCents === undefined || totalCents <= 0) return undefined;
  if (usedCents === undefined || usedCents < 0) return undefined;
  return { totalCents, usedCents };
}

/** Stripe reports account credit as a NEGATIVE customer balance; anything else is a debt. */
function stripeCreditCents(body: JsonRecord | undefined): number {
  const balance = asNumber(body?.customerBalance);
  if (balance === undefined || balance >= 0) return 0;
  return Math.abs(balance);
}

function mapPrimary(input: {
  usage: JsonRecord;
  facts: CursorFacts;
  planName: string | undefined;
  creditGrants: JsonRecord | undefined;
  stripe: JsonRecord | undefined;
}): VibeMetric[] {
  const { usage, facts } = input;
  if (!facts.isEnabled || facts.planUsage === undefined) {
    throw new VibeRequestError(ID, "No active Cursor subscription.");
  }
  if (facts.limitCents === undefined && facts.totalPercentUsed === undefined) {
    throw new VibeRequestError(ID, "Total usage limit missing from API response.");
  }

  const planUsage = facts.planUsage;
  const cycle = billingCycle(usage);
  const metrics: VibeMetric[] = [];

  // Total usage. Team seats meter dollars against a pooled budget; individual
  // seats meter a percentage of their plan, and only fall back to arithmetic on
  // the cents when the server did not send the percentage itself.
  const usedCents = asNumber(planUsage.totalSpend)
    ?? (facts.limitCents ?? 0) - (asNumber(planUsage.remaining) ?? 0);
  const computedPercent = facts.limitCents !== undefined && facts.limitCents > 0
    ? (usedCents / facts.limitCents) * 100
    : 0;
  const normalizedPlan = input.planName?.trim().toLowerCase() ?? "";
  const isTeam = normalizedPlan === "team" || facts.isTeamByShape;
  if (isTeam) {
    if (facts.limitCents === undefined) throw new VibeRequestError(ID, UNAVAILABLE);
    push(metrics, consumptionMetric({
      key: "totalUsage",
      label: LABELS.totalUsage,
      unit: "usd",
      used: centsToDollars(usedCents),
      limit: centsToDollars(facts.limitCents),
      resetsAtMs: cycle.resetsAtMs,
      windowSeconds: cycle.periodMs / 1000,
    }));
  } else {
    push(metrics, consumptionMetric({
      key: "totalUsage",
      label: LABELS.totalUsage,
      unit: "percent",
      used: facts.totalPercentUsed ?? computedPercent,
      limit: 100,
      resetsAtMs: cycle.resetsAtMs,
      windowSeconds: cycle.periodMs / 1000,
    }));
  }

  push(metrics, consumptionMetric({
    key: "autoUsage",
    label: LABELS.autoUsage,
    unit: "percent",
    used: asNumber(planUsage.autoPercentUsed),
    limit: 100,
    resetsAtMs: cycle.resetsAtMs,
    windowSeconds: cycle.periodMs / 1000,
  }));
  push(metrics, consumptionMetric({
    key: "apiUsage",
    label: LABELS.apiUsage,
    unit: "percent",
    used: asNumber(planUsage.apiPercentUsed),
    limit: 100,
    resetsAtMs: cycle.resetsAtMs,
    windowSeconds: cycle.periodMs / 1000,
  }));

  push(metrics, onDemandMetric(asRecord(usage.spendLimitUsage)));

  // Credits are Cursor's prepaid pool: grants plus any Stripe account credit,
  // minus what the grants already spent. Sub-cent totals mean "no pool", not "$0".
  const grants = decodeCreditGrants(input.creditGrants);
  const combinedCents = (grants?.totalCents ?? 0) + stripeCreditCents(input.stripe);
  if (combinedCents > 0) {
    const remainingCents = Math.max(0, combinedCents - (grants?.usedCents ?? 0));
    push(metrics, balanceMetric({
      key: "credits",
      label: LABELS.credits,
      unit: "usd",
      available: centsToDollars(remainingCents),
    }));
  }

  return metrics;
}

/**
 * On-demand ("extra usage") spend. Individual and pooled fields are the same
 * meter under two names, and `totalSpend` is a third; the first positive one
 * wins because a zero there means "this shape is unused", not "nothing spent".
 */
function onDemandMetric(spendLimit: JsonRecord | undefined): VibeMetric | undefined {
  if (spendLimit === undefined) return undefined;
  const limitCents = asNumber(spendLimit.individualLimit) ?? asNumber(spendLimit.pooledLimit) ?? 0;
  const remainingCents = asNumber(spendLimit.individualRemaining)
    ?? asNumber(spendLimit.pooledRemaining) ?? 0;
  const reported = [
    asNumber(spendLimit.individualUsed),
    asNumber(spendLimit.pooledUsed),
    asNumber(spendLimit.totalSpend),
  ].filter((value): value is number => value !== undefined);
  const inferred = Math.max(0, limitCents - remainingCents);
  const spentCents = reported.find((value) => value > 0)
    ?? (inferred > 0 ? inferred : reported[0] ?? 0);

  if (limitCents > 0) {
    // No resetsAt on purpose: the on-demand budget is a standing ceiling, not a
    // windowed allowance, so stamping the billing cycle on it would be a lie.
    return consumptionMetric({
      key: "onDemand",
      label: LABELS.onDemand,
      unit: "usd",
      used: centsToDollars(spentCents),
      limit: centsToDollars(limitCents),
    });
  }
  if (spentCents > 0) {
    return consumptionMetric({
      key: "onDemand",
      label: LABELS.onDemand,
      unit: "usd",
      used: centsToDollars(spentCents),
      limit: undefined,
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Mapping — request-based fallbacks (legacy / team / enterprise)
// ---------------------------------------------------------------------------

/** `GET /api/usage` counts requests, not money; the pool key is the literal "gpt-4". */
function mapRequestBased(usage: JsonRecord | undefined): VibeMetric[] {
  const pool = asRecord(usage?.["gpt-4"]);
  const limit = asNumber(pool?.maxRequestUsage);
  if (pool === undefined || limit === undefined || limit <= 0) return [];
  const used = asNumber(pool.numRequests) ?? 0;
  const startOfMonth = timestampMs(usage?.startOfMonth);
  const metric = consumptionMetric({
    key: "requests",
    label: LABELS.requests,
    unit: "requests",
    used,
    limit,
    resetsAtMs: startOfMonth === undefined ? undefined : startOfMonth + PERIOD_MS.month,
    windowSeconds: PERIOD_MS.month / 1000,
  });
  return metric === undefined ? [] : [metric];
}

interface FallbackDecision {
  use: boolean;
  message: string;
}

/**
 * When the plan meter is unusable, the account is one of the shapes whose
 * numbers only exist on cursor.com. The plan name decides the wording; the
 * payload shape decides the branch, since an unnamed plan plus a missing
 * `GetPlanInfo` is exactly what a fresh enterprise seat looks like.
 */
function fallbackDecision(
  facts: CursorFacts,
  planName: string | undefined,
  planInfoUnavailable: boolean,
): FallbackDecision {
  if (!facts.isEnabled) return { use: false, message: "" };
  const normalizedPlan = planName?.trim().toLowerCase() ?? "";
  if (facts.planUsageUnusable && normalizedPlan === "enterprise") {
    return { use: true, message: "Enterprise usage data unavailable. Try again later." };
  }
  if (facts.planUsageUnusable && normalizedPlan === "team") {
    return { use: true, message: "Team request-based usage data unavailable. Try again later." };
  }
  if (
    facts.planUsageUnusable
    && facts.totalPercentUsed === undefined
    && normalizedPlan === ""
    && planInfoUnavailable
  ) {
    return { use: true, message: UNAVAILABLE };
  }
  if (facts.isTeamByShape && facts.planUsageLimitMissing) {
    return { use: true, message: UNAVAILABLE };
  }
  return { use: false, message: "" };
}

interface DollarMeter {
  usedCents: number;
  limitCents: number;
}

/** A summary bucket only meters money when it has a positive ceiling. */
function dollarMeter(value: unknown): DollarMeter | undefined {
  const bucket = asRecord(value);
  // Absent `enabled` counts as enabled — only an explicit false switches a meter off.
  if (bucket === undefined || asBoolean(bucket.enabled) === false) return undefined;
  const limitCents = asNumber(bucket.limit);
  if (limitCents === undefined || limitCents <= 0) return undefined;
  const reported = asNumber(bucket.used);
  const inferred = Math.max(0, limitCents - (asNumber(bucket.remaining) ?? limitCents));
  const usedCents = reported !== undefined && reported > 0 ? reported : inferred;
  return { usedCents: Math.max(0, usedCents), limitCents };
}

function summaryCycle(summary: JsonRecord | undefined, requestUsage: JsonRecord | undefined): BillingCycle {
  // Unlike the RPC, the website sends ISO-8601 strings here.
  const start = timestampMs(summary?.billingCycleStart);
  const end = timestampMs(summary?.billingCycleEnd);
  if (start !== undefined && end !== undefined && end > start) {
    return { resetsAtMs: end, periodMs: end - start };
  }
  const startOfMonth = timestampMs(requestUsage?.startOfMonth);
  return {
    resetsAtMs: startOfMonth === undefined ? undefined : startOfMonth + PERIOD_MS.month,
    periodMs: PERIOD_MS.month,
  };
}

function mapSummary(input: {
  summary: JsonRecord | undefined;
  requestUsage: JsonRecord | undefined;
  message: string;
}): VibeMetric[] {
  const { summary, requestUsage } = input;
  const cycle = summaryCycle(summary, requestUsage);
  const metrics: VibeMetric[] = [];

  // Enterprise seats meter requests, and the request pool doubles as the
  // headline: the same numbers answer both `totalUsage` and `requests` so the
  // panel's primary row is never empty on these accounts.
  const pool = asRecord(requestUsage?.["gpt-4"]);
  const requestLimit = asNumber(pool?.maxRequestUsage);
  let hasRequests = false;
  if (pool !== undefined && requestLimit !== undefined && requestLimit > 0) {
    const used = Math.max(0, asNumber(pool.numRequests) ?? asNumber(pool.numRequestsTotal) ?? 0);
    for (const key of ["totalUsage", "requests"] as const) {
      push(metrics, consumptionMetric({
        key,
        label: LABELS[key],
        unit: "requests",
        used,
        limit: requestLimit,
        resetsAtMs: cycle.resetsAtMs,
        windowSeconds: cycle.periodMs / 1000,
      }));
    }
    hasRequests = metrics.length > 0;
  }

  if (!hasRequests) push(metrics, summaryTotal(summary, cycle));

  const plan = asRecord(pick(summary, "individualUsage", "plan"));
  push(metrics, consumptionMetric({
    key: "autoUsage",
    label: LABELS.autoUsage,
    unit: "percent",
    used: asNumber(plan?.autoPercentUsed),
    limit: 100,
    resetsAtMs: cycle.resetsAtMs,
    windowSeconds: cycle.periodMs / 1000,
  }));
  push(metrics, consumptionMetric({
    key: "apiUsage",
    label: LABELS.apiUsage,
    unit: "percent",
    used: asNumber(plan?.apiPercentUsed),
    limit: 100,
    resetsAtMs: cycle.resetsAtMs,
    windowSeconds: cycle.periodMs / 1000,
  }));

  // The individual bucket is the seat's own overage; the team one is the shared
  // pool. Only one of them describes this user, and the personal one wins.
  push(
    metrics,
    summaryOnDemand(pick(summary, "individualUsage", "onDemand"), cycle)
      ?? summaryOnDemand(pick(summary, "teamUsage", "onDemand"), cycle),
  );

  if (metrics.length === 0) throw new VibeRequestError(ID, input.message);
  return metrics;
}

function summaryTotal(summary: JsonRecord | undefined, cycle: BillingCycle): VibeMetric | undefined {
  const limitType = asString(summary?.limitType)?.toLowerCase();
  const pooled = dollarMeter(pick(summary, "teamUsage", "pooled"));
  const dollars = (meter: DollarMeter): VibeMetric | undefined => consumptionMetric({
    key: "totalUsage",
    label: LABELS.totalUsage,
    unit: "usd",
    used: centsToDollars(meter.usedCents),
    limit: centsToDollars(meter.limitCents),
    resetsAtMs: cycle.resetsAtMs,
    windowSeconds: cycle.periodMs / 1000,
  });

  if (limitType === "team" && pooled !== undefined) return dollars(pooled);
  const percent = asNumber(pick(summary, "individualUsage", "plan", "totalPercentUsed"));
  if (percent !== undefined) {
    return consumptionMetric({
      key: "totalUsage",
      label: LABELS.totalUsage,
      unit: "percent",
      used: percent,
      limit: 100,
      resetsAtMs: cycle.resetsAtMs,
      windowSeconds: cycle.periodMs / 1000,
    });
  }
  const overall = dollarMeter(pick(summary, "individualUsage", "overall"));
  if (overall !== undefined) return dollars(overall);
  if (pooled !== undefined) return dollars(pooled);
  return undefined;
}

function summaryOnDemand(value: unknown, cycle: BillingCycle): VibeMetric | undefined {
  const bucket = asRecord(value);
  if (bucket === undefined || asBoolean(bucket.enabled) === false) return undefined;
  const meter = dollarMeter(bucket);
  if (meter !== undefined) {
    return consumptionMetric({
      key: "onDemand",
      label: LABELS.onDemand,
      unit: "usd",
      used: centsToDollars(meter.usedCents),
      limit: centsToDollars(meter.limitCents),
      resetsAtMs: cycle.resetsAtMs,
      windowSeconds: cycle.periodMs / 1000,
    });
  }
  const usedCents = asNumber(bucket.used);
  if (usedCents !== undefined && usedCents > 0) {
    return consumptionMetric({
      key: "onDemand",
      label: LABELS.onDemand,
      unit: "usd",
      used: centsToDollars(usedCents),
      limit: undefined,
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const cursorAdapter: VibeProviderAdapter = {
  id: ID,
  displayName: "Cursor",

  async detect(context: VibeAdapterContext): Promise<boolean> {
    return (await loadAuth(context)) !== undefined;
  },

  async fetchUsage(context: VibeAdapterContext): Promise<VibeProviderResult> {
    const auth = await loadAuth(context);
    if (auth === undefined) {
      throw new VibeCredentialsMissingError(ID, "sign in to Cursor, or run `cursor-agent login`");
    }

    let active = auth.accessToken;
    const refreshToken = auth.refreshToken;
    if (refreshToken !== undefined && needsRefresh(active, context.now())) {
      try {
        active = (await refreshAccessToken(context, refreshToken)) ?? active;
      } catch (error) {
        // A pre-emptive refresh that fails only sinks the request when there is
        // no token left to try; an `exp` that reads stale often still works.
        if (active === undefined) throw error;
      }
    }
    if (active === undefined) {
      throw new VibeCredentialsMissingError(ID, "sign in to Cursor, or run `cursor-agent login`");
    }

    const usageResponse = await withTokenRefresh({
      providerId: ID,
      token: active,
      attempt: (token) => connectPost(context, USAGE_URL, token),
      refresh: refreshToken === undefined ? undefined : async () => {
        const fresh = await refreshAccessToken(context, refreshToken);
        if (fresh === undefined) throw new VibeCredentialsExpiredError(ID);
        active = fresh;
        return fresh;
      },
    });
    const usage = asRecord(requireSuccess(usageResponse, ID, context.now()));
    if (usage === undefined) throw new VibeRequestError(ID, "usage response was not a JSON object");

    const token = active;
    const session = sessionFrom(token);
    const planBody = await optionalJson(() => connectPost(context, PLAN_URL, token));
    const planName = asString(pick(planBody, "planInfo", "planName"));
    const planInfoUnavailable = planName === undefined;

    const facts = decodeFacts(usage);
    const fallback = fallbackDecision(facts, planName, planInfoUnavailable);

    if (fallback.use) {
      const summary = session === undefined
        ? undefined
        : await optionalJson(() => restGet(context, USAGE_SUMMARY_URL, session));
      const requestUsage = session === undefined
        ? undefined
        : await optionalJson(() =>
          restGet(context, `${REST_USAGE_URL}?user=${encodeURIComponent(session.userID)}`, session));
      return {
        plan: planLabel(planName) ?? planLabel(summary?.membershipType),
        metrics: mapSummary({ summary, requestUsage, message: fallback.message }),
      };
    }

    if (facts.shouldTryGenericRequestFallback && session !== undefined) {
      const requestUsage = await optionalJson(() =>
        restGet(context, `${REST_USAGE_URL}?user=${encodeURIComponent(session.userID)}`, session));
      const metrics = mapRequestBased(requestUsage);
      if (metrics.length > 0) return { plan: planLabel(planName), metrics };
      // Nothing there either — fall through and let the primary mapper decide
      // whether the plan meter can still say something true.
    }

    const creditGrants = await optionalJson(() => connectPost(context, CREDITS_URL, token));
    const stripe = session === undefined
      ? undefined
      : await optionalJson(() => restGet(context, STRIPE_URL, session));

    return {
      plan: planLabel(planName),
      metrics: mapPrimary({ usage, facts, planName, creditGrants, stripe }),
    };
  },
};
