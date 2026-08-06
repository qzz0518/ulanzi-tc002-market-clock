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

export type StudioView = "console" | "canvas" | "library";
export type PreviewScope = "item" | "channel";
export type BusyAction = "preview" | "push" | null;
