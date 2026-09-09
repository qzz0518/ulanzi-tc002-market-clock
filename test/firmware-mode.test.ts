import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import {
  LOW_BATTERY_PERCENT,
  describeBattery,
  describeFirmware,
  deriveFirmwareMode,
  firmwareModeLabel,
  type FirmwareOsState,
} from "../web/src/lib/firmware-mode.ts";
import { StudioHeader } from "../web/src/components/studio/studio-header";

function osState(overrides: Partial<FirmwareOsState> = {}): FirmwareOsState {
  return {
    live: true,
    telemetry: { batteryPercent: 87, charging: false, ageMs: 1_200 },
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof describeFirmware>[0]> = {}) {
  return {
    osState: null,
    musicFirmwareOnline: false,
    ...overrides,
  };
}

function header(overrides: Partial<Parameters<typeof StudioHeader>[0]> = {}): string {
  return renderToStaticMarkup(createElement(
    CladdProvider,
    null,
    createElement(StudioHeader, {
      view: "console",
      onViewChange: () => {},
      runtime: { healthy: true },
      firmwareStatus: describeFirmware(input()),
      ...overrides,
    }),
  ));
}

describe("firmware mode", () => {
  test("nothing reporting means the official firmware, never a guess", () => {
    expect(deriveFirmwareMode(input())).toBe("official");
    // 服务没有 os link（404）或读取失败时 osState 为 null，同样落回官方固件。
    expect(deriveFirmwareMode(input({ osState: null }))).toBe("official");
  });

  test("a live ZOS report outranks every sideload heartbeat", () => {
    expect(deriveFirmwareMode(input({ osState: osState() }))).toBe("zos");
    // ZOS 是刷进去的固件，它在上报就说明侧载心跳是残留：实测证据优先。
    expect(deriveFirmwareMode(input({
      osState: osState(),
      musicFirmwareOnline: true,
    }))).toBe("zos");
  });

  test("the music sideload's heartbeat ranks above official", () => {
    expect(deriveFirmwareMode(input({ musicFirmwareOnline: true }))).toBe("music");
  });

  test("an offline ZOS state is not ZOS", () => {
    // live=false 是服务对上报时效的判断；控制台不再自己拿 receivedAt 减浏览器时钟。
    expect(deriveFirmwareMode(input({ osState: osState({ live: false }) }))).toBe("official");
    expect(deriveFirmwareMode(input({
      osState: osState({ live: false }),
      musicFirmwareOnline: true,
    }))).toBe("music");
  });

  test("labels stay in Simplified Chinese", () => {
    expect(firmwareModeLabel("official")).toBe("官方固件");
    expect(firmwareModeLabel("music")).toBe("音乐固件");
    expect(firmwareModeLabel("zos")).toBe("ZOS");
  });
});

describe("battery readout", () => {
  test("reads the percentage only while the device is live", () => {
    expect(describeBattery(osState()).text).toBe("87%");
    // 离线就是离线：最后一次读数留在屏幕上和当前读数长得一模一样。
    expect(describeBattery(osState({ live: false }))).toEqual({
      percent: null,
      charging: false,
      text: null,
      low: false,
    });
    expect(describeBattery(null).text).toBeNull();
  });

  test("-1 shows nothing rather than a flat battery", () => {
    // 固件在 MCU 给出读数前一直发 -1；渲染成 0% 就是在给满电的时钟报没电。
    expect(describeBattery(osState({
      telemetry: { batteryPercent: -1, charging: false },
    })).text).toBeNull();
    // 旧服务干脆没有这两个字段，同样什么都不显示。
    expect(describeBattery(osState({ telemetry: {} })).text).toBeNull();
    expect(describeBattery(osState({ telemetry: null })).text).toBeNull();
  });

  test("charging is part of the readout, and 0% only after a real reading", () => {
    const charging = describeBattery(osState({
      telemetry: { batteryPercent: 41, charging: true },
    }));
    expect(charging.text).toBe("41% 充电中");
    expect(charging.charging).toBe(true);
    // 充电时不算「电量低」——插着线的 5% 不需要报警。
    expect(describeBattery(osState({
      telemetry: { batteryPercent: 5, charging: true },
    })).low).toBe(false);
    const flatButReal = describeBattery(osState({ telemetry: { batteryPercent: 0, charging: false } }));
    expect(flatButReal.text).toBe("0%");
    expect(flatButReal.low).toBe(true);
  });

  test("clamps and rounds what the device sends", () => {
    expect(describeBattery(osState({ telemetry: { batteryPercent: 100.4 } })).percent).toBe(100);
    expect(describeBattery(osState({ telemetry: { batteryPercent: 128 } })).percent).toBe(100);
    expect(describeBattery(osState({ telemetry: { batteryPercent: 66.6 } })).text).toBe("67%");
    expect(describeBattery(osState({ telemetry: { batteryPercent: Number.NaN } })).text).toBeNull();
  });

  test("low is the threshold, not a vibe", () => {
    expect(describeBattery(osState({
      telemetry: { batteryPercent: LOW_BATTERY_PERCENT },
    })).low).toBe(true);
    expect(describeBattery(osState({
      telemetry: { batteryPercent: LOW_BATTERY_PERCENT + 1 },
    })).low).toBe(false);
  });
});

describe("firmware status copy", () => {
  test("only ZOS talks about a battery, and says so when it has none", () => {
    const zos = describeFirmware(input({ osState: osState() }));
    expect(zos.label).toBe("ZOS");
    expect(zos.description).toContain("ZOS");
    expect(zos.description).toContain("电量 87%");

    const unread = describeFirmware(input({
      osState: osState({ telemetry: { batteryPercent: -1 } }),
    }));
    expect(unread.description).toContain("电量尚未读到");
    expect(unread.battery.text).toBeNull();

    const official = describeFirmware(input());
    expect(official.description).not.toContain("电量");
    // 官方固件没有电量通道，别让它看起来像是「读数丢了」。
    expect(official.battery.percent).toBeNull();
  });

  test("闪存里是什么和谁在上报是两件事，掉线只影响后者", () => {
    // mode 说的是「此刻谁在上报」——它必须这么说，否则镜像和指示灯都会宣称一台
    // 沉默的设备正在运行。断电后回到什么是另一件事，而它挺得过这段沉默。
    const offline = describeFirmware(input({
      osState: osState({ live: false, zosFlashed: true }),
    }));
    expect(offline.mode).toBe("official");
    expect(offline.zosFlashed).toBe(true);

    expect(describeFirmware(input({ osState: osState({ zosFlashed: true }) })).zosFlashed)
      .toBe(true);
    // 服务没提这台钟刷没刷过，就不许替它断言。
    expect(describeFirmware(input({ osState: osState() })).zosFlashed).toBe(false);
    expect(describeFirmware(input()).zosFlashed).toBe(false);
  });
});

describe("studio header indicator", () => {
  test("names the firmware in the top right", () => {
    expect(header()).toContain("官方固件");
    expect(header({ firmwareStatus: describeFirmware(input({ musicFirmwareOnline: true })) }))
      .toContain("音乐固件");
  });

  test("shows the battery like a phone once ZOS reports one", () => {
    const html = header({
      firmwareStatus: describeFirmware(input({
        osState: osState({ telemetry: { batteryPercent: 87, charging: true } }),
      })),
    });
    expect(html).toContain("ZOS");
    expect(html).toContain("87%");
    expect(html).toContain("电量 87% 充电中");
  });

  test("hides the battery when the device is not reporting", () => {
    const offline = header({
      firmwareStatus: describeFirmware(input({ osState: osState({ live: false }) })),
    });
    expect(offline).not.toContain("%");
    expect(offline).toContain("官方固件");

    const unread = header({
      firmwareStatus: describeFirmware(input({
        osState: osState({ telemetry: { batteryPercent: -1, charging: false } }),
      })),
    });
    // 没读到电量时整块不出现，而不是 0%。
    expect(unread).toContain("ZOS");
    expect(unread).not.toContain("0%");
  });

  test("the push-link light speaks only for the official firmware", () => {
    // 官方固件下它报的是 Custom App 推送链路。
    expect(header({ runtime: { healthy: true } })).toContain("设备正常");
    // 跑 ZOS 时那条通道根本不存在，报「设备离线」等于污蔑一台正在上报的设备。
    const zos = header({
      runtime: { healthy: false },
      firmwareStatus: describeFirmware(input({ osState: osState() })),
    });
    expect(zos).not.toContain("设备离线");
    expect(zos).toContain("ZOS");
  });
});
