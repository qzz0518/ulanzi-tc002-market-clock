import { describe, expect, test } from "bun:test";
import { cursorAdapter } from "../src/vibe/providers/cursor.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type VibeAdapterContext,
  type VibeMetric,
} from "../src/vibe/providers/types.ts";

const NOW = Date.parse("2026-08-14T09:00:00Z");
const CYCLE_START = Date.parse("2026-08-01T00:00:00Z");
const CYCLE_END = Date.parse("2026-09-01T00:00:00Z");
const CYCLE_SECONDS = (CYCLE_END - CYCLE_START) / 1000;

const STATE_DB = "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const PLAN_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const CREDITS_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance";
const REFRESH_URL = "https://api2.cursor.sh/oauth/token";
const REST_USAGE_URL = "https://cursor.com/api/usage";
const SUMMARY_URL = "https://cursor.com/api/usage-summary";
const STRIPE_URL = "https://cursor.com/api/auth/stripe";

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Shaped like the real thing: a base64url header/payload and an opaque signature. */
function jwt(payload: Record<string, unknown>): string {
  return [
    base64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    base64url(JSON.stringify(payload)),
    "c2lnbmF0dXJlLXBsYWNlaG9sZGVy",
  ].join(".");
}

const SUBJECT = "google-oauth2|user_abc123";
const FRESH_TOKEN = jwt({ sub: SUBJECT, exp: Math.floor(NOW / 1000) + 3600 });
const STALE_TOKEN = jwt({ sub: SUBJECT, exp: Math.floor(NOW / 1000) - 60 });
const ROTATED_TOKEN = jwt({ sub: SUBJECT, exp: Math.floor(NOW / 1000) + 7200 });
const REFRESH_TOKEN = jwt({ sub: SUBJECT, exp: Math.floor(NOW / 1000) + 86_400 });

/**
 * A `state.vscdb` page, byte for byte the way SQLite lays an ItemTable row out:
 * the key immediately followed by its value, wrapped in the binary noise the
 * scanner has to walk past.
 */
function stateDb(options: {
  access?: string;
  refresh?: string;
  membership?: string;
}): string {
  // Binary page noise, written as escapes so the source stays a text file.
  const noise = "\u0000\u0010\u0001";
  const parts = [`SQLite format 3${noise}`];
  // The UNIQUE index stores the key alone, followed by a rowid — the shape the
  // scanner must not mistake for a token.
  if (options.access !== undefined) parts.push(`cursorAuth/accessToken\u0003\u0001`);
  if (options.access !== undefined) parts.push(`cursorAuth/accessToken${options.access}`);
  if (options.refresh !== undefined) parts.push(`cursorAuth/refreshToken${options.refresh}`);
  if (options.membership !== undefined) {
    parts.push(`cursorAuth/stripeMembershipType${options.membership}\u0007`);
  }
  return parts.join(noise);
}

type Handler = (init?: RequestInit) => Response;

interface Harness {
  context: VibeAdapterContext;
  calls: { url: string; init?: RequestInit }[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function harness(options: {
  routes?: Record<string, Handler>;
  files?: Record<string, string>;
  keychain?: Record<string, string>;
}): Harness {
  const calls: { url: string; init?: RequestInit }[] = [];
  const routes = options.routes ?? {};
  const context: VibeAdapterContext = {
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((candidate) => url.startsWith(candidate));
      if (key === undefined) throw new Error(`unexpected fetch: ${url}`);
      return routes[key]!(init);
    },
    env: {},
    keychain: { read: async (service) => options.keychain?.[service] ?? null },
    readTextFile: async (path) => options.files?.[path] ?? null,
    writeTextFile: async () => {},
    listDirectory: async () => [],
    apiKey: () => null,
    timeoutMs: 5_000,
  };
  return { context, calls };
}

function byKey(metrics: VibeMetric[], key: string): VibeMetric | undefined {
  return metrics.find((metric) => metric.key === key);
}

// The individual-seat payload: money in cents, cycle bounds in epoch millis.
const INDIVIDUAL_USAGE = {
  planUsage: {
    limit: 4000,
    totalSpend: 1000,
    remaining: 3000,
    totalPercentUsed: 25,
    autoPercentUsed: 12.5,
    apiPercentUsed: 3,
  },
  spendLimitUsage: { limitType: "individual", individualLimit: 2000, individualUsed: 500 },
  billingCycleStart: CYCLE_START,
  billingCycleEnd: CYCLE_END,
};

function individualRoutes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [USAGE_URL]: () => json(INDIVIDUAL_USAGE),
    [PLAN_URL]: () => json({ planInfo: { planName: "pro plan" } }),
    [CREDITS_URL]: () => json({ hasCreditGrants: true, totalCents: 5000, usedCents: 1500 }),
    [STRIPE_URL]: () => json({ customerBalance: -2500 }),
    ...overrides,
  };
}

describe("cursor adapter", () => {
  test("maps an individual seat's plan meter, credits and on-demand spend", async () => {
    const { context, calls } = harness({
      routes: individualRoutes(),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN, refresh: REFRESH_TOKEN }) },
    });

    const result = await cursorAdapter.fetchUsage(context);

    expect(result.plan).toBe("Pro Plan");
    expect(result.metrics.map((metric) => metric.key)).toEqual([
      "totalUsage",
      "autoUsage",
      "apiUsage",
      "onDemand",
      "credits",
    ]);

    expect(byKey(result.metrics, "totalUsage")).toEqual({
      key: "totalUsage",
      label: "Total Usage",
      kind: "consumption",
      unit: "percent",
      used: 25,
      limit: 100,
      remaining: 75,
      utilization: 0.25,
      resetsAt: "2026-09-01T00:00:00.000Z",
      windowSeconds: CYCLE_SECONDS,
    });
    expect(byKey(result.metrics, "autoUsage")).toMatchObject({
      label: "Auto Usage",
      unit: "percent",
      used: 12.5,
      limit: 100,
      utilization: 0.125,
    });
    expect(byKey(result.metrics, "apiUsage")).toMatchObject({ label: "API Usage", used: 3, limit: 100 });
    // 500 of 2000 cents, and no reset: the extra-usage ceiling is not windowed.
    expect(byKey(result.metrics, "onDemand")).toEqual({
      key: "onDemand",
      label: "Extra Usage",
      kind: "consumption",
      unit: "usd",
      used: 5,
      limit: 20,
      remaining: 15,
      utilization: 0.25,
      resetsAt: undefined,
      windowSeconds: undefined,
    });
    // (5000 grant + 2500 stripe credit − 1500 spent) cents = $60 left.
    expect(byKey(result.metrics, "credits")).toEqual({
      key: "credits",
      label: "Credits",
      kind: "balance",
      unit: "usd",
      available: 60,
      resetsAt: undefined,
    });

    const usageCall = calls.find((call) => call.url === USAGE_URL);
    expect(usageCall?.init?.method).toBe("POST");
    expect(usageCall?.init?.body).toBe("{}");
    expect((usageCall?.init?.headers as Record<string, string>)["Connect-Protocol-Version"]).toBe("1");
    expect((usageCall?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FRESH_TOKEN}`);
    // cursor.com authenticates with the pre-encoded session cookie.
    const stripeCall = calls.find((call) => call.url === STRIPE_URL);
    expect((stripeCall?.init?.headers as Record<string, string>).Cookie)
      .toBe(`WorkosCursorSessionToken=user_abc123%3A%3A${FRESH_TOKEN}`);
  });

  test("prefers the Keychain copy when the editor DB holds a stale free-tier session", async () => {
    const otherSubject = jwt({ sub: "auth0|user_zzz", exp: Math.floor(NOW / 1000) + 3600 });
    const { context, calls } = harness({
      routes: individualRoutes(),
      files: { [STATE_DB]: stateDb({ access: otherSubject, membership: "free" }) },
      keychain: { "cursor-access-token": FRESH_TOKEN },
    });

    await cursorAdapter.fetchUsage(context);

    const usageCall = calls.find((call) => call.url === USAGE_URL);
    expect((usageCall?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FRESH_TOKEN}`);
  });

  test("falls back to the Keychain when there is no editor database", async () => {
    const { context } = harness({
      routes: individualRoutes(),
      keychain: { "cursor-access-token": FRESH_TOKEN },
    });

    expect(await cursorAdapter.detect(context)).toBe(true);
    expect((await cursorAdapter.fetchUsage(context)).metrics.length).toBeGreaterThan(0);
  });

  test("no credential anywhere is a state, not a failure", async () => {
    const { context } = harness({ routes: individualRoutes() });

    expect(await cursorAdapter.detect(context)).toBe(false);
    await expect(cursorAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
  });

  test("a 401 refreshes once and retries with the rotated token", async () => {
    let refreshes = 0;
    const seen: string[] = [];
    const { context } = harness({
      routes: individualRoutes({
        [USAGE_URL]: (init) => {
          const auth = (init?.headers as Record<string, string>).Authorization ?? "";
          seen.push(auth);
          return auth === `Bearer ${ROTATED_TOKEN}` ? json(INDIVIDUAL_USAGE) : json({}, 401);
        },
        [REFRESH_URL]: () => {
          refreshes += 1;
          return json({ access_token: ROTATED_TOKEN });
        },
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN, refresh: REFRESH_TOKEN }) },
    });

    const result = await cursorAdapter.fetchUsage(context);

    expect(refreshes).toBe(1);
    expect(seen).toEqual([`Bearer ${FRESH_TOKEN}`, `Bearer ${ROTATED_TOKEN}`]);
    expect(byKey(result.metrics, "totalUsage")?.used).toBe(25);
  });

  test("an expired JWT is refreshed before the first call", async () => {
    const seen: string[] = [];
    const { context } = harness({
      routes: individualRoutes({
        [USAGE_URL]: (init) => {
          seen.push((init?.headers as Record<string, string>).Authorization ?? "");
          return json(INDIVIDUAL_USAGE);
        },
        [REFRESH_URL]: () => json({ access_token: ROTATED_TOKEN }),
      }),
      files: { [STATE_DB]: stateDb({ access: STALE_TOKEN, refresh: REFRESH_TOKEN }) },
    });

    await cursorAdapter.fetchUsage(context);

    expect(seen).toEqual([`Bearer ${ROTATED_TOKEN}`]);
  });

  test("a refresh answering shouldLogout means re-login, not a retry", async () => {
    const { context } = harness({
      routes: individualRoutes({
        [USAGE_URL]: () => json({}, 401),
        [REFRESH_URL]: () => json({ shouldLogout: true }, 400),
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN, refresh: REFRESH_TOKEN }) },
    });

    await expect(cursorAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("a 401 with no refresh token available is a sign-in prompt", async () => {
    const { context } = harness({
      routes: individualRoutes({ [USAGE_URL]: () => json({}, 401) }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    await expect(cursorAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("429 carries the cooldown the server asked for", async () => {
    const { context } = harness({
      routes: individualRoutes({
        [USAGE_URL]: () => json({}, 429, { "retry-after": "30" }),
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    try {
      await cursorAdapter.fetchUsage(context);
      throw new Error("expected a rate-limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(VibeRateLimitedError);
      expect((error as VibeRateLimitedError).retryAfterMs).toBe(30_000);
    }
  });

  test("a 500 is a request error, not a credential problem", async () => {
    const { context } = harness({
      routes: individualRoutes({ [USAGE_URL]: () => json({}, 503) }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    try {
      await cursorAdapter.fetchUsage(context);
      throw new Error("expected a request error");
    } catch (error) {
      expect(error).toBeInstanceOf(VibeRequestError);
      expect((error as VibeRequestError).status).toBe(503);
    }
  });

  test("fields the server did not send are dropped, never zeroed", async () => {
    const { context } = harness({
      routes: individualRoutes({
        [USAGE_URL]: () => json({
          planUsage: { limit: 4000, totalPercentUsed: 25, autoPercentUsed: "n/a" },
          billingCycleEnd: CYCLE_END,
        }),
        // A grant object missing usedCents is discarded whole rather than halved.
        [CREDITS_URL]: () => json({ hasCreditGrants: true, totalCents: 5000 }),
        [STRIPE_URL]: () => json({ customerBalance: 1200 }),
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    const result = await cursorAdapter.fetchUsage(context);

    expect(result.metrics.map((metric) => metric.key)).toEqual(["totalUsage"]);
    expect(byKey(result.metrics, "autoUsage")).toBeUndefined();
    expect(byKey(result.metrics, "credits")).toBeUndefined();
    // Only the end bound arrived, so the window falls back to a 30-day month.
    expect(byKey(result.metrics, "totalUsage")).toMatchObject({
      resetsAt: "2026-09-01T00:00:00.000Z",
      windowSeconds: 2_592_000,
    });
  });

  test("a team seat meters dollars, inferring spend when totalSpend is a boolean", async () => {
    const { context } = harness({
      routes: individualRoutes({
        [USAGE_URL]: () => json({
          planUsage: { limit: 40_000, remaining: 32_000, totalSpend: true },
          spendLimitUsage: { limitType: "team", pooledLimit: 100_000, pooledUsed: 25_000 },
          billingCycleStart: CYCLE_START,
          billingCycleEnd: CYCLE_END,
        }),
        [PLAN_URL]: () => json({ planInfo: { planName: "team" } }),
        [CREDITS_URL]: () => json({ hasCreditGrants: false }),
        [STRIPE_URL]: () => json({ customerBalance: 0 }),
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    const result = await cursorAdapter.fetchUsage(context);

    expect(result.plan).toBe("Team");
    expect(byKey(result.metrics, "totalUsage")).toMatchObject({
      unit: "usd",
      used: 80,
      limit: 400,
      utilization: 0.2,
    });
    expect(byKey(result.metrics, "onDemand")).toMatchObject({ unit: "usd", used: 250, limit: 1000 });
  });

  test("an enterprise seat falls back to the website's request meter", async () => {
    const { context, calls } = harness({
      routes: individualRoutes({
        [USAGE_URL]: () => json({ planUsage: {} }),
        [PLAN_URL]: () => json({ planInfo: { planName: "Enterprise" } }),
        [SUMMARY_URL]: () => json({
          billingCycleStart: "2026-08-01T00:00:00Z",
          billingCycleEnd: "2026-09-01T00:00:00Z",
          membershipType: "enterprise",
          individualUsage: {
            plan: { autoPercentUsed: 40 },
            onDemand: { limit: 10_000, used: 2_500 },
          },
        }),
        [REST_USAGE_URL]: () => json({
          "gpt-4": { maxRequestUsage: 500, numRequests: 125 },
          startOfMonth: "2026-08-01T00:00:00Z",
        }),
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    const result = await cursorAdapter.fetchUsage(context);

    expect(result.plan).toBe("Enterprise");
    // The request pool answers both the headline and the Requests row.
    expect(byKey(result.metrics, "totalUsage")).toMatchObject({
      label: "Total Usage",
      unit: "requests",
      used: 125,
      limit: 500,
      utilization: 0.25,
      resetsAt: "2026-09-01T00:00:00.000Z",
      windowSeconds: CYCLE_SECONDS,
    });
    expect(byKey(result.metrics, "requests")).toMatchObject({
      label: "Requests",
      unit: "requests",
      used: 125,
      limit: 500,
    });
    expect(byKey(result.metrics, "autoUsage")).toMatchObject({ used: 40, limit: 100 });
    expect(byKey(result.metrics, "onDemand")).toMatchObject({ unit: "usd", used: 25, limit: 100 });
    expect(calls.some((call) => call.url === `${REST_USAGE_URL}?user=user_abc123`)).toBe(true);
  });

  test("a summary with only a team dollar meter still reports total usage", async () => {
    const { context } = harness({
      routes: individualRoutes({
        [USAGE_URL]: () => json({ planUsage: {}, spendLimitUsage: { limitType: "team" } }),
        [PLAN_URL]: () => json({}),
        [SUMMARY_URL]: () => json({
          limitType: "team",
          teamUsage: { pooled: { limit: 50_000, remaining: 20_000 } },
        }),
        [REST_USAGE_URL]: () => json({}),
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    const result = await cursorAdapter.fetchUsage(context);

    // used is inferred from limit − remaining because the bucket reports neither.
    expect(byKey(result.metrics, "totalUsage")).toMatchObject({ unit: "usd", used: 300, limit: 500 });
  });

  test("a legacy plan payload with no limit uses the generic request fallback", async () => {
    const { context } = harness({
      routes: individualRoutes({
        [USAGE_URL]: () => json({ planUsage: {} }),
        [PLAN_URL]: () => json({ planInfo: { planName: "pro" } }),
        [REST_USAGE_URL]: () => json({
          "gpt-4": { maxRequestUsage: 500, numRequests: 42 },
          startOfMonth: "2026-08-01T00:00:00Z",
        }),
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    const result = await cursorAdapter.fetchUsage(context);

    expect(result.plan).toBe("Pro");
    expect(result.metrics.map((metric) => metric.key)).toEqual(["requests"]);
    expect(byKey(result.metrics, "requests")).toMatchObject({
      used: 42,
      limit: 500,
      utilization: 0.084,
      // startOfMonth + 30 days, the only reset a request pool advertises.
      resetsAt: "2026-08-31T00:00:00.000Z",
      windowSeconds: 2_592_000,
    });
  });

  test("an account with no plan meter at all reports the vendor's own reason", async () => {
    const { context } = harness({
      routes: individualRoutes({
        [USAGE_URL]: () => json({ enabled: false }),
        [PLAN_URL]: () => json({ planInfo: { planName: "pro" } }),
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    await expect(cursorAdapter.fetchUsage(context)).rejects.toThrow("No active Cursor subscription.");
  });

  test("optional endpoints failing costs a row, not the provider", async () => {
    const { context } = harness({
      routes: individualRoutes({
        [PLAN_URL]: () => json({}, 500),
        [CREDITS_URL]: () => {
          throw new Error("socket hang up");
        },
        [STRIPE_URL]: () => json("not json" as unknown, 200),
      }),
      files: { [STATE_DB]: stateDb({ access: FRESH_TOKEN }) },
    });

    const result = await cursorAdapter.fetchUsage(context);

    expect(result.plan).toBeUndefined();
    expect(result.metrics.map((metric) => metric.key)).toEqual([
      "totalUsage",
      "autoUsage",
      "apiUsage",
      "onDemand",
    ]);
  });
});
