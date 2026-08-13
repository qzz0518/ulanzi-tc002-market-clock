import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import {
  DEVICE_INFO_ROWS,
  describeZosDeviceFacts,
  deviceSettingsSurface,
} from "../web/src/lib/device-settings-fields";
import {
  DeviceGeneralPanel,
  ZosGeneralPanel,
} from "../web/src/components/studio/device-settings-dialog";
import { ZosSendRows } from "../web/src/components/zos/zos-send-row";
import type { BleSupport } from "../web/src/lib/ble-provisioning";
import type { ZosState, ZosTelemetry } from "../web/src/lib/zos-link";
import type { DeviceGeneralSettings } from "../web/src/types";

const noop = () => {};

function markup(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(createElement(CladdProvider, null, node));
}

const BLE_OK: BleSupport = {
  code: "ok",
  ok: true,
  title: "可用",
  detail: "这台浏览器支持网页蓝牙。",
  offerPortal: false,
};

const OFFICIAL_DRAFT: DeviceGeneralSettings = {
  brightness: { level: "mid", low: 30, mid: 60, high: 90 },
  volume: 3,
  carouselSpeed: 20,
  scrollSpeed: 4,
  timezone: "UTC+8",
  dateFormat: "MM/DD",
  showWeek: true,
  weekStart: 1,
  lowBatteryAutoSleep: false,
};

/** 只有官方固件那一页才有的字段——它们全部来自 /getConfig 与 /getDeviceInfo。 */
const STOCK_ONLY_LABELS = [
  "自动翻页速度",
  "滚动速度",
  "时区设置",
  "显示星期",
  "一周第一天",
  "低电量自动休眠",
];

function telemetry(overrides: Partial<ZosTelemetry> = {}): ZosTelemetry {
  return {
    screen: "channel",
    focus: "btc",
    wifi: "xiaoya-2.4G",
    ip: "192.168.8.108",
    uptimeMs: 7_400_000,
    freeKb: 16_568,
    supplicantRestarts: 0,
    receivedAt: 1_000_000,
    ageMs: 3_000,
    ...overrides,
  };
}

function state(overrides: Partial<ZosState> = {}): ZosState {
  return {
    seq: 4,
    menu: [],
    display: { focus: null, pinned: false },
    telemetry: telemetry(),
    live: true,
    ...overrides,
  };
}

function facts(input: ZosState | null): Map<string, { value: string; note?: string }> {
  return new Map(describeZosDeviceFacts(input, 1_003_000).map((row) => [row.key, row]));
}

describe("which surface 常规设置 renders, per firmware", () => {
  test("a live report picks the surface; the two sideloads share one", () => {
    expect(deviceSettingsSurface("official")).toBe("official");
    expect(deviceSettingsSurface("zos")).toBe("zos");
    // 音乐/游戏 are the same situation for this dialog: something else holds the
    // device and the official endpoints answer nothing.
    expect(deviceSettingsSurface("music")).toBe("sideload");
    expect(deviceSettingsSurface("arcade")).toBe("sideload");
  });

  test("a flashed ZOS that fell off the Wi-Fi is still ZOS, not 官方固件", () => {
    // 掉线的那一刻恰恰是这个对话框最有用的时候（蓝牙配网在里面）。firmwareMode 只认
    // 「此刻在上报」，所以掉线的 ZOS 在它眼里是 official；zosFlashed 是服务端记住的
    // 黏性事实，闪存里装的是什么不会因为设备掉线而改变。
    expect(deviceSettingsSurface("official", true)).toBe("zos");
    // 侧载优先：闪存里是 ZOS，但此刻占着设备的是侧载固件。
    expect(deviceSettingsSurface("music", true)).toBe("sideload");
    expect(deviceSettingsSurface("arcade", true)).toBe("sideload");
    // 没刷过就还是官方固件那条路，一个字都不改。
    expect(deviceSettingsSurface("official", false)).toBe("official");
  });
});

describe("常规 tab, stock firmware — unchanged", () => {
  // 刷着原厂固件的人看到的必须和以前一模一样。钉住的是渲染出来的表单本身,不是
  // 另写一份「应该有哪些字段」的清单——那种清单删光表单也照样能通过。
  test("all nine fields render, in the stock page's own words", () => {
    const html = markup(createElement(DeviceGeneralPanel, {
      draft: OFFICIAL_DRAFT,
      onChange: noop,
    }));

    for (const label of ["屏幕亮度", "音量调节", ...STOCK_ONLY_LABELS, "日期"]) {
      expect([label, html.includes(label)]).toEqual([label, true]);
    }
    // 四节标题照旧,加上共用的「关于」。
    for (const heading of ["显示与声音", "播放行为", "日期与时间", "电源", "关于"]) {
      expect([heading, html.includes(heading)]).toEqual([heading, true]);
    }
    // 三条滑块(亮度/音量/翻页/滚动 共四条)与两个开关都还在。
    expect(html.match(/type="range"/g)?.length ?? 0).toBe(4);
    expect(html.match(/role="switch"/g)?.length ?? 0).toBe(2);
    // 读数按各自的量纲显示,不是一律百分比。
    expect(html).toContain("60 %");
    expect(html).toContain("3 级");
    expect(html).toContain("20 秒");
    expect(html).toContain("4 档");
    expect(html).toContain("UTC+8");
  });

  test("0 值有自己的说法，不是一个孤零零的 0", () => {
    const html = markup(createElement(DeviceGeneralPanel, {
      draft: { ...OFFICIAL_DRAFT, volume: 0, carouselSpeed: 0, scrollSpeed: 0 },
      onChange: noop,
    }));
    expect(html).toContain("静音");
    expect(html).toContain("不翻页");
    expect(html).toContain("不滚动");
  });

  test("设备信息 keeps the six /getDeviceInfo rows, in order", () => {
    // 这张表就是这个列表本身(DeviceHostPanel 直接 map 它),所以钉住它等于钉住那一页。
    expect(DEVICE_INFO_ROWS.map((row) => row.key)).toEqual([
      "serialNumber",
      "ssid",
      "ip",
      "mac",
      "mcuVersion",
      "appVersion",
    ]);
    expect(DEVICE_INFO_ROWS.map((row) => row.label)).toEqual([
      "设备 SN",
      "WiFi 名称",
      "IP 地址",
      "MAC 地址",
      "MCU 固件版本",
      "SOC 固件版本",
    ]);
  });
});

describe("常规 tab, ZOS — two different tables, not one half-filled", () => {
  test("nothing borrowed from the stock form", () => {
    const html = markup(createElement(ZosGeneralPanel, {
      requested: { volume: 4, brightness: 7, seq: 2 },
      live: true,
      bleSupport: BLE_OK,
      onSend: noop,
      onProvision: noop,
    }));

    // 能写的就这两个 + 配网:PUT /api/os/settings 只收 volume/brightness。
    expect(html.match(/type="range"/g)?.length ?? 0).toBe(2);
    expect(html).toContain("音量");
    expect(html).toContain("亮度");
    expect(html).toContain("蓝牙配网");
    // 官方固件那几个字段一个都不出现:它们读的是 ZOS 没有实现的端点,
    // 留一排读不到也写不了的空行比不列出来更糟。
    for (const label of STOCK_ONLY_LABELS) {
      expect([label, html.includes(label)]).toEqual([label, false]);
    }
    // 设备状态那张表同理:出厂标识在 ZOS 上根本不存在。
    const zosFactKeys = describeZosDeviceFacts(state(), 1_003_000).map((row) => row.key);
    for (const key of ["serialNumber", "mac", "mcuVersion", "appVersion"]) {
      expect([key, zosFactKeys.includes(key)]).toEqual([key, false]);
    }
  });

  test("offline the page still works, and says why it is worth using", () => {
    const html = markup(createElement(ZosGeneralPanel, {
      requested: null,
      live: false,
      bleSupport: BLE_OK,
      onSend: noop,
      onProvision: noop,
    }));
    // 掉线不是把这一页关掉的理由:配网走蓝牙,不需要时钟在网上;音量亮度写给服务,
    // 固件回来第一次拉取就生效。
    expect(html).toContain("时钟掉线了");
    expect(html).toContain("已经刷进闪存");
    expect(html).toContain("开始配网");
    expect(html.match(/type="range"/g)?.length ?? 0).toBe(2);
  });

  test("online there is no offline banner", () => {
    const html = markup(createElement(ZosGeneralPanel, {
      requested: null,
      live: true,
      bleSupport: BLE_OK,
      onSend: noop,
      onProvision: noop,
    }));
    expect(html).not.toContain("时钟掉线了");
  });
});

describe("the ZOS 设备状态 rows", () => {
  test("the rows are the telemetry block plus residency, in render order", () => {
    expect(describeZosDeviceFacts(state(), 1_003_000).map((row) => row.key)).toEqual([
      "wifi",
      "ip",
      "battery",
      "uptime",
      "free",
      "supplicant",
      "heartbeat",
      "residency",
    ]);
  });

  test("a live device reports its link, power and memory in the panel's own words", () => {
    const rows = facts(state({
      telemetry: telemetry({ batteryPercent: 82, charging: false }),
    }));
    expect(rows.get("wifi")?.value).toBe("xiaoya-2.4G");
    expect(rows.get("ip")?.value).toBe("192.168.8.108");
    expect(rows.get("battery")?.value).toBe("82%");
    expect(rows.get("uptime")?.value).toBe("2 小时 3 分");
    expect(rows.get("free")?.value).toBe("16568 KB");
    expect(rows.get("supplicant")?.value).toBe("0 次");
    // 心跳按服务自己量的 ageMs 算,不拿浏览器时钟去减设备时间。
    expect(rows.get("heartbeat")?.value).toBe("3 秒前");
    // 0 次不带注解:数字本身已经说完了,而它为什么是 0 是我们的实现细节。
    expect(rows.get("supplicant")?.note).toBeUndefined();
  });

  test("充电中 is said on the row, not left to a colour", () => {
    const rows = facts(state({ telemetry: telemetry({ batteryPercent: 12, charging: true }) }));
    expect(rows.get("battery")?.value).toBe("12% · 充电中");
  });

  test("-1 是「还没读到」,永远不许变成 0%", () => {
    // 固件在 MCU 第一次回读之前一直发 -1;把它画成 0% 就是在一台满电的钟上报
    // 「快没电了」。服务太老、字段缺失,同样不许猜。
    for (const percent of [-1, undefined]) {
      const rows = facts(state({ telemetry: telemetry({ batteryPercent: percent }) }));
      expect(rows.get("battery")?.value).toBe("尚未读到");
      expect(rows.get("battery")?.value).not.toContain("0%");
      expect(rows.get("battery")?.note).toContain("MCU");
    }
  });

  test("offline every reading collapses to 离线, and no stale number survives", () => {
    // 上一份读数和当前读数在屏幕上长得一模一样,所以掉线就什么都不留。
    const rows = facts(state({ live: false }));
    for (const key of ["wifi", "ip", "battery", "uptime", "free", "supplicant", "heartbeat"]) {
      expect([key, rows.get(key)?.value]).toEqual([key, "离线"]);
    }
    expect(rows.get("wifi")?.value).not.toBe("xiaoya-2.4G");
  });

  test("固件驻留 is sticky: 断电后回到什么,不因掉线而改口", () => {
    // 刷进闪存是设备的事实,不是这一秒有没有上报的事实。
    expect(facts(state({ live: false, zosFlashed: true })).get("residency")?.value)
      .toBe("已刷入闪存");
    expect(facts(state({ zosFlashed: true })).get("residency")?.note)
      .toContain("断电重启后仍是 ZOS");
    expect(facts(state()).get("residency")?.value).toBe("临时侧载");
    expect(facts(state({ live: false })).get("residency")?.value).toBe("未知");
    expect(facts(null).get("residency")?.value).toBe("未知");
  });

  test("nothing read yet is not the same as offline", () => {
    // 对话框在拿到第一份状态前显示「正在读取」,而不是把 null 当成掉线;这个
    // 分支由 DeviceHostPanel 的 zosFacts === null 承担,这里只钉住 helper 不会
    // 替它编一份读数出来。
    expect(facts(null).get("ip")?.value).toBe("离线");
    expect(facts(null).get("battery")?.value).toBe("离线");
  });
});

describe("volume and brightness are sends, not readouts", () => {
  test("nothing sent yet says 未下发 on both rows, and dims both sliders", () => {
    const html = markup(createElement(ZosSendRows, { requested: null, onSend: noop }));
    // 半满的轨道不能冒充设备当前的亮度:读数说「未下发」,滑块压暗。
    expect(html.match(/未下发/g)?.length ?? 0).toBe(2);
    expect(html.match(/is-unsent/g)?.length ?? 0).toBe(2);
    expect(html).not.toContain("0 / 10");
  });

  test("a sent value is shown in the device's own scale, and stops being dimmed", () => {
    const html = markup(createElement(ZosSendRows, {
      requested: { volume: 0, brightness: 7, seq: 3 },
      onSend: noop,
    }));
    // 0 档是真静音,不是「很小声」,所以给词不给数。
    expect(html).toContain("静音");
    expect(html).toContain("7 / 10");
    expect(html).not.toContain("未下发");
    expect(html).not.toContain("is-unsent");
  });

  test("one component, two homes — the panel and the dialog cannot drift", async () => {
    const [panel, dialog] = await Promise.all([
      Bun.file(new URL("../web/src/components/zos/zos-panel.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/studio/device-settings-dialog.tsx", import.meta.url)).text(),
    ]);
    for (const source of [panel, dialog]) {
      expect(source).toContain("<ZosSendRows");
      // 量程和措辞都不许在调用处重写一遍。
      expect(source).not.toContain("ZOS_VOLUME_MAX");
      expect(source).not.toContain("volumeText");
    }
  });
});
