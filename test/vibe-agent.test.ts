import { describe, expect, test } from "bun:test";
import {
  buildEnvelope,
  collectRound,
  parseAgentArgs,
  pushEnvelope,
  VibeAgentUsageError,
  type VibeAgentOptions,
} from "../src/vibe-agent.ts";
import { VIBE_INGEST_SCHEMA } from "../src/vibe/ingest-schema.ts";
import { VibeIngestStore } from "../src/vibe/ingest-store.ts";
import { VibeUsageService } from "../src/vibe/usage-service.ts";
import {
  VibeCredentialsExpiredError,
  type VibeProviderAdapter,
} from "../src/vibe/providers/types.ts";

const PUSH_URL = "http://127.0.0.1:43820/v1/push";
const T0 = Date.parse("2026-08-16T09:00:00.000Z");

function options(overrides: Partial<VibeAgentOptions> = {}): VibeAgentOptions {
  return { url: PUSH_URL, token: "secret", machine: "laptop", intervalMs: 60_000, once: false, ...overrides };
}

describe("parseAgentArgs", () => {
  test("reads the flags it is given", () => {
    const parsed = parseAgentArgs(
      ["--url", PUSH_URL, "--token", "abc", "--machine", "work-laptop", "--interval", "120", "--once"],
      {},
    );
    expect(parsed).toEqual({
      url: PUSH_URL,
      token: "abc",
      machine: "work-laptop",
      intervalMs: 120_000,
      once: true,
    });
  });

  test("falls back to the environment", () => {
    const parsed = parseAgentArgs([], {
      VIBE_PUSH_URL: PUSH_URL,
      VIBE_INGEST_TOKEN: "from-env",
      VIBE_MACHINE: "server",
      VIBE_PUSH_INTERVAL: "30",
    });
    expect(parsed).toMatchObject({ token: "from-env", machine: "server", intervalMs: 30_000 });
  });

  test("a flag beats the environment", () => {
    const parsed = parseAgentArgs(["--machine", "explicit"], {
      VIBE_PUSH_URL: PUSH_URL,
      VIBE_MACHINE: "from-env",
    });
    expect(parsed).toMatchObject({ machine: "explicit" });
  });

  test("--help short-circuits everything, including a missing url", () => {
    expect(parseAgentArgs(["--help"], {})).toBe("help");
    expect(parseAgentArgs(["-h"], {})).toBe("help");
  });

  // Falling through to the environment when a flag's value is missing is how an
  // operator ends up pushing to the wrong host with no error anywhere.
  test("a flag with no value fails rather than falling through", () => {
    expect(() => parseAgentArgs(["--url", "--once"], { VIBE_PUSH_URL: PUSH_URL }))
      .toThrow(VibeAgentUsageError);
  });

  test.each([
    ["no url at all", [] as string[], {}],
    ["a url that is not a url", ["--url", "not a url"], {}],
    ["a non-http scheme", ["--url", "ftp://host/v1/push"], {}],
    ["an unknown flag", ["--url", PUSH_URL, "--verbose"], {}],
    ["a fractional interval", ["--url", PUSH_URL, "--interval", "1.5"], {}],
    ["an interval below the floor", ["--url", PUSH_URL, "--interval", "5"], {}],
    ["an interval above the ceiling", ["--url", PUSH_URL, "--interval", "7200"], {}],
    ["a machine name the store would reject", ["--url", PUSH_URL, "--machine", "work/laptop"], {}],
  ])("rejects %s", (_label, argv, env) => {
    expect(() => parseAgentArgs(argv as string[], env)).toThrow(VibeAgentUsageError);
  });

  test("a token is optional — the service decides whether it needs one", () => {
    const parsed = parseAgentArgs(["--url", PUSH_URL], {});
    expect(parsed).not.toBe("help");
    expect((parsed as VibeAgentOptions).token).toBeUndefined();
  });
});

describe("buildEnvelope", () => {
  test("names the schema and uses the wire's snake_case timestamp", () => {
    const built = buildEnvelope("laptop", { providers: [], errors: [] }, T0);
    expect(built).toEqual({
      schema: VIBE_INGEST_SCHEMA,
      machine: "laptop",
      sent_at: "2026-08-16T09:00:00.000Z",
      snapshots: [],
      errors: [],
    });
  });

  // The whole point of the pairing: whatever the agent builds, the store takes.
  test("what the agent builds is what the store accepts", () => {
    const envelope = buildEnvelope("laptop", { providers: [{
      id: "claude",
      displayName: "Claude",
      plan: "Max 20x",
      fetchedAt: new Date(T0).toISOString(),
      stale: false,
      metrics: [{ key: "session", label: "Session", kind: "consumption", unit: "percent", utilization: 0.42 }],
      spendLines: [{ label: "Today", value: "$1.20" }],
    }], errors: [] }, T0);

    const store = new VibeIngestStore(() => T0);
    // Through JSON, because that is the only way it ever arrives.
    store.accept(JSON.parse(JSON.stringify(envelope)));
    expect(store.collect()[0]!.metrics[0]!.utilization).toBe(0.42);
  });
});

describe("collectRound", () => {
  function adapter(id: string, signedIn: boolean): VibeProviderAdapter {
    return {
      id,
      displayName: id,
      detect: async () => signedIn,
      fetchUsage: async () => ({
        metrics: [{ key: "session", label: "Session", kind: "consumption", unit: "percent", utilization: 0.5 }],
      }),
    };
  }

  test("returns whatever is signed in", async () => {
    const service = new VibeUsageService({ adapters: [adapter("claude", true)], now: () => T0 });
    const round = await collectRound(service);
    expect(round.providers.map((usage: { id: string }) => usage.id)).toEqual(["claude"]);
  });

  // Otherwise a vendor that failed over here just vanishes from the panel over
  // there, with no reason attached — the one failure nobody is watching.
  test("a vendor's failure travels with the round", async () => {
    const service = new VibeUsageService({
      adapters: [{
        id: "claude",
        displayName: "claude",
        detect: async () => true,
        fetchUsage: async () => { throw new VibeCredentialsExpiredError("claude", "sign-in rejected (HTTP 401)"); },
      }],
      now: () => T0,
    });

    const round = await collectRound(service);
    expect(round.providers).toEqual([]);
    expect(round.errors).toEqual([{ providerId: "claude", message: "sign-in rejected (HTTP 401)" }]);
  });

  // Pushing an empty array is how a machine that got logged out stops showing
  // its old rows; treating it as a failure would serve them until they expire.
  test("nothing signed in becomes an empty push, not an error", async () => {
    const service = new VibeUsageService({ adapters: [adapter("claude", false)], now: () => T0 });
    expect(await collectRound(service)).toEqual({ providers: [], errors: [] });
  });
});

describe("pushEnvelope", () => {
  test("posts JSON with the bearer token", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await pushEnvelope(options(), { schema: VIBE_INGEST_SCHEMA }, fetcher);

    expect(seen[0]!.url).toBe(PUSH_URL);
    expect(seen[0]!.init.method).toBe("POST");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("sends no Authorization header when there is no token", async () => {
    let headers: Record<string, string> = {};
    const fetcher = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await pushEnvelope({ ...options(), token: undefined }, {}, fetcher);
    expect(headers.Authorization).toBeUndefined();
  });

  test("a rejection carries the service's own message back to the log", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: "usage ingest token is invalid" }), { status: 401 })
    ) as unknown as typeof fetch;

    await expect(pushEnvelope(options(), {}, fetcher))
      .rejects.toThrow(/HTTP 401.*usage ingest token is invalid/);
  });
});
