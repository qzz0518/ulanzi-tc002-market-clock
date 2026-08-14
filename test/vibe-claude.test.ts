import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { claudeAdapter } from "../src/vibe/providers/claude.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type FetchLike,
  type VibeAdapterContext,
} from "../src/vibe/providers/types.ts";

const NOW = Date.parse("2026-08-14T09:00:00.000Z");
const CREDENTIALS_PATH = "~/.claude/.credentials.json";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_URL = "https://platform.claude.com/v1/oauth/token";

/** Verbatim from the reverse-engineering report's sample `/api/oauth/usage` body. */
const USAGE_BODY = {
  five_hour: { utilization: 10, resets_at: "2026-08-14T12:30:00.000Z" },
  seven_day: { utilization: 20, resets_at: "2026-08-18T00:00:00.000Z" },
  seven_day_sonnet: { utilization: 5, resets_at: "2026-08-18T00:00:00.000Z" },
  limits: [
    { kind: "session", group: "session", percent: 10, resets_at: "2026-08-14T12:30:00.000Z" },
    { kind: "weekly_all", group: "weekly", percent: 20, resets_at: "2026-08-18T00:00:00.000Z" },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 7,
      resets_at: "2026-08-17T10:59:59.714Z",
      scope: { model: { display_name: "Fable", id: null }, surface: null },
    },
  ],
  // Cents, both of them.
  extra_usage: { is_enabled: true, used_credits: 500, monthly_limit: 1000 },
};

function credentialBlob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      expiresAt: NOW + 3_600_000,
      subscriptionType: "max",
      rateLimitTier: "tier_20x",
      scopes: ["user:profile", "user:inference"],
      ...overrides,
    },
  });
}

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
  keychainWrites: { service: string; value: string }[];
  fileWrites: { path: string; content: string }[];
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

  const keychainWrites: { service: string; value: string }[] = [];
  const fileWrites: { path: string; content: string }[] = [];

  return {
    calls,
    keychainReads,
    keychainWrites,
    fileWrites,
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

describe("claude adapter — credentials", () => {
  test("detects a credentials file and reports no login when nothing is stored", async () => {
    const stored = makeContext({ files: { [CREDENTIALS_PATH]: credentialBlob() } });
    expect(await claudeAdapter.detect(stored.context)).toBe(true);

    const empty = makeContext();
    expect(await claudeAdapter.detect(empty.context)).toBe(false);
    await expect(claudeAdapter.fetchUsage(empty.context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
    expect(empty.calls).toHaveLength(0);
  });

  test("the keychain item wins over the file copy", async () => {
    const harness = makeContext({
      keychain: { [KEYCHAIN_SERVICE]: credentialBlob({ accessToken: "from-keychain" }) },
      files: { [CREDENTIALS_PATH]: credentialBlob({ accessToken: "from-file" }) },
      responses: usageOnly(USAGE_BODY),
    });
    await claudeAdapter.fetchUsage(harness.context);
    expect(harness.calls[0]?.headers.Authorization).toBe("Bearer from-keychain");
  });

  test("CLAUDE_CONFIG_DIR adds the hashed keychain item ahead of the plain one", async () => {
    const configDir = "/Users/tester/work/.claude";
    const hash = createHash("sha256").update(configDir.normalize("NFC"), "utf8").digest("hex").slice(0, 8);
    const harness = makeContext({
      env: { CLAUDE_CONFIG_DIR: configDir },
      files: { [`${configDir}/.credentials.json`]: credentialBlob() },
      responses: usageOnly(USAGE_BODY),
    });
    await claudeAdapter.fetchUsage(harness.context);
    expect(harness.keychainReads).toEqual([`${KEYCHAIN_SERVICE}-${hash}`, KEYCHAIN_SERVICE]);
  });

  test("a hex-encoded credentials file is decoded like plain JSON", async () => {
    const hex = Buffer.from(credentialBlob(), "utf8").toString("hex");
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: hex },
      responses: usageOnly(USAGE_BODY),
    });
    const result = await claudeAdapter.fetchUsage(harness.context);
    expect(result.plan).toBe("Max 20x");
  });

  test("a credential without user:profile reports a note instead of calling the endpoint", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob({ scopes: ["user:inference"] }) },
    });
    const result = await claudeAdapter.fetchUsage(harness.context);
    expect(result.metrics).toEqual([]);
    expect(result.plan).toBe("Max 20x");
    expect(result.note).toContain("重新登录");
    expect(harness.calls).toHaveLength(0);
  });

  test("a credential written before scopes existed is still treated as live-capable", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob({ scopes: [] }) },
      responses: usageOnly(USAGE_BODY),
    });
    const result = await claudeAdapter.fetchUsage(harness.context);
    expect(result.metrics.map((metric) => metric.key)).toContain("session");
  });

  test("a setup token from the environment is a login, but not a live-usage one", async () => {
    const harness = makeContext({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-setup" } });
    expect(await claudeAdapter.detect(harness.context)).toBe(true);
    const result = await claudeAdapter.fetchUsage(harness.context);
    expect(result.metrics).toEqual([]);
    expect(result.note).toContain("setup token");
    expect(harness.calls).toHaveLength(0);
  });
});

describe("claude adapter — metric mapping", () => {
  test("maps every window, the Fable row and extra usage", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: usageOnly(USAGE_BODY),
    });
    const result = await claudeAdapter.fetchUsage(harness.context);

    expect(harness.calls[0]?.url).toBe(USAGE_URL);
    expect(harness.calls[0]?.headers).toMatchObject({
      Authorization: "Bearer access-token-1",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.69",
    });
    expect(result.plan).toBe("Max 20x");
    expect(result.metrics.map((metric) => metric.key)).toEqual([
      "session",
      "weekly",
      "sonnet",
      "fable",
      "extraUsage",
    ]);

    expect(result.metrics[0]).toEqual({
      key: "session",
      label: "Session",
      kind: "consumption",
      unit: "percent",
      used: 10,
      limit: 100,
      remaining: 90,
      utilization: 0.1,
      resetsAt: "2026-08-14T12:30:00.000Z",
      windowSeconds: 18_000,
    });
    expect(result.metrics[1]).toMatchObject({
      key: "weekly",
      label: "Weekly",
      used: 20,
      utilization: 0.2,
      windowSeconds: 604_800,
      resetsAt: "2026-08-18T00:00:00.000Z",
    });
    expect(result.metrics[2]).toMatchObject({ key: "sonnet", label: "Sonnet", used: 5, utilization: 0.05 });
    expect(result.metrics[3]).toMatchObject({
      key: "fable",
      label: "Fable",
      used: 7,
      limit: 100,
      utilization: 0.07,
      resetsAt: "2026-08-17T10:59:59.714Z",
      windowSeconds: 604_800,
    });
    // Cents become dollars, and only the pair used/limit makes a bounded row.
    expect(result.metrics[4]).toMatchObject({
      key: "extraUsage",
      label: "Extra Usage",
      kind: "consumption",
      unit: "usd",
      used: 5,
      limit: 10,
      remaining: 5,
      utilization: 0.5,
    });
  });

  test("an epoch-number reset stamp is accepted alongside the ISO form", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: usageOnly({ five_hour: { utilization: 42, resets_at: 1_786_000_000 } }),
    });
    const result = await claudeAdapter.fetchUsage(harness.context);
    expect(result.metrics[0]?.resetsAt).toBe(new Date(1_786_000_000_000).toISOString());
  });

  test("missing and malformed windows are dropped, never zeroed", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: usageOnly({
        five_hour: { resets_at: "2026-08-14T12:30:00.000Z" }, // no utilization at all
        seven_day: { utilization: 20 }, // no reset stamp
        seven_day_sonnet: null,
        limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } } }], // no percent
        extra_usage: { is_enabled: false, used_credits: 900, monthly_limit: 1000 },
      }),
    });
    const result = await claudeAdapter.fetchUsage(harness.context);
    expect(result.metrics.map((metric) => metric.key)).toEqual(["weekly"]);
    expect(result.metrics[0]?.resetsAt).toBeUndefined();
  });

  test("extra usage without a cap is unbounded, and silent when nothing was spent", async () => {
    const uncapped = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: usageOnly({ extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 0 } }),
    });
    const result = await claudeAdapter.fetchUsage(uncapped.context);
    expect(result.metrics[0]).toMatchObject({ key: "extraUsage", used: 2.5 });
    expect(result.metrics[0]?.limit).toBeUndefined();
    expect(result.metrics[0]?.utilization).toBeUndefined();

    const idle = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: usageOnly({ extra_usage: { is_enabled: true, used_credits: 0 } }),
    });
    expect((await claudeAdapter.fetchUsage(idle.context)).metrics).toEqual([]);
  });

  test("plan strings follow the credential blob, not the response", async () => {
    const plan = async (overrides: Record<string, unknown>) => {
      const harness = makeContext({
        files: { [CREDENTIALS_PATH]: credentialBlob(overrides) },
        responses: usageOnly(USAGE_BODY),
      });
      return (await claudeAdapter.fetchUsage(harness.context)).plan;
    };
    expect(await plan({ subscriptionType: "max", rateLimitTier: "tier_20x" })).toBe("Max 20x");
    expect(await plan({ subscriptionType: "max", rateLimitTier: "default_claude_5x" })).toBe("Max 5x");
    expect(await plan({ subscriptionType: "pro", rateLimitTier: undefined })).toBe("Pro");
    expect(await plan({ subscriptionType: "pro", rateLimitTier: "standard" })).toBe("Pro");
    expect(await plan({ subscriptionType: "TEAM PLAN", rateLimitTier: undefined })).toBe("Team Plan");
    expect(await plan({ subscriptionType: undefined })).toBeUndefined();
  });
});

describe("claude adapter — errors and refresh", () => {
  test("a 401 refreshes once and retries with the new token", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: {
        [USAGE_URL]: [{ status: 401, body: { error: "unauthorized" } }, { body: USAGE_BODY }],
        [REFRESH_URL]: [{ body: { access_token: "access-token-2", refresh_token: "refresh-token-2", expires_in: 3600 } }],
      },
    });
    const result = await claudeAdapter.fetchUsage(harness.context);
    expect(result.metrics).toHaveLength(5);

    const refreshCall = harness.calls.find((call) => call.url === REFRESH_URL);
    expect(refreshCall?.method).toBe("POST");
    expect(JSON.parse(refreshCall?.body ?? "{}")).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-token-1",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    });
    expect(harness.calls.at(-1)?.headers.Authorization).toBe("Bearer access-token-2");
  });

  test("an access token inside the five-minute window is refreshed before the call", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob({ expiresAt: NOW + 60_000 }) },
      responses: {
        [USAGE_URL]: [{ body: USAGE_BODY }],
        [REFRESH_URL]: [{ body: { access_token: "access-token-fresh", expires_in: 3600 } }],
      },
    });
    await claudeAdapter.fetchUsage(harness.context);
    expect(harness.calls[0]?.url).toBe(REFRESH_URL);
    expect(harness.calls[1]?.headers.Authorization).toBe("Bearer access-token-fresh");
  });

  test("invalid_grant on refresh is an expired sign-in", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob({ expiresAt: NOW + 1_000 }) },
      responses: { [REFRESH_URL]: [{ status: 400, body: { error: "invalid_grant" } }] },
    });
    await expect(claudeAdapter.fetchUsage(harness.context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("an unrecognised 400 from the token endpoint stays a request failure", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob({ expiresAt: NOW + 1_000 }) },
      responses: { [REFRESH_URL]: [{ status: 400, body: { error: "bad_gateway_html" } }] },
    });
    await expect(claudeAdapter.fetchUsage(harness.context)).rejects.toBeInstanceOf(VibeRequestError);
  });

  test("a second 401 after refreshing gives up", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: {
        [USAGE_URL]: [{ status: 401 }],
        [REFRESH_URL]: [{ body: { access_token: "access-token-2" } }],
      },
    });
    await expect(claudeAdapter.fetchUsage(harness.context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("a 401 with no refresh token cannot be retried", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob({ refreshToken: undefined }) },
      responses: { [USAGE_URL]: [{ status: 401 }] },
    });
    await expect(claudeAdapter.fetchUsage(harness.context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
    expect(harness.calls).toHaveLength(1);
  });

  test("a 429 carries Retry-After, and falls back to the five-minute cooldown", async () => {
    const withHeader = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: { [USAGE_URL]: [{ status: 429, headers: { "retry-after": "90" } }] },
    });
    await expect(claudeAdapter.fetchUsage(withHeader.context)).rejects.toMatchObject({
      name: "VibeRateLimitedError",
      retryAfterMs: 90_000,
    });

    const bare = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: { [USAGE_URL]: [{ status: 429 }] },
    });
    const error = await claudeAdapter.fetchUsage(bare.context).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(VibeRateLimitedError);
    expect((error as VibeRateLimitedError).retryAfterMs).toBe(300_000);
  });

  test("a 500 is a request failure carrying the status", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob() },
      responses: { [USAGE_URL]: [{ status: 500 }] },
    });
    const error = await claudeAdapter.fetchUsage(harness.context).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect((error as VibeRequestError).status).toBe(500);
  });

  test("an expired keychain login falls through to the file login", async () => {
    const harness = makeContext({
      keychain: { [KEYCHAIN_SERVICE]: credentialBlob({ accessToken: "stale", refreshToken: undefined }) },
      files: { [CREDENTIALS_PATH]: credentialBlob({ accessToken: "fresh", refreshToken: undefined }) },
      responses: { [USAGE_URL]: [{ status: 401 }, { body: USAGE_BODY }] },
    });
    const result = await claudeAdapter.fetchUsage(harness.context);
    expect(result.metrics).toHaveLength(5);
    expect(harness.calls.map((call) => call.headers.Authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
  });
});

describe("claude adapter — rotated credentials go back to the CLI", () => {
  // Anthropic retires the old refresh token on every exchange, so a refresh we
  // perform and keep to ourselves would sign the user out of Claude Code.
  const EXPIRING = credentialBlob({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: NOW + 60_000,
  });

  function refreshThenUsage() {
    return {
      [REFRESH_URL]: [{
        body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3_600 },
      }],
      [USAGE_URL]: [{ body: USAGE_BODY }],
    };
  }

  test("a keychain login is never refreshed, because we cannot hand the rotation back", async () => {
    // `security` cannot write a blob this long without truncating it, so the
    // only safe move is to leave the CLI's own refresh token alone and let the
    // panel say the sign-in expired.
    const harness = makeContext({
      keychain: { [KEYCHAIN_SERVICE]: EXPIRING },
      responses: { [USAGE_URL]: [{ status: 401 }] },
    });
    await expect(claudeAdapter.fetchUsage(harness.context)).rejects.toThrow();
    // No refresh was attempted at all: the CLI still holds a token that works.
    expect(harness.calls.some((call) => call.url === REFRESH_URL)).toBe(false);
    expect(harness.fileWrites).toHaveLength(0);
  });

  test("a file login is rewritten, and the keychain is left alone", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: EXPIRING },
      responses: refreshThenUsage(),
    });
    await claudeAdapter.fetchUsage(harness.context);

    expect(harness.fileWrites).toHaveLength(1);
    expect(harness.fileWrites[0]!.path).toBe(CREDENTIALS_PATH);
    expect(JSON.parse(harness.fileWrites[0]!.content).claudeAiOauth.accessToken).toBe("new-access");
    expect(harness.keychainWrites).toHaveLength(0);
  });

  test("a token with life left is never rotated, so nothing is written", async () => {
    const harness = makeContext({
      keychain: { [KEYCHAIN_SERVICE]: credentialBlob({ expiresAt: NOW + 6 * 3_600_000 }) },
      responses: usageOnly(USAGE_BODY),
    });
    await claudeAdapter.fetchUsage(harness.context);
    expect(harness.keychainWrites).toHaveLength(0);
    expect(harness.fileWrites).toHaveLength(0);
  });
});

describe("claude adapter — the write-back never eats what it does not model", () => {
  // A real credential carries more than this adapter reads: `mcpOAuth` holds the
  // tokens for the user's MCP servers, and `refreshTokenExpiresAt` sits beside
  // the fields we do read. Rebuilding the blob from our own model would delete
  // them and quietly break the user's MCP logins.
  const RICH = JSON.stringify({
    claudeAiOauth: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: NOW + 60_000,
      refreshTokenExpiresAt: NOW + 30 * 86_400_000,
      scopes: ["user:profile", "user:inference"],
      subscriptionType: "max",
      rateLimitTier: "tier_20x",
    },
    mcpOAuth: { "server-a": { accessToken: "mcp-token", expiresAt: 123 } },
    someFutureKey: { nested: true },
  });

  test("only the rotated fields change; every other key survives byte for byte", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: RICH },
      responses: {
        [REFRESH_URL]: [{ body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3_600 } }],
        [USAGE_URL]: [{ body: USAGE_BODY }],
      },
    });
    await claudeAdapter.fetchUsage(harness.context);

    const blob = JSON.parse(harness.fileWrites[0]!.content) as Record<string, any>;
    expect(blob.claudeAiOauth.accessToken).toBe("new-access");
    expect(blob.claudeAiOauth.refreshToken).toBe("new-refresh");
    expect(blob.claudeAiOauth.expiresAt).toBe(NOW + 3_600_000);
    // Untouched, including the ones this file has never heard of.
    expect(blob.claudeAiOauth.refreshTokenExpiresAt).toBe(NOW + 30 * 86_400_000);
    expect(blob.mcpOAuth).toEqual({ "server-a": { accessToken: "mcp-token", expiresAt: 123 } });
    expect(blob.someFutureKey).toEqual({ nested: true });
  });

  test("a source that stops parsing is left alone rather than overwritten", async () => {
    const harness = makeContext({
      files: { [CREDENTIALS_PATH]: credentialBlob({ expiresAt: NOW + 60_000 }) },
      responses: {
        [REFRESH_URL]: [{ body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3_600 } }],
        [USAGE_URL]: [{ body: USAGE_BODY }],
      },
    });
    // Whatever owns the file between our read and our write-back, our shape is
    // not what belongs there.
    let reads = 0;
    const original = harness.context.readTextFile;
    harness.context.readTextFile = async (path: string) => {
      reads += 1;
      return reads === 1 ? await original(path) : "not json at all";
    };
    await claudeAdapter.fetchUsage(harness.context);
    expect(harness.fileWrites).toHaveLength(0);
  });
});
