export const DEVICE_BRIGHTNESS_LEVELS = ["low", "mid", "high"] as const;
export const DEVICE_CAROUSEL_SPEEDS = [0, 10, 20, 30, 40, 50, 60] as const;
export const DEVICE_DATE_FORMATS = ["MM/DD", "DD/MM"] as const;
export const DEVICE_TIMEZONES = [
  "UTC-12", "UTC-11", "UTC-10", "UTC-9", "UTC-8", "UTC-7", "UTC-6",
  "UTC-5", "UTC-4", "UTC-3", "UTC-2", "UTC-1", "UTC+0", "UTC+1",
  "UTC+2", "UTC+3", "UTC+4", "UTC+5", "UTC+6", "UTC+7", "UTC+8",
  "UTC+9", "UTC+10", "UTC+11", "UTC+12",
] as const;

export type DeviceBrightnessLevel = typeof DEVICE_BRIGHTNESS_LEVELS[number];
export type DeviceCarouselSpeed = typeof DEVICE_CAROUSEL_SPEEDS[number];
export type DeviceDateFormat = typeof DEVICE_DATE_FORMATS[number];
export type DeviceTimezone = typeof DEVICE_TIMEZONES[number];

export interface DeviceGeneralSettings {
  brightness: {
    level: DeviceBrightnessLevel;
    low: number;
    mid: number;
    high: number;
  };
  volume: number;
  carouselSpeed: DeviceCarouselSpeed;
  scrollSpeed: number;
  timezone: DeviceTimezone;
  dateFormat: DeviceDateFormat;
  showWeek: boolean;
  weekStart: 0 | 1;
  lowBatteryAutoSleep: boolean;
}

export const DEFAULT_DEVICE_GENERAL_SETTINGS: DeviceGeneralSettings = {
  brightness: { level: "mid", low: 50, mid: 80, high: 100 },
  volume: 3,
  carouselSpeed: 60,
  scrollSpeed: 7,
  timezone: "UTC+8",
  dateFormat: "MM/DD",
  showWeek: true,
  weekStart: 1,
  lowBatteryAutoSleep: false,
};

export class DeviceSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceSettingsValidationError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceSettingsValidationError(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new DeviceSettingsValidationError(`${label}必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return Number(value);
}

function oneOf<T extends readonly unknown[]>(value: unknown, values: T, label: string): T[number] {
  if (!values.includes(value)) {
    throw new DeviceSettingsValidationError(`${label}无效`);
  }
  return value as T[number];
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new DeviceSettingsValidationError(`${label}必须为开或关`);
  }
  return value;
}

export function validateDeviceGeneralSettings(value: unknown): DeviceGeneralSettings {
  const input = record(value, "常规设置");
  const brightness = record(input.brightness, "亮度设置");
  const low = integer(brightness.low, "低档亮度", 5, 100);
  const mid = integer(brightness.mid, "中档亮度", 5, 100);
  const high = integer(brightness.high, "高档亮度", 5, 100);
  if (low > mid || mid > high) {
    throw new DeviceSettingsValidationError("亮度必须满足低档 ≤ 中档 ≤ 高档");
  }

  return {
    brightness: {
      level: oneOf(brightness.level, DEVICE_BRIGHTNESS_LEVELS, "屏幕亮度档位"),
      low,
      mid,
      high,
    },
    volume: integer(input.volume, "音量", 0, 6),
    carouselSpeed: oneOf(input.carouselSpeed, DEVICE_CAROUSEL_SPEEDS, "自动翻页速度"),
    scrollSpeed: integer(input.scrollSpeed, "滚动速度", 0, 10),
    timezone: oneOf(input.timezone, DEVICE_TIMEZONES, "时区"),
    dateFormat: oneOf(input.dateFormat, DEVICE_DATE_FORMATS, "日期格式"),
    showWeek: booleanValue(input.showWeek, "显示星期"),
    weekStart: oneOf(input.weekStart, [0, 1] as const, "一周第一天"),
    lowBatteryAutoSleep: booleanValue(input.lowBatteryAutoSleep, "低电量自动休眠"),
  };
}

export function normalizeDeviceGeneralSettings(value: unknown): DeviceGeneralSettings {
  const input = record(value, "设备配置");
  const brightness = input.brightness === undefined
    ? {}
    : record(input.brightness, "亮度设置");
  let weekStart = input.weekStart ?? DEFAULT_DEVICE_GENERAL_SETTINGS.weekStart;
  if (weekStart === "Sun") weekStart = 0;
  if (weekStart === "Mon") weekStart = 1;

  return validateDeviceGeneralSettings({
    brightness: {
      level: brightness.level ?? DEFAULT_DEVICE_GENERAL_SETTINGS.brightness.level,
      low: brightness.low ?? DEFAULT_DEVICE_GENERAL_SETTINGS.brightness.low,
      mid: brightness.mid ?? DEFAULT_DEVICE_GENERAL_SETTINGS.brightness.mid,
      high: brightness.high ?? DEFAULT_DEVICE_GENERAL_SETTINGS.brightness.high,
    },
    volume: input.volume ?? DEFAULT_DEVICE_GENERAL_SETTINGS.volume,
    carouselSpeed: input.carouselSpeed ?? DEFAULT_DEVICE_GENERAL_SETTINGS.carouselSpeed,
    scrollSpeed: input.scrollSpeed ?? DEFAULT_DEVICE_GENERAL_SETTINGS.scrollSpeed,
    timezone: input.timezone ?? DEFAULT_DEVICE_GENERAL_SETTINGS.timezone,
    dateFormat: input.dateFormat ?? DEFAULT_DEVICE_GENERAL_SETTINGS.dateFormat,
    showWeek: input.showWeek ?? DEFAULT_DEVICE_GENERAL_SETTINGS.showWeek,
    weekStart,
    lowBatteryAutoSleep:
      input.lowBatteryAutoSleep ?? DEFAULT_DEVICE_GENERAL_SETTINGS.lowBatteryAutoSleep,
  });
}
