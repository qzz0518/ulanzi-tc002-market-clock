import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Eye,
  EyeOff,
  GripVertical,
  MapPin,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  Webhook,
} from "lucide-react";
import {
  Button,
  ColorPicker,
  Dialog,
  Input,
  List,
  ListButton,
  NumberScrubber,
  Select,
  Surface,
  SurfaceCut,
  Switch,
  Tab,
  Tabs,
  TabsList,
  Tooltip,
  Spinner,
} from "@cladd-ui/react";
import { jsonApi } from "@/lib/api";
import { useAppToast } from "@/lib/use-app-toast";
import { cn, errorMessage, seconds } from "@/lib/utils";
import type { FirmwareMode } from "@/lib/firmware-mode";
import type {
  BusyAction,
  ChannelConfig,
  ContentCatalogEntry,
  ContentItemConfig,
  JsonValue,
  MarketInstrument,
  PreviewScope,
} from "@/types";
import { ContentIcon } from "./content-icon";
import { WorkspaceActions } from "./workspace-actions";

// High-saturation presets that read well on the LED panel, offered as
// one-click swatches in every color option's picker.
const LED_COLOR_SWATCHES = [
  "#ff4830",
  "#ff8a2a",
  "#ffd43b",
  "#00ff66",
  "#00d67a",
  "#00e5ff",
  "#5b8cff",
  "#ffffff",
];

function contentTitle(
  item: ContentItemConfig,
  definition?: ContentCatalogEntry,
  instrument?: MarketInstrument,
): string {
  if (
    item.contentId === "creative:pixel-asset"
    && typeof item.options.title === "string"
    && item.options.title.trim()
  ) return item.options.title.trim();
  if (item.contentId === "market:instrument") {
    return instrument?.displaySymbol ?? "不可用的运行时资产";
  }
  return definition?.title ?? item.contentId;
}

interface WorkspaceEditorProps {
  channel: ChannelConfig;
  selectedItemId: string | null;
  catalog: ContentCatalogEntry[];
  instruments: MarketInstrument[];
  previewUrl: string | null;
  previewing: boolean;
  previewError: string | null;
  previewFrameCount: number | null;
  previewScope: PreviewScope;
  busy: BusyAction;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  deviceOutOfDate: boolean;
  lastPushAt?: string;
  // 时钟当前跑的固件；决定"推送"这个动作是否还存在（ZOS 下由设备自己拉取）。
  firmwareMode?: FirmwareMode;
  onChannelChange: (patch: Partial<ChannelConfig>) => void;
  onSelectItem: (itemId: string) => void;
  onPreviewScopeChange: (scope: PreviewScope) => void;
  onDurationChange: (itemId: string, durationMs: number) => void;
  onOptionChange: (itemId: string, key: string, value: JsonValue) => void;
  onMoveItem: (itemId: string, direction: -1 | 1) => void;
  onReorderItem: (itemId: string, targetId: string, position: "before" | "after") => void;
  onRemoveItem: (itemId: string) => void;
  onTimerStart: (itemId: string) => void;
  onTimerPause: (itemId: string) => void;
  onOpenCatalog: () => void;
  /** 见 WorkspaceActions.onFlushEdits：固定到时钟前先把待保存的改动落盘。 */
  onFlushEdits?: () => Promise<boolean>;
  onPush: () => void;
}

interface OptionEditorProps {
  item: ContentItemConfig;
  definition: ContentCatalogEntry;
  instrument?: MarketInstrument;
  firmwareMode: FirmwareMode;
  onChange: (key: string, value: JsonValue) => void;
  onTimerStart: () => void;
  onTimerPause: () => void;
}

interface NumberInputProps {
  id?: string;
  value: number;
  minimum?: number;
  maximum?: number;
  step?: number;
  unit?: string;
  className?: string;
  ariaLabel?: string;
  onCommit: (value: number) => void;
}

function NumberInput({
  id,
  value,
  minimum,
  maximum,
  step = 1,
  unit,
  className,
  ariaLabel = "数值",
  onCommit,
}: NumberInputProps) {
  return (
    <NumberScrubber
      id={id}
      className={cn("number-scrubber", className)}
      contentClassName="number-scrubber__content"
      inputClassName="number-scrubber__input"
      value={value}
      min={minimum}
      max={maximum}
      step={step}
      aria-label={`${ariaLabel}，可左右拖动或点击输入`}
      title="左右拖动调整，点击输入"
      color="neutral"
      displayValue={(nextValue) => unit ? `${nextValue} ${unit}` : String(nextValue)}
      onChange={onCommit}
    />
  );
}

interface GeocodePlace {
  name: string;
  admin1?: string;
  country: string;
  latitude: number;
  longitude: number;
}

// One selection fills all three location options: the display text plus the
// hidden coordinate pair the renderers actually read.
export function placeSelectionPatches(place: GeocodePlace): Array<[string, JsonValue]> {
  return [
    ["place", [place.name, place.country].filter(Boolean).join(", ")],
    ["latitude", String(place.latitude)],
    ["longitude", String(place.longitude)],
  ];
}

// The notice-board channel shows static text; the webhook is its instant
// sibling — one POST from any LAN device puts a message on the clock right
// away and it cleans itself up. A single button opens a dialog that explains
// it; nothing extra sits in the option panel.
function NoticeWebhookHint({ firmwareMode }: { firmwareMode: FirmwareMode }) {
  const toast = useAppToast();
  const [open, setOpen] = useState(false);
  // The webhook is the one feature here that has no ZOS route at all: it writes
  // a Custom App straight at the stock firmware's receiver, and that receiver
  // left with the firmware. Measured on the real device: POST /api/notify comes
  // back "clock returned HTTP 503". The dialog still shows the command — it
  // works again the moment the official firmware is back — but it says so.
  const zos = firmwareMode === "zos";
  const origin = typeof window === "undefined" ? "http://<服务地址>:43820" : window.location.origin;
  const command = `curl -X POST ${origin}/api/notify -H 'Content-Type: application/json' -d '{"message":"你好像素","holdSeconds":45}'`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success("已复制 curl 示例");
    } catch {
      toast.error("复制失败，请手动选择文本");
    }
  };
  return (
    <div className="timer-actions">
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Webhook />Webhook 即时通知
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Webhook 即时通知"
        cancelButtonText="关闭"
        confirmButtonText="复制 curl 示例"
        onConfirm={() => void copy()}
      >
        <div className="flex min-w-0 flex-col gap-2 text-sm">
          {zos && (
            <Surface
              color="orange"
              variant="solid"
              outline
              className="rounded-lg"
              contentClassName="px-3 py-2 text-xs leading-relaxed text-cladd-fg-soft"
            >
              <strong className="text-cladd-fg">时钟正在运行 ZOS，这条 Webhook 暂时不会上屏。</strong>
              它写的是官方固件的 Custom App 接收端，ZOS 上没有这个接口，服务会返回
              「clock returned HTTP 503」。恢复官方固件后即刻恢复。
            </Surface>
          )}
          <p className="m-0">
            与频道里的通知板内容无关：任何设备（curl、iOS 快捷指令、Home Assistant）向下面的
            地址 POST 一条消息即可立刻上屏，显示 holdSeconds 秒后自动消失，支持中文。
          </p>
          <code
            className="overflow-x-auto whitespace-nowrap rounded bg-cladd-surface-minus px-2 py-1.5 font-mono text-xs"
            style={{ width: 0, minWidth: "100%" }}
          >
            {command}
          </code>
          <p className="m-0 text-xs text-cladd-fg-soft">
            手机打开控制台时，示例地址会自动换成局域网 IP。可选 NOTIFY_TOKEN 鉴权与全部字段
            见技术参考「Webhook 通知」。
          </p>
        </div>
      </Dialog>
    </div>
  );
}

interface PlaceSearchFieldProps {
  controlId: string;
  label: string;
  value: string;
  onChange: (key: string, value: JsonValue) => void;
}

function PlaceSearchField({ controlId, label, value, onChange }: PlaceSearchFieldProps) {
  const [results, setResults] = useState<GeocodePlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const sequence = useRef(0);
  // The mounted value is a saved place, and a picked candidate writes one
  // back; neither should reopen the dropdown — only fresh typing searches.
  const settledValue = useRef<string | null>(value);
  const toast = useAppToast();

  useEffect(() => {
    if (settledValue.current === value) return;
    const query = value.trim();
    if (!query) {
      sequence.current += 1;
      setResults([]);
      setSearching(false);
      setSearched(false);
      return;
    }
    const currentSequence = ++sequence.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await jsonApi<{ places: GeocodePlace[] }>(
            `/api/weather/geocode?${new URLSearchParams({ q: query.slice(0, 64) })}`,
          );
          if (currentSequence !== sequence.current) return;
          setResults(response.places);
          setSearched(true);
        } catch (error) {
          if (currentSequence !== sequence.current) return;
          setResults([]);
          setSearched(false);
          toast.error("地点搜索失败", { description: errorMessage(error) });
        } finally {
          if (currentSequence === sequence.current) setSearching(false);
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [value, toast]);

  const pick = (place: GeocodePlace) => {
    const patches = placeSelectionPatches(place);
    sequence.current += 1;
    settledValue.current = String(patches[0]![1]);
    setResults([]);
    setSearched(false);
    setSearching(false);
    for (const [key, patchValue] of patches) onChange(key, patchValue);
  };

  return (
    <div className="place-search flex min-w-0 flex-col gap-1.5">
      <Input
        inputId={controlId}
        icon={<Search aria-hidden="true" />}
        value={value}
        maxLength={64}
        placeholder="输入城市或地点，如 Shanghai"
        inputComponentProps={{ "aria-label": label, spellCheck: false, autoComplete: "off" }}
        onChange={(nextValue) => {
          settledValue.current = null;
          onChange("place", nextValue);
        }}
      />
      {searching && (
        <p className="place-search__status m-0 flex items-center gap-1.5 text-sm text-cladd-fg-soft" role="status">
          <Spinner size="sm" aria-hidden="true" />正在搜索地点…
        </p>
      )}
      {searched && !searching && results.length === 0 && (
        <p className="place-search__status m-0 text-sm text-cladd-fg-soft" role="status">
          没有找到匹配的地点，换个写法再试。
        </p>
      )}
      {results.length > 0 && (
        <List className="place-search__results max-h-56 overflow-y-auto" aria-label="地点候选">
          {results.map((place) => (
            <ListButton
              key={`${place.name}|${place.latitude}|${place.longitude}`}
              type="button"
              color="neutral"
              rounded={false}
              tightFocusRing
              icon={<MapPin aria-hidden="true" />}
              footer={[place.admin1, place.country].filter(Boolean).join(" · ") || undefined}
              onClick={() => pick(place)}
            >
              {place.name}
            </ListButton>
          ))}
        </List>
      )}
    </div>
  );
}

function OptionEditor({
  item,
  definition,
  instrument,
  firmwareMode,
  onChange,
  onTimerStart,
  onTimerPause,
}: OptionEditorProps) {
  const visibleFields = definition.options.filter((field) => field.type !== "hidden");
  const optionKeys = new Set(definition.options.map((field) => field.key));
  // place + latitude + longitude together mark a geocoded location content:
  // the place text turns into a search box that fills the hidden coordinates.
  const hasPlaceSearch = optionKeys.has("place")
    && optionKeys.has("latitude")
    && optionKeys.has("longitude");
  const hasMetadata = item.contentId === "creative:pixel-asset" || item.contentId === "market:instrument";

  return (
    <section className="content-options" aria-label={`${contentTitle(item, definition, instrument)} 内容设置`}>
      {visibleFields.length === 0 && item.contentId !== "tools:timer" && !hasMetadata && (
        <p className="option-empty">此内容无需额外设置</p>
      )}
      {(visibleFields.length > 0 || item.contentId === "tools:timer") && (
        <div className="option-grid">
          {visibleFields.map((field) => {
            const controlId = `option-${item.id}-${field.key}`;
            const value = item.options[field.key] ?? field.default;
            const displayAsSeconds = field.type === "number" && field.key.endsWith("Ms");
            const displayScale = displayAsSeconds ? 1_000 : 1;

            if (field.key === "place" && hasPlaceSearch) {
              return (
                <div key={field.key} className="option-field option-field--wide place-search-field">
                  <div className="option-copy">
                    <label htmlFor={controlId} className="option-label">{field.label}</label>
                    {field.help && <span className="option-help">{field.help}</span>}
                  </div>
                  <PlaceSearchField
                    key={item.id}
                    controlId={controlId}
                    label={field.label}
                    value={String(value)}
                    onChange={onChange}
                  />
                </div>
              );
            }

            if (field.type === "boolean") {
              return (
                <label key={field.key} className="option-field option-field--boolean">
                  <div className="option-copy">
                    <span className="option-label">{field.label}</span>
                    {field.help && <span className="option-help">{field.help}</span>}
                  </div>
                  <Switch
                    as="span"
                    input
                    checked={value === true}
                    onChange={(checked) => onChange(field.key, checked)}
                  />
                </label>
              );
            }

            return (
              <div key={field.key} className={cn("option-field", field.type === "text" && "option-field--wide")}>
                <div className="option-copy">
                  <label htmlFor={controlId} className="option-label">{field.label}</label>
                  {field.help && <span className="option-help">{field.help}</span>}
                </div>
                {field.type === "select" ? (
                  <Select
                    id={controlId}
                    aria-label={field.label}
                    value={String(value)}
                    options={(field.choices ?? []).map((choice) => choice.value)}
                    renderOption={({ value: choiceValue }) => (
                      field.choices?.find((choice) => choice.value === choiceValue)?.label ?? choiceValue
                    )}
                    onChange={(nextValue) => onChange(field.key, nextValue)}
                  >
                    {field.choices?.find((choice) => choice.value === String(value))?.label ?? String(value)}
                  </Select>
                ) : field.type === "number" ? (
                  <NumberInput
                    id={controlId}
                    value={Number(value) / displayScale}
                    minimum={field.minimum === undefined ? undefined : field.minimum / displayScale}
                    maximum={field.maximum === undefined ? undefined : field.maximum / displayScale}
                    step={(field.step ?? 1) / displayScale}
                    unit={displayAsSeconds ? "秒" : undefined}
                    ariaLabel={displayAsSeconds ? `${field.label}（秒）` : field.label}
                    onCommit={(nextValue) => onChange(
                      field.key,
                      displayAsSeconds ? Math.round(nextValue * displayScale) : nextValue,
                    )}
                  />
                ) : field.type === "color" ? (
                  <ColorPicker
                    size="sm"
                    alpha={false}
                    inputs={false}
                    debounce={200}
                    swatches={LED_COLOR_SWATCHES}
                    value={String(value)}
                    popoverPosition="top-start"
                    aria-label={field.label}
                    onChange={(next) => onChange(field.key, next.hex.slice(0, 7).toLowerCase())}
                  >
                    {String(value)}
                  </ColorPicker>
                ) : (
                  <Input
                    inputId={controlId}
                    type="text"
                    value={String(value)}
                    maxLength={96}
                    onChange={(nextValue) => onChange(field.key, nextValue)}
                  />
                )}
              </div>
            );
          })}

          {item.contentId === "tools:timer" && (
            <div className="timer-actions">
              <Button type="button" color="brand" size="sm" onClick={onTimerStart}><Play />从头开始</Button>
              <Button type="button" size="sm" onClick={onTimerPause}><Pause />暂停</Button>
            </div>
          )}
        </div>
      )}
      {item.contentId === "tools:notice" && <NoticeWebhookHint firmwareMode={firmwareMode} />}
      {item.contentId === "creative:pixel-asset" && (
        <div className="pixel-asset-metadata">
          <span>作者：{typeof item.options.author === "string" ? item.options.author : "未署名"}</span>
          <span>{Number(item.options.frameCount) > 1 ? `${item.options.frameCount} 帧动画` : "静态素材"}</span>
          {typeof item.options.sourceUrl === "string" && item.options.sourceUrl.startsWith("https://ugc.ulanzistudio.com/contentView/") && (
            <a href={item.options.sourceUrl} target="_blank" rel="noreferrer">查看官方来源</a>
          )}
        </div>
      )}
      {item.contentId === "market:instrument" && (
        <div className="pixel-asset-metadata">
          {instrument
            ? <>
              <span>{instrument.displayName}</span>
              <span>{instrument.kind.toUpperCase()} · {instrument.baseCode}/{instrument.quoteCode}</span>
              <span>{instrument.sourceNote}</span>
            </>
            : <span>这个资产的本地身份记录不可用；频道仍会保留，但无法预览或推送。</span>}
        </div>
      )}
    </section>
  );
}

export function WorkspaceEditor({
  channel,
  selectedItemId,
  catalog,
  instruments,
  previewUrl,
  previewing,
  previewError,
  previewFrameCount,
  previewScope,
  busy,
  dirty,
  saving,
  lastSavedAt,
  deviceOutOfDate,
  lastPushAt,
  firmwareMode = "official",
  onChannelChange,
  onSelectItem,
  onPreviewScopeChange,
  onDurationChange,
  onOptionChange,
  onMoveItem,
  onReorderItem,
  onRemoveItem,
  onTimerStart,
  onTimerPause,
  onOpenCatalog,
  onFlushEdits,
  onPush,
}: WorkspaceEditorProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const selectedItem = channel.items.find((item) => item.id === selectedItemId) ?? channel.items[0];
  const instrumentsByRef = new Map(instruments.map((instrument) => [instrument.ref, instrument]));
  const instrumentFor = (item: ContentItemConfig): MarketInstrument | undefined =>
    item.contentId === "market:instrument" && typeof item.options.instrumentRef === "string"
      ? instrumentsByRef.get(item.options.instrumentRef)
      : undefined;
  const selectedDefinition = selectedItem
    ? catalog.find((definition) => definition.id === selectedItem.contentId)
    : undefined;
  const totalDuration = channel.items.reduce((sum, item) => sum + item.durationMs, 0);
  const previewLabel = previewScope === "item"
    ? selectedItem ? contentTitle(selectedItem, selectedDefinition, instrumentFor(selectedItem)) : "所选内容"
    : `完整轮播 · ${channel.items.length} 个内容`;

  useEffect(() => {
    setMobileSettingsOpen(false);
    setMobilePreviewOpen(false);
  }, [channel.id]);

  return (
    <main className="workspace-editor" id="workspace-editor">
      <Button
        type="button"
        color="neutral"
        variant="transparent"
        outline={false}
        className="mobile-channel-settings-trigger"
        aria-expanded={mobileSettingsOpen}
        aria-controls="channel-settings-panel"
        onClick={() => setMobileSettingsOpen((current) => !current)}
      >
        <span className="mobile-channel-settings-trigger__copy">
          <span><Settings2 />频道设置</span>
          <small>{channel.appName} · {channel.enabled ? "已启用" : "未启用"} · 刷新 {seconds(channel.refreshIntervalMs)} 秒</small>
        </span>
        <ChevronDown className={cn("mobile-disclosure-chevron", mobileSettingsOpen && "is-open")} />
      </Button>

      <section
        id="channel-settings-panel"
        className={cn("channel-config", !mobileSettingsOpen && "is-mobile-collapsed")}
        aria-label="频道设置"
      >
        <div className="config-field config-field--name">
          <label htmlFor="channel-name">频道名称</label>
          <Input
            inputId="channel-name"
            value={channel.name}
            maxLength={48}
            onChange={(nextValue) => onChannelChange({ name: nextValue })}
          />
        </div>
        <div className="config-field">
          <label htmlFor="channel-app">时钟旋钮名称</label>
          <Input
            inputId="channel-app"
            value={channel.appName}
            maxLength={32}
            inputComponentProps={{ spellCheck: false, autoCapitalize: "none" }}
            onChange={(nextValue) => onChannelChange({ appName: nextValue })}
          />
        </div>
        <div className="config-field config-field--refresh">
          <label htmlFor="channel-refresh">内容刷新间隔</label>
          <NumberInput
            id="channel-refresh"
            value={seconds(channel.refreshIntervalMs)}
            minimum={1}
            maximum={900}
            step={1}
            unit="秒"
            ariaLabel="内容刷新间隔（秒）"
            onCommit={(nextValue) => onChannelChange({ refreshIntervalMs: Math.round(nextValue * 1_000) })}
          />
        </div>
        <label className="config-field config-field--toggle" title="启用后显示在时钟旋钮列表中">
          <span className="option-label">启用频道</span>
          <Switch
            as="span"
            input
            checked={channel.enabled}
            onChange={(checked) => onChannelChange({ enabled: checked })}
          />
        </label>
      </section>

      <section className="preview-section" aria-labelledby="preview-title">
        <div className="preview-toolbar">
          <div className="preview-copy">
            <h2 id="preview-title">{channel.items.length === 1 ? "独立内容" : "频道预览"}</h2>
            <span>旋钮项 {channel.appName} · 共 {seconds(totalDuration)} 秒</span>
          </div>
          {channel.items.length > 1 && (
            <Tabs value={previewScope} onValueChange={(value) => onPreviewScopeChange(value as PreviewScope)}>
              <SurfaceCut
                className="segmented-track preview-scope"
                color="neutral"
                outline={false}
                contentClassName="segmented-track__content"
              >
                <TabsList aria-label="预览范围" size="sm" activeColor="brand">
                  <Tab value="item">所选内容</Tab>
                  <Tab value="channel">完整轮播</Tab>
                </TabsList>
              </SurfaceCut>
            </Tabs>
          )}
          <Button
            type="button"
            className="mobile-preview-toggle"
            aria-expanded={mobilePreviewOpen}
            aria-controls="channel-device-preview"
            onClick={() => setMobilePreviewOpen((current) => !current)}
          >
            {mobilePreviewOpen ? <EyeOff /> : <Eye />}
            {mobilePreviewOpen ? "收起预览" : "查看预览"}
          </Button>
          <WorkspaceActions
            busy={busy}
            dirty={dirty}
            saving={saving}
            lastSavedAt={lastSavedAt}
            deviceOutOfDate={deviceOutOfDate}
            lastPushAt={lastPushAt}
            firmwareMode={firmwareMode}
            channelAppName={channel.appName}
            channelEnabled={channel.enabled}
            onFlushEdits={onFlushEdits}
            onPush={onPush}
          />
        </div>

        <div
          id="channel-device-preview"
          className={cn(
            "device-stage",
            previewing && "is-rendering",
            !mobilePreviewOpen && "is-mobile-collapsed",
          )}
          aria-busy={previewing}
        >
          <div className="clock-device" aria-label="Ulanzi TC002 预览">
            <div className="clock-screen">
              {previewUrl
                ? <img src={previewUrl} alt={`${previewLabel}动画预览`} />
                : <span title={previewError ?? undefined}>
                    {previewing
                      ? "正在生成所选内容预览…"
                      : previewError
                        ? "预览生成失败，修改设置后将自动重试"
                        : "等待生成预览…"}
                  </span>}
            </div>
          </div>
          <div className="preview-context" aria-live="polite">
            <span>正在预览：<strong>{previewLabel}</strong></span>
            <span>{previewing
              ? "更新中…"
              : previewError
                ? "预览失败"
                : previewFrameCount
                  ? `${previewFrameCount} 帧`
                  : "自动预览"}</span>
          </div>
          {channel.items.length > 1 && (
            <div className="preview-dots" aria-label="选择要预览的内容">
              {channel.items.map((item, index) => {
                const definition = catalog.find((entry) => entry.id === item.contentId);
                const title = contentTitle(item, definition, instrumentFor(item));
                const active = item.id === selectedItem?.id && previewScope === "item";
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(active && "is-active")}
                    aria-label={`预览第 ${index + 1} 项：${title}`}
                    aria-pressed={active}
                    title={title}
                    onClick={() => {
                      onSelectItem(item.id);
                      onPreviewScopeChange("item");
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="playlist-section" aria-labelledby="playlist-title">
        <div className="subsection-heading">
          <div className="playlist-heading-copy">
            <h2 id="playlist-title">播放顺序</h2>
            <span>{channel.items.length} 个内容 · 共 {seconds(totalDuration)} 秒</span>
          </div>
          <Button
            type="button"
            color="brand"
            className="mobile-add-content"
            onClick={onOpenCatalog}
          >
            <Plus />添加内容
          </Button>
        </div>
        <div className="playlist">
          {channel.items.map((item, index) => {
            const definition = catalog.find((entry) => entry.id === item.contentId);
            const instrument = instrumentFor(item);
            const title = contentTitle(item, definition, instrument);
            const active = item.id === selectedItem?.id;
            return (
              <div
                key={item.id}
                id={`playlist-item-${item.id}`}
                className={cn(
                  "playlist-item",
                  active && "is-active",
                  draggingId === item.id && "is-dragging",
                  dragOverId === item.id && draggingId !== item.id && "is-drop-target",
                )}
                onDragOver={(event) => {
                  if (!draggingId || draggingId === item.id) return;
                  event.preventDefault();
                  setDragOverId(item.id);
                }}
                onDragLeave={() => setDragOverId((current) => current === item.id ? null : current)}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!draggingId || draggingId === item.id) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const position = event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
                  onReorderItem(draggingId, item.id, position);
                  setDraggingId(null);
                  setDragOverId(null);
                }}
              >
                <div className="playlist-row">
                  <Tooltip tooltip="拖动排序；也可使用右侧箭头">
                    <Button
                      type="button"
                      className="drag-handle"
                      variant="transparent"
                      outline={false}
                      size="sm"
                      square
                      draggable
                      aria-label={`拖动排序 ${title}`}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", item.id);
                        setDraggingId(item.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverId(null);
                      }}
                    >
                      <GripVertical />
                    </Button>
                  </Tooltip>
                  <button
                    type="button"
                    className="playlist-select"
                    aria-pressed={active}
                    onClick={() => onSelectItem(item.id)}
                  >
                    <ContentIcon
                      contentId={item.contentId}
                      assetRef={typeof item.options.assetRef === "string" ? item.options.assetRef : undefined}
                      iconUrl={instrument?.iconUrl}
                      fallbackLabel={instrument?.baseCode}
                    />
                    <span className="playlist-name">
                      <strong>{title}</strong>
                      <span>{item.contentId}</span>
                    </span>
                  </button>
                  <div className="duration-field">
                    <span>单项停留</span>
                    <NumberInput
                      ariaLabel={`${title}单项停留时长`}
                      value={seconds(item.durationMs)}
                      minimum={0.5}
                      maximum={900}
                      step={0.5}
                      unit="秒"
                      onCommit={(nextValue) => onDurationChange(item.id, Math.round(nextValue * 1_000))}
                    />
                  </div>
                  <div className="playlist-actions">
                    <Tooltip tooltip="上移">
                      <Button type="button" variant="transparent" outline={false} size="sm" square disabled={index === 0} onClick={() => onMoveItem(item.id, -1)} aria-label={`上移 ${title}`}>
                        <ArrowUp />
                      </Button>
                    </Tooltip>
                    <Tooltip tooltip="下移">
                      <Button type="button" variant="transparent" outline={false} size="sm" square disabled={index === channel.items.length - 1} onClick={() => onMoveItem(item.id, 1)} aria-label={`下移 ${title}`}>
                        <ArrowDown />
                      </Button>
                    </Tooltip>
                    <Tooltip tooltip="从频道移除">
                      <Button type="button" className="playlist-remove" color="red" variant="transparent" outline={false} size="sm" square onClick={() => onRemoveItem(item.id)} aria-label={`从频道移除 ${title}`}>
                        <Trash2 />
                      </Button>
                    </Tooltip>
                  </div>
                </div>

                {active && definition && (
                  <OptionEditor
                    item={item}
                    definition={definition}
                    instrument={instrument}
                    firmwareMode={firmwareMode}
                    onChange={(key, value) => onOptionChange(item.id, key, value)}
                    onTimerStart={() => onTimerStart(item.id)}
                    onTimerPause={() => onTimerPause(item.id)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
