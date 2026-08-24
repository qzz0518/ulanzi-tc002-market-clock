import { describe, expect, test } from "bun:test";
import { VibeIngestError, VibeIngestStore } from "../src/vibe/ingest-store.ts";
import { VIBE_INGEST_SCHEMA } from "../src/vibe/ingest-schema.ts";
import { VibeUsageService, type VibeProviderUsage } from "../src/vibe/usage-service.ts";
import type { VibeProviderAdapter } from "../src/vibe/providers/types.ts";

const T0 = Date.parse("2026-08-16T09:00:00.000Z");

function provider(overrides: Partial<VibeProviderUsage> = {}): Record<string, unknown> {
  return {
    id: "claude",
    displayName: "Claude",
    plan: "Max 20x",
    fetchedAt: "2026-08-16T08:59:50.000Z",
    stale: false,
    metrics: [{
      key: "session",
      label: "Session",
      kind: "consumption",
      unit: "percent",
      used: 42,
      limit: 100,
      remaining: 58,
      utilization: 0.42,
      resetsAt: "2026-08-16T14:00:00.000Z",
      windowSeconds: 18000,
    }],
    spendLines: [{ label: "Today", value: "$1.20" }],
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: VIBE_INGEST_SCHEMA,
    machine: "work-laptop",
    sent_at: "2026-08-16T09:00:00.000Z",
    snapshots: [provider()],
    ...overrides,
  };
}

describe("VibeIngestStore validation", () => {
  test("accepts a well-formed envelope and hands the providers back", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope());

    const collected = store.collect();
    expect(collected).toHaveLength(1);
    expect(collected[0]!.id).toBe("claude");
    expect(collected[0]!.plan).toBe("Max 20x");
    expect(collected[0]!.metrics[0]!.utilization).toBe(0.42);
    expect(collected[0]!.spendLines).toEqual([{ label: "Today", value: "$1.20" }]);
  });

  test("rejects a schema it does not know", () => {
    const store = new VibeIngestStore(() => T0);
    expect(() => store.accept(envelope({ schema: "openusage.limits.v1" })))
      .toThrow(VibeIngestError);
  });

  test.each([
    ["a machine name with illegal characters", { machine: "work/laptop" }],
    ["an empty machine name", { machine: "" }],
    ["a missing timestamp", { sent_at: undefined }],
    ["an unparseable timestamp", { sent_at: "yesterday" }],
    ["snapshots that are not an array", { snapshots: { claude: {} } }],
  ])("rejects %s", (_label, patch) => {
    const store = new VibeIngestStore(() => T0);
    expect(() => store.accept(envelope(patch))).toThrow(VibeIngestError);
  });

  test("rejects the same provider twice in one push", () => {
    const store = new VibeIngestStore(() => T0);
    expect(() => store.accept(envelope({ snapshots: [provider(), provider()] })))
      .toThrow(/duplicate provider/);
  });

  test("rejects a metric whose kind is not one of the two", () => {
    const store = new VibeIngestStore(() => T0);
    const broken = provider({
      metrics: [{ key: "session", label: "Session", kind: "guess", unit: "percent" }],
    } as unknown as Partial<VibeProviderUsage>);
    expect(() => store.accept(envelope({ snapshots: [broken] }))).toThrow(/kind must be/);
  });

  // The panel draws a bar from these numbers, so a value it cannot read has to
  // vanish rather than become 0 — a zero here reads as "quota exhausted".
  test("drops an unreadable number instead of defaulting it", () => {
    const store = new VibeIngestStore(() => T0);
    const patched = provider({
      metrics: [{
        key: "session",
        label: "Session",
        kind: "consumption",
        unit: "percent",
        used: "42",
        limit: 100,
        utilization: Number.NaN,
      }],
    } as unknown as Partial<VibeProviderUsage>);
    store.accept(envelope({ snapshots: [patched] }));

    const metric = store.collect()[0]!.metrics[0]!;
    expect(metric.used).toBeUndefined();
    expect(metric.utilization).toBeUndefined();
    expect(metric.limit).toBe(100);
  });

  test("drops a utilization outside 0–1 rather than draw a bar 100x too long", () => {
    const store = new VibeIngestStore(() => T0);
    const patched = provider({
      metrics: [{ key: "session", label: "S", kind: "consumption", unit: "percent", utilization: 42 }],
    } as unknown as Partial<VibeProviderUsage>);
    store.accept(envelope({ snapshots: [patched] }));
    expect(store.collect()[0]!.metrics[0]!.utilization).toBeUndefined();
  });

  test("caps how many machines may push", () => {
    const store = new VibeIngestStore(() => T0);
    for (let index = 0; index < 8; index += 1) {
      store.accept(envelope({ machine: `host-${index}` }));
    }
    expect(() => store.accept(envelope({ machine: "host-8" }))).toThrow(/at most 8 machines/);
    // An existing machine may still refresh once the table is full.
    expect(() => store.accept(envelope({ machine: "host-0" }))).not.toThrow();
  });
});

describe("VibeIngestStore ageing", () => {
  test("flags a machine stale after five minutes and drops it after fifteen", () => {
    let now = T0;
    const store = new VibeIngestStore(() => now);
    store.accept(envelope());
    expect(store.collect()[0]!.stale).toBe(false);

    now = T0 + 5 * 60_000;
    expect(store.collect()[0]!.stale).toBe(true);
    expect(store.listMachines()[0]!.stale).toBe(true);

    now = T0 + 15 * 60_000;
    expect(store.collect()).toEqual([]);
    expect(store.listMachines()).toEqual([]);
  });

  test("a fresh push clears the stale flag", () => {
    let now = T0;
    const store = new VibeIngestStore(() => now);
    store.accept(envelope());
    now = T0 + 6 * 60_000;
    expect(store.collect()[0]!.stale).toBe(true);

    store.accept(envelope({ sent_at: "2026-08-16T09:06:00.000Z" }));
    expect(store.collect()[0]!.stale).toBe(false);
  });

  test("an agent's own stale flag survives the trip", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ snapshots: [provider({ stale: true })] }));
    expect(store.collect()[0]!.stale).toBe(true);
  });
});

describe("VibeIngestStore with several machines", () => {
  test("the newest push takes the row and says whose it is", () => {
    let now = T0;
    const store = new VibeIngestStore(() => now);
    store.accept(envelope({ machine: "desktop", snapshots: [provider({ plan: "Pro" })] }));
    now = T0 + 1000;
    store.accept(envelope({ machine: "laptop", snapshots: [provider({ plan: "Max 20x" })] }));

    const collected = store.collect();
    expect(collected).toHaveLength(1);
    expect(collected[0]!.plan).toBe("Max 20x");
    expect(collected[0]!.source).toEqual({ kind: "remote", machine: "laptop" });
  });

  // The machine belongs in `source`, not appended to `note`: `note` is the
  // vendor's own message and merging the two made a sentence neither wrote.
  test("a vendor note survives untouched beside the source", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({
      machine: "laptop",
      snapshots: [provider({ note: "重新登录以恢复实时额度" })],
    }));
    const usage = store.collect()[0]!;
    expect(usage.note).toBe("重新登录以恢复实时额度");
    expect(usage.source).toEqual({ kind: "remote", machine: "laptop" });
  });

  test("even a single machine names itself, so the console can label the row", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ machine: "laptop" }));
    expect(store.collect()[0]!.source).toEqual({ kind: "remote", machine: "laptop" });
  });

  // Otherwise a pushed row could claim to have been read locally, and the
  // console's «do I need remote collection?» answer would be a lie.
  test("a push cannot claim to be a local read", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({
      machine: "laptop",
      snapshots: [{ ...provider(), source: { kind: "local" } }],
    }));
    expect(store.collect()[0]!.source).toEqual({ kind: "remote", machine: "laptop" });
  });

  test("different vendors from different machines all show", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ machine: "desktop", snapshots: [provider({ id: "claude" })] }));
    store.accept(envelope({ machine: "laptop", snapshots: [provider({ id: "codex" })] }));
    expect(store.collect().map((usage) => usage.id).sort()).toEqual(["claude", "codex"]);
  });

  test("listMachines reports newest first with the vendors each carries", () => {
    let now = T0;
    const store = new VibeIngestStore(() => now);
    store.accept(envelope({ machine: "desktop" }));
    now = T0 + 1000;
    store.accept(envelope({ machine: "laptop", snapshots: [provider({ id: "codex" })] }));

    const machines = store.listMachines();
    expect(machines.map((entry) => entry.machine)).toEqual(["laptop", "desktop"]);
    expect(machines[0]!.providerIds).toEqual(["codex"]);
    expect(machines[0]!.receivedAt).toBe(new Date(T0 + 1000).toISOString());
  });
});

describe("VibeIngestStore.forget", () => {
  test("drops that machine's rows at once", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ machine: "laptop" }));
    store.accept(envelope({ machine: "desktop", snapshots: [provider({ id: "codex" })] }));

    expect(store.forget("laptop")).toBe(true);
    expect(store.collect().map((usage) => usage.id)).toEqual(["codex"]);
    expect(store.listMachines().map((entry) => entry.machine)).toEqual(["desktop"]);
  });

  test("an unknown machine is false, not an error", () => {
    const store = new VibeIngestStore(() => T0);
    expect(store.forget("never-seen")).toBe(false);
  });

  // Forgetting is not uninstalling: it clears the panel, and an agent that is
  // still running says so again on its next push. The dialog tells the reader
  // to stop the agent first for exactly this reason.
  test("a still-running agent reappears on its next push", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ machine: "laptop" }));
    store.forget("laptop");
    store.accept(envelope({ machine: "laptop" }));
    expect(store.listMachines()).toHaveLength(1);
  });
});

describe("errors travel with the push", () => {
  const failing = { providerId: "claude", message: "sign-in rejected (HTTP 401)" };

  test("a reason for a missing vendor survives the trip", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ snapshots: [], errors: [failing] }));
    expect(store.collectErrors()).toEqual([failing]);
  });

  // Older agents pushed providers only; a round without the field is valid.
  test("an agent that sends no errors is still accepted", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope());
    expect(store.collectErrors()).toEqual([]);
  });

  test.each([
    ["errors that are not an array", { errors: { claude: "boom" } }],
    ["an error with no message", { errors: [{ providerId: "claude" }] }],
    ["an error with no providerId", { errors: [{ message: "boom" }] }],
    ["an error whose providerId is malformed", { errors: [{ providerId: "Claude!", message: "boom" }] }],
  ])("rejects %s", (_label, patch) => {
    const store = new VibeIngestStore(() => T0);
    expect(() => store.accept(envelope(patch))).toThrow(VibeIngestError);
  });

  // The failing vendor has no row to hang a machine badge on, so the machine
  // goes in the text — but only when there is more than one to tell apart.
  test("several machines name themselves in the message", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ machine: "laptop", snapshots: [], errors: [failing] }));
    expect(store.collectErrors()[0]!.message).toBe("sign-in rejected (HTTP 401)");

    store.accept(envelope({ machine: "desktop", snapshots: [], errors: [failing] }));
    expect(store.collectErrors().map((e) => e.message).sort()).toEqual([
      "sign-in rejected (HTTP 401)（desktop）",
      "sign-in rejected (HTTP 401)（laptop）",
    ]);
  });

  test("an expired machine takes its explanations with it", () => {
    let now = T0;
    const store = new VibeIngestStore(() => now);
    store.accept(envelope({ snapshots: [], errors: [failing] }));
    now = T0 + 15 * 60_000;
    expect(store.collectErrors()).toEqual([]);
  });

  test("forgetting a machine drops its errors too", () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ machine: "laptop", snapshots: [], errors: [failing] }));
    store.forget("laptop");
    expect(store.collectErrors()).toEqual([]);
  });
});

describe("source labelling", () => {
  function adapter(id: string): VibeProviderAdapter {
    return {
      id,
      displayName: id,
      detect: async () => true,
      fetchUsage: async () => ({
        metrics: [{ key: "session", label: "S", kind: "consumption", unit: "percent", utilization: 0.1 }],
      }),
    };
  }

  test("a locally collected row says so", async () => {
    const service = new VibeUsageService({ adapters: [adapter("claude")], now: () => T0 });
    const snapshot = await service.fetchSnapshot();
    expect(snapshot.providers[0]!.source).toEqual({ kind: "local" });
  });

  // The whole point of the field: one snapshot, two origins, each row honest
  // about which it is.
  test("a mixed snapshot labels each row with its own origin", async () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ machine: "laptop", snapshots: [provider({ id: "codex" })] }));
    const service = new VibeUsageService({
      adapters: [adapter("claude")],
      ingest: store,
      now: () => T0,
    });

    const snapshot = await service.fetchSnapshot();
    const byId = new Map(snapshot.providers.map((usage) => [usage.id, usage]));
    expect(byId.get("claude")!.source).toEqual({ kind: "local" });
    expect(byId.get("codex")!.source).toEqual({ kind: "remote", machine: "laptop" });
  });

  test("a local read overwriting a pushed row relabels it local", async () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ machine: "laptop" }));
    const service = new VibeUsageService({
      adapters: [adapter("claude")],
      ingest: store,
      now: () => T0,
    });

    const snapshot = await service.fetchSnapshot();
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]!.source).toEqual({ kind: "local" });
  });
});

describe("VibeUsageService folding ingest in", () => {
  function adapter(id: string, plan: string): VibeProviderAdapter {
    return {
      id,
      displayName: id,
      detect: async () => true,
      fetchUsage: async () => ({
        plan,
        metrics: [{ key: "session", label: "Session", kind: "consumption", unit: "percent", utilization: 0.1 }],
      }),
    };
  }

  test("a pushed provider reaches the snapshot when nothing is signed in locally", async () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope());
    const service = new VibeUsageService({ adapters: [], ingest: store, now: () => T0 });

    const snapshot = await service.fetchSnapshot();
    expect(snapshot.providers.map((usage) => usage.id)).toEqual(["claude"]);
    expect(snapshot.providers[0]!.plan).toBe("Max 20x");
  });

  // A credential this process read itself outranks one relayed over the network.
  test("a local read of the same vendor overwrites the pushed row", async () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope());
    const service = new VibeUsageService({
      adapters: [adapter("claude", "local-plan")],
      ingest: store,
      now: () => T0,
    });

    const snapshot = await service.fetchSnapshot();
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]!.plan).toBe("local-plan");
  });

  test("local and pushed vendors coexist, in catalog order", async () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({ snapshots: [provider({ id: "codex", displayName: "Codex" })] }));
    const service = new VibeUsageService({
      adapters: [adapter("claude", "local")],
      ingest: store,
      now: () => T0,
    });

    const snapshot = await service.fetchSnapshot();
    expect(snapshot.providers.map((usage) => usage.id)).toEqual(["claude", "codex"]);
  });

  test("a remote failure reaches the console's error list", async () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({
      snapshots: [],
      errors: [{ providerId: "claude", message: "sign-in rejected (HTTP 401)" }],
    }));
    const service = new VibeUsageService({ adapters: [], ingest: store, now: () => T0 });

    const snapshot = await service.fetchSnapshot();
    expect(snapshot.errors).toEqual([{ providerId: "claude", message: "sign-in rejected (HTTP 401)" }]);
  });

  // What the user is looking at is the local row; the remote machine's problem
  // with the same vendor is not the explanation for anything on screen.
  test("a remote failure is dropped when the local read of that vendor worked", async () => {
    const store = new VibeIngestStore(() => T0);
    store.accept(envelope({
      snapshots: [],
      errors: [{ providerId: "claude", message: "sign-in rejected (HTTP 401)" }],
    }));
    const service = new VibeUsageService({
      adapters: [adapter("claude", "local-plan")],
      ingest: store,
      now: () => T0,
    });

    const snapshot = await service.fetchSnapshot();
    expect(snapshot.providers[0]!.plan).toBe("local-plan");
    expect(snapshot.errors).toEqual([]);
  });

  test("an expired push leaves the snapshot as empty as it would have been", async () => {
    let now = T0;
    const store = new VibeIngestStore(() => now);
    store.accept(envelope());
    now = T0 + 20 * 60_000;
    const service = new VibeUsageService({ adapters: [], ingest: store, now: () => now });

    await expect(service.fetchSnapshot()).rejects.toThrow();
  });
});
