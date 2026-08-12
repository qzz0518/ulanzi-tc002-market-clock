import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const MUSIC_SESSION_CONFIRMATION = "START_TC002_MUSIC_SESSION";
export const ARCADE_SESSION_CONFIRMATION = "START_TC002_ARCADE_SESSION";
export const OS_SESSION_CONFIRMATION = "START_TC002_OS_SESSION";

/**
 * The sideload stack is shared by every sideloadable TC002 app (ADR 0004): the
 * installer class encodes the tmpfs/busybox constraints once, and a profile
 * carries the per-app facts. Both apps claim the same framework load path
 * (/tmp/EasyUI.cfg + zkswe restart), so they are mutually exclusive by
 * construction.
 */
export interface SideloadProfile {
  appId: string;             // manifest appId; also the session identity value
  slug: string;              // remote bundle dir = /tmp/tc002-<slug>
  confirmation: string;      // explicit user acknowledgement phrase
  releaseDirectory: string;
  packagingDoc: string;      // where the missing-bundle message points to
  extraCleanupPaths: string[]; // extra /tmp files this app leaves behind
  copy: { running: string; started: string };
}

export const MUSIC_SIDELOAD_PROFILE: SideloadProfile = {
  appId: "tc002-lyrics-player",
  slug: "music",
  confirmation: MUSIC_SESSION_CONFIRMATION,
  releaseDirectory: "device/tc002-lyrics-player/release",
  packagingDoc: "device/tc002-lyrics-player/README.md",
  extraCleanupPaths: ["/tmp/track.mp3"],
  copy: {
    running: "设备在线，音乐固件正在运行",
    started: "音乐固件已在时钟内存运行；点「恢复官方固件」或断电重启即可回到原样",
  },
};

export const ARCADE_SIDELOAD_PROFILE: SideloadProfile = {
  appId: "tc002-arcade",
  slug: "arcade",
  confirmation: ARCADE_SESSION_CONFIRMATION,
  releaseDirectory: "device/tc002-arcade/release",
  packagingDoc: "device/tc002-arcade/README.md",
  extraCleanupPaths: [],
  copy: {
    running: "设备在线，游戏固件正在运行",
    started: "游戏固件已在时钟内存运行；点「恢复官方固件」或断电重启即可回到原样",
  },
};

export const OS_SIDELOAD_PROFILE: SideloadProfile = {
  appId: "tc002-os",
  slug: "os",
  confirmation: OS_SESSION_CONFIRMATION,
  releaseDirectory: "device/tc002-os/release",
  packagingDoc: "device/tc002-os/README.md",
  extraCleanupPaths: [],
  copy: {
    running: "设备在线，系统固件正在运行",
    started: "系统固件已在时钟内存运行；点「恢复官方固件」或断电重启即可回到原样",
  },
};

// Both apps' entry scripts write their appId here so each installer can tell
// whose session is live; the file lives in tmpfs like everything else.
const SESSION_ID_FILE = "/tmp/tc002-sideload.id";
// Every remote dir any profile may have used; the start cleanup clears them
// all so switching apps never pushes on top of a full tmpfs.
const ALL_REMOTE_DIRS = ["/tmp/tc002-music", "/tmp/tc002-arcade", "/tmp/tc002-os"] as const;

function remoteDir(profile: SideloadProfile): string {
  return `/tmp/tc002-${profile.slug}`;
}

// A firmware session counts as alive while the framework is up on the
// sideloaded /tmp config AND the identity file names this app. The entry
// script deploys and exits (the device busybox has no `sleep`, so it cannot
// linger), so no PID is watched. Music bundles released before the id file
// existed write none: an id-less session can only be the music player's own
// (backward compatible per ADR 0004), while every other app requires an
// exact match.
function sessionAliveCheck(profile: SideloadProfile): string {
  const identity = `[ "$(cat ${SESSION_ID_FILE} 2>/dev/null)" = "${profile.appId}" ]`;
  const match = profile.appId === MUSIC_SIDELOAD_PROFILE.appId
    ? `{ ${identity} || [ ! -f ${SESSION_ID_FILE} ]; }`
    : identity;
  return `[ -f /tmp/EasyUI.cfg ] && [ "$(getprop init.svc.zkswe)" = "running" ] && ${match} && echo running`;
}

function assertSafeProfile(profile: SideloadProfile): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile.appId)) {
    throw new Error("sideload profile appId is invalid");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(profile.slug)) {
    throw new Error("sideload profile slug is invalid");
  }
  for (const path of profile.extraCleanupPaths) {
    // The paths are embedded into an adb shell command line; keep them plain.
    if (!/^\/tmp\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path)) {
      throw new Error(`sideload profile cleanup path is invalid: ${path}`);
    }
  }
}

export interface MusicPlayerBundle {
  state: "missing" | "invalid" | "ready";
  appId: string;
  version?: string;
  entry?: string;
  bundleId?: string;
  fileCount?: number;
  bytes?: number;
  message: string;
}

export interface MusicDeviceProbe {
  adb: "missing" | "ready";
  connected: boolean;
  model?: string;
  platform?: string;
  appVersion?: string;
  mcuVersion?: string;
  playerRunning?: boolean;
  message: string;
}

export interface MusicSessionState {
  active: boolean;
  version?: string;
  startedAt?: string;
}

export interface MusicDeviceAppStatus {
  artifact: MusicPlayerBundle;
  adb: "missing" | "ready";
  busy: boolean;
  session: MusicSessionState;
  restore: {
    title: string;
    steps: string[];
  };
}

export interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface BundleManifest {
  schemaVersion: 3;
  appId: string;
  version: string;
  entry: string;
  bundleId: string;
  files: BundleFile[];
}

interface ReadyBundle {
  manifest: BundleManifest;
  bundleDir: string;
  bytes: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  which(command: string): string | null;
  run(command: string, args: string[], timeoutMs: number): Promise<ProcessResult>;
}

export const defaultProcessRunner: ProcessRunner = {
  which(command) {
    if (!isAbsolute(command)) return Bun.which(command);
    try {
      accessSync(command, fsConstants.X_OK);
      return command;
    } catch {
      return null;
    }
  },
  async run(command, args, timeoutMs) {
    const child = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timeout));
    if (timedOut) throw new MusicInstallerError("ADB 操作超时，请确认设备与电脑在同一网络", 504);
    return {
      exitCode,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    };
  },
};

// The name is load-bearing: control-api maps this error class to HTTP status
// codes for every sideloadable app, not only music.
export class MusicInstallerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "MusicInstallerError";
  }
}

export class MusicPlayerBundleStore {
  private readonly appId: string;
  private readonly packagingDoc: string;

  constructor(
    private readonly releaseDirectory: string,
    profile?: Pick<SideloadProfile, "appId" | "packagingDoc">,
  ) {
    this.appId = profile?.appId ?? MUSIC_SIDELOAD_PROFILE.appId;
    this.packagingDoc = profile?.packagingDoc ?? MUSIC_SIDELOAD_PROFILE.packagingDoc;
  }

  async inspect(): Promise<MusicPlayerBundle> {
    try {
      const bundle = await this.requireReady();
      return {
        state: "ready",
        appId: bundle.manifest.appId,
        version: bundle.manifest.version,
        entry: bundle.manifest.entry,
        bundleId: bundle.manifest.bundleId,
        fileCount: bundle.manifest.files.length,
        bytes: bundle.bytes,
        message: "固件包完整性校验通过（逐文件 SHA-256），可以侧载到时钟",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          state: "missing",
          appId: this.appId,
          message: `还没有固件包：按 ${this.packagingDoc} 打包 FlyThings 构建产物`,
        };
      }
      return {
        state: "invalid",
        appId: this.appId,
        message: error instanceof Error ? error.message : "固件包校验失败",
      };
    }
  }

  async requireReady(): Promise<ReadyBundle> {
    const manifestPath = join(this.releaseDirectory, "manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    const manifest = validateManifest(raw, this.appId);
    const bundleDir = join(this.releaseDirectory, "bundle");
    let bytes = 0;
    for (const file of manifest.files) {
      const filePath = join(bundleDir, file.path);
      // join collapses any traversal, so re-check the result stays inside.
      if (!filePath.startsWith(bundleDir + "/")) {
        throw new MusicInstallerError("固件清单包含非法文件路径");
      }
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size !== file.bytes) {
        throw new MusicInstallerError(`固件文件大小与清单不一致：${file.path}`);
      }
      if (await sha256File(filePath) !== file.sha256) {
        throw new MusicInstallerError(`固件文件 SHA-256 与清单不一致：${file.path}`);
      }
      bytes += file.bytes;
    }
    if (computeBundleId(manifest.files) !== manifest.bundleId) {
      throw new MusicInstallerError("固件清单的 bundleId 与文件列表不一致");
    }
    return { manifest, bundleDir, bytes };
  }
}

/**
 * Path-A device model: the sideload session deploys the FlyThings app into
 * the framework's /tmp load path and restarts the UI service (zkswe) on it.
 * A session counts as alive while /tmp/EasyUI.cfg exists, zkswe runs, and the
 * identity file names this profile's app. Nothing is written to flash, so
 * restoring — or simply power-cycling the clock — always returns the device
 * to the official firmware.
 */
export class Tc002SideloadInstaller {
  private busy = false;
  private session: MusicSessionState = { active: false };
  private readonly profile: SideloadProfile;
  private readonly remoteDir: string;
  // A shebang entry runs as `sh`, so pidof/killall on the entry name are not
  // reliable; the launcher records $! into this file for the pre-launch cleanup.
  private readonly remotePid: string;
  private readonly aliveCheck: string;

  constructor(private readonly options: {
    clockHost: string;
    bundleStore: MusicPlayerBundleStore;
    profile?: SideloadProfile;
    adbPath?: string;
    processRunner?: ProcessRunner;
    verifyClock: () => Promise<{ mcuVersion?: string; appVersion?: string }>;
    serviceOrigin?: () => Promise<string | null>;
    settleDelayMs?: number;
    now?: () => Date;
    /**
     * True when the device's flash holds ZOS rather than the stock firmware.
     *
     * It changes what "restore" means, and in the direction that matters: a
     * power cycle on a flashed unit brings ZOS back, not Ulanzi's app. Telling
     * a user otherwise sends them to pull the plug expecting their clock and
     * hand them the thing they were trying to leave. Injected rather than
     * detected here because only the device knows, and it says so in its
     * telemetry.
     */
    zosFlashed?: () => boolean;
  }) {
    if (!isSafeHost(options.clockHost)) throw new Error("TC002 host is invalid for ADB");
    const adbPath = options.adbPath?.trim();
    if (adbPath && (!isAbsolute(adbPath) || adbPath.length > 1_024 || /[\r\n\0]/.test(adbPath))) {
      throw new Error("ADB_BIN must be an absolute executable path");
    }
    this.profile = options.profile ?? MUSIC_SIDELOAD_PROFILE;
    assertSafeProfile(this.profile);
    this.remoteDir = remoteDir(this.profile);
    this.remotePid = `${this.remoteDir}/session.pid`;
    this.aliveCheck = sessionAliveCheck(this.profile);
  }

  async status(): Promise<MusicDeviceAppStatus> {
    return {
      artifact: await this.options.bundleStore.inspect(),
      adb: this.adb ? "ready" : "missing",
      busy: this.busy,
      session: { ...this.session },
      restore: restoreGuide(this.options.zosFlashed?.() === true),
    };
  }

  // Cheap in-memory read for liveness endpoints: no adb round-trip, no disk.
  sessionState(): MusicSessionState {
    return { ...this.session };
  }

  async probe(): Promise<MusicDeviceProbe> {
    // adbd on the device accepts essentially one session, so every public
    // entrypoint that touches adb serializes through the busy flag.
    if (this.busy) throw new MusicInstallerError("设备操作进行中，请稍后再试", 409);
    this.busy = true;
    try {
      return await this.probeInternal();
    } finally {
      this.busy = false;
    }
  }

  // Unlocked variant for startSession, which already holds the busy flag.
  private async probeInternal(): Promise<MusicDeviceProbe> {
    const adb = this.adb;
    if (!adb) {
      return {
        adb: "missing",
        connected: false,
        message: this.options.adbPath
          ? "后台配置的 adb 不可执行；请重新运行安装脚本刷新 ADB_BIN"
          : "后台服务没有找到 adb；请重新运行安装脚本写入 ADB_BIN",
      };
    }

    const target = this.target;
    const connection = await this.runner.run(adb, ["connect", target], 12_000);
    if (connection.exitCode !== 0 || /failed|unable|refused/i.test(`${connection.stdout}\n${connection.stderr}`)) {
      throw new MusicInstallerError("ADB 无法连接 TC002，请确认 Wi-Fi、IP 和调试状态", 503);
    }
    const playerRunning = await this.refreshSession(adb);
    let clock: { mcuVersion?: string; appVersion?: string } = {};
    try {
      clock = await this.options.verifyClock();
    } catch (error) {
      // The official HTTP API lives in the official firmware; while a
      // sideloaded firmware runs it is expected to be gone, so its absence is
      // only fatal when this profile's app is not running either.
      if (playerRunning !== true) throw error;
    }
    const [model, platform] = await Promise.all([
      this.adbProperty(adb, "ro.product.model"),
      this.adbProperty(adb, "ro.product.platform"),
    ]);
    return {
      adb: "ready",
      connected: true,
      ...(model ? { model } : {}),
      ...(platform ? { platform } : {}),
      ...(clock.appVersion ? { appVersion: clock.appVersion } : {}),
      ...(clock.mcuVersion ? { mcuVersion: clock.mcuVersion } : {}),
      ...(playerRunning === undefined ? {} : { playerRunning }),
      message: playerRunning
        ? this.profile.copy.running
        : "已通过官方 HTTP 接口和 Wi-Fi ADB 双重确认设备",
    };
  }

  async startSession(input: {
    confirmation: string;
    expectedBundleId: string;
  }): Promise<{ state: "running"; message: string; restore: MusicDeviceAppStatus["restore"] }> {
    if (input.confirmation !== this.profile.confirmation) {
      throw new MusicInstallerError("请先确认已了解如何回到官方固件");
    }
    if (!/^[a-f0-9]{64}$/.test(input.expectedBundleId)) {
      throw new MusicInstallerError("固件包校验值无效");
    }
    if (this.busy) throw new MusicInstallerError("设备操作进行中，请勿重复提交", 409);

    this.busy = true;
    try {
      const bundle = await this.options.bundleStore.requireReady();
      if (bundle.manifest.bundleId !== input.expectedBundleId) {
        throw new MusicInstallerError("页面中的固件包版本已经变化，请刷新后重新确认", 409);
      }
      await this.probeInternal();
      const adb = this.adb;
      if (!adb) throw new MusicInstallerError("本机没有找到 adb", 503);
      const entry = bundle.manifest.entry;

      // Stop the old world before deleting its files: on tmpfs, unlinking a
      // file that a live process still maps keeps the space pinned, so a
      // repeat sideload would otherwise push on top of a full tmpfs and wedge
      // adbd. Kill any previous session process, then stop the UI service.
      await this.requireCommand(
        adb,
        this.shell(`[ -f ${this.remotePid} ] && kill "$(cat ${this.remotePid})" 2>/dev/null; setprop ctl.stop zkswe`),
        10_000,
      );
      try {
        // The device busybox has no tar/unzip, so the bundle directory is pushed
        // recursively; `dir/.` copies its contents straight into the remote dir.
        // tmpfs is tiny: clear every leftover from a previous session (either
        // app's bundle dir, old audio, the framework's /tmp load path, the
        // session identity) BEFORE pushing, or adbd wedges mid-transfer.
        const cleanupFiles = [
          ...this.profile.extraCleanupPaths,
          "/tmp/EasyUI.cfg",
          "/tmp/libzkgui.so",
          SESSION_ID_FILE,
        ].join(" ");
        await this.requireCommand(
          adb,
          this.shell(`rm -rf ${ALL_REMOTE_DIRS.join(" ")} /tmp/ui; rm -f ${cleanupFiles}`),
          10_000,
        );
        await this.requireCommand(adb, this.shell(`mkdir -p ${this.remoteDir}`), 10_000);
        await this.requireCommand(
          adb,
          ["-s", this.target, "push", `${bundle.bundleDir}/.`, `${this.remoteDir}/`],
          180_000,
        );
        // Zero-config key: the firmware reads this file on startup to learn the
        // service origin, so the same binary works on any network without a rebuild.
        const origin = this.options.serviceOrigin ? await this.options.serviceOrigin() : null;
        if (origin !== null) {
          if (!/^http:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(origin)) {
            throw new MusicInstallerError("服务地址格式异常，无法写入设备");
          }
          await this.requireCommand(
            adb,
            this.shell(`echo '${origin}' > ${this.remoteDir}/service.origin`),
            10_000,
          );
        }
        await this.requireCommand(adb, this.shell(`chmod +x ${this.remoteDir}/${entry}`), 10_000);
        // The device busybox has no nohup/setsid, so detach with a subshell:
        // the background child is reparented to init when the subshell exits,
        // letting the adb command return instead of blocking on the process.
        // The entry deploys the /tmp load path (and writes the session id),
        // restarts the framework, and exits; its exit code is invisible here,
        // so the deploy is verified explicitly right after.
        await this.requireCommand(
          adb,
          this.shell(
            `(cd ${this.remoteDir} && ./${entry} </dev/null >${this.remoteDir}/session.log 2>&1 & echo $! > ${this.remotePid})`,
          ),
          15_000,
        );
        await new Promise((resolve) => setTimeout(resolve, this.options.settleDelayMs ?? 2_500));
        const deployed = await this.runner.run(adb, this.shell(this.aliveCheck), 8_000);
        if (deployed.exitCode !== 0 || !deployed.stdout.includes("running")) {
          throw new MusicInstallerError("固件未能在时钟上启动；已尝试恢复官方界面，请重新检测后再试", 503);
        }
      } catch (error) {
        // The official UI was already stopped; drop any half-deployed /tmp
        // config and bring it back before failing so the clock never stays on
        // a dead screen. Whatever session existed before was terminated by the
        // kill+stop above, so the in-memory state must not claim it survived.
        await this.runner.run(
          adb,
          this.shell(`rm -f /tmp/EasyUI.cfg ${SESSION_ID_FILE}; setprop ctl.start zkswe`),
          10_000,
        ).catch(() => undefined);
        this.session = { active: false };
        throw error;
      }

      this.session = {
        active: true,
        version: bundle.manifest.version,
        startedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      return {
        state: "running",
        message: this.profile.copy.started,
        restore: restoreGuide(this.options.zosFlashed?.() === true),
      };
    } finally {
      this.busy = false;
    }
  }

  async stopSession(): Promise<{ state: "official"; message: string; restore: MusicDeviceAppStatus["restore"] }> {
    if (this.busy) throw new MusicInstallerError("设备操作进行中，请勿重复提交", 409);
    this.busy = true;
    try {
      const adb = this.adb;
      if (!adb) throw new MusicInstallerError("本机没有找到 adb", 503);
      const entry = await this.knownEntry();
      await this.runner.run(
        adb,
        this.shell(
          `[ -f ${this.remotePid} ] && kill "$(cat ${this.remotePid})" 2>/dev/null; `
            + (entry ? `killall ${entry} 2>/dev/null; ` : "")
            + "true",
        ),
        10_000,
      ).catch(() => undefined);
      // The cleanup must actually succeed: if /tmp/EasyUI.cfg survived, the
      // restart below would boot the sideloaded app again while we report
      // "official".
      const cleanupFiles = [
        "/tmp/EasyUI.cfg",
        "/tmp/libzkgui.so",
        SESSION_ID_FILE,
        ...this.profile.extraCleanupPaths,
      ].join(" ");
      await this.requireCommand(
        adb,
        this.shell(`rm -rf ${this.remoteDir} /tmp/ui; rm -f ${cleanupFiles}`),
        15_000,
      );
      // Restart instead of start: with the firmware bundle the framework is
      // already running the sideloaded app, so it must reload now that the
      // /tmp config is gone; for a stopped service restart behaves like start.
      await this.requireCommand(adb, this.shell("setprop ctl.restart zkswe"), 10_000);
      this.session = { active: false };
      return {
        state: "official",
        message: "官方界面已恢复；如显示异常，直接断电重启即可",
        restore: restoreGuide(this.options.zosFlashed?.() === true),
      };
    } finally {
      this.busy = false;
    }
  }

  private shell(command: string): string[] {
    return ["-s", this.target, "shell", command];
  }

  private async knownEntry(): Promise<string | undefined> {
    try {
      return (await this.options.bundleStore.requireReady()).manifest.entry;
    } catch {
      return undefined;
    }
  }

  private async refreshSession(adb: string): Promise<boolean | undefined> {
    const result = await this.runner
      .run(adb, this.shell(this.aliveCheck), 8_000)
      .catch(() => undefined);
    if (!result) return undefined;
    const running = result.stdout.includes("running");
    if (this.session.active && !running) {
      // A power cycle wipes tmpfs and boots the official firmware, so a
      // missing /tmp config means the device already restored itself.
      this.session = { active: false };
    }
    if (running && !this.session.active) this.session = { active: true };
    return running;
  }

  private get runner(): ProcessRunner {
    return this.options.processRunner ?? defaultProcessRunner;
  }

  private get adb(): string | null {
    return this.runner.which(this.options.adbPath?.trim() || "adb");
  }

  private get target(): string {
    return `${this.options.clockHost}:5555`;
  }

  private async adbProperty(adb: string, property: string): Promise<string | undefined> {
    const result = await this.runner.run(
      adb,
      ["-s", this.target, "shell", "getprop", property],
      8_000,
    );
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.trim();
    return value.length > 0 && value.length <= 120 ? value : undefined;
  }

  private async requireCommand(adb: string, args: string[], timeoutMs: number): Promise<void> {
    const result = await this.runner.run(adb, args, timeoutMs);
    if (result.exitCode !== 0) {
      throw new MusicInstallerError("ADB 操作失败，请重新检测设备后再试；若时钟黑屏或异常，断电重启即可回到官方固件", 503);
    }
  }
}

// Backward-compatible name from the music-only era; same class.
export { Tc002SideloadInstaller as Tc002MusicInstaller };

export function isValidBundleEntry(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

// A relative POSIX path with no traversal, absolute root, or backslashes.
export function isValidBundlePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.split("/").includes("..");
}

export function computeBundleId(files: readonly BundleFile[]): string {
  const canonical = [...files]
    .map((file) => `${file.path}:${file.sha256}:${file.bytes}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function validateManifest(value: unknown, expectedAppId: string): BundleManifest {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const files = record.files;
  if (
    record.schemaVersion !== 3 ||
    record.appId !== expectedAppId ||
    !isValidBundleEntry(record.entry) ||
    typeof record.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(record.version) ||
    typeof record.bundleId !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.bundleId) ||
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 512
  ) {
    throw new MusicInstallerError("固件发布清单格式无效");
  }
  for (const file of files) {
    const entry = file as Record<string, unknown>;
    if (
      !isValidBundlePath(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      (entry.bytes as number) > 256 * 1024 * 1024
    ) {
      throw new MusicInstallerError("固件发布清单格式无效");
    }
  }
  if (!(files as BundleFile[]).some((file) => file.path === record.entry)) {
    throw new MusicInstallerError("固件清单缺少入口文件");
  }
  return record as unknown as BundleManifest;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

function restoreGuide(zosFlashed = false): MusicDeviceAppStatus["restore"] {
  // Sideloading only ever lives in tmpfs, so a power cycle always ends it. What
  // differs is what is underneath: the stock app, or a flashed ZOS.
  if (zosFlashed) {
    return {
      title: "回到闪存里的 ZOS",
      steps: [
        "点「结束侧载」，ZOS 立即恢复",
        "或直接断电重启 TC002——侧载固件只在内存里，重启后回到闪存里的 ZOS",
        "这台设备的 res 分区已写入 ZOS，断电重启不会回到 Ulanzi 官方固件",
        "要回官方固件需要重新刷写：mise run os-restore-image 打包，再走升级流程",
      ],
    };
  }
  return {
    title: "回到 Ulanzi 官方固件",
    steps: [
      "点「恢复官方固件」，官方界面立即恢复",
      "或直接断电重启 TC002——固件只在内存里，重启后自动回到官方固件",
      "如界面仍异常，断电后按住 USB-C 旁的复位按钮再上电（官方恢复方式）",
      "恢复后重新检查 Wi-Fi、亮度、时区和音量设置",
    ],
  };
}

function isSafeHost(value: string): boolean {
  return value.length > 0 && value.length <= 253 && !/[\s/?#@:]/.test(value) && !value.includes("://");
}

function truncateOutput(value: string): string {
  return value.replace(/[\0\r]/g, "").slice(0, 4_096);
}
