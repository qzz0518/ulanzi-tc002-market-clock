import { describe, expect, test } from "bun:test";
import { opencodeAdapter } from "../src/vibe/providers/opencode.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type VibeAdapterContext,
} from "../src/vibe/providers/types.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_AUTH_PATH = "~/.local/share/opencode/auth.json";

const NOW = Date.parse("2026-07-06T12:00:00.000Z");

/** Spec §2.3 sample body; `status` is deliberately not read. */
const USAGE_BODY = {
  usage: {
    rolling: { status: "ok", percent: 12, resetsAt: "2026-07-12T13:30:00.662Z" },
    weekly: { status: "ok", percent: 8, resetsAt: "2026-07-13T00:00:00.662Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-08-04T11:18:32.662Z" },
  },
};

/** The real file: other providers' entries and non-object siblings must not matter. */
const AUTH_JSON = JSON.stringify({
  $schema: "https://opencode.ai/auth.json",
  openai: { type: "oauth", access: "x", refresh: "y" },
  "opencode-go": { type: "api", key: "sk-abc" },
  weird: ["a", "b"],
});

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
  route?: (url: string, init: RequestInit | undefined) => Handled;
}): { context: VibeAdapterContext; calls: Call[]; reads: string[] } {
  const calls: Call[] = [];
  const reads: string[] = [];
  const context: VibeAdapterContext = {
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (!options.route) throw new Error(`unexpected fetch ${url}`);
      return respond(options.route(url, init));
    },
    env: options.env ?? {},
    keychain: { async read() { return null; } },
    async writeTextFile() {},
    async readTextFile(path) {
      reads.push(path);
      if (options.unreadable?.includes(path)) throw new Error("EACCES");
      return options.files?.[path] ?? null;
    },
    async listDirectory() { return []; },
    apiKey: () => null,
    timeoutMs: 5_000,
  };
  return { context, calls, reads };
}

function header(init: RequestInit | undefined, name: string): unknown {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe("opencode adapter", () => {
  test("maps the three windows to the catalog's session/weekly/monthly metrics", async () => {
    const { context, calls } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({ body: USAGE_BODY }),
    });

    const result = await opencodeAdapter.fetchUsage(context);

    expect(result.plan).toBe("Go");
    expect(result.metrics).toEqual([
      {
        key: "session",
        label: "Session",
        kind: "consumption",
        unit: "percent",
        used: 12,
        limit: 100,
        remaining: 88,
        utilization: 0.12,
        resetsAt: "2026-07-12T13:30:00.662Z",
        windowSeconds: 18_000,
      },
      {
        key: "weekly",
        label: "Weekly",
        kind: "consumption",
        unit: "percent",
        used: 8,
        limit: 100,
        remaining: 92,
        utilization: 0.08,
        resetsAt: "2026-07-13T00:00:00.662Z",
        windowSeconds: 604_800,
      },
      {
        key: "monthly",
        label: "Monthly",
        kind: "consumption",
        unit: "percent",
        used: 100,
        limit: 100,
        remaining: 0,
        utilization: 1,
        resetsAt: "2026-08-04T11:18:32.662Z",
        windowSeconds: 2_592_000,
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(USAGE_URL);
    expect(header(calls[0]!.init, "Authorization")).toBe("Bearer sk-abc");
    expect(header(calls[0]!.init, "Accept")).toBe("application/json");
  });

  test("percent clamps at both ends and zero is a real meter", async () => {
    const { context } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({
        body: {
          usage: {
            rolling: { percent: 0 },
            weekly: { percent: 150 },
            monthly: { percent: -4 },
          },
        },
      }),
    });

    const result = await opencodeAdapter.fetchUsage(context);
    expect(result.metrics.map((metric) => metric.used)).toEqual([0, 100, 0]);
    expect(result.metrics.map((metric) => metric.utilization)).toEqual([0, 1, 0]);
    // No resetsAt in the payload means no countdown — the meter still renders.
    expect(result.metrics.every((metric) => metric.resetsAt === undefined)).toBe(true);
  });

  test("a numeric string percent is accepted; an unparseable one is not", async () => {
    const { context } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({
        body: { usage: { rolling: { percent: "12.5" }, weekly: { percent: 8 }, monthly: { percent: 3 } } },
      }),
    });
    expect((await opencodeAdapter.fetchUsage(context)).metrics[0]).toMatchObject({ used: 12.5, utilization: 0.125 });
  });

  test.each([
    ["no usage envelope", { data: {} }],
    ["only one window", { usage: { weekly: { percent: 1 } } }],
    ["a window that is not an object", { usage: { rolling: 12, weekly: { percent: 1 }, monthly: { percent: 1 } } }],
    ["a non-numeric percent", {
      usage: { rolling: { percent: "n/a" }, weekly: { percent: 1 }, monthly: { percent: 1 } },
    }],
    ["a boolean percent", {
      usage: { rolling: { percent: true }, weekly: { percent: 1 }, monthly: { percent: 1 } },
    }],
  ])("rejects a usage response that changed shape: %s", async (_name, body) => {
    const { context } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({ body }),
    });
    // Dropping to a partial answer would read as "quota freed up" on the panel.
    await expect(opencodeAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeRequestError);
  });

  test("an unparseable resetsAt drops the countdown, not the meter", async () => {
    const { context } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({
        body: {
          usage: {
            rolling: { percent: 12, resetsAt: "later today" },
            weekly: { percent: 8, resetsAt: "2026-07-13T00:00:00.662Z" },
            monthly: { percent: 3 },
          },
        },
      }),
    });

    const result = await opencodeAdapter.fetchUsage(context);
    expect(result.metrics[0]).toMatchObject({ key: "session", used: 12 });
    expect(result.metrics[0]?.resetsAt).toBeUndefined();
    expect(result.metrics[1]?.resetsAt).toBe("2026-07-13T00:00:00.662Z");
  });

  test("no auth.json is a missing credential and stays undetected", async () => {
    const { context, calls } = makeContext({ route: () => ({ body: USAGE_BODY }) });
    await expect(opencodeAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
    expect(await opencodeAdapter.detect(context)).toBe(false);
    expect(calls).toEqual([]);
  });

  test.each([
    ["no opencode-go entry", JSON.stringify({ openai: { type: "oauth", access: "x" } })],
    ["no key on the entry", JSON.stringify({ "opencode-go": { type: "api" } })],
    ["a blank key", JSON.stringify({ "opencode-go": { key: "   " } })],
    ["a non-string key", JSON.stringify({ "opencode-go": { key: 42 } })],
  ])("an auth.json without a Go key is a missing credential: %s", async (_name, contents) => {
    const { context } = makeContext({ files: { [DEFAULT_AUTH_PATH]: contents }, route: () => ({ body: USAGE_BODY }) });
    await expect(opencodeAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsMissingError);
    expect(await opencodeAdapter.detect(context)).toBe(false);
  });

  test.each([
    ["broken JSON", "{ not json"],
    ["a JSON array", "[]"],
  ])("a corrupt auth.json is broken storage, not a missing sign-in: %s", async (_name, contents) => {
    const { context } = makeContext({ files: { [DEFAULT_AUTH_PATH]: contents }, route: () => ({ body: USAGE_BODY }) });
    await expect(opencodeAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeRequestError);
    // Still a footprint, so the console shows the real "fix the file" message.
    expect(await opencodeAdapter.detect(context)).toBe(true);
  });

  test("an unreadable auth.json surfaces the permission problem", async () => {
    const { context } = makeContext({ unreadable: [DEFAULT_AUTH_PATH], route: () => ({ body: USAGE_BODY }) });
    const error = await opencodeAdapter.fetchUsage(context).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect((error as VibeRequestError).message).toContain("EACCES");
    expect(await opencodeAdapter.detect(context)).toBe(true);
  });

  test("OPENCODE_DATA_DIR wins, then XDG_DATA_HOME, then the default", async () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ OPENCODE_DATA_DIR: "~/custom/opencode//" }, "~/custom/opencode/auth.json"],
      [{ XDG_DATA_HOME: "/data/share/" }, "/data/share/opencode/auth.json"],
      [{ OPENCODE_DATA_DIR: "/override", XDG_DATA_HOME: "/data/share" }, "/override/auth.json"],
      [{}, DEFAULT_AUTH_PATH],
      // A blank override is not a path; fall through as if it were unset.
      [{ OPENCODE_DATA_DIR: "  " }, DEFAULT_AUTH_PATH],
    ];
    for (const [env, expected] of cases) {
      const { context, reads } = makeContext({ env, route: () => ({ body: USAGE_BODY }) });
      await opencodeAdapter.detect(context);
      expect(reads).toEqual([expected]);
    }
  });

  test("a 401 means the key was rejected", async () => {
    const { context } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({ status: 401, body: { type: "error", error: { type: "AuthError", message: "nope" } } }),
    });
    // There is nothing to refresh, so this is terminal until the user logs in.
    await expect(opencodeAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("a 403 EntitlementError is 'no subscription', not 'signed out'", async () => {
    const { context } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({
        status: 403,
        body: {
          type: "error",
          error: { type: "EntitlementError", message: "OpenCode Go subscription required." },
        },
      }),
    });
    const error = await opencodeAdapter.fetchUsage(context).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect(error).not.toBeInstanceOf(VibeCredentialsExpiredError);
    expect((error as VibeRequestError).status).toBe(403);
    expect((error as VibeRequestError).message).toContain("subscription");
  });

  test("a 403 with any other body is a rejected credential", async () => {
    const { context } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({ status: 403, text: "<html>blocked</html>" }),
    });
    await expect(opencodeAdapter.fetchUsage(context)).rejects.toBeInstanceOf(VibeCredentialsExpiredError);
  });

  test("a 429 surfaces as a rate limit with its cooldown", async () => {
    const { context } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({ status: 429, headers: { "retry-after": "30" } }),
    });
    const error = await opencodeAdapter.fetchUsage(context).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VibeRateLimitedError);
    expect((error as VibeRateLimitedError).retryAfterMs).toBe(30_000);
  });

  test("a 500 is a request error carrying its status", async () => {
    const { context } = makeContext({
      files: { [DEFAULT_AUTH_PATH]: AUTH_JSON },
      route: () => ({ status: 500 }),
    });
    const error = await opencodeAdapter.fetchUsage(context).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VibeRequestError);
    expect((error as VibeRequestError).status).toBe(500);
  });

  test("detect reads the key without touching the network", async () => {
    const { context, calls } = makeContext({ files: { [DEFAULT_AUTH_PATH]: AUTH_JSON } });
    expect(await opencodeAdapter.detect(context)).toBe(true);
    expect(calls).toEqual([]);
  });
});
