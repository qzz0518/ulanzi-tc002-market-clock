import { describe, expect, test } from "bun:test";
import { copilotAdapter } from "../src/vibe/providers/copilot.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type VibeAdapterContext,
  type VibeMetric,
} from "../src/vibe/providers/types.ts";

const NOW = Date.parse("2026-08-14T09:00:00Z");
const MONTH_SECONDS = 2_592_000;

const APPS_PATH = "~/.config/github-copilot/apps.json";
const HOSTS_JSON_PATH = "~/.config/github-copilot/hosts.json";
const GH_HOSTS_PATH = "~/.config/gh/hosts.yml";

const USAGE_URL = "https://api.github.com/copilot_internal/user";
const ORGS_URL = "https://api.github.com/user/orgs?per_page=100";
const ORG_BILLING_URL = "https://api.github.com/orgs/acme/settings/billing/usage/summary";

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
    keychain: {
      read: async (service, account) => {
        const scoped = account === undefined ? undefined : options.keychain?.[`${service} ${account}`];
        return scoped ?? options.keychain?.[service] ?? null;
      },
    },
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

const EDITOR_APPS = JSON.stringify({
  "github.com:Iv1.abc123": { user: "octocat", oauth_token: "gho_editor" },
});

/** The paid-seat body, verbatim from a live `copilot_internal/user`. */
const PAID_BODY = {
  copilot_plan: "pro",
  quota_reset_date: "2099-01-15T00:00:00Z",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      remaining: 123,
      percent_remaining: 41,
      overage_permitted: true,
      overage_count: 12,
      quota_id: "premium",
    },
    chat: { entitlement: 1000, remaining: 950, percent_remaining: 95, quota_id: "chat" },
  },
};

/** Free tier: a day-only reset date and a zero-entitlement premium placeholder. */
const FREE_BODY = {
  copilot_plan: "individual",
  access_type_sku: "free_limited_copilot",
  token_based_billing: true,
  quota_reset_date: "2099-07-01",
  quota_snapshots: {
    chat: { entitlement: 200, remaining: 182, percent_remaining: 91.0, overage_permitted: false },
    completions: {
      entitlement: 2000,
      remaining: 1989,
      percent_remaining: 99.4,
      overage_permitted: false,
    },
    premium_interactions: {
      entitlement: 0,
      remaining: 0,
      percent_remaining: 0.0,
      overage_permitted: false,
    },
  },
};

/** Org-managed Business seat: every bucket is an "unlimited" placeholder. */
const ORG_PLACEHOLDER = {
  overage_count: 0,
  overage_entitlement: 0,
  overage_permitted: true,
  percent_remaining: 100.0,
  quota_remaining: 0.0,
  unlimited: true,
  has_quota: true,
  quota_reset_at: 0,
  token_based_billing: true,
  remaining: 0,
  entitlement: 0,
};

const ORG_BODY = {
  copilot_plan: "business",
  token_based_billing: true,
  quota_snapshots: {
    premium_interactions: { ...ORG_PLACEHOLDER, quota_id: "premium_interactions" },
    chat: { ...ORG_PLACEHOLDER, quota_id: "chat" },
    completions: { ...ORG_PLACEHOLDER, quota_id: "completions" },
  },
};

const ORG_BILLING_BODY = {
  timePeriod: { year: 2026, month: 7 },
  organization: "acme",
  usageItems: [
    {
      product: "Copilot",
      sku: "copilot_ai_unit",
      unitType: "ai-units",
      pricePerUnit: 0.01,
      grossQuantity: 298.698546,
      grossAmount: 2.98698546,
      discountQuantity: 298.698546,
      discountAmount: 2.98698546,
      netQuantity: 40,
      netAmount: 1.25,
    },
    // A seat fee, deliberately not a credit line.
    { product: "Copilot", unitType: "user-months", grossQuantity: 12, netAmount: 228 },
    { product: "Actions", unitType: "minutes", grossQuantity: 900, netAmount: 7.2 },
  ],
};

describe("copilot adapter", () => {
  test("maps a paid seat's credits, overage and chat meters", async () => {
    const { context, calls } = harness({
      routes: { [USAGE_URL]: () => json(PAID_BODY) },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    const result = await copilotAdapter.fetchUsage(context);

    expect(result.plan).toBe("Pro");
    expect(result.metrics.map((metric) => metric.key)).toEqual([
      "premiumCredits",
      "extraUsage",
      "chat",
    ]);
    expect(byKey(result.metrics, "premiumCredits")).toEqual({
      key: "premiumCredits",
      label: "Credits",
      kind: "consumption",
      unit: "percent",
      used: 59,
      limit: 100,
      remaining: 41,
      utilization: 0.59,
      resetsAt: "2099-01-15T00:00:00.000Z",
      windowSeconds: MONTH_SECONDS,
    });
    expect(byKey(result.metrics, "extraUsage")).toEqual({
      key: "extraUsage",
      label: "Extra Usage",
      kind: "consumption",
      unit: "count",
      used: 12,
      limit: undefined,
      remaining: undefined,
      utilization: undefined,
      resetsAt: undefined,
      windowSeconds: undefined,
    });
    expect(byKey(result.metrics, "chat")).toMatchObject({
      label: "Chat",
      used: 5,
      limit: 100,
      utilization: 0.05,
    });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    // GitHub OAuth tokens use the `token` scheme, and the endpoint needs editor headers.
    expect(headers.Authorization).toBe("token gho_editor");
    expect(headers["Editor-Version"]).toBe("vscode/1.96.2");
    expect(headers["X-Github-Api-Version"]).toBe("2025-04-01");
  });

  test("free tier: zero entitlement suppresses credits, day-only reset parses as UTC", async () => {
    const { context } = harness({
      routes: { [USAGE_URL]: () => json(FREE_BODY) },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    const result = await copilotAdapter.fetchUsage(context);

    expect(result.plan).toBe("Individual");
    expect(result.metrics.map((metric) => metric.key)).toEqual(["chat", "completions"]);
    expect(byKey(result.metrics, "chat")).toMatchObject({
      used: 9,
      limit: 100,
      resetsAt: "2099-07-01T00:00:00.000Z",
    });
    expect(byKey(result.metrics, "completions")?.used).toBeCloseTo(0.6, 10);
    // No credits meter, so no Extra Usage row can hang off one.
    expect(byKey(result.metrics, "extraUsage")).toBeUndefined();
  });

  test("an org-managed seat suppresses every placeholder and reads org billing instead", async () => {
    const { context, calls } = harness({
      routes: {
        [USAGE_URL]: () => json(ORG_BODY),
        [ORGS_URL]: () => json([{ login: "acme" }, { login: "other" }]),
        [ORG_BILLING_URL]: () => json(ORG_BILLING_BODY),
      },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    const result = await copilotAdapter.fetchUsage(context);

    expect(result.plan).toBe("Business");
    expect(result.metrics.map((metric) => metric.key)).toEqual(["orgCredits", "orgSpend"]);
    // Only the ai-units line counts: the seat fee and the Actions minutes do not.
    expect(byKey(result.metrics, "orgCredits")).toMatchObject({
      label: "Org Credits",
      unit: "credits",
      used: 298.698546,
      limit: undefined,
    });
    expect(byKey(result.metrics, "orgSpend")).toMatchObject({
      label: "Org Spend",
      unit: "usd",
      used: 1.25,
    });
    expect(result.note).toBeUndefined();
    const billingHeaders = calls[2]?.init?.headers as Record<string, string>;
    expect(billingHeaders.Accept).toBe("application/vnd.github+json");
    expect(billingHeaders["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  test("an org-managed seat without read:org degrades to a plan-only card", async () => {
    const { context } = harness({
      routes: {
        [USAGE_URL]: () => json(ORG_BODY),
        [ORGS_URL]: () => json({ message: "Requires read:org" }, 403),
      },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    const result = await copilotAdapter.fetchUsage(context);

    expect(result.plan).toBe("Business");
    expect(result.metrics).toEqual([]);
    expect(result.note).toBe("组织统一管理的席位，这个账号读不到账单额度。");
  });

  test("org discovery skips an org with no Copilot credits and keeps walking", async () => {
    const { context } = harness({
      routes: {
        [USAGE_URL]: () => json(ORG_BODY),
        [ORGS_URL]: () => json([{ login: "empty" }, { login: "flaky" }, { login: "acme" }]),
        "https://api.github.com/orgs/empty/": () => json({ usageItems: [] }),
        // A 5xx must not end the walk, and must not be read as "no credits here".
        "https://api.github.com/orgs/flaky/": () => json({}, 503),
        [ORG_BILLING_URL]: () => json(ORG_BILLING_BODY),
      },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    const result = await copilotAdapter.fetchUsage(context);

    expect(result.metrics.map((metric) => metric.key)).toEqual(["orgCredits", "orgSpend"]);
  });

  test("legacy free shape without quota_snapshots still meters chat and completions", async () => {
    const { context } = harness({
      routes: {
        [USAGE_URL]: () => json({
          copilot_plan: "free_limited_copilot",
          limited_user_reset_date: "2026-09-01",
          limited_user_quotas: { chat: 25, completions: 1500 },
          monthly_quotas: { chat: 50, completions: 2000 },
        }),
      },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    const result = await copilotAdapter.fetchUsage(context);

    expect(result.plan).toBe("Free Limited Copilot");
    expect(byKey(result.metrics, "chat")).toMatchObject({
      used: 50,
      limit: 100,
      utilization: 0.5,
      resetsAt: "2026-09-01T00:00:00.000Z",
    });
    expect(byKey(result.metrics, "completions")).toMatchObject({ used: 25, utilization: 0.25 });
  });

  test.each([
    ["pro", "Pro"],
    ["business", "Business"],
    ["individual", "Individual"],
    ["enterprise", "Enterprise"],
    ["free_limited_copilot", "Free Limited Copilot"],
  ])("plan %p reads as %p", async (raw, expected) => {
    const { context } = harness({
      routes: { [USAGE_URL]: () => json({ ...PAID_BODY, copilot_plan: raw }) },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    expect((await copilotAdapter.fetchUsage(context)).plan).toBe(expected);
  });

  test("a non-string plan is omitted rather than invented", async () => {
    const { context } = harness({
      routes: { [USAGE_URL]: () => json({ ...PAID_BODY, copilot_plan: 42 }) },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    expect((await copilotAdapter.fetchUsage(context)).plan).toBeUndefined();
  });

  test("unlimited and sentinel buckets are dropped, not drawn as 0%", async () => {
    const { context } = harness({
      routes: {
        [USAGE_URL]: () => json({
          copilot_plan: "pro",
          quota_snapshots: {
            premium_interactions: { entitlement: 300, remaining: 150 },
            chat: { unlimited: true, entitlement: 100, remaining: 100, percent_remaining: 100 },
            completions: { entitlement: -1, remaining: -1, percent_remaining: 100 },
          },
        }),
      },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    const result = await copilotAdapter.fetchUsage(context);

    // No percent_remaining on premium, so the entitlement ratio answers instead.
    expect(result.metrics.map((metric) => metric.key)).toEqual(["premiumCredits"]);
    expect(byKey(result.metrics, "premiumCredits")).toMatchObject({ used: 50, limit: 100 });
    // No resets in the payload means no resetsAt at all.
    expect(byKey(result.metrics, "premiumCredits")?.resetsAt).toBeUndefined();
  });

  test("a bucket with neither a percentage nor a usable ratio is dropped", async () => {
    const { context } = harness({
      routes: {
        [USAGE_URL]: () => json({
          copilot_plan: "pro",
          token_based_billing: false,
          quota_snapshots: { premium_interactions: { entitlement: 300 }, chat: "nonsense" },
        }),
      },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    await expect(copilotAdapter.fetchUsage(context)).rejects.toThrow(
      "Copilot usage data is unavailable for this account.",
    );
  });

  test("overage is only shown when the account may actually overspend", async () => {
    const { context } = harness({
      routes: {
        [USAGE_URL]: () => json({
          copilot_plan: "pro",
          quota_snapshots: {
            premium_interactions: {
              entitlement: 300,
              remaining: 300,
              percent_remaining: 100,
              overage_permitted: true,
              // No overage_count yet: a real zero, worth showing.
            },
          },
        }),
      },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    const result = await copilotAdapter.fetchUsage(context);

    expect(byKey(result.metrics, "extraUsage")).toMatchObject({ used: 0, unit: "count" });
    expect(byKey(result.metrics, "premiumCredits")).toMatchObject({ used: 0, utilization: 0 });
  });

  test("reads the gh CLI token when the editor never signed in", async () => {
    const hosts = [
      "ghe.corp.example:",
      "    oauth_token: ghe_should_never_leave_the_intranet",
      "    user: corp-user",
      "github.com:",
      "    oauth_token: gho_from_gh_cli",
      "    user: octocat",
      "    git_protocol: https",
      "",
    ].join("\n");
    const { context, calls } = harness({
      routes: { [USAGE_URL]: () => json(PAID_BODY) },
      files: { [GH_HOSTS_PATH]: hosts },
    });

    await copilotAdapter.fetchUsage(context);

    expect((calls[0]?.init?.headers as Record<string, string>).Authorization)
      .toBe("token gho_from_gh_cli");
  });

  test("an enterprise-only editor config is skipped so no GHE token reaches api.github.com", async () => {
    const { context, calls } = harness({
      routes: { [USAGE_URL]: () => json(PAID_BODY) },
      files: {
        [APPS_PATH]: JSON.stringify({ "ghe.corp.example:Iv1.x": { oauth_token: "ghe_secret" } }),
        [HOSTS_JSON_PATH]: JSON.stringify({ "github.com": { oauth_token: "gho_hosts_json" } }),
      },
    });

    await copilotAdapter.fetchUsage(context);

    expect((calls[0]?.init?.headers as Record<string, string>).Authorization)
      .toBe("token gho_hosts_json");
  });

  test("unwraps the go-keyring blob the gh CLI stores in the Keychain", async () => {
    const { context, calls } = harness({
      routes: { [USAGE_URL]: () => json(PAID_BODY) },
      files: { [GH_HOSTS_PATH]: "github.com:\n    user: octocat\n" },
      keychain: {
        "gh:github.com octocat": `go-keyring-base64:${Buffer.from("gho_keychain").toString("base64")}`,
      },
    });

    expect(await copilotAdapter.detect(context)).toBe(true);
    await copilotAdapter.fetchUsage(context);

    expect((calls[0]?.init?.headers as Record<string, string>).Authorization)
      .toBe("token gho_keychain");
  });

  test("no token anywhere is a state, not a failure", async () => {
    const { context } = harness({ routes: { [USAGE_URL]: () => json(PAID_BODY) } });

    expect(await copilotAdapter.detect(context)).toBe(false);
    await expect(copilotAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
  });

  test("401 means re-authenticate; there is nothing to refresh", async () => {
    const { context, calls } = harness({
      routes: { [USAGE_URL]: () => json({ message: "Bad credentials" }, 401) },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    await expect(copilotAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
    expect(calls.length).toBe(1);
  });

  test("429 carries the cooldown the server asked for", async () => {
    const { context } = harness({
      routes: { [USAGE_URL]: () => json({}, 429, { "retry-after": "60" }) },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    try {
      await copilotAdapter.fetchUsage(context);
      throw new Error("expected a rate-limit error");
    } catch (error) {
      expect(error).toBeInstanceOf(VibeRateLimitedError);
      expect((error as VibeRateLimitedError).retryAfterMs).toBe(60_000);
    }
  });

  test("a 500 is a request error carrying its status", async () => {
    const { context } = harness({
      routes: { [USAGE_URL]: () => json({}, 502) },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    try {
      await copilotAdapter.fetchUsage(context);
      throw new Error("expected a request error");
    } catch (error) {
      expect(error).toBeInstanceOf(VibeRequestError);
      expect((error as VibeRequestError).status).toBe(502);
    }
  });

  test("a body that is not a JSON object is a request error", async () => {
    const { context } = harness({
      routes: { [USAGE_URL]: () => new Response("<html>nope</html>", { status: 200 }) },
      files: { [APPS_PATH]: EDITOR_APPS },
    });

    await expect(copilotAdapter.fetchUsage(context)).rejects.toThrow("Copilot usage response invalid.");
  });
});
