import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import { WorkspaceActions } from "../web/src/components/studio/workspace-actions";
import { WorkspaceEditor } from "../web/src/components/studio/workspace-editor";
import { CanvasWorkspace } from "../web/src/components/studio/canvas-workspace";
import { PixelAssetLibrary } from "../web/src/components/studio/pixel-asset-library";
import { GameShell } from "../web/src/components/game/game-shell";
import { MusicPlayer } from "../web/src/components/music/music-player";
import { DeviceHostPanel } from "../web/src/components/studio/device-settings-dialog";
import { getContentCatalog } from "../src/content-registry.ts";
import type { ChannelConfig } from "../src/workspace.ts";

// Every tab in this console was written against the stock firmware, whose
// `POST /api/custom` receiver ZOS does not have. Verified against the live
// device at 192.168.8.108 while ZOS was running: /api/channels/push,
// /api/live/frames and /api/notify all answer "clock returned HTTP 503", while
// /api/os/display + the device's own /api/os/frames pull keeps channels working.
// These tests pin the copy that has to follow from that.

const noop = () => {};

function markup(node: ReactNode): string {
  return renderToStaticMarkup(createElement(CladdProvider, null, node));
}

/**
 * The `<button>…</button>` whose label contains `label`.
 *
 * Rendered classes are the only evidence a test has that a cladd control still
 * looks like the control it is meant to be — `在时钟上显示` once shipped as a
 * tinted fill with no ring, which reads as a disabled chip and is invisible to
 * every assertion that only looks for the text.
 */
function buttonHtml(html: string, label: string): string {
  const at = html.indexOf(label);
  expect([label, at > -1]).toEqual([label, true]);
  const start = html.lastIndexOf("<button", at);
  const end = html.indexOf("</button>", at);
  expect([label, start > -1 && end > start]).toEqual([label, true]);
  return html.slice(start, end + "</button>".length);
}

/** cladd paints the outline ring as `shadow-cladd-outline` on the surface layer. */
function hasOutline(buttonMarkup: string): boolean {
  return buttonMarkup.includes("shadow-cladd-outline");
}

/**
 * The accent carried by the `<button>` element itself.
 *
 * Not the whole subtree: cladd's focus-ring layer is stamped `cladd-color-brand`
 * on every button from the provider's accent, so a substring search over the
 * markup reports an accent on controls that visibly have none.
 */
function accented(buttonMarkup: string): boolean {
  const root = buttonMarkup.slice(0, buttonMarkup.indexOf(">"));
  return /cladd-color-\w+/.test(root);
}

function noticeChannel(enabled = true): ChannelConfig {
  return {
    id: "ch_notice",
    name: "通知板",
    appName: "notice",
    enabled,
    refreshIntervalMs: 60_000,
    items: [{
      id: "item_notice",
      contentId: "tools:notice",
      durationMs: 8_000,
      options: { text: "你好", color: "#00ff66" },
    }],
  };
}

function editorMarkup(channel: ChannelConfig, firmwareMode: "official" | "zos"): string {
  return markup(createElement(WorkspaceEditor, {
    channel: channel as never,
    selectedItemId: channel.items[0]!.id,
    catalog: getContentCatalog() as never,
    instruments: [],
    previewUrl: null,
    previewing: false,
    previewError: null,
    previewFrameCount: null,
    previewScope: "item",
    busy: null,
    dirty: false,
    saving: false,
    lastSavedAt: null,
    deviceOutOfDate: false,
    firmwareMode,
    onChannelChange: noop,
    onSelectItem: noop,
    onPreviewScopeChange: noop,
    onDurationChange: noop,
    onOptionChange: noop,
    onMoveItem: noop,
    onReorderItem: noop,
    onRemoveItem: noop,
    onTimerStart: noop,
    onTimerPause: noop,
    onOpenCatalog: noop,
    onPush: noop,
  }));
}

function canvasMarkup(firmwareMode: "official" | "zos"): string {
  return markup(createElement(CanvasWorkspace, {
    targetItem: null,
    targetChannelName: "我的画板",
    busy: null,
    dirty: false,
    saving: false,
    lastSavedAt: null,
    deviceOutOfDate: false,
    firmwareMode,
    onCreateTarget: noop,
    onApply: noop,
    onPreview: noop,
    onPush: noop,
  }));
}

describe("内容 under ZOS", () => {
  test("offers the pin instead of a push that cannot reach the device", () => {
    const html = markup(createElement(WorkspaceActions, {
      busy: null,
      dirty: false,
      saving: false,
      lastSavedAt: Date.now(),
      deviceOutOfDate: false,
      firmwareMode: "zos",
      channelAppName: "btc",
      onPush: noop,
    }));

    // 推送这个动作在 ZOS 上不存在,按钮也不该在。
    expect(html).not.toContain("推送频道");
    expect(html).toContain("在时钟上显示");
    // 「尚未推送到设备」在 ZOS 下是纯假话:频道一直可达,只是由设备来取。
    expect(html).not.toContain("尚未推送到设备");
    expect(html).toContain("ZOS 主动拉取");
  });

  test("the pin reads as the primary action, ring included, in both states", () => {
    // Regression: `outline={pinnedHere}` meant the *unpinned* state — the one
    // that actually does something — rendered the brand tint with no
    // shadow-cladd-outline, i.e. a pale pill with no border on a light card.
    const html = markup(createElement(WorkspaceActions, {
      busy: null,
      dirty: false,
      saving: false,
      lastSavedAt: Date.now(),
      deviceOutOfDate: false,
      firmwareMode: "zos",
      channelAppName: "btc",
      onPreview: noop,
      onPush: noop,
    }));

    const pin = buttonHtml(html, "在时钟上显示");
    expect(hasOutline(pin)).toBe(true);
    // Primary treatment = cladd's default gradient surface + the app accent,
    // exactly what 推送频道 renders under the stock firmware.
    expect(accented(pin)).toBe(true);
    expect(pin).toContain("cladd-color-brand");
    expect(pin).toContain("from-cladd-surface-highlight");
    // Not disabled and not read-only: it is the live action on this page.
    expect(pin).not.toContain("disabled=\"\"");
    // 预览 sits in the same row and must not out-weigh it.
    expect(accented(buttonHtml(html, "预览"))).toBe(false);
  });

  test("both treatments the pin toggles between keep the ring", async () => {
    // 固定态只有 useZosFocus 拿到设备状态后才渲染得出来，SSR 到不了那一步；
    // 所以这里直接对 cladd 立约：这两组 props 都必须画出 shadow-cladd-outline。
    // 真正会回归的是「有人又把 outline 绑到某个布尔上」，那在源码里就能抓。
    const { Button } = await import("@cladd-ui/react");
    for (const variant of ["gradient", "transparent"] as const) {
      const html = markup(createElement(
        Button,
        { type: "button", color: "brand", variant, outline: true },
        "标签",
      ));
      expect([variant, hasOutline(html)]).toEqual([variant, true]);
    }

    const source = await Bun.file(
      new URL("../web/src/components/studio/workspace-actions.tsx", import.meta.url),
    ).text();
    // 这一颗按钮的 outline 不接受任何条件：它是这一页的主操作。
    expect(source).not.toMatch(/outline=\{(?!true\})/);
    expect(source).toContain('variant={pinnedHere ? "transparent" : "gradient"}');
  });

  test("the stock push button carries the same ring, so the two states match", () => {
    const push = buttonHtml(markup(createElement(WorkspaceActions, {
      busy: null,
      dirty: false,
      saving: false,
      lastSavedAt: Date.now(),
      deviceOutOfDate: false,
      onPush: noop,
    })), "推送频道");
    expect(hasOutline(push)).toBe(true);
    expect(accented(push)).toBe(true);
  });

  test("says why pinning a disabled channel would do nothing", () => {
    const html = markup(createElement(WorkspaceActions, {
      busy: null,
      dirty: false,
      saving: false,
      lastSavedAt: Date.now(),
      deviceOutOfDate: false,
      firmwareMode: "zos",
      channelAppName: "btc",
      channelEnabled: false,
      onPush: noop,
    }));

    // service.ts 的 publishOsMenu 只发布 enabled 频道,固件 selectApp 找不到就
    // 静默什么都不做 —— 按钮要在按下之前就说清楚。
    expect(html).toContain("频道未启用");
    expect(html).toMatch(/在时钟上显示[\s\S]*?disabled|disabled[\s\S]*?在时钟上显示/);
  });

  test("drops the pin entirely when the caller has no app name to pin", () => {
    // 画板页只拿得到频道显示名,固定要的是 appName —— 与其给一个必然落空的
    // 按钮,不如只留状态。
    const html = markup(createElement(WorkspaceActions, {
      busy: null,
      dirty: false,
      saving: false,
      lastSavedAt: Date.now(),
      deviceOutOfDate: false,
      firmwareMode: "zos",
      onPush: noop,
    }));

    expect(html).toContain("ZOS 主动拉取");
    expect(html).not.toContain("在时钟上显示");
    expect(html).not.toContain("推送频道");
  });

  test("keeps the stock push path exactly as it was", () => {
    const html = markup(createElement(WorkspaceActions, {
      busy: null,
      dirty: false,
      saving: false,
      lastSavedAt: Date.now(),
      deviceOutOfDate: true,
      lastPushAt: new Date(Date.now() - 60_000).toISOString(),
      onPush: noop,
    }));

    expect(html).toContain("推送频道");
    expect(html).toContain("设备版本待更新");
    expect(html).not.toContain("在时钟上显示");
  });

  test("the editor pins by the channel's knob name", () => {
    const zos = editorMarkup(noticeChannel(), "zos");
    expect(zos).toContain("在时钟上显示");
    expect(zos).not.toContain("推送频道");

    const official = editorMarkup(noticeChannel(), "official");
    expect(official).toContain("推送频道");
    expect(official).not.toContain("在时钟上显示");
  });

  test("the notice webhook admits it cannot reach a ZOS clock", async () => {
    // Dialog 走 portal,SSR 里没有正文,只能核对源码里的这句话。
    const source = await Bun.file(
      new URL("../web/src/components/studio/workspace-editor.tsx", import.meta.url),
    ).text();
    expect(source).toContain('const zos = firmwareMode === "zos";');
    expect(source).toContain("时钟正在运行 ZOS，这条 Webhook 暂时不会上屏。");
    expect(source).toContain("clock returned HTTP 503");
  });
});

describe("画板 under ZOS", () => {
  test("keeps the doodle wall but stops calling it 上屏", () => {
    const html = canvasMarkup("zos");

    // 涂鸦墙是控制台内部的协作(WS 中继),与固件无关,不能因为 ZOS 就关掉。
    expect(html).toContain("涂鸦墙");
    expect(html).not.toContain("直播上屏");
    // 写入频道仍然能到设备,只是设备自己来取。
    expect(html).toContain("写入到所选频道");
    expect(html).toContain("写入后由时钟自己拉取");
  });

  test("leaves the live channel alone under the stock firmware", () => {
    const html = canvasMarkup("official");
    expect(html).toContain("直播上屏");
    expect(html).not.toContain("涂鸦墙");
  });

  test("never builds a live recorder that could only answer 503", async () => {
    const source = await Bun.file(
      new URL("../web/src/components/studio/canvas-workspace.tsx", import.meta.url),
    ).text();
    expect(source).toContain('const screen = zos ? null : createLiveScreen("draw"');
  });
});

describe("素材库 under ZOS", () => {
  test("stays fully usable and names the pull route", () => {
    const html = markup(createElement(PixelAssetLibrary, {
      addedOfficialIds: [],
      targetChannelName: "市场轮播",
      firmwareMode: "zos",
      onAdd: noop,
      onStandalone: noop,
    }));

    // 导入落在 workspace 里,一步都不碰设备 —— 这一页在 ZOS 下没有任何功能损失。
    expect(html).toContain("加入所选频道");
    expect(html).toContain("导入视频");
    expect(html).toContain("设备下次显示该频道时自己拉取，无需推送");
  });
});

describe("游戏 under ZOS", () => {
  test("stops promising 上屏 and points at the device's own arcade", () => {
    const html = renderToStaticMarkup(createElement(GameShell, {
      firmwareOnline: false,
      firmwareMode: "zos",
    }));

    expect(html).toContain("ZOS 运行中");
    expect(html).toMatch(/上屏[\s\S]*?disabled/);
    expect(html).toContain("时钟自带同样七款游戏");
    // 两套侧载固件在 ZOS 下根本不可能在跑,那句文案不该出现。
    expect(html).not.toContain("恢复官方固件后才能上屏");
    expect(html).not.toContain("音乐固件直连中");
    // 浏览器里照常能玩:这不是一堵禁用墙。
    expect(html).toContain("开始");
    expect(html).toContain("重开");
    expect(html).toContain('width="52" height="16"');
  });

  test("offers to send the clock into the game the picker is on", () => {
    const html = renderToStaticMarkup(createElement(GameShell, {
      firmwareOnline: false,
      firmwareMode: "zos",
    }));

    const jump = buttonHtml(html, "在时钟上玩");
    expect(jump).not.toContain('disabled=""');
    expect(jump).toContain('aria-pressed="false"');
    expect(hasOutline(jump)).toBe(true);
    // 「开始」已经是这一排唯一的 brand 重音；再来一个就是 pitfalls 里说的重音打架。
    expect(accented(jump)).toBe(false);
    expect(buttonHtml(html, "开始")).toContain("cladd-color-brand");
    // 默认选中第一款，按钮的 title 必须点名它，不能是泛指的「游戏」。
    expect(jump).toContain("时间打砖块");
  });

  test("never claims the two sides are in sync", () => {
    const html = renderToStaticMarkup(createElement(GameShell, {
      firmwareOnline: false,
      firmwareMode: "zos",
    }));
    // 设备用 time(0) 播种，两边跑出来必然不同——文案不能暗示同步/投屏/续玩。
    expect(html).toContain("两边各自开局，进度和随机数都不共享");
    expect(html).toContain("进度不共享");
    for (const lie of ["同步", "投到时钟", "接着玩", "同一局"]) {
      expect([lie, html.includes(lie)]).toEqual([lie, false]);
    }
    // 旧文案假设控制台没有钥匙，现在有了。
    expect(html).not.toContain("在设备上用旋钮进「游戏」即可直接玩");
  });

  test("the game jump names the engine id the firmware knows", async () => {
    const source = await Bun.file(
      new URL("../web/src/components/game/game-shell.tsx", import.meta.url),
    ).text();
    // GAME_REGISTRY 的 id 就是设备引擎 id() 的那七个值，focus 直接由它派生 ——
    // 硬编码一份就是两边悄悄跑偏的开始。
    expect(source).toContain("zosGameFocus(gameId)");
    expect(source).toContain("zosFocus.toggle(zosGameTarget)");
    expect(source).not.toContain('"game:tetris"');
    expect(source).toContain("切换时钟界面失败：");
  });

  test("the stock firmware sees no jump button at all", () => {
    // 官方固件上 PUT /api/os/display 无人接听，那颗按钮按下去只会是个错误。
    const html = renderToStaticMarkup(createElement(GameShell, { firmwareOnline: false }));
    expect(html).not.toContain("在时钟上玩");
    expect(html).toContain("重开");
  });

  test("warns that a sideload would push ZOS off the device", async () => {
    const source = await Bun.file(
      new URL("../web/src/components/game/game-shell.tsx", import.meta.url),
    ).text();
    expect(source).toContain("它与 ZOS 互斥，侧载期间 ZOS 会被顶下去。");
    // ZOS 刷在 res 分区上,所以断电重启回到的是 ZOS 而不是官方固件。这条承诺
    // 现在由共享面板按 restoresTo 说,宿主页只负责把固件模式喂进去。
    expect(source).toContain("结束侧载或断电重启后回到的是 ZOS，不是 Ulanzi 官方固件。");
    expect(source).toContain("firmwareMode,");
  });
});

describe("音乐 under ZOS", () => {
  test("replaces the mirror toggle with a real jump to the device's music page", () => {
    const html = renderToStaticMarkup(createElement(MusicPlayer, { firmwareMode: "zos" }));

    // 固件现在认 focus:"music"（真机 telemetry.screen → "music"），所以这里是一颗
    // 真按钮，不再是那个 aria-disabled 的说明芯片。
    expect(html).toContain("切到时钟音乐页");
    expect(html).not.toContain("ZOS 音乐页");
    const jump = buttonHtml(html, "切到时钟音乐页");
    expect(jump).not.toContain('aria-disabled="true"');
    expect(jump).not.toContain('disabled=""');
    expect(jump).toContain('aria-pressed="false"');
    // 与同排的 设备同屏 同一个写法：transparent + outline，按下才亮 brand。
    expect(hasOutline(jump)).toBe(true);
    // 标签不能读成「把这块预览镜像过去」——那正是 ZOS 上做不到的事。
    expect(jump).not.toContain("在时钟上显示");
    expect(jump).toContain("那一页由设备渲染，不是这块预览的镜像");

    // 同屏走 /api/music/mirror → live frames → Custom App,ZOS 上是 503。
    expect(html).not.toContain("设备同屏");
    // 网易云也能推上去了：本组件 PUT /api/os/now-playing 上报浏览器里正在播的
    // 东西,所以旧的「只跟随 Spotify Connect」是假话,必须消失。默认来源是网易云,
    // 说清楚的是「这一页得开着」——那才是这条路真正的约束。
    expect(html).not.toContain("时钟的「音乐」页只跟随 Spotify Connect");
    expect(html).toContain("网页就是网易云的播放器，所以这一页得开着");

    // 主题设置在 ZOS 下是真的推到设备的：ZOS 从 /api/os/pull 读同一份
    // sDeviceState（ADR 0007）。这颗芯片说「仅影响预览」正是用户报的第二个问题。
    expect(html).toContain("实时同步到设备");
    expect(html).not.toContain("仅影响预览");
  });

  test("the music jump is wired to the measured focus, not a hand-typed string", async () => {
    const source = await Bun.file(
      new URL("../web/src/components/music/music-player.tsx", import.meta.url),
    ).text();
    expect(source).toContain("zosFocus.toggle(ZOS_MUSIC_FOCUS)");
    expect(source).toContain('import { ZOS_MUSIC_FOCUS } from "@/lib/zos-link";');
    // 接管之后必须有回去的路，否则旋钮就一直被控制台占着。
    expect(source).toContain("交还旋钮");
    // 失败要说出来：这颗按钮唯一的反馈在三米外的灯板上。
    expect(source).toContain("切换时钟界面失败：");
  });

  test("keeps the mirror on the stock firmware", () => {
    const html = renderToStaticMarkup(createElement(MusicPlayer));
    expect(html).toContain("设备同屏");
    expect(html).not.toContain("ZOS 音乐页");
  });
});

// 上面每一条都给组件直接喂了 firmwareMode。真正会坏的地方在 app.tsx：一个改好
// 的组件不带这个 prop 渲染出来，和一个根本没改过的组件长得一模一样，所以接线
// 本身要有断言，而不是靠读代码确认。
describe("app.tsx 的固件模式接线", () => {
  const TABS: Array<{ name: string; file: string }> = [
    { name: "WorkspaceEditor", file: "studio/workspace-editor.tsx" },
    { name: "ContentMarket", file: "studio/content-market.tsx" },
    { name: "CanvasWorkspace", file: "studio/canvas-workspace.tsx" },
    { name: "PixelAssetLibrary", file: "studio/pixel-asset-library.tsx" },
    { name: "GameShell", file: "../components/game/game-shell.tsx" },
    { name: "MusicPlayer", file: "../components/music/music-player.tsx" },
    { name: "ZosPanel", file: "../components/zos/zos-panel.tsx" },
  ];

  async function appSource(): Promise<string> {
    return await Bun.file(new URL("../web/src/app.tsx", import.meta.url)).text();
  }

  /** app.tsx 里挂载 `<Name …/>` 的那段属性文本。 */
  function mountProps(source: string, name: string): string {
    const parts = source.split(`<${name}`);
    expect(parts.length).toBe(2);
    const rest = parts[1]!;
    const end = rest.indexOf("/>");
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  }

  test("every tab that declares firmwareMode is mounted with it", async () => {
    const source = await appSource();
    for (const tab of TABS) {
      const componentSource = await Bun.file(
        new URL(`../web/src/components/${tab.file}`, import.meta.url),
      ).text();
      const declares = componentSource.includes("firmwareMode?: FirmwareMode");
      const props = mountProps(source, tab.name);
      // 声明了就必须喂;没声明就绝不能喂——喂了也只是个掉进虚空的 prop。
      expect([tab.name, props.includes("firmwareMode={firmwareMode}")])
        .toEqual([tab.name, declares]);
    }
  });

  test("no wrapper stands between app.tsx and a tab's real props", async () => {
    const source = await appSource();
    // 一个只把 prop 类型撑宽的 shim 会让 tsc 对「传了没传」完全失声,这正是
    // 这些改造曾经整批处于休眠状态的原因。
    expect(source).not.toContain("withFirmwareMode");
    expect(source).not.toContain("Base}");
    expect(source).toContain("const firmwareMode = firmwareStatus.mode;");
  });

  test("画板 gets the knob name, not just the display name", async () => {
    const source = await appSource();
    const props = mountProps(source, "CanvasWorkspace");
    // 显示名固定不了设备:PUT /api/os/display 认的是 appName。
    expect(props).toContain("targetChannelAppName={selectedChannel.appName}");
    expect(props).toContain("targetChannelEnabled={selectedChannel.enabled}");
  });

  test("画板 turns that app name into a real pin button", () => {
    const pinned = markup(createElement(CanvasWorkspace, {
      targetItem: null,
      targetChannelName: "我的画板",
      targetChannelAppName: "canvas",
      busy: null,
      dirty: false,
      saving: false,
      lastSavedAt: null,
      deviceOutOfDate: false,
      firmwareMode: "zos",
      onCreateTarget: noop,
      onApply: noop,
      onPreview: noop,
      onPush: noop,
    }));
    expect(pinned).toContain("在时钟上显示");
    // 拿不到 appName 时按下去必然落空,所以那颗按钮压根不出现。
    expect(canvasMarkup("zos")).not.toContain("在时钟上显示");
  });

  test("toast copy stops promising a push that ZOS never receives", async () => {
    const source = await appSource();
    for (const claim of [
      "更改会自动保存，时钟下次进入该频道即为最新。",
      "保存后生效，时钟下次进入该频道即为最新。",
      "已保存 · 时钟下次进入该频道即为最新",
    ]) {
      expect(source).toContain(claim);
    }
    // 官方固件那条照旧——ZOS 不是把功能关掉的理由。
    expect(source).toContain("更改会自动保存，推送后显示在时钟上。");
    expect(source).toContain("保存并推送后生效。");
    expect(source).toContain("已推送到旋钮项 ");
  });
});

describe("常规设置 under ZOS", () => {
  test("the header hands the dialog the firmware mode", async () => {
    const header = await Bun.file(
      new URL("../web/src/components/studio/studio-header.tsx", import.meta.url),
    ).text();
    expect(header).toContain("firmwareMode={firmwareStatus.mode}");
  });

  test("the device tab explains the dead probe instead of blaming the network", () => {
    const html = markup(createElement(DeviceHostPanel, {
      info: null,
      infoLoading: false,
      infoError: "clock returned HTTP 503",
      host: null,
      hostDraft: "192.168.8.108",
      savingHost: false,
      zos: true,
      onHostDraftChange: noop,
      onSaveHost: noop,
      onResetHost: noop,
      onRetry: noop,
    }));

    expect(html).toContain("ZOS 不提供官方固件的设备信息接口");
    // 不是错误,重试一百次也一样;也不能让人去查网线。
    expect(html).not.toContain("无法读取设备信息");
    expect(html).not.toContain("请在下方确认它的局域网地址");
    expect(html).not.toContain("重试");
    // 地址表单是服务端的,照常留着。
    expect(html).toContain("时钟地址");
  });

  test("keeps the stock probe error exactly as it was", () => {
    const html = markup(createElement(DeviceHostPanel, {
      info: null,
      infoLoading: false,
      infoError: "时钟没有响应",
      host: null,
      hostDraft: "192.168.8.9",
      savingHost: false,
      onHostDraftChange: noop,
      onSaveHost: noop,
      onResetHost: noop,
      onRetry: noop,
    }));
    expect(html).toContain("无法读取设备信息");
    expect(html).not.toContain("ZOS 不提供");
  });

  test("the general tab is not offered as a live form on ZOS", async () => {
    const source = await Bun.file(
      new URL("../web/src/components/studio/device-settings-dialog.tsx", import.meta.url),
    ).text();
    // 表单本身不渲染:一份填得好好的、保存必然 503 的表单比一句说明更误导人。
    expect(source).toContain("常规设置在 ZOS 上不可用");
    expect(source).toContain("if (open && !zos) void loadSettings();");
    expect(source).toContain("if (!draft || saving || zos) return;");
    expect(source).toContain("disabled={zos || !dirty || loading || saving}");
    expect(source).toContain("时钟正在跑 ZOS，它不提供这套接口。");
  });
});

describe("canvas: 写入为单独 APP", () => {
  test("the button sits left of 写入到所选频道 and is wired to its own handler", async () => {
    const [canvasSource, appSource] = await Promise.all([
      Bun.file(new URL("../web/src/components/studio/canvas-workspace.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/app.tsx", import.meta.url)).text(),
    ]);

    // Order matters: the user asked for it to the LEFT of the existing action,
    // and in this flex row source order is visual order.
    const asApp = canvasSource.indexOf("写入为单独 APP");
    const toChannel = canvasSource.indexOf("写入到所选频道");
    expect(asApp).toBeGreaterThan(-1);
    expect(asApp).toBeLessThan(toChannel);

    // A separate handler, not a modifier on the existing one: "add to what I am
    // editing" and "make a new thing" are different intentions.
    expect(canvasSource).toContain("onApplyAsChannel?.(pixels)");
    expect(canvasSource).toContain("onApplyAsChannel?: (pixels: number[]) => void;");
    expect(appSource).toContain("onApplyAsChannel={applyCanvasAsChannel}");
  });

  test("it refuses at the device's channel cap instead of failing on save", async () => {
    const appSource = await Bun.file(new URL("../web/src/app.tsx", import.meta.url)).text();
    // 24 is src/workspace.ts's maxChannels; a 25th would be rejected by the
    // server, so the console says why rather than letting the round-trip fail.
    expect(appSource).toContain("const MAX_CHANNELS = 24;");
    expect(appSource).toMatch(/channels\.length >= MAX_CHANNELS[\s\S]{0,200}toast\.error/);
  });

  test("the new channel is numbered so two drawings are distinguishable", async () => {
    const appSource = await Bun.file(new URL("../web/src/app.tsx", import.meta.url)).text();
    // On the clock's ring only the name is visible, so "画板" twice would be
    // two identical-looking entries.
    expect(appSource).toMatch(/画板 \$\{taken \+ 1\}/);
    expect(appSource).toContain('newChannel(workspace, catalog, `画板 ${taken + 1}`, "canvas", item)');
  });
});
