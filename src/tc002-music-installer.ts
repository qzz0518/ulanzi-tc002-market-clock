import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const MUSIC_SESSION_CONFIRMATION = "START_TC002_MUSIC_SESSION";

const REMOTE_DIR = "/tmp/tc002-music";
// A shebang entry runs as `sh`, so pidof/killall on the entry name are not
// reliable; the launcher records $! and every check goes through this file.
const REMOTE_PID = `${REMOTE_DIR}/session.pid`;

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
  appId: "tc002-lyrics-player";
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

export class MusicInstallerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "MusicInstallerError";
  }
}

export class MusicPlayerBundleStore {
  constructor(private readonly releaseDirectory: string) {}

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
        message: "旁载包已通过逐文件 SHA-256 校验，可以开始调试会话",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          state: "missing",
          appId: "tc002-lyrics-player",
          message: "尚未放入由 FlyThings 构建产物打包的旁载目录",
        };
      }
      return {
        state: "invalid",
        appId: "tc002-lyrics-player",
        message: error instanceof Error ? error.message : "旁载包校验失败",
      };
    }
  }

  async requireReady(): Promise<ReadyBundle> {
    const manifestPath = join(this.releaseDirectory, "manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    const manifest = validateManifest(raw);
    const bundleDir = join(this.releaseDirectory, "bundle");
    let bytes = 0;
    for (const file of manifest.files) {
      const filePath = join(bundleDir, file.path);
      // join collapses any traversal, so re-check the result stays inside.
      if (!filePath.startsWith(bundleDir + "/")) {
        throw new MusicInstallerError("旁载清单包含非法文件路径");
      }
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size !== file.bytes) {
        throw new MusicInstallerError(`旁载文件大小与清单不一致：${file.path}`);
      }
      if (await sha256File(filePath) !== file.sha256) {
        throw new MusicInstallerError(`旁载文件 SHA-256 与清单不一致：${file.path}`);
      }
      bytes += file.bytes;
    }
    if (computeBundleId(manifest.files) !== manifest.bundleId) {
      throw new MusicInstallerError("旁载清单的 bundleId 与文件列表不一致");
    }
    return { manifest, bundleDir, bytes };
  }
}

/**
 * Path-A device model: the player is pushed to the TC002's tmpfs and runs as
 * a temporary process while the official UI service is paused. Nothing is
 * written to flash, so ending the session — or simply power-cycling the
 * clock — always returns the device to the official firmware.
 */
export class Tc002MusicInstaller {
  private busy = false;
  private session: MusicSessionState = { active: false };

  constructor(private readonly options: {
    clockHost: string;
    bundleStore: MusicPlayerBundleStore;
    adbPath?: string;
    processRunner?: ProcessRunner;
    verifyClock: () => Promise<{ mcuVersion?: string; appVersion?: string }>;
    now?: () => Date;
  }) {
    if (!isSafeHost(options.clockHost)) throw new Error("TC002 host is invalid for ADB");
    const adbPath = options.adbPath?.trim();
    if (adbPath && (!isAbsolute(adbPath) || adbPath.length > 1_024 || /[\r\n\0]/.test(adbPath))) {
      throw new Error("ADB_BIN must be an absolute executable path");
    }
  }

  async status(): Promise<MusicDeviceAppStatus> {
    return {
      artifact: await this.options.bundleStore.inspect(),
      adb: this.adb ? "ready" : "missing",
      busy: this.busy,
      session: { ...this.session },
      restore: restoreGuide(),
    };
  }

  async probe(): Promise<MusicDeviceProbe> {
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

    const clock = await this.options.verifyClock();
    const target = this.target;
    const connection = await this.runner.run(adb, ["connect", target], 12_000);
    if (connection.exitCode !== 0 || /failed|unable|refused/i.test(`${connection.stdout}\n${connection.stderr}`)) {
      throw new MusicInstallerError("ADB 无法连接 TC002，请确认 Wi-Fi、IP 和调试状态", 503);
    }
    const [model, platform] = await Promise.all([
      this.adbProperty(adb, "ro.product.model"),
      this.adbProperty(adb, "ro.product.platform"),
    ]);
    const playerRunning = await this.refreshSession(adb);
    return {
      adb: "ready",
      connected: true,
      ...(model ? { model } : {}),
      ...(platform ? { platform } : {}),
      ...(clock.appVersion ? { appVersion: clock.appVersion } : {}),
      ...(clock.mcuVersion ? { mcuVersion: clock.mcuVersion } : {}),
      ...(playerRunning === undefined ? {} : { playerRunning }),
      message: playerRunning
        ? "设备在线，播放器调试会话正在运行"
        : "已通过官方 HTTP 接口和 Wi-Fi ADB 双重确认设备",
    };
  }

  async startSession(input: {
    confirmation: string;
    expectedBundleId: string;
  }): Promise<{ state: "running"; message: string; restore: MusicDeviceAppStatus["restore"] }> {
    if (input.confirmation !== MUSIC_SESSION_CONFIRMATION) {
      throw new MusicInstallerError("请先确认已了解如何回到官方固件");
    }
    if (!/^[a-f0-9]{64}$/.test(input.expectedBundleId)) {
      throw new MusicInstallerError("旁载包校验值无效");
    }
    if (this.busy) throw new MusicInstallerError("设备操作进行中，请勿重复提交", 409);

    this.busy = true;
    try {
      const bundle = await this.options.bundleStore.requireReady();
      if (bundle.manifest.bundleId !== input.expectedBundleId) {
        throw new MusicInstallerError("页面中的旁载包版本已经变化，请刷新后重新确认", 409);
      }
      await this.probe();
      const adb = this.adb;
      if (!adb) throw new MusicInstallerError("本机没有找到 adb", 503);
      const entry = bundle.manifest.entry;

      // The device busybox has no tar/unzip, so the bundle directory is pushed
      // recursively; `dir/.` copies its contents straight into REMOTE_DIR.
      await this.requireCommand(adb, this.shell(`rm -rf ${REMOTE_DIR}`), 10_000);
      await this.requireCommand(adb, this.shell(`mkdir -p ${REMOTE_DIR}`), 10_000);
      await this.requireCommand(
        adb,
        ["-s", this.target, "push", `${bundle.bundleDir}/.`, `${REMOTE_DIR}/`],
        180_000,
      );
      await this.requireCommand(adb, this.shell(`chmod +x ${REMOTE_DIR}/${entry}`), 10_000);
      await this.requireCommand(adb, this.shell("setprop ctl.stop zkswe"), 10_000);
      try {
        // The device busybox has no nohup/setsid, so detach with a subshell:
        // the background child is reparented to init when the subshell exits,
        // letting the adb command return instead of blocking on the process.
        await this.requireCommand(
          adb,
          this.shell(
            `(cd ${REMOTE_DIR} && ./${entry} </dev/null >${REMOTE_DIR}/session.log 2>&1 & echo $! > ${REMOTE_PID})`,
          ),
          15_000,
        );
      } catch (error) {
        // The official UI was already paused; bring it back before failing so
        // the clock never stays on a dead screen.
        await this.runner.run(adb, this.shell("setprop ctl.start zkswe"), 10_000).catch(() => undefined);
        throw error;
      }

      this.session = {
        active: true,
        version: bundle.manifest.version,
        startedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      return {
        state: "running",
        message: "播放器已在内存盘运行，官方界面已暂停；结束会话或断电重启即可回到官方固件",
        restore: restoreGuide(),
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
          `[ -f ${REMOTE_PID} ] && kill "$(cat ${REMOTE_PID})" 2>/dev/null; `
            + (entry ? `killall ${entry} 2>/dev/null; ` : "")
            + "true",
        ),
        10_000,
      ).catch(() => undefined);
      await this.runner.run(adb, this.shell(`rm -rf ${REMOTE_DIR}`), 15_000).catch(() => undefined);
      await this.requireCommand(adb, this.shell("setprop ctl.start zkswe"), 10_000);
      this.session = { active: false };
      return {
        state: "official",
        message: "官方界面已恢复；如显示异常，直接断电重启即可",
        restore: restoreGuide(),
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
    const entry = await this.knownEntry();
    if (!entry) return undefined;
    const result = await this.runner
      .run(
        adb,
        this.shell(
          `[ -f ${REMOTE_PID} ] && kill -0 "$(cat ${REMOTE_PID})" 2>/dev/null && echo running`,
        ),
        8_000,
      )
      .catch(() => undefined);
    if (!result) return undefined;
    const running = result.stdout.includes("running");
    if (this.session.active && !running) {
      // A power cycle wipes tmpfs and boots the official firmware, so a
      // missing process means the device already restored itself.
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
      throw new MusicInstallerError("ADB 操作失败；设备状态未改变，请重新检测后再试", 503);
    }
  }
}

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

function validateManifest(value: unknown): BundleManifest {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const files = record.files;
  if (
    record.schemaVersion !== 3 ||
    record.appId !== "tc002-lyrics-player" ||
    !isValidBundleEntry(record.entry) ||
    typeof record.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(record.version) ||
    typeof record.bundleId !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.bundleId) ||
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 512
  ) {
    throw new MusicInstallerError("旁载发布清单格式无效");
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
      throw new MusicInstallerError("旁载发布清单格式无效");
    }
  }
  if (!(files as BundleFile[]).some((file) => file.path === record.entry)) {
    throw new MusicInstallerError("旁载清单缺少入口文件");
  }
  return record as unknown as BundleManifest;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

function restoreGuide(): MusicDeviceAppStatus["restore"] {
  return {
    title: "回到 Ulanzi 官方固件",
    steps: [
      "点击「结束会话」，官方界面会立即恢复",
      "或直接断电重启 TC002——播放器运行在内存盘，重启后自动回到官方固件",
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
