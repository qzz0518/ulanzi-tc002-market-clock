import { describe, expect, test } from "bun:test";
import {
  ZOS_SECTION_ORDER,
  defaultOpenSection,
  describeSections,
  pinIntent,
  rowMarker,
  sectionMarker,
  type ZosSection,
} from "../web/src/lib/zos-sections";
import { ZOS_GAME_SHORTCUTS, type ZosMenuEntry, type ZosTelemetry } from "../web/src/lib/zos-link";

// The service's pull document is flat, and this is what it looks like: every
// enabled channel, then the three non-channel destinations.
const MENU: ZosMenuEntry[] = [
  { id: "btc", label: "比特币", kind: "channel" },
  { id: "weather", label: "大字天气钟", kind: "channel" },
  { id: "music", label: "音乐", kind: "music" },
  { id: "game", label: "游戏", kind: "game" },
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

function build(overrides: Partial<Parameters<typeof describeSections>[0]> = {}): ZosSection[] {
  return describeSections({
    menu: MENU,
    display: { focus: null, pinned: false },
    telemetry: telemetry(),
    live: true,
    bleAvailable: true,
    ...overrides,
  });
}

function byId(sections: ZosSection[], id: string): ZosSection {
  return sections.find((section) => section.id === id)!;
}

describe("zos device sections", () => {
  test("the flat pull document becomes the device's four-entry root ring", () => {
    // osLogic.cc fixes exactly these four and says why: channels are content,
    // not destinations. Ten channels on one level is the wire format, not the
    // device — and the wire format is what the old console rendered.
    const sections = build();
    expect(sections.map((section) => section.id)).toEqual([...ZOS_SECTION_ORDER]);
    expect(sections.map((section) => section.label)).toEqual(["音乐", "游戏", "轮播", "设置"]);
  });

  test("channels live one level down, under 轮播", () => {
    const carousel = byId(build(), "carousel");
    expect(carousel.leaf).toBe(false);
    expect(carousel.rows.map((row) => row.key)).toEqual(["btc", "weather"]);
    expect(carousel.footer).toBe("2 个频道");
    // 轮播 is the one destination with no focus of its own — it is what the
    // device does when nothing is pinned, so "go there" is 交还旋钮.
    expect(carousel.focus).toBeNull();
  });

  test("the seven games live one level down too, behind the games ring itself", () => {
    const games = byId(build(), "games");
    expect(games.rows[0]?.label).toBe("游戏列表");
    // Plain `game` only pushes the ring; `game:<id>` enters the engine.
    expect(games.rows[0]?.action).toEqual({ type: "focus", focus: "game" });
    expect(games.rows).toHaveLength(ZOS_GAME_SHORTCUTS.length + 1);
    expect(games.rows[1]?.action).toEqual({ type: "focus", focus: "game:breakout" });
  });

  test("音乐 is a leaf because the device has nothing under it", () => {
    const music = byId(build(), "music");
    expect(music.leaf).toBe(true);
    expect(music.focus).toBe("music");
    expect(music.rows).toEqual([]);
  });

  test("the BLE wizard lands under 设置, next to the device's own settings page", () => {
    const settings = byId(build(), "settings");
    expect(settings.leaf).toBe(false);
    expect(settings.rows.map((row) => row.label)).toEqual(["设备设置页", "蓝牙配网"]);
    expect(settings.rows[0]?.action).toEqual({ type: "focus", focus: "settings" });
    expect(settings.rows[1]?.action).toEqual({ type: "provision" });
  });

  test("a browser that cannot do Web Bluetooth is never offered the row", () => {
    const settings = byId(build({ bleAvailable: false }), "settings");
    expect(settings.rows.map((row) => row.label)).toEqual(["设备设置页"]);
  });

  test("a pinned channel marks both the row and the collapsed section", () => {
    const sections = build({ display: { focus: "weather", pinned: true } });
    const carousel = byId(sections, "carousel");
    expect(carousel.pinned).toBe(true);
    expect(carousel.rows.find((row) => row.key === "weather")?.pinned).toBe(true);
    expect(carousel.rows.find((row) => row.key === "btc")?.pinned).toBe(false);
    // 固定在别处的时候,其它三项不许跟着亮。
    expect(byId(sections, "games").pinned).toBe(false);
    expect(byId(sections, "music").pinned).toBe(false);
  });

  test("an unpinned display pins nothing, whatever focus still says", () => {
    // The service keeps the last focus around after a release; only `pinned`
    // decides whether the console is driving.
    const sections = build({ display: { focus: "weather", pinned: false } });
    expect(byId(sections, "carousel").pinned).toBe(false);
  });

  test("the device's own report names the channel on the panel", () => {
    const sections = build({ telemetry: telemetry({ screen: "channel", focus: "weather" }) });
    const carousel = byId(sections, "carousel");
    expect(carousel.onScreen).toBe(true);
    expect(carousel.rows.find((row) => row.key === "weather")?.onScreen).toBe(true);
    expect(carousel.rows.find((row) => row.key === "btc")?.onScreen).toBe(false);
    // 频道自己会说自己正在显示,所以 footer 只说这一节里有什么——「7 个频道 ·
    // 设备正在显示「灯牌」」加上那一行的 chip,就是同一句话说两遍。
    expect(carousel.footer).toBe("2 个频道");
  });

  test("no footer anywhere restates what the device is doing", () => {
    for (const telemetryOverride of [
      { screen: "channel", focus: "weather" },
      { screen: "music" },
      { screen: "games" },
      { screen: "game" },
      { screen: "settings" },
    ]) {
      const sections = build({ telemetry: telemetry(telemetryOverride) });
      const footers = sections.flatMap((section) => [
        section.footer,
        ...section.rows.map((row) => row.footer),
      ]);
      for (const footer of footers) {
        expect(footer ?? "").not.toContain("正在");
      }
    }
  });

  test("the games ring and a running game are told apart", () => {
    const ring = byId(build({ telemetry: telemetry({ screen: "games" }) }), "games");
    expect(ring.onScreen).toBe(true);
    expect(ring.rows[0]?.onScreen).toBe(true);

    const playing = byId(build({ telemetry: telemetry({ screen: "game" }) }), "games");
    expect(playing.onScreen).toBe(true);
    // 固件只说「在游戏里」,不说是哪一个,所以没有一行可以自称正在跑。
    expect(playing.rows[0]?.onScreen).toBe(false);
    expect(playing.rows.every((row) => row.key === "games:list" || !row.onScreen)).toBe(true);
  });

  test("音乐 is confirmed by screen, never by the channel ring's focus", () => {
    // Pinned to 音乐 the device reported screen "music" while focus stayed on
    // the channel it had been showing — measured at 192.168.8.108.
    const sections = build({ telemetry: telemetry({ screen: "music", focus: "btc" }) });
    expect(byId(sections, "music").onScreen).toBe(true);
    // 一个叶子节点没有下一层,它的状态由它自己的标记说完,不再多一行 footer。
    expect(byId(sections, "music").footer).toBeNull();
    expect(byId(sections, "carousel").onScreen).toBe(false);
  });

  test("offline nothing claims to be on screen", () => {
    const sections = build({ live: false, telemetry: telemetry({ screen: "channel", focus: "btc" }) });
    expect(sections.every((section) => !section.onScreen)).toBe(true);
    expect(sections.every((section) => section.rows.every((row) => !row.onScreen))).toBe(true);
    // 但菜单结构还在:离线也能预约固定,固件上线后第一次拉取即生效。
    expect(sections).toHaveLength(4);
  });

  test("a destination the service does not offer is dropped, not shown dead", () => {
    const sections = describeSections({
      menu: [{ id: "btc", label: "比特币", kind: "channel" }],
      display: { focus: null, pinned: false },
      telemetry: null,
      live: false,
      bleAvailable: true,
    });
    expect(sections.map((section) => section.id)).toEqual(["carousel"]);
  });

  test("an empty menu produces no sections at all", () => {
    expect(describeSections({
      menu: [],
      display: { focus: null, pinned: false },
      telemetry: null,
      live: false,
      bleAvailable: false,
    })).toEqual([]);
  });
});

describe("zos markers", () => {
  test("a row states its own facts, and 已固定 outranks 正在显示", () => {
    const sections = build({
      display: { focus: "weather", pinned: true },
      telemetry: telemetry({ screen: "channel", focus: "weather" }),
    });
    const carousel = byId(sections, "carousel");
    const weather = carousel.rows.find((row) => row.key === "weather")!;
    // 确认到位的固定同时满足两件事,但一行上挂两个 chip 就是自己跟自己重复。
    expect(weather.pinned && weather.onScreen).toBe(true);
    expect(rowMarker(weather)).toBe("pinned");
    expect(rowMarker(carousel.rows.find((row) => row.key === "btc")!)).toBeNull();
  });

  test("an open section defers to its rows, a collapsed one speaks for them", () => {
    const sections = build({
      display: { focus: "weather", pinned: true },
      telemetry: telemetry({ screen: "channel", focus: "weather" }),
    });
    const carousel = byId(sections, "carousel");
    expect(sectionMarker(carousel, true)).toBeNull();
    expect(sectionMarker(carousel, false)).toBe("pinned");
  });

  test("a running game is the one fact no row may claim, so the section keeps it", () => {
    // 固件只报 screen: "game",不说是哪一个引擎——展开也没有一行有资格说,
    // 所以这一句归 游戏 自己,展开与否都在。
    const playing = byId(build({ telemetry: telemetry({ screen: "game" }) }), "games");
    expect(sectionMarker(playing, true)).toBe("onScreen");
    expect(sectionMarker(playing, false)).toBe("onScreen");

    // 停在选游戏那一环时,游戏列表 这一行说得出口,上面那层就闭嘴。
    const ring = byId(build({ telemetry: telemetry({ screen: "games" }) }), "games");
    expect(sectionMarker(ring, true)).toBeNull();
    expect(sectionMarker(ring, false)).toBe("onScreen");
  });

  test("a leaf is its own row, so it always carries its own marker", () => {
    const music = byId(build({ telemetry: telemetry({ screen: "music" }) }), "music");
    expect(sectionMarker(music, false)).toBe("onScreen");
    const pinned = byId(build({ display: { focus: "music", pinned: true } }), "music");
    expect(sectionMarker(pinned, false)).toBe("pinned");
    expect(sectionMarker(byId(build(), "music"), false)).toBeNull();
  });
});

describe("zos pin intent", () => {
  test("clicking an idle row pins it, and promises only the pull", () => {
    const intent = pinIntent({ label: "大字天气钟", focus: "weather", pinned: false });
    expect(intent).toEqual({
      focus: "weather",
      pinned: true,
      title: "已固定「大字天气钟」",
      detail: "时钟下次拉取状态时切过去，通常几秒内。",
    });
  });

  test("clicking the pinned row again hands the knob back", () => {
    // 这是那个写死的 aria-label 曾经说反的动作:同一行再点一次是取消固定。
    const intent = pinIntent({ label: "大字天气钟", focus: "weather", pinned: true });
    expect(intent.focus).toBeNull();
    expect(intent.pinned).toBe(false);
    expect(intent.title).toBe("已交还旋钮");
    expect(intent.detail).toBeNull();
  });

  test("a game shortcut says it enters the engine, the plain ring does not", () => {
    expect(pinIntent({ label: "贪吃蛇", focus: "game:snake", pinned: false }).detail)
      .toBe("时钟下次拉取状态时直接进入游戏。");
    expect(pinIntent({ label: "游戏列表", focus: "game", pinned: false }).detail)
      .toBe("时钟下次拉取状态时切过去，通常几秒内。");
  });
});

describe("zos default open section", () => {
  test("轮播 opens first, because switching channels should cost zero clicks", () => {
    expect(defaultOpenSection(build())).toBe("carousel");
  });

  test("whatever holds the pin wins, so no accordion hides the live command", () => {
    expect(defaultOpenSection(build({ display: { focus: "game:snake", pinned: true } }))).toBe("games");
  });

  test("a leaf pin does not open anything, having nothing to open", () => {
    expect(defaultOpenSection(build({ display: { focus: "music", pinned: true } }))).toBe("carousel");
  });

  test("no sections, nothing open", () => {
    expect(defaultOpenSection([])).toBeUndefined();
  });
});
