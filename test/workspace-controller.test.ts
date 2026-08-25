import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.ts";
import type { ClockPayload } from "../src/display.ts";
import type { AssetMarketData } from "../src/price.ts";
import { WorkspaceStore, type WorkspaceSettings } from "../src/workspace.ts";
import { WorkspaceController } from "../src/workspace-controller.ts";
import { PixelAssetStore } from "../src/pixel-asset-store.ts";
import { PixelCanvas, encodePixelAnimation } from "../src/pixel-ui.ts";
import { InstrumentStore, canonicalInstrumentKey } from "../src/market/instruments.ts";
import { MarketIconStore } from "../src/market/icon-store.ts";
import { DynamicMarketDataClient } from "../src/market/quotes.ts";
import { VibeUnavailableError, VibeUsageService } from "../src/vibe/usage-service.ts";
import type { VibeProviderAdapter } from "../src/vibe/providers/types.ts";
import { OsLinkHub, type OsVibeAgent } from "../src/os-link.ts";

const directories: string[] = [];
const NOW = Date.parse("2026-08-06T06:00:00Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function fixtureWorkspace(): WorkspaceSettings {
  return {
    version: 3,
    channels: [
      {
        id: "mixed",
        name: "市场和通知",
        appName: "market_mix",
        enabled: true,
        refreshIntervalMs: 1_000,
        items: [
          { id: "stock", contentId: "market:aapl", durationMs: 1_500, options: { showChange: true, changeDurationMs: 500 } },
          { id: "notice", contentId: "tools:notice", durationMs: 1_000, options: { message: "HELLO", color: "#00ff66", background: "#000000", scroll: false } },
        ],
      },
      {
        id: "fire",
        name: "火焰",
        appName: "fire",
        enabled: true,
        refreshIntervalMs: 1_000,
        items: [{ id: "fire_item", contentId: "visual:fire", durationMs: 1_000, options: { speed: "1" } }],
      },
    ],
  };
}

/**
 * A one-metric Claude stand-in. The controller only cares that a service hands
 * back a snapshot or throws, so the vendor plumbing stays out of these tests.
 */
function stubVibeService(input: {
  now: () => number;
  offline: () => boolean;
  onFetch: () => void;
}): VibeUsageService {
  const adapter: VibeProviderAdapter = {
    id: "claude",
    displayName: "Claude",
    detect: async () => true,
    fetchUsage: async () => {
      input.onFetch();
      if (input.offline()) throw new Error("Unable to connect");
      return {
        plan: "Max 20x",
        metrics: [{
          key: "session",
          label: "Session",
          kind: "consumption" as const,
          unit: "percent",
          used: 25,
          limit: 100,
          utilization: 0.25,
        }],
      };
    },
  };
  return new VibeUsageService({ adapters: [adapter], now: input.now });
}

/** A channel of the shape the retired 频道布置 used to write. */
function vibeChannel(id: string, appName: string, contentId: string): WorkspaceSettings["channels"][number] {
  return {
    id,
    name: appName === "vibe" ? "AI 用量" : "AI 用量详情",
    appName,
    enabled: true,
    refreshIntervalMs: 60_000,
    items: [{ id: `${id}_item`, contentId, durationMs: 15_000, options: {} }],
  };
}

describe("multi-channel workspace controller", () => {
  test("composes a carousel but publishes standalone channels as separate knob apps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-controller-"));
    directories.push(directory);
    const pushes: Array<{ appName: string; payload: ClockPayload }> = [];
    const controller = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace: fixtureWorkspace(),
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      marketClient: {
        async getAsset(assetId: "aapl"): Promise<AssetMarketData> {
          return {
            assetId,
            provider: "yahoo",
            price: 233.19,
            rawPrice: "233.19",
            fetchedAt: new Date(NOW).toISOString(),
            changePercent: 1.3,
            changePeriod: "1D",
          };
        },
      } as never,
      pushPayload: async (appName, payload) => {
        pushes.push({ appName, payload });
        return { status: 200 };
      },
      deleteApp: async () => ({ status: 200 }),
      now: () => NOW,
    });

    const state = await controller.pushAll();
    expect(pushes.map((push) => push.appName)).toEqual(["market_mix", "fire"]);
    expect(pushes[0]?.payload.image[0]?.data).toStartWith("data:image/gif;base64,");
    expect(state.channels.map((channel) => channel.animationDurationMs)).toEqual([2_500, 1_000]);
    expect(state.channels.every((channel) => channel.updateCount === 1)).toBe(true);
  });

  test("cleans old Custom App names after a rename or disable without rolling back the save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-cleanup-"));
    directories.push(directory);
    const deleted: string[] = [];
    const controller = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace: fixtureWorkspace(),
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      marketClient: {} as never,
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async (appName) => { deleted.push(appName); return { status: 200 }; },
      now: () => NOW,
    });
    const next = fixtureWorkspace();
    next.channels[0]!.appName = "market_new";
    next.channels[1]!.enabled = false;
    await controller.saveWorkspace(next);
    expect(deleted).toEqual(["market_mix", "fire"]);
    expect(controller.getWorkspace().channels[0]?.appName).toBe("market_new");
  });

  test("carries a failed delete across a restart instead of forgetting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-cleanup-restart-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace.json");
    // Stands in for AppCleanupStore: the controller only ever calls save().
    let saved: Record<string, string> = {};
    const appCleanupStore = { save: async (pending: Record<string, string>) => { saved = pending; } };

    // The clock is asleep, so the DELETE fails. Before this was written down,
    // the retry list lived only in memory.
    const first = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace: fixtureWorkspace(),
      workspaceStore: new WorkspaceStore(workspacePath),
      marketClient: {} as never,
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async () => { throw new Error("clock request timed out after 4000ms"); },
      appCleanupStore,
      now: () => NOW,
    });
    const next = fixtureWorkspace();
    next.channels[1]!.enabled = false;
    await first.saveWorkspace(next);
    expect(first.getState().cleanupErrors).toEqual({ fire: "clock request timed out after 4000ms" });
    expect(saved).toEqual({ fire: "clock request timed out after 4000ms" });

    // A restart in that window used to drop the list: the workspace no longer
    // mentions the channel, so nothing else remembers the app is on the device.
    const deleted: string[] = [];
    const second = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace: next,
      workspaceStore: new WorkspaceStore(workspacePath),
      marketClient: {} as never,
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async (appName) => { deleted.push(appName); return { status: 200 }; },
      appCleanupStore,
      pendingAppCleanup: saved,
      now: () => NOW,
    });
    expect(second.getState().cleanupErrors).toEqual({ fire: "clock request timed out after 4000ms" });
    await second.pushDue();
    expect(deleted).toEqual(["fire"]);
    expect(second.getState().cleanupErrors).toEqual({});
    expect(saved).toEqual({});
  });

  test("rejects unknown renderers and malformed canvases before persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-invalid-"));
    directories.push(directory);
    const workspace = fixtureWorkspace();
    workspace.channels[0]!.items = [{ id: "bad", contentId: "unknown:thing", durationMs: 1_000, options: {} }];
    expect(() => new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace,
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async () => ({ status: 200 }),
    })).toThrow("unknown contentId");
  });

  test("renders a locally imported animated pixel asset without contacting Ulanzi again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-controller-assets-"));
    directories.push(directory);
    const store = new PixelAssetStore(join(directory, "assets"));
    const first = new PixelCanvas(52, 16, [255, 0, 0]);
    const second = new PixelCanvas(52, 16, [0, 0, 255]);
    const metadata = await store.save({
      officialId: "1011",
      title: "cc小螃蟹",
      author: "Tester",
      sourceUrl: "https://ugc.ulanzistudio.com/contentView/1011",
      mimeType: "image/gif",
      bytes: encodePixelAnimation([first, second], [140, 140]),
    });
    const workspace = fixtureWorkspace();
    workspace.channels[1]!.items = [{
      id: "crab",
      contentId: "creative:pixel-asset",
      durationMs: 1_000,
      options: {
        assetRef: metadata.ref,
        officialId: metadata.officialId,
        title: metadata.title,
        author: metadata.author,
        sourceUrl: metadata.sourceUrl,
        frameCount: metadata.frameCount,
      },
    }];
    const controller = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace,
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      pixelAssetStore: store,
      marketClient: {} as never,
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async () => ({ status: 200 }),
      now: () => NOW,
    });
    const rendered = await controller.previewChannel(workspace.channels[1]!.id);
    expect(rendered.mimeType).toBe("image/gif");
    expect(rendered.frames.length).toBeGreaterThan(2);
    expect(rendered.animationDurationMs).toBe(1_000);
    expect(rendered.label).toBe("cc小螃蟹");
  });

  test("reuses a recent automatic preview but refreshes it on demand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-preview-cache-"));
    directories.push(directory);
    const workspace = fixtureWorkspace();
    const channel = workspace.channels[1]!;
    const controller = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace,
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      marketClient: {} as never,
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async () => ({ status: 200 }),
      now: () => NOW,
    });

    const first = await controller.previewChannel(channel);
    const reused = await controller.previewChannel(structuredClone(channel));
    const refreshed = await controller.previewChannel(channel, true);
    const inFlightFirst = controller.previewChannel(channel, true);
    const inFlightSecond = controller.previewChannel(structuredClone(channel), true);

    expect(reused).toBe(first);
    expect(refreshed).not.toBe(first);
    expect(await inFlightSecond).toBe(await inFlightFirst);
  });

  test("serves usage from cache and falls back to it only while it is still datable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-cache-"));
    directories.push(directory);
    let clientNow = NOW;
    let controllerNow = NOW;
    let fetches = 0;
    let offline = false;
    const vibeClient = stubVibeService({
      now: () => clientNow,
      offline: () => offline,
      onFetch: () => { fetches += 1; },
    });
    const controller = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace: fixtureWorkspace(),
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      marketClient: {} as never,
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async () => ({ status: 200 }),
      vibeClient,
      vibeStarred: () => ({ claude: ["session"] }),
      now: () => controllerNow,
    });

    // Volatile numbers must not reach the network on a preview; only the empty
    // cache does, exactly like getMarket.
    const first = await controller.getVibeUsage(false);
    expect(fetches).toBe(1);
    expect(first.starred.claude).toEqual(["session"]);
    expect(first.snapshot.providers[0]!.metrics[0]!.used).toBe(25);
    expect(await controller.getVibeUsage(false)).toEqual(first);
    expect(fetches).toBe(1);

    // A vendor that refuses keeps its last good numbers, flagged stale and with
    // the reason attached, rather than blanking the page — degradation is per
    // vendor, so one dead endpoint never costs the others their row.
    offline = true;
    // Console-initiated a minute later, so neither floor swallows the round.
    controllerNow = NOW + 60_000;
    clientNow = controllerNow;
    const degraded = await controller.getVibeUsage(true, true);
    expect(fetches).toBe(2);
    expect(degraded.snapshot.providers[0]!.metrics).toEqual(first.snapshot.providers[0]!.metrics);
    expect(degraded.snapshot.providers[0]!.stale).toBe(true);
    expect(degraded.snapshot.errors).toEqual([{ providerId: "claude", message: "Unable to connect" }]);

    // Past the staleness window nobody can say when the figure was true, so the
    // vendor drops out entirely and only the error is left.
    controllerNow = NOW + 20 * 60_000;
    clientNow = controllerNow;
    const expired = await controller.getVibeUsage(true, true);
    expect(expired.snapshot.providers).toEqual([]);
    expect(expired.snapshot.errors).toHaveLength(1);
  });

  test("names a missing usage service as unavailability so the panel can say so", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-unset-"));
    directories.push(directory);
    const controller = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace: fixtureWorkspace(),
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      marketClient: {} as never,
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async () => ({ status: 200 }),
      now: () => NOW,
    });
    await expect(controller.getVibeUsage(false)).rejects.toBeInstanceOf(VibeUnavailableError);
  });

  test("renders a persisted runtime instrument and protects it from the legacy settings API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-controller-runtime-market-"));
    directories.push(directory);
    const instrumentStore = new InstrumentStore(join(directory, "instruments"), { now: () => NOW });
    const marketIconStore = new MarketIconStore(join(directory, "icons"), { now: () => NOW });
    await Promise.all([instrumentStore.load(), marketIconStore.load()]);
    const draft = {
      canonicalKey: canonicalInstrumentKey({ kind: "fx" as const, base: "EUR", quote: "USD" }),
      kind: "fx" as const,
      displayName: "Euro / US Dollar",
      displaySymbol: "EUR/USD",
      baseCode: "EUR",
      quoteCode: "USD",
      decimals: 4,
      changePeriod: "1D" as const,
      routes: [{ provider: "frankfurter" as const, symbol: "EUR/USD" }],
      sourceNote: "Frankfurter reference rates.",
    };
    const ref = instrumentStore.allocateRef();
    const icon = await marketIconStore.saveFallback({ ...draft, ref });
    const instrument = await instrumentStore.save({ ...draft, ref, iconRef: icon.ref });
    const workspace = fixtureWorkspace();
    workspace.channels[0]!.items = [{
      id: "eurusd",
      contentId: "market:instrument",
      durationMs: 15_000,
      options: { instrumentRef: instrument.ref, showChange: true, changeDurationMs: 2_500 },
    }];
    const controller = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace,
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      instrumentStore,
      marketIconStore,
      dynamicMarketClient: new DynamicMarketDataClient({
        now: () => NOW,
        fetcher: async () => Response.json([
          { date: "2026-08-05", base: "EUR", quote: "USD", rate: 1.16 },
          { date: "2026-08-06", base: "EUR", quote: "USD", rate: 1.17 },
        ]),
      }),
      marketClient: {} as never,
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async () => ({ status: 200 }),
      now: () => NOW,
    });
    const rendered = await controller.previewChannel("mixed");
    expect(rendered.label).toBe("EUR/USD 1.1700");
    expect(rendered.frames).toHaveLength(2);
    expect(() => controller.getSettings()).toThrow("legacy settings API cannot represent runtime instruments");
    await expect(controller.saveSettings({})).rejects.toThrow(
      "legacy settings API cannot represent runtime instruments",
    );

    const missing = structuredClone(workspace);
    missing.channels[0]!.items[0]!.options.instrumentRef = "ins_ffffffffffffffffffffffff";
    await expect(controller.saveWorkspace(missing)).rejects.toThrow("instrument is unavailable");
  });
});

// VIBE became a firmware app, so `tools:vibe-*` left the registry — and an
// unresolvable contentId throws inside the constructor, before Bun.serve. These
// four cover the migration that keeps `bun start` working across that upgrade.
describe("retired VIBE channel migration", () => {
  const migrationController = async (
    workspace: WorkspaceSettings,
    directory: string,
    collected: { logs: Array<[string, Record<string, unknown>]>; deleted: string[] },
  ) => {
    const controller = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace,
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      marketClient: {} as never,
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async (appName) => { collected.deleted.push(appName); return { status: 200 }; },
      onLog: (event, details) => { collected.logs.push([event, details]); },
      now: () => NOW,
    });
    await controller.vibeMigrationSettled;
    return controller;
  };

  test("drops the placed channels, writes the result back, and clears them off the clock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-migrate-"));
    directories.push(directory);
    const collected = { logs: [] as Array<[string, Record<string, unknown>]>, deleted: [] as string[] };
    const workspace = fixtureWorkspace();
    workspace.channels.push(
      vibeChannel("vibe_duo", "vibe", "tools:vibe-duo"),
      vibeChannel("vibe_claude", "vibe_claude", "tools:vibe-agent"),
    );
    const controller = await migrationController(workspace, directory, collected);

    expect(controller.getWorkspace().channels.map((channel) => channel.appName))
      .toEqual(["market_mix", "fire"]);
    // Written back, or every boot re-migrates while the console shows a
    // workspace that disagrees with disk.
    const reloaded = await new WorkspaceStore(join(directory, "workspace.json")).load();
    expect(reloaded.channels.map((channel) => channel.appName)).toEqual(["market_mix", "fire"]);
    // Under the official firmware each dropped channel is still a Custom App on
    // the knob; nothing else would ever take it off.
    expect(collected.deleted).toEqual(["vibe", "vibe_claude"]);
    expect(collected.logs).toEqual([["workspace_vibe_channels_migrated", {
      droppedChannels: ["vibe", "vibe_claude"],
      strippedItems: 0,
      resetToDefaults: false,
      reason: "vibe_is_a_firmware_app",
    }]]);
  });

  test("leaves a user channel that merely happens to be called vibe alone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-squatter-"));
    directories.push(directory);
    const collected = { logs: [] as Array<[string, Record<string, unknown>]>, deleted: [] as string[] };
    const workspace = fixtureWorkspace();
    // `vibe` was deliberately never reserved, so this is somebody's own channel:
    // our appName, none of our content. Name alone must never be enough.
    workspace.channels[1]!.appName = "vibe";
    const controller = await migrationController(workspace, directory, collected);

    expect(controller.getWorkspace().channels).toEqual(workspace.channels);
    expect(collected.logs).toEqual([]);
    expect(collected.deleted).toEqual([]);
    // Nothing changed, so nothing was written: the file is still absent.
    expect(await Bun.file(join(directory, "workspace.json")).exists()).toBe(false);
  });

  test("takes only the tile out of a carousel somebody dropped one into", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-mixed-"));
    directories.push(directory);
    const collected = { logs: [] as Array<[string, Record<string, unknown>]>, deleted: [] as string[] };
    const workspace = fixtureWorkspace();
    workspace.channels[0]!.items.push({
      id: "usage", contentId: "tools:vibe-duo", durationMs: 15_000, options: {},
    });
    const controller = await migrationController(workspace, directory, collected);

    const channels = controller.getWorkspace().channels;
    expect(channels.map((channel) => channel.appName)).toEqual(["market_mix", "fire"]);
    expect(channels[0]!.items.map((item) => item.contentId)).toEqual(["market:aapl", "tools:notice"]);
    expect(collected.deleted).toEqual([]);
    expect(collected.logs[0]![1]).toMatchObject({ droppedChannels: [], strippedItems: 1 });
  });

  test("falls back to the stock workspace when VIBE was all there was", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-only-"));
    directories.push(directory);
    const collected = { logs: [] as Array<[string, Record<string, unknown>]>, deleted: [] as string[] };
    const controller = await migrationController(
      { version: 3, channels: [vibeChannel("vibe_duo", "vibe", "tools:vibe-duo")] },
      directory,
      collected,
    );

    // A workspace needs at least one channel, so an obviously fresh panel beats
    // a service that refuses to start.
    expect(controller.getWorkspace().channels).toHaveLength(1);
    expect(controller.getWorkspace().channels[0]!.items[0]!.contentId).toBe("market:btc");
    expect(collected.logs[0]![1]).toMatchObject({ resetToDefaults: true });
    // The default workspace claims the same appName the dropped channel used
    // only when the user configured it that way; here it does not, so the stale
    // Custom App is still deleted.
    expect(collected.deleted).toEqual(["vibe"]);
  });
});

// The panel's VIBE app is fed by service.ts's publishOsVibe(), which reads this
// controller's view and hands it to OsLinkHub.setVibe(). service.ts is a script
// that starts a server on import, so the projection cannot be imported here —
// this pins the half that can be: the view shape publishOsVibe reads, and that
// what comes out of it survives the hub unchanged.
test("a usage view projects onto the wire rows the panel draws", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-publish-"));
  directories.push(directory);
  const controller = new WorkspaceController({
    config: loadConfig({ CLOCK_HOST: "tc002.test" }),
    workspace: fixtureWorkspace(),
    workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
    marketClient: {} as never,
    pushPayload: async () => ({ status: 200 }),
    deleteApp: async () => ({ status: 200 }),
    vibeClient: stubVibeService({ now: () => NOW, offline: () => false, onFetch: () => {} }),
    // "credits" is starred first but the stub vendor never sends it; star order
    // still decides row order, and a metric nobody sent gets no row at all.
    vibeStarred: () => ({ claude: ["credits", "session"] }),
    now: () => NOW,
  });

  const view = await controller.getVibeUsage(false);
  const agents: OsVibeAgent[] = view.snapshot.providers.map((provider) => ({
    id: provider.id,
    label: provider.displayName,
    plan: provider.plan ?? "",
    stale: provider.stale,
    metrics: (view.starred[provider.id] ?? [])
      .map((key) => provider.metrics.find((metric) => metric.key === key))
      .filter((metric) => metric !== undefined)
      .map((metric) => ({
        label: metric.label,
        used: (metric.kind === "balance" ? metric.available : metric.used) ?? 0,
        limit: metric.unit === "percent" ? metric.limit ?? 100 : 0,
        resetSec: -1,
      })),
  }));

  const hub = new OsLinkHub();
  hub.setVibe(agents);
  expect(hub.getVibe()).toEqual([{
    id: "claude",
    label: "Claude",
    plan: "Max 20x",
    stale: false,
    metrics: [{ label: "Session", used: 25, limit: 100, resetSec: -1 }],
  }]);
  // Idempotent: the publisher runs on a five-minute timer, and a payload that
  // compares equal must not wake every parked long poll.
  const seq = hub.currentSeq();
  hub.setVibe(agents);
  expect(hub.currentSeq()).toBe(seq);
});

// Review regression: a cache hit must age out, or a service with no scheduled
// VIBE channel pins the boot-time snapshot forever behind /api/vibe/status.
test("vibe usage cache hits age out at VIBE_STALE_MS instead of pinning the boot snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-age-"));
  directories.push(directory);
  let clientNow = NOW - 20 * 60_000;
  let fetches = 0;
  const vibeClient = stubVibeService({
    now: () => clientNow,
    offline: () => false,
    onFetch: () => { fetches += 1; },
  });
  const controller = new WorkspaceController({
    config: loadConfig({ CLOCK_HOST: "tc002.test" }),
    workspace: fixtureWorkspace(),
    workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
    marketClient: {} as never,
    pushPayload: async () => ({ status: 200 }),
    deleteApp: async () => ({ status: 200 }),
    vibeClient,
    now: () => NOW,
  });

  await controller.getVibeUsage(false); // cache lands already 20 minutes old
  expect(fetches).toBe(1);
  clientNow = NOW; // the next fetch stamps fresh
  await controller.getVibeUsage(false); // stale hit refetches instead of serving
  expect(fetches).toBe(2);
  await controller.getVibeUsage(false); // fresh again — back to cache hits
  expect(fetches).toBe(2);
});

// Review regression: several VIBE channels each push on their own interval, and
// every push asks for fresh usage. Without a floor that is one vendor round per
// push — which is exactly what earned a 429 during bring-up.
test("scheduled pushes share one collection round; only the console may force one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-floor-"));
  directories.push(directory);
  let clientNow = NOW;
  let fetches = 0;
  const vibeClient = stubVibeService({
    now: () => clientNow,
    offline: () => false,
    onFetch: () => { fetches += 1; },
  });
  let controllerNow = NOW;
  const controller = new WorkspaceController({
    config: loadConfig({ CLOCK_HOST: "tc002.test" }),
    workspace: fixtureWorkspace(),
    workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
    marketClient: {} as never,
    pushPayload: async () => ({ status: 200 }),
    deleteApp: async () => ({ status: 200 }),
    vibeClient,
    now: () => controllerNow,
  });

  await controller.getVibeUsage(true);
  expect(fetches).toBe(1);

  // Three more channel pushes a minute apart: still one round.
  for (let minute = 1; minute <= 3; minute += 1) {
    controllerNow = NOW + minute * 60_000;
    clientNow = controllerNow;
    await controller.getVibeUsage(true);
  }
  expect(fetches).toBe(1);

  // The console's own refresh is allowed through it.
  await controller.getVibeUsage(true, true);
  expect(fetches).toBe(2);

  // And past the floor the schedule collects again on its own.
  controllerNow = NOW + 9 * 60_000;
  clientNow = controllerNow;
  await controller.getVibeUsage(true);
  expect(fetches).toBe(3);
});
