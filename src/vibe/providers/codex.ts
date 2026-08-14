/**
 * Codex quota, read from the ChatGPT session the `codex` CLI already holds.
 *
 * The CLI keeps its OAuth blob in `auth.json` (a keychain item on hosts where
 * the file was never written), and the same access token answers ChatGPT's
 * private `wham/usage` route. Windows are classified by their declared length
 * rather than their slot, because OpenAI moves a sole weekly limit into the
 * primary slot during incidents — trusting the slot would relabel a weekly
 * quota as a 5-hour one.
 */

import { vibeMetricLabel } from "../vibe-catalog.ts";
import {
  parseBody,
  request,
  requireSuccess,
  withTokenRefresh,
  type RawResponse,
} from "./http.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  balanceMetric,
  consumptionMetric,
  epochMs,
  jwtPayload,
  parseJsonWithHexFallback,
  PERIOD_MS,
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

const PROVIDER_ID = "codex";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const KEYCHAIN_SERVICE = "Codex Auth";
const USER_AGENT = "vibe-usage/1.0";
/** Refresh five minutes ahead of the JWT's own expiry, as the CLI does. */
const REFRESH_SLACK_MS = 5 * 60 * 1000;
/** Only used when the access token's `exp` is unreadable: the CLI's own staleness bound. */
const LAST_REFRESH_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
/** OpenAI prices a reset credit at four cents; the CLI shows both figures. */
const CREDIT_USD_RATE = 0.04;

interface CodexAuth {
  accessToken?: string;
  refreshToken?: string;
  /** ChatGPT workspace this token belongs to; the usage route needs it as a header. */
  accountId?: string;
  apiKey?: string;
  lastRefresh?: string;
}

interface Candidate {
  source: "file" | "keychain";
  /** Which auth.json this came from, so a rotated blob goes back to it. */
  path?: string;
  auth: CodexAuth;
}

function metricLabel(key: string): string {
  return vibeMetricLabel(PROVIDER_ID, key);
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** RFC-3986 form encoding: `encodeURIComponent` leaves `!'()*` alone, the token endpoint should not have to. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function authPaths(env: Record<string, string | undefined>): string[] {
  const home = envValue(env, "CODEX_HOME");
  if (home !== undefined) return [`${home.replace(/\/+$/, "")}/auth.json`];
  // XDG first, then the legacy dot-directory the installer still writes.
  return ["~/.config/codex/auth.json", "~/.codex/auth.json"];
}

/** `auth.json` is plain JSON on most installs and hex-encoded on a few. */
function parseAuth(text: string | null): CodexAuth | undefined {
  if (text === null) return undefined;
  const root = asRecord(parseJsonWithHexFallback(text));
  if (!root) return undefined;
  const tokens = asRecord(root.tokens);
  const auth: CodexAuth = {
    accessToken: tokens === undefined ? undefined : asString(tokens.access_token),
    refreshToken: tokens === undefined ? undefined : asString(tokens.refresh_token),
    accountId: tokens === undefined ? undefined : asString(tokens.account_id),
    apiKey: asString(root.OPENAI_API_KEY),
    lastRefresh: asString(root.last_refresh),
  };
  // A file with neither an access token nor an API key is a leftover, not a login.
  return auth.accessToken === undefined && auth.apiKey === undefined ? undefined : auth;
}

async function loadCandidates(context: VibeAdapterContext): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const path of authPaths(context.env)) {
    const auth = parseAuth(await context.readTextFile(path));
    if (auth) candidates.push({ source: "file", path, auth });
  }
  // The keychain copy only exists on installs that never wrote a file, so it is
  // read as a fallback rather than on every refresh.
  if (candidates.some((candidate) => candidate.auth.accessToken !== undefined)) return candidates;
  const keychainAuth = parseAuth(await context.keychain.read(KEYCHAIN_SERVICE).catch(() => null));
  if (keychainAuth) candidates.push({ source: "keychain", auth: keychainAuth });
  return candidates;
}

function needsRefresh(auth: CodexAuth, nowMs: number): boolean {
  // The access token is a JWT whose `exp` is epoch SECONDS.
  const expSeconds = auth.accessToken === undefined ? undefined : asNumber(jwtPayload(auth.accessToken)?.exp);
  if (expSeconds !== undefined) return expSeconds * 1000 - nowMs <= REFRESH_SLACK_MS;
  const lastRefresh = timestampMs(auth.lastRefresh);
  if (lastRefresh === undefined) return false;
  return nowMs - lastRefresh > LAST_REFRESH_MAX_AGE_MS;
}

/** `{"error": {...}}`, `{"error": "code"}` and `{"code": "…"}` all appear on a rejected refresh. */
function refreshErrorCode(body: JsonRecord | undefined): string | undefined {
  const error = body?.error;
  const record = asRecord(error);
  if (record) return asString(record.code) ?? asString(record.error) ?? asString(body?.code);
  return asString(error) ?? asString(body?.code);
}

/**
 * Exchanges the refresh token. Nothing is written back — this adapter has no
 * writer in its context — so the rotated token lives only for this call and the
 * CLI keeps refreshing on its own schedule.
 */
async function refreshAuth(context: VibeAdapterContext, auth: CodexAuth): Promise<CodexAuth> {
  const body = [
    "grant_type=refresh_token",
    `client_id=${formEncode(CLIENT_ID)}`,
    `refresh_token=${formEncode(auth.refreshToken ?? "")}`,
  ].join("&");
  const response = await request(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: PROVIDER_ID,
  });

  if (response.status === 400 || response.status === 401) {
    const code = refreshErrorCode(asRecord(parseBody(response)));
    // Three distinct ways a session dies, and the user needs the right one:
    // `reused` means another client rotated the token first.
    if (code === "refresh_token_expired") {
      throw new VibeCredentialsExpiredError(PROVIDER_ID, "session expired — run `codex` to log in again");
    }
    if (code === "refresh_token_reused") {
      throw new VibeCredentialsExpiredError(PROVIDER_ID, "token conflict — run `codex` to log in again");
    }
    if (code === "refresh_token_invalidated") {
      throw new VibeCredentialsExpiredError(PROVIDER_ID, "token revoked — run `codex` to log in again");
    }
    throw new VibeRequestError(PROVIDER_ID, `token refresh failed: HTTP ${response.status}`, response.status);
  }
  if (!response.ok) {
    throw new VibeRequestError(PROVIDER_ID, `token refresh failed: HTTP ${response.status}`, response.status);
  }

  const parsed = asRecord(parseBody(response));
  const accessToken = asString(parsed?.access_token);
  if (accessToken === undefined) {
    throw new VibeCredentialsExpiredError(PROVIDER_ID, "token expired — run `codex` to log in again");
  }
  return {
    ...auth,
    accessToken,
    refreshToken: asString(parsed?.refresh_token) ?? auth.refreshToken,
  };
}

/**
 * Hands a rotated credential back to the Codex CLI.
 *
 * OpenAI rotates the refresh token on every exchange, so a refresh we perform
 * and keep to ourselves leaves `auth.json` holding a token the server has
 * already retired — the next `codex` run would find itself logged out. The
 * rewrite preserves every key the file carried (the CLI reads more of them than
 * we do) and stamps `last_refresh` the way the CLI does.
 *
 * A failed write is swallowed: this read is still valid, and a locked file mid
 * render is not something the user can act on.
 */
async function persistRefreshed(
  context: VibeAdapterContext,
  candidate: Candidate,
  auth: CodexAuth,
): Promise<void> {
  if (candidate.source !== "file" || candidate.path === undefined) return;
  try {
    const original = asRecord(parseJsonWithHexFallback(await context.readTextFile(candidate.path) ?? "")) ?? {};
    const tokens = { ...(asRecord(original.tokens) ?? {}) };
    tokens.access_token = auth.accessToken;
    if (auth.refreshToken !== undefined) tokens.refresh_token = auth.refreshToken;
    const next = {
      ...original,
      tokens,
      last_refresh: new Date(context.now()).toISOString(),
    };
    await context.writeTextFile(candidate.path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // See the note above: a failed write-back costs a future login, not this read.
  }
}

interface WindowCandidate {
  window: JsonRecord;
  usedPercent: number | undefined;
  fallbackKind: "session" | "weekly";
}

function windowCandidate(
  value: unknown,
  headerPercent: number | undefined,
  fallbackKind: "session" | "weekly",
): WindowCandidate | undefined {
  const window = asRecord(value);
  // A response header alone can carry the percentage while the body omits the
  // window entirely; an absent window with no header means there is no limit.
  if (window === undefined && headerPercent === undefined) return undefined;
  const resolved = window ?? {};
  return { window: resolved, usedPercent: asNumber(resolved.used_percent) ?? headerPercent, fallbackKind };
}

function windowPeriodMs(window: JsonRecord): number | undefined {
  const seconds = asNumber(window.limit_window_seconds);
  return seconds === undefined ? undefined : Math.trunc(seconds * 1000);
}

function exactKind(window: JsonRecord): "session" | "weekly" | undefined {
  const periodMs = windowPeriodMs(window);
  if (periodMs === PERIOD_MS.session) return "session";
  if (periodMs === PERIOD_MS.week) return "weekly";
  return undefined;
}

/** `reset_at` is an absolute epoch; `reset_after_seconds` is relative to this request. */
function windowResetMs(window: JsonRecord, nowMs: number): number | undefined {
  const resetAt = epochMs(window.reset_at);
  if (resetAt !== undefined) return resetAt;
  const after = asNumber(window.reset_after_seconds);
  return after === undefined ? undefined : nowMs + after * 1000;
}

/**
 * Maps a `rate_limit` object onto the session/weekly pair, keyed on the window
 * length the vendor declared and only falling back to slot order when it did
 * not declare one.
 */
function classifiedWindows(
  rateLimit: unknown,
  keys: { session: string; weekly: string },
  headerPercents: { primary?: number; secondary?: number },
  nowMs: number,
): VibeMetric[] {
  const record = asRecord(rateLimit);
  const candidates = [
    windowCandidate(record?.primary_window, headerPercents.primary, "session"),
    windowCandidate(record?.secondary_window, headerPercents.secondary, "weekly"),
  ].filter((candidate): candidate is WindowCandidate => candidate !== undefined);

  const metrics: VibeMetric[] = [];
  for (const kind of ["session", "weekly"] as const) {
    const candidate = candidates.find((entry) => exactKind(entry.window) === kind)
      ?? candidates.find((entry) => exactKind(entry.window) === undefined && entry.fallbackKind === kind);
    if (candidate === undefined) continue;
    const key = keys[kind];
    const metric = consumptionMetric({
      key,
      label: metricLabel(key),
      // `used_percent` is already a 0–100 share of the window, carried verbatim.
      unit: "percent",
      used: candidate.usedPercent,
      limit: 100,
      resetsAtMs: windowResetMs(candidate.window, nowMs),
      windowSeconds: (windowPeriodMs(candidate.window)
        ?? (kind === "session" ? PERIOD_MS.session : PERIOD_MS.week)) / 1000,
    });
    if (metric) metrics.push(metric);
  }
  return metrics;
}

/** Spark ships as an extra limit block, named differently across releases. */
function sparkMetrics(body: JsonRecord, nowMs: number): VibeMetric[] {
  for (const entry of asArray(body.additional_rate_limits) ?? []) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = `${asString(record.limit_name) ?? ""} ${asString(record.metered_feature) ?? ""}`.toLowerCase();
    if (!name.includes("spark")) continue;
    // Headers only ever describe the main limit, never this one.
    return classifiedWindows(record.rate_limit, { session: "spark", weekly: "sparkWeekly" }, {}, nowMs);
  }
  return [];
}

/** Credits are dropped when the vendor marked them unavailable, and sorted so the soonest expiry leads. */
function availableExpiries(value: unknown): number[] {
  return (asArray(value) ?? [])
    .flatMap((entry) => {
      const credit = asRecord(entry);
      if (!credit) return [];
      const status = asString(credit.status);
      if (status !== undefined && status !== "available") return [];
      const expiry = timestampMs(credit.expires_at) ?? epochMs(credit.expires_at);
      return expiry === undefined ? [] : [expiry];
    })
    .sort((left, right) => left - right);
}

function resetCreditsMetric(body: JsonRecord, dedicated: JsonRecord | undefined): VibeMetric | undefined {
  // A dedicated body that answered with a null count must not shadow the usage
  // body's own number, so the count decides which source is authoritative.
  const source = dedicated !== undefined && asNumber(dedicated.available_count) !== undefined
    ? dedicated
    : asRecord(body.rate_limit_reset_credits);
  const count = asNumber(source?.available_count);
  if (source === undefined || count === undefined || count < 0) return undefined;
  const expiries = availableExpiries(source.credits);
  return balanceMetric({
    key: "rateLimitResets",
    label: metricLabel("rateLimitResets"),
    unit: "resets",
    available: Math.floor(count),
    // The nearest expiry is the only one a single row can show.
    resetsAtMs: expiries[0],
  });
}

/** One vendor row ("$32.84 · 821 credits") exports as two scalars. */
function creditMetrics(body: JsonRecord, headerBalance: number | undefined): VibeMetric[] {
  const credits = asRecord(body.credits);
  const remaining = asNumber(credits?.balance)
    ?? (credits?.has_credits === false ? 0 : undefined)
    ?? headerBalance;
  if (remaining === undefined) return [];
  // The CLI floors before pricing, so a partial credit never buys anything.
  const count = Math.max(0, Math.floor(remaining));
  const metrics = [
    balanceMetric({ key: "credits", label: metricLabel("credits"), unit: "credits", available: count }),
    balanceMetric({
      key: "creditValue",
      label: metricLabel("creditValue"),
      unit: "usd",
      // Rounded to cents: 821 * 0.04 is 32.840000000000003 in binary floating point.
      available: Math.round(count * CREDIT_USD_RATE * 100) / 100,
    }),
  ];
  return metrics.filter((metric): metric is VibeMetric => metric !== undefined);
}

function headerNumber(response: RawResponse, name: string): number | undefined {
  return asNumber(response.headers.get(name));
}

/** `prolite` and `pro` are marketing names the API never spells out. */
function formatPlan(value: unknown): string | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  const lowered = raw.toLowerCase();
  if (lowered === "prolite") return "Pro 5x";
  if (lowered === "pro") return "Pro 20x";
  // Tail case is preserved: "gpt5_pro" must not become "Gpt5 pro".
  return titleCase(raw, false);
}

async function fetchWithCandidate(
  context: VibeAdapterContext,
  candidate: Candidate,
  accessToken: string,
): Promise<VibeProviderResult> {
  let auth = candidate.auth;
  let activeToken = accessToken;
  // Only a file-backed login can take its rotated token back (the keychain is
  // read-only for us — see keychain.ts). Spending a rotation we cannot persist
  // would log the user out of the Codex CLI, so we simply do not.
  const writable = candidate.source === "file" && candidate.path !== undefined;
  const refresh = auth.refreshToken === undefined || !writable
    ? undefined
    : async (): Promise<string> => {
      auth = await refreshAuth(context, auth);
      // Persist before the retry: if the usage call then fails, the rotated
      // token is still the one the CLI needs to hold.
      await persistRefreshed(context, candidate, auth);
      activeToken = auth.accessToken ?? "";
      return activeToken;
    };
  // The credential was read from disk moments ago, so a token the CLI rotated
  // out of band is already the one we hold — refreshing a stale copy is what
  // trips `refresh_token_reused`.
  if (refresh !== undefined && needsRefresh(auth, context.now())) await refresh();

  const headers = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    ...(auth.accountId === undefined ? {} : { "ChatGPT-Account-Id": auth.accountId }),
  });

  const response = await withTokenRefresh({
    providerId: PROVIDER_ID,
    token: activeToken,
    attempt: (token) => {
      activeToken = token;
      return request(USAGE_URL, {
        headers: headers(token),
        timeoutMs: context.timeoutMs,
        fetch: context.fetch,
        providerId: PROVIDER_ID,
      });
    },
    refresh,
  });

  const parsed = asRecord(requireSuccess(response, PROVIDER_ID, context.now()));
  if (!parsed) throw new VibeRequestError(PROVIDER_ID, "usage response was not a JSON object");

  const nowMs = context.now();
  const dedicated = await fetchResetCredits(context, activeToken, auth.accountId);
  const plan = formatPlan(parsed.plan_type);
  const metrics = [
    ...classifiedWindows(parsed.rate_limit, { session: "session", weekly: "weekly" }, {
      primary: headerNumber(response, "x-codex-primary-used-percent"),
      secondary: headerNumber(response, "x-codex-secondary-used-percent"),
    }, nowMs),
    ...sparkMetrics(parsed, nowMs),
    ...creditMetrics(parsed, headerNumber(response, "x-codex-credits-balance")),
  ];
  const resets = resetCreditsMetric(parsed, dedicated);
  if (resets) metrics.push(resets);
  return { ...(plan === undefined ? {} : { plan }), metrics };
}

/**
 * The reset-credit list is a nice-to-have second call: the usage body already
 * carries a count, so any failure here is swallowed rather than costing the
 * whole panel its numbers.
 */
async function fetchResetCredits(
  context: VibeAdapterContext,
  token: string,
  accountId: string | undefined,
): Promise<JsonRecord | undefined> {
  try {
    const response = await request(RESET_CREDITS_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "OpenAI-Beta": "codex-1",
        originator: "Codex Desktop",
        ...(accountId === undefined ? {} : { "ChatGPT-Account-Id": accountId }),
      },
      timeoutMs: context.timeoutMs,
      fetch: context.fetch,
      providerId: PROVIDER_ID,
    });
    if (!response.ok) return undefined;
    return asRecord(parseBody(response));
  } catch {
    return undefined;
  }
}

export const codexAdapter: VibeProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "Codex",

  async detect(context: VibeAdapterContext): Promise<boolean> {
    const candidates = await loadCandidates(context);
    // An API-key-only auth.json is not a ChatGPT login: the usage route has
    // nothing to say about it, so the provider stays unconfigured.
    return candidates.some((candidate) => candidate.auth.accessToken !== undefined);
  },

  async fetchUsage(context: VibeAdapterContext): Promise<VibeProviderResult> {
    const candidates = await loadCandidates(context);
    const withToken = candidates.filter((candidate) => candidate.auth.accessToken !== undefined);
    if (withToken.length === 0) {
      const apiKeyOnly = candidates.some((candidate) => candidate.auth.apiKey !== undefined);
      throw new VibeCredentialsMissingError(
        PROVIDER_ID,
        apiKeyOnly
          ? "usage is not available for an API key — run `codex` to sign in"
          : "not logged in — run `codex` to authenticate",
      );
    }

    // `~/.config` and `~/.codex` can both hold a login; only an expired one
    // falls through to the next file, everything else is reported as it is.
    let expired: VibeCredentialsExpiredError | undefined;
    for (const candidate of withToken) {
      try {
        return await fetchWithCandidate(context, candidate, candidate.auth.accessToken!);
      } catch (error) {
        if (!(error instanceof VibeCredentialsExpiredError)) throw error;
        expired = error;
      }
    }
    throw expired ?? new VibeCredentialsExpiredError(PROVIDER_ID);
  },
};
