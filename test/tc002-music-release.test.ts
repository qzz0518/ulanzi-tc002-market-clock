import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMusicRelease, createSideloadRelease } from "../src/tc002-music-release.ts";
import {
  ARCADE_SIDELOAD_PROFILE,
  MusicPlayerBundleStore,
} from "../src/tc002-music-installer.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("TC002 music sideload release staging", () => {
  test("copies a bundle directory and emits a per-file manifest the store accepts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc002-music-release-"));
    directories.push(root);
    const sourceDirectory = join(root, "build");
    const releaseDirectory = join(root, "release");
    await mkdir(join(sourceDirectory, "resources"), { recursive: true });
    await writeFile(join(sourceDirectory, "player"), new Uint8Array([1, 2, 3, 4]));
    await writeFile(join(sourceDirectory, "resources", "font.bin"), new Uint8Array([9, 9]));

    const manifest = await createMusicRelease({
      sourceDir: sourceDirectory,
      version: "0.1.0",
      releaseDirectory,
    });

    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.entry).toBe("player");
    expect(manifest.files.map((file) => file.path)).toEqual(["player", "resources/font.bin"]);
    expect(manifest.bundleId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(join(releaseDirectory, "manifest.json"), "utf8")))
      .toEqual(manifest);

    const inspected = await new MusicPlayerBundleStore(releaseDirectory).inspect();
    expect(inspected.state).toBe("ready");
    expect(inspected.fileCount).toBe(2);
    expect(inspected.bytes).toBe(6);
  });

  test("re-staging replaces the previous bundle instead of accreting stale files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc002-music-restage-"));
    directories.push(root);
    const releaseDirectory = join(root, "release");
    const firstSource = join(root, "first");
    await mkdir(firstSource, { recursive: true });
    await writeFile(join(firstSource, "player"), new Uint8Array([1]));
    await writeFile(join(firstSource, "stale.bin"), new Uint8Array([2]));
    await createMusicRelease({ sourceDir: firstSource, version: "0.1.0", releaseDirectory });

    const secondSource = join(root, "second");
    await mkdir(secondSource, { recursive: true });
    await writeFile(join(secondSource, "player"), new Uint8Array([3]));
    const manifest = await createMusicRelease({
      sourceDir: secondSource,
      version: "0.2.0",
      releaseDirectory,
    });

    expect(manifest.files.map((file) => file.path)).toEqual(["player"]);
    expect((await new MusicPlayerBundleStore(releaseDirectory).inspect()).state).toBe("ready");
  });

  test("stages an arcade bundle whose manifest only the arcade store accepts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc002-arcade-release-"));
    directories.push(root);
    const sourceDirectory = join(root, "build");
    const releaseDirectory = join(root, "release");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "player"), new Uint8Array([7, 7, 7]));
    await writeFile(join(sourceDirectory, "libzkgui.so"), new Uint8Array([1, 2]));

    const manifest = await createSideloadRelease({
      sourceDir: sourceDirectory,
      version: "0.1.0",
      appId: "tc002-arcade",
      releaseDirectory,
    });
    expect(manifest.appId).toBe("tc002-arcade");
    expect(manifest.schemaVersion).toBe(3);

    const arcadeStore = new MusicPlayerBundleStore(releaseDirectory, ARCADE_SIDELOAD_PROFILE);
    expect((await arcadeStore.inspect()).state).toBe("ready");
    // The music store must refuse it: appId is part of the manifest contract.
    const musicStore = new MusicPlayerBundleStore(releaseDirectory);
    expect((await musicStore.inspect()).state).toBe("invalid");
  });

  test("refuses a malformed appId before touching the filesystem layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc002-appid-release-"));
    directories.push(root);
    const sourceDirectory = join(root, "build");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "player"), new Uint8Array([1]));
    await expect(createSideloadRelease({
      sourceDir: sourceDirectory,
      version: "0.1.0",
      appId: "TC002 Arcade!",
      releaseDirectory: join(root, "release"),
    })).rejects.toThrow("appId");
  });

  test("refuses a source missing the declared entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc002-music-release-entry-"));
    directories.push(root);
    const sourceDirectory = join(root, "build");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "not-player"), new Uint8Array([1]));
    await expect(createMusicRelease({
      sourceDir: sourceDirectory,
      version: "0.1.0",
      releaseDirectory: join(root, "release"),
    })).rejects.toThrow("entry");
  });

  test("refuses an entry name that could break out of the shell command", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc002-music-release-inject-"));
    directories.push(root);
    const sourceDirectory = join(root, "build");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, "player"), new Uint8Array([1]));
    await expect(createMusicRelease({
      sourceDir: sourceDirectory,
      version: "0.1.0",
      entry: "player; reboot",
      releaseDirectory: join(root, "release"),
    })).rejects.toThrow("entry");
  });
});
