import { resolve } from "node:path";
import { runCreateRelease } from "./create-release.ts";

await runCreateRelease({
  appId: "tc002-arcade",
  releaseDirectory: resolve(import.meta.dir, "../device/tc002-arcade/release"),
  taskName: "arcade-release",
});
