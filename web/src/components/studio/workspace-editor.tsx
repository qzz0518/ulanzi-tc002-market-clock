import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Eye,
  EyeOff,
  GripVertical,
  Pause,
  Play,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  Button,
  Input,
  NumberScrubber,
  Select,
  Switch,
  Tab,
  Tabs,
  TabsList,
  Tooltip,
} from "@cladd-ui/react";
import { cn, seconds } from "@/lib/utils";
import type {
  BusyAction,
  ChannelConfig,
  ContentCatalogEntry,
  ContentItemConfig,
  JsonValue,
  PreviewScope,
} from "@/types";
import { ContentIcon } from "./content-icon";
import { WorkspaceActions } from "./workspace-actions";

function contentTitle(item: ContentItemConfig, definition?: ContentCatalogEntry): string {
  if (
    item.contentId === "creative:pixel-asset"
    && typeof item.options.title === "string"
    && item.options.title.trim()
  ) return item.options.title.trim();
  return definition?.title ?? item.contentId;
}

interface WorkspaceEditorProps {
  channel: ChannelConfig;
  selectedItemId: string | null;
  catalog: ContentCatalogEntry[];
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
  onPush: () => void;
}

interface OptionEditorProps {
  item: ContentItemConfig;
  definition: ContentCatalogEntry;
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

function OptionEditor({ item, definition, onChange, onTimerStart, onTimerPause }: OptionEditorProps) {
  const visibleFields = definition.options.filter((field) => field.type !== "hidden");
  const titleId = `content-options-${item.id}`;

  return (
    <section className="content-options" aria-labelledby={titleId}>
      <div className="subsection-heading">
        <div>
          <h3 id={titleId}>内容设置</h3>
          <p>{contentTitle(item, definition)}</p>
        </div>
        {visibleFields.length === 0 && item.contentId !== "tools:timer" && (
          <span>此内容无需额外设置</span>
        )}
      </div>
      {(visibleFields.length > 0 || item.contentId === "tools:timer") && (
        <div className="option-grid">
          {visibleFields.map((field) => {
            const controlId = `option-${item.id}-${field.key}`;
            const value = item.options[field.key] ?? field.default;
            const displayAsSeconds = field.type === "number" && field.key.endsWith("Ms");
            const displayScale = displayAsSeconds ? 1_000 : 1;

            if (field.type === "boolean") {
              return (
                <label key={field.key} className="option-field option-field--boolean">
                  <div className="option-copy">
                    <span className="option-label">{field.label}</span>
                    {field.help && <span>{field.help}</span>}
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
                <label htmlFor={controlId} className="option-label">{field.label}</label>
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
                ) : (
                  <Input
                    inputId={controlId}
                    type={field.type === "color" ? "color" : "text"}
                    value={String(value)}
                    maxLength={field.type === "text" ? 96 : undefined}
                    onChange={(nextValue) => onChange(field.key, nextValue)}
                  />
                )}
                {field.help && <span className="option-help">{field.help}</span>}
              </div>
            );
          })}

          {item.contentId === "tools:timer" && (
            <div className="timer-actions">
              <Button type="button" color="brand" variant="solid-fill" size="sm" onClick={onTimerStart}><Play />从头开始</Button>
              <Button type="button" size="sm" onClick={onTimerPause}><Pause />暂停</Button>
            </div>
          )}
        </div>
      )}
      {item.contentId === "creative:pixel-asset" && (
        <div className="pixel-asset-metadata">
          <span>作者：{typeof item.options.author === "string" ? item.options.author : "未署名"}</span>
          <span>{Number(item.options.frameCount) > 1 ? `${item.options.frameCount} 帧动画` : "静态素材"}</span>
          {typeof item.options.sourceUrl === "string" && item.options.sourceUrl.startsWith("https://ugc.ulanzistudio.com/contentView/") && (
            <a href={item.options.sourceUrl} target="_blank" rel="noreferrer">查看官方来源</a>
          )}
        </div>
      )}
    </section>
  );
}

export function WorkspaceEditor({
  channel,
  selectedItemId,
  catalog,
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
  onPush,
}: WorkspaceEditorProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const selectedItem = channel.items.find((item) => item.id === selectedItemId) ?? channel.items[0];
  const selectedDefinition = selectedItem
    ? catalog.find((definition) => definition.id === selectedItem.contentId)
    : undefined;
  const totalDuration = channel.items.reduce((sum, item) => sum + item.durationMs, 0);
  const effectiveRefresh = Math.max(channel.refreshIntervalMs, totalDuration);
  const previewLabel = previewScope === "item"
    ? selectedItem ? contentTitle(selectedItem, selectedDefinition) : "所选内容"
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
          <span className="config-help">仅用于本页面识别。</span>
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
          <span className="config-help">设备旋钮列表中显示；限 1–32 位字母、数字、_ 或 -。</span>
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
          <span className="config-help">完整播放后才重新取数；当前实际最短 {seconds(effectiveRefresh)} 秒。</span>
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
              <TabsList
                className="preview-scope"
                aria-label="预览范围"
                size="sm"
                activeColor="brand"
                activeVariant="solid-fill"
                activeOutline={false}
              >
                <Tab value="item">所选内容</Tab>
                <Tab value="channel">完整轮播</Tab>
              </TabsList>
            </Tabs>
          )}
          <Button
            type="button"
            color="neutral"
            variant="transparent"
            outline={false}
            size="sm"
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
                const title = contentTitle(item, definition);
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
            size="sm"
            className="mobile-add-content"
            onClick={onOpenCatalog}
          >
            <Plus />添加内容
          </Button>
        </div>
        <div className="playlist">
          {channel.items.map((item, index) => {
            const definition = catalog.find((entry) => entry.id === item.contentId);
            const title = contentTitle(item, definition);
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
