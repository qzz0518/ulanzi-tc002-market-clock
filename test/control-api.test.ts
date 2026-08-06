import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlHandler } from "../src/control-api.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { DashboardController } from "../src/controller.ts";
import { renderOfflineDashboard } from "../src/pixel-ui.ts";
import { createDefaultWorkspace } from "../src/workspace.ts";
import type { WorkspaceController } from "../src/workspace-controller.ts";
import { PixelAssetStore } from "../src/pixel-asset-store.ts";
import { PixelCanvas } from "../src/pixel-ui.ts";
import type { UlanziPixelAssetClient } from "../src/ulanzi-pixel-assets.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

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

function fakeWorkspaceController(previewCalls?: boolean[]): WorkspaceController {
  let workspace = createDefaultWorkspace("markets");
  return {
    getWorkspace: () => structuredClone(workspace),
    saveWorkspace: async (value: unknown) => {
      workspace = value as typeof workspace;
      return structuredClone(workspace);
    },
    getSettings: () => structuredClone(DEFAULT_SETTINGS),
    saveSettings: async () => structuredClone(DEFAULT_SETTINGS),
    getState: () => ({
      service: "ulanzi-tc002-content-hub",
      healthy: true,
      workspace,
      channels: [],
    }),
    preview: async () => renderOfflineDashboard(),
    previewChannel: async (_target: unknown, forceRefresh = false) => {
      previewCalls?.push(forceRefresh);
      return renderOfflineDashboard() as never;
    },
    pushAll: async () => ({ healthy: true }),
    pushChannel: async () => ({ healthy: true }),
  } as unknown as WorkspaceController;
}

describe("local control API", () => {
  test("serves the GUI, official clock frame, ten presets, and pixel icons", async () => {
    const handler = createControlHandler(fakeController());
    const page = await handler(new Request("http://127.0.0.1:43820/"));
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Pixel Market");
    expect(pageHtml).toContain('id="root"');
    expect(pageHtml).toContain('href="/assets/studio.css"');
    expect(pageHtml).toContain('src="/assets/studio.js"');
    expect(pageHtml).not.toContain("status-progress");
    expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(page.headers.get("Content-Security-Policy")).not.toContain("script-src 'unsafe-inline'");
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
    expect(presetBody.presets).toHaveLength(10);
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

  test("exposes the extensible catalog and versioned channel workspace", async () => {
    const previewCalls: boolean[] = [];
    const handler = createControlHandler(fakeWorkspaceController(previewCalls));
    const catalog = await handler(new Request("http://127.0.0.1:43820/api/catalog"));
    const catalogBody = await catalog.json();
    expect(catalogBody.contents).toHaveLength(23);
    expect(catalogBody.categories.map((category: { id: string }) => category.id)).toEqual([
      "market", "tools", "visual", "creative",
    ]);

    const current = await handler(new Request("http://127.0.0.1:43820/api/workspace"));
    const workspace = (await current.json()).workspace;
    workspace.channels[0].name = "组合轮播";
    const saved = await handler(new Request("http://127.0.0.1:43820/api/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify(workspace),
    }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).workspace.channels[0].name).toBe("组合轮播");

    const preview = await handler(new Request("http://127.0.0.1:43820/api/channels/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: workspace.channels[0].id, forceRefresh: true }),
    }));
    expect(preview.headers.get("X-Frame-Count")).toBe("1");
    expect(previewCalls).toEqual([true]);
  });

  test("imports official pixel assets through the same-origin library adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-control-assets-"));
    directories.push(directory);
    const png = new PixelCanvas(52, 16, [0, 255, 102]).toPng();
    const client = {
      async list() {
        return {
          count: 1,
          page: 1,
          limit: 12,
          items: [{
            id: "1091",
            title: "新天鹅堡",
            author: "Sakiko",
            description: "",
            classificationCode: 12,
            previewPath: "/cdn/uploadPath/upload/castle.png",
            detailUrl: "https://ugc.ulanzistudio.com/contentView/1091",
            createdAt: "2026-07-31 00:00:00",
            animatedPreview: false,
          }],
        };
      },
      async download() {
        return {
          officialId: "1091",
          title: "新天鹅堡",
          author: "Sakiko",
          sourceUrl: "https://ugc.ulanzistudio.com/contentView/1091",
          mimeType: "image/png" as const,
          bytes: png,
        };
      },
      async preview() {
        return { bytes: png, contentType: "image/png" };
      },
    } as unknown as UlanziPixelAssetClient;
    const store = new PixelAssetStore(directory);
    const handler = createControlHandler(fakeWorkspaceController(), {
      pixelAssetLibrary: { client, store },
    });

    const listed = await handler(new Request(
      "http://127.0.0.1:43820/api/library/ulanzi/pixel-assets?classificationId=13",
    ));
    expect(listed.status).toBe(200);
    expect((await listed.json()).items[0].previewUrl).toContain("/api/library/ulanzi/media?");

    const imported = await handler(new Request("http://127.0.0.1:43820/api/library/ulanzi/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:43820" },
      body: JSON.stringify({ source: "1091" }),
    }));
    expect(imported.status).toBe(200);
    const importedBody = await imported.json();
    expect(importedBody.asset).toMatchObject({ officialId: "1091", frameCount: 1 });
    const localMedia = await handler(new Request(
      `http://127.0.0.1:43820${importedBody.asset.previewUrl}`,
    ));
    expect(localMedia.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await localMedia.arrayBuffer()).subarray(0, 4)).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });
});
