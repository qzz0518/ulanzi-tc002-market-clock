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

export type MarketInstrumentKind = "crypto" | "fx" | "metal" | "stock";

export interface MarketInstrument {
  version: 1;
  ref: string;
  iconRef: string;
  iconUrl: string;
  iconMode: "fallback" | "catalog" | null;
  canonicalKey: string;
  kind: MarketInstrumentKind;
  displayName: string;
  displaySymbol: string;
  baseCode: string;
  quoteCode: string;
  decimals: number;
  changePeriod?: "24H" | "1D";
  sourceNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketSearchCandidate {
  candidateRef: string;
  canonicalKey: string;
  kind: MarketInstrumentKind;
  displayName: string;
  displaySymbol: string;
  baseCode: string;
  quoteCode: string;
  pair: string;
  sourceLabel: string;
  sourceNote: string;
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

// Mirrors ClockDeviceInfo in src/clock-client.ts — the six rows the clock's own
// 设备信息 page shows. Every field is optional: a partial /getBase still renders.
export interface DeviceInfo {
  serialNumber?: string;
  ssid?: string;
  ip?: string;
  mac?: string;
  mcuVersion?: string;
  appVersion?: string;
}

export interface DeviceHostStatus {
  host: string;
  envHost: string;
  source: "env" | "override";
}

export interface DeviceHostProbe {
  ok: boolean;
  info?: DeviceInfo;
  error?: string;
}

export interface ControlAccessInfo {
  port: number;
  address: string | null;
  url: string | null;
  suggestedUrl: string | null;
  lanEnabled: boolean;
  sameSubnetAsClock: boolean;
}

export type MusicProviderId = "netease" | "spotify";
export type MusicPlaybackMode = "device-audio" | "remote";

export interface MusicProfile {
  provider: MusicProviderId;
  id: string;
  nickname: string;
  avatarUrl?: string;
  plan?: string;
}

export interface MusicSessionStatus {
  loggedIn: boolean;
  profile?: MusicProfile;
}

export interface MusicProviderSummary {
  id: MusicProviderId;
  label: string;
  playbackMode: MusicPlaybackMode;
  loggedIn: boolean;
  profile?: MusicProfile;
  ready: boolean;
}

export interface MusicOverview {
  active: MusicProviderId;
  providers: MusicProviderSummary[];
}

export interface SpotifyAppStatus {
  configured: boolean;
  clientId: string | null;
  redirectUri: string;
}

export interface MusicRemoteDevice {
  id: string;
  name: string;
  type: string;
  active: boolean;
  volumePercent?: number;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  trackCount: number;
  coverUrl?: string;
}

export interface MusicTrack {
  id: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  coverUrl?: string;
}

// Mirrors src/music/core.ts. `/api/music/tracks/:id` serializes the provider's
// lines wholesale, so the two shapes have to agree field for field.
export interface MusicLyricWord {
  startMs: number;
  endMs: number;
  text: string;
}

export type LyricEndSource = "words" | "marker" | "estimate" | "next";

export interface MusicLyricLine {
  startMs: number;
  /** When the line stopped being SUNG — not when the next one starts. */
  endMs: number;
  text: string;
  translation?: string;
  /** Present only when the source really carries word timings (NetEase yrc). */
  words?: MusicLyricWord[];
  /** How endMs was decided; drives the 逐字 / 估算 badge. */
  endSource: LyricEndSource;
}

export interface MusicTrackDetail {
  track: MusicTrack;
  lyrics: MusicLyricLine[];
}

export interface MusicDeviceAppStatus {
  artifact: {
    state: "missing" | "invalid" | "ready";
    appId: string;
    version?: string;
    entry?: string;
    bundleId?: string;
    fileCount?: number;
    bytes?: number;
    message: string;
  };
  adb: "missing" | "ready";
  busy: boolean;
  session: { active: boolean; version?: string; startedAt?: string };
  restore: { title: string; steps: string[] };
}

export interface MusicDeviceProbe {
  adb: "missing" | "ready";
  connected: boolean;
  model?: string;
  platform?: string;
  appVersion?: string;
  mcuVersion?: string;
  playerRunning?: boolean;
  message: string;
}

// GET /api/arcade/status —— 游戏固件的在线快照（心跳记忆 + 会话状态）。
export interface ArcadeStatus {
  online: boolean;
  ageMs: number;
  game: string;
  phase: string;
  score: number;
}

// 哪种侧载固件正在直连；两种固件互斥，最多一种在线。
export type FirmwareKind = "music" | "arcade";

// 时钟此刻在跑哪套固件。判定规则与文案都在 lib/firmware-mode.ts —— 那里是唯一
// 真源，这里只是转出类型，好让习惯从 @/types 取类型的组件拿到同一个定义。
export type { FirmwareMode } from "@/lib/firmware-mode";

export type StudioView = "console" | "canvas" | "library" | "music" | "game" | "zos";
export type PreviewScope = "item" | "channel";
export type BusyAction = "preview" | "push" | null;
