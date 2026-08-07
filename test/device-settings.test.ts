import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DEVICE_GENERAL_SETTINGS,
  normalizeDeviceGeneralSettings,
  validateDeviceGeneralSettings,
} from "../src/device-settings.ts";

describe("device general settings", () => {
  test("normalizes the official weekday aliases and fills absent public fields", () => {
    expect(normalizeDeviceGeneralSettings({ weekStart: "Sun" })).toEqual({
      ...DEFAULT_DEVICE_GENERAL_SETTINGS,
      brightness: { ...DEFAULT_DEVICE_GENERAL_SETTINGS.brightness },
      weekStart: 0,
    });
    expect(normalizeDeviceGeneralSettings({ weekStart: "Mon" }).weekStart).toBe(1);
  });

  test("accepts every supported setting at its boundary", () => {
    expect(validateDeviceGeneralSettings({
      brightness: { level: "low", low: 5, mid: 5, high: 100 },
      volume: 0,
      carouselSpeed: 0,
      scrollSpeed: 10,
      timezone: "UTC-12",
      dateFormat: "DD/MM",
      showWeek: false,
      weekStart: 0,
      lowBatteryAutoSleep: true,
    })).toMatchObject({
      brightness: { level: "low", low: 5, mid: 5, high: 100 },
      carouselSpeed: 0,
      timezone: "UTC-12",
    });
  });

  test("rejects unordered brightness values and unsupported enums", () => {
    expect(() => validateDeviceGeneralSettings({
      ...DEFAULT_DEVICE_GENERAL_SETTINGS,
      brightness: { level: "mid", low: 90, mid: 80, high: 100 },
    })).toThrow("低档 ≤ 中档 ≤ 高档");
    expect(() => validateDeviceGeneralSettings({
      ...DEFAULT_DEVICE_GENERAL_SETTINGS,
      timezone: "UTC+13",
    })).toThrow("时区无效");
  });
});
