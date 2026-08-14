/**
 * Grok (xAI) usage.
 *
 * The `grok` CLI leaves an OAuth blob at `~/.grok/auth.json`: a map of
 * `"<issuer>::<clientId>"` → entry, one per signed-in account. There is no
 * Keychain item, no env-var token and no API-key path for Grok, so that file is
 * the only credential source — and the entry key doubles as the OAuth client id
 * when the entry does not carry one.
 *
 * The quota itself comes from the same billing proxy the CLI calls, which speaks
 * proto3-JSON: zero-valued fields are omitted entirely, so "absent" and "0" are
 * the same statement and must be read as such (see `decodeCreditsConfig`).
 */

import { vibeMetricLabel } from "../vibe-catalog.ts";
import { parseBody, request, requireSuccess, withTokenRefresh, type RawResponse } from "./http.ts";
import {
  asNumber,
  asRecord,
  asString,
  consumptionMetric,
  epochMs,
  jwtPayload,
  parseJsonWithHexFallback,
  pick,
  timestampMs,
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

const PROVIDER_ID = "grok";
const AUTH_PATH = "~/.grok/auth.json";
const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const REFRESH_URL = "https://auth.x.ai/oauth2/token";
/** The proxy gates CLI traffic on this header, not on the User-Agent. */
const TOKEN_AUTH_HEADER = "xai-grok-cli";
/** Used when neither the entry nor its key names a client — the CLI's own id. */
const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
/** Refresh this far ahead of expiry so a long render never races the clock. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
/** The only period type that maps to a weekly meter; monthly accounts have none. */
const WEEKLY_PERIOD_TYPE = "USAGE_PERIOD_TYPE_WEEKLY";

interface GrokCandidate {
  /** Which account entry in auth.json this came from, for the write-back. */
  entryKey: string;
  /** Mutated in place when a refresh rotates the access token mid-run. */
  token: string;
  refreshToken: string | undefined;
  clientId: string;
  /** `expires_at` / `expires` from the file, when either parses. */
  entryExpiresAtMs: number | undefined;
}

interface GrokCreditsConfig {
  periodType: string;
  periodStartMs: number;
  periodEndMs: number;
  usedPercent: number;
  onDemandCap: number;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-XAI-Token-Auth": TOKEN_AUTH_HEADER,
    Accept: "application/json",
    // Any UA is accepted; the proxy authenticates on the bearer plus the header
    // above. We send our own rather than borrow another client's identity.
    "User-Agent": "vibe-usage",
  };
}

/**
 * `application/x-www-form-urlencoded` per RFC 3986: a space is `%20`, never `+`.
 * The token endpoint rejects the `+` form, which is what `URLSearchParams` emits.
 */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `"https://auth.x.ai::client"` → `"client"`; the CLI encodes the client id there. */
function clientIdFromEntryKey(entryKey: string): string | undefined {
  const segments = entryKey.split("::");
  return segments.length > 1 ? asString(segments[segments.length - 1]) : undefined;
}

/**
 * The access token is a JWT; its `exp` claim is the authoritative expiry. `exp`
 * is seconds by spec, and `epochMs` tolerates a vendor that ever sends ms. A
 * non-JWT token simply has no expiry and is used as-is.
 */
function tokenExpiresAtMs(token: string): number | undefined {
  const payload = jwtPayload(token);
  return payload === undefined ? undefined : epochMs(payload.exp);
}

async function loadCandidates(context: VibeAdapterContext): Promise<GrokCandidate[]> {
  let text: string | null;
  try {
    text = await context.readTextFile(AUTH_PATH);
  } catch {
    // Unreadable is indistinguishable from absent for the user's next action:
    // both are fixed by `grok login`.
    throw new VibeCredentialsMissingError(PROVIDER_ID, "~/.grok/auth.json is unreadable; run `grok login`");
  }
  if (text === null) {
    throw new VibeCredentialsMissingError(PROVIDER_ID, "no ~/.grok/auth.json; run `grok login`");
  }
  const auth = asRecord(parseJsonWithHexFallback(text));
  if (auth === undefined) {
    throw new VibeCredentialsMissingError(PROVIDER_ID, "~/.grok/auth.json is not a credential map; run `grok login`");
  }

  const candidates: GrokCandidate[] = [];
  for (const [entryKey, value] of Object.entries(auth)) {
    const entry = asRecord(value);
    if (entry === undefined) continue;
    const token = asString(entry.key);
    if (token === undefined) continue;
    candidates.push({
      token,
      // `refresh` is the legacy alias the older CLI wrote.
      refreshToken: asString(entry.refresh_token) ?? asString(entry.refresh),
      entryKey,
      clientId: asString(entry.oidc_client_id) ?? clientIdFromEntryKey(entryKey) ?? DEFAULT_CLIENT_ID,
      entryExpiresAtMs: timestampMs(entry.expires_at) ?? timestampMs(entry.expires),
    });
  }
  if (candidates.length === 0) {
    throw new VibeCredentialsMissingError(PROVIDER_ID, "~/.grok/auth.json has no access token; run `grok login`");
  }
  return candidates;
}

/** Either clock saying "about to expire" is enough to spend a refresh token. */
function needsRefresh(candidate: GrokCandidate, nowMs: number): boolean {
  const fromEntry = candidate.entryExpiresAtMs;
  const fromToken = tokenExpiresAtMs(candidate.token);
  if (fromEntry !== undefined && fromEntry - nowMs <= REFRESH_BUFFER_MS) return true;
  return fromToken !== undefined && fromToken - nowMs <= REFRESH_BUFFER_MS;
}

/** The JWT wins over the file: the file's `expires_at` is a copy that goes stale. */
function isExpired(candidate: GrokCandidate, nowMs: number): boolean {
  const expiresAt = tokenExpiresAtMs(candidate.token) ?? candidate.entryExpiresAtMs;
  return expiresAt !== undefined && nowMs >= expiresAt;
}

/**
 * Spends the refresh token and rotates `candidate` in memory.
 *
 * Every failure mode — no refresh token, transport error, non-2xx, unparseable
 * body, blank access token — returns undefined rather than throwing, because the
 * caller's next move is to try the next account, not to fail the provider.
 *
 * The rotated token IS written back: auth.x.ai is an OIDC issuer that returns a
 * new refresh token on every exchange and revokes the chain if the retired one
 * is presented again, so keeping the rotation to ourselves would sign the user
 * out of their own `grok` CLI. The write merges into the existing entry rather
 * than rebuilding the file — auth.json is a map that may hold other accounts,
 * and each entry carries a dozen fields we never read.
 */
async function refreshAccessToken(
  context: VibeAdapterContext,
  candidate: GrokCandidate,
): Promise<string | undefined> {
  const refreshToken = candidate.refreshToken;
  if (refreshToken === undefined) return undefined;
  const body = `grant_type=refresh_token&client_id=${formEncode(candidate.clientId)}`
    + `&refresh_token=${formEncode(refreshToken)}`;

  let response: RawResponse;
  try {
    response = await request(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      timeoutMs: context.timeoutMs,
      fetch: context.fetch,
      providerId: PROVIDER_ID,
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const payload = asRecord(parseBody(response));
  const access = payload === undefined ? undefined : asString(payload.access_token);
  if (access === undefined) return undefined;

  candidate.token = access;
  const rotated = payload === undefined ? undefined : asString(payload.refresh_token);
  if (rotated !== undefined) candidate.refreshToken = rotated;
  await persistRotated(context, candidate, {
    key: access,
    refreshToken: rotated,
    expiresInSeconds: asNumber(payload?.expires_in),
  });
  return access;
}

/**
 * Merges a rotated credential back into this account's entry in auth.json.
 *
 * Everything is preserved except the three fields the exchange changed; a file
 * that no longer parses, or an entry that has since disappeared, aborts the
 * write rather than replacing someone else's data with ours. A failed write is
 * swallowed — this read is still valid and a locked file mid-render is not
 * something the user can act on.
 */
async function persistRotated(
  context: VibeAdapterContext,
  candidate: GrokCandidate,
  rotated: { key: string; refreshToken: string | undefined; expiresInSeconds: number | undefined },
): Promise<void> {
  try {
    const raw = await context.readTextFile(AUTH_PATH);
    if (raw === null) return;
    const root = asRecord(parseJsonWithHexFallback(raw));
    const entry = asRecord(root?.[candidate.entryKey]);
    if (root === undefined || entry === undefined) return;
    const next = {
      ...root,
      [candidate.entryKey]: {
        ...entry,
        key: rotated.key,
        ...(rotated.refreshToken === undefined ? {} : { refresh_token: rotated.refreshToken }),
        ...(rotated.expiresInSeconds === undefined
          ? {}
          : { expires_at: new Date(context.now() + rotated.expiresInSeconds * 1000).toISOString() }),
      },
    };
    await context.writeTextFile(AUTH_PATH, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // See the note above: a failed write-back costs a future login, not this read.
  }
}

async function fetchCredits(context: VibeAdapterContext, candidate: GrokCandidate): Promise<unknown> {
  const attempt = (token: string) => request(CREDITS_URL, {
    headers: headers(token),
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: PROVIDER_ID,
  });
  const refresh = candidate.refreshToken === undefined ? undefined : async () => {
    const fresh = await refreshAccessToken(context, candidate);
    if (fresh === undefined) throw new VibeCredentialsExpiredError(PROVIDER_ID);
    return fresh;
  };
  const response = await withTokenRefresh({
    providerId: PROVIDER_ID,
    token: candidate.token,
    attempt,
    refresh,
  });
  return requireSuccess(response, PROVIDER_ID, context.now());
}

function invalidResponse(): VibeRequestError {
  return new VibeRequestError(PROVIDER_ID, "grok billing response changed");
}

/**
 * proto3-JSON, so every zero is missing rather than sent. `creditUsagePercent`
 * and `onDemandCap` therefore default to 0 when absent — that is the vendor
 * saying zero, not us inventing a number. Anything present but the wrong type
 * means the contract moved and we fail loudly instead of guessing.
 */
function decodeCreditsConfig(body: unknown): GrokCreditsConfig {
  const config = asRecord(pick(body, "config"));
  const period = asRecord(pick(config, "currentPeriod"));
  if (config === undefined || period === undefined) throw invalidResponse();

  const periodType = asString(period.type);
  const periodStartMs = timestampMs(period.start);
  const periodEndMs = timestampMs(period.end);
  if (periodType === undefined || periodStartMs === undefined || periodEndMs === undefined) {
    throw invalidResponse();
  }
  if (periodEndMs <= periodStartMs) throw invalidResponse();

  const usedPercent = config.creditUsagePercent === undefined ? 0 : asNumber(config.creditUsagePercent);
  if (usedPercent === undefined) throw invalidResponse();

  let onDemandCap = 0;
  if (config.onDemandCap !== undefined) {
    const cap = asRecord(config.onDemandCap);
    if (cap === undefined) throw invalidResponse();
    const value = cap.val === undefined ? 0 : asNumber(cap.val);
    if (value === undefined) throw invalidResponse();
    onDemandCap = value;
  }

  return { periodType, periodStartMs, periodEndMs, usedPercent, onDemandCap };
}

/** Best-effort: the plan is decoration, so any failure here costs a label, not the fetch. */
async function fetchPlan(context: VibeAdapterContext, token: string): Promise<string | undefined> {
  try {
    const response = await request(SETTINGS_URL, {
      headers: headers(token),
      timeoutMs: context.timeoutMs,
      fetch: context.fetch,
      providerId: PROVIDER_ID,
    });
    if (!response.ok) return undefined;
    // Verbatim vendor wording ("SuperGrok Heavy") — no mapping table exists.
    return asString(pick(parseBody(response), "subscription_tier_display"));
  } catch {
    return undefined;
  }
}

/** `2500` renders as "2500"; a fractional cap keeps its decimals. */
function formatUnits(value: number): string {
  return String(value);
}

async function probe(context: VibeAdapterContext, candidate: GrokCandidate): Promise<VibeProviderResult> {
  const config = decodeCreditsConfig(await fetchCredits(context, candidate));
  // The plan call rides the possibly-rotated token, so it must run after the
  // credits fetch has had its chance to refresh.
  const plan = await fetchPlan(context, candidate.token);

  const metrics: VibeMetric[] = [];
  if (config.periodType === WEEKLY_PERIOD_TYPE) {
    const weekly = consumptionMetric({
      key: "weekly",
      label: vibeMetricLabel(PROVIDER_ID, "weekly"),
      unit: "percent",
      used: config.usedPercent,
      limit: 100,
      resetsAtMs: config.periodEndMs,
      // The window is measured from the billing period itself, not assumed.
      windowSeconds: Math.round(config.periodEndMs - config.periodStartMs) / 1000,
    });
    if (weekly !== undefined) metrics.push(weekly);
  }

  const result: VibeProviderResult = {
    metrics,
    spendLines: [{
      label: "Pay as you go",
      value: config.onDemandCap > 0 ? `${formatUnits(config.onDemandCap)} cap` : "Disabled",
    }],
  };
  if (plan !== undefined) result.plan = plan;
  if (metrics.length === 0) {
    // A monthly (or future) billing period simply has no weekly meter. Not an
    // error — but without this the panel would look broken rather than empty.
    result.note = `no weekly meter on this billing period (${config.periodType})`;
  }
  return result;
}

export const grokAdapter: VibeProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "Grok",

  async detect(context: VibeAdapterContext): Promise<boolean> {
    try {
      return (await loadCandidates(context)).length > 0;
    } catch {
      return false;
    }
  },

  async fetchUsage(context: VibeAdapterContext): Promise<VibeProviderResult> {
    const candidates = await loadCandidates(context);
    let sawExpired = false;
    for (const candidate of candidates) {
      if (needsRefresh(candidate, context.now())) {
        const fresh = await refreshAccessToken(context, candidate);
        // A dead refresh token on an already-expired credential means this
        // account is done; a live-but-stale one is still worth trying.
        if (fresh === undefined && isExpired(candidate, context.now())) {
          sawExpired = true;
          continue;
        }
      }
      return await probe(context, candidate);
    }
    throw sawExpired
      ? new VibeCredentialsExpiredError(PROVIDER_ID, "grok sign-in expired; run `grok login` again")
      : new VibeCredentialsMissingError(PROVIDER_ID, "no usable grok credential; run `grok login`");
  },
};
