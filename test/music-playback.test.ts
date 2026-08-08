import { describe, expect, test } from "bun:test";
import { clampPlaybackPositionMs } from "../web/src/lib/music-playback";

describe("music playback position", () => {
  test("keeps a valid requested position", () => {
    expect(clampPlaybackPositionMs(61_250, 240_000)).toBe(61_250);
  });

  test("clamps positions to the media duration", () => {
    expect(clampPlaybackPositionMs(241_000, 240_000)).toBe(240_000);
    expect(clampPlaybackPositionMs(-100, 240_000)).toBe(0);
  });

  test("preserves a pending seek before metadata has loaded", () => {
    expect(clampPlaybackPositionMs(42_125, Number.NaN)).toBe(42_125);
    expect(clampPlaybackPositionMs(Number.NaN, Number.NaN)).toBe(0);
  });
});
