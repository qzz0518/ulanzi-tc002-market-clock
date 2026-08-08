import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build as buildWeb } from "vite";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist");
const entrypoints = [
  "src/service.ts",
  "scripts/status.ts",
  "scripts/preview.ts",
] as const;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await buildWeb({ configFile: join(root, "vite.config.ts") });

for (const entrypoint of entrypoints) {
  const result = await Bun.build({
    entrypoints: [join(root, entrypoint)],
    outdir,
    target: "bun",
    external: ["netease-cloud-music-api-alger"],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`failed to bundle ${entrypoint}`);
  }
}

await mkdir(join(outdir, "assets"), { recursive: true });
await copyFile(
  join(root, "src/assets/tc002-frame.png"),
  join(outdir, "assets/tc002-frame.png"),
);
await copyFile(
  join(root, "src/assets/demo-audio.mp3"),
  join(outdir, "assets/demo-audio.mp3"),
);
const cryptoIconsSource = join(root, "node_modules/cryptocurrency-icons");
const cryptoIconsOutput = join(outdir, "assets/crypto-icons");
await mkdir(join(cryptoIconsOutput, "128"), { recursive: true });
await Promise.all([
  copyFile(join(cryptoIconsSource, "manifest.json"), join(cryptoIconsOutput, "manifest.json")),
  copyFile(join(cryptoIconsSource, "LICENSE.md"), join(cryptoIconsOutput, "LICENSE.md")),
  cp(
    join(cryptoIconsSource, "128/color"),
    join(cryptoIconsOutput, "128/color"),
    { recursive: true },
  ),
]);

console.log("Built Cladd UI, service bundles, and runtime assets to dist/");
