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
    // 谁在开面板,是状态条上唯一会变的那一行。
    expect(html).toContain("旋钮自由");
    expect(html).toContain("设备菜单");
    expect(html).toContain("下发到设备");
  });

  test("the page carries one heading, and it is not visible chrome", () => {
    const html = markup(createElement(ZosPanel));
    // 页头的 Tab 已经写着「系统」,面板自己再叠一层眉题 + 大标题 + 一句话
    // 就是同一件事说三遍——标题只留给读屏器。
    expect(html).toContain('<h1 class="sr-only">ZOS 系统控制台</h1>');
    expect(html).not.toContain("DISPLAY CONTROL");
    expect(html).not.toContain("系统固件控制台");
    // 一整块面板,不是三张各带标题的卡。
    expect(html).not.toContain("音量与亮度");
    expect(html).not.toContain("详细状态");
    expect(html.match(/<h1/g)?.length ?? 0).toBe(1);
  });

  test("nothing is pinned, so there is nothing to hand back", () => {
    const html = markup(createElement(ZosPanel));
    // 旧版常驻一个永远禁用的「交还旋钮」;没接管过就没有交还这回事。
    expect(html).not.toContain("交还旋钮");
  });

  test("the read-only facts sit behind a disclosure, not in the first screen", () => {
    const html = markup(createElement(ZosPanel));
    // 抽屉标题说清里面有什么,内容默认不占版面——排障才看的事实不该和
    // 「现在能按什么」抢同一块地方。
    expect(html).toContain("诊断");
    expect(html).toContain("IP · 内存 · 心跳 · 固件驻留");
    for (const label of ["IP 地址", "空闲内存", "Wi-Fi 重连", "最近心跳"]) {
      expect(html).not.toContain(label);
    }
    // 固件驻留在抽屉里的取值(离线时是「未知」)同样不该出现在第一屏。
    expect(html).not.toContain("未知");
    // 概况条（电量 / Wi-Fi / 运行时长）离线时整条消失,而不是展示旧数字。
    expect(html).not.toContain("zc-strip__vitals");
    expect(html).not.toContain("已运行");
  });

  test("volume steps and brightness slides — both are sends, not readouts", () => {
    const html = markup(createElement(ZosPanel));
    // 0–6 共七格,一次动一格:NumberField 的 ± 就是设备侧键的那一步。
    expect(html).toContain("cladd-number-field");
    expect(html).toContain('aria-label="音量，0 到 6 级"');
    // 亮度是比例,滑轨的填充量本身就是读数。
    expect(html).toContain('type="range"');
    expect(html).toContain("亮度（1 到 10 级）");
    // 读不回来不是缺陷,是序列号让设备旋钮压过控制台的代价——所以说「未下发」,
    // 不说「未知」,也不用一整段话解释自己。
    expect(html.match(/未下发/g)?.length ?? 0).toBe(2);
    expect(html).not.toContain("那边的改动不会回读到这里");
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
    // 系统页不要页级标题块:面板自带状态条,再来一层就是第二个页头。
    expect(appSource).toContain('{view !== "zos" && (');
    expect(appSource).not.toContain("TC002 ZOS CONSOLE");

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

  test("the right column is built from the kit, not from divs dressed up as it", () => {
    // 结构本身由 zos-menu.test.ts 真渲染出来看(四个触发器、单开、标记只出现
    // 一次)。这里只留 markup 里看不见的那几条:组件的取舍,以及不该复活的旧写法。
    const html = markup(createElement(ZosPanel));
    // 分组小标题全 app 一个样,所以用 SectionTitle 而不是自己写一层眉题。
    expect(html).toContain("cladd-section-title");
    expect(html.match(/cladd-section-title/g)?.length ?? 0).toBe(2);
    // 离散、一次一格 → NumberField;连续比例 → Slider。
    expect(html).toContain("cladd-number-field");
    expect(html).toContain("cladd-slider");
  });

  test("no hand-rolled facsimile of a kit component crept back in", async () => {
    const [panelSource, menuSource] = await Promise.all([
      Bun.file(new URL("../web/src/components/zos/zos-panel.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/zos/zos-menu.tsx", import.meta.url)).text(),
    ]);

    // 防抖用组件自带的,不再手搓 setTimeout——旧版那个 250ms debounce 加两个
    // ref 就是这么长出来的。
    expect(panelSource).toContain("throttle={BRIGHTNESS_THROTTLE_MS}");
    expect(panelSource).not.toContain("setTimeout");
    // 只读事实是「刻进去」的槽,不是又一张卡片。抽屉默认收起,渲染不出来,
    // 所以这一条只能在源码上盯。
    expect(panelSource).toContain("<SurfaceCut");
    // multiple 不传:一次开一个,与设备一次只显示一环同构。
    expect(menuSource).not.toContain("multiple");
    // 独立 Chip 不下探到 xs/2xs——那两档是给嵌套用的,单独站一行读不出来。
    for (const source of [panelSource, menuSource]) {
      expect(source).not.toMatch(/<Chip[^>]*size="(2xs|xs)"/);
    }
    // Surface 的 className 管盒子、contentClassName 管里面,别把布局写反。
    expect(panelSource).toMatch(/contentClassName="flex flex-col"/);
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
