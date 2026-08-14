/**
 * Devin quota.
 *
 * Devin is Windsurf/Codeium-backed, so the usage call is the Codeium seat
 * management Connect-RPC, and the credential is a plain API key rather than an
 * OAuth grant — there is no refresh flow anywhere in this provider. The key
 * lives in one of two places depending on how the user signed in: the CLI
 * writes `~/.local/share/devin/credentials.toml`, the desktop app stores it in
 * its VS Code-style state DB. Both are tried, the CLI file first.
 *
 * Percentages arrive as *remaining*, so every meter here is `100 - remaining`,
 * and the reset stamps are absolute Unix seconds, not offsets.
 */

import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  balanceMetric,
  consumptionMetric,
  epochMs,
  PERIOD_MS,
  pick,
} from "./parse.ts";
import { request, requireSuccess } from "./http.ts";
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

const PROVIDER_ID = "devin";

const CREDENTIALS_PATH = "~/.local/share/devin/credentials.toml";
const STATE_DB_DIR = "~/Library/Application Support/Devin/User/globalStorage";
const STATE_DB_NAME = "state.vscdb";
const STATE_DB_KEY = "windsurfAuthStatus";

const DEFAULT_API_SERVER = "https://server.codeium.com";
const USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
/** The IDE build the seat service expects; sent as both version fields. */
const COMPAT_VERSION = "1.108.2";

const NOT_SIGNED_IN = "run `devin auth login` or sign in to Devin and try again";
const QUOTA_UNAVAILABLE = "Devin quota data unavailable";

interface DevinCredential {
  apiKey: string;
  server: string;
}

export const devinAdapter: VibeProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "Devin",

  async detect(context) {
    if (context.apiKey(PROVIDER_ID) !== null) return true;
    if (await context.readTextFile(CREDENTIALS_PATH) !== null) return true;
    // Only the directory listing here: the state DB is megabytes of SQLite and
    // this probe runs before every refresh.
    return (await context.listDirectory(STATE_DB_DIR)).includes(STATE_DB_NAME);
  },

  async fetchUsage(context) {
    const credentials = await collectCredentials(context);
    if (credentials.length === 0) throw new VibeCredentialsMissingError(PROVIDER_ID, NOT_SIGNED_IN);

    let sawAuthFailure = false;
    let lastError: unknown;
    for (const credential of credentials) {
      try {
        return await fetchWith(context, credential);
      } catch (error) {
        // Every source talks to the same host, so a rate limit is the host's
        // answer for all of them; retrying with the next key only deepens it.
        if (error instanceof VibeRateLimitedError) throw error;
        if (error instanceof VibeCredentialsExpiredError) sawAuthFailure = true;
        lastError = error;
      }
    }
    if (sawAuthFailure) throw new VibeCredentialsExpiredError(PROVIDER_ID, NOT_SIGNED_IN);
    throw lastError instanceof Error ? lastError : new VibeRequestError(PROVIDER_ID, QUOTA_UNAVAILABLE);
  },
};

// --- credentials ------------------------------------------------------------

async function collectCredentials(context: VibeAdapterContext): Promise<DevinCredential[]> {
  const found: DevinCredential[] = [];
  const push = (credential: DevinCredential | undefined) => {
    if (credential === undefined) return;
    // The app and the CLI usually hold the same key; sending it twice buys
    // nothing but a second rejection.
    if (found.some((seen) => seen.apiKey === credential.apiKey && seen.server === credential.server)) return;
    found.push(credential);
  };

  // A key the user typed into the console is a deliberate choice; it wins.
  const configured = context.apiKey(PROVIDER_ID);
  if (configured !== null && configured.trim() !== "") {
    push({ apiKey: configured.trim(), server: DEFAULT_API_SERVER });
  }
  push(await loadFileCredential(context));
  push(await loadAppCredential(context));
  return found;
}

async function loadFileCredential(context: VibeAdapterContext): Promise<DevinCredential | undefined> {
  const text = await context.readTextFile(CREDENTIALS_PATH);
  if (text === null) return undefined;
  const apiKey = readTomlValue(text, "windsurf_api_key");
  if (apiKey === undefined) return undefined;
  return { apiKey, server: cleanServerUrl(readTomlValue(text, "api_server_url")) ?? DEFAULT_API_SERVER };
}

/**
 * The desktop app keeps its auth blob in a VS Code state DB, which upstream
 * reads with the `sqlite3` CLI. An adapter may not spawn one, so we read the
 * file and pull the record out of it: SQLite stores TEXT column values verbatim
 * in the page bytes, key first, so the JSON sits a few bytes past its key. A
 * miss just means this source yields nothing — never a wrong key.
 */
async function loadAppCredential(context: VibeAdapterContext): Promise<DevinCredential | undefined> {
  if (!(await context.listDirectory(STATE_DB_DIR)).includes(STATE_DB_NAME)) return undefined;
  const raw = await context.readTextFile(`${STATE_DB_DIR}/${STATE_DB_NAME}`);
  if (raw === null) return undefined;
  const apiKey = scanStateDbForApiKey(raw);
  if (apiKey === undefined) return undefined;
  // This source never carries a server override, so the default host applies.
  return { apiKey, server: DEFAULT_API_SERVER };
}

/** How far past the key marker the value can start before we stop believing it. */
const STATE_DB_VALUE_WINDOW = 4_096;

function scanStateDbForApiKey(raw: string): string | undefined {
  let cursor = raw.indexOf(STATE_DB_KEY);
  while (cursor !== -1) {
    const start = raw.indexOf("{", cursor);
    if (start !== -1 && start - cursor <= STATE_DB_VALUE_WINDOW) {
      const json = sliceJsonObject(raw, start, STATE_DB_VALUE_WINDOW);
      if (json !== undefined) {
        try {
          const apiKey = asString(pick(JSON.parse(json), "apiKey"));
          if (apiKey !== undefined) return apiKey;
        } catch {
          // A freelist copy of an older record; keep looking.
        }
      }
    }
    cursor = raw.indexOf(STATE_DB_KEY, cursor + STATE_DB_KEY.length);
  }
  return undefined;
}

/** Brace matching that ignores braces inside strings, bounded so a corrupt page cannot run away. */
function sliceJsonObject(text: string, start: number, limit: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const end = Math.min(text.length, start + limit);
  for (let index = start; index < end; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * A four-line scanner instead of a TOML parser, matching upstream exactly —
 * including the rule that a key present with an empty value aborts the search
 * rather than falling through to a later line.
 */
function readTomlValue(text: string, key: string): string | undefined {
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim() !== key) continue;

    const rest = line.slice(separator + 1).trim();
    if (rest === "") return undefined;
    const quote = rest[0];
    if (quote === "\"" || quote === "'") {
      let value = "";
      let escaped = false;
      for (let index = 1; index < rest.length; index += 1) {
        const char = rest[index]!;
        // Escapes are not unescaped, only honoured as "this quote is not the end".
        if (!escaped && char === quote) break;
        escaped = !escaped && char === "\\";
        value += char;
      }
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    }
    const bare = rest.split("#")[0]!.trim();
    return bare === "" ? undefined : bare;
  }
  return undefined;
}

/** Only https, and no trailing slash — a plain-http override is dropped, not honoured. */
function cleanServerUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("https://")) return undefined;
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? undefined : stripped;
}

// --- usage ------------------------------------------------------------------

async function fetchWith(context: VibeAdapterContext, credential: DevinCredential): Promise<VibeProviderResult> {
  const response = await request(`${credential.server}${USER_STATUS_PATH}`, {
    method: "POST",
    // No Authorization header: this API carries the key inside the body.
    headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: JSON.stringify({
      metadata: {
        apiKey: credential.apiKey,
        ideName: "devin",
        ideVersion: COMPAT_VERSION,
        extensionName: "devin",
        extensionVersion: COMPAT_VERSION,
        locale: "en",
      },
    }),
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: PROVIDER_ID,
  });
  return mapUserStatus(requireSuccess(response, PROVIDER_ID, context.now()));
}

function mapUserStatus(body: unknown): VibeProviderResult {
  const userStatus = asRecord(pick(body, "userStatus"));
  if (userStatus === undefined) throw new VibeRequestError(PROVIDER_ID, QUOTA_UNAVAILABLE);

  const planStatus = asRecord(userStatus.planStatus) ?? {};
  const planInfo = asRecord(planStatus.planInfo) ?? {};
  // Devin always names a plan; an absent one is upstream's own literal.
  const plan = asString(planInfo.planName) ?? "Unknown";
  const hideDaily = asBoolean(planInfo.hideDailyQuota) ?? false;

  const dailyRemaining = asNumber(planStatus.dailyQuotaRemainingPercent);
  const weeklyRemaining = asNumber(planStatus.weeklyQuotaRemainingPercent);
  const weeklyResetMs = epochMs(planStatus.weeklyQuotaResetAtUnix);

  const metrics: VibeMetric[] = [];
  if (!hideDaily && dailyRemaining !== undefined) {
    pushMetric(metrics, consumptionMetric({
      key: "daily",
      label: "Daily",
      unit: "percent",
      used: 100 - dailyRemaining,
      limit: 100,
      resetsAtMs: epochMs(planStatus.dailyQuotaResetAtUnix),
      windowSeconds: PERIOD_MS.day / 1000,
    }));
  }

  // Plans that hide the daily row still meter daily; the weekly slot is where
  // that figure is shown, stamped with the weekly window it is displayed under.
  const weeklySource = weeklyRemaining ?? (hideDaily ? dailyRemaining : undefined);
  if (weeklySource !== undefined) {
    pushMetric(metrics, consumptionMetric({
      key: "weekly",
      label: "Weekly",
      unit: "percent",
      used: 100 - weeklySource,
      limit: 100,
      resetsAtMs: weeklyResetMs,
      windowSeconds: PERIOD_MS.week / 1000,
    }));
  }

  const overageMicros = asNumber(planStatus.overageBalanceMicros);
  if (overageMicros !== undefined) {
    // Micros → dollars. A real 0 is a balance of zero, which is worth showing;
    // only an absent field drops the row.
    pushMetric(metrics, balanceMetric({
      key: "extraUsageBalance",
      label: "Extra Balance",
      unit: "usd",
      available: Math.max(0, overageMicros) / 1_000_000,
    }));
  }

  if (metrics.length === 0) throw new VibeRequestError(PROVIDER_ID, QUOTA_UNAVAILABLE);
  return { plan, metrics };
}

function pushMetric(metrics: VibeMetric[], metric: VibeMetric | undefined): void {
  if (metric !== undefined) metrics.push(metric);
}
