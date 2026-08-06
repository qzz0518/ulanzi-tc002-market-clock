import { describe, expect, test } from "bun:test";
import {
  channelForPreview,
  deviceIsBehind,
  relativeTimestamp,
} from "../web/src/lib/studio-state.ts";
import type { ChannelConfig } from "../web/src/types.ts";

const channel: ChannelConfig = {
  id: "market",
  name: "市场轮播",
  appName: "btc",
  enabled: true,
  refreshIntervalMs: 15_000,
  items: [
    { id: "btc", contentId: "market:btc", durationMs: 15_000, options: {} },
    { id: "eth", contentId: "market:eth", durationMs: 15_000, options: {} },
  ],
};

describe("studio state helpers", () => {
  test("locks item preview to the item currently being edited", () => {
    expect(channelForPreview(channel, "eth", "item").items.map((item) => item.id)).toEqual(["eth"]);
    expect(channelForPreview(channel, "eth", "channel")).toBe(channel);
  });

  test("distinguishes saved edits from the version currently on the device", () => {
    const editedAt = Date.parse("2026-08-07T01:00:00Z");
    expect(deviceIsBehind("2026-08-07T00:59:00Z", editedAt)).toBe(true);
    expect(deviceIsBehind("2026-08-07T01:01:00Z", editedAt)).toBe(false);
    expect(deviceIsBehind(undefined, undefined)).toBe(false);
  });

  test("formats compact relative timestamps for operation status", () => {
    const now = Date.parse("2026-08-07T01:00:00Z");
    expect(relativeTimestamp(now - 4_000, now)).toBe("刚刚");
    expect(relativeTimestamp(now - 125_000, now)).toBe("2 分钟前");
  });
});
