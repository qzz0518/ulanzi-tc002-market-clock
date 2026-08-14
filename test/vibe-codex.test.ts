import { describe, expect, test } from "bun:test";
import { codexAdapter } from "../src/vibe/providers/codex.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type FetchLike,
  type VibeAdapterContext,
} from "../src/vibe/providers/types.ts";

const NOW = Date.parse("2026-08-14T09:00:00.000Z");
const XDG_PATH = "~/.config/codex/auth.json";
const HOME_PATH = "~/.codex/auth.json";
const KEYCHAIN_SERVICE = "Codex Auth";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const REFRESH_URL = "https://auth.openai.com/oauth/token";

/** A JWT whose `exp` claim is what `needsRefresh` reads; the signature is never checked. */
function jwt(expSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp: expSeconds, sub: "user-1" })}.signature`;
}

const LIVE_TOKEN = jwt(Math.floor(NOW / 1000) + 3_600);

function authBlob(overrides: {
  tokens?: Record<string, unknown> | null;
  root?: Record<string, unknown>;
} = {}): string {
  const tokens = overrides.tokens === null
    ? undefined
    : {
      access_token: LIVE_TOKEN,
      refresh_token: "refresh-token-1",
      id_token: "id-token-1",
      account_id: "acct-123",
      ...overrides.tokens,
    };
  return JSON.stringify({
    ...(tokens === undefined ? {} : { tokens }),
    last_refresh: "2026-08-13T01:40:00.000Z",
    ...overrides.root,
  });
}

/** Verbatim from the reverse-engineering report's sample `wham/usage` body. */
const USAGE_BODY = {
  plan_type: "prolite",
  rate_limit: {
    primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 18000 },
    secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1_767_225_600 },
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_spark",
      rate_limit: {
        primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_after_seconds: 600 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_767_225_600 },
      },
    },
  ],
  rate_limit_reset_credits: { available_count: 1 },
  credits: { balance: 100, has_credits: true },
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface Stub {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Harness {
  context: VibeAdapterContext;
  calls: Call[];
  keychainReads: string[];
  fileWrites: { path: string; content: string }[];
  keychainWrites: { service: string; value: string }[];
}

function makeContext(options: {
  files?: Record<string, string>;
  keychain?: Record<string, string>;
  env?: Record<string, string | undefined>;
  /** Per-URL queue; the last entry repeats once the queue drains. */
  responses?: Record<string, Stub[]>;
  now?: number;
} = {}): Harness {
  const calls: Call[] = [];
  const keychainReads: string[] = [];
  const queues = new Map(Object.entries(options.responses ?? {}).map(([url, stubs]) => [url, [...stubs]]));

  const fetchLike: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const queue = queues.get(url);
    if (queue === undefined || queue.length === 0) throw new Error(`unexpected request to ${url}`);
    const stub = queue.length === 1 ? queue[0]! : queue.shift()!;
    return new Response(stub.body === undefined ? "" : JSON.stringify(stub.body), {
      status: stub.status ?? 200,
      headers: stub.headers,
    });
  };

  const fileWrites: { path: string; content: string }[] = [];
  const keychainWrites: { service: string; value: string }[] = [];

  return {
    calls,
    keychainReads,
    fileWrites,
    keychainWrites,
    context: {
      now: () => options.now ?? NOW,
      fetch: fetchLike,
      env: options.env ?? {},
      keychain: {
        async read(service: string) {
          keychainReads.push(service);
          return options.keychain?.[service] ?? null;
        },
      },
      async readTextFile(path: string) {
        return options.files?.[path] ?? null;
      },
      async writeTextFile(path: string, content: string) {
        fileWrites.push({ path, content });
      },
      async listDirectory() {
        return [];
      },
      apiKey: () => null,
      timeoutMs: 5_000,
    },
  };
}

function usageOnly(body: unknown, stub: Omit<Stub, "body"> = {}): Record<string, Stub[]> {
  return { [USAGE_URL]: [{ ...stub, body }] };
}

describe("codex adapter — credentials", () => {
  test("finds auth.json, and reports no login when there is none", async () => {
    const stored = makeContext({ files: { [HOME_PATH]: authBlob() } });
    expect(await codexAdapter.detect(stored.context)).toBe(true);

    const empty = makeContext();
    expect(await codexAdapter.detect(empty.context)).toBe(false);
    await expect(codexAdapter.fetchUsage(empty.context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
    expect(empty.calls).toHaveLength(0);
  });

  test("an API-key-only auth.json is not a ChatGPT login", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob({ tokens: null, root: { OPENAI_API_KEY: "sk-proj-1" } }) },
    });
    expect(await codexAdapter.detect(harness.context)).toBe(false);
    const error = await codexAdapter.fetchUsage(harness.context).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(VibeCredentialsMissingError);
    expect((error as Error).message).toContain("API key");
  });

  test("the XDG path is read before the legacy dot-directory", async () => {
    const harness = makeContext({
      files: {
        [XDG_PATH]: authBlob({ tokens: { access_token: jwt(Math.floor(NOW / 1000) + 3_600) } }),
        [HOME_PATH]: authBlob({ tokens: { access_token: "legacy" } }),
      },
      responses: usageOnly(USAGE_BODY),
    });
    await codexAdapter.fetchUsage(harness.context);
    expect(harness.calls[0]?.headers.Authorization).not.toBe("Bearer legacy");
  });

  test("CODEX_HOME replaces both default paths", async () => {
    const harness = makeContext({
      env: { CODEX_HOME: "/opt/codex/" },
      files: { "/opt/codex/auth.json": authBlob(), [HOME_PATH]: authBlob({ tokens: { access_token: "ignored" } }) },
      responses: usageOnly(USAGE_BODY),
    });
    const result = await codexAdapter.fetchUsage(harness.context);
    expect(result.plan).toBe("Pro 5x");
    expect(harness.calls[0]?.headers.Authorization).toBe(`Bearer ${LIVE_TOKEN}`);
  });

  test("the keychain item is only consulted when no file carries a token", async () => {
    const withFile = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: usageOnly(USAGE_BODY),
    });
    await codexAdapter.fetchUsage(withFile.context);
    expect(withFile.keychainReads).toEqual([]);

    const keychainOnly = makeContext({
      keychain: { [KEYCHAIN_SERVICE]: authBlob({ tokens: { account_id: "acct-keychain" } }) },
      responses: usageOnly(USAGE_BODY),
    });
    await codexAdapter.fetchUsage(keychainOnly.context);
    expect(keychainOnly.keychainReads).toEqual([KEYCHAIN_SERVICE]);
    expect(keychainOnly.calls[0]?.headers["ChatGPT-Account-Id"]).toBe("acct-keychain");
  });

  test("a hex-encoded auth.json decodes like plain JSON", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: Buffer.from(authBlob(), "utf8").toString("hex") },
      responses: usageOnly(USAGE_BODY),
    });
    expect((await codexAdapter.fetchUsage(harness.context)).metrics.length).toBeGreaterThan(0);
  });

  test("the account header is omitted when the login has no account id", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob({ tokens: { account_id: undefined } }) },
      responses: usageOnly(USAGE_BODY),
    });
    await codexAdapter.fetchUsage(harness.context);
    expect(harness.calls[0]?.headers["ChatGPT-Account-Id"]).toBeUndefined();
  });
});

describe("codex adapter — metric mapping", () => {
  test("maps both windows, spark, credits and reset credits", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: usageOnly(USAGE_BODY),
    });
    const result = await codexAdapter.fetchUsage(harness.context);

    expect(harness.calls[0]?.url).toBe(USAGE_URL);
    expect(harness.calls[0]?.headers["ChatGPT-Account-Id"]).toBe("acct-123");
    expect(result.plan).toBe("Pro 5x");
    expect(result.metrics.map((metric) => metric.key)).toEqual([
      "session",
      "weekly",
      "spark",
      "sparkWeekly",
      "credits",
      "creditValue",
      "rateLimitResets",
    ]);

    expect(result.metrics[0]).toEqual({
      key: "session",
      label: "Session",
      kind: "consumption",
      unit: "percent",
      used: 1,
      limit: 100,
      remaining: 99,
      utilization: 0.01,
      // `reset_after_seconds` is relative to this request.
      resetsAt: new Date(NOW + 18_000_000).toISOString(),
      windowSeconds: 18_000,
    });
    expect(result.metrics[1]).toMatchObject({
      key: "weekly",
      label: "Weekly",
      used: 5,
      utilization: 0.05,
      // `reset_at` is absolute epoch seconds.
      resetsAt: new Date(1_767_225_600_000).toISOString(),
      windowSeconds: 604_800,
    });
    expect(result.metrics[2]).toMatchObject({
      key: "spark",
      label: "Spark",
      used: 12.5,
      utilization: 0.125,
      resetsAt: new Date(NOW + 600_000).toISOString(),
    });
    expect(result.metrics[3]).toMatchObject({ key: "sparkWeekly", label: "Spark Weekly", used: 40, windowSeconds: 604_800 });
    expect(result.metrics[4]).toEqual({
      key: "credits",
      label: "Credits",
      kind: "balance",
      unit: "credits",
      available: 100,
      resetsAt: undefined,
    });
    expect(result.metrics[5]).toMatchObject({ key: "creditValue", label: "Credits", unit: "usd", available: 4 });
    expect(result.metrics[6]).toMatchObject({
      key: "rateLimitResets",
      label: "Rate Limit Resets",
      kind: "balance",
      unit: "resets",
      available: 1,
    });
  });

  test("a window is classified by its declared length, not by its slot", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: usageOnly({
        // Codex parks a sole weekly limit in the primary slot during incidents.
        rate_limit: { primary_window: { used_percent: 63, limit_window_seconds: 604800, reset_at: 1_767_225_600 } },
      }),
    });
    const result = await codexAdapter.fetchUsage(harness.context);
    expect(result.metrics.map((metric) => metric.key)).toEqual(["weekly"]);
    expect(result.metrics[0]).toMatchObject({ used: 63, windowSeconds: 604_800 });
  });

  test("an undeclared window falls back to its slot's meaning", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: usageOnly({
        rate_limit: { primary_window: { used_percent: 8 }, secondary_window: { used_percent: 44 } },
      }),
    });
    const result = await codexAdapter.fetchUsage(harness.context);
    expect(result.metrics).toEqual([
      {
        key: "session",
        label: "Session",
        kind: "consumption",
        unit: "percent",
        used: 8,
        limit: 100,
        remaining: 92,
        utilization: 0.08,
        resetsAt: undefined,
        windowSeconds: 18_000,
      },
      {
        key: "weekly",
        label: "Weekly",
        kind: "consumption",
        unit: "percent",
        used: 44,
        limit: 100,
        remaining: 56,
        utilization: 0.44,
        resetsAt: undefined,
        windowSeconds: 604_800,
      },
    ]);
  });

  test("response headers can supply a percentage the body omitted", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: {
        [USAGE_URL]: [{
          body: { plan_type: "plus" },
          headers: { "x-codex-primary-used-percent": "3", "x-codex-credits-balance": "12" },
        }],
      },
    });
    const result = await codexAdapter.fetchUsage(harness.context);
    expect(result.plan).toBe("Plus");
    expect(result.metrics.map((metric) => metric.key)).toEqual(["session", "credits", "creditValue"]);
    expect(result.metrics[0]).toMatchObject({ used: 3, windowSeconds: 18_000 });
    expect(result.metrics[1]).toMatchObject({ available: 12 });
    expect(result.metrics[2]).toMatchObject({ available: 0.48 });
  });

  test("missing and malformed fields are dropped, never zeroed", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: usageOnly({
        rate_limit: { primary_window: { limit_window_seconds: 18000 }, secondary_window: null },
        additional_rate_limits: [{ limit_name: "GPT-5.3-Codex" }],
        rate_limit_reset_credits: { available_count: -2 },
        credits: {},
      }),
    });
    const result = await codexAdapter.fetchUsage(harness.context);
    expect(result.metrics).toEqual([]);
    expect(result.plan).toBeUndefined();
  });

  test("has_credits:false is a measured zero, and a partial balance floors", async () => {
    const none = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: usageOnly({ credits: { has_credits: false } }),
    });
    const zeroed = await codexAdapter.fetchUsage(none.context);
    expect(zeroed.metrics).toMatchObject([{ key: "credits", available: 0 }, { key: "creditValue", available: 0 }]);

    const partial = makeContext({
      files: { [HOME_PATH]: authBlob() },
      // The balance also arrives as a numeric string on some accounts.
      responses: usageOnly({ credits: { balance: "821.6" } }),
    });
    const floored = await codexAdapter.fetchUsage(partial.context);
    expect(floored.metrics).toMatchObject([{ key: "credits", available: 821 }, { key: "creditValue", available: 32.84 }]);
  });

  test("the dedicated reset-credit list wins and carries the nearest expiry", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: {
        [USAGE_URL]: [{ body: { rate_limit_reset_credits: { available_count: 1 } } }],
        [RESET_CREDITS_URL]: [{
          body: {
            available_count: 3,
            credits: [
              { id: "c1", expires_at: "2026-09-01T00:00:00.000Z" },
              { id: "c2", status: "available", expires_at: 1_767_225_600 },
              { id: "c3", status: "consumed", expires_at: 1_760_000_000 },
            ],
          },
        }],
      },
    });
    const result = await codexAdapter.fetchUsage(harness.context);
    expect(harness.calls[1]?.headers).toMatchObject({ "OpenAI-Beta": "codex-1", originator: "Codex Desktop" });
    expect(result.metrics.at(-1)).toMatchObject({
      key: "rateLimitResets",
      available: 3,
      // Nearest of the two usable credits; the consumed one expires sooner and is dropped.
      resetsAt: new Date(1_767_225_600_000).toISOString(),
    });
  });

  test("a failed or empty reset-credit call falls back to the usage body's count", async () => {
    const failed = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: {
        [USAGE_URL]: [{ body: { rate_limit_reset_credits: { available_count: 2 } } }],
        [RESET_CREDITS_URL]: [{ status: 500 }],
      },
    });
    expect((await codexAdapter.fetchUsage(failed.context)).metrics).toMatchObject([
      { key: "rateLimitResets", available: 2 },
    ]);

    const nulled = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: {
        [USAGE_URL]: [{ body: { rate_limit_reset_credits: { available_count: 2 } } }],
        [RESET_CREDITS_URL]: [{ body: { available_count: null } }],
      },
    });
    expect((await codexAdapter.fetchUsage(nulled.context)).metrics).toMatchObject([
      { key: "rateLimitResets", available: 2 },
    ]);
  });

  test("plan strings follow the vendor's own naming", async () => {
    const plan = async (planType: unknown) => {
      const harness = makeContext({
        files: { [HOME_PATH]: authBlob() },
        responses: usageOnly({ plan_type: planType }),
      });
      return (await codexAdapter.fetchUsage(harness.context)).plan;
    };
    expect(await plan("prolite")).toBe("Pro 5x");
    expect(await plan("pro")).toBe("Pro 20x");
    expect(await plan("plus")).toBe("Plus");
    expect(await plan("pro_plus")).toBe("Pro Plus");
    expect(await plan("business")).toBe("Business");
    expect(await plan("")).toBeUndefined();
    expect(await plan(7)).toBeUndefined();
    expect(await plan(undefined)).toBeUndefined();
  });
});

describe("codex adapter — errors and refresh", () => {
  test("a 401 refreshes once, form-encoded, and retries", async () => {
    const refreshed = jwt(Math.floor(NOW / 1000) + 7_200);
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: {
        [USAGE_URL]: [{ status: 401 }, { body: USAGE_BODY }],
        [REFRESH_URL]: [{ body: { access_token: refreshed, refresh_token: "refresh-token-2" } }],
        [RESET_CREDITS_URL]: [{ status: 404 }],
      },
    });
    const result = await codexAdapter.fetchUsage(harness.context);
    expect(result.metrics.length).toBeGreaterThan(0);

    const refreshCall = harness.calls.find((call) => call.url === REFRESH_URL);
    expect(refreshCall?.method).toBe("POST");
    expect(refreshCall?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(refreshCall?.body).toBe(
      "grant_type=refresh_token&client_id=app_EMoamEEZ73f0CkXaXp7hrann&refresh_token=refresh-token-1",
    );
    // The retried usage call and the reset-credit call both use the new token.
    expect(harness.calls.filter((call) => call.url === USAGE_URL).at(-1)?.headers.Authorization)
      .toBe(`Bearer ${refreshed}`);
    expect(harness.calls.find((call) => call.url === RESET_CREDITS_URL)?.headers.Authorization)
      .toBe(`Bearer ${refreshed}`);
  });

  test("an access token inside the five-minute window is refreshed before the call", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob({ tokens: { access_token: jwt(Math.floor(NOW / 1000) + 60) } }) },
      responses: {
        [USAGE_URL]: [{ body: USAGE_BODY }],
        [REFRESH_URL]: [{ body: { access_token: "proactive-token" } }],
      },
    });
    await codexAdapter.fetchUsage(harness.context);
    expect(harness.calls[0]?.url).toBe(REFRESH_URL);
    expect(harness.calls[1]?.headers.Authorization).toBe("Bearer proactive-token");
  });

  test("an unreadable exp falls back to the eight-day last_refresh bound", async () => {
    const stale = makeContext({
      files: {
        [HOME_PATH]: authBlob({
          tokens: { access_token: "opaque-token" },
          root: { last_refresh: new Date(NOW - 9 * 86_400_000).toISOString() },
        }),
      },
      responses: {
        [USAGE_URL]: [{ body: USAGE_BODY }],
        [REFRESH_URL]: [{ body: { access_token: "rotated-token" } }],
      },
    });
    await codexAdapter.fetchUsage(stale.context);
    expect(stale.calls[0]?.url).toBe(REFRESH_URL);

    const fresh = makeContext({
      files: {
        [HOME_PATH]: authBlob({
          tokens: { access_token: "opaque-token" },
          root: { last_refresh: new Date(NOW - 86_400_000).toISOString() },
        }),
      },
      responses: usageOnly(USAGE_BODY),
    });
    await codexAdapter.fetchUsage(fresh.context);
    expect(fresh.calls[0]?.url).toBe(USAGE_URL);
  });

  test("each refresh-token rejection maps to the right sign-in state", async () => {
    const refreshFailure = async (body: unknown, status = 400) => {
      const harness = makeContext({
        files: { [HOME_PATH]: authBlob({ tokens: { access_token: jwt(Math.floor(NOW / 1000) + 60) } }) },
        responses: { [REFRESH_URL]: [{ status, body }] },
      });
      return codexAdapter.fetchUsage(harness.context).catch((reason: unknown) => reason);
    };

    expect(await refreshFailure({ error: "refresh_token_expired" })).toBeInstanceOf(VibeCredentialsExpiredError);
    expect((await refreshFailure({ error: { code: "refresh_token_reused" } }) as Error).message)
      .toContain("token conflict");
    expect((await refreshFailure({ code: "refresh_token_invalidated" }, 401) as Error).message)
      .toContain("token revoked");
    // An unrecognised code is an HTTP failure, not a reason to make the user log in.
    expect(await refreshFailure({ error: "server_error" })).toBeInstanceOf(VibeRequestError);
  });

  test("a second 401 after refreshing gives up", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: {
        [USAGE_URL]: [{ status: 401 }],
        [REFRESH_URL]: [{ body: { access_token: jwt(Math.floor(NOW / 1000) + 7_200) } }],
      },
    });
    await expect(codexAdapter.fetchUsage(harness.context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("a 401 with no refresh token cannot be retried", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob({ tokens: { refresh_token: undefined } }) },
      responses: { [USAGE_URL]: [{ status: 401 }] },
    });
    await expect(codexAdapter.fetchUsage(harness.context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
    expect(harness.calls).toHaveLength(1);
  });

  test("an expired first login falls through to the second auth.json", async () => {
    const harness = makeContext({
      files: {
        [XDG_PATH]: authBlob({ tokens: { access_token: "stale", refresh_token: undefined, account_id: "acct-a" } }),
        [HOME_PATH]: authBlob({ tokens: { access_token: "fresh", refresh_token: undefined, account_id: "acct-b" } }),
      },
      responses: { [USAGE_URL]: [{ status: 401 }, { body: USAGE_BODY }] },
    });
    const result = await codexAdapter.fetchUsage(harness.context);
    expect(result.metrics.length).toBeGreaterThan(0);
    expect(harness.calls.filter((call) => call.url === USAGE_URL).map((call) => call.headers.Authorization))
      .toEqual(["Bearer stale", "Bearer fresh"]);
  });

  test("a 429 is a rate limit and a 500 is a request failure", async () => {
    const limited = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: { [USAGE_URL]: [{ status: 429, headers: { "retry-after": "30" } }] },
    });
    const rateLimited = await codexAdapter.fetchUsage(limited.context).catch((reason: unknown) => reason);
    expect(rateLimited).toBeInstanceOf(VibeRateLimitedError);
    expect((rateLimited as VibeRateLimitedError).retryAfterMs).toBe(30_000);

    const broken = makeContext({
      files: { [HOME_PATH]: authBlob() },
      responses: { [USAGE_URL]: [{ status: 500 }] },
    });
    const failed = await codexAdapter.fetchUsage(broken.context).catch((reason: unknown) => reason);
    expect(failed).toBeInstanceOf(VibeRequestError);
    expect((failed as VibeRequestError).status).toBe(500);
  });
});

describe("codex adapter — rotated credentials go back to the CLI", () => {
  // OpenAI retires the old refresh token on every exchange, so a refresh we
  // perform and keep to ourselves would sign the user out of the Codex CLI.
  const EXPIRED = authBlob({ tokens: { access_token: jwt(Math.floor(NOW / 1000) - 60) } });

  test("auth.json is rewritten in place, keeping the keys the CLI owns", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: EXPIRED },
      responses: {
        [REFRESH_URL]: [{ body: { access_token: jwt(Math.floor(NOW / 1000) + 3_600), refresh_token: "refresh-token-2" } }],
        [USAGE_URL]: [{ body: USAGE_BODY }],
      },
    });
    await codexAdapter.fetchUsage(harness.context);

    expect(harness.fileWrites).toHaveLength(1);
    expect(harness.fileWrites[0]!.path).toBe(HOME_PATH);
    const written = JSON.parse(harness.fileWrites[0]!.content) as Record<string, any>;
    expect(written.tokens.refresh_token).toBe("refresh-token-2");
    // Keys we never read must survive, and last_refresh follows the CLI's shape.
    expect(written.tokens.id_token).toBe("id-token-1");
    expect(written.tokens.account_id).toBe("acct-123");
    expect(written.last_refresh).toBe(new Date(NOW).toISOString());
  });

  test("a live token is never rotated, so auth.json is left untouched", async () => {
    const harness = makeContext({
      files: { [HOME_PATH]: authBlob({ tokens: { access_token: jwt(Math.floor(NOW / 1000) + 7_200) } }) },
      responses: usageOnly(USAGE_BODY),
    });
    await codexAdapter.fetchUsage(harness.context);
    expect(harness.fileWrites).toHaveLength(0);
  });
});
