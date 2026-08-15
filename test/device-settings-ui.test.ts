import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clockHostError,
  DeviceHostPanel,
  DeviceSettingSwitch,
} from "../web/src/components/studio/device-settings-dialog";
import { formatMacAddress } from "../web/src/lib/device-settings-fields";
import type { DeviceInfo } from "../web/src/types";

const FULL_INFO: DeviceInfo = {
  serialNumber: "B0D26I008U3670972",
  ssid: "xiaoya-2.4G",
  ip: "192.168.8.240",
  mac: "ccc4b277a772",
  mcuVersion: "V1.0.17",
  appVersion: "1.0.8",
};

function hostPanelProps(overrides: Partial<Parameters<typeof DeviceHostPanel>[0]> = {}) {
  return {
    info: FULL_INFO,
    infoLoading: false,
    infoError: null,
    host: { host: "192.168.8.240", envHost: "192.168.8.240", source: "env" as const },
    hostDraft: "192.168.8.240",
    savingHost: false,
    onHostDraftChange: () => {},
    onSaveHost: () => {},
    onResetHost: () => {},
    onRetry: () => {},
    ...overrides,
  };
}

describe("device settings UI", () => {
  test("wraps each Cladd switch in a native label hit target", () => {
    const html = renderToStaticMarkup(createElement(DeviceSettingSwitch, {
      label: "显示星期",
      checked: true,
      onChange: () => {},
    }));

    expect(html).toStartWith('<label class="device-settings-switch">');
    expect(html).toContain('<span class="sr-only">显示星期</span>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });

  test("mirrors the server's clock-host rules so the obvious pastes fail locally", () => {
    expect(clockHostError("192.168.8.240")).toBeNull();
    expect(clockHostError("tc002.local")).toBeNull();
    expect(clockHostError("  192.168.8.240  ")).toBeNull();
    expect(clockHostError("")).toContain("填写");
    expect(clockHostError("http://192.168.8.240")).toContain("http://");
    expect(clockHostError("192.168.8.240:80")).toContain("端口");
    expect(clockHostError("192.168.8 240")).toContain("空格");
    expect(clockHostError("x".repeat(254))).toContain("过长");
  });

  test("renders the MAC in the standard colon-separated form, and leaves oddities alone", () => {
    expect(formatMacAddress("ccc4b277a772")).toBe("CC:C4:B2:77:A7:72");
    expect(formatMacAddress("CCC4B277A772")).toBe("CC:C4:B2:77:A7:72");
    // Anything the clock reports in another shape is shown verbatim rather than
    // padded or truncated into a plausible-looking address.
    expect(formatMacAddress("cc:c4:b2:77:a7:72")).toBe("cc:c4:b2:77:a7:72");
    expect(formatMacAddress("ccc4b277a7")).toBe("ccc4b277a7");
    expect(formatMacAddress("zzc4b277a772")).toBe("zzc4b277a772");
    expect(formatMacAddress("")).toBe("");
  });

  test("shows every field of the device information page", () => {
    const html = renderToStaticMarkup(createElement(DeviceHostPanel, hostPanelProps()));

    expect(html).toContain("设备信息");
    for (const [key, value] of Object.entries(FULL_INFO)) {
      if (key !== "mac") expect(html).toContain(value);
    }
    expect(html).toContain("CC:C4:B2:77:A7:72");
    expect(html).toContain("device-info-list");
    expect(html).toContain('value="192.168.8.240"');
    // The read-only rows must keep reusing the settings row markup, so the two
    // tabs cannot drift into two different type scales.
    expect(html).toContain('class="device-setting-field"');
    expect(html).toContain('class="device-setting-copy"');
    expect(html).toContain("device-setting-control device-info-value");
  });

  test("keeps the address form reachable when the clock cannot be read", () => {
    const html = renderToStaticMarkup(createElement(DeviceHostPanel, hostPanelProps({
      info: null,
      infoError: "clock request failed: timed out after 5000ms",
    })));

    expect(html).toContain('role="alert"');
    expect(html).toContain("无法读取设备信息");
    expect(html).toContain("timed out after 5000ms");
    // The recovery affordance must survive the failure that makes it necessary.
    expect(html).toContain("时钟地址");
    expect(html).toContain("保存并连接");
  });

  test("renders partial device information without collapsing into the error state", () => {
    const html = renderToStaticMarkup(createElement(DeviceHostPanel, hostPanelProps({
      info: { ip: "192.168.8.240" },
    })));

    expect(html).not.toContain("无法读取设备信息");
    expect(html).toContain("192.168.8.240");
    expect(html).toContain("—");
  });

  test("offers to restore the installed address only when an override is active", () => {
    const plain = renderToStaticMarkup(createElement(DeviceHostPanel, hostPanelProps()));
    expect(plain).not.toContain("恢复安装时地址");

    const overridden = renderToStaticMarkup(createElement(DeviceHostPanel, hostPanelProps({
      host: { host: "192.168.8.9", envHost: "192.168.8.240", source: "override" as const },
      hostDraft: "192.168.8.9",
    })));
    expect(overridden).toContain("恢复安装时地址");
    expect(overridden).toContain("192.168.8.240");
  });

  // 开始配网 has to ask the clock BEFORE it opens the chooser, and it must open
  // the chooser even when the ask fails. cladd's Dialog portals and server-
  // renders to nothing, so the handler cannot be clicked from here; the source
  // is the seam, the same one zos-panel.test.ts uses for the install button.
  test("开始配网 asks the clock to open Bluetooth first, and opens the wizard regardless", async () => {
    const source = await Bun.file(
      new URL("../web/src/components/studio/device-settings-dialog.tsx", import.meta.url),
    ).text();

    const start = source.indexOf("const openProvision = async () => {");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\n  };", start));

    // The whole point: an ONLINE clock advertises nothing, so a wizard that only
    // scanned found an empty chooser on exactly the device the user was trying
    // to move to another router.
    expect(body).toContain("link.requestBleOpen()");
    // A failed ask is reported, never thrown at the user as a dead button.
    expect(body).toContain("} catch (error) {");

    // LAST STATEMENT, outside every branch. A clock that is offline is already
    // advertising, so the old path still works and the wizard must open whether
    // the request reached the clock, failed, or was never sent at all.
    const statements = body.trimEnd().split("\n");
    expect(statements[statements.length - 1]!.trim()).toBe("setProvisionOpen(true);");
    // And it opens in exactly one place, so no branch can quietly skip it.
    expect(source.split("setProvisionOpen(true)").length - 1).toBe(1);
  });
});
