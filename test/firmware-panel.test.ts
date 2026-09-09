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
    appId: "tc002-lyrics-player",
    bundleId: "c".repeat(64),
    message: "固件包完整性校验通过（逐文件 SHA-256），可以侧载到时钟",
  },
  adb: "ready",
  busy: false,
  session: { active: false },
  restore: { title: "回到 Ulanzi 官方固件", steps: ["点「恢复官方固件」，官方界面立即恢复"] },
} as MusicDeviceAppStatus;

describe("music firmware panel", () => {
  test("statusLabel walks session > probe > artifact > idle", () => {
    expect(firmwareStatusLabel(null, null, "音乐固件")).toBe("侧载固件");
    expect(firmwareStatusLabel(readyApp, null, "音乐固件")).toBe("固件包已就绪");
    const probe = { adb: "ready", connected: true, message: "ok" } as MusicDeviceProbe;
    expect(firmwareStatusLabel(readyApp, probe, "音乐固件")).toBe("TC002 已连接");
    const active = { ...readyApp, session: { active: true } } as MusicDeviceAppStatus;
    expect(firmwareStatusLabel(active, probe, "音乐固件")).toBe("音乐固件运行中");
  });

  test("renders the guarded three-step flow with the firmware-specific copy", () => {
    // Dialog 走 portal（SSR 为空），直接渲染抽屉主体。
    const html = renderToStaticMarkup(createElement(FirmwarePanelBody, {
      controller: fakeController({ firmwareLabel: "音乐固件", deviceApp: readyApp }),
      heading: "侧载音乐固件",
      description: "把音乐固件推进时钟内存临时运行。",
      headingId: "music-firmware-dialog-deploy-title",
    }));

    expect(html).toContain("侧载音乐固件");
    expect(html).toContain("校验固件包");
    expect(html).toContain("检测 TC002");
    expect(html).toContain("我知道如何回到官方固件");
    expect(html).toContain("恢复官方固件");
    expect(html).toContain("按住 USB-C 旁的复位按钮");
    // fw-deploy--flow 是抽屉正文的纵向节奏开关：容器出 gap，子块一律不带
    // margin（含宿主页面塞进来的 cladd Surface）。掉了它整块间距会散架。
    expect(html).toContain('class="fw-deploy fw-deploy--flow"');
    expect(html).toContain("fw-deploy-steps");
    expect(html).toContain("fw-deploy-decision");
    expect(html).toContain("fw-recovery-guide");
    // 固件包就绪但未探测：第 1 步完成、第 2 步进行中，侧载按钮仍然禁用
    // （按钮的 disabled 属性在文案之前，窗口按 cladd 按钮的标记长度放宽）。
    expect(html).toContain('class="is-done"');
    expect(html).toContain('class="is-current"');
    expect(html).toMatch(/data-disabled="true"[\s\S]{0,1200}?侧载固件<\/span><\/button>/);
  });

  test("shows session-active state with the stop action and the host page's extras", () => {
    const active = { ...readyApp, session: { active: true, version: "0.1.0" } } as MusicDeviceAppStatus;
    const html = renderToStaticMarkup(createElement(
      FirmwarePanelBody,
      {
        controller: fakeController({
          firmwareLabel: "音乐固件",
          deviceApp: active,
          sessionActive: true,
          deviceProbe: {
            adb: "ready",
            connected: true,
            model: "Ulanzi TC002",
            message: "设备在线，音乐固件正在运行",
          } as MusicDeviceProbe,
        }),
        heading: "侧载音乐固件",
        description: "描述",
        headingId: "music-firmware-dialog-deploy-title",
      },
      // 宿主页塞进来的额外内容（音乐页放的是 ZOS 中断提示）跟在探测事实后面。
      createElement("dl", { className: "fw-device-facts" },
        createElement("div", null,
          createElement("dt", null, "正在播放"),
          createElement("dd", null, "像素歌词"))),
    ));

    expect(html).toContain("音乐固件运行中；点「恢复官方固件」或断电重启即可回到官方固件");
    expect(html).toContain("恢复官方固件");
    expect(html).toContain("正在播放");
    expect(html).toContain("像素歌词");
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

  test("the music page is the panel's one host; the game shell no longer mounts it", async () => {
    const [playerSource, shellSource, css] = await Promise.all([
      Bun.file(new URL("../web/src/components/music/music-player.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/game/game-shell.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/styles/music-player.css", import.meta.url)).text(),
    ]);
    expect(playerSource).toContain("<FirmwarePanel");
    expect(playerSource).toContain('apiPrefix: "/api/music"');
    expect(playerSource).toContain('dialogClassName="music-firmware-dialog"');
    // 游戏固件退役了（ADR 0014）：游戏页没有抽屉，也不碰 /api/arcade；那套
    // 抽屉皮肤随之从样式表里消失，别留一份没人挂的 .arcade-firmware-dialog。
    expect(shellSource).not.toContain("FirmwarePanel");
    expect(shellSource).not.toContain("/api/arcade");
    expect(css).not.toContain("arcade-firmware-dialog");
  });
});
