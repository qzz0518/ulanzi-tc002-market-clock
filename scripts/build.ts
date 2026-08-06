import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist");
const entrypoints = [
  "src/service.ts",
  "scripts/status.ts",
  "scripts/preview.ts",
] as const;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

for (const entrypoint of entrypoints) {
  const result = await Bun.build({
    entrypoints: [join(root, entrypoint)],
    outdir,
    target: "bun",
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

console.log("Built service bundles and copied runtime assets to dist/");
