import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import {
  WorkspaceEditor,
  placeSelectionPatches,
} from "../web/src/components/studio/workspace-editor";
import { getContentCatalog } from "../src/content-registry.ts";
import type { ChannelConfig } from "../src/workspace.ts";

function weatherChannel(): ChannelConfig {
  return {
    id: "ch_weather",
    name: "天气",
    appName: "weather",
    enabled: true,
    refreshIntervalMs: 600_000,
    items: [{
      id: "item_weather",
      contentId: "visual:weather",
      durationMs: 10_000,
      options: { place: "", latitude: "31.2304", longitude: "121.4737", speed: "1" },
    }],
  };
}

function editorMarkup(channel: ChannelConfig): string {
  const noop = () => {};
  return renderToStaticMarkup(createElement(
    CladdProvider,
    null,
    createElement(WorkspaceEditor, {
      channel: channel as never,
      selectedItemId: channel.items[0]!.id,
      catalog: getContentCatalog() as never,
      instruments: [],
      previewUrl: null,
      previewing: false,
      previewError: null,
      previewFrameCount: null,
      previewScope: "item",
      busy: null,
      dirty: false,
      saving: false,
      lastSavedAt: null,
      deviceOutOfDate: false,
      onChannelChange: noop,
      onSelectItem: noop,
      onPreviewScopeChange: noop,
      onDurationChange: noop,
      onOptionChange: noop,
      onMoveItem: noop,
      onReorderItem: noop,
      onRemoveItem: noop,
      onTimerStart: noop,
      onTimerPause: noop,
      onOpenCatalog: noop,
      onPush: noop,
    }),
  ));
}

describe("place search option UI", () => {
  test("one picked candidate fills the place text plus both hidden coordinates", () => {
    expect(placeSelectionPatches({
      name: "Shanghai",
      admin1: "Shanghai",
      country: "China",
      latitude: 31.2222,
      longitude: 121.4581,
    })).toEqual([
      ["place", "Shanghai, China"],
      ["latitude", "31.2222"],
      ["longitude", "121.4581"],
    ]);
    // Entries without a country name still produce a clean display string.
    expect(placeSelectionPatches({
      name: "Shanghai Reef",
      country: "",
      latitude: 9.9,
      longitude: 114.1,
    })[0]).toEqual(["place", "Shanghai Reef"]);
  });

  test("renders the weather item's place field as a search box and hides the coordinates", () => {
    const html = editorMarkup(weatherChannel());
    expect(html).toContain("地点");
    expect(html).toContain("在下方搜索地点后自动填入");
    expect(html).toContain("输入城市或地点，如 Shanghai");
    expect(html).toContain("place-search");
    // The coordinate pair is hidden plumbing now; no editable fields remain.
    expect(html).not.toContain("纬度");
    expect(html).not.toContain("经度");
    expect(html).not.toContain("31.2304");
  });
});
