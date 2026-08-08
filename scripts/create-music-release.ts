import { resolve } from "node:path";
import { createMusicRelease } from "../src/tc002-music-release.ts";

const [sourceDir, version, entry] = process.argv.slice(2);
if (!sourceDir || !version) {
  console.error("usage: bun run music-release -- /path/to/bundle-dir 0.1.0 [entry]");
  process.exit(2);
}

const releaseDirectory = resolve(import.meta.dir, "../device/tc002-lyrics-player/release");
const manifest = await createMusicRelease({
  sourceDir,
  version,
  ...(entry ? { entry } : {}),
  releaseDirectory,
});
console.log(
  `TC002 lyrics-player ${manifest.version} staged (entry ${manifest.entry}, `
    + `${manifest.files.length} files, bundleId ${manifest.bundleId})`,
);
