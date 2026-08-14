/**
 * GitHub Copilot.
 *
 * Copilot has no OAuth dance of its own here: whatever token the editor plugin
 * or `gh` already stored is used verbatim against `copilot_internal/user`, the
 * same private endpoint the VS Code extension calls for its quota bar. There is
 * nothing to refresh and nothing to write back, so a rejected token means one
 * thing only — sign in again.
 *
 * Two account shapes have to survive: a personal seat, whose meters arrive as
 * `quota_snapshots` percentages, and an org-managed seat, whose snapshots are
 * all "unlimited" placeholders and whose real numbers live in the organisation's
 * billing summary. The second lookup is best-effort by design: the usual token
 * lacks `read:org`, and a plan-only card beats a red one.
 */

import { parseBody, request, requireSuccess } from "./http.ts";
import {
  PERIOD_MS,
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  clampPercent,
  consumptionMetric,
  parseJsonWithHexFallback,
  timestampMs,
  titleCase,
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

const ID = "copilot";

const EDITOR_APPS_PATH = "~/.config/github-copilot/apps.json";
const EDITOR_HOSTS_PATH = "~/.config/github-copilot/hosts.json";
const GH_HOSTS_PATH = "~/.config/gh/hosts.yml";
const GH_KEYCHAIN_SERVICE = "gh:github.com";
const GO_KEYRING_PREFIX = "go-keyring-base64:";

const USAGE_URL = "https://api.github.com/copilot_internal/user";
const ORGS_URL = "https://api.github.com/user/orgs?per_page=100";
const ORG_BILLING_URL = (org: string) =>
  `https://api.github.com/orgs/${encodeURIComponent(org)}/settings/billing/usage/summary`;

/**
 * `copilot_internal` is undocumented and gates on looking like the extension:
 * without the editor headers it answers 404 for perfectly valid tokens.
 */
const USAGE_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Editor-Version": "vscode/1.96.2",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "X-Github-Api-Version": "2025-04-01",
};

const REST_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "VIBE",
  "X-GitHub-Api-Version": "2022-11-28",
};

/** Row names as the catalog spells them (`vibe-catalog.ts` → copilot.metricLabels). */
const LABELS = {
  premiumCredits: "Credits",
  extraUsage: "Extra Usage",
  orgCredits: "Org Credits",
  orgSpend: "Org Spend",
  chat: "Chat",
  completions: "Completions",
} as const;

/** Copilot quotas run on the GitHub billing month; the payload never states the window. */
const WINDOW_SECONDS = PERIOD_MS.month / 1000;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * The `gh` CLI stores its token through go-keyring, which base64s the value
 * behind a literal marker. Anything without the marker was written by an older
 * version and is already the token.
 */
function unwrapGoKeyring(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(GO_KEYRING_PREFIX)) return trimmed === "" ? undefined : trimmed;
  const encoded = trimmed.slice(GO_KEYRING_PREFIX.length).trim();
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
    return decoded === "" ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/**
 * The editor writes one entry per host, and newer builds key it
 * `"github.com:<appId>"`. Matching the host prefix is what keeps a GitHub
 * Enterprise token (`"ghe.corp.example:…"`) from being sent to api.github.com,
 * where it would be a leaked secret rather than a failed request.
 */
function tokenFromEditorConfig(text: string): string | undefined {
  const parsed = asRecord(parseJsonWithHexFallback(text));
  if (parsed === undefined) return undefined;
  for (const [host, value] of Object.entries(parsed)) {
    if (host !== "github.com" && !host.startsWith("github.com:")) continue;
    const token = asString(asRecord(value)?.oauth_token);
    if (token !== undefined) return token;
  }
  return undefined;
}

/**
 * `hosts.yml` is a two-level YAML the CLI writes itself, so a full parser would
 * be more risk than reward — but the host block matters: an enterprise block
 * sitting above github.com must not hand over its token. A line with no leading
 * whitespace opens a new host; keys are read only while github.com is open.
 */
function yamlValue(text: string, key: string, host = "github.com"): string | undefined {
  let inHost = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const indented = /^\s/.test(line);
    if (!indented) {
      inHost = line.trim().startsWith(`${host}:`);
      continue;
    }
    if (!inHost) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}:`)) continue;
    const value = trimmed.slice(key.length + 1).trim().replace(/^["']|["']$/g, "").trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

async function readKeychain(
  context: VibeAdapterContext,
  service: string,
  account?: string,
): Promise<string | undefined> {
  try {
    return (await context.keychain.read(service, account)) ?? undefined;
  } catch {
    // A locked or denied keychain is indistinguishable from "nothing stored" at
    // this layer; the chain just continues to the next source.
    return undefined;
  }
}

/**
 * First non-empty source wins, files before Keychain — reading a file never
 * raises an authorisation prompt, and both sources hold the same token.
 * No environment override exists: `GITHUB_TOKEN` is usually a CI PAT, which
 * this endpoint rejects.
 */
async function loadToken(context: VibeAdapterContext): Promise<string | undefined> {
  for (const path of [EDITOR_APPS_PATH, EDITOR_HOSTS_PATH]) {
    const text = await context.readTextFile(path);
    if (text === null) continue;
    const token = tokenFromEditorConfig(text);
    if (token !== undefined) return token;
  }

  const hosts = await context.readTextFile(GH_HOSTS_PATH);
  const ghUser = hosts === null ? undefined : yamlValue(hosts, "user");
  if (hosts !== null) {
    const token = yamlValue(hosts, "oauth_token");
    if (token !== undefined) return token;
  }

  // go-keyring scopes the item by GitHub username; the account-less shape is
  // what older `gh` versions wrote.
  const raw = (ghUser === undefined ? undefined : await readKeychain(context, GH_KEYCHAIN_SERVICE, ghUser))
    ?? await readKeychain(context, GH_KEYCHAIN_SERVICE);
  return raw === undefined ? undefined : unwrapGoKeyring(raw);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function push(metrics: VibeMetric[], metric: VibeMetric | undefined): void {
  if (metric !== undefined) metrics.push(metric);
}

/**
 * Free tier stamps a bare `"2099-07-01"` while paid seats send a full ISO
 * instant; a date-only string is UTC midnight, which is how GitHub means it.
 */
function resetAtMs(body: JsonRecord): number | undefined {
  return timestampMs(body.quota_reset_date) ?? timestampMs(body.limited_user_reset_date);
}

/**
 * One quota bucket → one percent meter.
 *
 * Unlimited seats are described three different ways (`unlimited: true`, or a
 * `-1` sentinel in either field) and org-managed placeholders report a zero
 * entitlement; none of those is a number worth drawing, so the row is dropped
 * rather than shown as 0 % of nothing.
 */
function snapshotMetric(
  key: keyof typeof LABELS,
  bucket: unknown,
  resetsAtMs: number | undefined,
): VibeMetric | undefined {
  const record = asRecord(bucket);
  if (record === undefined) return undefined;
  const entitlement = asNumber(record.entitlement);
  const remaining = asNumber(record.remaining);
  if (asBoolean(record.unlimited) === true || entitlement === -1 || remaining === -1) return undefined;
  if (entitlement === 0) return undefined;

  // GitHub's own percentage wins: it is what the account page shows, and it is
  // computed against allowances the entitlement field does not always reflect.
  const percentRemaining = asNumber(record.percent_remaining);
  let usedPercent: number;
  if (percentRemaining !== undefined) {
    usedPercent = clampPercent(100 - percentRemaining);
  } else if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    usedPercent = clampPercent(100 - (remaining / entitlement) * 100);
  } else {
    return undefined;
  }

  return consumptionMetric({
    key,
    label: LABELS[key],
    unit: "percent",
    used: usedPercent,
    limit: 100,
    resetsAtMs,
    windowSeconds: WINDOW_SECONDS,
  });
}

/**
 * Overage is only meaningful next to a real credits meter and only when the
 * account may actually overspend — an org placeholder carries
 * `overage_permitted: true` with no quota at all, and printing "Extra Usage 0"
 * there told users they had a bill they do not have.
 */
function overageMetric(premium: unknown): VibeMetric | undefined {
  const record = asRecord(premium);
  if (record === undefined || asBoolean(record.overage_permitted) !== true) return undefined;
  return consumptionMetric({
    key: "extraUsage",
    label: LABELS.extraUsage,
    unit: "count",
    // A genuine zero IS shown here: "no overage yet" is information.
    used: Math.max(0, asNumber(record.overage_count) ?? 0),
    limit: undefined,
  });
}

/** The pre-`quota_snapshots` free-tier shape: absolute remaining against a monthly total. */
function limitedMetric(
  key: "chat" | "completions",
  remainingValue: unknown,
  totalValue: unknown,
  resetsAtMs: number | undefined,
): VibeMetric | undefined {
  const total = asNumber(totalValue);
  const remaining = asNumber(remainingValue);
  if (total === undefined || total <= 0 || remaining === undefined) return undefined;
  return consumptionMetric({
    key,
    label: LABELS[key],
    unit: "percent",
    used: clampPercent(((total - remaining) / total) * 100),
    limit: 100,
    resetsAtMs,
    windowSeconds: WINDOW_SECONDS,
  });
}

function planLabel(value: unknown): string | undefined {
  const text = asString(value);
  // "free_limited_copilot" → "Free Limited Copilot"; GitHub sends snake_case slugs.
  return text === undefined ? undefined : titleCase(text, true);
}

interface MappedUsage {
  plan?: string;
  metrics: VibeMetric[];
  isOrgManagedSeat: boolean;
}

function mapUsage(body: JsonRecord): MappedUsage {
  const plan = planLabel(body.copilot_plan);
  const resetsAtMs = resetAtMs(body);
  const snapshots = asRecord(body.quota_snapshots);
  const premium = snapshots?.premium_interactions;

  const metrics: VibeMetric[] = [];
  const credits = snapshotMetric("premiumCredits", premium, resetsAtMs);
  if (credits !== undefined) {
    metrics.push(credits);
    push(metrics, overageMetric(premium));
  }
  push(metrics, snapshotMetric("chat", snapshots?.chat, resetsAtMs));
  push(metrics, snapshotMetric("completions", snapshots?.completions, resetsAtMs));

  if (metrics.length === 0) {
    const limited = asRecord(body.limited_user_quotas);
    const monthly = asRecord(body.monthly_quotas);
    push(metrics, limitedMetric("chat", limited?.chat, monthly?.chat, resetsAtMs));
    push(metrics, limitedMetric("completions", limited?.completions, monthly?.completions, resetsAtMs));
  }

  if (metrics.length === 0) {
    // No meters plus token-based billing is the org-managed seat signature: the
    // quota really lives on the organisation, so this is a redirect, not a failure.
    if (asBoolean(body.token_based_billing) === true) {
      return { plan, metrics: [], isOrgManagedSeat: true };
    }
    throw new VibeRequestError(ID, "Copilot usage data is unavailable for this account.");
  }
  return { plan, metrics, isOrgManagedSeat: false };
}

/**
 * The billing summary lists every product the org bought; only Copilot's
 * AI-unit lines are credits. Seat fees (`unitType: "user-months"`) are a
 * subscription cost, not usage, and would double the number if counted.
 */
function mapOrgBilling(body: JsonRecord): VibeMetric[] | undefined {
  const items = asArray(body.usageItems);
  if (items === undefined) return undefined;
  const creditItems = items
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item !== undefined)
    .filter((item) => {
      const product = asString(item.product)?.toLowerCase();
      const unitType = asString(item.unitType)?.toLowerCase();
      return product === "copilot" && (unitType === "ai-units" || unitType === "ai-credits");
    });
  if (creditItems.length === 0) return undefined;

  let credits = 0;
  let spend = 0;
  for (const item of creditItems) {
    credits += Math.max(0, asNumber(item.grossQuantity) ?? 0);
    // netAmount is already DOLLARS here, unlike every cents-based vendor field.
    spend += Math.max(0, asNumber(item.netAmount) ?? 0);
  }

  const metrics: VibeMetric[] = [];
  push(metrics, consumptionMetric({
    key: "orgCredits",
    label: LABELS.orgCredits,
    unit: "credits",
    used: credits,
    limit: undefined,
  }));
  push(metrics, consumptionMetric({
    key: "orgSpend",
    label: LABELS.orgSpend,
    unit: "usd",
    used: spend,
    limit: undefined,
  }));
  return metrics;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function githubGet(
  context: VibeAdapterContext,
  url: string,
  token: string,
  headers: Record<string, string>,
) {
  return request(url, {
    // GitHub's OAuth app tokens authenticate with the `token` scheme; `Bearer`
    // is for the app-installation JWTs and 401s here.
    headers: { Authorization: `token ${token}`, ...headers },
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
    providerId: ID,
  });
}

/**
 * Org credit lines for one organisation, or undefined when this org definitively
 * has none (403/404 — not an admin, or no Copilot). A 429 or 5xx throws instead,
 * so a passing outage does not get mistaken for "wrong org" mid-discovery.
 */
async function orgLines(
  context: VibeAdapterContext,
  token: string,
  org: string,
): Promise<VibeMetric[] | undefined> {
  const response = await githubGet(context, ORG_BILLING_URL(org), token, REST_HEADERS);
  if (response.status === 429 || response.status >= 500) {
    throw new VibeRequestError(ID, `org billing HTTP ${response.status}`, response.status);
  }
  if (response.status !== 200) return undefined;
  const body = asRecord(parseBody(response));
  return body === undefined ? undefined : mapOrgBilling(body);
}

/**
 * Walks the user's orgs until one answers with Copilot credits.
 *
 * OpenUsage caches the winning org in UserDefaults; the adapter contract has no
 * store to cache in, so discovery repeats each refresh — a couple of extra GETs
 * against a first page of at most 100 orgs. Nothing here is allowed to fail the
 * provider: a personal seat mis-detected as org-managed just shows plan only.
 */
async function discoverOrgLines(context: VibeAdapterContext, token: string): Promise<VibeMetric[]> {
  let response;
  try {
    response = await githubGet(context, ORGS_URL, token, REST_HEADERS);
  } catch {
    return [];
  }
  // 403 is the common answer: editor-plugin tokens carry no `read:org`.
  if (response.status !== 200) return [];
  const orgs = asArray(parseBody(response)) ?? [];
  for (const entry of orgs) {
    const login = asString(asRecord(entry)?.login);
    if (login === undefined) continue;
    try {
      const lines = await orgLines(context, token, login);
      if (lines !== undefined && lines.length > 0) return lines;
    } catch {
      // One org's outage must not abort the walk.
      continue;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const copilotAdapter: VibeProviderAdapter = {
  id: ID,
  displayName: "Copilot",

  async detect(context: VibeAdapterContext): Promise<boolean> {
    return (await loadToken(context)) !== undefined;
  },

  async fetchUsage(context: VibeAdapterContext): Promise<VibeProviderResult> {
    const token = await loadToken(context);
    if (token === undefined) {
      throw new VibeCredentialsMissingError(
        ID,
        "sign in to Copilot in your editor, or run `gh auth login`",
      );
    }

    const response = await githubGet(context, USAGE_URL, token, USAGE_HEADERS);
    const body = asRecord(requireSuccess(response, ID, context.now()));
    if (body === undefined) throw new VibeRequestError(ID, "Copilot usage response invalid.");

    const mapped = mapUsage(body);
    if (!mapped.isOrgManagedSeat) {
      return { plan: mapped.plan, metrics: mapped.metrics };
    }

    const lines = await discoverOrgLines(context, token);
    return {
      plan: mapped.plan,
      metrics: lines,
      note: lines.length === 0 ? "组织统一管理的席位，这个账号读不到账单额度。" : undefined,
    };
  },
};
