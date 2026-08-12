import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FirmwarePanelBody,
  firmwareStatusLabel,
  type FirmwarePanelController,
} from "../web/src/components/firmware-panel";
import type { MusicDeviceAppStatus, MusicDeviceProbe } from "../web/src/types";

function fakeController(overrides: Partial<FirmwarePanelController> = {}): FirmwarePanelController {
  return {
    firmwareLabel: "音乐固件",
    // 默认按「闪存里是官方固件」——面板的历史行为，ZOS 分支单独有用例。
    restoresTo: "官方固件",
    restoresToZos: false,
    open: true,
    setOpen: () => {},
    openPanel: () => {},
    deviceApp: null,
    deviceProbe: null,
    busy: false,
    error: null,
    sessionMessage: null,
    recoveryAcknowledged: false,
    setRecoveryAcknowledged: () => {},
    sessionActive: false,
    canStartSession: false,
    statusLabel: "侧载固件",
    loadDeviceApp: async () => {},
    probeDevice: async () => {},
    startSession: async () => {},
    stopSession: async () => {},
    ...overrides,
  };
}

const readyApp = {
  artifact: {
    state: "ready",
    appId: "tc002-arcade",
    bundleId: "c".repeat(64),
    message: "固件包完整性校验通过（逐文件 SHA-256），可以侧载到时钟",
  },
  adb: "ready",
  busy: false,
  session: { active: false },
  restore: { title: "回到 Ulanzi 官方固件", steps: ["点「恢复官方固件」，官方界面立即恢复"] },
} as MusicDeviceAppStatus;

describe("shared firmware panel", () => {
  test("statusLabel walks session > probe > artifact > idle", () => {
    expect(firmwareStatusLabel(null, null, "音乐固件")).toBe("侧载固件");
    expect(firmwareStatusLabel(readyApp, null, "游戏固件")).toBe("固件包已就绪");
    const probe = { adb: "ready", connected: true, message: "ok" } as MusicDeviceProbe;
    expect(firmwareStatusLabel(readyApp, probe, "游戏固件")).toBe("TC002 已连接");
    const active = { ...readyApp, session: { active: true } } as MusicDeviceAppStatus;
    expect(firmwareStatusLabel(active, probe, "游戏固件")).toBe("游戏固件运行中");
    expect(firmwareStatusLabel(active, probe, "音乐固件")).toBe("音乐固件运行中");
  });

  test("renders the guarded three-step flow with the firmware-specific copy", () => {
    // Dialog 走 portal（SSR 为空），直接渲染抽屉主体。
    const html = renderToStaticMarkup(createElement(FirmwarePanelBody, {
      controller: fakeController({ firmwareLabel: "游戏固件", deviceApp: readyApp }),
      heading: "侧载游戏固件",
      description: "把游戏固件推进时钟内存临时运行。",
      headingId: "arcade-firmware-dialog-deploy-title",
    }));

    expect(html).toContain("侧载游戏固件");
    expect(html).toContain("校验固件包");
    expect(html).toContain("检测 TC002");
    expect(html).toContain("我知道如何回到官方固件");
    expect(html).toContain("恢复官方固件");
    expect(html).toContain("按住 USB-C 旁的复位按钮");
    expect(html).toContain('class="fw-deploy"');
    expect(html).toContain("fw-deploy-steps");
    expect(html).toContain("fw-recovery-guide");
    // 固件包就绪但未探测：第 1 步完成、第 2 步进行中，侧载按钮仍然禁用
    // （按钮的 disabled 属性在文案之前，窗口按 cladd 按钮的标记长度放宽）。
    expect(html).toContain('class="is-done"');
    expect(html).toContain('class="is-current"');
    expect(html).toMatch(/data-disabled="true"[\s\S]{0,1200}?侧载固件<\/span><\/button>/);
  });

  test("shows session-active state with the stop action and extra live facts", () => {
    const active = { ...readyApp, session: { active: true, version: "0.1.0" } } as MusicDeviceAppStatus;
    const html = renderToStaticMarkup(createElement(
      FirmwarePanelBody,
      {
        controller: fakeController({
          firmwareLabel: "游戏固件",
          deviceApp: active,
          sessionActive: true,
          deviceProbe: {
            adb: "ready",
            connected: true,
            model: "Ulanzi TC002",
            message: "设备在线，游戏固件正在运行",
          } as MusicDeviceProbe,
        }),
        heading: "侧载游戏固件",
        description: "描述",
        headingId: "arcade-firmware-dialog-deploy-title",
      },
      createElement("dl", { className: "fw-device-facts" },
        createElement("div", null,
          createElement("dt", null, "当前游戏"),
          createElement("dd", null, "breakout"))),
    ));

    expect(html).toContain("游戏固件运行中；点「恢复官方固件」或断电重启即可回到官方固件");
    expect(html).toContain("恢复官方固件");
    expect(html).toContain("当前游戏");
    expect(html).toContain("breakout");
    expect(html).toContain("Ulanzi TC002");
  });

  // 这台设备的 ZOS 是刷进 res 分区的：断电重启回到 ZOS，不是官方固件。侧载面板
  // 通篇的「恢复官方固件」在这种机器上是假话，而且假在最危险的方向上。
  test("a flashed-ZOS device is told the sideload falls back to ZOS, not the official firmware", () => {
    const active = { ...readyApp, session: { active: true } } as MusicDeviceAppStatus;
    const html = renderToStaticMarkup(createElement(FirmwarePanelBody, {
      controller: fakeController({
        firmwareLabel: "音乐固件",
        deviceApp: active,
        sessionActive: true,
        restoresTo: "ZOS",
        restoresToZos: true,
      }),
      heading: "侧载音乐固件",
      description: "描述",
      headingId: "music-firmware-dialog-deploy-title",
    }));

    expect(html).toContain("我知道如何回到ZOS");
    expect(html).toContain("结束侧载");
    expect(html).toContain("回到 ZOS");
    expect(html).toContain("重启后回到闪存里的 ZOS");
    expect(html).toContain("音乐固件运行中；点「结束侧载」或断电重启即可回到ZOS");
    // 服务端的恢复指南是照官方固件写死的，这里必须被本地这份顶掉。
    expect(html).not.toContain("恢复官方固件");
    expect(html).not.toContain("自动回到官方固件");
  });

  test("both host pages mount the shared panel instead of a private drawer", async () => {
    const [playerSource, shellSource] = await Promise.all([
      Bun.file(new URL("../web/src/components/music/music-player.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/game/game-shell.tsx", import.meta.url)).text(),
    ]);
    expect(playerSource).toContain("<FirmwarePanel");
    expect(playerSource).toContain('apiPrefix: "/api/music"');
    expect(shellSource).toContain("<FirmwarePanel");
    expect(shellSource).toContain('apiPrefix: "/api/arcade"');
    // 各自的抽屉主题：音乐纸面浅色，游戏街机暗色。
    expect(playerSource).toContain('dialogClassName="music-firmware-dialog"');
    expect(shellSource).toContain('dialogClassName="arcade-firmware-dialog"');
  });
});
