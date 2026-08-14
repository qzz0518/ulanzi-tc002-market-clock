/**
 * OpenCode (Go subscription) usage.
 *
 * The credential is one JSON path — `$["opencode-go"].key` in OpenCode's own
 * auth.json — used verbatim as a bearer token. There is no OAuth, no refresh and
 * no Keychain here, so a rejected key is terminal until the user logs in again.
 *
 * The auth file follows OpenCode's data-directory rules, which is why the path
 * is derived from the environment rather than hardcoded: users who set
 * XDG_DATA_HOME (or the app's own override) have it nowhere near ~/.local.
 */

import { vibeMetricLabel } from "../vibe-catalog.ts";
import { parseBody, request, requireSuccess } from "./http.ts";
import {
  PERIOD_MS,
  asNumber,
  asRecord,
  asString,
  consumptionMetric,
  parseJsonWithHexFallback,
  pick,
  timestampMs,
} from "./parse.ts";
import {
  VibeCredentialsMissingError,
  VibeRequestError,
  type VibeAdapterContext,
  type VibeMetric,
  type VibeProviderAdapter,
  type VibeProviderResult,
} from "./types.ts";

const PROVIDER_ID = "opencode";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_DATA_DIR = "~/.local/share/opencode";
/** The plan is literal: meters come back only for a Go subscription. */
const GO_PLAN = "Go";

/**
 * The three meters the endpoint reports. `rolling` is a 5-hour session window;
 * the durations are fixed by the plan, not carried in the response, so they are
 * constants here rather than derived arithmetic.
 */
const WINDOWS = [
  { key: "session", field: "rolling", windowSeconds: PERIOD_MS.session / 1000 },
  { key: "weekly", field: "weekly", windowSeconds: PERIOD_MS.week / 1000 },
  { key: "monthly", field: "monthly", windowSeconds: PERIOD_MS.month / 1000 },
] as const;

function trimTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

/** Mirrors OpenCode's own resolution order; `readTextFile` expands the `~`. */
function dataDirectory(context: VibeAdapterContext): string {
  const override = asString(context.env.OPENCODE_DATA_DIR);
  if (override !== undefined) return trimTrailingSlashes(override);
  const xdg = asString(context.env.XDG_DATA_HOME);
  if (xdg !== undefined) return `${trimTrailingSlashes(xdg)}/opencode`;
  return DEFAULT_DATA_DIR;
}

function authFilePath(context: VibeAdapterContext): string {
  return `${dataDirectory(context)}/auth.json`;
}

/**
 * Returns the Go key, or undefined when the user simply is not signed in.
 *
 * A present-but-broken auth.json is a different state and throws: telling the
 * user "not signed in" when the file is there but unreadable sends them to the
 * wrong fix.
 */
async function readGoKey(context: VibeAdapterContext): Promise<string | undefined> {
  const path = authFilePath(context);
  let text: string | null;
  try {
    text = await context.readTextFile(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VibeRequestError(PROVIDER_ID, `could not read OpenCode's auth.json: ${reason}`);
  }
  if (text === null) return undefined;

  const auth = asRecord(parseJsonWithHexFallback(text));
  if (auth === undefined) {
    throw new VibeRequestError(PROVIDER_ID, "OpenCode's auth.json is not valid JSON");
  }
  // Only this one entry is read: siblings belong to other providers and may hold
  // any shape at all (arrays, OAuth blobs), which must not break the lookup.
  return asString(pick(auth, "opencode-go", "key"));
}

/** `{"error":{"type":"EntitlementError"}}` — absent for HTML or edge error bodies. */
function errorType(body: unknown): string | undefined {
  return asString(pick(body, "error", "type"));
}

export const opencodeAdapter: VibeProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "OpenCode",

  async detect(context: VibeAdapterContext): Promise<boolean> {
    try {
      return (await readGoKey(context)) !== undefined;
    } catch {
      // A broken auth.json is still an OpenCode footprint; staying detected is
      // what lets fetchUsage surface the real "fix your auth.json" message.
      return true;
    }
  },

  async fetchUsage(context: VibeAdapterContext): Promise<VibeProviderResult> {
    const key = await readGoKey(context);
    if (key === undefined) {
      throw new VibeCredentialsMissingError(PROVIDER_ID, "no OpenCode Go key; log in with OpenCode Go");
    }

    const response = await request(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      timeoutMs: context.timeoutMs,
      fetch: context.fetch,
      providerId: PROVIDER_ID,
    });
    // A 403 carrying the documented entitlement error means the key is valid but
    // has no Go plan — a different fix from "sign in again", so it must not fall
    // into requireSuccess's credentials-expired bucket.
    if (response.status === 403 && errorType(parseBody(response)) === "EntitlementError") {
      throw new VibeRequestError(PROVIDER_ID, "no active OpenCode Go subscription on this key", 403);
    }
    const body = requireSuccess(response, PROVIDER_ID, context.now());

    const usage = asRecord(pick(body, "usage"));
    if (usage === undefined) throw new VibeRequestError(PROVIDER_ID, "opencode usage response changed");

    const metrics: VibeMetric[] = [];
    for (const window of WINDOWS) {
      const raw = asRecord(usage[window.field]);
      const metric = raw === undefined ? undefined : consumptionMetric({
        key: window.key,
        label: vibeMetricLabel(PROVIDER_ID, window.key),
        unit: "percent",
        // `percent` is the whole meter; consumptionMetric drops the row when it
        // is missing or non-numeric, which is what makes the guard below true.
        used: asNumber(raw.percent),
        limit: 100,
        resetsAtMs: timestampMs(raw.resetsAt),
        windowSeconds: window.windowSeconds,
      });
      if (metric === undefined) {
        // All three windows always ship together; one missing means the payload
        // changed shape, and a partial answer would read as "quota freed up".
        throw new VibeRequestError(PROVIDER_ID, `opencode usage is missing the ${window.field} window`);
      }
      metrics.push(metric);
    }

    return { plan: GO_PLAN, metrics };
  },
};
