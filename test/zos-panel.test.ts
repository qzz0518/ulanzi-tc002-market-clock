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
  isRestoreArmed,
  parseFirmwareStatus,
  parseUpgradeSeq,
  type ZosFirmwareStatus,
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

    // 整数倍放大:尺寸给在画布上(边框往外包),档位是整数 px。反过来让边框盒去凑
    // 52:16,扣掉边框剩下的内容宽就不再是 52 的整数倍。
    expect(css).toMatch(/\.zc-screen__frame canvas\s*\{[^}]*width:\s*calc\(52 \* var\(--zc-pixel, 14px\)\);/s);
    expect(css).toMatch(/\.zc-screen__frame\s*\{[^}]*width:\s*fit-content;/s);
    expect(css).toMatch(/\.zc-device\s*\{[^}]*--zc-pixel:\s*14px;/s);
    expect(css).toContain("{ .zc-device { --zc-pixel: 12px; } }");

    // ……但只在双列里成立。单列时设备列就是整页,整数倍必然剩下 avail mod 52
    // 的余量:412px 手机上实测 26px、430px 上 44px(12%)、768px 上 165px(24%),
    // 右侧一条空带,被当成「预览没占满宽度」报回来过。窄屏改满宽,上限收在桌面
    // 最大档,免得窄窗口里的镜像反而比桌面还大。
    const singleColumn = css.slice(css.indexOf("@media (max-width: 60rem)"));
    expect(singleColumn).toContain(
      ".zc-device > * { max-width: min(100%, calc(52 * 14px + 2 * var(--zc-bezel))); }",
    );
    expect(singleColumn).toContain(".zc-screen__frame { width: 100%; }");
    expect(singleColumn).toContain(".zc-screen__frame canvas { width: 100%; }");
    // 60rem 以下的老档位必须删干净:留着只会是满宽规则下面的死代码,读的人会
    // 以为窄屏还在走整数倍。
    for (const step of [10, 8, 6, 4]) {
      expect(css).not.toContain(`--zc-pixel: ${step}px`);
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
    // 结构本身由 zos-menu.test.ts 真渲染出来看(五个目的地、单开、标记只出现
    // 一次)。这里只留 markup 里看不见的那几条:组件的取舍,以及不该复活的旧写法。
    const html = markup(createElement(ZosPanel));
    // 分组小标题全 app 一个样,所以用 SectionTitle 而不是自己写一层眉题。
    // 两块:设备菜单、下发到设备。固件那一块搬去 常规设置 了。
    expect(html).toContain("cladd-section-title");
    expect(html.match(/cladd-section-title/g)?.length ?? 0).toBe(2);
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

// --- 固件 -------------------------------------------------------------------
//
// 这一节现在长在 常规设置 里（第 04 节），不在系统面板上：固件是设备属性，
// 和亮度、息屏、网络同类。组件本身还是单独渲染来断言——cladd 的 Dialog 走
// portal，服务端渲染出来是空串。

const NOW = 1_700_000_000_000;

const PACKED: ZosFirmwareUpdateProps["status"] = {
  packed: true,
  image: {
    buildId: "aa7ab843c11ec2713a023b4a20f52b14",
    bytes: 8_912_896,
    builtAt: NOW - 2 * 3_600_000,
    md5: "08e9fc52338abd686ee822295a051327",
    partitionType: 3,
    partitionLabel: "res",
    zosBuildId: null,
    filesystemBuiltAt: NOW - 3 * 3_600_000,
  },
  source: { kind: "packed", fileName: null, at: NOW - 2 * 3_600_000 },
  shadowedPacked: null,
  restore: null,
};

const NOTHING: ZosFirmwareUpdateProps["status"] = {
  packed: false,
  image: null,
  source: null,
  shadowedPacked: null,
  restore: null,
};

/** 那份取不回来的官方固件,如同服务报出来的样子。 */
const RESTORE: NonNullable<ZosFirmwareStatus["restore"]> = {
  available: true,
  path: "/srv/clock/.runtime/tc002-stock/restore-live.img",
  bytes: 2_781_756,
  builtAt: NOW - 30 * 24 * 3_600_000,
};

/**
 * 还原点已经躺在待装位里:服务把它当成一次上传收下,所以 source 就是 upload,
 * 文件名正是还原点路径的末段——控制台正是靠这两者对上才知道待装的是它。
 */
const ARMED: ZosFirmwareUpdateProps["status"] = {
  ...PACKED,
  image: { ...PACKED!.image!, bytes: RESTORE.bytes, partitionType: 3, partitionLabel: "res" },
  source: { kind: "upload", fileName: "restore-live.img", at: NOW - 60_000 },
  restore: RESTORE,
};

function updateMarkup(overrides: Partial<ZosFirmwareUpdateProps> = {}): string {
  return markup(createElement(ZosFirmwareUpdate, {
    mode: "zos",
    zosFlashed: true,
    live: true,
    status: NOTHING,
    statusError: null,
    request: null,
    serverSeq: null,
    now: NOW,
    busy: false,
    uploading: false,
    consent: false,
    onConsentChange: () => {},
    onUpgrade: () => {},
    onRefreshStatus: () => {},
    onUpload: () => {},
    onRemoveUpload: () => {},
    onArmRestore: () => {},
    restoring: false,
    ...overrides,
  }));
}

/** 装机按钮那一段 markup;整份里到处都有 disabled,得先把按钮切出来再判断。 */
function installButton(html: string): string | undefined {
  return html.split("<button").find((chunk) => chunk.includes("安装到时钟"));
}

/** 选文件那一颗，同理。 */
function uploadButton(html: string): string | undefined {
  return html.split("<button").find((chunk) => chunk.includes("选择镜像文件"));
}

/** 还原点那一行自己的按钮:「放入待装位」/「已放入待装位」。 */
function restoreButton(html: string): string | undefined {
  return html.split("<button").find((chunk) => chunk.includes("放入待装位"));
}

/**
 * 装机那一颗在还原模式下改叫「还原官方固件」——和上面那一行的标签同名。
 *
 * 按 <button 切出来的段落是从一颗按钮到下一颗,所以那个 <label> 会落在**前一颗**
 * 按钮的段里(实测:「移除上传」那一段就带着它)。闭合标签是唯一分得开的东西。
 */
function restoreInstallButton(html: string): string | undefined {
  return html.split("<button").find((chunk) => chunk.includes("还原官方固件</span>"));
}

describe("zos firmware update", () => {
  test("no image: names both ways to get one, and offers no button that cannot work", () => {
    const html = updateMarkup({ status: NOTHING });

    expect(html).toContain("还没有可安装的镜像");
    // 上传是给这台钟的主人的；打包是给开发者的。两条路都说，别只说后者。
    expect(html).toContain("上传一份 .img");
    expect(html).toContain("mise run os-image");
    // 按下去必然失败的入口比没有入口更糟。
    expect(installButton(html)).toBeUndefined();
    expect(html).not.toContain("我知道更新期间会发生什么");
    // 但选文件永远可以按:没有镜像的时候，它正是要做的那件事。
    expect(uploadButton(html)).toBeDefined();
    expect(uploadButton(html)).not.toContain("disabled");
    expect(html).toContain("重新读取");
  });

  test("an image is described by its own facts: size, whole-file MD5, target partition", () => {
    const html = updateMarkup({ status: PACKED });

    expect(html).toContain("8.5 MB");
    // 人能自己核对的那个数——对文件跑一次 md5 就能比。
    expect(html).toContain("08e9fc52338abd686ee822295a051327");
    // 写哪个分区。服务只放 res 过，所以这一行是确认，而 res 正是最该被确认的。
    expect(html).toContain("res（mtd3）");
    // 版本读不出来就写「未知」，并且说清为什么。编一个像版本号的东西出来，
    // 会被当成真的版本号。
    expect(html).toContain("未知");
    expect(html).toContain("隔着一层 xz 压缩读不出来");
    expect(html).toContain("2 小时前");
    expect(installButton(html)).toBeDefined();
    // 一页一颗「重新读取」:有镜像时那颗在对话框脚上,这一节不再常驻一个同名按钮。
    expect(html).not.toContain("重新读取");

    // 服务真的给了版本号时，就照给的写，不再有「未知」那一套说辞。
    const stamped = updateMarkup({
      status: { ...PACKED, image: { ...PACKED.image!, zosBuildId: "3f2a1c9-202608141930" } },
    });
    expect(stamped).toContain("3f2a1c9-202608141930");
    expect(stamped).not.toContain("隔着一层 xz 压缩读不出来");

    // 服务没说的字段一律不占位。
    const bare = updateMarkup({
      status: {
        packed: true,
        image: {
          buildId: null, bytes: null, builtAt: null, md5: null,
          partitionType: null, partitionLabel: null, zosBuildId: null, filesystemBuiltAt: null,
        },
        source: null,
        shadowedPacked: null,
        restore: null,
      },
    });
    expect(bare).not.toContain("大小");
    expect(bare).not.toContain("整包 MD5");
    expect(bare).not.toContain("写入分区");
    expect(installButton(bare)).toBeDefined();
  });

  // 装错版本那一晚就是这么来的:分不清「这是我刚打的」和「这是别人给我的」。
  test("says where the armed image came from, and never lets a local pack hide behind an upload", () => {
    const packed = updateMarkup({ status: PACKED });
    expect(packed).toContain("本地打包");
    expect(packed).toContain("mise run os-image");
    // 本地打包的那一份就是要装的那一份,没有第二份可提。
    expect(packed).not.toContain("移除上传");
    expect(packed).not.toContain("没有被选中");

    const uploaded = updateMarkup({
      status: {
        ...PACKED,
        source: { kind: "upload", fileName: "zos-2026.08.15.img", at: NOW - 5 * 60_000 },
        shadowedPacked: { bytes: 1_045_052, builtAt: NOW - 60_000 },
      },
    });
    expect(uploaded).toContain("本次上传");
    expect(uploaded).toContain("zos-2026.08.15.img");
    expect(uploaded).toContain("5 分钟前");
    // 仓库里那一份还在,而且不会被装——说出来,别让它悄悄躺着。
    expect(uploaded).toContain("本地打包的镜像没有被选中");
    expect(uploaded).toContain("1021 KB");
    // 并且给得出回头路。
    expect(uploaded).toContain("移除上传");
  });

  // 上传和安装是两步。这是整个设计的支点:上传成功和「这就是我要的那一版」
  // 是两个说法,后者的结局是擦掉 mtd3。
  test("uploading is offered without consent, and installing still is not", () => {
    const html = updateMarkup({ status: PACKED, consent: false });
    // 选文件不需要勾任何东西:它不动设备。
    expect(uploadButton(html)).not.toContain("disabled");
    expect(html).toContain("上传只是准备镜像，不会开始安装");
    // 装机需要。
    expect(installButton(html)).toContain("disabled");

    // 上传在途时,装机按钮压住:两件事不能同时在飞。
    const busy = updateMarkup({ status: PACKED, consent: true, uploading: true });
    expect(installButton(busy)).toContain("disabled");
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

  // 还原点这一行和上传是同一件事——把镜像放进待装位,然后停手。值得单独一行的
  // 原因只有一个:那份镜像补不回来。它是刷 ZOS 之前从这台设备现役分区取下的,
  // Ulanzi 不提供下载,设备没有恢复分区,现在再跑一次打包器只会打出正在跑的 ZOS。
  test("the restore row says which of its three states it is in, and invents no fourth", () => {
    // 服务端太老、根本没这个字段 → 整行不出现。「这台机器没有还原点」是个断言,
    // 而这样的服务从没被问到过——沉默好过替它回答。
    const silent = updateMarkup({ status: PACKED });
    expect(restoreButton(silent)).toBeUndefined();
    expect(silent).not.toContain("放进待装位");

    // 配了路径但文件不在 → 说清它补不回来,而不是给一条会悄悄打出错东西的命令。
    const gone = updateMarkup({
      status: { ...PACKED, restore: { ...RESTORE, available: false, bytes: null, builtAt: null } },
    });
    expect(gone).toContain("这台机器上没有还原点");
    expect(gone).toContain("补不回来");
    expect(gone).toContain("Ulanzi 不提供固件下载");
    // 按下去必然失败的入口比没有入口更糟——这一节别处已经守着这条规矩了。
    expect(restoreButton(gone)).toContain("disabled");
    expect(gone).not.toContain("mise run os-restore-image");

    // 有 → 说它是什么、多大,并且和上传那一行一样明说这一步不装。
    const ready = updateMarkup({ status: { ...PACKED, restore: RESTORE } });
    expect(ready).toContain("刷 ZOS 之前从这台设备取下的 Ulanzi 官方固件");
    expect(ready).toContain("2.7 MB");
    expect(ready).toContain("不会开始安装");
    expect(restoreButton(ready)).not.toContain("disabled");
    expect(restoreButton(ready)).toContain("放入待装位");

    // 已经在待装位里 → 按钮改口并停手,免得再发一次一模一样的装填。
    const armed = updateMarkup({ status: ARMED });
    expect(restoreButton(armed)).toContain("已放入待装位");
    expect(restoreButton(armed)).toContain("disabled");

    // 装填在途:和上传一样,它自己转,别人不许动。
    const busy = updateMarkup({ status: { ...PACKED, restore: RESTORE }, restoring: true });
    expect(restoreButton(busy)).toContain("disabled");
    expect(installButton(busy)).toContain("disabled");
  });

  // 同一颗按钮,两种相反的结局。装 ZOS 是「时钟还是我们的」;装还原点是把时钟还给
  // Ulanzi,连带这个控制台和设备之间的链路一起消失。旁边摆一句通用的同意语,就是
  // 有一半的时候在让人同意另一件事——而这一半正是不可逆的那一半。
  test("arming the restore point swaps the consent and the button, not just their colour", () => {
    const armed = updateMarkup({ status: ARMED, consent: true });

    expect(armed).toContain("我知道这会把 ZOS 从时钟上抹掉");
    expect(armed).toContain("装完时钟回到出厂那套界面");
    // 说到底会失去什么,要点名:这三样正是这台钟被刷成 ZOS 的理由。
    expect(armed).toContain("VIBE、音乐、游戏和这个控制台的设备连接都会消失");
    expect(armed).toContain("得重新刷一次 ZOS");
    // 装 ZOS 那句必须消失,而不是被挤到下面还留着。
    expect(armed).not.toContain("我知道更新期间会发生什么");
    // 按钮同理:待装的是官方固件,就不该写着「安装到时钟」。
    expect(installButton(armed)).toBeUndefined();
    expect(restoreInstallButton(armed)).toBeDefined();
    expect(restoreInstallButton(armed)).not.toContain("disabled");
    // 勾选框和按钮一起转成橙色:这一节别处用 brand,橙色在这里只有一个意思。
    expect(armed).toContain("orange");

    // 反过来:待装的是一份 ZOS 上传,说的就必须是 ZOS 那一套。
    const zos = updateMarkup({
      status: { ...ARMED, source: { kind: "upload", fileName: "zos-2026.08.15.img", at: NOW - 60_000 } },
      consent: true,
    });
    expect(zos).toContain("我知道更新期间会发生什么");
    expect(zos).not.toContain("我知道这会把 ZOS 从时钟上抹掉");
    expect(installButton(zos)).toBeDefined();
    expect(restoreInstallButton(zos)).toBeUndefined();
    // 还原点仍然在,只是没被装填——那一行照旧可按。
    expect(restoreButton(zos)).not.toContain("disabled");

    // 同意语换了,门禁没换:没勾就还是按不动。
    expect(restoreInstallButton(updateMarkup({ status: ARMED, consent: false }))).toContain("disabled");
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

  // 固件搬进了 常规设置。系统面板上不该再留一个入口:同一件事在两处各有一份
  // 状态,就会有两个说法,而这一件事的结局是擦掉 mtd3。
  test("the system panel offers no firmware entry at all — it lives in 常规设置 now", () => {
    const html = markup(createElement(ZosPanel));
    expect(html).not.toContain("固件更新");
    expect(html).not.toContain("上传镜像");
    expect(installButton(html)).toBeUndefined();
    expect(uploadButton(html)).toBeUndefined();
  });

  test("reads the image status field by field, and never invents one", () => {
    const blank = { packed: false, image: null, source: null, shadowedPacked: null, restore: null };
    const image = (over: Record<string, unknown> = {}) => ({
      buildId: null, bytes: null, builtAt: null, md5: null,
      partitionType: null, partitionLabel: null, zosBuildId: null, filesystemBuiltAt: null,
      ...over,
    });

    // 认得出的两种写法都收,认不出的一律留白——这些数字紧挨着一个会重写闪存的按钮。
    expect(parseFirmwareStatus({ packed: true, image: { buildId: "b1", bytes: 1024, builtAt: 7 } }))
      .toEqual({ ...blank, packed: true, image: image({ buildId: "b1", bytes: 1024, builtAt: 7 }) });
    expect(parseFirmwareStatus({ image: { buildId: "b1", size: 2048, builtAtMs: 9 } }))
      .toEqual({ ...blank, packed: true, image: image({ buildId: "b1", bytes: 2048, builtAt: 9 }) });
    // 200 不等于「有镜像」。
    expect(parseFirmwareStatus({})).toEqual(blank);
    expect(parseFirmwareStatus({ packed: false, image: { buildId: "b1" } })).toEqual(blank);
    expect(parseFirmwareStatus(null)).toEqual(blank);
    // 类型不对的字段当成没给,而不是照着渲染。
    expect(parseFirmwareStatus({ packed: true, image: { buildId: 7, bytes: "big", builtAt: -1 } }))
      .toEqual({ ...blank, packed: true, image: image() });

    // 新字段同样是逐个读的:整包 MD5、写入分区、版本号。
    expect(parseFirmwareStatus({
      packed: true,
      image: { md5: "abc", partitionType: 3, partitionLabel: "res", zosBuildId: "r-1", filesystemBuiltAt: 5 },
      source: { kind: "upload", fileName: "a.img", at: 9 },
      shadowedPacked: { bytes: 12, builtAt: 13 },
    })).toEqual({
      packed: true,
      image: image({ md5: "abc", partitionType: 3, partitionLabel: "res", zosBuildId: "r-1", filesystemBuiltAt: 5 }),
      source: { kind: "upload", fileName: "a.img", at: 9 },
      shadowedPacked: { bytes: 12, builtAt: 13 },
      restore: null,
    });

    // 还原点是逐字段读的,而且**在「有没有装填镜像」之前**就读——两件事无关,
    // 而「还什么都没装填」正是第一次来的人最可能看到的状态。
    expect(parseFirmwareStatus({
      restore: { available: true, path: "/x/restore-live.img", bytes: 2781756, builtAt: 42 },
    }).restore).toEqual({ available: true, path: "/x/restore-live.img", bytes: 2781756, builtAt: 42 });
    expect(parseFirmwareStatus({ packed: false, restore: { available: false, path: "/x/y.img" } }).restore)
      .toEqual({ available: false, path: "/x/y.img", bytes: null, builtAt: null });
    // 服务端太老、根本没这个字段 → null,读作「不知道」而不是「没有」。
    expect(parseFirmwareStatus({ packed: false }).restore).toBeNull();
    // 认不出的来源就是「没有来源」,不是猜一个。猜错的方向恰好是最危险的那个:
    // 把别人上传的镜像说成自己刚打的。
    expect(parseFirmwareStatus({ packed: true, image: { bytes: 4 }, source: { kind: "elsewhere" } }).source)
      .toBeNull();

    expect(parseUpgradeSeq({ seq: 4 })).toBe(4);
    expect(parseUpgradeSeq({ upgrade: { seq: 4 } })).toBe(4);
    // 服务没给回执,请求仍然算发出去了——null,不是 0,更不是 NaN。
    expect(parseUpgradeSeq({ ok: true })).toBeNull();
  });

  /**
   * 这条判断决定按钮旁边说哪一句话,而两句话描述的是相反的结局,所以它值得被逐个
   * 情形钉住。
   *
   * 它比的是「服务记下的文件名」对上「服务报出的还原点路径的末段」——不是路径全等,
   * 因为上传仓从来不记原来的目录;也不是网页这边写死一个名字,那样服务改了路径,
   * 控制台会安静地说错话。
   */
  test("isRestoreArmed matches the recorded name against the reported path, and nothing else", () => {
    const status = (over: Partial<ZosFirmwareStatus>): ZosFirmwareStatus => ({
      packed: true,
      image: null,
      source: { kind: "upload", fileName: "restore-live.img", at: 1 },
      shadowedPacked: null,
      restore: { available: true, path: "/srv/.runtime/tc002-stock/restore-live.img", bytes: 1, builtAt: 1 },
      ...over,
    });

    expect(isRestoreArmed(status({}))).toBe(true);
    // 目录不参与比较:同名就算数,因为服务只报得出这两样。
    expect(isRestoreArmed(status({
      restore: { available: true, path: "restore-live.img", bytes: 1, builtAt: 1 },
    }))).toBe(true);

    // 待装的是别的东西 → 说 ZOS 那一套。
    expect(isRestoreArmed(status({ source: { kind: "upload", fileName: "zos.img", at: 1 } }))).toBe(false);
    // 本地打包出来的镜像永远不是还原点,它连文件名都没有。
    expect(isRestoreArmed(status({ source: { kind: "packed", fileName: null, at: 1 } }))).toBe(false);
    // 而且「不是上传」这一条要自己站得住:哪怕打包那一份真带上了同名的文件名,
    // 它也不是还原点——只有服务把还原点收进上传仓的那一次才算数。
    expect(isRestoreArmed(status({ source: { kind: "packed", fileName: "restore-live.img", at: 1 } })))
      .toBe(false);
    // 什么都没装填。
    expect(isRestoreArmed(status({ source: null }))).toBe(false);
    // 服务端太老,报不出还原点 → 不许猜。
    expect(isRestoreArmed(status({ restore: null }))).toBe(false);
    expect(isRestoreArmed(null)).toBe(false);
    // 路径以斜杠收尾时末段是空字符串。两个空字符串相等,所以少了那道空串判断,
    // 一份没有文件名的上传就会被说成还原点——这是这条规则唯一会自己骗自己的形状。
    expect(isRestoreArmed(status({
      source: { kind: "upload", fileName: "", at: 1 },
      restore: { available: true, path: "/srv/tc002-stock/", bytes: 1, builtAt: 1 },
    }))).toBe(false);
    expect(isRestoreArmed(status({
      restore: { available: true, path: "/srv/tc002-stock/", bytes: 1, builtAt: 1 },
    }))).toBe(false);

    // 这条规则会认错的唯一方向:主人自己上传一份**恰好也叫** restore-live.img 的
    // 镜像。认错的方向是安全的那一边——它会把更吓人的那句话摆出来(「这会把 ZOS
    // 抹掉」),而不是相反。反过来永远不会发生:装填还原点时,文件名是服务拿路径的
    // 末段填的,所以真的还原点绝不会被说成一份普通的 ZOS 升级。
    expect(isRestoreArmed(status({
      source: { kind: "upload", fileName: "restore-live.img", at: 1 },
      restore: { available: true, path: "/srv/x/restore-live.img", bytes: 1, builtAt: 1 },
    }))).toBe(true);
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
    const [linkSource, dialogSource, panelSource] = await Promise.all([
      Bun.file(new URL("../web/src/lib/zos-link.ts", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/studio/device-settings-dialog.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/zos/zos-panel.tsx", import.meta.url)).text(),
    ]);

    expect(linkSource).toContain('"/api/os/firmware/status"');
    expect(linkSource).toContain('"/api/os/firmware"');
    expect(linkSource).toContain('"/api/os/upgrade"');
    // 装机是明确的人为动作,不是轮询:对话框只在打开时读一次镜像信息,写只走点击。
    expect(dialogSource).toContain("link.requestUpgrade()");
    expect(dialogSource).not.toContain("setInterval(() => void loadFirmware");
    // 系统面板不再碰固件——它连读都不读了。
    expect(panelSource).not.toContain("requestUpgrade");
    expect(panelSource).not.toContain("readFirmwareStatus");
  });
});
