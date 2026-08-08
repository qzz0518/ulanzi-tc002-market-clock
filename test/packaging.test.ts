import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const FILES = {
  macosInstaller: join(ROOT, "scripts/install.sh"),
  macosUninstaller: join(ROOT, "scripts/uninstall.sh"),
  dockerInstaller: join(ROOT, "scripts/install-docker.sh"),
  dockerUninstaller: join(ROOT, "scripts/uninstall-docker.sh"),
  macos: join(ROOT, "packaging/macos/com.zerah.ulanzi-market-clock.plist.template"),
  dockerfile: join(ROOT, "Dockerfile"),
  compose: join(ROOT, "compose.yaml"),
  removedLinuxUnit: join(ROOT, "packaging/linux/zerah-ulanzi-market-clock.service.template"),
  removedLinuxRunner: join(ROOT, "scripts/run-service.sh"),
};

describe("service packaging", () => {
  test("shell entrypoints pass Bash syntax validation", () => {
    for (const path of [
      FILES.macosInstaller,
      FILES.macosUninstaller,
      FILES.dockerInstaller,
      FILES.dockerUninstaller,
    ]) {
      const result = Bun.spawnSync(["bash", "-n", path]);
      expect(result.exitCode).toBe(0);
    }
  });

  test("native packaging is macOS-only and uses the Zerah service identity", async () => {
    const installer = await readFile(FILES.macosInstaller, "utf8");
    const uninstaller = await readFile(FILES.macosUninstaller, "utf8");
    const macos = await readFile(FILES.macos, "utf8");
    const combined = `${installer}\n${uninstaller}\n${macos}`;

    expect(combined).not.toContain(["", "Users", ""].join("/"));
    expect(macos).toContain("com.zerah.ulanzi-market-clock");
    expect(macos).toContain("@@PROJECT_DIR_XML@@");
    expect(macos).toContain("@@BUN_BIN_XML@@");
    expect(macos).toContain("@@ENTRYPOINT_XML@@");
    expect(installer).toContain("Darwin");
    expect(installer).toContain("read -r clock_host");
    expect(installer).toContain('clock_host="${CLOCK_HOST:-}"');
    expect(installer).toContain('control_host="${CONTROL_HOST:-0.0.0.0}"');
    expect(installer).toContain("--control-host");
    expect(installer).toContain("--adb-bin");
    expect(installer).toContain("command -v adb");
    expect(installer).not.toContain("CLOCK_HOST:-192.168");
    expect(macos).toContain("@@CONTROL_HOST_XML@@");
    expect(macos).toContain("@@ADB_BIN_XML@@");
    expect(installer).toContain('readonly REQUIRED_BUN_VERSION="1.3.14"');
    expect(installer).toContain("mise which bun");
    expect(installer).toContain('version="$("$candidate" --version');
    expect(installer).not.toContain("systemctl");
    expect(uninstaller).not.toContain("systemctl");
    expect(await Bun.file(FILES.removedLinuxUnit).exists()).toBe(false);
    expect(await Bun.file(FILES.removedLinuxRunner).exists()).toBe(false);
  });

  test("Docker packaging keeps the control API local and runtime data persistent", async () => {
    const installer = await readFile(FILES.dockerInstaller, "utf8");
    const dockerfile = await readFile(FILES.dockerfile, "utf8");
    const compose = await readFile(FILES.compose, "utf8");

    expect(installer).toContain("Docker host must be able to route to the TC002 address");
    expect(installer).toContain("docker compose");
    expect(installer).toContain("read -r clock_host");
    expect(installer).toContain('clock_host="${CLOCK_HOST:-}"');
    expect(installer).not.toContain("CLOCK_HOST:-192.168");
    expect(dockerfile).toContain("USER bun");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("apk add --no-cache curl");
    expect(dockerfile).toContain("COPY web ./web");
    expect(dockerfile).toContain("vite.config.ts");
    expect(compose).toContain('CONTROL_HOST: "0.0.0.0"');
    expect(compose).toContain('CLOCK_HOST: "${CLOCK_HOST:?');
    expect(compose).not.toContain("CLOCK_HOST:-192.168");
    expect(compose).toContain(
      '"127.0.0.1:${HEALTH_PORT:-43820}:${HEALTH_PORT:-43820}/tcp"',
    );
    expect(compose).toContain("./.runtime:/app/.runtime");
    expect(compose).toContain("read_only: true");
    expect(compose).not.toContain("network_mode: host");
  });
});
