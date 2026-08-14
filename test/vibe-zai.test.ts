import { describe, expect, test } from "bun:test";
import { zaiAdapter } from "../src/vibe/providers/zai.ts";
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

const NOW = Date.parse("2026-06-29T09:00:00Z");
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";

/** Verbatim from a live GLM Coding Pro account (anonymised), 2026-06-29. */
const QUOTA_BODY = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 17, nextResetTime: 1782724971179 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 3, nextResetTime: 1783305486997 },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 1000,
        currentValue: 0,
        remaining: 1000,
        percentage: 0,
        nextResetTime: 1785292686976,
        usageDetails: [
          { modelCode: "search-prime", usage: 0 },
          { modelCode: "web-reader", usage: 0 },
          { modelCode: "zread", usage: 0 },
        ],
      },
    ],
    level: "pro",
  },
  success: true,
};

const SUBSCRIPTION_BODY = {
  code: 200,
  msg: "Operation successful",
  data: [
    {
      productName: "GLM Coding Pro",
      status: "VALID",
      nextRenewTime: "2026-07-29",
      billingCycle: "monthly",
      inCurrentPeriod: true,
    },
  ],
  success: true,
};

interface Route {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  throws?: string;
}

function makeContext(routes: Record<string, Route>, apiKey: string | null = "zai-test") {
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

/** Quota-only context: the plan lookup answers with whatever the caller passes. */
function quotaContext(quota: Route, subscription: Route = { body: SUBSCRIPTION_BODY }) {
  return makeContext({ [QUOTA_URL]: quota, [SUBSCRIPTION_URL]: subscription });
}

function byKey(metrics: VibeMetric[]): Record<string, VibeMetric> {
  return Object.fromEntries(metrics.map((metric) => [metric.key, metric]));
}

describe("zai adapter", () => {
  test("detect only asks whether a key exists, without touching the network", async () => {
    const present = makeContext({});
    expect(await zaiAdapter.detect(present.context)).toBe(true);
    expect(present.calls).toEqual([]);
    expect(await zaiAdapter.detect(makeContext({}, "  ").context)).toBe(false);
    expect(await zaiAdapter.detect(makeContext({}, null).context)).toBe(false);
  });

  test("maps the live quota payload into session, weekly and web-search meters", async () => {
    const { context, calls } = quotaContext({ body: QUOTA_BODY });
    const result = await zaiAdapter.fetchUsage(context);
    const metrics = byKey(result.metrics);

    expect(result.metrics.map((metric) => metric.key)).toEqual(["session", "weekly", "webSearches"]);
    expect(calls.every((call) => call.authorization === "Bearer zai-test")).toBe(true);

    expect(metrics.session).toEqual({
      key: "session",
      label: "Session",
      kind: "consumption",
      unit: "percent",
      used: 17,
      limit: 100,
      remaining: 83,
      utilization: 0.17,
      // unit 3 (hours) × 5 = a five-hour window, carried from the payload.
      windowSeconds: 18_000,
      resetsAt: "2026-06-29T09:22:51.179Z",
    });

    expect(metrics.weekly).toEqual({
      key: "weekly",
      label: "Weekly",
      kind: "consumption",
      unit: "percent",
      used: 3,
      limit: 100,
      remaining: 97,
      utilization: 0.03,
      windowSeconds: 604_800,
      resetsAt: "2026-07-06T02:38:06.997Z",
    });

    expect(metrics.webSearches).toEqual({
      key: "webSearches",
      label: "Web Searches",
      kind: "consumption",
      unit: "searches",
      used: 0,
      limit: 1000,
      remaining: 1000,
      utilization: 0,
      windowSeconds: 2_592_000,
      resetsAt: "2026-07-29T02:38:06.976Z",
    });

    for (const metric of result.metrics) {
      expect(metric.label).toBe(vibeMetricLabel("zai", metric.key));
    }
    expect(result.plan).toBe("GLM Coding Pro");
    expect(result.note).toBeUndefined();
  });

  test("TIME_LIMIT's inverted fields: usage is the ceiling, currentValue the spend", async () => {
    const { context } = quotaContext({
      body: { data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 250 }] } },
    });
    const metrics = byKey((await zaiAdapter.fetchUsage(context)).metrics);
    expect(metrics.webSearches).toMatchObject({
      used: 250,
      limit: 1000,
      remaining: 750,
      utilization: 0.25,
      windowSeconds: 2_592_000,
    });
    expect(metrics.webSearches!.resetsAt).toBeUndefined();
  });

  test("the session/weekly split follows the payload's window, not the array order", async () => {
    const { context } = quotaContext({
      body: {
        data: {
          limits: [
            // 3 days: still "weekly" because anything from a day up is the long meter.
            { name: "TOKENS_LIMIT", unit: 4, number: 3, percentage: 40 },
            // 2 hours: sub-daily, so the session meter even though it comes second.
            { name: "TOKENS_LIMIT", unit: 3, number: 2, percentage: 10 },
          ],
        },
      },
    });
    const metrics = byKey((await zaiAdapter.fetchUsage(context)).metrics);
    expect(metrics.weekly).toMatchObject({ used: 40, windowSeconds: 259_200 });
    expect(metrics.session).toMatchObject({ used: 10, windowSeconds: 7_200 });
  });

  test("a percentage above range is clamped to a full meter", async () => {
    const { context } = quotaContext({
      body: { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 150 }] } },
    });
    const metrics = byKey((await zaiAdapter.fetchUsage(context)).metrics);
    expect(metrics.session).toMatchObject({ used: 100, remaining: 0, utilization: 1 });
  });

  test("a missing or boolean percentage is an invalid response, never a 0% meter", async () => {
    const missing = quotaContext({
      body: { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5 }] } },
    });
    await expect(zaiAdapter.fetchUsage(missing.context)).rejects.toBeInstanceOf(VibeRequestError);

    const boolean = quotaContext({
      body: { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: true }] } },
    });
    await expect(zaiAdapter.fetchUsage(boolean.context)).rejects.toBeInstanceOf(VibeRequestError);
  });

  test("a TOKENS_LIMIT without a window is invalid, but an unknown unit is just skipped", async () => {
    const windowless = quotaContext({
      body: { data: { limits: [{ type: "TOKENS_LIMIT", percentage: 5 }] } },
    });
    await expect(zaiAdapter.fetchUsage(windowless.context)).rejects.toBeInstanceOf(VibeRequestError);

    const futureUnit = quotaContext({
      body: { data: { limits: [{ type: "TOKENS_LIMIT", unit: 99, number: 1, percentage: 5 }] } },
    });
    const skipped = await zaiAdapter.fetchUsage(futureUnit.context);
    expect(skipped.metrics).toEqual([]);
    expect(skipped.note).toBe("这个套餐没有可读的用量指标。");
  });

  test("unrecognised entries never hide the meters we do understand", async () => {
    const { context } = quotaContext({
      body: {
        data: {
          limits: [
            { type: "FUTURE_LIMIT", unit: 9, number: 1 },
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 61 },
          ],
        },
      },
    });
    const result = await zaiAdapter.fetchUsage(context);
    expect(result.metrics.map((metric) => metric.key)).toEqual(["weekly"]);
  });

  test("an explicit empty limits array is a valid no-data state", async () => {
    const { context } = quotaContext({ body: { data: { limits: [] } } });
    const result = await zaiAdapter.fetchUsage(context);
    expect(result.metrics).toEqual([]);
    expect(result.note).toBe("这个套餐没有可读的用量指标。");
    expect(result.plan).toBe("GLM Coding Pro");
  });

  test("the root object may be the container when there is no data wrapper", async () => {
    const { context } = quotaContext({
      body: { limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 12 }] },
    });
    const metrics = byKey((await zaiAdapter.fetchUsage(context)).metrics);
    expect(metrics.weekly).toMatchObject({ used: 12, limit: 100 });
  });

  test.each([
    ["not JSON", { text: "not-json" }],
    ["a list where the container belongs", { body: { data: [] } }],
    ["a container without limits", { body: { data: {} } }],
    ["limits that are not a list", { body: { data: { limits: {} } } }],
    ["limits holding non-objects", { body: { data: { limits: [1, 2] } } }],
  ])("rejects %s as an invalid response", async (_name, route) => {
    const { context } = quotaContext(route as Route);
    await expect(zaiAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeRequestError);
  });

  test("an account without a coding plan is named as such, not shown as blank meters", async () => {
    const { context } = quotaContext({
      body: { code: 500, msg: "当前用户不存在coding plan", success: false },
    });
    const error = await zaiAdapter.fetchUsage(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect((error as Error).message).toContain("GLM Coding Plan");
  });

  test("an unrelated success:false body does not masquerade as a missing plan", async () => {
    const { context } = quotaContext({ body: { code: 500, msg: "internal error", success: false } });
    const error = await zaiAdapter.fetchUsage(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect((error as Error).message).toBe("usage response invalid");
  });

  test("no API key is a missing-credential state and never hits the network", async () => {
    const { context, calls } = makeContext({}, null);
    await expect(zaiAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
    expect(calls).toEqual([]);
  });

  test("a rejected key on the quota call is an expired credential", async () => {
    const { context } = quotaContext({ status: 401, body: { msg: "unauthorized" } });
    await expect(zaiAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("429 surfaces as a rate limit carrying the vendor's cooldown", async () => {
    const { context } = quotaContext({ status: 429, body: {}, headers: { "retry-after": "12" } });
    const error = await zaiAdapter.fetchUsage(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VibeRateLimitedError);
    expect((error as VibeRateLimitedError).retryAfterMs).toBe(12_000);
  });

  test("a 5xx on the quota call keeps its status", async () => {
    const { context } = quotaContext({ status: 503, body: {} });
    const error = await zaiAdapter.fetchUsage(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect((error as VibeRequestError).status).toBe(503);
  });

  test("a transport failure on the quota call is a request error", async () => {
    const { context } = quotaContext({ throws: "ETIMEDOUT" });
    await expect(zaiAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeRequestError);
  });

  test.each([
    ["a failing subscription endpoint", { status: 500, body: {} } as Route],
    ["a rejected subscription endpoint", { status: 401, body: {} } as Route],
    ["a subscription transport error", { throws: "ECONNRESET" } as Route],
    ["an empty subscription list", { body: { data: [] } } as Route],
    ["a subscription entry without a name", { body: { data: [{ productName: "" }] } } as Route],
    ["a non-list subscription payload", { body: { data: { productName: "GLM Coding Pro" } } } as Route],
  ])("survives %s with meters intact and no plan", async (_name, subscription) => {
    const { context } = quotaContext({ body: QUOTA_BODY }, subscription);
    const result = await zaiAdapter.fetchUsage(context);
    expect(result.metrics.map((metric) => metric.key)).toEqual(["session", "weekly", "webSearches"]);
    expect(result.plan).toBeUndefined();
  });

  test("the plan name is the vendor's own wording, verbatim", async () => {
    const { context } = quotaContext(
      { body: QUOTA_BODY },
      { body: { data: [{ productName: "GLM Coding Max" }, { productName: "GLM Coding Lite" }] } },
    );
    expect((await zaiAdapter.fetchUsage(context)).plan).toBe("GLM Coding Max");
  });

  test("numeric strings are accepted the way the vendor sends them", async () => {
    const { context } = quotaContext({
      body: { data: { limits: [{ type: "TOKENS_LIMIT", unit: "3", number: "5", percentage: "17.5" }] } },
    });
    const metrics = byKey((await zaiAdapter.fetchUsage(context)).metrics);
    expect(metrics.session).toMatchObject({ used: 17.5, windowSeconds: 18_000 });
  });

  test("a web-search entry missing either side of the count is invalid", async () => {
    const noUsed = quotaContext({ body: { data: { limits: [{ type: "TIME_LIMIT", usage: 1000 }] } } });
    await expect(zaiAdapter.fetchUsage(noUsed.context)).rejects.toBeInstanceOf(VibeRequestError);

    const noLimit = quotaContext({ body: { data: { limits: [{ type: "TIME_LIMIT", currentValue: 5 }] } } });
    await expect(zaiAdapter.fetchUsage(noLimit.context)).rejects.toBeInstanceOf(VibeRequestError);
  });
});
