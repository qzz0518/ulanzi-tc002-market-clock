import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  computeBundleId,
  isValidBundleEntry,
  isValidBundlePath,
  type BundleFile,
} from "./tc002-music-installer.ts";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 512;

export interface MusicReleaseManifest {
  schemaVersion: 3;
  appId: "tc002-lyrics-player";
  version: string;
  entry: string;
  bundleId: string;
  files: BundleFile[];
}

export async function createMusicRelease(input: {
  sourceDir: string;
  version: string;
  entry?: string;
  releaseDirectory: string;
}): Promise<MusicReleaseManifest> {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(input.version)) {
    throw new Error("version must be semantic, for example 0.1.0");
  }
  const entry = input.entry ?? "player";
  if (!isValidBundleEntry(entry)) {
    throw new Error("entry must be a plain executable name inside the bundle, for example player");
  }

  const sourceDir = resolve(input.sourceDir);
  const sourceInfo = await stat(sourceDir);
  if (!sourceInfo.isDirectory()) {
    throw new Error("sideload source must be a directory containing the FlyThings build output");
  }

  const bundleDir = resolve(input.releaseDirectory, "bundle");
  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });
  await cp(sourceDir, bundleDir, { recursive: true });

  const files = await collectFiles(bundleDir);
  if (files.length < 1) throw new Error("sideload source directory is empty");
  if (files.length > MAX_FILES) throw new Error(`sideload bundle exceeds ${MAX_FILES} files`);
  if (!files.some((file) => file.path === entry)) {
    throw new Error(`entry "${entry}" is not present in the source directory`);
  }

  const manifest: MusicReleaseManifest = {
    schemaVersion: 3,
    appId: "tc002-lyrics-player",
    version: input.version,
    entry,
    bundleId: computeBundleId(files),
    files,
  };

  const temporaryManifest = join(
    input.releaseDirectory,
    `.manifest.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  await rename(temporaryManifest, join(input.releaseDirectory, "manifest.json"));
  return manifest;
}

async function collectFiles(bundleDir: string): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const dirent of entries) {
      const absolute = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!dirent.isFile()) {
        throw new Error(`sideload bundle may only contain regular files: ${dirent.name}`);
      }
      const path = relative(bundleDir, absolute).split(sep).join("/");
      if (!isValidBundlePath(path)) {
        throw new Error(`sideload file path is invalid: ${path}`);
      }
      const info = await stat(absolute);
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(`sideload file exceeds 256 MiB: ${path}`);
      }
      files.push({ path, bytes: info.size, sha256: await sha256File(absolute) });
    }
  };
  await walk(bundleDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}
