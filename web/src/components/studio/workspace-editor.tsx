import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  TriangleAlert,
  Webhook,
} from "lucide-react";
import {
  type ButtonProps,
  Button,
  ColorPicker,
  Dialog,
  Input,
  List,
  ListButton,
  NumberScrubber,
  Select,
  SurfaceCut,
  Switch,
  Tab,
  Tabs,
  TabsList,
  Tooltip,
  Spinner,
} from "@cladd-ui/react";
import { Callout } from "@/components/callout";
import { Disclosure } from "@/components/disclosure";
import { jsonApi } from "@/lib/api";
import { useAppToast } from "@/lib/use-app-toast";
import { usePhoneTier } from "@/lib/use-phone-tier";
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

// Recessed, the scrubber matches the Inputs beside it and the Input it turns
// into on click — raised, every click was a visible jump. NumberScrubber has no
// `surface` prop: this relies on cladd 0.18.5's NumberScrubber spreading
// `...rest` onto its idle Button. Typed against Button so a rename there fails tsc.
const CUT_SURFACE: Pick<ButtonProps, "surface"> = { surface: "cut" };

// Built CSS is minified, which rewrites 200ms as ".2s" — honour the unit.
function motionMs(style: CSSStyleDeclaration, token: string, fallback: number): number {
  const value = style.getPropertyValue(token).trim();
  return (parseFloat(value) * (value.endsWith("ms") ? 1 : 1000)) || fallback;
}
const FLIP_ANIMATION = "playlist-flip";

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
      {...CUT_SURFACE}
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
        <div className="flex min-w-0 flex-col gap-2">
          {zos && (
            <Callout icon={TriangleAlert} tone="warning" title="时钟正在运行 ZOS，这条 Webhook 暂时不会上屏。">
              {/* One line per sentence run: a JSX line break between two CJK
                  characters renders as a stray space. */}
              <p>它写的是官方固件的 Custom App 接收端，ZOS 上没有这个接口，服务因此直接拒绝，返回 HTTP 503。恢复官方固件后即刻恢复。</p>
            </Callout>
          )}
          <p className="m-0 text-[length:var(--type-small)] leading-normal text-cladd-fg-soft">
            与频道里的通知板内容无关：任何设备（curl、iOS 快捷指令、Home Assistant）向下面的地址 POST 一条消息，时钟即刻收到，显示 holdSeconds 秒后自动消失，支持中文。它写进名为 notify 的 Custom App——什么时候轮到它上屏，仍由设备的自动翻页决定。
          </p>
          <code
            className="overflow-x-auto whitespace-nowrap rounded-[var(--radius-control)] bg-cladd-surface-minus px-2 py-1.5 font-mono text-[length:var(--type-caption)]"
            style={{ width: 0, minWidth: "100%" }}
          >
            {command}
          </code>
          <p className="m-0 text-[length:var(--type-caption)] leading-[1.45] text-cladd-fg-softer">
            手机打开控制台时，示例地址会自动换成局域网 IP。可选 NOTIFY_TOKEN 鉴权与全部字段见技术参考「Webhook 通知」。
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
        <p className="place-search__status m-0 flex items-center gap-1.5 text-[length:var(--type-caption)] text-cladd-fg-softer" role="status">
          <Spinner size="sm" aria-hidden="true" />正在搜索地点…
        </p>
      )}
      {searched && !searching && results.length === 0 && (
        <p className="place-search__status m-0 text-[length:var(--type-caption)] text-cladd-fg-softer" role="status">
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
                    // Every value control in the panel is recessed, like the
                    // Input and the scrubbers beside it.
                    surface="cut"
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
                    surface="cut"
                    className="font-mono"
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

  // Below the 52rem tier the channel settings and the device preview fold away behind their own toggles.
  const phone = usePhoneTier();
  const settingsOpen = !phone || mobileSettingsOpen;
  const previewOpen = !phone || mobilePreviewOpen;

  useEffect(() => {
    setMobileSettingsOpen(false);
    setMobilePreviewOpen(false);
  }, [channel.id]);

  // FLIP for ↑↓, drop and remove: rows are measured just before the change is
  // requested, then slid from there to where the new order put them. Measuring
  // at the moment of intent (not on the previous render) keeps a scroll or an
  // options panel opening in between from turning into a bogus offset.
  // Keyboard activation (event.detail 0) skips the capture: no motion for
  // keyboard-driven actions, and a held Enter would otherwise queue slides.
  const playlistRef = useRef<HTMLDivElement>(null);
  const rowTopsBeforeMove = useRef<{ movedId: string; tops: Map<string, number> } | null>(null);
  const rowsSeen = useRef<{ channelId: string; ids: Set<string> } | null>(null);
  const itemOrder = channel.items.map((item) => item.id).join("|");
  const captureRowTops = (movedItemId: string, event?: { detail: number }) => {
    const list = playlistRef.current;
    if (!list || event?.detail === 0) return;
    rowTopsBeforeMove.current = {
      movedId: `playlist-item-${movedItemId}`,
      tops: new Map([...list.children].map((row) => [row.id, row.getBoundingClientRect().top])),
    };
    // A move that changed nothing (first row up) must not leave a stale capture
    // for some later, unrelated reorder; the commit lands before the next frame.
    requestAnimationFrame(() => { rowTopsBeforeMove.current = null; });
  };
  useLayoutEffect(() => {
    const before = rowTopsBeforeMove.current;
    rowTopsBeforeMove.current = null;
    const seen = rowsSeen.current;
    rowsSeen.current = { channelId: channel.id, ids: new Set(channel.items.map((item) => `playlist-item-${item.id}`)) };
    const list = playlistRef.current;
    if (!list) return;
    // `before` was read where each row was SEEN, mid-slide included; a slide
    // still applied here would make the new layout read wrong by its offset
    // and the next slide start a row away — the jump on a quick second ↓.
    const interrupted = new Set<Element>();
    for (const row of list.children) {
      for (const animation of row.getAnimations()) {
        if (animation.id !== FLIP_ANIMATION) continue;
        animation.cancel();
        interrupted.add(row);
      }
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const tokens = getComputedStyle(list);
    const flipDuration = motionMs(tokens, "--motion-base", 200);
    const easeInOut = tokens.getPropertyValue("--ease-in-out").trim() || "ease-in-out";
    // A row caught mid-slide is already moving: ease-out keeps its speed,
    // where ease-in-out would park it at rest for a beat first.
    const easeOut = tokens.getPropertyValue("--ease-out").trim() || "ease-out";
    const slide = (row: Element, delta: number, zIndex: number, timing: KeyframeAnimationOptions) => row.animate(
      [{ transform: `translateY(${delta}px)`, zIndex }, { transform: "none", zIndex }],
      { id: FLIP_ANIMATION, ...timing },
    );
    if (before) {
      for (const row of list.children) {
        const top = before.tops.get(row.id);
        if (top === undefined) continue;
        const delta = top - row.getBoundingClientRect().top;
        if (Math.abs(delta) < 1) continue;
        // The row the user moved travels over the ones it displaces.
        slide(row, delta, row.id === before.movedId ? 1 : 0, {
          duration: flipDuration,
          easing: interrupted.has(row) ? easeOut : easeInOut,
        });
      }
    }
    // A row the user just added (same channel, new id) arrives like .motion-enter.
    // WAAPI rather than the class: the row's className changes as it becomes
    // the selected item, and React rewriting it would cut the class short.
    if (seen?.channelId !== channel.id) return;
    const duration = motionMs(tokens, "--motion-slow", 280);
    // 撤销 puts a row back mid-list from a toast outside this list, so nothing
    // measured the rows first; each row below was pushed down by exactly the
    // newcomers above it (rows have no gap). The restored row also takes the
    // selection, so another row's options fold in the same commit: the slide
    // rides that fold's clock and curve, making every row's net travel one
    // curve — on the reorder clock the fold won the first 60ms and the rows
    // below rose 32px before sliding down.
    let pushedBy = 0;
    for (const row of list.children) {
      if (seen.ids.has(row.id)) {
        if (!before && pushedBy) slide(row, -pushedBy, 0, { duration, easing: easeOut });
        continue;
      }
      pushedBy += (row as HTMLElement).offsetHeight;
      row.animate(
        [{ opacity: 0, transform: "translateY(0.25rem)", zIndex: 1 }, { opacity: 1, transform: "none", zIndex: 1 }],
        { duration, easing: easeOut, fill: "backwards" },
      );
    }
  }, [itemOrder, channel.id]);

  return (
    <main className="workspace-editor" id="workspace-editor">
      <Button
        type="button"
        color="neutral"
        multiline
        className="mobile-channel-settings-trigger"
        contentClassName="mobile-channel-settings-trigger__content"
        aria-expanded={mobileSettingsOpen}
        aria-controls="channel-settings-panel"
        onClick={() => setMobileSettingsOpen((current) => !current)}
      >
        <span className="mobile-channel-settings-trigger__copy">
          <span><Settings2 />频道设置</span>
          <small>{channel.appName} · {channel.enabled ? "已启用" : "未启用"} · 刷新 {seconds(channel.refreshIntervalMs)} 秒</small>
        </span>
        <ChevronDown className="disclosure-chevron text-cladd-fg-softer" data-open={mobileSettingsOpen} aria-hidden="true" />
      </Button>

      {/* Desktop always shows the row; only phones fold it. */}
      <Disclosure animated={phone} open={settingsOpen}>
        <section
          id="channel-settings-panel"
          className="channel-config"
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
              inputClassName="font-mono"
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
            <span className="config-field__control">
              <Switch
                as="span"
                input
                checked={channel.enabled}
                onChange={(checked) => onChannelChange({ enabled: checked })}
              />
            </span>
          </label>
        </section>
      </Disclosure>

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

        <Disclosure animated={phone} open={previewOpen}>
          <div
            id="channel-device-preview"
            className={cn("device-stage", previewing && "is-rendering")}
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
        </Disclosure>
      </section>

      <section className="playlist-section" aria-labelledby="playlist-title">
        <div className="subsection-heading">
          <div className="playlist-heading-copy">
            <h3 id="playlist-title">播放顺序</h3>
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
        <div className="playlist" ref={playlistRef}>
          {channel.items.map((item, index) => {
            const definition = catalog.find((entry) => entry.id === item.contentId);
            const instrument = instrumentFor(item);
            const title = contentTitle(item, definition, instrument);
            const active = item.id === selectedItem?.id;
            const first = index === 0;
            const last = index === channel.items.length - 1;
            const moveUp = (event: { detail: number }) => { captureRowTops(item.id, event); onMoveItem(item.id, -1); };
            const moveDown = (event: { detail: number }) => { captureRowTops(item.id, event); onMoveItem(item.id, 1); };
            const remove = (event: { detail: number }) => { captureRowTops(item.id, event); onRemoveItem(item.id); };
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
                  captureRowTops(draggingId);
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
                  {!phone && (
                    <div className="playlist-actions">
                      <Tooltip tooltip="上移">
                        <Button type="button" variant="transparent" outline={false} size="sm" square disabled={first} onClick={moveUp} aria-label={`上移 ${title}`}>
                          <ArrowUp />
                        </Button>
                      </Tooltip>
                      <Tooltip tooltip="下移">
                        <Button type="button" variant="transparent" outline={false} size="sm" square disabled={last} onClick={moveDown} aria-label={`下移 ${title}`}>
                          <ArrowDown />
                        </Button>
                      </Tooltip>
                      <Tooltip tooltip="从频道移除">
                        <Button type="button" className="playlist-remove" color="red" variant="transparent" outline={false} size="sm" square onClick={remove} aria-label={`从频道移除 ${title}`}>
                          <Trash2 />
                        </Button>
                      </Tooltip>
                    </div>
                  )}
                </div>

                {/* Mounted on first open, then kept, so closing animates too —
                    without 48 inert editors for rows nobody opened. */}
                {(definition || phone) && (
                  <Disclosure lazy open={active}>
                    {/* A phone row has room for the name and the duration only; the
                        arrows and remove open with the selected row's options instead. */}
                    {phone && (
                      <div className="playlist-panel-actions">
                        <Button type="button" size="sm" disabled={first} onClick={moveUp} aria-label={`上移 ${title}`}>
                          <ArrowUp />上移
                        </Button>
                        <Button type="button" size="sm" disabled={last} onClick={moveDown} aria-label={`下移 ${title}`}>
                          <ArrowDown />下移
                        </Button>
                        <Button type="button" className="playlist-remove" color="red" variant="transparent" outline={false} size="sm" onClick={remove} aria-label={`从频道移除 ${title}`}>
                          <Trash2 />移除
                        </Button>
                      </div>
                    )}
                    {definition && (
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
                  </Disclosure>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
