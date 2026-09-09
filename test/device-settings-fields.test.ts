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
  ZosFirmwarePanel,
  ZosGeneralPanel,
} from "../web/src/components/studio/device-settings-dialog";
import { ZosSendRows } from "../web/src/components/zos/zos-send-row";
import { ZosFirmwareUpdate } from "../web/src/components/zos/zos-firmware-update";
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
  test("a live report picks the surface; the music sideload gets its own", () => {
    expect(deviceSettingsSurface("official")).toBe("official");
    expect(deviceSettingsSurface("zos")).toBe("zos");
    // Something else holds the device and the official endpoints answer nothing.
    expect(deviceSettingsSurface("music")).toBe("sideload");
  });

  test("a flashed ZOS that fell off the Wi-Fi is still ZOS, not 官方固件", () => {
    // 掉线的那一刻恰恰是这个对话框最有用的时候（蓝牙配网在里面）。firmwareMode 只认
    // 「此刻在上报」，所以掉线的 ZOS 在它眼里是 official；zosFlashed 是服务端记住的
    // 黏性事实，闪存里装的是什么不会因为设备掉线而改变。
    expect(deviceSettingsSurface("official", true)).toBe("zos");
    // 侧载优先：闪存里是 ZOS，但此刻占着设备的是侧载固件。
    expect(deviceSettingsSurface("music", true)).toBe("sideload");
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
      sleep: { on: false, startMin: 1380, endMin: 420, idleSec: 300, asleep: false, clockSynced: true },
      onSleepSend: noop,
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
      sleep: null,
      onSleepSend: noop,
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

  // 固件搬去了自己的标签页,所以「常规」这一页到 网络 就结束了,关于 顶上空出来的
  // 那个序号。留一个 04 的洞,或者让 关于 停在 05,都是在说这里还有一节没渲染出来。
  test("固件 has left this page, and the numbering closes up behind it", () => {
    const html = markup(createElement(ZosGeneralPanel, {
      requested: null,
      live: true,
      sleep: null,
      onSleepSend: noop,
      bleSupport: BLE_OK,
      onSend: noop,
      onProvision: noop,
    }));

    // 三节 + 关于,序号连着走:显示与声音 01、夜间息屏 02、网络 03、关于 04。
    const order = ["显示与声音", "夜间息屏", "网络", "关于"];
    let cursor = -1;
    for (const heading of order) {
      const at = html.indexOf(`>${heading}<`);
      expect([heading, at > cursor]).toEqual([heading, true]);
      cursor = at;
    }
    expect(html).toContain("<span>04</span>");
    expect(html).not.toContain("<span>05</span>");

    // 固件那一节连同它的正文一起走了,不是把标题留在这里当占位。
    expect(html).not.toContain(">固件<");
    expect(html).not.toContain("选择镜像文件");
    expect(html).not.toContain("安装到时钟");
  });

  // 固件是这一屏唯一一个会重写闪存的操作,所以它是一个平级的去处,不是「常规」
  // 里的第 N 节。这条钉的是那一页真的把整段正文带走了。
  test("固件 is its own page: one section, numbered 01, carrying the whole panel", () => {
    const html = markup(createElement(ZosFirmwarePanel, {
      children: createElement(ZosFirmwareUpdate, {
        mode: "zos",
        zosFlashed: true,
        live: true,
        status: {
          packed: true,
          image: {
            buildId: "aa7ab843c11ec2713a023b4a20f52b14",
            bytes: 1_045_052,
            builtAt: 1_700_000_000_000,
            md5: "08e9fc52338abd686ee822295a051327",
            partitionType: 3,
            partitionLabel: "res",
            zosBuildId: null,
            filesystemBuiltAt: null,
          },
          source: { kind: "packed", fileName: null, at: 1_700_000_000_000 },
          shadowedPacked: null,
          restore: null,
        },
        statusError: null,
        request: null,
        serverSeq: null,
        now: 1_700_000_000_000,
        busy: false,
        uploading: false,
        consent: false,
        onConsentChange: noop,
        onUpgrade: noop,
        onRefreshStatus: noop,
        onUpload: noop,
        onRemoveUpload: noop,
        onArmRestore: noop,
        restoring: false,
      }),
    }));

    // 自己的一页,所以从 01 数起,而且只有这一节。
    expect(html).toContain("<span>01</span>");
    expect(html).not.toContain("<span>02</span>");
    // 标签页已经叫「固件」了,这一节讲的是那份镜像。
    expect(html).toContain("系统镜像");
    // 镜像事实、上传入口、安装按钮都在里面——不是一个占位的标题。
    expect(html).toContain("08e9fc52338abd686ee822295a051327");
    expect(html).toContain("res（mtd3）");
    expect(html).toContain("选择镜像文件");
    expect(html).toContain("安装到时钟");
  });

  test("online there is no offline banner", () => {
    const html = markup(createElement(ZosGeneralPanel, {
      requested: null,
      live: true,
      sleep: { on: true, startMin: 1380, endMin: 420, idleSec: 300, asleep: false, clockSynced: true },
      onSleepSend: noop,
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

  test("电压跟在百分比旁边——固件真正据以关机的量", () => {
    const rows = facts(state({
      telemetry: telemetry({ batteryPercent: 54, batteryMillivolts: 3821, charging: true }),
    }));
    expect(rows.get("battery")?.value).toBe("54% · 3821 mV · 充电中");
    // 单位就是毫伏。不拿电压再换算出第二个百分比:那条电芯曲线我们没有,
    // 两个对不上的百分比只会让人以为其中一个坏了。
    expect(rows.get("battery")?.value).not.toMatch(/mV.*%/);
  });

  test("老固件不报电压时,那一段整个不出现,而不是占位符", () => {
    const rows = facts(state({ telemetry: telemetry({ batteryPercent: 54 }) }));
    expect(rows.get("battery")?.value).toBe("54%");
    expect(rows.get("battery")?.value).not.toContain("mV");
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

// --- 固件那一页的导航与内缩 ---------------------------------------------------

/** `@media (max-width: 34rem) { … }` 那一整块。块内规则都是单行，所以顶格的 `}` 就是它的结尾。 */
function mediaBlock(css: string, query: string): string {
  const at = css.indexOf(`@media ${query} {`);
  expect([query, at > -1]).toEqual([query, true]);
  const end = css.indexOf("\n}\n", at);
  expect([query, end > at]).toEqual([query, true]);
  return css.slice(at, end);
}

describe("固件 is a destination in this dialog, not a section of 常规", () => {
  // cladd 的 Dialog 走 portal，服务端渲染出来是空串，所以导航本身只能在源码这一层
  // 钉住——面板的正文由上面那两条渲染着断言。
  test("it rides the same Tabs as 常规 and 设备信息, and only on ZOS", async () => {
    const source = await Bun.file(
      new URL("../web/src/components/studio/device-settings-dialog.tsx", import.meta.url),
    ).text();

    // 同一套导航，不是第二种写法：和另外两个一样，一个 <Tab> 配一个 <TabPanel>。
    expect(source).toContain('<Tab value="general">');
    expect(source).toContain('<Tab value="device">');
    expect(source).toContain('{zos && <Tab value="firmware"><Cpu />固件</Tab>}');
    expect(source).toContain('<TabPanel value="firmware"');
    // 三个去处共用一个联合类型，别处 as 成什么就是什么的那种写法接不住新标签页。
    expect(source).toContain('type SettingsTab = "general" | "device" | "firmware";');
    // 一台不跑 ZOS 的钟没有 ZOS 可更新：标签页跟着 zos 出现，选中的那一页也要
    // 在它消失时让位，否则 cladd 会渲染出一个哪一页都不亮的空壳。
    expect(source).toContain('if (!zos && tab === "firmware") setTab("general");');
    // 它不再是「常规」里那一节：标题换了、序号也不在那边了。
    expect(source).not.toContain('id="zos-firmware-title">固件<');
    expect(source).toContain('id="zos-firmware-title">系统镜像<');
  });
});

describe("设置对话框的左右内缩只有一个来源", () => {
  // 同意栏与「安装到时钟」比它上面每一行都往里 5.6px 的那个 bug：行的内缩是
  // .device-setting-field 的 padding，说明块的内缩是 .device-settings-note 的
  // margin——两条互不相干的规则各抄了一份 1.25rem，而窄屏那条 @media 只重写了行。
  test("行的 padding 与说明块的 margin 读同一个变量", async () => {
    const css = await Bun.file(new URL("../web/src/styles/globals.css", import.meta.url)).text();
    const inset = "var(--device-settings-inset, 1.25rem)";

    expect(css).toContain("--device-settings-inset: 1.25rem;");
    // 两种盒模型，同一个数。任何一边写回字面量，这两条就分家了。
    expect(css).toContain(`padding: 0.58rem ${inset};`);
    expect(css).toContain(`margin: 0 ${inset};`);
    // 同一屏上其余几处内缩也在同一个数上：页脚、分节标题、下发行、链接行。
    expect(css).toContain(`padding: 0.9rem ${inset};`);
    expect(css).toContain(`padding: 1rem 1rem 1rem ${inset};`);
    expect(css).toContain(`.device-settings-fields .zc-out__row { padding-inline: ${inset}; }`);
  });

  test("窄屏只改这一个数，没有一条规则被落下", async () => {
    const css = await Bun.file(new URL("../web/src/styles/globals.css", import.meta.url)).text();
    const narrow = mediaBlock(css, "(max-width: 34rem)");

    expect(narrow).toContain(".device-settings-dialog { --device-settings-inset: 0.9rem; }");
    // 逐条重写行、页脚、分节标题而漏掉说明块，正是同意栏错位的来路。改成一个变量
    // 之后，这一块里不该再剩下任何一条自己算内缩的规则。
    for (const selector of [
      ".device-setting-field",
      ".device-settings-actions",
      ".device-settings-section__heading",
      ".device-settings-fields .zc-out__row",
    ]) {
      const rule = narrow.split("\n").find((line) => line.trim().startsWith(`${selector} {`)) ?? "";
      expect([selector, rule.includes("padding-inline")]).toEqual([selector, false]);
      expect([selector, rule.includes("0.9rem")]).toEqual([selector, false]);
    }
  });
});
