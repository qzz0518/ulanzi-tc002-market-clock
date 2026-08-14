import { describe, expect, test } from "bun:test";
import { antigravityAdapter } from "../src/vibe/providers/antigravity.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type VibeAdapterContext,
} from "../src/vibe/providers/types.ts";

const NOW = Date.parse("2026-07-02T12:00:00Z");

const DAILY_BASE = "https://daily-cloudcode-pa.googleapis.com";
const FALLBACK_BASE = "https://cloudcode-pa.googleapis.com";

/**
 * Exactly what `security find-generic-password -a antigravity -s gemini -w`
 * prints on a machine signed in through the app: Go's keyring prefix, base64,
 * and the `agy` envelope with the real token one level down under "token".
 */
function keychainBlob(token: Record<string, unknown>): string {
  const json = JSON.stringify({ token, auth_method: "consumer" });
  return `go-keyring-base64:${Buffer.from(json, "utf8").toString("base64")}`;
}

const LIVE_TOKEN = keychainBlob({
  access_token: "ya29.live",
  refresh_token: "1//refresh",
  expiry: "2099-01-01T00:00:00Z",
  token_type: "Bearer",
});

/** Live-probe shape: two groups, four buckets, deliberately out of panel order. */
const QUOTA_SUMMARY = {
  groups: [
    {
      displayName: "Claude and other models",
      buckets: [
        { bucketId: "3p-weekly", displayName: "Weekly", window: "weekly", remainingFraction: 1, resetTime: "2026-07-06T07:00:00Z" },
        { bucketId: "3p-5h", displayName: "5-hour", window: "5h", remainingFraction: 0.4, resetTime: "2026-07-02T15:30:00Z" },
      ],
    },
    {
      displayName: "Gemini models",
      buckets: [
        { bucketId: "gemini-5h", displayName: "5-hour", window: "5h", remainingFraction: 0.75, resetTime: "2026-07-02T16:00:00Z" },
        { bucketId: "gemini-weekly", displayName: "Weekly", window: "weekly", remainingFraction: 0.9, resetTime: "2026-07-06T07:00:00Z" },
      ],
    },
  ],
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface Route {
  when: (url: string) => boolean;
  then: (call: Call, hits: number) => Response;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function endpoint(path: string, base?: string): (url: string) => boolean {
  return (url) => url.endsWith(path) && (base === undefined || url.startsWith(base));
}

function harness(options: {
  routes: Route[];
  keychain?: string | null;
  keychainError?: boolean;
  nowMs?: number;
}): { context: VibeAdapterContext; calls: Call[] } {
  const calls: Call[] = [];
  const hits = new Map<Route, number>();
  const context: VibeAdapterContext = {
    now: () => options.nowMs ?? NOW,
    fetch: async (url, init) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? init.body : "",
      };
      calls.push(call);
      for (const route of options.routes) {
        if (!route.when(url)) continue;
        const seen = hits.get(route) ?? 0;
        hits.set(route, seen + 1);
        return route.then(call, seen);
      }
      return new Response("no route", { status: 404 });
    },
    env: {},
    keychain: {
      read: async (service, account) => {
        expect(service).toBe("gemini");
        expect(account).toBe("antigravity");
        if (options.keychainError) throw new Error("keychain locked");
        return options.keychain === undefined ? LIVE_TOKEN : options.keychain;
      },
    },
    readTextFile: async () => null,
    writeTextFile: async () => {},
    listDirectory: async () => [],
    apiKey: () => null,
    timeoutMs: 5_000,
  };
  return { context, calls };
}

const summaryRoute = (base?: string): Route => ({
  when: endpoint("/v1internal:retrieveUserQuotaSummary", base),
  then: () => json(QUOTA_SUMMARY),
});

const assistRoute = (body: unknown): Route => ({
  when: endpoint("/v1internal:loadCodeAssist"),
  then: () => json(body),
});

describe("antigravity detect", () => {
  test("a keychain item is the whole probe — no network", async () => {
    const { context, calls } = harness({ routes: [] });
    expect(await antigravityAdapter.detect(context)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("nothing stored means not installed", async () => {
    const { context } = harness({ routes: [], keychain: null });
    expect(await antigravityAdapter.detect(context)).toBe(false);
  });

  test("a locked keychain keeps the provider enabled so the error can be shown", async () => {
    const { context } = harness({ routes: [], keychainError: true });
    expect(await antigravityAdapter.detect(context)).toBe(true);
  });
});

describe("antigravity quota summary", () => {
  test("maps the four buckets to catalog keys, labels and windows", async () => {
    const { context, calls } = harness({
      routes: [summaryRoute(), assistRoute({ paidTier: { name: "Google AI Pro" }, cloudaicompanionProject: "proj-1" })],
    });

    const result = await antigravityAdapter.fetchUsage(context);

    expect(result.plan).toBe("Pro");
    expect(result.metrics).toEqual([
      {
        key: "geminiSession",
        label: "Session",
        kind: "consumption",
        unit: "percent",
        used: 25,
        limit: 100,
        remaining: 75,
        utilization: 0.25,
        resetsAt: "2026-07-02T16:00:00.000Z",
        windowSeconds: 18_000,
      },
      {
        key: "geminiWeekly",
        label: "Weekly",
        kind: "consumption",
        unit: "percent",
        used: 10,
        limit: 100,
        remaining: 90,
        utilization: 0.1,
        resetsAt: "2026-07-06T07:00:00.000Z",
        windowSeconds: 604_800,
      },
      {
        key: "nonGeminiSession",
        label: "Claude",
        kind: "consumption",
        unit: "percent",
        used: 60,
        limit: 100,
        remaining: 40,
        utilization: 0.6,
        resetsAt: "2026-07-02T15:30:00.000Z",
        windowSeconds: 18_000,
      },
      {
        key: "nonGeminiWeekly",
        label: "Claude Weekly",
        kind: "consumption",
        unit: "percent",
        used: 0,
        limit: 100,
        remaining: 100,
        utilization: 0,
        resetsAt: "2026-07-06T07:00:00.000Z",
        windowSeconds: 604_800,
      },
    ]);

    const summary = calls[0]!;
    expect(summary.url).toBe(`${DAILY_BASE}/v1internal:retrieveUserQuotaSummary`);
    expect(summary.method).toBe("POST");
    expect(summary.body).toBe("{}");
    expect(summary.headers.Authorization).toBe("Bearer ya29.live");
    expect(summary.headers["User-Agent"]).toBe("antigravity");
    // The plan lookup is the CLI endpoint and identifies itself as the CLI.
    expect(calls[1]!.headers["User-Agent"]).toBe("agy");
  });

  test("falls through to the second host when the first one is broken", async () => {
    const { context, calls } = harness({
      routes: [
        { when: endpoint("/v1internal:retrieveUserQuotaSummary", DAILY_BASE), then: () => new Response("boom", { status: 500 }) },
        summaryRoute(FALLBACK_BASE),
        assistRoute({ currentTier: { name: "Free" } }),
      ],
    });

    const result = await antigravityAdapter.fetchUsage(context);

    expect(result.metrics).toHaveLength(4);
    expect(result.plan).toBe("Free");
    expect(calls.map((call) => call.url.startsWith(DAILY_BASE))).toEqual([true, false, true]);
  });

  test("accepts the language-server envelope shape as well", async () => {
    const { context } = harness({
      routes: [
        { when: endpoint("/v1internal:retrieveUserQuotaSummary"), then: () => json({ response: QUOTA_SUMMARY }) },
        assistRoute({}),
      ],
    });
    const result = await antigravityAdapter.fetchUsage(context);
    expect(result.metrics.map((metric) => metric.key)).toEqual([
      "geminiSession", "geminiWeekly", "nonGeminiSession", "nonGeminiWeekly",
    ]);
  });

  test("drops what the vendor did not send instead of zeroing it", async () => {
    const { context } = harness({
      routes: [
        {
          when: endpoint("/v1internal:retrieveUserQuotaSummary"),
          then: () => json({
            groups: [
              {
                buckets: [
                  { bucketId: "gemini-5h", remainingFraction: 0.5, resetTime: "2026-07-02T16:00:00Z" },
                  // No fraction: the row must vanish, not read 0%.
                  { bucketId: "gemini-weekly", resetTime: "2026-07-06T07:00:00Z" },
                  // A pool we have never seen must not join an existing meter.
                  { bucketId: "gemini-image-5h", remainingFraction: 0 },
                  // Duplicate: the first copy is the one that counts.
                  { bucketId: "gemini-5h", remainingFraction: 0.1 },
                  { bucketId: "3p-5h", remainingFraction: "0.25" },
                ],
              },
              { displayName: "a group with no buckets at all" },
            ],
          }),
        },
        assistRoute({}),
      ],
    });

    const result = await antigravityAdapter.fetchUsage(context);

    expect(result.metrics.map((metric) => [metric.key, metric.used])).toEqual([
      ["geminiSession", 50],
      ["nonGeminiSession", 75],
    ]);
    expect(result.metrics[0]!.resetsAt).toBe("2026-07-02T16:00:00.000Z");
    // resetTime is optional; a line without one still renders.
    expect(result.metrics[1]!.resetsAt).toBeUndefined();
  });

  test("clamps fractions the wire has actually sent out of range", async () => {
    const { context } = harness({
      routes: [
        {
          when: endpoint("/v1internal:retrieveUserQuotaSummary"),
          then: () => json({
            groups: [{ buckets: [
              { bucketId: "gemini-5h", remainingFraction: 1.5 },
              { bucketId: "3p-5h", remainingFraction: -0.2 },
            ] }],
          }),
        },
        assistRoute({}),
      ],
    });
    const result = await antigravityAdapter.fetchUsage(context);
    expect(result.metrics.map((metric) => [metric.key, metric.used, metric.utilization])).toEqual([
      ["geminiSession", 0, 0],
      ["nonGeminiSession", 100, 1],
    ]);
  });

  test("an empty group list is an answer, not a reason to try the old endpoints", async () => {
    const { context, calls } = harness({
      routes: [
        { when: endpoint("/v1internal:retrieveUserQuotaSummary"), then: () => json({ groups: [] }) },
        assistRoute({ paidTier: { name: "Google AI Ultra" } }),
      ],
    });

    const result = await antigravityAdapter.fetchUsage(context);

    expect(result.metrics).toEqual([]);
    expect(result.plan).toBe("Ultra");
    expect(result.note).toBe("Antigravity 这次没有返回任何额度区间。");
    expect(calls.some((call) => call.url.includes("fetchAvailableModels"))).toBe(false);
  });
});

describe("antigravity credentials", () => {
  test("no keychain item is a state, not a failure", async () => {
    const { context, calls } = harness({ routes: [], keychain: null });
    await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow(VibeCredentialsMissingError);
    await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow("start Antigravity");
    expect(calls).toHaveLength(0);
  });

  test("an unlockable keychain is a request error, not a logout", async () => {
    const { context } = harness({ routes: [], keychainError: true });
    await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow(VibeRequestError);
  });

  test("a blob with no token in it is never posted as a bearer", async () => {
    for (const raw of ["{not json", "[1,2,3]", "{\"auth_method\":\"consumer\"}", "go-keyring-base64:"]) {
      const { context, calls } = harness({ routes: [summaryRoute()], keychain: raw });
      await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow(VibeCredentialsExpiredError);
      expect(calls).toHaveLength(0);
    }
  });

  test("reads the shapes the app and the CLI actually write", async () => {
    const shapes: [string, string][] = [
      [LIVE_TOKEN, "ya29.live"],
      // Plain JSON, no keyring wrapper, camelCase keys.
      [JSON.stringify({ accessToken: "ya29.camel" }), "ya29.camel"],
      // Nested under one of the containers the CLI has used.
      [JSON.stringify({ credentials: { access_token: "ya29.nested" } }), "ya29.nested"],
      // A bare JSON string, a "Bearer …" line, and a naked token.
      [JSON.stringify("ya29.string"), "ya29.string"],
      ["Bearer ya29.header", "ya29.header"],
      ["ya29.raw", "ya29.raw"],
    ];
    for (const [raw, expected] of shapes) {
      const { context, calls } = harness({ routes: [summaryRoute(), assistRoute({})], keychain: raw });
      await antigravityAdapter.fetchUsage(context);
      expect(calls[0]!.headers.Authorization).toBe(`Bearer ${expected}`);
    }
  });

  test("an expired token with nothing to refresh it reads as signed out", async () => {
    const { context, calls } = harness({
      routes: [summaryRoute()],
      keychain: keychainBlob({ access_token: "ya29.stale", expiry: "2026-07-02T12:00:30Z" }),
    });
    // 30 s of life left is inside the 60 s buffer, so it is not worth a trip.
    await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow(VibeCredentialsMissingError);
    expect(calls).toHaveLength(0);
  });

  test("an expired token with a refresh token is refreshed before the first call", async () => {
    const { context, calls } = harness({
      routes: [
        {
          when: (url) => url === "https://oauth2.googleapis.com/token",
          then: () => json({ access_token: "ya29.fresh", expires_in: 3600 }),
        },
        summaryRoute(),
        assistRoute({}),
      ],
      keychain: keychainBlob({
        access_token: "ya29.stale",
        refresh_token: "1//re fresh+token",
        expiry: "2020-01-01T00:00:00Z",
      }),
    });

    await antigravityAdapter.fetchUsage(context);

    const refresh = calls[0]!;
    expect(refresh.url).toBe("https://oauth2.googleapis.com/token");
    expect(refresh.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(refresh.body).toBe(
      "client_id=REDACTED-OAUTH-CLIENT-ID"
      + "&client_secret=REDACTED-OAUTH-CLIENT-SECRET"
      + "&refresh_token=1%2F%2Fre%20fresh%2Btoken"
      + "&grant_type=refresh_token",
    );
    expect(calls[1]!.headers.Authorization).toBe("Bearer ya29.fresh");
  });

  test("a 401 buys exactly one refresh, then the retry decides", async () => {
    const { context, calls } = harness({
      routes: [
        { when: (url) => url.includes("oauth2"), then: () => json({ access_token: "ya29.fresh" }) },
        {
          when: endpoint("/v1internal:retrieveUserQuotaSummary"),
          // Both hosts reject the stale token, then both accept the fresh one.
          then: (call) => (call.headers.Authorization === "Bearer ya29.live"
            ? new Response("expired", { status: 401 })
            : json(QUOTA_SUMMARY)),
        },
        assistRoute({}),
      ],
    });

    const result = await antigravityAdapter.fetchUsage(context);

    expect(result.metrics).toHaveLength(4);
    expect(calls.filter((call) => call.url.includes("oauth2"))).toHaveLength(1);
    // The plan lookup must spend the refreshed token, not the dead one.
    expect(calls.at(-1)!.headers.Authorization).toBe("Bearer ya29.fresh");
  });

  test("a token minted seconds ago and rejected is not minted again", async () => {
    const { context, calls } = harness({
      routes: [
        { when: (url) => url.includes("oauth2"), then: () => json({ access_token: "ya29.fresh" }) },
        { when: endpoint("/v1internal:retrieveUserQuotaSummary"), then: () => new Response("nope", { status: 401 }) },
      ],
      keychain: keychainBlob({ access_token: "ya29.stale", refresh_token: "1//refresh", expiry: "2020-01-01T00:00:00Z" }),
    });

    await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow(VibeCredentialsExpiredError);

    expect(calls.filter((call) => call.url.includes("oauth2"))).toHaveLength(1);
  });

  test("a second rejection is final", async () => {
    const { context } = harness({
      routes: [
        { when: (url) => url.includes("oauth2"), then: () => json({ access_token: "ya29.fresh" }) },
        { when: endpoint("/v1internal:retrieveUserQuotaSummary"), then: () => new Response("nope", { status: 403 }) },
      ],
    });
    await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow(VibeCredentialsExpiredError);
  });

  test("invalid_grant from Google is a dead sign-in", async () => {
    const { context } = harness({
      routes: [
        { when: (url) => url.includes("oauth2"), then: () => json({ error: "invalid_grant" }, 400) },
      ],
      keychain: keychainBlob({ refresh_token: "1//dead" }),
    });
    await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow(VibeCredentialsExpiredError);
  });

  test("a busy token endpoint is congestion, not a logout", async () => {
    const { context } = harness({
      routes: [
        { when: (url) => url.includes("oauth2"), then: () => new Response("", { status: 408 }) },
      ],
      keychain: keychainBlob({ refresh_token: "1//slow" }),
    });
    const error = await antigravityAdapter.fetchUsage(context).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect((error as VibeRequestError).status).toBe(408);
  });
});

describe("antigravity failure modes", () => {
  test("a 429 backs off instead of falling through to the legacy chain", async () => {
    const { context, calls } = harness({
      routes: [
        {
          when: endpoint("/v1internal:retrieveUserQuotaSummary"),
          then: () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
        },
      ],
    });

    const error = await antigravityAdapter.fetchUsage(context).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(VibeRateLimitedError);
    expect((error as VibeRateLimitedError).retryAfterMs).toBe(30_000);
    // One host, one call: the second would spend the same quota.
    expect(calls).toHaveLength(1);
  });

  test("everything down is a request error, not fabricated zeroes", async () => {
    const { context } = harness({ routes: [{ when: () => true, then: () => new Response("", { status: 503 }) }] });
    await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow(VibeRequestError);
  });
});

describe("antigravity legacy endpoints", () => {
  const MODELS = {
    models: {
      p: { model: "MODEL_P", displayName: "Gemini 3.1 Pro (High)", quotaInfo: { remainingFraction: 0.4, resetTime: "2026-06-26T09:37:05Z" } },
      q: { model: "MODEL_Q", displayName: "Gemini 3.1 Pro (Low)", quotaInfo: { remainingFraction: 0.9 } },
      c: { model: "MODEL_C", displayName: "Claude Sonnet 4.6", quotaInfo: { remainingFraction: 0.5 } },
      // Blacklisted, and depleted: it must not drag the Gemini pool to 100%.
      x: { model: "MODEL_GOOGLE_GEMINI_2_5_PRO", displayName: "Gemini 2.5 Pro" },
      hidden: { model: "MODEL_H", displayName: "Internal", isInternal: true, quotaInfo: { remainingFraction: 0 } },
      unnamed: { model: "MODEL_U", quotaInfo: { remainingFraction: 0 } },
    },
  };

  test("pools the model list into the two 5-hour meters when the summary RPC is missing", async () => {
    const { context, calls } = harness({
      routes: [
        { when: endpoint("/v1internal:retrieveUserQuotaSummary"), then: () => new Response("", { status: 404 }) },
        { when: endpoint("/v1internal:fetchAvailableModels"), then: () => json(MODELS) },
        assistRoute({ currentTier: { name: "Gemini Code Assist in Google One AI Pro" } }),
      ],
    });

    const result = await antigravityAdapter.fetchUsage(context);

    expect(result.plan).toBe("Pro");
    expect(result.metrics).toEqual([
      {
        key: "geminiSession",
        label: "Session",
        kind: "consumption",
        unit: "percent",
        used: 60,
        limit: 100,
        remaining: 40,
        utilization: 0.6,
        resetsAt: "2026-06-26T09:37:05.000Z",
        windowSeconds: 18_000,
      },
      {
        key: "nonGeminiSession",
        label: "Claude",
        kind: "consumption",
        unit: "percent",
        used: 50,
        limit: 100,
        remaining: 50,
        utilization: 0.5,
        resetsAt: undefined,
        windowSeconds: 18_000,
      },
    ]);
    // Both hosts get one shot at the missing RPC before the fallback starts.
    expect(calls.filter((call) => call.url.includes("retrieveUserQuotaSummary"))).toHaveLength(2);
  });

  test("a model the server lists without quota info is a spent pool, per upstream", async () => {
    const { context } = harness({
      routes: [
        { when: endpoint("/v1internal:retrieveUserQuotaSummary"), then: () => new Response("", { status: 404 }) },
        {
          when: endpoint("/v1internal:fetchAvailableModels"),
          then: () => json({ models: { a: { model: "MODEL_A", displayName: "Gemini 3 Pro" } } }),
        },
        assistRoute({}),
      ],
    });
    const result = await antigravityAdapter.fetchUsage(context);
    expect(result.metrics).toEqual([expect.objectContaining({ key: "geminiSession", used: 100, utilization: 1 })]);
  });

  test("retrieveUserQuota carries the project, then retries without it", async () => {
    const { context, calls } = harness({
      routes: [
        { when: endpoint("/v1internal:retrieveUserQuotaSummary"), then: () => new Response("", { status: 404 }) },
        { when: endpoint("/v1internal:fetchAvailableModels"), then: () => new Response("", { status: 404 }) },
        assistRoute({ cloudaicompanionProject: "proj-7", paidTier: { name: "Google AI Ultra" } }),
        {
          when: endpoint("/v1internal:retrieveUserQuota"),
          // The project-scoped call fails on both hosts; the bare retry works.
          then: (call) => (call.body === "{}"
            ? json({ buckets: [
              { modelId: "gemini-3-pro-preview", remainingFraction: 0.5, resetTime: "2026-06-27T04:44:01Z" },
              { modelId: "claude-sonnet-4-6", remainingFraction: 0.2 },
            ] })
            : new Response("", { status: 400 })),
        },
      ],
    });

    const result = await antigravityAdapter.fetchUsage(context);

    expect(result.plan).toBe("Ultra");
    expect(result.metrics.map((metric) => [metric.key, metric.used, metric.resetsAt])).toEqual([
      ["geminiSession", 50, "2026-06-27T04:44:01.000Z"],
      ["nonGeminiSession", 80, undefined],
    ]);
    const quotaCalls = calls.filter((call) => call.url.endsWith(":retrieveUserQuota"));
    expect(quotaCalls[0]!.body).toBe(JSON.stringify({ project: "proj-7" }));
    expect(quotaCalls.at(-1)!.body).toBe("{}");
    expect(quotaCalls[0]!.headers["User-Agent"]).toBe("agy");
  });

  test("nothing anywhere is a request error", async () => {
    const { context } = harness({
      routes: [{ when: () => true, then: () => new Response("", { status: 404 }) }],
    });
    await expect(antigravityAdapter.fetchUsage(context)).rejects.toThrow(/temporarily unavailable/);
  });
});

describe("antigravity plan strings", () => {
  const cases: [unknown, string | undefined][] = [
    [{ paidTier: { name: "Google AI Pro" } }, "Pro"],
    [{ paidTier: { name: "Google AI Ultra" } }, "Ultra"],
    [{ currentTier: { name: "Gemini Code Assist in Google One AI Pro" } }, "Pro"],
    [{ currentTier: { name: "Gemini Code Assist" } }, "Gemini Code Assist"],
    [{ currentTier: { name: "free tier" } }, "Free"],
    // paidTier wins: currentTier reads "Free" for a subscriber mid-cycle.
    [{ currentTier: { name: "Free" }, paidTier: { name: "Google AI Ultra" } }, "Ultra"],
    [{ currentTier: {} }, undefined],
    [{}, undefined],
  ];

  for (const [body, expected] of cases) {
    test(`${JSON.stringify(body)} → ${expected ?? "no plan"}`, async () => {
      const { context } = harness({ routes: [summaryRoute(), assistRoute(body)] });
      expect((await antigravityAdapter.fetchUsage(context)).plan).toBe(expected as string);
    });
  }

  test("a plan lookup that fails never costs the meters", async () => {
    const { context } = harness({
      routes: [summaryRoute(), { when: endpoint("/v1internal:loadCodeAssist"), then: () => new Response("", { status: 500 }) }],
    });
    const result = await antigravityAdapter.fetchUsage(context);
    expect(result.plan).toBeUndefined();
    expect(result.metrics).toHaveLength(4);
  });
});
