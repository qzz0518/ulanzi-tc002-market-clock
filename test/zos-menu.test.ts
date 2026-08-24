import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import { ZosMenu, type ZosMenuProps } from "../web/src/components/zos/zos-menu";
import { describeSections, type ZosSectionInput } from "../web/src/lib/zos-sections";
import { ZOS_GAME_SHORTCUTS, type ZosMenuEntry, type ZosTelemetry } from "../web/src/lib/zos-link";

// The menu is rendered here, not grepped for. ZosPanel itself cannot be: it
// gets its sections from a poll, and renderToStaticMarkup runs no effects, so
// under SSR the panel is forever empty. Splitting the rendering out is what
// makes the structure — five destinations, one open panel, one marker per fact —
// something a test can actually look at.

const MENU: ZosMenuEntry[] = [
  { id: "btc", label: "比特币", kind: "channel" },
  { id: "weather", label: "大字天气钟", kind: "channel" },
  { id: "music", label: "音乐", kind: "music" },
  { id: "game", label: "游戏", kind: "game" },
  { id: "vibe", label: "VIBE", kind: "vibe" },
  { id: "settings", label: "设置", kind: "settings" },
];

function telemetry(overrides: Partial<ZosTelemetry> = {}): ZosTelemetry {
  return {
    screen: "launcher",
    focus: "btc",
    wifi: "xiaoya-2.4G",
    ip: "192.168.8.240",
    uptimeMs: 7_400_000,
    freeKb: 16_568,
    supplicantRestarts: 0,
    receivedAt: 1_000_000,
    ...overrides,
  };
}

function render(
  props: Partial<ZosMenuProps> = {},
  input: Partial<ZosSectionInput> = {},
): string {
  const sections = describeSections({
    menu: MENU,
    display: { focus: null, pinned: false },
    telemetry: telemetry(),
    live: true,
    ...input,
  });
  return renderToStaticMarkup(createElement(CladdProvider, null, createElement(ZosMenu, {
    sections,
    open: undefined,
    onOpenChange: () => {},
    busy: false,
    emptyLabel: "正在读取设备菜单…",
    onPin: () => {},
    ...props,
  })));
}

/** One button's own markup: from its tag to wherever the next button starts. */
function button(html: string, label: string): string {
  const chunk = html.split("<button").find((part) => part.includes(`>${label}</div>`));
  if (chunk === undefined) throw new Error(`no button labelled ${label}`);
  return chunk;
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("zos menu structure", () => {
  test("the device's five destinations are five rows, one disclosure open at a time", () => {
    const html = render({ open: "carousel" });

    // 音乐 is a leaf — nothing lives under it, so it has no disclosure at all.
    expect(button(html, "音乐")).not.toContain("aria-expanded");
    expect(button(html, "游戏")).toContain('aria-expanded="false"');
    expect(button(html, "轮播")).toContain('aria-expanded="true"');
    // 「VIBE」 too: 固件只认一个地址,下面那些页只有旋钮翻得到。
    expect(button(html, "VIBE")).not.toContain("aria-expanded");
    // 设置 became a leaf when 蓝牙配网 moved into 常规设置: one row left, and a
    // disclosure around one row is a click that buys nothing.
    expect(button(html, "设置")).not.toContain("aria-expanded");
    // 单开:一次只有一个面板存在,与设备一次只显示一环同构。
    expect(count(html, 'aria-expanded="true"')).toBe(1);
    expect(count(html, 'role="region"')).toBe(1);
    // 展开的那一层由它自己的触发器命名,不另起一个组名——「轮播 7 个频道」已经
    // 说清下面这些是什么了。
    const region = html.slice(html.indexOf('role="region"'));
    expect(region.slice(0, region.indexOf(">"))).toContain("aria-labelledby=");
    expect(html).not.toContain('role="group"');
  });

  test("the level below is the open section's, and only the open section's", () => {
    const carousel = render({ open: "carousel" });
    expect(carousel).toContain("比特币");
    expect(carousel).toContain("大字天气钟");
    expect(carousel).not.toContain("贪吃蛇");

    const games = render({ open: "games" });
    expect(games).toContain("游戏列表");
    expect(games).toContain("贪吃蛇");
    expect(games).not.toContain("比特币");
    // 七个引擎 + 那一环本身,全部挂在 游戏 下面,而不是和频道并排。
    for (const game of ZOS_GAME_SHORTCUTS) expect(games).toContain(game.label);

    // 全部收起也是合法状态:用户关掉最后一个,菜单就只剩五个目的地。
    const closed = render({ open: undefined });
    expect(closed).not.toContain('role="region"');
    expect(closed).not.toContain("比特币");
    for (const label of ["音乐", "游戏", "轮播", "VIBE", "设置"]) expect(closed).toContain(label);
  });

  test("nothing to show yet says so, and offers no menu to click", () => {
    const html = renderToStaticMarkup(createElement(CladdProvider, null, createElement(ZosMenu, {
      sections: [],
      open: undefined,
      onOpenChange: () => {},
      busy: false,
      emptyLabel: "正在读取设备菜单…",
      onPin: () => {},
    })));
    expect(html).toContain("正在读取设备菜单…");
    expect(html).not.toContain("<button");
  });
});

describe("zos menu markers", () => {
  test("a pinned row wears the mark, and the section above it stays quiet", () => {
    const html = render({ open: "carousel" }, { display: { focus: "weather", pinned: true } });

    expect(button(html, "大字天气钟")).toContain("已固定");
    expect(button(html, "轮播")).not.toContain("已固定");
    // 同一件事只说一遍:这是用户点名的那条投诉。
    expect(count(html, "已固定")).toBe(1);
    // footer 只说里面有什么,不复述设备在干什么。
    expect(button(html, "轮播")).toContain("2 个频道");
    expect(html).not.toContain("设备正在显示");
  });

  test("a collapsed section speaks for the row it is hiding", () => {
    const html = render({ open: undefined }, { display: { focus: "weather", pinned: true } });
    // 行不在屏幕上,那这条事实就没有别人能说了。
    expect(html).not.toContain("大字天气钟");
    expect(button(html, "轮播")).toContain("已固定");
    expect(count(html, "已固定")).toBe(1);
  });

  test("正在显示 is the device's own report, and it too is stated once", () => {
    const html = render(
      { open: "carousel" },
      { telemetry: telemetry({ screen: "channel", focus: "weather" }) },
    );
    expect(button(html, "大字天气钟")).toContain("正在显示");
    expect(button(html, "轮播")).not.toContain("正在显示");
    expect(count(html, "正在显示")).toBe(1);
  });

  test("a running game has no row that may claim it, so the section says it instead", () => {
    // 固件只报 screen: "game",不报是哪一个引擎——所以七行里没有一行有资格自称
    // 正在跑,这一句只能由 游戏 自己说,展开与否都一样。
    const open = render({ open: "games" }, { telemetry: telemetry({ screen: "game" }) });
    expect(button(open, "游戏")).toContain("正在显示");
    expect(count(open, "正在显示")).toBe(1);

    // 反过来,停在选游戏那一环时,游戏列表 这一行说得出口,于是上面那层闭嘴。
    const ring = render({ open: "games" }, { telemetry: telemetry({ screen: "games" }) });
    expect(button(ring, "游戏列表")).toContain("正在显示");
    expect(button(ring, "游戏")).not.toContain("正在显示");
    expect(count(ring, "正在显示")).toBe(1);
  });

  test("已固定 outranks 正在显示: a confirmed pin is one chip, not two", () => {
    const html = render(
      { open: "carousel" },
      {
        display: { focus: "weather", pinned: true },
        telemetry: telemetry({ screen: "channel", focus: "weather" }),
      },
    );
    expect(button(html, "大字天气钟")).toContain("已固定");
    expect(count(html, "已固定")).toBe(1);
    expect(count(html, "正在显示")).toBe(0);
  });

  test("「VIBE」 wears its own marker: a leaf has no rows to defer to", () => {
    const html = render({ open: "carousel" }, { telemetry: telemetry({ screen: "vibe" }) });
    expect(button(html, "VIBE")).toContain("正在显示");
    expect(count(html, "正在显示")).toBe(1);
    // 和其它每一行一样是个开关,再点一次就是交还旋钮。
    expect(button(html, "VIBE")).toContain('aria-pressed="false"');
    // footer 说的是「按下去会把设备送到哪」,不是设备正在干什么。
    expect(button(html, "VIBE")).toContain("把时钟切到 AI 代理的额度页");
  });

  test("offline the menu still stands, and nothing on it claims to be showing", () => {
    const html = render(
      { open: "carousel" },
      { live: false, telemetry: telemetry({ screen: "channel", focus: "weather" }) },
    );
    expect(html).toContain("大字天气钟");
    expect(count(html, "正在显示")).toBe(0);
  });
});

describe("zos menu accessibility", () => {
  test("a row is a toggle, and its name is what is written on it", () => {
    const html = render({ open: "carousel" }, { display: { focus: "weather", pinned: true } });

    // 行本身是开关:再点一次就是取消固定,所以状态走 aria-pressed。
    expect(button(html, "大字天气钟")).toContain('aria-pressed="true"');
    expect(button(html, "比特币")).toContain('aria-pressed="false"');
    expect(button(html, "音乐")).toContain('aria-pressed="false"');
    // 写死的 aria-label 会把行内的「已固定」和 footer 全盖掉,而且固定之后还会
    // 把动作说反——按下去其实是取消固定。名字由行内文字算出来就没有这个问题:
    // 菜单里没有任何一个按钮自带名字。
    expect(html).not.toContain('aria-label="把设备固定在');
    for (const chunk of html.split("<button").slice(1)) {
      expect(chunk.slice(0, chunk.indexOf(">"))).not.toContain("aria-label");
    }
    expect(button(html, "大字天气钟")).toContain("已固定");
  });

  test("每一行都在发指令,所以写入在飞的时候整张菜单都停手", () => {
    const html = render({ open: "carousel", busy: true });
    // 服务只保留一个 focus,第二次点击只会和第一次赛跑。
    expect(button(html, "比特币")).toContain("disabled");
    expect(button(html, "设置")).toContain("disabled");
    expect(button(html, "音乐")).toContain("disabled");
    expect(button(html, "VIBE")).toContain("disabled");
  });

  test("菜单里再没有「打开这台浏览器里的向导」那种行", () => {
    // 蓝牙配网 搬去了常规设置:它不是设备上的一个去处,混在五个目的地里就得为它
    // 破例(不是开关、不受 busy 管),而破例正是这份菜单一致性的裂口。
    for (const open of ["carousel", "games", "vibe", "settings", undefined]) {
      const html = render({ open });
      expect(html).not.toContain("蓝牙配网");
    }
  });
});
