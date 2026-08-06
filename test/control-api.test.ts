import { describe, expect, test } from "bun:test";
import { createControlHandler } from "../src/control-api.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { DashboardController } from "../src/controller.ts";
import { renderOfflineDashboard } from "../src/pixel-ui.ts";

function fakeController(): DashboardController {
  let settings = structuredClone(DEFAULT_SETTINGS);
  return {
    getSettings: () => structuredClone(settings),
    saveSettings: async (value: unknown) => {
      settings = value as typeof settings;
      return structuredClone(settings);
    },
    getState: () => ({
      service: "ulanzi-tc002-market-clock",
      healthy: true,
      settings,
    }),
    preview: async () => renderOfflineDashboard(),
    pushNow: async () => ({ healthy: true }),
  } as unknown as DashboardController;
}

describe("local control API", () => {
  test("serves the GUI, official clock frame, six presets, and pixel icons", async () => {
    const handler = createControlHandler(fakeController());
    const page = await handler(new Request("http://127.0.0.1:43820/"));
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Pixel Market");
    expect(pageHtml).toContain("设置格式无效");
    expect(pageHtml).not.toContain(".button.preview { display: none; }");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");

    const frame = await handler(new Request("http://127.0.0.1:43820/assets/tc002-frame.png"));
    expect(frame.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await frame.arrayBuffer()).subarray(0, 4)).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );

    const presets = await handler(new Request("http://127.0.0.1:43820/api/presets"));
    const presetBody = await presets.json() as {
      presets: Array<{ id: string; iconUrl: string }>;
    };
    expect(presetBody.presets).toHaveLength(6);
    const ethPreset = presetBody.presets.find((preset) => preset.id === "eth");
    expect(ethPreset?.iconUrl).toMatch(/^\/api\/icons\/eth\.png\?v=[a-f0-9]{12}$/);

    const icon = await handler(new Request(new URL(ethPreset!.iconUrl, "http://127.0.0.1:43820")));
    expect(icon.headers.get("Content-Type")).toBe("image/png");
    expect(icon.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await icon.arrayBuffer()).subarray(0, 4)).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });

  test("persists same-origin JSON settings and rejects cross-origin writes", async () => {
    const handler = createControlHandler(fakeController());
    const body = JSON.stringify({ ...DEFAULT_SETTINGS, assets: ["eth", "sol"] });
    const saved = await handler(
      new Request("http://127.0.0.1:43820/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
        body,
      }),
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings.assets).toEqual(["eth", "sol"]);

    const rejected = await handler(
      new Request("http://127.0.0.1:43820/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: "https://example.com" },
        body,
      }),
    );
    expect(rejected.status).toBe(400);
  });

  test("returns preview bytes and supports direct push", async () => {
    const handler = createControlHandler(fakeController());
    const preview = await handler(
      new Request("http://127.0.0.1:43820/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(DEFAULT_SETTINGS),
      }),
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Content-Type")).toBe("image/png");

    const pushed = await handler(
      new Request("http://127.0.0.1:43820/api/push", { method: "POST" }),
    );
    expect(pushed.status).toBe(200);
  });
});
