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
});
