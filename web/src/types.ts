export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ContentItemConfig {
  id: string;
  contentId: string;
  durationMs: number;
  options: Record<string, JsonValue>;
}

export interface ChannelConfig {
  id: string;
  name: string;
  appName: string;
  enabled: boolean;
  refreshIntervalMs: number;
  items: ContentItemConfig[];
}

export interface WorkspaceSettings {
  version: 3;
  channels: ChannelConfig[];
}

export type ContentCategory = "market" | "tools" | "visual" | "creative";
export type ContentOptionType = "text" | "number" | "boolean" | "color" | "select" | "hidden";

export interface ContentOptionChoice {
  value: string;
  label: string;
}

export interface ContentOptionField {
  key: string;
  label: string;
  type: ContentOptionType;
  default: JsonValue;
  minimum?: number;
  maximum?: number;
  step?: number;
  choices?: ContentOptionChoice[];
  help?: string;
}

export interface ContentCatalogEntry {
  id: string;
  title: string;
  category: ContentCategory;
  description: string;
  defaultDurationMs: number;
  preferredRefreshIntervalMs: number;
  availableInMarket?: boolean;
  options: ContentOptionField[];
  defaultOptions: Record<string, JsonValue>;
}

export interface ContentCategoryEntry {
  id: ContentCategory;
  label: string;
}

export interface RuntimeState {
  healthy?: boolean;
  degraded?: boolean;
  deviceReachable?: boolean;
  pushing?: boolean;
  channels?: ChannelRuntimeState[];
  [key: string]: unknown;
}

export interface ChannelRuntimeState {
  id: string;
  appName: string;
  healthy: boolean;
  degraded: boolean;
  pushing: boolean;
  lastPushAt?: string;
  contentErrors: Record<string, string>;
  updateCount: number;
}

export type DeviceBrightnessLevel = "low" | "mid" | "high";
export type DeviceCarouselSpeed = 0 | 10 | 20 | 30 | 40 | 50 | 60;
export type DeviceTimezone =
  | "UTC-12" | "UTC-11" | "UTC-10" | "UTC-9" | "UTC-8" | "UTC-7"
  | "UTC-6" | "UTC-5" | "UTC-4" | "UTC-3" | "UTC-2" | "UTC-1"
  | "UTC+0" | "UTC+1" | "UTC+2" | "UTC+3" | "UTC+4" | "UTC+5"
  | "UTC+6" | "UTC+7" | "UTC+8" | "UTC+9" | "UTC+10" | "UTC+11"
  | "UTC+12";

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
  dateFormat: "MM/DD" | "DD/MM";
  showWeek: boolean;
  weekStart: 0 | 1;
  lowBatteryAutoSleep: boolean;
}

export interface ControlAccessInfo {
  port: number;
  address: string | null;
  url: string | null;
  suggestedUrl: string | null;
  lanEnabled: boolean;
  sameSubnetAsClock: boolean;
}

export type StudioView = "console" | "canvas" | "library";
export type PreviewScope = "item" | "channel";
export type BusyAction = "preview" | "push" | null;
