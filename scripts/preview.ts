import { mkdir } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { createPreviewStrip } from "../src/pixel-ui.ts";
import { MarketDataClient } from "../src/price.ts";
import { WorkspaceStore } from "../src/workspace.ts";
import { WorkspaceController } from "../src/workspace-controller.ts";
import { PixelAssetStore } from "../src/pixel-asset-store.ts";

const config = loadConfig({
  ...process.env,
  CLOCK_HOST: process.env.CLOCK_HOST || "preview.invalid",
});
const workspaceStore = new WorkspaceStore(
  ".runtime/workspace.json",
  ".runtime/settings.json",
  config.appName,
);
const workspace = await workspaceStore.load();
const controller = new WorkspaceController({
  config,
  workspace,
  workspaceStore,
  marketClient: new MarketDataClient({ timeoutMs: config.requestTimeoutMs }),
  pushPayload: async () => ({ status: 200 }),
  deleteApp: async () => ({ status: 200 }),
  pixelAssetStore: new PixelAssetStore(".runtime/pixel-assets"),
  // No vibeClient: AI usage is a firmware app now, so nothing a channel renders
  // asks for a usage snapshot and this pass must not talk to ten vendors.
});

await mkdir(".runtime/previews", { recursive: true });
const results: unknown[] = [];
for (const channel of workspace.channels) {
  try {
    const rendered = await controller.previewChannel(channel.id);
    const extension = rendered.mimeType === "image/gif" ? "gif" : "png";
    const deviceImage = `.runtime/previews/${channel.appName}.${extension}`;
    const previewImage = `.runtime/previews/${channel.appName}-strip.png`;
    await Bun.write(deviceImage, rendered.image);
    await Bun.write(previewImage, createPreviewStrip(rendered.frames.slice(0, 12), 8, 8));
    results.push({
      channel: channel.name,
      appName: channel.appName,
      contentIds: rendered.contentIds,
      frames: rendered.frames.length,
      animationDurationMs: rendered.animationDurationMs,
      deviceImage,
      previewImage,
      contentErrors: rendered.contentErrors,
    });
  } catch (error) {
    results.push({
      channel: channel.name,
      appName: channel.appName,
      error: error instanceof Error ? error.message : "preview failed",
    });
  }
}

console.log(JSON.stringify({ channels: results }, null, 2));
