import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import { ZosPanel } from "../web/src/components/zos/zos-panel";
import { ZosMirrorScreen } from "../web/src/components/zos/zos-mirror-screen";
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
    // 接管状态与读数区。
    expect(html).toContain("旋钮自由");
    // 频道之外还有音乐/游戏/设置三项,「设备频道」不覆盖它们。
    expect(html).toContain("设备菜单");
    expect(html).toContain("设备状态");
    expect(html).toContain("交还旋钮");
    expect(html).toContain("立即刷新");
    // Wi-Fi 重连次数是安全属性,不是花絮:0 次代表固件没动过无线链路。
    expect(html).toContain("Wi-Fi 重连");
  });

  test("shows 离线 for every telemetry field instead of stale numbers", () => {
    const html = markup(createElement(ZosPanel));
    for (const label of ["当前界面", "设备焦点", "IP 地址", "运行时长", "空闲内存", "最近心跳"]) {
      expect(html).toContain(label);
    }
    // 八个读数行在离线时全部塌成「离线」。
    expect(html.match(/离线/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
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

    expect(offline).toContain("zos-screen__notice");
    expect(offline).toContain("设备离线");
    expect(waiting).toContain("等待画面");
    expect(stale).toContain("画面已停更");
    expect(stale).toContain("8 秒前");
    // 只有真正的实时画面才没有盖层——那是唯一可以只看屏幕的状态。
    expect(liveNow).not.toContain("zos-screen__notice");
    expect(liveNow).toContain("实时同步中");
  });

  test("is mounted as its own view, unlocked by sideload firmware", async () => {
    const [panelSource, mirrorSource, linkSource, appSource, headerSource, css] = await Promise.all([
      Bun.file(new URL("../web/src/components/zos/zos-panel.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/zos/zos-mirror-screen.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/lib/zos-link.ts", import.meta.url)).text(),
      Bun.file(new URL("../web/src/app.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/studio/studio-header.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/styles/globals.css", import.meta.url)).text(),
    ]);

    // 三个端点,一个都不能少:状态、镜像(轮询即订阅)、接管。
    expect(linkSource).toContain('"/api/os/state"');
    expect(linkSource).toContain('"/api/os/mirror"');
    expect(linkSource).toContain('"/api/os/display"');
    expect(linkSource).toContain('method: "PUT"');
    // 设备离线时镜像轮询放慢但绝不停:停了固件就再也收不到 mirror=1。
    expect(linkSource).toContain("export const ZOS_MIRROR_IDLE_POLL_MS = 2_000;");
    expect(linkSource).toContain("export const ZOS_MIRROR_POLL_MS = 250;");

    // 画面不可信时清空画布,而不是留住最后一帧冒充实时。
    expect(mirrorSource).toContain("context.clearRect(0, 0, ZOS_SCREEN_WIDTH, ZOS_SCREEN_HEIGHT)");
    expect(panelSource).toContain("createZosLink");
    expect(panelSource).toContain("link.stop()");

    // 页面接线:独立视图 + 主导航入口,且不被侧载固件锁死。
    expect(appSource).toContain('view === "zos"');
    // 系统页不接 firmwareMode:它自己长轮询 /api/os/state,再喂一个推导值只会
    // 多一个可能与它自己读数打架的真相来源。
    expect(appSource).toContain("<ZosPanel />");
    expect(appSource).toContain('nextView !== "zos"');
    expect(headerSource).toContain('value="zos"><MonitorCog />系统</Tab>');

    // 整数倍放大:尺寸给在画布上(边框往外包),四个断点都是整数 px。
    // 反过来让边框盒去凑 52:16,扣掉边框剩下的内容宽就不再是 52 的整数倍。
    expect(css).toMatch(/\.zos-screen__frame canvas\s*\{[^}]*width:\s*calc\(52 \* var\(--zos-pixel, 14px\)\);/s);
    expect(css).toMatch(/\.zos-screen__frame\s*\{[^}]*width:\s*fit-content;/s);
    expect(css).toMatch(/\.zos-stage\s*\{[^}]*--zos-pixel:\s*14px;/s);
    for (const step of [12, 10, 8, 6, 4]) {
      expect(css).toContain(`{ .zos-stage { --zos-pixel: ${step}px; } }`);
    }

    // LED 屏质感与游戏厅同源;盖层在网格之上,不会被网格纹理糊掉。
    expect(css).toMatch(/\.zos-screen__frame canvas\s*\{[^}]*image-rendering:\s*pixelated;/s);
    expect(css).toMatch(/\.zos-screen__frame::after\s*\{[^}]*background-size:\s*calc\(100% \/ 52\)/s);
    expect(css).toMatch(/\.zos-screen__notice\s*\{[^}]*z-index:\s*2;/s);
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
