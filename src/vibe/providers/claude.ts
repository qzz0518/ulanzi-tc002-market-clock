/**
 * Claude Code's own OAuth session, read where the CLI already put it.
 *
 * There is no public usage API: `claude` talks to `/api/oauth/usage` with the
 * token it stores in the login keychain (or `~/.claude/.credentials.json` on
 * hosts where the keychain is unavailable), so we read the same credential and
 * send the same headers. Nothing here is cached — the controller owns the
 * refresh cadence, and re-reading the credential every time is also what keeps
 * us in step with a CLI that rotates the token out from under us.
 */

import { createHash } from "node:crypto";
import { vibeMetricLabel } from "../vibe-catalog.ts";
import {
  parseBody,
  request,
  requireSuccess,
  retryAfterMs,
  withTokenRefresh,
  type RawResponse,
} from "./http.ts";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  centsToDollars,
  consumptionMetric,
  epochMs,
  parseJsonWithHexFallback,
  PERIOD_MS,
  pick,
  timestampMs,
  titleCase,
} from "./parse.ts";
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

const PROVIDER_ID = "claude";

const DEFAULT_API_BASE = "https://api.anthropic.com";
const DEFAULT_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const PROD_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const NON_PROD_CLIENT_ID = "22422756-60c9-4084-8eb7-27705fd5cf9a";
/** The exact scope set `claude` asks for; a narrower request loses `user:profile`. */
const REFRESH_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
/** Without this scope the usage endpoint 403s, so we never call it. */
const USAGE_SCOPE = "user:profile";
/** The CLI refreshes five minutes ahead of expiry; a token that dies mid-request costs a whole cycle. */
const REFRESH_SLACK_MS = 5 * 60 * 1000;
/** `/api/oauth/usage` rate-limits hard and often omits Retry-After; back off five minutes by default. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
/** Anthropic gates the OAuth usage route on the CLI's own beta flag and UA. */
const ANTHROPIC_BETA = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.69";

const MISSING_SCOPE_NOTE = "这份登录没有用量权限，运行 `claude` 重新登录即可恢复会话与每周额度。";
const INFERENCE_ONLY_NOTE = "环境变量里只有推理用的 setup token，运行 `claude` 重新登录才能读到额度。";

type CredentialSource = "keychain" | "file" | "environment";

interface ClaudeOAuth {
  accessToken: string;
  refreshToken?: string;
  /** Epoch **milliseconds** — the CLI writes ms here, unlike every JWT `exp`. */
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
  scopes?: string[];
}

interface Candidate {
  source: CredentialSource;
  /** Which keychain item this came from, so a rotated blob goes back to it. */
  keychainService?: string;
  /**
   * A `claude setup-token` token from the environment: valid for inference,
   * 403 on the usage endpoint. Kept because it still proves a login exists.
   */
  inferenceOnly: boolean;
  oauth: ClaudeOAuth;
}

type LiveAvailability = "available" | "missing-scope" | "inference-only";

interface Endpoints {
  usageUrl: string;
  refreshUrl: string;
  clientId: string;
  /** Non-production logins get their own keychain item, e.g. `-staging-oauth`. */
  keychainSuffix: string;
}

function metricLabel(key: string): string {
  return vibeMetricLabel(PROVIDER_ID, key);
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** Claude Code's own flag convention: set means on unless explicitly falsy. */
function envFlag(env: Record<string, string | undefined>, name: string): boolean {
  const value = envValue(env, name)?.toLowerCase();
  if (value === undefined) return false;
  return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Anthropic staff run the CLI against local/staging OAuth; a custom URL beats
 * both. We resolve the same way so a non-production login reads its own
 * keychain item instead of silently reporting the production account.
 */
function resolveEndpoints(env: Record<string, string | undefined>): Endpoints {
  let apiBase = DEFAULT_API_BASE;
  let refreshUrl = DEFAULT_REFRESH_URL;
  let clientId = PROD_CLIENT_ID;
  let keychainSuffix = "";

  const isAnthropic = envValue(env, "USER_TYPE") === "ant";
  if (isAnthropic && envFlag(env, "USE_LOCAL_OAUTH")) {
    apiBase = trimTrailingSlashes(envValue(env, "CLAUDE_LOCAL_OAUTH_API_BASE") ?? "http://localhost:8000");
    refreshUrl = `${apiBase}/v1/oauth/token`;
    clientId = NON_PROD_CLIENT_ID;
    keychainSuffix = "-local-oauth";
  } else if (isAnthropic && envFlag(env, "USE_STAGING_OAUTH")) {
    apiBase = "https://api-staging.anthropic.com";
    refreshUrl = "https://platform.staging.ant.dev/v1/oauth/token";
    clientId = NON_PROD_CLIENT_ID;
    keychainSuffix = "-staging-oauth";
  }

  const customBase = envValue(env, "CLAUDE_CODE_CUSTOM_OAUTH_URL");
  if (customBase !== undefined) {
    apiBase = trimTrailingSlashes(customBase);
    refreshUrl = `${apiBase}/v1/oauth/token`;
    keychainSuffix = "-custom-oauth";
  }
  const customClientId = envValue(env, "CLAUDE_CODE_OAUTH_CLIENT_ID");
  if (customClientId !== undefined) clientId = customClientId;

  return { usageUrl: `${apiBase}/api/oauth/usage`, refreshUrl, clientId, keychainSuffix };
}

/**
 * A per-config-dir keychain item so several checkouts can be logged in at once;
 * the un-suffixed item stays as the fallback for logins that predate it.
 */
function keychainServices(env: Record<string, string | undefined>, suffix: string): string[] {
  const base = `Claude Code${suffix}-credentials`;
  const configDir = envValue(env, "CLAUDE_CONFIG_DIR");
  if (configDir === undefined) return [base];
  const hash = createHash("sha256").update(configDir.normalize("NFC"), "utf8").digest("hex").slice(0, 8);
  return [`${base}-${hash}`, base];
}

function credentialsPath(env: Record<string, string | undefined>): string {
  const configDir = envValue(env, "CLAUDE_CONFIG_DIR") ?? "~/.claude";
  return `${trimTrailingSlashes(configDir)}/.credentials.json`;
}

/** The stored blob is `{claudeAiOauth: {...}}`, sometimes hex-encoded. */
function parseOAuth(text: string | null): ClaudeOAuth | undefined {
  if (text === null) return undefined;
  const oauth = asRecord(pick(parseJsonWithHexFallback(text), "claudeAiOauth"));
  if (!oauth) return undefined;
  const accessToken = asString(oauth.accessToken);
  if (accessToken === undefined) return undefined;
  const scopes = asArray(oauth.scopes)?.flatMap((entry) => {
    const scope = asString(entry);
    return scope === undefined ? [] : [scope];
  });
  return {
    accessToken,
    refreshToken: asString(oauth.refreshToken),
    expiresAt: asNumber(oauth.expiresAt),
    subscriptionType: asString(oauth.subscriptionType),
    rateLimitTier: asString(oauth.rateLimitTier),
    scopes,
  };
}

/**
 * Credentials written before `scopes` existed carry none, and those logins do
 * have profile access — an empty list therefore means "assume live", not "deny".
 */
function liveAvailability(candidate: Candidate): LiveAvailability {
  if (candidate.inferenceOnly) return "inference-only";
  const scopes = candidate.oauth.scopes;
  if (scopes === undefined || scopes.length === 0) return "available";
  return scopes.includes(USAGE_SCOPE) ? "available" : "missing-scope";
}

async function loadCandidates(context: VibeAdapterContext, endpoints: Endpoints): Promise<Candidate[]> {
  const stored: Candidate[] = [];
  for (const service of keychainServices(context.env, endpoints.keychainSuffix)) {
    // A locked or denied keychain is not "no credential" — but it is also not
    // worth failing the whole provider over while a file copy may still exist.
    const raw = await context.keychain.read(service).catch(() => null);
    const oauth = parseOAuth(raw);
    if (oauth) stored.push({ source: "keychain", keychainService: service, inferenceOnly: false, oauth });
  }
  const fileOauth = parseOAuth(await context.readTextFile(credentialsPath(context.env)));
  if (fileOauth) stored.push({ source: "file", inferenceOnly: false, oauth: fileOauth });

  const envToken = envValue(context.env, "CLAUDE_CODE_OAUTH_TOKEN");
  if (envToken === undefined) return stored;

  // The env token carries no plan metadata, so it borrows the stored blob's —
  // and it goes last, because it cannot answer the usage endpoint at all.
  const donor = stored.find((candidate) => liveAvailability(candidate) === "available") ?? stored[0];
  const envCandidate: Candidate = {
    source: "environment",
    inferenceOnly: true,
    oauth: {
      accessToken: envToken,
      subscriptionType: donor?.oauth.subscriptionType,
      rateLimitTier: donor?.oauth.rateLimitTier,
    },
  };
  const liveCapable = stored.filter((candidate) => liveAvailability(candidate) === "available");
  return liveCapable.length === 0 ? [envCandidate] : [...liveCapable, envCandidate];
}

function needsRefresh(oauth: ClaudeOAuth, nowMs: number): boolean {
  // No expiry recorded means the CLI never learned one; refreshing blind would
  // rotate a working token for nothing.
  if (oauth.expiresAt === undefined) return false;
  return oauth.expiresAt - nowMs <= REFRESH_SLACK_MS;
}

/**
 * Exchanges the refresh token for a fresh access token.
 *
 * The rotated blob is NOT written back: this adapter has no writer in its
 * context by design. Anthropic rotates the refresh token on every exchange, so
 * a user who hits this path often enough may have to re-run `claude` — the
 * proactive window keeps that rare by only spending a refresh that the CLI
 * itself was about to spend.
 */
async function refreshOAuth(
  context: VibeAdapterContext,
  endpoints: Endpoints,
  oauth: ClaudeOAuth,
): Promise<ClaudeOAuth> {
  const response = await request(endpoints.refreshUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: endpoints.clientId,
      scope: REFRESH_SCOPES,
    }),
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: PROVIDER_ID,
  });

  if (response.status === 400 || response.status === 401) {
    const body = asRecord(parseBody(response));
    const code = asString(body?.error) ?? asString(body?.error_description);
    // Only `invalid_grant` means the login is really gone; a 400 from a WAF
    // page must not send the user off to re-authenticate for nothing.
    if (code === "invalid_grant") {
      throw new VibeCredentialsExpiredError(PROVIDER_ID, "session expired — run `claude` to log in again");
    }
    throw new VibeRequestError(PROVIDER_ID, `token refresh failed: HTTP ${response.status}`, response.status);
  }
  if (!response.ok) {
    throw new VibeRequestError(PROVIDER_ID, `token refresh failed: HTTP ${response.status}`, response.status);
  }

  const body = asRecord(parseBody(response));
  const accessToken = asString(body?.access_token);
  if (accessToken === undefined) {
    throw new VibeCredentialsExpiredError(PROVIDER_ID, "token refresh returned no access token");
  }
  const expiresIn = asNumber(body?.expires_in);
  return {
    ...oauth,
    accessToken,
    refreshToken: asString(body?.refresh_token) ?? oauth.refreshToken,
    // `expires_in` is seconds; the stored field is milliseconds.
    expiresAt: expiresIn === undefined ? oauth.expiresAt : context.now() + expiresIn * 1000,
  };
}

/** A reset stamp is an ISO string most days and an epoch number on others. */
function resetMs(value: unknown): number | undefined {
  return timestampMs(value) ?? epochMs(value);
}

function windowMetric(
  key: string,
  value: unknown,
  windowSeconds: number,
): VibeMetric | undefined {
  const window = asRecord(value);
  if (!window) return undefined;
  return consumptionMetric({
    key,
    label: metricLabel(key),
    unit: "percent",
    // Anthropic already reports a 0–100 percentage of the window; there is no
    // token count behind it, so the limit is the scale itself.
    used: asNumber(window.utilization),
    limit: 100,
    resetsAtMs: resetMs(window.resets_at),
    windowSeconds,
  });
}

/** The weekly per-model row for Fable, which arrives inside the generic `limits[]`. */
function fableMetric(body: Record<string, unknown>): VibeMetric | undefined {
  for (const entry of asArray(body.limits) ?? []) {
    const limit = asRecord(entry);
    if (!limit || limit.kind !== "weekly_scoped") continue;
    if (asString(pick(limit, "scope", "model", "display_name")) !== "Fable") continue;
    return consumptionMetric({
      key: "fable",
      label: metricLabel("fable"),
      unit: "percent",
      used: asNumber(limit.percent),
      limit: 100,
      resetsAtMs: resetMs(limit.resets_at),
      windowSeconds: PERIOD_MS.week / 1000,
    });
  }
  return undefined;
}

/** Extra usage is billed in cents and only counts once the user has opted in. */
function extraUsageMetric(body: Record<string, unknown>): VibeMetric | undefined {
  const extra = asRecord(body.extra_usage);
  if (!extra || extra.is_enabled !== true) return undefined;
  const usedCents = asNumber(extra.used_credits);
  if (usedCents === undefined) return undefined;
  const used = centsToDollars(usedCents);
  const limitCents = asNumber(extra.monthly_limit);
  if (limitCents !== undefined && limitCents > 0) {
    return consumptionMetric({
      key: "extraUsage",
      label: metricLabel("extraUsage"),
      unit: "usd",
      used,
      limit: centsToDollars(limitCents),
    });
  }
  // No cap configured: an unbounded spend row, and only when there is spend to
  // show — "$0.00 of nothing" is noise, not information.
  if (used <= 0) return undefined;
  return consumptionMetric({
    key: "extraUsage",
    label: metricLabel("extraUsage"),
    unit: "usd",
    used,
    limit: undefined,
  });
}

function mapUsage(body: unknown): VibeMetric[] {
  const record = asRecord(body);
  if (!record) throw new VibeRequestError(PROVIDER_ID, "usage response was not a JSON object");
  const metrics = [
    windowMetric("session", record.five_hour, PERIOD_MS.session / 1000),
    windowMetric("weekly", record.seven_day, PERIOD_MS.week / 1000),
    windowMetric("sonnet", record.seven_day_sonnet, PERIOD_MS.week / 1000),
    fableMetric(record),
    extraUsageMetric(record),
  ];
  return metrics.filter((metric): metric is VibeMetric => metric !== undefined);
}

/** "max" + tier "tier_20x" → "Max 20x". The plan lives in the credential, not the response. */
function formatPlan(oauth: ClaudeOAuth): string | undefined {
  if (oauth.subscriptionType === undefined) return undefined;
  const base = titleCase(oauth.subscriptionType);
  const tier = oauth.rateLimitTier === undefined ? null : /\d+x/.exec(oauth.rateLimitTier);
  return tier === null ? base : `${base} ${tier[0]}`;
}

/**
 * Hands a rotated credential back to the CLI that owns it.
 *
 * Anthropic returns a NEW refresh token on every exchange and retires the old
 * one. If we spend a refresh and keep the result to ourselves, the copy in
 * `.credentials.json` is dead, and the next `claude` run finds itself logged
 * out — a pixel clock must never do that to somebody's editor. Only the file
 * source is written; a keychain login is never refreshed at all (see the guard
 * in fetchWithCandidate and the note in keychain.ts).
 *
 * The blob is REBUILT FROM THE ORIGINAL, not from our model of it: a real
 * credential carries keys we neither read nor understand (`mcpOAuth` holds the
 * OAuth tokens for the user's MCP servers, `refreshTokenExpiresAt` sits beside
 * the fields we do read), and writing back only what this file happens to model
 * would silently delete them. So we re-read the source, overwrite the four
 * fields the exchange actually changed, and leave every other byte alone.
 *
 * A failure here is deliberately swallowed: the usage read that follows is
 * still valid, and there is nothing the user could do about a locked keychain
 * mid-render. The stale copy simply forces them to sign in again later, which
 * is where they would have been anyway.
 */
async function persistRefreshed(
  context: VibeAdapterContext,
  candidate: Candidate,
  oauth: ClaudeOAuth,
): Promise<void> {
  const path = credentialsPath(context.env);
  try {
    if (candidate.source !== "file") return;
    const raw = await context.readTextFile(path);
    if (raw === null) return;
    const root = asRecord(parseJsonWithHexFallback(raw));
    const existing = asRecord(root?.claudeAiOauth);
    // No recognisable blob to merge into means something else owns this item;
    // overwriting it with our own shape would be worse than doing nothing.
    if (root === undefined || existing === undefined) return;
    const merged = {
      ...root,
      claudeAiOauth: {
        ...existing,
        accessToken: oauth.accessToken,
        ...(oauth.refreshToken === undefined ? {} : { refreshToken: oauth.refreshToken }),
        ...(oauth.expiresAt === undefined ? {} : { expiresAt: oauth.expiresAt }),
      },
    };
    await context.writeTextFile(path, `${JSON.stringify(merged)}\n`);
  } catch {
    // See the note above: a failed write-back costs a future login, not this read.
  }
}

async function fetchWithCandidate(
  context: VibeAdapterContext,
  endpoints: Endpoints,
  candidate: Candidate,
): Promise<VibeProviderResult> {
  let oauth = candidate.oauth;
  // A refresh we cannot write back is a refresh that signs the user out of
  // Claude Code: Anthropic retires the old token the moment it issues a new
  // one, and the keychain cannot be rewritten safely (keychain.ts). So a
  // keychain login is used exactly as it stands — when it expires, the panel
  // says so and the next `claude` run repairs it.
  const writable = candidate.source === "file";
  const refresh = oauth.refreshToken === undefined || !writable
    ? undefined
    : async (): Promise<string> => {
      oauth = await refreshOAuth(context, endpoints, oauth);
      // Persist before the retry: if the usage call then fails, the rotated
      // token is still the one the CLI needs to hold.
      await persistRefreshed(context, candidate, oauth);
      return oauth.accessToken;
    };
  if (refresh !== undefined && needsRefresh(oauth, context.now())) await refresh();

  const attempt = (token: string): Promise<RawResponse> =>
    request(endpoints.usageUrl, {
      headers: {
        // The stored blob sometimes keeps a trailing newline from a shell write.
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": ANTHROPIC_BETA,
        "User-Agent": USER_AGENT,
      },
      timeoutMs: context.timeoutMs,
      fetch: context.fetch,
      providerId: PROVIDER_ID,
    });

  const response = await withTokenRefresh({ providerId: PROVIDER_ID, token: oauth.accessToken, attempt, refresh });
  if (response.status === 429) {
    // Anthropic frequently answers 429 with no Retry-After; hammering it makes
    // the block longer, so we hand the controller an explicit cooldown.
    throw new VibeRateLimitedError(
      PROVIDER_ID,
      retryAfterMs(response, context.now()) ?? RATE_LIMIT_COOLDOWN_MS,
    );
  }
  const body = requireSuccess(response, PROVIDER_ID, context.now());
  const plan = formatPlan(candidate.oauth);
  return { ...(plan === undefined ? {} : { plan }), metrics: mapUsage(body) };
}

export const claudeAdapter: VibeProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "Claude",

  async detect(context: VibeAdapterContext): Promise<boolean> {
    const candidates = await loadCandidates(context, resolveEndpoints(context.env));
    return candidates.length > 0;
  },

  async fetchUsage(context: VibeAdapterContext): Promise<VibeProviderResult> {
    const endpoints = resolveEndpoints(context.env);
    const candidates = await loadCandidates(context, endpoints);
    if (candidates.length === 0) {
      throw new VibeCredentialsMissingError(PROVIDER_ID, "not logged in — run `claude` to authenticate");
    }

    const live = candidates.filter((candidate) => liveAvailability(candidate) === "available");
    if (live.length === 0) {
      // Logged in, just not with a credential that may read usage. That is a
      // state to explain, not an error to raise: the panel stays quiet and the
      // console tells the user which command restores the numbers.
      const first = candidates[0]!;
      const plan = formatPlan(first.oauth);
      return {
        ...(plan === undefined ? {} : { plan }),
        metrics: [],
        note: liveAvailability(first) === "inference-only" ? INFERENCE_ONLY_NOTE : MISSING_SCOPE_NOTE,
      };
    }

    // A stale keychain item next to a fresh file login is common enough that
    // giving up on the first rejection would report "signed out" to a user who
    // is signed in; only an expired credential falls through to the next one.
    let expired: VibeCredentialsExpiredError | undefined;
    for (const candidate of live) {
      try {
        return await fetchWithCandidate(context, endpoints, candidate);
      } catch (error) {
        if (!(error instanceof VibeCredentialsExpiredError)) throw error;
        expired = error;
      }
    }
    throw expired ?? new VibeCredentialsExpiredError(PROVIDER_ID);
  },
};
