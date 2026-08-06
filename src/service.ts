import {
  deleteClockApp,
  pushClockPayloadNamed,
  readClockInfo,
} from "./clock-client.ts";
import { loadConfig } from "./config.ts";
import { createControlHandler } from "./control-api.ts";
import { WorkspaceStore, createDefaultWorkspace } from "./workspace.ts";
import { WorkspaceController } from "./workspace-controller.ts";
import { PixelAssetStore } from "./pixel-asset-store.ts";
import { UlanziPixelAssetClient } from "./ulanzi-pixel-assets.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

const config = loadConfig();
const workspaceStore = new WorkspaceStore(
  ".runtime/workspace.json",
  ".runtime/settings.json",
  config.appName,
);
const pixelAssetStore = new PixelAssetStore(".runtime/pixel-assets");
const ulanziPixelAssets = new UlanziPixelAssetClient({ timeoutMs: config.requestTimeoutMs });
let workspace = createDefaultWorkspace(config.appName);
try {
  workspace = await workspaceStore.load();
} catch (error) {
  log("workspace_load_failed", { error: errorMessage(error), fallback: "defaults" });
}

const controller = new WorkspaceController({
  config,
  workspace,
  workspaceStore,
  pushPayload: (appName, payload) => pushClockPayloadNamed(config, appName, payload),
  deleteApp: (appName) => deleteClockApp(config, appName),
  pixelAssetStore,
});

let stopping = false;
let wakeSleep: (() => void) | undefined;
const loggedUpdateCounts = new Map<string, number>();

function interruptibleSleep(ms: number): Promise<void> {
  if (stopping) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = undefined;
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = undefined;
      resolve();
    };
  });
}

const controlHandler = createControlHandler(controller, {
  onSettingsChanged: () => wakeSleep?.(),
  pixelAssetLibrary: { client: ulanziPixelAssets, store: pixelAssetStore },
});
const controlServer = Bun.serve({
  hostname: config.controlHost,
  port: config.healthPort,
  fetch: controlHandler,
});

function beginShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log("shutdown_requested", { signal });
  wakeSleep?.();
  controlServer.stop(true);
}

process.once("SIGINT", () => beginShutdown("SIGINT"));
process.once("SIGTERM", () => beginShutdown("SIGTERM"));

async function run(): Promise<void> {
  log("service_started", {
    clockHost: config.clockHost,
    channels: controller.getWorkspace().channels.map((channel) => ({
      appName: channel.appName,
      items: channel.items.map((item) => item.contentId),
    })),
    controlUrl: `http://${config.controlHost}:${config.healthPort}/`,
  });

  try {
    const info = await readClockInfo(config);
    controller.setDeviceInfo(info);
    log("clock_detected", { mcu: info.mcuVersion, app: info.appVersion });
  } catch (error) {
    log("clock_detection_failed", { error: errorMessage(error) });
  }

  while (!stopping) {
    try {
      const state = await controller.pushDue();
      const updatedChannels = state.channels.filter((channel) =>
        channel.updateCount > (loggedUpdateCounts.get(channel.id) ?? 0)
      );
      for (const channel of updatedChannels) {
        loggedUpdateCounts.set(channel.id, channel.updateCount);
      }
      if (updatedChannels.length > 0 || state.degraded) {
        log("channels_checked", {
          channels: updatedChannels.map((channel) => ({
            appName: channel.appName,
            updateCount: channel.updateCount,
            animationDurationMs: channel.animationDurationMs,
            degraded: channel.degraded,
          })),
          degraded: state.degraded,
        });
      }
    } catch (error) {
      log("update_failed", {
        error: errorMessage(error),
      });
    }

    await interruptibleSleep(controller.getNextWakeMs());
  }

  log("service_stopped");
}

await run();
