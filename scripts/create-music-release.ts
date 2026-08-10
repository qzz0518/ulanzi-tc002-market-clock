import { resolve } from "node:path";
import { runCreateRelease } from "./create-release.ts";

await runCreateRelease({
  appId: "tc002-lyrics-player",
  releaseDirectory: resolve(import.meta.dir, "../device/tc002-lyrics-player/release"),
  taskName: "music-release",
});
