import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  ARCADE_SESSION_CONFIRMATION,
  ARCADE_SIDELOAD_PROFILE,
  computeBundleId,
  MUSIC_SESSION_CONFIRMATION,
  MUSIC_SIDELOAD_PROFILE,
  MusicInstallerError,
  MusicPlayerBundleStore,
  Tc002MusicInstaller,
  Tc002SideloadInstaller,
  type ProcessRunner,
  type SideloadProfile,
} from "../src/tc002-music-installer.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function releaseFixture(
  appId = "tc002-lyrics-player",
): Promise<{ directory: string; bundleId: string }> {
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
    appId,
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

// Both apps run through the identical lifecycle; only the profile-derived
// pieces (remote dir, confirmation, identity, extra cleanup) may differ.
const PROFILES: Array<{
  profile: SideloadProfile;
  remoteDir: string;
  extraCleanup: string;
  identity: string;
}> = [
  {
    profile: MUSIC_SIDELOAD_PROFILE,
    remoteDir: "/tmp/tc002-music",
    extraCleanup: "/tmp/track.mp3 ",
    // Legacy music bundles wrote no id file, so an id-less session still counts.
    identity: '{ [ "$(cat /tmp/tc002-sideload.id 2>/dev/null)" = "tc002-lyrics-player" ] || [ ! -f /tmp/tc002-sideload.id ]; }',
  },
  {
    profile: ARCADE_SIDELOAD_PROFILE,
    remoteDir: "/tmp/tc002-arcade",
    extraCleanup: "",
    identity: '[ "$(cat /tmp/tc002-sideload.id 2>/dev/null)" = "tc002-arcade" ]',
  },
];

describe("TC002 sideload session (both profiles)", () => {
  for (const { profile, remoteDir, extraCleanup, identity } of PROFILES) {
    const aliveCheck =
      `[ -f /tmp/EasyUI.cfg ] && [ "$(getprop init.svc.zkswe)" = "running" ] && ${identity} && echo running`;

    test(`${profile.appId}: starts a session on tmpfs with identity-aware checks`, async () => {
      const fixture = await releaseFixture(profile.appId);
      const calls: string[][] = [];
      const installer = new Tc002SideloadInstaller({
        clockHost: "192.0.2.20",
        profile,
        bundleStore: new MusicPlayerBundleStore(fixture.directory, profile),
        processRunner: fakeRunner(calls),
        verifyClock: async () => ({ mcuVersion: "T1.0.13", appVersion: "0.2.9" }),
        settleDelayMs: 0,
      });

      const result = await installer.startSession({
        confirmation: profile.confirmation,
        expectedBundleId: fixture.bundleId,
      });
      expect(result.state).toBe("running");
      expect(result.message).toBe(profile.copy.started);
      expect(calls).toContainEqual(["/tools/adb", "connect", "192.0.2.20:5555"]);
      expect(calls).toContainEqual([
        "/tools/adb", "-s", "192.0.2.20:5555", "push",
        `${join(fixture.directory, "bundle")}/.`, `${remoteDir}/`,
      ]);
      expect(calls.slice(-7).map((call) => call.at(-1))).toEqual([
        `[ -f ${remoteDir}/session.pid ] && kill "$(cat ${remoteDir}/session.pid)" 2>/dev/null; setprop ctl.stop zkswe`,
        // Start clears BOTH bundle dirs and the session id: switching between
        // the two apps must never push on top of a full tmpfs.
        `rm -rf /tmp/tc002-music /tmp/tc002-arcade /tmp/ui; rm -f ${extraCleanup}/tmp/EasyUI.cfg /tmp/libzkgui.so /tmp/tc002-sideload.id`,
        `mkdir -p ${remoteDir}`,
        `${remoteDir}/`,
        `chmod +x ${remoteDir}/player`,
        `(cd ${remoteDir} && ./player </dev/null >${remoteDir}/session.log 2>&1 & echo $! > ${remoteDir}/session.pid)`,
        aliveCheck,
      ]);
      const flat = calls.map((call) => call.join(" ")).join("\n");
      expect(flat).not.toContain("zkupgrade");
      expect(flat).not.toContain("update.img");
      expect(flat).not.toContain("nohup");
      expect((await installer.status()).session.active).toBe(true);
      expect(installer.sessionState().active).toBe(true);
    });

    test(`${profile.appId}: stop kills the app, removes the id file, and restores zkswe`, async () => {
      const fixture = await releaseFixture(profile.appId);
      const calls: string[][] = [];
      const installer = new Tc002SideloadInstaller({
        clockHost: "192.0.2.20",
        profile,
        bundleStore: new MusicPlayerBundleStore(fixture.directory, profile),
        processRunner: fakeRunner(calls),
        verifyClock: async () => ({}),
        settleDelayMs: 0,
      });
      await installer.startSession({
        confirmation: profile.confirmation,
        expectedBundleId: fixture.bundleId,
      });

      const result = await installer.stopSession();
      expect(result.state).toBe("official");
      expect(calls.slice(-3).map((call) => call.at(-1))).toEqual([
        `[ -f ${remoteDir}/session.pid ] && kill "$(cat ${remoteDir}/session.pid)" 2>/dev/null; killall player 2>/dev/null; true`,
        `rm -rf ${remoteDir} /tmp/ui; rm -f /tmp/EasyUI.cfg /tmp/libzkgui.so /tmp/tc002-sideload.id ${extraCleanup}`.trimEnd(),
        "setprop ctl.restart zkswe",
      ]);
      expect((await installer.status()).session.active).toBe(false);
    });

    test(`${profile.appId}: rollback removes the half-deployed config and the id file`, async () => {
      const fixture = await releaseFixture(profile.appId);
      const calls: string[][] = [];
      const installer = new Tc002SideloadInstaller({
        clockHost: "192.0.2.20",
        profile,
        bundleStore: new MusicPlayerBundleStore(fixture.directory, profile),
        processRunner: fakeRunner(calls, {
          failOn: (args) => typeof args.at(-1) === "string" && args.at(-1)!.includes("./player </dev/null"),
        }),
        verifyClock: async () => ({}),
        settleDelayMs: 0,
      });

      await expect(installer.startSession({
        confirmation: profile.confirmation,
        expectedBundleId: fixture.bundleId,
      })).rejects.toBeInstanceOf(MusicInstallerError);
      expect(calls.at(-1)?.at(-1)).toBe(
        "rm -f /tmp/EasyUI.cfg /tmp/tc002-sideload.id; setprop ctl.start zkswe",
      );
      expect((await installer.status()).session.active).toBe(false);
    });

    test(`${profile.appId}: refuses the other app's confirmation phrase`, async () => {
      const fixture = await releaseFixture(profile.appId);
      const calls: string[][] = [];
      const installer = new Tc002SideloadInstaller({
        clockHost: "192.0.2.20",
        profile,
        bundleStore: new MusicPlayerBundleStore(fixture.directory, profile),
        processRunner: fakeRunner(calls),
        verifyClock: async () => ({}),
        settleDelayMs: 0,
      });
      const wrong = profile.appId === "tc002-arcade"
        ? MUSIC_SESSION_CONFIRMATION
        : ARCADE_SESSION_CONFIRMATION;
      await expect(installer.startSession({
        confirmation: wrong,
        expectedBundleId: fixture.bundleId,
      })).rejects.toBeInstanceOf(MusicInstallerError);
      expect(calls).toHaveLength(0);
    });
  }

  test("the arcade store refuses a music manifest (appId mismatch)", async () => {
    const fixture = await releaseFixture("tc002-lyrics-player");
    const store = new MusicPlayerBundleStore(fixture.directory, ARCADE_SIDELOAD_PROFILE);
    const inspected = await store.inspect();
    expect(inspected.state).toBe("invalid");
    expect(inspected.appId).toBe("tc002-arcade");
  });

  test("a session with a foreign identity is not recognized as our own", async () => {
    // The device runs the arcade (id file says tc002-arcade); the music
    // installer's alive check must come back empty, flipping its session off.
    const fixture = await releaseFixture("tc002-lyrics-player");
    const calls: string[][] = [];
    const installer = new Tc002SideloadInstaller({
      clockHost: "192.0.2.20",
      profile: MUSIC_SIDELOAD_PROFILE,
      bundleStore: new MusicPlayerBundleStore(fixture.directory, MUSIC_SIDELOAD_PROFILE),
      processRunner: fakeRunner(calls, {
        // The identity clause fails on-device: nothing is printed.
        respond: (args) => args.at(-1)?.includes("echo running") ? "" : undefined,
      }),
      verifyClock: async () => ({ appVersion: "0.2.9" }),
    });
    const probe = await installer.probe();
    expect(probe.playerRunning).toBe(false);
  });
});

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
    expect(status.artifact.message).toContain("device/tc002-lyrics-player/README.md");
    expect(status.adb).toBe("missing");
    expect(status.session.active).toBe(false);
    expect(status.restore.steps.join("\n")).toContain("断电重启");
    expect(status.restore.steps.join("\n")).toContain("USB-C");
  });

  test("the arcade profile's missing-bundle message points at its own packaging doc", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc002-empty-bundle-"));
    directories.push(directory);
    const store = new MusicPlayerBundleStore(directory, ARCADE_SIDELOAD_PROFILE);
    const inspected = await store.inspect();
    expect(inspected.state).toBe("missing");
    expect(inspected.appId).toBe("tc002-arcade");
    expect(inspected.message).toContain("device/tc002-arcade/README.md");
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

  test("keeps recognizing a legacy id-less session as the music player's own", async () => {
    // The alive check must tolerate bundles built before the id file existed:
    // its shell contains the "no id file" escape hatch alongside the match.
    const fixture = await releaseFixture();
    const calls: string[][] = [];
    const installer = new Tc002MusicInstaller({
      clockHost: "192.0.2.20",
      bundleStore: new MusicPlayerBundleStore(fixture.directory),
      processRunner: fakeRunner(calls),
      verifyClock: async () => ({}),
    });
    const probe = await installer.probe();
    expect(probe.playerRunning).toBe(true);
    const aliveCall = calls.map((call) => call.at(-1)).find((arg) => arg?.includes("echo running"));
    expect(aliveCall).toContain('[ "$(cat /tmp/tc002-sideload.id 2>/dev/null)" = "tc002-lyrics-player" ]');
    expect(aliveCall).toContain("|| [ ! -f /tmp/tc002-sideload.id ]");
  });

  test("the arcade alive check has no legacy escape hatch", async () => {
    const fixture = await releaseFixture("tc002-arcade");
    const calls: string[][] = [];
    const installer = new Tc002SideloadInstaller({
      clockHost: "192.0.2.20",
      profile: ARCADE_SIDELOAD_PROFILE,
      bundleStore: new MusicPlayerBundleStore(fixture.directory, ARCADE_SIDELOAD_PROFILE),
      processRunner: fakeRunner(calls),
      verifyClock: async () => ({}),
    });
    await installer.probe();
    const aliveCall = calls.map((call) => call.at(-1)).find((arg) => arg?.includes("echo running"));
    expect(aliveCall).toContain('[ "$(cat /tmp/tc002-sideload.id 2>/dev/null)" = "tc002-arcade" ]');
    expect(aliveCall).not.toContain("|| [ ! -f /tmp/tc002-sideload.id ]");
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
    expect(calls.at(-1)?.at(-1)).toBe("rm -f /tmp/EasyUI.cfg /tmp/tc002-sideload.id; setprop ctl.start zkswe");
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
    expect(calls.at(-1)?.at(-1)).toBe("rm -f /tmp/EasyUI.cfg /tmp/tc002-sideload.id; setprop ctl.start zkswe");
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
