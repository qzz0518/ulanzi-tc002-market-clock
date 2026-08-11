import { resolve } from "node:path";
import { runCreateRelease } from "./create-release.ts";

await runCreateRelease({
  appId: "tc002-os",
  releaseDirectory: resolve(import.meta.dir, "../device/tc002-os/release"),
  taskName: "os-release",
});
