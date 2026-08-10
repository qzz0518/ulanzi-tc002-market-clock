import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceStore,
  createDefaultWorkspace,
  legacySettingsFromWorkspace,
  migrateDashboardSettings,
  validateWorkspace,
} from "../src/workspace.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("versioned content workspace", () => {
  test("represents both a standalone item and a combined carousel with channels", () => {
    const workspace = createDefaultWorkspace("market_mix");
    expect(workspace).toMatchObject({
      version: 3,
      channels: [{ appName: "market_mix", items: [{ contentId: "market:btc" }] }],
    });
    const combined = validateWorkspace({
      ...workspace,
      channels: [{
        ...workspace.channels[0],
        items: [
          workspace.channels[0]!.items[0],
          { id: "notice", contentId: "tools:notice", durationMs: 5_000, options: {} },
        ],
      }],
    });
    expect(combined.channels[0]?.items).toHaveLength(2);
  });

  test("migrates the legacy asset carousel and preserves its timing", () => {
    const legacy = {
      ...DEFAULT_SETTINGS,
      assets: ["btc", "gold", "aapl"] as ("btc" | "gold" | "aapl")[],
      priceDurationMs: 10_000,
      changeDurationMs: 2_000,
      refreshIntervalMs: 20_000,
    };
    const workspace = migrateDashboardSettings(legacy, "markets");
    expect(workspace.channels[0]?.items.map((item) => item.contentId)).toEqual([
      "market:btc", "market:gold", "market:aapl",
    ]);
    expect(workspace.channels[0]?.items.map((item) => item.durationMs)).toEqual([
      12_000, 10_000, 12_000,
    ]);
    expect(workspace.channels[0]?.refreshIntervalMs).toBe(20_000);
    expect(legacySettingsFromWorkspace(workspace).assets).toEqual(["btc", "gold", "aapl"]);
  });

  test("rejects duplicate knob app names and oversized channel definitions", () => {
    const channel = createDefaultWorkspace("same").channels[0]!;
    expect(() => validateWorkspace({ version: 3, channels: [channel, { ...channel, id: "two" }] }))
      .toThrow("appName values must be unique");
    expect(() => validateWorkspace({
      version: 3,
      channels: [{ ...channel, items: [] }],
    })).toThrow("at least one item");
  });

  test("reserves notification, music mirror, and live app names", () => {
    const channel = createDefaultWorkspace("market").channels[0]!;
    for (const appName of ["notify", "music_lyrics", "live_game"]) {
      expect(() => validateWorkspace({
        version: 3,
        channels: [{ ...channel, appName }],
      })).toThrow("reserved for a system channel");
    }
    expect(validateWorkspace({
      version: 3,
      channels: [{ ...channel, appName: "lively" }],
    }).channels[0]?.appName).toBe("lively");
  });

  test("atomically upgrades the old settings file on first load", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-workspace-"));
    directories.push(directory);
    const legacyPath = join(directory, "settings.json");
    const workspacePath = join(directory, "workspace.json");
    await Bun.write(legacyPath, JSON.stringify({ ...DEFAULT_SETTINGS, assets: ["eth", "aapl"] }));
    const store = new WorkspaceStore(workspacePath, legacyPath, "markets");
    const workspace = await store.load();
    expect(workspace.channels[0]?.items.map((item) => item.contentId)).toEqual([
      "market:eth", "market:aapl",
    ]);
    expect(JSON.parse(await readFile(workspacePath, "utf8")).version).toBe(3);
  });
});
