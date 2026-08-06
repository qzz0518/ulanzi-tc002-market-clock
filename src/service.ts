import { readClockInfo, pushClockPayload } from "./clock-client.ts";
import { loadConfig } from "./config.ts";
import { createControlHandler } from "./control-api.ts";
import { DashboardController } from "./controller.ts";
import { DEFAULT_SETTINGS, SettingsStore } from "./settings.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

const config = loadConfig();
const settingsStore = new SettingsStore(".runtime/settings.json");
let settings = DEFAULT_SETTINGS;
try {
  settings = await settingsStore.load();
} catch (error) {
  log("settings_load_failed", { error: errorMessage(error), fallback: "defaults" });
}

const controller = new DashboardController({
  config,
  settings,
  settingsStore,
  pushPayload: (payload) => pushClockPayload(config, payload),
});

let stopping = false;
let wakeSleep: (() => void) | undefined;

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
    appName: config.appName,
    selectedAssets: controller.getSettings().assets,
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
      const state = await controller.pushNow("scheduled");
      if (state.updateCount === 1 || state.updateCount % 10 === 0 || state.degraded) {
        log("dashboard_pushed", {
          assets: state.assets.map((asset) => asset.assetId),
          providers: state.assets.map((asset) => asset.provider),
          animationDurationMs: state.animationDurationMs,
          updateCount: state.updateCount,
          degraded: state.degraded,
        });
      }
    } catch (error) {
      log("update_failed", {
        error: errorMessage(error),
        consecutiveFailures: controller.getState().consecutiveFailures,
      });
    }

    await interruptibleSleep(controller.getEffectiveRefreshIntervalMs());
  }

  log("service_stopped");
}

await run();
