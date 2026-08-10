import { createSideloadRelease } from "../src/tc002-music-release.ts";

/**
 * Shared CLI body for staging a sideload release. The per-app entrypoints
 * (create-music-release.ts, create-arcade-release.ts) supply the appId and
 * release directory; argv carries `<source-dir> <version> [entry]`.
 */
export async function runCreateRelease(options: {
  appId: string;
  releaseDirectory: string;
  taskName: string;
}): Promise<void> {
  const [sourceDir, version, entry] = process.argv.slice(2);
  if (!sourceDir || !version) {
    console.error(`usage: bun run ${options.taskName} -- /path/to/bundle-dir 0.1.0 [entry]`);
    process.exit(2);
  }

  const manifest = await createSideloadRelease({
    sourceDir,
    version,
    ...(entry ? { entry } : {}),
    appId: options.appId,
    releaseDirectory: options.releaseDirectory,
  });
  console.log(
    `${options.appId} ${manifest.version} staged (entry ${manifest.entry}, `
      + `${manifest.files.length} files, bundleId ${manifest.bundleId})`,
  );
}
