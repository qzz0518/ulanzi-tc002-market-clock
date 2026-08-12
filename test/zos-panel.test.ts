import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import { ZosPanel } from "../web/src/components/zos/zos-panel";
import { ZosMirrorScreen } from "../web/src/components/zos/zos-mirror-screen";
import { ZosInputDeck } from "../web/src/components/zos/zos-input-deck";
import { StudioHeader } from "../web/src/components/studio/studio-header";
import { describeMirror } from "../web/src/lib/zos-link.ts";

function markup(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(createElement(CladdProvider, null, node));
}

describe("zos panel", () => {
  test("renders the stage before any device has answered", () => {
    // Effects do not run in SSR, so this is exactly the first paint: no state,
    // no frame. Nothing here may imply a working device.
    const html = markup(createElement(ZosPanel));

    expect(html).toContain("52 × 16 · 固件合成器直出");
    expect(html).toContain('width="52" height="16"');
    // 设备未上报即离线,不是「一切正常」。
    expect(html).toContain("设备离线");
    expect(html).toContain("时钟没有在跑 ZOS 固件");
    expect(html).toContain("正在读取设备菜单…");
    // 接管状态与三张侧栏卡。
    expect(html).toContain("旋钮自由");
    expect(html).toContain("设备菜单");
    expect(html).toContain("音量与亮度");
    expect(html).toContain("详细状态");
    expect(html).toContain("交还旋钮");
    // Wi-Fi 重连次数是安全属性,不是花絮:0 次代表固件没动过无线链路。
    expect(html).toContain("Wi-Fi 重连");
    // 固件驻留说的是「断电重启回到什么」;没有任何记录时必须承认未知。
    expect(html).toContain("固件驻留");
    expect(html).toContain("未知");
  });

  test("shows 离线 for every telemetry detail instead of stale numbers", () => {
    const html = markup(createElement(ZosPanel));
    for (const label of ["当前界面", "IP 地址", "空闲内存", "最近心跳"]) {
      expect(html).toContain(label);
    }
    // 详情行离线时全部塌成「离线」。
    expect(html.match(/离线/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    // 概况条（电量 / Wi-Fi / 运行时长）离线时整条消失,而不是展示旧数字。
    expect(html).not.toContain("zc-vitals");
    expect(html).not.toContain("已运行");
  });

  test("the remote deck is present but inert on the offline first paint", () => {
    const html = markup(createElement(ZosPanel));
    // 六个可注入事件的物理词汇表:侧键、旋钮、中键。
    expect(html).toContain("左键");
    expect(html).toContain("右键");
    expect(html).toContain("确认");
    expect(html).toContain("按住返回");
    expect(html).toContain("zc-knob");
    // 离线时按键不排队——排队的旋钮转动会在重连时一起爆发。
    expect(html).toContain("设备离线，远程按键不可用");
    // 中键在离线时禁用(SSR 里 disabled 属性直接可见)。
    const core = html.split("<button").find((chunk) => chunk.includes("zc-knob__core"))!;
    expect(core).toContain("disabled");
  });

  test("a live deck offers the keyboard vocabulary and no offline copy", () => {
    const html = markup(createElement(ZosInputDeck, {
      live: true,
      onSend: () => Promise.resolve(null),
    }));
    expect(html).toContain("旋钮");
    expect(html).toContain("确认");
    expect(html).toContain("返回");
    expect(html).toContain("按键实时发往设备");
    expect(html).not.toContain("设备离线");
    const core = html.split("<button").find((chunk) => chunk.includes("zc-knob__core"))!;
    expect(core).not.toContain("disabled");
    // 无障碍旁路:读屏器拖不动圆盘,必须有真按钮承载左旋/右旋。
    expect(html).toContain("旋钮左旋一格");
    expect(html).toContain("旋钮右旋一格");
  });

  test("the mirror never renders a bare black box", () => {
    const offline = markup(createElement(ZosMirrorScreen, {
      rgbBase64: null,
      status: describeMirror({ live: false, frameReceivedAt: null, now: 1_000 }),
    }));
    const waiting = markup(createElement(ZosMirrorScreen, {
      rgbBase64: null,
      status: describeMirror({ live: true, frameReceivedAt: null, now: 1_000 }),
    }));
    const stale = markup(createElement(ZosMirrorScreen, {
      rgbBase64: "AAAA",
      status: describeMirror({ live: true, frameReceivedAt: 1_000, now: 9_000 }),
    }));
    const liveNow = markup(createElement(ZosMirrorScreen, {
      rgbBase64: "AAAA",
      status: describeMirror({ live: true, frameReceivedAt: 1_000, now: 1_100 }),
    }));

    expect(offline).toContain("zc-screen__notice");
    expect(offline).toContain("设备离线");
    expect(waiting).toContain("等待画面");
    expect(stale).toContain("画面已停更");
    expect(stale).toContain("8 秒前");
    // 只有真正的实时画面才没有盖层——那是唯一可以只看屏幕的状态。
    expect(liveNow).not.toContain("zc-screen__notice");
    expect(liveNow).toContain("实时同步中");
  });

  test("is mounted as its own view, unlocked by sideload firmware", async () => {
    const [panelSource, mirrorSource, deckSource, linkSource, appSource, headerSource, css] = await Promise.all([
      Bun.file(new URL("../web/src/components/zos/zos-panel.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/zos/zos-mirror-screen.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/zos/zos-input-deck.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/lib/zos-link.ts", import.meta.url)).text(),
      Bun.file(new URL("../web/src/app.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/studio/studio-header.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/zos/zos-console.css", import.meta.url)).text(),
    ]);

    // 五个端点,一个都不能少:状态、镜像(轮询即订阅)、接管、按键注入、音量亮度。
    expect(linkSource).toContain('"/api/os/state"');
    expect(linkSource).toContain('"/api/os/mirror"');
    expect(linkSource).toContain('"/api/os/display"');
    expect(linkSource).toContain('"/api/os/input"');
    expect(linkSource).toContain('"/api/os/settings"');
    expect(linkSource).toContain('method: "PUT"');
    expect(linkSource).toContain('method: "POST"');
    // 设备离线时镜像轮询放慢但绝不停:停了固件就再也收不到 mirror=1。
    expect(linkSource).toContain("export const ZOS_MIRROR_IDLE_POLL_MS = 2_000;");
    expect(linkSource).toContain("export const ZOS_MIRROR_POLL_MS = 250;");
    // 长按阈值与固件 osLogic.cc 的 HOLD_MS 同值,遥控手感即真机手感。
    expect(linkSource).toContain("export const ZOS_HOLD_MS = 600;");

    // 画面不可信时清空画布,而不是留住最后一帧冒充实时。
    expect(mirrorSource).toContain("context.clearRect(0, 0, ZOS_SCREEN_WIDTH, ZOS_SCREEN_HEIGHT)");
    expect(panelSource).toContain("createZosLink");
    expect(panelSource).toContain("link.stop()");
    expect(panelSource).toContain('import "./zos-console.css"');

    // 甲板:按住走固件同款状态机;滚轮必须挂 non-passive 原生监听才能拦下翻页。
    expect(deckSource).toContain("createPressTracker");
    expect(deckSource).toContain("{ passive: false }");
    expect(deckSource).toContain("zosInputForKey");

    // 页面接线:独立视图 + 主导航入口,且不被侧载固件锁死。
    expect(appSource).toContain('view === "zos"');
    // 系统页不接 firmwareMode:它自己长轮询 /api/os/state,再喂一个推导值只会
    // 多一个可能与它自己读数打架的真相来源。
    expect(appSource).toContain("<ZosPanel />");
    expect(appSource).toContain('nextView !== "zos"');
    expect(headerSource).toContain('value="zos"><MonitorCog />系统</Tab>');

    // 整数倍放大:尺寸给在画布上(边框往外包),五个断点都是整数 px。
    // 反过来让边框盒去凑 52:16,扣掉边框剩下的内容宽就不再是 52 的整数倍。
    expect(css).toMatch(/\.zc-screen__frame canvas\s*\{[^}]*width:\s*calc\(52 \* var\(--zc-pixel, 14px\)\);/s);
    expect(css).toMatch(/\.zc-screen__frame\s*\{[^}]*width:\s*fit-content;/s);
    expect(css).toMatch(/\.zc-device\s*\{[^}]*--zc-pixel:\s*14px;/s);
    for (const step of [12, 10, 8, 6, 4]) {
      expect(css).toContain(`{ .zc-device { --zc-pixel: ${step}px; } }`);
    }

    // LED 屏质感与游戏厅同源;盖层在网格之上,不会被网格纹理糊掉。
    expect(css).toMatch(/\.zc-screen__frame canvas\s*\{[^}]*image-rendering:\s*pixelated;/s);
    expect(css).toMatch(/\.zc-screen__frame::after\s*\{[^}]*background-size:\s*calc\(100% \/ 52\)/s);
    expect(css).toMatch(/\.zc-screen__notice\s*\{[^}]*z-index:\s*2;/s);
  });

  test("keeps the system tab reachable while a sideload firmware holds the device", () => {
    const header = renderToStaticMarkup(createElement(StudioHeader, {
      view: "zos",
      onViewChange: () => {},
      runtime: null,
      firmwareLocked: true,
      firmwareKind: "arcade",
    }));
    expect(header).toContain("系统");
    // 内容页锁,系统页不锁——它读的是 tc002-os 自己的拉取链路。
    // 逐个按钮切开再判断:整份 markup 里到处都有 disabled,跨标签的正则会误判。
    const tabButton = (value: string): string =>
      header.split("<button").find((chunk) => chunk.includes(`data-value="${value}"`))!;
    expect(tabButton("console")).toContain("disabled");
    expect(tabButton("zos")).not.toContain("disabled");
    expect(tabButton("zos")).toContain('aria-selected="true"');
  });
});
