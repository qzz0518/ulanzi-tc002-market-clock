import { describe, expect, test } from "bun:test";
import { openrouterAdapter } from "../src/vibe/providers/openrouter.ts";
import { EmptyKeychain } from "../src/vibe/providers/keychain.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type VibeAdapterContext,
  type VibeMetric,
} from "../src/vibe/providers/types.ts";
import { vibeMetricLabel } from "../src/vibe/vibe-catalog.ts";

const NOW = Date.parse("2026-08-14T09:00:00Z");
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const KEY_URL = "https://openrouter.ai/api/v1/key";

interface Route {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  throws?: string;
}

function makeContext(routes: Record<string, Route>, apiKey: string | null = "sk-or-test") {
  const calls: { url: string; authorization?: string }[] = [];
  const context: VibeAdapterContext = {
    now: () => NOW,
    fetch: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, authorization: headers.authorization });
      const route = routes[url];
      if (route === undefined) throw new Error(`unexpected fetch: ${url}`);
      if (route.throws !== undefined) throw new Error(route.throws);
      const text = route.text ?? JSON.stringify(route.body ?? {});
      return new Response(text, { status: route.status ?? 200, headers: route.headers });
    },
    env: {},
    keychain: new EmptyKeychain(),
    readTextFile: async () => null,
    writeTextFile: async () => {},
    listDirectory: async () => [],
    apiKey: () => apiKey,
    timeoutMs: 5_000,
  };
  return { context, calls };
}

function byKey(metrics: VibeMetric[]): Record<string, VibeMetric> {
  return Object.fromEntries(metrics.map((metric) => [metric.key, metric]));
}

describe("openrouter adapter", () => {
  test("detect only asks whether a key exists, without touching the network", async () => {
    const withKey = makeContext({});
    expect(await openrouterAdapter.detect(withKey.context)).toBe(true);
    expect(withKey.calls).toEqual([]);

    const blank = makeContext({}, "   ");
    expect(await openrouterAdapter.detect(blank.context)).toBe(false);
    expect(await openrouterAdapter.detect(makeContext({}, null).context)).toBe(false);
  });

  test("maps /credits and /key into catalog metrics, spend lines and a plan", async () => {
    const { context, calls } = makeContext({
      [CREDITS_URL]: { body: { data: { total_credits: 277.47, total_usage: 178.2 } } },
      [KEY_URL]: {
        body: {
          data: {
            usage_daily: 5.17,
            usage_weekly: 18.4,
            usage_monthly: 62.5,
            limit: 50,
            usage: 12.5,
            is_free_tier: false,
          },
        },
      },
    });

    const result = await openrouterAdapter.fetchUsage(context);
    const metrics = byKey(result.metrics);

    expect(Object.keys(metrics).sort()).toEqual(["balance", "credits", "keyLimit"]);
    expect(calls.every((call) => call.authorization === "Bearer sk-or-test")).toBe(true);

    expect(metrics.credits).toMatchObject({
      key: "credits",
      label: "Credits",
      kind: "consumption",
      unit: "usd",
      used: 178.2,
      limit: 277.47,
    });
    expect(metrics.credits!.remaining).toBeCloseTo(99.27, 6);
    expect(metrics.credits!.utilization).toBeCloseTo(178.2 / 277.47, 12);
    expect(metrics.credits!.resetsAt).toBeUndefined();

    expect(metrics.balance).toMatchObject({
      key: "balance",
      label: "Balance",
      kind: "balance",
      unit: "usd",
    });
    expect(metrics.balance!.available).toBeCloseTo(99.27, 6);

    expect(metrics.keyLimit).toMatchObject({
      key: "keyLimit",
      label: "Key Limit",
      kind: "consumption",
      unit: "usd",
      used: 12.5,
      limit: 50,
      remaining: 37.5,
      utilization: 0.25,
    });

    // The console and the LED renderer key off the catalog's labels.
    for (const metric of result.metrics) {
      expect(metric.label).toBe(vibeMetricLabel("openrouter", metric.key));
    }

    expect(result.spendLines).toEqual([
      { label: "Today", value: "$5.17" },
      { label: "This Week", value: "$18.40" },
      { label: "This Month", value: "$62.50" },
    ]);
    expect(result.plan).toBe("Pay as you go");
  });

  test("is_free_tier true is the free plan, and a non-boolean leaves the plan unset", async () => {
    const free = makeContext({
      [CREDITS_URL]: { body: { data: { total_credits: 10, total_usage: 1 } } },
      [KEY_URL]: { body: { data: { is_free_tier: true } } },
    });
    expect((await openrouterAdapter.fetchUsage(free.context)).plan).toBe("Free tier");

    const stringy = makeContext({
      [CREDITS_URL]: { body: { data: { total_credits: 10, total_usage: 1 } } },
      [KEY_URL]: { body: { data: { is_free_tier: "true" } } },
    });
    expect((await openrouterAdapter.fetchUsage(stringy.context)).plan).toBeUndefined();

    const absent = makeContext({
      [CREDITS_URL]: { body: { data: { total_credits: 10, total_usage: 1 } } },
      [KEY_URL]: { body: { data: {} } },
    });
    expect((await openrouterAdapter.fetchUsage(absent.context)).plan).toBeUndefined();
  });

  test("numeric strings are accepted the way the vendor sends them", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { body: { data: { total_credits: "277.47", total_usage: "178.20" } } },
      [KEY_URL]: { body: { data: {} } },
    });
    const metrics = byKey((await openrouterAdapter.fetchUsage(context)).metrics);
    expect(metrics.credits!.used).toBe(178.2);
    expect(metrics.credits!.limit).toBe(277.47);
  });

  test("a missing total_usage drops both credit rows rather than reporting zero spend", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { body: { data: { total_credits: 277.47 } } },
      [KEY_URL]: { body: { data: { limit: 50, usage: 12.5 } } },
    });
    const result = await openrouterAdapter.fetchUsage(context);
    expect(result.metrics.map((metric) => metric.key)).toEqual(["keyLimit"]);
  });

  test("a missing total_credits drops the meter but still reports a real zero balance", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { body: { data: { total_usage: 12 } } },
      [KEY_URL]: { body: { data: {} } },
    });
    const metrics = byKey((await openrouterAdapter.fetchUsage(context)).metrics);
    expect(metrics.credits).toBeUndefined();
    expect(metrics.balance!.available).toBe(0);
  });

  test("a null or zero key cap emits no Key Limit meter", async () => {
    const nulled = makeContext({
      [CREDITS_URL]: { body: { data: { total_usage: 1, total_credits: 10 } } },
      [KEY_URL]: { body: { data: { limit: null, usage: 4 } } },
    });
    expect(byKey((await openrouterAdapter.fetchUsage(nulled.context)).metrics).keyLimit).toBeUndefined();

    const zeroed = makeContext({
      [CREDITS_URL]: { body: { data: { total_usage: 1, total_credits: 10 } } },
      [KEY_URL]: { body: { data: { limit: 0, usage: 4 } } },
    });
    expect(byKey((await openrouterAdapter.fetchUsage(zeroed.context)).metrics).keyLimit).toBeUndefined();
  });

  test("a cap without a usage figure starts at a measured zero", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { body: { data: {} } },
      [KEY_URL]: { body: { data: { limit: 40 } } },
    });
    const metrics = byKey((await openrouterAdapter.fetchUsage(context)).metrics);
    expect(metrics.keyLimit).toMatchObject({ used: 0, limit: 40, remaining: 40, utilization: 0 });
  });

  test("spend rows drop absent or non-numeric fields and keep a measured zero", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { body: { data: { total_usage: 1, total_credits: 10 } } },
      [KEY_URL]: { body: { data: { usage_daily: 0, usage_weekly: true, usage_monthly: null } } },
    });
    const result = await openrouterAdapter.fetchUsage(context);
    expect(result.spendLines).toEqual([{ label: "Today", value: "$0.00" }]);
  });

  test("no API key is a missing-credential state and never hits the network", async () => {
    const { context, calls } = makeContext({}, null);
    await expect(openrouterAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
    expect(calls).toEqual([]);
  });

  test("both endpoints rejecting the key is an expired credential", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { status: 401, body: { error: "invalid" } },
      [KEY_URL]: { status: 403, body: { error: "invalid" } },
    });
    await expect(openrouterAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("a key gated out of /credits alone still renders /key's rows", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { status: 403, body: { error: "forbidden" } },
      [KEY_URL]: { body: { data: { limit: 20, usage: 5, is_free_tier: false } } },
    });
    const result = await openrouterAdapter.fetchUsage(context);
    expect(result.metrics.map((metric) => metric.key)).toEqual(["keyLimit"]);
    expect(result.plan).toBe("Pay as you go");
  });

  test("429 surfaces as a rate limit carrying the vendor's cooldown", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { status: 429, body: {}, headers: { "retry-after": "30" } },
      [KEY_URL]: { status: 429, body: {} },
    });
    const error = await openrouterAdapter.fetchUsage(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VibeRateLimitedError);
    expect((error as VibeRateLimitedError).retryAfterMs).toBe(30_000);
  });

  test("an auth failure on one side yields the other side's real error", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { status: 401, body: {} },
      [KEY_URL]: { status: 500, body: {} },
    });
    const error = await openrouterAdapter.fetchUsage(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect((error as VibeRequestError).status).toBe(500);
  });

  test("two usable responses carrying nothing mappable fail rather than render blanks", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { body: { data: {} } },
      [KEY_URL]: { body: { data: {} } },
    });
    await expect(openrouterAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeRequestError);
  });

  test("a non-JSON body is a request error, not an empty panel", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { text: "<html>gateway</html>" },
      [KEY_URL]: { text: "" },
    });
    await expect(openrouterAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeRequestError);
  });

  test("a transport failure on both endpoints is reported as a request error", async () => {
    const { context } = makeContext({
      [CREDITS_URL]: { throws: "ECONNREFUSED" },
      [KEY_URL]: { throws: "ECONNREFUSED" },
    });
    await expect(openrouterAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeRequestError);
  });
});
