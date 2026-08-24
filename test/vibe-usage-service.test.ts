import { describe, expect, test } from "bun:test";
import { VibeUsageService, VibeUnavailableError } from "../src/vibe/usage-service.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type VibeProviderAdapter,
} from "../src/vibe/providers/types.ts";

const NOW = Date.parse("2026-08-14T09:00:00Z");

function metric(used: number) {
  return [{
    key: "session",
    label: "Session",
    kind: "consumption" as const,
    unit: "percent",
    used,
    limit: 100,
    utilization: used / 100,
  }];
}

/** A vendor whose every behaviour is scripted per call. */
function adapter(id: string, script: {
  detect?: () => boolean | Promise<boolean>;
  fetch: () => Promise<{ plan?: string; metrics: ReturnType<typeof metric> }>;
}): VibeProviderAdapter {
  return {
    id,
    displayName: id,
    detect: async () => script.detect === undefined ? true : await script.detect(),
    fetchUsage: async () => await script.fetch(),
  };
}

function service(adapters: VibeProviderAdapter[], now: () => number, deadlineMs = 20_000) {
  return new VibeUsageService({ adapters, now, deadlineMs, keychain: { read: async () => null } });
}

describe("vibe usage service — degradation is per vendor", () => {
  test("a rate-limited vendor stays parked, and keeps saying why after last-good expires", async () => {
    let clock = NOW;
    let calls = 0;
    const collector = service([adapter("claude", {
      fetch: async () => {
        calls += 1;
        if (calls === 1) return { plan: "Max 20x", metrics: metric(25) };
        throw new VibeRateLimitedError("claude", 30 * 60_000);
      },
    })], () => clock);

    expect((await collector.fetchSnapshot()).providers[0]!.metrics[0]!.used).toBe(25);

    // The 429 lands: last-good stands in, flagged, with the reason attached.
    clock = NOW + 60_000;
    const parked = await collector.fetchSnapshot();
    expect(calls).toBe(2);
    expect(parked.providers[0]!.stale).toBe(true);
    expect(parked.errors[0]!.providerId).toBe("claude");

    // Still inside the cooldown: no second request is spent on it.
    clock = NOW + 5 * 60_000;
    const stillParked = await collector.fetchSnapshot();
    expect(calls).toBe(2);
    expect(stillParked.errors).toHaveLength(1);

    // Past the 15-minute last-good window the numbers go, but the reason must
    // not: a parked vendor with no error would read as one never signed in.
    clock = NOW + 20 * 60_000;
    const expired = await collector.fetchSnapshot();
    expect(calls).toBe(2);
    expect(expired.providers).toHaveLength(0);
    expect(expired.errors).toEqual([{ providerId: "claude", message: "rate limited" }]);
  });

  test("a rejected credential is not retried every round", async () => {
    let clock = NOW;
    let calls = 0;
    const collector = service([adapter("codex", {
      fetch: async () => {
        calls += 1;
        throw new VibeCredentialsExpiredError("codex");
      },
    })], () => clock);

    await collector.fetchSnapshot();
    expect(calls).toBe(1);
    // Every refresh attempt spends the CLI's rotating token, so a login only the
    // user can repair is left alone for a while.
    clock = NOW + 10 * 60_000;
    await collector.fetchSnapshot();
    expect(calls).toBe(1);
    clock = NOW + 31 * 60_000;
    await collector.fetchSnapshot();
    expect(calls).toBe(2);
  });

  test("a probe that throws is a failure, not a logout", async () => {
    let clock = NOW;
    let locked = false;
    const collector = service([adapter("claude", {
      detect: () => {
        if (locked) throw new Error("keychain locked");
        return true;
      },
      fetch: async () => ({ metrics: metric(40) }),
    })], () => clock);

    await collector.fetchSnapshot();
    locked = true;
    clock = NOW + 60_000;
    const snapshot = await collector.fetchSnapshot();
    // A locked keychain must not look like a sign-out: the numbers stay, flagged.
    expect(snapshot.providers[0]!.stale).toBe(true);
    expect(snapshot.errors[0]!.message).toContain("locked");
  });

  test("a vendor with no credential is absent rather than an error", async () => {
    const collector = service([
      adapter("claude", { detect: () => false, fetch: async () => ({ metrics: metric(1) }) }),
      adapter("codex", { fetch: async () => ({ metrics: metric(7) }) }),
    ], () => NOW);
    const snapshot = await collector.fetchSnapshot();
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(["codex"]);
    expect(snapshot.errors).toHaveLength(0);
  });

  test("nothing signed in at all is unavailability, which the panel names", async () => {
    const collector = service([
      adapter("claude", { detect: () => false, fetch: async () => ({ metrics: metric(1) }) }),
    ], () => NOW);
    await expect(collector.fetchSnapshot()).rejects.toBeInstanceOf(VibeUnavailableError);
  });

  test("one hung vendor cannot hold the round past its deadline", async () => {
    const collector = service([
      adapter("claude", { fetch: () => new Promise(() => {}) }),
      adapter("codex", { fetch: async () => ({ metrics: metric(3) }) }),
    ], () => NOW, 50);

    const snapshot = await collector.fetchSnapshot();
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(["codex"]);
    expect(snapshot.errors[0]!.message).toContain("deadline");
  });

  test("a missing credential mid-run clears the numbers it left behind", async () => {
    let clock = NOW;
    let signedIn = true;
    const collector = service([adapter("claude", {
      fetch: async () => {
        if (!signedIn) throw new VibeCredentialsMissingError("claude");
        return { metrics: metric(12) };
      },
    })], () => clock);

    await collector.fetchSnapshot();
    signedIn = false;
    clock = NOW + 60_000;
    // A logout must not leave yesterday's numbers on the panel for 15 minutes.
    await expect(collector.fetchSnapshot()).rejects.toBeInstanceOf(VibeUnavailableError);
  });

  test("a transport failure keeps last-good until it can no longer be dated", async () => {
    let clock = NOW;
    let online = true;
    const collector = service([adapter("grok", {
      fetch: async () => {
        if (!online) throw new VibeRequestError("grok", "connect ECONNREFUSED");
        return { metrics: metric(4) };
      },
    })], () => clock);

    await collector.fetchSnapshot();
    online = false;
    clock = NOW + 10 * 60_000;
    expect((await collector.fetchSnapshot()).providers[0]!.stale).toBe(true);
    clock = NOW + 16 * 60_000;
    const gone = await collector.fetchSnapshot();
    expect(gone.providers).toHaveLength(0);
    expect(gone.errors).toHaveLength(1);
  });
});

describe("cooldowns and what clears them", () => {
  function rejecting(id: string, calls: { n: number }): VibeProviderAdapter {
    return {
      id,
      displayName: id,
      detect: async () => true,
      fetchUsage: async () => {
        calls.n += 1;
        throw new VibeCredentialsExpiredError(id, "sign-in rejected (HTTP 401)");
      },
    };
  }

  test("a rejected credential is parked, so the next round does not spend it again", async () => {
    const calls = { n: 0 };
    const service = new VibeUsageService({ adapters: [rejecting("claude", calls)], now: () => 1_000 });

    const first = await service.fetchSnapshot();
    expect(first.errors[0]!.message).toBe("sign-in rejected (HTTP 401)");
    await service.fetchSnapshot();
    expect(calls.n).toBe(1);
  });

  // The console's 刷新 means "try again now". Without this a user who had just
  // repaired the login watched the panel repeat the old reason for half an hour
  // and concluded the repair had failed.
  test("clearCooldowns lets the very next round try again", async () => {
    const calls = { n: 0 };
    const service = new VibeUsageService({ adapters: [rejecting("claude", calls)], now: () => 1_000 });

    await service.fetchSnapshot();
    service.clearCooldowns();
    await service.fetchSnapshot();
    expect(calls.n).toBe(2);
  });

  // The status code is the difference between a credential the vendor rejected
  // and one this process never got to use; flattening it cost a debugging
  // session looking for an expiry that was not there.
  test("the vendor's own message survives to the console", async () => {
    const service = new VibeUsageService({
      adapters: [{
        id: "claude",
        displayName: "claude",
        detect: async () => true,
        fetchUsage: async () => { throw new VibeCredentialsExpiredError("claude", "sign-in rejected (HTTP 403)"); },
      }],
      now: () => 1_000,
    });
    const snapshot = await service.fetchSnapshot();
    expect(snapshot.errors[0]!.message).toContain("HTTP 403");
  });
});
