import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import { ZosPanel } from "../web/src/components/zos/zos-panel";
import { ZosMirrorScreen } from "../web/src/components/zos/zos-mirror-screen";
import { ZosInputDeck } from "../web/src/components/zos/zos-input-deck";
import {
  ZosFirmwareUpdate,
  type ZosFirmwareUpdateProps,
} from "../web/src/components/zos/zos-firmware-update";
import { StudioHeader } from "../web/src/components/studio/studio-header";
import {
  describeImageAge,
  describeMirror,
  describeUpgradeWatch,
  formatImageBytes,
  parseFirmwareStatus,
  parseUpgradeSeq,
} from "../web/src/lib/zos-link.ts";

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

  test("the panel contributes no heading of its own", () => {
    const html = markup(createElement(ZosPanel));
    // 页级标题是 app.tsx 的 .page-heading,全站一块骨架;面板再出一个(哪怕是
    // sr-only)就是同一页两个名字。整页只有一个 h1 这条,由 app 级用例去数——
    // 这里单渲面板看不见页头,断言不了整页。
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("DISPLAY CONTROL");
    expect(html).not.toContain("系统固件控制台");
    expect(html).not.toContain("ZOS 系统控制台");
    // 一整块面板,不是三张各带标题的卡。
    expect(html).not.toContain("音量与亮度");
    expect(html).not.toContain("详细状态");
  });

  test("nothing is pinned, so there is nothing to hand back", () => {
    const html = markup(createElement(ZosPanel));
    // 旧版常驻一个永远禁用的「交还旋钮」;没接管过就没有交还这回事。
    expect(html).not.toContain("交还旋钮");
  });

  test("the read-only facts left this page entirely — they live in 常规设置 now", () => {
    const html = markup(createElement(ZosPanel));
    // 排障才看的事实搬进了设置对话框(设备信息标签页),这一页只留「现在能按
    // 什么」:镜像、遥控、菜单、下发。连那个抽屉一起搬走,不是收起来。
    expect(html).not.toContain("诊断");
    expect(html).not.toContain("IP · 内存 · 心跳 · 固件驻留");
    for (const label of ["IP 地址", "空闲内存", "Wi-Fi 重连", "最近心跳", "固件驻留"]) {
      expect(html).not.toContain(label);
    }
    expect(html).not.toContain("未知");
    // 概况条（电量 / Wi-Fi / 运行时长）离线时整条消失,而不是展示旧数字。
    expect(html).not.toContain("zc-strip__vitals");
    expect(html).not.toContain("已运行");
  });

  test("蓝牙配网 moved into 常规设置, except where the dialog cannot help", () => {
    const html = markup(createElement(ZosPanel));
    // 设备在线时配网是设置里的一行(菜单里不再有它)。离线时它必须留在这里:
    // deriveFirmwareMode 只认活着的上报,所以一台掉线的 ZOS 在对话框眼里是
    // 「官方固件」,那边迎接它的是原厂固件那张读不出东西的表。
    expect(html).toContain("蓝牙配网");
    const menu = html.slice(html.indexOf("设备菜单"));
    expect(menu).not.toContain("蓝牙配网");
  });

  test("volume and brightness are one control twice — both are sends, not readouts", () => {
    const html = markup(createElement(ZosPanel));
    // 和「常规设置 → 显示与声音」同一套:两条一样的滑块,标签在左、读数在右。
    // 一上一下摆两种控件,是用户第一眼就看出来的那处不一致。
    expect(html.match(/type="range"/g)?.length ?? 0).toBe(2);
    expect(html).not.toContain("cladd-number-field");
    // Slider 自己没有可及名字,靠外层 label 里的 sr-only 取名。
    expect(html).toContain('<span class="sr-only">音量</span>');
    expect(html).toContain('<span class="sr-only">亮度</span>');
    // 读不回来不是缺陷,是序列号让设备旋钮压过控制台的代价——所以说「未下发」,
    // 不说「未知」,也不用一整段话解释自己。
    expect(html.match(/未下发/g)?.length ?? 0).toBe(2);
    expect(html.match(/is-unsent/g)?.length ?? 0).toBe(2);
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
    // 系统页和其他 Tab 一样有且只有一个页级标题块:之前多出来的是页头下面
    // 那块讲同一件事的分区标题,删的是它,页头本身是全站统一的骨架。
    expect(appSource).toContain("TC002 ZOS CONSOLE");
    expect(appSource).not.toContain('{view !== "zos" && (');
    // 页头是无条件渲染的,所以它就是整页唯一的 h1——前提是没人再往组件里塞
    // 第二个。下一条用例守这个前提。
    expect(appSource).toMatch(/<div className="page-heading">/);

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

  test("every view has exactly one h1, because only the shell writes one", async () => {
    // 系统页曾经同时有两个 h1:页头的「系统控制台」,和面板里留下的 sr-only
    // 「ZOS 系统控制台」。读屏器按标题跳转会把同一页连报两个名字——用户投诉的
    // 「两层标题」换了个地方活着。
    //
    // 单渲面板数不出整页的重复(它看不见页头),整页又没法在 SSR 里跑起来,所以
    // 这条钉在源码上:标题只能由 app.tsx 的骨架出,组件树里一个 h1 都不许有。
    const root = new URL("../web/src/components/", import.meta.url);
    const files = Array.from(new Bun.Glob("**/*.tsx").scanSync(fileURLToPath(root)));
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await Bun.file(new URL(file, root)).text();
      if (/<h1[\s>]/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);

    // 反过来,页级标题必须真的存在于骨架里,否则上面那条会在「谁都没有标题」
    // 的情况下也通过。
    const appSource = await Bun.file(new URL("../web/src/app.tsx", import.meta.url)).text();
    expect(appSource).toContain("<h1>{pageCopy.title}</h1>");
  });

  test("the right column is built from the kit, not from divs dressed up as it", () => {
    // 结构本身由 zos-menu.test.ts 真渲染出来看(四个触发器、单开、标记只出现
    // 一次)。这里只留 markup 里看不见的那几条:组件的取舍,以及不该复活的旧写法。
    const html = markup(createElement(ZosPanel));
    // 分组小标题全 app 一个样,所以用 SectionTitle 而不是自己写一层眉题。
    // 三块:设备菜单、下发到设备、固件更新。
    expect(html).toContain("cladd-section-title");
    expect(html.match(/cladd-section-title/g)?.length ?? 0).toBe(3);
    // 音量与亮度都用 Slider:全 app 只有「常规设置」那一处在调这两个值,
    // 那边两条都是 Slider,这里跟着走。
    expect(html).toContain("cladd-slider");
  });

  test("no hand-rolled facsimile of a kit component crept back in", async () => {
    const [panelSource, menuSource] = await Promise.all([
      Bun.file(new URL("../web/src/components/zos/zos-panel.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/zos/zos-menu.tsx", import.meta.url)).text(),
    ]);

    // 防抖用组件自带的,不再手搓 setTimeout——旧版那个 250ms debounce 加两个
    // ref 就是这么长出来的。现在连滑块本体都在 zos-send-row.tsx,两处共用。
    const sendRowSource = await Bun.file(
      new URL("../web/src/components/zos/zos-send-row.tsx", import.meta.url),
    ).text();
    expect(sendRowSource).toContain("throttle={SETTINGS_THROTTLE_MS}");
    expect(panelSource).not.toContain("setTimeout");
    expect(panelSource).toContain("<ZosSendRows");
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

// --- 固件更新 ---------------------------------------------------------------

const NOW = 1_700_000_000_000;

const PACKED: ZosFirmwareUpdateProps["status"] = {
  packed: true,
  image: { buildId: "zos-2026.08.14+3f2a1c", bytes: 8_912_896, builtAt: NOW - 2 * 3_600_000 },
};

function updateMarkup(overrides: Partial<ZosFirmwareUpdateProps> = {}): string {
  return markup(createElement(ZosFirmwareUpdate, {
    mode: "zos",
    zosFlashed: true,
    live: true,
    status: { packed: false, image: null },
    statusError: null,
    request: null,
    serverSeq: null,
    now: NOW,
    busy: false,
    consent: false,
    onConsentChange: () => {},
    onUpgrade: () => {},
    onRefreshStatus: () => {},
    ...overrides,
  }));
}

/** 装机按钮那一段 markup;整份里到处都有 disabled,得先把按钮切出来再判断。 */
function installButton(html: string): string | undefined {
  return html.split("<button").find((chunk) => chunk.includes("更新时钟固件"));
}

describe("zos firmware update", () => {
  test("no image packed: says how to make one, and offers no button that cannot work", () => {
    const html = updateMarkup({ status: { packed: false, image: null } });

    expect(html).toContain("固件更新");
    expect(html).toContain("还没有打包镜像");
    expect(html).toContain("mise run os-image");
    // 按下去必然失败的入口比没有入口更糟。
    expect(installButton(html)).toBeUndefined();
    expect(html).not.toContain("我知道更新期间会发生什么");
    // 打完包不该要求刷新整页。
    expect(html).toContain("重新读取");
  });

  test("an image on disk is described by its own facts, and only those", () => {
    const html = updateMarkup({ status: PACKED });

    expect(html).toContain("镜像已就绪");
    expect(html).toContain("zos-2026.08.14+3f2a1c");
    expect(html).toContain("8.5 MB");
    expect(html).toContain("2 小时前");
    expect(installButton(html)).toBeDefined();

    // 服务没说的字段一律不占位:凭空的版本号会被当成真的。
    const bare = updateMarkup({ status: { packed: true, image: { buildId: null, bytes: null, builtAt: null } } });
    expect(bare).toContain("镜像已就绪");
    expect(bare).not.toContain("版本");
    expect(bare).not.toContain("大小");
    expect(bare).not.toContain("打包于");
    expect(installButton(bare)).toBeDefined();
  });

  test("the status read can fail, and then it says so instead of showing an old image", () => {
    const html = updateMarkup({ status: null, statusError: "HTTP 404" });
    expect(html).toContain("读不到镜像信息");
    expect(html).toContain("HTTP 404");
    expect(html).toContain('role="alert"');
    expect(installButton(html)).toBeUndefined();

    const loading = updateMarkup({ status: null });
    expect(loading).toContain("正在读取镜像信息…");
    expect(installButton(loading)).toBeUndefined();
  });

  test("the button is gated on an explicit consent that says what will happen", () => {
    const unchecked = updateMarkup({ status: PACKED, consent: false });
    // 侧载面板同款:先把要发生的事说完,再让人勾。
    expect(unchecked).toContain("时钟会下载镜像、写入 flash 并重启，期间面板会短暂无响应；断电会中断安装。");
    expect(installButton(unchecked)).toContain("disabled");

    const checked = updateMarkup({ status: PACKED, consent: true });
    expect(installButton(checked)).not.toContain("disabled");
  });

  test("a request in flight is reported by what the console can see, and nothing more", () => {
    const request = { seq: 3, at: NOW - 90_000, sawOffline: false };

    const sent = updateMarkup({ status: PACKED, consent: true, request, serverSeq: 3 });
    expect(sent).toContain("已下发更新请求");
    expect(sent).toContain("已过 1 分 30 秒");
    // 编号不是次数:服务端发的是纪元秒,固件按「比装过的更新」比较。渲染成
    // 「第 N 次」会写出「第 1786721798 次」——既不对也荒唐。
    expect(sent).toContain("编号 3");
    expect(sent).not.toContain("第 3 次");
    // 一次在途的安装,不能被第二次点击追上。
    expect(installButton(sent)).toContain("disabled");

    // 设备掉线正是我们要它做的事:此时门禁那句「先把它连回网络」是错的,不许出现。
    const installing = updateMarkup({
      mode: "official",
      zosFlashed: true,
      live: false,
      status: PACKED,
      consent: true,
      request,
      serverSeq: 3,
    });
    expect(installing).toContain("设备已离线");
    expect(installing).toContain("断电会中断安装");
    expect(installing).not.toContain("时钟没有在上报");

    const returned = updateMarkup({
      status: PACKED,
      consent: true,
      request: { ...request, sawOffline: true },
      serverSeq: 3,
    });
    expect(returned).toContain("设备已重启并回到在线");
    // 观察不到的成功就不许宣布——装上的是哪一版由时钟自己说。
    expect(returned).not.toContain("更新成功");
    expect(returned).not.toContain("已更新");
    // 回来了就可以再来一次。
    expect(installButton(returned)).not.toContain("disabled");
  });

  test("other firmwares are told what this section is, not just that it is off", () => {
    // 没在上报 ZOS:没有可更新的对象,连镜像信息都不摆。
    const nothing = updateMarkup({ mode: "official", zosFlashed: false, live: false, status: PACKED });
    expect(nothing).toContain("当前不适用");
    expect(nothing).toContain("ZOS 系统固件");
    expect(nothing).not.toContain("镜像已就绪");
    expect(installButton(nothing)).toBeUndefined();

    // 侧载占着时钟:出路是先结束侧载,不是「不可用」。
    const music = updateMarkup({ mode: "music", zosFlashed: true, live: false, status: PACKED });
    expect(music).toContain("音乐固件正占着时钟");
    expect(music).toContain("先结束侧载");
    expect(installButton(music)).toBeUndefined();

    // 刷了 ZOS 但掉线:更新要设备自己下载镜像,所以先把它连回网络。
    const offline = updateMarkup({ mode: "official", zosFlashed: true, live: false, status: PACKED });
    expect(offline).toContain("时钟没有在上报");
    expect(offline).toContain("蓝牙配网");
    expect(installButton(offline)).toBeUndefined();
  });

  test("the panel's first paint offers no install — nothing has reported yet", () => {
    const html = markup(createElement(ZosPanel));
    expect(html).toContain("固件更新");
    expect(html).toContain("当前不适用");
    expect(installButton(html)).toBeUndefined();
  });

  test("reads the image status field by field, and never invents one", () => {
    // 认得出的两种写法都收,认不出的一律留白——这些数字紧挨着一个会重写闪存的按钮。
    expect(parseFirmwareStatus({ packed: true, image: { buildId: "b1", bytes: 1024, builtAt: 7 } }))
      .toEqual({ packed: true, image: { buildId: "b1", bytes: 1024, builtAt: 7 } });
    expect(parseFirmwareStatus({ image: { buildId: "b1", size: 2048, builtAtMs: 9 } }))
      .toEqual({ packed: true, image: { buildId: "b1", bytes: 2048, builtAt: 9 } });
    // 200 不等于「有镜像」。
    expect(parseFirmwareStatus({})).toEqual({ packed: false, image: null });
    expect(parseFirmwareStatus({ packed: false, image: { buildId: "b1" } }))
      .toEqual({ packed: false, image: null });
    expect(parseFirmwareStatus(null)).toEqual({ packed: false, image: null });
    // 类型不对的字段当成没给,而不是照着渲染。
    expect(parseFirmwareStatus({ packed: true, image: { buildId: 7, bytes: "big", builtAt: -1 } }))
      .toEqual({ packed: true, image: { buildId: null, bytes: null, builtAt: null } });

    expect(parseUpgradeSeq({ seq: 4 })).toBe(4);
    expect(parseUpgradeSeq({ upgrade: { seq: 4 } })).toBe(4);
    // 服务没给回执,请求仍然算发出去了——null,不是 0,更不是 NaN。
    expect(parseUpgradeSeq({ ok: true })).toBeNull();
  });

  test("image size and age are formatted, and skew never becomes a future build", () => {
    expect(formatImageBytes(8_912_896)).toBe("8.5 MB");
    expect(formatImageBytes(4_096)).toBe("4 KB");
    expect(formatImageBytes(null)).toBeNull();

    expect(describeImageAge(NOW - 30_000, NOW)).toBe("刚刚");
    expect(describeImageAge(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(describeImageAge(NOW - 3 * 3_600_000, NOW)).toBe("3 小时前");
    expect(describeImageAge(NOW - 50 * 3_600_000, NOW)).toBe("2 天前");
    // 服务盖的时间戳,浏览器的时钟——差几秒是时钟偏差,不是「未来打包的镜像」。
    expect(describeImageAge(NOW + 4_000, NOW)).toBe("刚刚");
    expect(describeImageAge(null, NOW)).toBeNull();
  });

  test("the watch reports the sequence the service still carries, not the one we sent", () => {
    // 服务重启会把序号清掉,设备就永远看不到这次请求了;所以回执优先读服务的。
    const watch = describeUpgradeWatch({
      request: { seq: 2, at: NOW - 1_000, sawOffline: false },
      live: true,
      serverSeq: 5,
      now: NOW,
    });
    expect(watch.receipt).toContain("编号 5");
    const fallback = describeUpgradeWatch({
      request: { seq: 2, at: NOW - 1_000, sawOffline: false },
      live: true,
      serverSeq: null,
      now: NOW,
    });
    expect(fallback.receipt).toContain("编号 2");
    const silent = describeUpgradeWatch({
      request: { seq: null, at: NOW - 1_000, sawOffline: false },
      live: true,
      serverSeq: null,
      now: NOW,
    });
    expect(silent.receipt).toBeNull();
  });

  test("the console asks once, on the endpoints the service exposes", async () => {
    const [linkSource, panelSource] = await Promise.all([
      Bun.file(new URL("../web/src/lib/zos-link.ts", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/zos/zos-panel.tsx", import.meta.url)).text(),
    ]);

    expect(linkSource).toContain('"/api/os/firmware/status"');
    expect(linkSource).toContain('"/api/os/upgrade"');
    // 装机是明确的人为动作,不是轮询:面板只在装载时读一次镜像信息,写只走点击。
    expect(panelSource).toContain("link.requestUpgrade()");
    expect(panelSource).not.toContain("setInterval(() => void loadFirmware");
  });
});
