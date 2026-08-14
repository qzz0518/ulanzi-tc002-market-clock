import { describe, expect, test } from "bun:test";
import { grokAdapter } from "../src/vibe/providers/grok.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type VibeAdapterContext,
} from "../src/vibe/providers/types.ts";

const AUTH_PATH = "~/.grok/auth.json";
const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const REFRESH_URL = "https://auth.x.ai/oauth2/token";

const NOW = Date.parse("2026-07-06T12:00:00.000Z");

/** Captured live 2026-07-06 (spec §1.3) — proto3-JSON, so zeros are present here. */
const CREDITS_BODY = {
  config: {
    creditUsagePercent: 99.0,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-06-30T21:36:52.140114+00:00",
      end: "2026-07-07T21:36:52.140114+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-06-30T21:36:52.140114+00:00",
    billingPeriodEnd: "2026-07-07T21:36:52.140114+00:00",
  },
};

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A token whose `exp` claim (seconds) drives needsRefresh/isExpired. */
function jwt(expSeconds?: number): string {
  const payload = expSeconds === undefined ? { sub: "user" } : { sub: "user", exp: expSeconds };
  return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(payload)}.signature`;
}

const LIVE_TOKEN = jwt((NOW + 86_400_000) / 1000);

function authFile(entries: Record<string, unknown>): string {
  return JSON.stringify(entries);
}

interface Handled {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function respond(handled: Handled): Response {
  const body = handled.text ?? (handled.body === undefined ? "" : JSON.stringify(handled.body));
  return new Response(body, { status: handled.status ?? 200, headers: handled.headers });
}

function makeContext(options: {
  files?: Record<string, string>;
  unreadable?: string[];
  env?: Record<string, string | undefined>;
  now?: number;
  route?: (url: string, call: number, init: RequestInit | undefined) => Handled;
}): { context: VibeAdapterContext; calls: Call[]; fileWrites: { path: string; content: string }[] } {
  const calls: Call[] = [];
  const fileWrites: { path: string; content: string }[] = [];
  const perUrl = new Map<string, number>();
  const context: VibeAdapterContext = {
    now: () => options.now ?? NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const index = perUrl.get(url) ?? 0;
      perUrl.set(url, index + 1);
      if (!options.route) throw new Error(`unexpected fetch ${url}`);
      return respond(options.route(url, index, init));
    },
    env: options.env ?? {},
    keychain: { async read() { return null; } },
    async writeTextFile(path, content) { fileWrites.push({ path, content }); },
    async readTextFile(path) {
      if (options.unreadable?.includes(path)) throw new Error("EACCES");
      return options.files?.[path] ?? null;
    },
    async listDirectory() { return []; },
    apiKey: () => null,
    timeoutMs: 5_000,
  };
  return { context, calls, fileWrites };
}

function header(init: RequestInit | undefined, name: string): unknown {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe("grok adapter", () => {
  test("maps the weekly billing period to the catalog's weekly metric", async () => {
    const { context, calls } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN, refresh_token: "r" } }) },
      route: (url) => {
        if (url === CREDITS_URL) return { body: CREDITS_BODY };
        if (url === SETTINGS_URL) return { body: { subscription_tier_display: "SuperGrok Heavy" } };
        throw new Error(`unexpected ${url}`);
      },
    });

    const result = await grokAdapter.fetchUsage(context);

    expect(result.plan).toBe("SuperGrok Heavy");
    expect(result.metrics).toEqual([{
      key: "weekly",
      label: "Weekly",
      kind: "consumption",
      unit: "percent",
      used: 99,
      limit: 100,
      remaining: 1,
      utilization: 0.99,
      resetsAt: "2026-07-07T21:36:52.140Z",
      windowSeconds: 604_800,
    }]);
    expect(result.spendLines).toEqual([{ label: "Pay as you go", value: "Disabled" }]);
    expect(result.note).toBeUndefined();

    expect(calls.map((call) => call.url)).toEqual([CREDITS_URL, SETTINGS_URL]);
    expect(header(calls[0]!.init, "Authorization")).toBe(`Bearer ${LIVE_TOKEN}`);
    expect(header(calls[0]!.init, "X-XAI-Token-Auth")).toBe("xai-grok-cli");
    expect(header(calls[0]!.init, "Accept")).toBe("application/json");
  });

  test("an on-demand cap becomes the pay-as-you-go line", async () => {
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
      route: (url) => url === CREDITS_URL
        ? { body: { config: { ...CREDITS_BODY.config, onDemandCap: { val: 2500 } } } }
        : { status: 500 },
    });

    const result = await grokAdapter.fetchUsage(context);
    expect(result.spendLines).toEqual([{ label: "Pay as you go", value: "2500 cap" }]);
    // Settings failed, so the plan is simply absent rather than guessed.
    expect(result.plan).toBeUndefined();
  });

  test("a non-weekly period yields no meter and no error", async () => {
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
      route: (url) => url === CREDITS_URL
        ? {
          body: {
            config: {
              creditUsagePercent: 12,
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_MONTHLY",
                start: "2026-06-30T21:36:52.140114+00:00",
                end: "2026-07-30T21:36:52.140114+00:00",
              },
            },
          },
        }
        : { body: {} },
    });

    const result = await grokAdapter.fetchUsage(context);
    expect(result.metrics).toEqual([]);
    expect(result.note).toContain("USAGE_PERIOD_TYPE_MONTHLY");
  });

  test("an omitted creditUsagePercent is a real zero, not a dropped metric", async () => {
    // proto3-JSON drops zero-valued fields, so absent means 0 here.
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
      route: (url) => url === CREDITS_URL
        ? {
          body: {
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                start: "2026-06-30T21:36:52.140114+00:00",
                end: "2026-07-07T21:36:52.140114+00:00",
              },
            },
          },
        }
        : { body: {} },
    });

    const result = await grokAdapter.fetchUsage(context);
    expect(result.metrics[0]).toMatchObject({ key: "weekly", used: 0, utilization: 0, remaining: 100 });
  });

  test("percentages above 100 clamp instead of overflowing the meter", async () => {
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
      route: (url) => url === CREDITS_URL
        ? { body: { config: { ...CREDITS_BODY.config, creditUsagePercent: 143.2 } } }
        : { body: {} },
    });

    const result = await grokAdapter.fetchUsage(context);
    expect(result.metrics[0]).toMatchObject({ used: 100, remaining: 0, utilization: 1 });
  });

  test.each([
    ["no config", { billing: {} }],
    ["no currentPeriod", { config: { creditUsagePercent: 5 } }],
    ["no period type", { config: { currentPeriod: { start: "2026-06-30T00:00:00Z", end: "2026-07-07T00:00:00Z" } } }],
    ["unparseable period end", {
      config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-06-30T00:00:00Z", end: "soon" } },
    }],
    ["end before start", {
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-07T00:00:00Z",
          end: "2026-06-30T00:00:00Z",
        },
      },
    }],
    ["percent is not a number", {
      config: {
        creditUsagePercent: "n/a%",
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-06-30T00:00:00Z", end: "2026-07-07T00:00:00Z" },
      },
    }],
    ["cap is not an object", {
      config: {
        onDemandCap: 5,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-06-30T00:00:00Z", end: "2026-07-07T00:00:00Z" },
      },
    }],
  ])("rejects a billing response that changed shape: %s", async (_name, body) => {
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
      route: () => ({ body }),
    });
    await expect(grokAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeRequestError);
  });

  test("a plan that is missing or not a string leaves the plan unset", async () => {
    for (const settings of [{}, { subscription_tier_display: 42 }, { subscription_tier_display: "   " }]) {
      const { context } = makeContext({
        files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
        route: (url) => url === CREDITS_URL ? { body: CREDITS_BODY } : { body: settings },
      });
      const result = await grokAdapter.fetchUsage(context);
      expect(result.plan).toBeUndefined();
    }
  });

  test("the plan string is taken verbatim, with no title-casing", async () => {
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
      route: (url) => url === CREDITS_URL
        ? { body: CREDITS_BODY }
        : { body: { subscription_tier_display: "  SuperGrok Heavy  " } },
    });
    expect((await grokAdapter.fetchUsage(context)).plan).toBe("SuperGrok Heavy");
  });

  test("no auth file at all is a missing credential", async () => {
    const { context } = makeContext({ route: () => ({ body: {} }) });
    await expect(grokAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
    expect(await grokAdapter.detect(context)).toBe(false);
  });

  test("an auth file with no usable token is a missing credential", async () => {
    for (const contents of ["{ not json", "[]", authFile({ "a::b": { refresh_token: "r" } }), authFile({ "a::b": { key: "  " } })]) {
      const { context } = makeContext({ files: { [AUTH_PATH]: contents }, route: () => ({ body: {} }) });
      await expect(grokAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
      expect(await grokAdapter.detect(context)).toBe(false);
    }
  });

  test("an unreadable auth file is reported as missing, not as a crash", async () => {
    const { context } = makeContext({ unreadable: [AUTH_PATH], route: () => ({ body: {} }) });
    await expect(grokAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
    expect(await grokAdapter.detect(context)).toBe(false);
  });

  test("detect finds a signed-in CLI without touching the network", async () => {
    const { context, calls } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
    });
    expect(await grokAdapter.detect(context)).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a 401 refreshes once and retries with the new token", async () => {
    const { context, calls } = makeContext({
      files: {
        [AUTH_PATH]: authFile({
          "https://auth.x.ai::client": { key: LIVE_TOKEN, refresh_token: "refresh token&=+/?%" },
        }),
      },
      route: (url, index) => {
        if (url === CREDITS_URL) return index === 0 ? { status: 401 } : { body: CREDITS_BODY };
        if (url === REFRESH_URL) return { body: { access_token: "new-token", expires_in: 3600 } };
        return { body: { subscription_tier_display: "SuperGrok" } };
      },
    });

    const result = await grokAdapter.fetchUsage(context);
    expect(result.metrics[0]?.key).toBe("weekly");

    expect(calls.map((call) => call.url)).toEqual([CREDITS_URL, REFRESH_URL, CREDITS_URL, SETTINGS_URL]);
    expect(header(calls[0]!.init, "Authorization")).toBe(`Bearer ${LIVE_TOKEN}`);
    expect(header(calls[2]!.init, "Authorization")).toBe("Bearer new-token");
    // The plan call rides the rotated token, not the one that was just rejected.
    expect(header(calls[3]!.init, "Authorization")).toBe("Bearer new-token");

    const refresh = calls[1]!;
    expect(refresh.init?.method).toBe("POST");
    expect(header(refresh.init, "Content-Type")).toBe("application/x-www-form-urlencoded");
    // client_id comes from the "::" tail of the entry key; a space is %20, never +.
    expect(refresh.init?.body).toBe(
      "grant_type=refresh_token&client_id=client&refresh_token=refresh%20token%26%3D%2B%2F%3F%25",
    );
  });

  test("oidc_client_id wins over the entry key, and both over the built-in default", async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ oidc_client_id: "from-entry" }, "https://auth.x.ai::from-key", "from-entry"],
      [{}, "https://auth.x.ai::from-key", "from-key"],
      [{}, "single-segment", "b1a00492-073a-47ea-816f-4c329264a828"],
    ];
    for (const [extra, entryKey, expected] of cases) {
      const { context, calls } = makeContext({
        files: { [AUTH_PATH]: authFile({ [entryKey]: { key: LIVE_TOKEN, refresh_token: "r", ...extra } }) },
        route: (url, index) => {
          if (url === CREDITS_URL) return index === 0 ? { status: 403 } : { body: CREDITS_BODY };
          if (url === REFRESH_URL) return { body: { access_token: "new-token" } };
          return { body: {} };
        },
      });
      await grokAdapter.fetchUsage(context);
      expect(calls[1]!.init?.body).toBe(`grant_type=refresh_token&client_id=${expected}&refresh_token=r`);
    }
  });

  test("a rejected token with no refresh token is an expired sign-in", async () => {
    const { context, calls } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
      route: () => ({ status: 401 }),
    });
    await expect(grokAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
    // No refresh token means no second chance — one call, then give up.
    expect(calls.map((call) => call.url)).toEqual([CREDITS_URL]);
  });

  test("a second rejection after refreshing is final", async () => {
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN, refresh_token: "r" } }) },
      route: (url) => url === REFRESH_URL ? { body: { access_token: "new-token" } } : { status: 401 },
    });
    await expect(grokAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("a refresh that fails on a rejected token is an expired sign-in", async () => {
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN, refresh_token: "r" } }) },
      route: (url) => url === REFRESH_URL ? { status: 400, body: { error: "invalid_grant" } } : { status: 401 },
    });
    await expect(grokAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("a token expiring inside the refresh buffer is refreshed before use", async () => {
    const nearlyDead = jwt((NOW + 60_000) / 1000);
    const { context, calls } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: nearlyDead, refresh_token: "r" } }) },
      route: (url) => {
        if (url === REFRESH_URL) return { body: { access_token: "fresh-token" } };
        if (url === CREDITS_URL) return { body: CREDITS_BODY };
        return { body: {} };
      },
    });

    await grokAdapter.fetchUsage(context);
    expect(calls[0]!.url).toBe(REFRESH_URL);
    expect(header(calls[1]!.init, "Authorization")).toBe("Bearer fresh-token");
  });

  test("the file's expires_at also triggers a pre-emptive refresh", async () => {
    const { context, calls } = makeContext({
      files: {
        [AUTH_PATH]: authFile({
          // No JWT expiry at all, so only the file field can raise the flag.
          "https://auth.x.ai::client": {
            key: jwt(),
            refresh_token: "r",
            expires_at: "2026-07-06T12:02:00.000Z",
          },
        }),
      },
      route: (url) => {
        if (url === REFRESH_URL) return { body: { access_token: "fresh-token" } };
        if (url === CREDITS_URL) return { body: CREDITS_BODY };
        return { body: {} };
      },
    });

    await grokAdapter.fetchUsage(context);
    expect(calls[0]!.url).toBe(REFRESH_URL);
  });

  test("an expired account whose refresh fails falls through to the next one", async () => {
    const dead = jwt((NOW - 60_000) / 1000);
    const { context, calls } = makeContext({
      files: {
        [AUTH_PATH]: authFile({
          "https://auth.x.ai::dead": { key: dead, refresh_token: "dead-refresh" },
          "https://auth.x.ai::live": { key: LIVE_TOKEN },
        }),
      },
      route: (url) => {
        if (url === REFRESH_URL) return { status: 400 };
        if (url === CREDITS_URL) return { body: CREDITS_BODY };
        return { body: {} };
      },
    });

    const result = await grokAdapter.fetchUsage(context);
    expect(result.metrics[0]?.key).toBe("weekly");
    expect(calls[0]!.url).toBe(REFRESH_URL);
    expect(header(calls[1]!.init, "Authorization")).toBe(`Bearer ${LIVE_TOKEN}`);
  });

  test("every account expired and unrefreshable is an expired sign-in", async () => {
    const dead = jwt((NOW - 60_000) / 1000);
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::dead": { key: dead } }) },
      route: () => ({ status: 400 }),
    });
    await expect(grokAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("a 429 surfaces as a rate limit with its cooldown", async () => {
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN, refresh_token: "r" } }) },
      route: () => ({ status: 429, headers: { "retry-after": "90" } }),
    });
    const error = await grokAdapter.fetchUsage(context).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VibeRateLimitedError);
    expect((error as VibeRateLimitedError).retryAfterMs).toBe(90_000);
  });

  test("a 500 is a request error carrying its status", async () => {
    const { context } = makeContext({
      files: { [AUTH_PATH]: authFile({ "https://auth.x.ai::client": { key: LIVE_TOKEN } }) },
      route: () => ({ status: 503 }),
    });
    const error = await grokAdapter.fetchUsage(context).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect((error as VibeRequestError).status).toBe(503);
  });
});

describe("grok adapter — the rotated token goes back to the CLI", () => {
  // auth.x.ai rotates the refresh token on every exchange and revokes the chain
  // if the retired one is presented again, so a refresh we keep to ourselves
  // would sign the user out of their own `grok` CLI.
  const ENTRY = "https://auth.x.ai::client";

  function expiredAuth() {
    return authFile({
      [ENTRY]: {
        key: "stale-token",
        refresh_token: "refresh-1",
        expires_at: new Date(NOW - 60_000).toISOString(),
        email: "someone@example.com",
        team_id: "team-7",
      },
    });
  }

  test("only the rotated fields change; the rest of the entry survives", async () => {
    const { context, fileWrites } = makeContext({
      files: { [AUTH_PATH]: expiredAuth() },
      route: (url) => {
        if (url === REFRESH_URL) {
          return { body: { access_token: "fresh-token", refresh_token: "refresh-2", expires_in: 3_600 } };
        }
        if (url === CREDITS_URL) return { body: CREDITS_BODY };
        if (url === SETTINGS_URL) return { body: { subscription_tier_display: "SuperGrok" } };
        throw new Error(`unexpected ${url}`);
      },
    });

    await grokAdapter.fetchUsage(context);

    expect(fileWrites).toHaveLength(1);
    expect(fileWrites[0]!.path).toBe(AUTH_PATH);
    const entry = (JSON.parse(fileWrites[0]!.content) as Record<string, any>)[ENTRY];
    expect(entry.key).toBe("fresh-token");
    expect(entry.refresh_token).toBe("refresh-2");
    expect(entry.expires_at).toBe(new Date(NOW + 3_600_000).toISOString());
    // Fields the CLI owns and we never read must survive the round trip.
    expect(entry.email).toBe("someone@example.com");
    expect(entry.team_id).toBe("team-7");
  });

  test("a file that stops parsing between read and write is left alone", async () => {
    const { context, fileWrites } = makeContext({
      files: { [AUTH_PATH]: expiredAuth() },
      route: (url) => {
        if (url === REFRESH_URL) {
          return { body: { access_token: "fresh-token", refresh_token: "refresh-2", expires_in: 3_600 } };
        }
        if (url === CREDITS_URL) return { body: CREDITS_BODY };
        if (url === SETTINGS_URL) return { body: { subscription_tier_display: "SuperGrok" } };
        throw new Error(`unexpected ${url}`);
      },
    });
    let reads = 0;
    const original = context.readTextFile;
    context.readTextFile = async (path: string) => {
      reads += 1;
      return reads === 1 ? await original(path) : "{ not json";
    };
    await grokAdapter.fetchUsage(context);
    expect(fileWrites).toHaveLength(0);
  });
});
