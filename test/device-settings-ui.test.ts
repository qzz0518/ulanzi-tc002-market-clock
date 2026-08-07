import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceSettingSwitch } from "../web/src/components/studio/device-settings-dialog";

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
});
