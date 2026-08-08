import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  computeBundleId,
  MUSIC_SESSION_CONFIRMATION,
  MusicInstallerError,
  MusicPlayerBundleStore,
  Tc002MusicInstaller,
  type ProcessRunner,
} from "../src/tc002-music-installer.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function releaseFixture(): Promise<{ directory: string; bundleId: string }> {
  const directory = await mkdtemp(join(tmpdir(), "tc002-bundle-"));
  directories.push(directory);
  const bundleDir = join(directory, "bundle");
  await mkdir(bundleDir, { recursive: true });
  const bytes = new Uint8Array([84, 67, 48, 48, 50]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(bundleDir, "player"), bytes);
  const files = [{ path: "player", bytes: bytes.byteLength, sha256 }];
  const bundleId = computeBundleId(files);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    schemaVersion: 3,
    appId: "tc002-lyrics-player",
    version: "0.1.0",
    entry: "player",
    bundleId,
    files,
  }));
  return { directory, bundleId };
}

function fakeRunner(calls: string[][], overrides?: {
  failOn?: (args: string[]) => boolean;
  respond?: (args: string[]) => string | undefined;
}): ProcessRunner {
  return {
    which: (command) => command === "adb" ? "/tools/adb" : null,
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (overrides?.failOn?.(args)) {
        return { exitCode: 1, stdout: "", stderr: "boom" };
      }
      const responded = overrides?.respond?.(args);
      if (responded !== undefined) {
        return { exitCode: 0, stdout: responded, stderr: "" };
      }
      if (args.at(-1) === "ro.product.model") {
        return { exitCode: 0, stdout: "Ulanzi TC002\n", stderr: "" };
      }
      if (args.at(-1) === "ro.product.platform") {
        return { exitCode: 0, stdout: "Z21\n", stderr: "" };
      }
      if (args.at(-1)?.includes("echo running")) {
        return { exitCode: 0, stdout: "running\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "connected\n", stderr: "" };
    },
  };
}

describe("TC002 music sideload session", () => {
  test("uses the configured absolute adb path when the service PATH is restricted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc002-empty-bundle-"));
    directories.push(directory);
    const calls: string[][] = [];
    const configuredAdb = "/opt/homebrew/bin/adb";
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(directory),
      adbPath: configuredAdb,
      processRunner: {
        which: (command) => command === configuredAdb ? configuredAdb : null,
        run: async (command, args) => {
          calls.push([command, ...args]);
          return { exitCode: 0, stdout: "connected\n", stderr: "" };
        },
      },
      verifyClock: async () => ({}),
    });

    expect((await installer.status()).adb).toBe("ready");
    expect((await installer.probe()).connected).toBe(true);
    expect(calls[0]).toEqual([configuredAdb, "connect", "192.0.2.20:5555"]);
  });

  test("rejects a relative ADB_BIN before any command can run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc002-empty-bundle-"));
    directories.push(directory);
    expect(() => new Tc002MusicInstaller({
      clockHost: "tc002.local",
      bundleStore: new MusicPlayerBundleStore(directory),
      adbPath: "bin/adb",
      verifyClock: async () => ({}),
    })).toThrow("ADB_BIN must be an absolute executable path");
  });

  test("reports a missing bundle and a power-cycle restore path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc002-empty-bundle-"));
    directories.push(directory);
    const installer = new Tc002MusicInstaller({
      clockHost: "tc002.local",
      bundleStore: new MusicPlayerBundleStore(directory),
      processRunner: { which: () => null, run: async () => { throw new Error("not called"); } },
      verifyClock: async () => ({}),
    });
    const status = await installer.status();
    expect(status.artifact.state).toBe("missing");
    expect(status.adb).toBe("missing");
    expect(status.session.active).toBe(false);
    expect(status.restore.steps.join("\n")).toContain("断电重启");
    expect(status.restore.steps.join("\n")).toContain("USB-C");
  });

  test("rejects a stale confirmation before running any ADB command", async () => {
    const fixture = await releaseFixture();
    const calls: string[][] = [];
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(fixture.directory),
      processRunner: fakeRunner(calls),
      verifyClock: async () => ({ appVersion: "0.2.9" }),
    });
    await expect(installer.startSession({
      confirmation: "",
      expectedBundleId: fixture.bundleId,
    })).rejects.toBeInstanceOf(MusicInstallerError);
    expect(calls).toHaveLength(0);
  });

  test("starts a session on tmpfs and pauses the official UI without flashing", async () => {
    const fixture = await releaseFixture();
    const calls: string[][] = [];
    let verified = false;
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(fixture.directory),
      processRunner: fakeRunner(calls),
      verifyClock: async () => {
        verified = true;
        return { mcuVersion: "T1.0.13", appVersion: "0.2.9" };
      },
      settleDelayMs: 0,
    });

    const result = await installer.startSession({
      confirmation: MUSIC_SESSION_CONFIRMATION,
      expectedBundleId: fixture.bundleId,
    });
    expect(verified).toBe(true);
    expect(result.state).toBe("running");
    expect(calls).toContainEqual(["/tools/adb", "connect", "192.0.2.20:5555"]);
    expect(calls).toContainEqual([
      "/tools/adb", "-s", "192.0.2.20:5555", "push",
      `${join(fixture.directory, "bundle")}/.`, "/tmp/tc002-music/",
    ]);
    expect(calls.slice(-7).map((call) => call.at(-1))).toEqual([
      '[ -f /tmp/tc002-music/session.pid ] && kill "$(cat /tmp/tc002-music/session.pid)" 2>/dev/null; setprop ctl.stop zkswe',
      "rm -rf /tmp/tc002-music /tmp/ui; rm -f /tmp/track.mp3 /tmp/EasyUI.cfg /tmp/libzkgui.so",
      "mkdir -p /tmp/tc002-music",
      "/tmp/tc002-music/",
      "chmod +x /tmp/tc002-music/player",
      "(cd /tmp/tc002-music && ./player </dev/null >/tmp/tc002-music/session.log 2>&1 & echo $! > /tmp/tc002-music/session.pid)",
      '[ -f /tmp/EasyUI.cfg ] && [ "$(getprop init.svc.zkswe)" = "running" ] && echo running',
    ]);
    const flat = calls.map((call) => call.join(" ")).join("\n");
    expect(flat).not.toContain("zkupgrade");
    expect(flat).not.toContain("update.img");
    expect(flat).not.toContain("tar");
    expect(flat).not.toContain("nohup");
    expect((await installer.status()).session.active).toBe(true);
  });

  test("injects the current service origin next to the pushed bundle", async () => {
    const fixture = await releaseFixture();
    const calls: string[][] = [];
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(fixture.directory),
      processRunner: fakeRunner(calls),
      verifyClock: async () => ({}),
      serviceOrigin: async () => "http://192.0.2.5:43820",
      settleDelayMs: 0,
    });
    await installer.startSession({
      confirmation: MUSIC_SESSION_CONFIRMATION,
      expectedBundleId: fixture.bundleId,
    });
    expect(calls.map((call) => call.at(-1))).toContain(
      "echo 'http://192.0.2.5:43820' > /tmp/tc002-music/service.origin",
    );
  });

  test("restarts the official UI when the player fails to launch", async () => {
    const fixture = await releaseFixture();
    const calls: string[][] = [];
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(fixture.directory),
      processRunner: fakeRunner(calls, {
        failOn: (args) => typeof args.at(-1) === "string" && args.at(-1)!.includes("./player </dev/null"),
      }),
      verifyClock: async () => ({}),
      settleDelayMs: 0,
    });

    await expect(installer.startSession({
      confirmation: MUSIC_SESSION_CONFIRMATION,
      expectedBundleId: fixture.bundleId,
    })).rejects.toBeInstanceOf(MusicInstallerError);
    expect(calls.at(-1)?.at(-1)).toBe("rm -f /tmp/EasyUI.cfg; setprop ctl.start zkswe");
    expect((await installer.status()).session.active).toBe(false);
  });

  test("rolls back when the framework does not come up on the sideloaded config", async () => {
    const fixture = await releaseFixture();
    const calls: string[][] = [];
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(fixture.directory),
      processRunner: fakeRunner(calls, {
        respond: (args) => args.at(-1)?.includes("echo running") ? "" : undefined,
      }),
      verifyClock: async () => ({}),
      settleDelayMs: 0,
    });
    await expect(installer.startSession({
      confirmation: MUSIC_SESSION_CONFIRMATION,
      expectedBundleId: fixture.bundleId,
    })).rejects.toBeInstanceOf(MusicInstallerError);
    expect(calls.at(-1)?.at(-1)).toBe("rm -f /tmp/EasyUI.cfg; setprop ctl.start zkswe");
    expect((await installer.status()).session.active).toBe(false);
  });

  test("rejects a stale page bundleId with a conflict", async () => {
    const fixture = await releaseFixture();
    const calls: string[][] = [];
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(fixture.directory),
      processRunner: fakeRunner(calls),
      verifyClock: async () => ({}),
      settleDelayMs: 0,
    });
    await expect(installer.startSession({
      confirmation: MUSIC_SESSION_CONFIRMATION,
      expectedBundleId: "a".repeat(64),
    })).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });

  test("stops the session by killing the player and restoring the official UI", async () => {
    const fixture = await releaseFixture();
    const calls: string[][] = [];
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(fixture.directory),
      processRunner: fakeRunner(calls),
      verifyClock: async () => ({}),
      settleDelayMs: 0,
    });
    await installer.startSession({
      confirmation: MUSIC_SESSION_CONFIRMATION,
      expectedBundleId: fixture.bundleId,
    });

    const result = await installer.stopSession();
    expect(result.state).toBe("official");
    expect(calls.slice(-3).map((call) => call.at(-1))).toEqual([
      '[ -f /tmp/tc002-music/session.pid ] && kill "$(cat /tmp/tc002-music/session.pid)" 2>/dev/null; killall player 2>/dev/null; true',
      "rm -rf /tmp/tc002-music /tmp/ui; rm -f /tmp/EasyUI.cfg /tmp/libzkgui.so /tmp/track.mp3",
      "setprop ctl.restart zkswe",
    ]);
    expect((await installer.status()).session.active).toBe(false);
  });

  test("marks the session inactive when a power cycle already restored the device", async () => {
    const fixture = await releaseFixture();
    const calls: string[][] = [];
    let started = false;
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(fixture.directory),
      processRunner: fakeRunner(calls, {
        respond: (args) =>
          args.at(-1)?.includes("echo running") ? (started ? "" : "running\n") : undefined,
      }),
      verifyClock: async () => ({}),
      settleDelayMs: 0,
    });
    await installer.startSession({
      confirmation: MUSIC_SESSION_CONFIRMATION,
      expectedBundleId: fixture.bundleId,
    });
    started = true;
    expect((await installer.status()).session.active).toBe(true);

    const probe = await installer.probe();
    expect(probe.playerRunning).toBe(false);
    expect((await installer.status()).session.active).toBe(false);
  });
});
