import { ASSET_PRESETS, type AssetId } from "./assets.ts";
import {
  renderDashboard,
  renderRuntimeMarketDashboard,
  type PixelCanvas,
  type Rgb,
} from "./pixel-ui.ts";
import type { AssetMarketData } from "./price.ts";
import {
  renderCanvasContent,
  renderCountdown,
  renderNoticeBoard,
  renderPomodoro,
  renderTimerColumn,
} from "./tool-renderers.ts";
import {
  VISUAL_EFFECT_IDS,
  renderVisualEffect,
  type VisualEffectId,
} from "./visual-effects.ts";
import {
  WeatherNotConfiguredError,
  parseCoordinate,
  type WeatherObservation,
} from "./weather/client.ts";
import type { RenderedPixelAsset } from "./pixel-asset-store.ts";
import type { MarketInstrument } from "./market/instruments.ts";
import type { RuntimeMarketData } from "./market/quotes.ts";
import { createContentItem, type ContentItemConfig, type JsonValue } from "./workspace.ts";

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
  choices?: readonly ContentOptionChoice[];
  help?: string;
}

export interface ContentRenderResult {
  frames: PixelCanvas[];
  frameDelaysMs: number[];
  label: string;
  assetIds?: AssetId[];
  instrumentRefs?: string[];
}

export interface ContentRenderContext {
  nowMs: number;
  forceRefresh: boolean;
  getMarket(assetId: AssetId, forceRefresh: boolean): Promise<AssetMarketData>;
  getInstrumentMarket(
    instrumentRef: string,
    forceRefresh: boolean,
  ): Promise<{ instrument: MarketInstrument; market: RuntimeMarketData; icon: PixelCanvas }>;
  getPixelAsset(assetRef: string, durationMs: number): Promise<RenderedPixelAsset>;
  getWeather(
    latitude: number,
    longitude: number,
    forceRefresh: boolean,
  ): Promise<WeatherObservation>;
}

export interface ContentDefinition {
  id: string;
  title: string;
  category: ContentCategory;
  description: string;
  defaultDurationMs: number;
  preferredRefreshIntervalMs: number;
  availableInMarket?: boolean;
  options: readonly ContentOptionField[];
  render(
    context: ContentRenderContext,
    item: ContentItemConfig,
  ): Promise<ContentRenderResult> | ContentRenderResult;
}

export interface ContentCatalogEntry extends Omit<ContentDefinition, "render"> {
  defaultOptions: Record<string, JsonValue>;
}

function defaults(fields: readonly ContentOptionField[]): Record<string, JsonValue> {
  return Object.fromEntries(fields.map((field) => [field.key, structuredClone(field.default)]));
}

function valueNumber(
  value: JsonValue | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

const MARKET_OPTIONS: readonly ContentOptionField[] = [
  {
    key: "showChange",
    label: "显示涨跌",
    type: "boolean",
    default: true,
    help: "按数据源显示 24H（加密）或 1D（股票 / 汇率）涨跌。",
  },
  {
    key: "changeDurationMs",
    label: "涨跌帧时长",
    type: "number",
    default: 2_500,
    minimum: 500,
    maximum: 30_000,
    step: 100,
    help: "包含在单项停留时长内，不会额外增加频道总时长。",
  },
];

function accentFromIcon(icon: PixelCanvas): Rgb {
  let brightest: Rgb = [90, 155, 255];
  let score = 0;
  for (let y = 0; y < icon.height; y += 1) {
    for (let x = 0; x < icon.width; x += 1) {
      const color = icon.getPixel(x, y);
      const next = color[0] + color[1] + color[2];
      if (next > score) {
        score = next;
        brightest = color;
      }
    }
  }
  return brightest;
}

function marketDefinition(assetId: AssetId): ContentDefinition {
  const preset = ASSET_PRESETS.find((candidate) => candidate.id === assetId)!;
  return {
    id: `market:${assetId}`,
    title: `${preset.symbol} · ${preset.name}`,
    category: "market",
    description: `${preset.pair}。${preset.sourceNote}`,
    defaultDurationMs: preset.changePeriod ? 15_000 : 12_500,
    preferredRefreshIntervalMs: preset.kind === "stock" ? 60_000 : 15_000,
    options: MARKET_OPTIONS,
    async render(context, item) {
      const market = await context.getMarket(assetId, context.forceRefresh);
      const requestedChangeDuration = Math.round(
        valueNumber(item.options.changeDurationMs, 2_500, 500, 30_000) / 100,
      ) * 100;
      const showChange = item.options.showChange !== false
        && market.changePercent !== undefined
        && market.changePeriod !== undefined
        && item.durationMs >= 1_500;
      const changeDurationMs = showChange
        ? Math.min(requestedChangeDuration, item.durationMs - 1_000)
        : 500;
      const rendered = renderDashboard([market], {
        assets: [assetId],
        priceDurationMs: item.durationMs - (showChange ? changeDurationMs : 0),
        changeDurationMs,
        refreshIntervalMs: Math.max(10_000, item.durationMs),
        showChange,
      });
      return {
        frames: [...rendered.frames],
        frameDelaysMs: [...rendered.frameDelaysMs],
        label: rendered.label,
        assetIds: [assetId],
      };
    },
  };
}

const RUNTIME_MARKET_DEFINITION: ContentDefinition = {
  id: "market:instrument",
  title: "运行时资产",
  category: "market",
  description: "通过搜索添加的股票、数字货币、汇率或金属。",
  defaultDurationMs: 15_000,
  preferredRefreshIntervalMs: 15_000,
  availableInMarket: false,
  options: [
    { key: "instrumentRef", label: "资产引用", type: "hidden", default: "" },
    ...MARKET_OPTIONS,
  ],
  async render(context, item) {
    const instrumentRef = typeof item.options.instrumentRef === "string"
      ? item.options.instrumentRef
      : "";
    const { instrument, market, icon } = await context.getInstrumentMarket(
      instrumentRef,
      context.forceRefresh,
    );
    const requestedChangeDuration = Math.round(
      valueNumber(item.options.changeDurationMs, 2_500, 500, 30_000) / 100,
    ) * 100;
    const showChange = item.options.showChange !== false
      && market.changePercent !== undefined
      && market.changePeriod !== undefined
      && item.durationMs >= 1_500;
    const changeDurationMs = showChange
      ? Math.min(requestedChangeDuration, item.durationMs - 1_000)
      : 500;
    const rendered = renderRuntimeMarketDashboard(
      market,
      {
        symbol: instrument.displaySymbol,
        decimals: instrument.decimals,
        accent: accentFromIcon(icon),
        icon,
      },
      {
        priceDurationMs: item.durationMs - (showChange ? changeDurationMs : 0),
        changeDurationMs,
        showChange,
      },
    );
    return {
      frames: [...rendered.frames],
      frameDelaysMs: [...rendered.frameDelaysMs],
      label: rendered.label,
      instrumentRefs: [instrument.ref],
    };
  },
};

const VISUAL_NAMES: Readonly<Record<VisualEffectId, { title: string; description: string }>> = {
  ant: { title: "兰顿蚂蚁", description: "简单转向规则演化出的元胞自动机轨迹。" },
  aquarium: { title: "鱼缸", description: "小鱼、水草和气泡组成的陪伴型像素动画。" },
  fire: { title: "火焰", description: "经典 demoscene 热量扩散火焰。" },
  fireworks: { title: "烟花", description: "升空尾迹、随机色相爆散与重力衰减。" },
  flipclock: { title: "翻页钟", description: "深色卡片、闪烁冒号与翻页扫光。" },
  life: { title: "生命游戏", description: "环面边界的康威生命游戏，可用当前时间播种。" },
  matrixclock: { title: "数字雨时钟", description: "Matrix 代码雨上叠加当前时间。" },
  maze: { title: "走迷宫", description: "随机生成迷宫并演示最短路径。" },
  pet: { title: "像素宠物", description: "橘猫的待机、散步、奔跑与攻击动画。" },
  sand: { title: "落沙", description: "彩色沙粒受重力下落并逐渐堆积。" },
  starfield: { title: "星空穿梭", description: "星点从中心加速飞出的曲速效果。" },
  suncolor: { title: "日出日落色温钟", description: "按太阳高度角把整屏染成夜蓝、晨橙、日白或暮红。" },
  weather: { title: "天气粒子", description: "按 Open-Meteo 实况自动切换晴、云、雨、雪粒子。" },
};

const SPEED_OPTION: ContentOptionField = {
  key: "speed",
  label: "速度",
  type: "select",
  default: "1",
  choices: [
    { value: "0.5", label: "慢" },
    { value: "1", label: "标准" },
    { value: "1.5", label: "快" },
    { value: "2", label: "很快" },
  ],
};

// The place text is what the studio's geocode search fills in; the hidden
// coordinate pair keeps its old keys so existing workspaces stay valid and the
// renderers keep reading latitude/longitude exactly as before.
const LOCATION_OPTIONS: readonly ContentOptionField[] = [
  {
    key: "place",
    label: "地点",
    type: "text",
    default: "",
    help: "在下方搜索地点后自动填入。",
  },
  { key: "latitude", label: "纬度", type: "hidden", default: "31.2304" },
  { key: "longitude", label: "经度", type: "hidden", default: "121.4737" },
];

// The flip clock, matrix clock and sun-colour clock all re-render on the wall
// clock rather than on an animation seed, so they refresh on the same cadence.
const TIME_DRIVEN_VISUALS: readonly VisualEffectId[] = ["flipclock", "matrixclock", "suncolor"];

function visualOptionFields(effectId: VisualEffectId): ContentOptionField[] {
  if (effectId === "flipclock" || effectId === "matrixclock") return [];
  if (effectId === "suncolor") return [...LOCATION_OPTIONS];
  const fields: ContentOptionField[] = [SPEED_OPTION];
  if (effectId === "pet") {
    fields.push({
      key: "petAction",
      label: "动作",
      type: "select",
      default: "random",
      choices: [
        { value: "random", label: "随机" },
        { value: "idle", label: "待机" },
        { value: "walk", label: "散步" },
        { value: "run", label: "奔跑" },
        { value: "attack", label: "攻击" },
      ],
    });
  }
  if (effectId === "life") {
    fields.push({
      key: "lifeStart",
      label: "开局",
      type: "select",
      default: "digits",
      choices: [
        { value: "digits", label: "当前时间" },
        { value: "soup", label: "随机汤" },
      ],
    });
  }
  if (effectId === "fireworks") {
    fields.push({
      key: "density",
      label: "密度",
      type: "select",
      default: "2",
      choices: [
        { value: "1", label: "稀疏" },
        { value: "2", label: "标准" },
        { value: "3", label: "密集" },
      ],
    });
  }
  return fields;
}

function visualDefinition(effectId: VisualEffectId): ContentDefinition {
  const details = VISUAL_NAMES[effectId];
  const timeDriven = TIME_DRIVEN_VISUALS.includes(effectId);
  return {
    id: `visual:${effectId}`,
    title: details.title,
    category: "visual",
    description: details.description,
    defaultDurationMs: 10_000,
    preferredRefreshIntervalMs: timeDriven ? 10_000 : 30_000,
    options: visualOptionFields(effectId),
    render(context, item) {
      const animation = renderVisualEffect(effectId, item.durationMs, context.nowMs, {
        speed: valueNumber(item.options.speed, 1, 0.5, 2),
        petAction: typeof item.options.petAction === "string"
          ? item.options.petAction as "idle" | "walk" | "run" | "attack" | "random"
          : undefined,
        lifeStart: item.options.lifeStart === "soup" ? "soup" : "digits",
        fireworkDensity: valueNumber(item.options.density, 2, 1, 3),
        latitude: valueNumber(item.options.latitude, 0, -90, 90),
        longitude: valueNumber(item.options.longitude, 0, -180, 180),
      });
      return animation;
    },
  };
}

const WEATHER_DEFINITION: ContentDefinition = {
  id: "visual:weather",
  title: VISUAL_NAMES.weather.title,
  category: "visual",
  description: VISUAL_NAMES.weather.description,
  defaultDurationMs: 10_000,
  // Open-Meteo publishes one current block per quarter hour; the client keeps
  // its own 10-minute floor, so the channel only has to stay in that ballpark.
  preferredRefreshIntervalMs: 600_000,
  options: [...LOCATION_OPTIONS, SPEED_OPTION],
  async render(context, item) {
    const speed = valueNumber(item.options.speed, 1, 0.5, 2);
    const notice = (weatherNotice: string) =>
      renderVisualEffect("weather", item.durationMs, context.nowMs, { speed, weatherNotice });
    let latitude: number;
    let longitude: number;
    try {
      latitude = parseCoordinate(item.options.latitude, 90, "latitude");
      longitude = parseCoordinate(item.options.longitude, 180, "longitude");
    } catch {
      return notice("坐标错误");
    }
    let weather: WeatherObservation;
    try {
      weather = await context.getWeather(latitude, longitude, context.forceRefresh);
    } catch (error) {
      // A missing client is a configuration state, not a failure: say so on the
      // panel. Anything else stays a channel error like every other data source.
      if (!(error instanceof WeatherNotConfiguredError)) throw error;
      return notice("未配置");
    }
    return renderVisualEffect("weather", item.durationMs, context.nowMs, {
      speed,
      weatherPlace: typeof item.options.place === "string" ? item.options.place : "",
      weather: {
        condition: weather.condition,
        temperatureC: weather.temperatureC,
        precipitationMm: weather.precipitationMm,
        cloudCoverPercent: weather.cloudCoverPercent,
      },
    });
  },
};

const NOTICE_DEFINITION: ContentDefinition = {
  id: "tools:notice",
  title: "通知板",
  category: "tools",
  description: "显示或滚动一条 ASCII 像素消息。",
  defaultDurationMs: 12_000,
  preferredRefreshIntervalMs: 300_000,
  options: [
    { key: "message", label: "消息", type: "text", default: "HELLO PIXEL" },
    { key: "color", label: "文字颜色", type: "color", default: "#00ff66" },
    { key: "background", label: "背景颜色", type: "color", default: "#000000" },
    { key: "scroll", label: "超宽时滚动", type: "boolean", default: true },
    { key: "fontScale", label: "字号", type: "select", default: "2", choices: [
      { value: "1", label: "5px" }, { value: "2", label: "10px" },
    ] },
    { key: "speed", label: "滚动速度", type: "number", default: 12, minimum: 4, maximum: 40, step: 1 },
  ],
  render(_context, item) {
    return renderNoticeBoard(item.durationMs, item.options);
  },
};

const TIMER_DEFINITION: ContentDefinition = {
  id: "tools:timer",
  title: "计时柱",
  category: "tools",
  description: "训练/间歇计时：下沉光柱、大号秒数和剩余组数。",
  defaultDurationMs: 15_000,
  preferredRefreshIntervalMs: 15_000,
  options: [
    { key: "workSeconds", label: "练习（秒）", type: "number", default: 30, minimum: 1, maximum: 3_600, step: 1 },
    { key: "restSeconds", label: "休息（秒）", type: "number", default: 15, minimum: 0, maximum: 3_600, step: 1 },
    { key: "rounds", label: "组数", type: "number", default: 8, minimum: 1, maximum: 99, step: 1 },
    { key: "orientation", label: "朝向", type: "select", default: "pv", choices: [
      { value: "pv", label: "竖装" }, { value: "pv2", label: "竖装（翻转）" }, { value: "land", label: "横装" },
    ] },
    { key: "digits", label: "数字", type: "select", default: "v", choices: [
      { value: "v", label: "竖排（大）" }, { value: "h", label: "横排" }, { value: "none", label: "不显示" },
    ] },
    { key: "running", label: "运行中", type: "boolean", default: false },
    { key: "startedAtMs", label: "开始时间", type: "hidden", default: 0 },
  ],
  render(context, item) {
    return renderTimerColumn(item.durationMs, item.options, context.nowMs);
  },
};

const POMODORO_DEFINITION: ContentDefinition = {
  id: "tools:pomodoro",
  title: "番茄钟",
  category: "tools",
  description: "工作与休息交替的番茄钟：番茄图标、剩余时间大数字与底部进度条，切换相位时全屏闪烁。",
  defaultDurationMs: 15_000,
  preferredRefreshIntervalMs: 15_000,
  options: [
    { key: "workMinutes", label: "工作（分钟）", type: "number", default: 25, minimum: 1, maximum: 180, step: 1 },
    { key: "breakMinutes", label: "休息（分钟）", type: "number", default: 5, minimum: 0, maximum: 60, step: 1 },
    { key: "workColor", label: "工作颜色", type: "color", default: "#ff4830" },
    { key: "breakColor", label: "休息颜色", type: "color", default: "#00d67a" },
    { key: "digitColor", label: "数字颜色", type: "color", default: "#ffffff" },
    { key: "running", label: "运行中", type: "boolean", default: false },
    { key: "startedAtMs", label: "开始时间", type: "hidden", default: 0 },
  ],
  render(context, item) {
    return renderPomodoro(item.durationMs, item.options, context.nowMs);
  },
};

const COUNTDOWN_DEFINITION: ContentDefinition = {
  id: "tools:countdown",
  title: "倒数日",
  category: "tools",
  description: "距离目标日期还有多少天；标题支持中文，当天播放全屏庆祝动画。",
  defaultDurationMs: 12_000,
  preferredRefreshIntervalMs: 600_000,
  options: [
    { key: "title", label: "标题", type: "text", default: "倒数日", help: "支持中文，最多 16 个字符。" },
    { key: "targetDate", label: "目标日期", type: "text", default: "2027-01-01", help: "格式 YYYY-MM-DD，按本地时区计算天数。" },
    { key: "accentColor", label: "主题色", type: "color", default: "#00e5ff", help: "天数与「天」的颜色；已过期的日子固定用暖橙。" },
  ],
  render(context, item) {
    return renderCountdown(item.durationMs, item.options, context.nowMs);
  },
};

const CANVAS_DEFINITION: ContentDefinition = {
  id: "creative:canvas",
  title: "画板",
  category: "creative",
  description: "可保存到频道的 52×16 像素画布。",
  defaultDurationMs: 15_000,
  preferredRefreshIntervalMs: 900_000,
  options: [{
    key: "pixels",
    label: "像素",
    type: "hidden",
    default: Array(52 * 16).fill(0),
  }],
  render(_context, item) {
    return renderCanvasContent(item.durationMs, item.options);
  },
};

const PIXEL_ASSET_DEFINITION: ContentDefinition = {
  id: "creative:pixel-asset",
  title: "像素素材",
  category: "creative",
  description: "从 Ulanzi 官方社区按需导入的静态或动画像素素材。",
  defaultDurationMs: 15_000,
  preferredRefreshIntervalMs: 900_000,
  availableInMarket: false,
  options: [
    { key: "assetRef", label: "本地素材", type: "hidden", default: "" },
    { key: "officialId", label: "官方作品 ID", type: "hidden", default: "" },
    { key: "title", label: "作品标题", type: "hidden", default: "像素素材" },
    { key: "author", label: "作者", type: "hidden", default: "未署名" },
    { key: "sourceUrl", label: "官方来源", type: "hidden", default: "" },
    { key: "frameCount", label: "帧数", type: "hidden", default: 1 },
  ],
  async render(context, item) {
    const assetRef = typeof item.options.assetRef === "string" ? item.options.assetRef : "";
    const rendered = await context.getPixelAsset(assetRef, item.durationMs);
    const title = typeof item.options.title === "string" && item.options.title.trim()
      ? item.options.title.trim()
      : rendered.metadata.title;
    return {
      frames: rendered.frames,
      frameDelaysMs: rendered.frameDelaysMs,
      label: title,
    };
  },
};

export const CONTENT_DEFINITIONS: readonly ContentDefinition[] = [
  ...ASSET_PRESETS.map((preset) => marketDefinition(preset.id)),
  RUNTIME_MARKET_DEFINITION,
  NOTICE_DEFINITION,
  TIMER_DEFINITION,
  POMODORO_DEFINITION,
  COUNTDOWN_DEFINITION,
  // Weather carries its own coordinate options and data dependency, so it is
  // registered explicitly instead of through the generic visual factory.
  ...VISUAL_EFFECT_IDS.filter((effectId) => effectId !== "weather").map(visualDefinition),
  WEATHER_DEFINITION,
  CANVAS_DEFINITION,
  PIXEL_ASSET_DEFINITION,
];

const DEFINITION_BY_ID = new Map(CONTENT_DEFINITIONS.map((definition) => [definition.id, definition]));

export function getContentDefinition(contentId: string): ContentDefinition {
  const definition = DEFINITION_BY_ID.get(contentId);
  if (!definition) throw new Error(`unknown content definition: ${contentId}`);
  return definition;
}

export function getContentCatalog(): ContentCatalogEntry[] {
  return CONTENT_DEFINITIONS.map(({ render: _render, ...definition }) => ({
    ...definition,
    defaultOptions: defaults(definition.options),
  }));
}

export function createDefaultContentItem(contentId: string): ContentItemConfig {
  const definition = getContentDefinition(contentId);
  return createContentItem(
    contentId,
    definition.defaultDurationMs,
    defaults(definition.options),
  );
}
