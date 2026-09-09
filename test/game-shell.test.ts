import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GameShell } from "../web/src/components/game/game-shell";
import { StudioHeader } from "../web/src/components/studio/studio-header";
import { describeFirmware } from "../web/src/lib/firmware-mode.ts";

describe("game shell", () => {
  test("renders the stage: picker, screen with HUD, console", () => {
    const html = renderToStaticMarkup(createElement(GameShell, { firmwareOnline: false }));

    // 顶栏：游戏切换 + 上屏开关 + 连接状态。
    expect(html).toContain("选择游戏");
    expect(html).toContain("时间打砖块");
    expect(html).toContain("上屏");
    // 未上屏,不是直播中:上屏默认关闭(见 game-shell.tsx 的 mirrorEnabled 初值),
    // 先在浏览器里玩,想投到时钟再手动打开。
    expect(html).toContain("未上屏");
    // 游戏固件的侧载入口没了（ADR 0014）；想用旋钮玩只剩一句指路：ZOS 自带同样七款。
    expect(html).not.toContain("侧载游戏固件");
    expect(html).toContain("ZOS 系统固件自带同样七款游戏");
    // 舞台：52×16 LED 屏 + 像素 HUD。
    expect(html).toContain('width="52" height="16"');
    expect(html).toContain("分数");
    expect(html).toContain("生命");
    expect(html).toContain("关卡");
    expect(html).toContain("最高分");
    expect(html).toContain("点按屏幕或按空格开始");
    // 控制台。
    expect(html).toContain("开始");
    expect(html).toContain("重开");
    expect(html).toContain("难度");
    expect(html).not.toContain("恢复官方固件后才能上屏");
  });

  test("keeps the game tab available but disables live output during firmware mode", () => {
    const game = renderToStaticMarkup(createElement(GameShell, {
      firmwareOnline: true,
    }));
    const header = renderToStaticMarkup(createElement(StudioHeader, {
      view: "game",
      onViewChange: () => {},
      runtime: null,
      firmwareStatus: describeFirmware({
        osState: null,
        musicFirmwareOnline: true,
      }),
      firmwareLocked: true,
    }));

    expect(game).toContain("音乐固件直连中，恢复官方固件后才能上屏");
    expect(game).toContain("固件直连");
    expect(game).toMatch(/上屏[\s\S]*?disabled/);
    expect(header).toContain("音乐固件");
    expect(header).toContain("游戏");
    expect(header).toMatch(/>内容<[\s\S]*?disabled/);
  });

  test("wires input capture and batched live streaming", async () => {
    const [shellSource, liveSource, appSource, headerSource, css] = await Promise.all([
      Bun.file(new URL("../web/src/components/game/game-shell.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/lib/live-screen.ts", import.meta.url)).text(),
      Bun.file(new URL("../web/src/app.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/studio/studio-header.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/styles/globals.css", import.meta.url)).text(),
    ]);

    // 录制回放批推常量集中在 live-screen.ts,真机可调。
    expect(liveSource).toContain("export const LIVE_FRAME_MS = 25;");
    expect(liveSource).toContain("export const LIVE_BATCH_FRAMES = 4;");
    expect(liveSource).toContain('method: "DELETE", keepalive: true');
    expect(liveSource).toContain("createLatestTaskRunner");

    // GameShell 采集 GameInput、按 tick 消费 pressedEdge、走 live-screen 上屏。
    expect(shellSource).toContain('createLiveScreen("game"');
    expect(shellSource).toContain("input.pressedEdge = false;");
    expect(shellSource).toContain("setPointerCapture");
    expect(shellSource).toContain('document.addEventListener("visibilitychange"');
    expect(shellSource).toContain("const GAME_OVER_STREAM_MS = 3_000;");
    expect(shellSource).toContain("GAME_REGISTRY");

    // 游戏固件退役了（ADR 0014）：游戏页没有侧载抽屉，不轮询 /api/arcade/*，
    // 也不再向工作台上报第二种侧载在线状态。
    expect(shellSource).not.toContain("/api/arcade");
    expect(shellSource).not.toContain("FirmwarePanel");
    expect(shellSource).not.toContain("onArcadeOnlineChange");

    // 页面接线与横屏 gate 保持；firmwareOnline 现在就是音乐固件的心跳。
    expect(headerSource).toContain('value="game"><Gamepad2 />游戏</Tab>');
    // Tooltip 文案（弹层内容不进 SSR，只能查源码）。
    expect(headerSource).toContain('"音乐固件运行中，结束侧载后可用"');
    expect(appSource).toContain('view === "game"');
    expect(appSource).toContain('const firmwareOnline = musicFirmwareOnline && firmwareMode !== "zos";');
    expect(appSource).toContain("firmwareOnline={firmwareOnline}");
    expect(appSource).not.toContain("arcadeOnline");
    expect(appSource).toContain('className="game-orientation-gate"');

    // LED 屏质感与触控行为;竖屏 gate 隐藏游戏布局。
    expect(css).toMatch(/\.game-screen__frame canvas\s*\{[^}]*image-rendering:\s*pixelated;/s);
    expect(css).toMatch(/\.game-screen__frame canvas\s*\{[^}]*touch-action:\s*none;/s);
    expect(css).toMatch(/\.game-screen__frame::after\s*\{[^}]*background-size:\s*calc\(100% \/ 52\)/s);
    expect(css).toMatch(/\.is-game-page \.studio-layout\.is-game\s*\{\s*display:\s*none;/s);
  });
});
