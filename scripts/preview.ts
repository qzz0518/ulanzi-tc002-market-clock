import { mkdir } from "node:fs/promises";
import { ASSET_IDS } from "../src/assets.ts";
import { loadRequestTimeoutMs } from "../src/config.ts";
import {
  createPreviewStrip,
  createScaledPreview,
  renderAssetIconTile,
  renderDashboard,
} from "../src/pixel-ui.ts";
import { MarketDataClient } from "../src/price.ts";
import { SettingsStore } from "../src/settings.ts";

const requestTimeoutMs = loadRequestTimeoutMs();
const settings = await new SettingsStore(".runtime/settings.json").load();
const client = new MarketDataClient({ timeoutMs: requestTimeoutMs });
const results = await Promise.allSettled(
  settings.assets.map((assetId) => client.getAsset(assetId)),
);
const markets = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
if (markets.length === 0) throw new Error("none of the selected assets returned market data");
const frame = renderDashboard(markets, settings);

await mkdir(".runtime", { recursive: true });
const extension = frame.mimeType === "image/gif" ? "gif" : "png";
const deviceImage = `.runtime/market-ui-52x16.${extension}`;
await Bun.write(deviceImage, frame.image);
await Promise.all(
  frame.frames.map((canvas, index) =>
    Bun.write(`.runtime/market-ui-frame-${index + 1}.png`, canvas.toPng()),
  ),
);
await Promise.all(
  frame.frames.map((canvas, index) =>
    Bun.write(
      `.runtime/market-ui-frame-${index + 1}-preview.png`,
      createScaledPreview(canvas),
    ),
  ),
);
const previewImage = ".runtime/market-ui-preview-strip.png";
const iconImage = ".runtime/asset-icons-preview.png";
await Bun.write(previewImage, createPreviewStrip(frame.frames));
await Bun.write(
  iconImage,
  createPreviewStrip(ASSET_IDS.map((assetId) => renderAssetIconTile(assetId)), 16, 16),
);

console.log(
  JSON.stringify(
    {
      assets: frame.assetIds,
      label: frame.label,
      frames: frame.frames.length,
      frameDelaysMs: frame.frameDelaysMs,
      animationDurationMs: frame.animationDurationMs,
      deviceImage,
      previewImage,
      iconImage,
      failures: results.filter((result) => result.status === "rejected").length,
    },
    null,
    2,
  ),
);
