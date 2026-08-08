import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListOrdered, Plus, RefreshCw, RotateCw } from "lucide-react";
import { Button, Tab, Tabs, TabsList } from "@cladd-ui/react";
import { api, jsonApi } from "@/lib/api";
import { createLatestTaskRunner } from "@/lib/latest-task-runner";
import {
  channelForPreview,
  channelRuntime,
  deviceIsBehind,
} from "@/lib/studio-state";
import { useAppToast } from "@/lib/use-app-toast";
import { clone, errorMessage, uid } from "@/lib/utils";
import type {
  BusyAction,
  ChannelConfig,
  ContentCatalogEntry,
  ContentCategory,
  ContentCategoryEntry,
  ContentItemConfig,
  JsonValue,
  MarketInstrument,
  PreviewScope,
  RuntimeState,
  StudioView,
  WorkspaceSettings,
} from "@/types";
import { CanvasWorkspace } from "@/components/studio/canvas-workspace";
import { ChannelSidebar } from "@/components/studio/channel-sidebar";
import { ContentMarket } from "@/components/studio/content-market";
import {
  PixelAssetLibrary,
  type ImportedPixelAsset,
} from "@/components/studio/pixel-asset-library";
import { MusicPlayer } from "@/components/music/music-player";
import { StudioHeader } from "@/components/studio/studio-header";
import { WorkspaceEditor } from "@/components/studio/workspace-editor";

interface CatalogResponse {
  categories: ContentCategoryEntry[];
  contents: ContentCatalogEntry[];
}

interface WorkspaceResponse {
  workspace: WorkspaceSettings;
}

interface InstrumentsResponse {
  instruments: MarketInstrument[];
}

interface SaveResponse extends WorkspaceResponse {
  state: RuntimeState;
}

interface PreviewJob {
  target: ChannelConfig;
  announce: boolean;
  forceRefresh: boolean;
}

interface PreviewResult {
  blob: Blob;
  frameCount: number | null;
}

const PREVIEW_TIMEOUT_MS = 10_000;
type MobileConsolePane = "compose" | "catalog";

function newItem(definition: ContentCatalogEntry): ContentItemConfig {
  return {
    id: uid("item"),
    contentId: definition.id,
    durationMs: definition.defaultDurationMs,
    options: clone(definition.defaultOptions),
  };
}

function importedPixelAssetItem(
  definition: ContentCatalogEntry,
  asset: ImportedPixelAsset,
): ContentItemConfig {
  const item = newItem(definition);
  item.options = {
    ...item.options,
    assetRef: asset.ref,
    officialId: asset.officialId,
    title: asset.title,
    author: asset.author,
    sourceUrl: asset.sourceUrl,
    frameCount: asset.frameCount,
  };
  return item;
}

function runtimeInstrumentItem(
  definition: ContentCatalogEntry,
  instrument: MarketInstrument,
): ContentItemConfig {
  const item = newItem(definition);
  item.options = {
    ...item.options,
    instrumentRef: instrument.ref,
  };
  return item;
}

function uniqueAppName(workspace: WorkspaceSettings, seed: string): string {
  const base = seed.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 26) || "pixel";
  const used = new Set(workspace.channels.map((channel) => channel.appName));
  let name = base;
  let index = 2;
  while (used.has(name)) {
    name = `${base.slice(0, 28)}_${index}`.slice(0, 32);
    index += 1;
  }
  return name;
}

function newChannel(
  workspace: WorkspaceSettings,
  catalog: ContentCatalogEntry[],
  name: string,
  appName: string,
  item?: ContentItemConfig,
): ChannelConfig {
  const firstDefinition = catalog.find((entry) => entry.availableInMarket !== false) ?? catalog[0]!;
  const first = item ?? newItem(firstDefinition);
  const definition = catalog.find((entry) => entry.id === first.contentId);
  return {
    id: uid("channel"),
    name,
    appName: uniqueAppName(workspace, appName),
    enabled: true,
    refreshIntervalMs: definition?.preferredRefreshIntervalMs ?? 15_000,
    items: [first],
  };
}

export function App() {
  const toast = useAppToast();
  const [catalog, setCatalog] = useState<ContentCatalogEntry[]>([]);
  const [categories, setCategories] = useState<ContentCategoryEntry[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSettings | null>(null);
  const [instruments, setInstruments] = useState<MarketInstrument[]>([]);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [category, setCategory] = useState<ContentCategory>("market");
  const [view, setView] = useState<StudioView>("console");
  const [mobileConsolePane, setMobileConsolePane] = useState<MobileConsolePane>("compose");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewFrameCount, setPreviewFrameCount] = useState<number | null>(null);
  const [previewScope, setPreviewScope] = useState<PreviewScope>("item");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [editedAtByChannel, setEditedAtByChannel] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<BusyAction>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const workspaceRef = useRef<WorkspaceSettings | null>(null);
  const editRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);

  const selectedChannel = useMemo(
    () => workspace?.channels.find((channel) => channel.id === selectedChannelId) ?? workspace?.channels[0] ?? null,
    [selectedChannelId, workspace],
  );
  const instrumentsByRef = useMemo(
    () => new Map(instruments.map((instrument) => [instrument.ref, instrument])),
    [instruments],
  );
  const selectedItem = selectedChannel?.items.find((item) => item.id === selectedItemId) ?? selectedChannel?.items[0] ?? null;
  const canvasItem = selectedItem?.contentId === "creative:canvas" ? selectedItem : null;
  const selectedChannelRuntime = selectedChannel
    ? channelRuntime(runtime, selectedChannel.id)
    : undefined;
  const selectedEditedAt = selectedChannel ? editedAtByChannel[selectedChannel.id] : undefined;
  const deviceOutOfDate = deviceIsBehind(selectedChannelRuntime?.lastPushAt, selectedEditedAt);
  const previewTarget = useMemo(
    () => selectedChannel ? channelForPreview(selectedChannel, selectedItem?.id ?? null, previewScope) : null,
    [previewScope, selectedChannel, selectedItem?.id],
  );

  workspaceRef.current = workspace;

  const clearPreview = useCallback(() => {
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setPreviewFrameCount(null);
    setPreviewError(null);
  }, []);

  const scrollToMobileSection = useCallback((id: string) => {
    if (!window.matchMedia("(max-width: 52rem)").matches) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }, []);

  const showMobileConsolePane = useCallback((pane: MobileConsolePane, focusId?: string) => {
    setMobileConsolePane(pane);
    scrollToMobileSection(focusId ?? (pane === "catalog" ? "market-title" : "playlist-title"));
  }, [scrollToMobileSection]);

  const previewRunner = useMemo(() => createLatestTaskRunner<PreviewJob, PreviewResult>({
    async execute({ target, forceRefresh }) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
      try {
        const response = await api("/api/channels/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: target, forceRefresh }),
          signal: controller.signal,
        });
        const frameCount = Number(response.headers.get("X-Frame-Count"));
        return {
          blob: await response.blob(),
          frameCount: Number.isFinite(frameCount) ? frameCount : null,
        };
      } finally {
        window.clearTimeout(timeout);
      }
    },
    apply(result, job) {
      const nextUrl = URL.createObjectURL(result.blob);
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return nextUrl;
      });
      setPreviewFrameCount(result.frameCount);
      setPreviewError(null);
      if (job.announce) {
        toast.success("预览已更新", { description: `${result.frameCount ?? "—"} 帧` });
      }
    },
    onError(error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      const description = timedOut
        ? "生成超过 10 秒，已停止等待。后续修改仍可继续预览。"
        : errorMessage(error);
      setPreviewError(description);
      toast.error("预览失败", { description });
    },
    onBusyChange(next) {
      setPreviewing(next);
      if (next) setPreviewError(null);
    },
  }), [toast]);

  useEffect(() => () => previewRunner.dispose(), [previewRunner]);

  const loadStudio = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [catalogResult, workspaceResult, runtimeResult, instrumentsResult] = await Promise.all([
        jsonApi<CatalogResponse>("/api/catalog"),
        jsonApi<WorkspaceResponse>("/api/workspace"),
        jsonApi<RuntimeState>("/api/state"),
        jsonApi<InstrumentsResponse>("/api/market/instruments"),
      ]);
      const firstChannel = workspaceResult.workspace.channels[0];
      setCatalog(catalogResult.contents);
      setCategories(catalogResult.categories);
      setWorkspace(workspaceResult.workspace);
      workspaceRef.current = workspaceResult.workspace;
      setRuntime(runtimeResult);
      setInstruments(instrumentsResult.instruments);
      setSelectedChannelId(firstChannel?.id ?? null);
      setSelectedItemId(firstChannel?.items[0]?.id ?? null);
      setDirty(false);
      setSaving(false);
      setLastSavedAt(Date.now());
      setEditedAtByChannel({});
      editRevisionRef.current = 0;
      savedRevisionRef.current = 0;
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStudio();
    return clearPreview;
  }, [clearPreview, loadStudio]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void jsonApi<RuntimeState>("/api/state").then(setRuntime).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  const changeWorkspace = useCallback((
    change: (draft: WorkspaceSettings) => void,
    editedChannelId?: string,
  ) => {
    if (!workspaceRef.current) return;
    editRevisionRef.current += 1;
    setWorkspace((current) => {
      if (!current) return current;
      const next = clone(current);
      change(next);
      return next;
    });
    setDirty(true);
    if (editedChannelId) {
      setEditedAtByChannel((current) => ({ ...current, [editedChannelId]: Date.now() }));
    }
  }, []);

  const selectChannel = (channelId: string) => {
    const channel = workspace?.channels.find((entry) => entry.id === channelId);
    const preferredItem = view === "canvas"
      ? channel?.items.find((item) => item.contentId === "creative:canvas") ?? channel?.items[0]
      : channel?.items[0];
    setSelectedChannelId(channelId);
    setSelectedItemId(preferredItem?.id ?? null);
    setPreviewScope("item");
  };

  const selectItem = (itemId: string) => {
    setSelectedItemId(itemId);
    setPreviewScope("item");
  };

  const addChannel = () => {
    if (!workspace || catalog.length === 0) return;
    const channel = newChannel(workspace, catalog, "新频道", "pixel");
    changeWorkspace((draft) => { draft.channels.push(channel); }, channel.id);
    setSelectedChannelId(channel.id);
    setSelectedItemId(channel.items[0]?.id ?? null);
    setPreviewScope("item");
    toast.success("新频道已创建");
  };

  const deleteChannel = (channelId: string) => {
    if (!workspace) return;
    if (workspace.channels.length <= 1) {
      toast.error("至少保留一个频道");
      return;
    }
    const index = workspace.channels.findIndex((channel) => channel.id === channelId);
    const removed = workspace.channels[index];
    if (!removed) return;
    const remaining = workspace.channels.filter((channel) => channel.id !== channelId);
    changeWorkspace((draft) => { draft.channels = remaining; });
    if (selectedChannelId === channelId) {
      const next = remaining[Math.min(index, remaining.length - 1)]!;
      setSelectedChannelId(next.id);
      setSelectedItemId(next.items[0]?.id ?? null);
    }
    toast.success(`已删除“${removed.name}”`, {
      description: "将自动保存并同步频道列表。",
      action: {
        label: "撤销",
        onClick: () => {
          changeWorkspace((draft) => { draft.channels.splice(index, 0, removed); }, removed.id);
          setSelectedChannelId(removed.id);
          setSelectedItemId(removed.items[0]?.id ?? null);
          setPreviewScope("item");
        },
      },
    });
  };

  const updateSelectedChannel = (patch: Partial<ChannelConfig>) => {
    if (!selectedChannel) return;
    changeWorkspace((draft) => {
      const channel = draft.channels.find((entry) => entry.id === selectedChannel.id);
      if (channel) Object.assign(channel, patch);
    }, selectedChannel.id);
  };

  const updateItem = (itemId: string, update: (item: ContentItemConfig) => void) => {
    if (!selectedChannel) return;
    changeWorkspace((draft) => {
      const channel = draft.channels.find((entry) => entry.id === selectedChannel.id);
      const item = channel?.items.find((entry) => entry.id === itemId);
      if (item) update(item);
    }, selectedChannel.id);
  };

  const moveItem = (itemId: string, direction: -1 | 1) => {
    if (!selectedChannel) return;
    changeWorkspace((draft) => {
      const channel = draft.channels.find((entry) => entry.id === selectedChannel.id);
      if (!channel) return;
      const index = channel.items.findIndex((item) => item.id === itemId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= channel.items.length) return;
      const [item] = channel.items.splice(index, 1);
      if (item) channel.items.splice(nextIndex, 0, item);
    }, selectedChannel.id);
  };

  const reorderItem = (itemId: string, targetId: string, position: "before" | "after") => {
    if (!selectedChannel || itemId === targetId) return;
    changeWorkspace((draft) => {
      const channel = draft.channels.find((entry) => entry.id === selectedChannel.id);
      if (!channel) return;
      const fromIndex = channel.items.findIndex((item) => item.id === itemId);
      if (fromIndex < 0) return;
      const [item] = channel.items.splice(fromIndex, 1);
      if (!item) return;
      const targetIndex = channel.items.findIndex((candidate) => candidate.id === targetId);
      if (targetIndex < 0) return;
      channel.items.splice(targetIndex + (position === "after" ? 1 : 0), 0, item);
    }, selectedChannel.id);
  };

  const removeItem = (itemId: string) => {
    if (!selectedChannel) return;
    if (selectedChannel.items.length <= 1) {
      toast.error("频道至少需要一个内容");
      return;
    }
    const index = selectedChannel.items.findIndex((item) => item.id === itemId);
    if (index < 0) return;
    const removed = selectedChannel.items[index]!;
    const nextItems = selectedChannel.items.filter((item) => item.id !== itemId);
    changeWorkspace((draft) => {
      const channel = draft.channels.find((entry) => entry.id === selectedChannel.id);
      if (channel) channel.items = nextItems;
    }, selectedChannel.id);
    if (selectedItemId === itemId) setSelectedItemId(nextItems[Math.max(0, index - 1)]?.id ?? null);
    const runtimeInstrument = removed.contentId === "market:instrument"
      && typeof removed.options.instrumentRef === "string"
      ? instrumentsByRef.get(removed.options.instrumentRef)
      : undefined;
    toast.success(`已移除“${runtimeInstrument?.displaySymbol ?? catalog.find((entry) => entry.id === removed.contentId)?.title ?? removed.contentId}”`, {
      action: {
        label: "撤销",
        onClick: () => {
          changeWorkspace((draft) => {
            const channel = draft.channels.find((entry) => entry.id === selectedChannel.id);
            if (channel) channel.items.splice(index, 0, removed);
          }, selectedChannel.id);
          setSelectedItemId(removed.id);
        },
      },
    });
  };

  const addToChannel = (definition: ContentCatalogEntry) => {
    if (!selectedChannel) return;
    if (selectedChannel.items.some((item) => item.contentId === definition.id)) {
      toast.error("这个内容已经在当前频道中");
      return;
    }
    const item = newItem(definition);
    changeWorkspace((draft) => {
      draft.channels.find((channel) => channel.id === selectedChannel.id)?.items.push(item);
    }, selectedChannel.id);
    setSelectedItemId(item.id);
    setPreviewScope("item");
    showMobileConsolePane("compose", `playlist-item-${item.id}`);
    toast.success(`已加入“${definition.title}”`);
  };

  const createStandalone = (definition: ContentCatalogEntry) => {
    if (!workspace) return;
    const channel = newChannel(workspace, catalog, definition.title, definition.id.split(":")[1] ?? "pixel", newItem(definition));
    changeWorkspace((draft) => { draft.channels.push(channel); }, channel.id);
    setSelectedChannelId(channel.id);
    setSelectedItemId(channel.items[0]?.id ?? null);
    setPreviewScope("item");
    setView("console");
    showMobileConsolePane("compose");
    toast.success("已创建独立旋钮项");
  };

  const rememberInstrument = (instrument: MarketInstrument) => {
    setInstruments((current) => {
      const index = current.findIndex((candidate) => candidate.ref === instrument.ref);
      if (index < 0) return [...current, instrument];
      const next = [...current];
      next[index] = instrument;
      return next;
    });
  };

  const addRuntimeInstrument = (instrument: MarketInstrument) => {
    if (!selectedChannel) return;
    rememberInstrument(instrument);
    if (selectedChannel.items.some((item) =>
      item.contentId === "market:instrument" && item.options.instrumentRef === instrument.ref
    )) {
      toast.error("这个资产已经在当前频道中");
      return;
    }
    const definition = catalog.find((entry) => entry.id === "market:instrument");
    if (!definition) {
      toast.error("通用资产渲染器尚未载入");
      return;
    }
    const item = runtimeInstrumentItem(definition, instrument);
    changeWorkspace((draft) => {
      draft.channels.find((channel) => channel.id === selectedChannel.id)?.items.push(item);
    }, selectedChannel.id);
    setSelectedItemId(item.id);
    setPreviewScope("item");
    showMobileConsolePane("compose", `playlist-item-${item.id}`);
    toast.success(`已加入“${instrument.displaySymbol}”`);
  };

  const createStandaloneRuntimeInstrument = (instrument: MarketInstrument) => {
    if (!workspace) return;
    rememberInstrument(instrument);
    const definition = catalog.find((entry) => entry.id === "market:instrument");
    if (!definition) {
      toast.error("通用资产渲染器尚未载入");
      return;
    }
    const item = runtimeInstrumentItem(definition, instrument);
    const channel = newChannel(
      workspace,
      catalog,
      instrument.displaySymbol.slice(0, 48),
      instrument.baseCode.toLowerCase(),
      item,
    );
    changeWorkspace((draft) => { draft.channels.push(channel); }, channel.id);
    setSelectedChannelId(channel.id);
    setSelectedItemId(item.id);
    setPreviewScope("item");
    setView("console");
    showMobileConsolePane("compose");
    toast.success(`已创建“${instrument.displaySymbol}”独立 App`);
  };

  const addImportedPixelAsset = (asset: ImportedPixelAsset) => {
    if (!selectedChannel) return;
    if (selectedChannel.items.some((item) =>
      item.contentId === "creative:pixel-asset" && item.options.officialId === asset.officialId
    )) {
      toast.error("这个素材已经在当前频道中");
      return;
    }
    const definition = catalog.find((entry) => entry.id === "creative:pixel-asset");
    if (!definition) {
      toast.error("像素素材渲染器尚未载入");
      return;
    }
    const item = importedPixelAssetItem(definition, asset);
    changeWorkspace((draft) => {
      draft.channels.find((channel) => channel.id === selectedChannel.id)?.items.push(item);
    }, selectedChannel.id);
    setSelectedItemId(item.id);
    setPreviewScope("item");
    toast.success(`已导入“${asset.title}”`, {
      description: `${asset.frameCount} 帧 · 已保存到本机，并沿用当前频道的推送策略。`,
    });
  };

  const createStandalonePixelAsset = (asset: ImportedPixelAsset) => {
    if (!workspace) return;
    const definition = catalog.find((entry) => entry.id === "creative:pixel-asset");
    if (!definition) {
      toast.error("像素素材渲染器尚未载入");
      return;
    }
    const item = importedPixelAssetItem(definition, asset);
    const channel = newChannel(
      workspace,
      catalog,
      asset.title.slice(0, 48),
      `pixel_${asset.officialId}`,
      item,
    );
    changeWorkspace((draft) => { draft.channels.push(channel); }, channel.id);
    setSelectedChannelId(channel.id);
    setSelectedItemId(item.id);
    setPreviewScope("item");
    setView("console");
    toast.success(`已创建“${asset.title}”独立 App`, {
      description: "素材已保存到本机，并沿用频道现有的预览与推送链路。",
    });
  };

  const persistWorkspace = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    try {
      while (savedRevisionRef.current !== editRevisionRef.current) {
        if (saveInFlightRef.current) {
          if (!await saveInFlightRef.current) return false;
          continue;
        }
        const snapshot = workspaceRef.current;
        if (!snapshot) return false;
        const revision = editRevisionRef.current;
        const request = (async () => {
          try {
            const data = await jsonApi<SaveResponse>("/api/workspace", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(snapshot),
            });
            setRuntime(data.state);
            savedRevisionRef.current = revision;
            if (editRevisionRef.current === revision) {
              if (JSON.stringify(workspaceRef.current) !== JSON.stringify(data.workspace)) {
                workspaceRef.current = data.workspace;
                setWorkspace(data.workspace);
              }
              setDirty(false);
              setLastSavedAt(Date.now());
            }
            return true;
          } catch (error) {
            toast.error("自动保存失败", { description: errorMessage(error) });
            return false;
          }
        })();
        saveInFlightRef.current = request;
        const saved = await request;
        if (saveInFlightRef.current === request) saveInFlightRef.current = null;
        if (!saved) return false;
      }
      return true;
    } finally {
      if (!saveInFlightRef.current) setSaving(false);
    }
  }, [toast]);

  const renderPreview = useCallback(async (
    target: ChannelConfig,
    announce = false,
    manageBusy = false,
  ): Promise<void> => {
    if (manageBusy) setBusy("preview");
    try {
      await previewRunner.enqueue({ target, announce, forceRefresh: announce });
    } finally {
      if (manageBusy) setBusy(null);
    }
  }, [previewRunner]);

  useEffect(() => {
    if (!dirty || saving) return;
    const timer = window.setTimeout(() => { void persistWorkspace(); }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, persistWorkspace, saving, workspace]);

  useEffect(() => {
    if (view !== "console" || !previewTarget) return;
    const timer = window.setTimeout(() => { void renderPreview(previewTarget); }, 320);
    return () => window.clearTimeout(timer);
  }, [previewTarget, renderPreview, view]);

  const preview = async () => {
    if (!previewTarget) return;
    await renderPreview(previewTarget, true, true);
  };

  const push = async () => {
    if (!selectedChannel) return;
    setBusy("push");
    try {
      if (savedRevisionRef.current !== editRevisionRef.current && !await persistWorkspace()) return;
      const response = await jsonApi<{ state: RuntimeState }>("/api/channels/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: selectedChannel.id }),
      });
      setRuntime(response.state);
      toast.success(`已推送到旋钮项 ${selectedChannel.appName}`);
    } catch (error) {
      toast.error("推送失败", { description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const changeView = (nextView: StudioView) => {
    if (nextView === "canvas" && workspace && selectedItem?.contentId !== "creative:canvas") {
      for (const channel of workspace.channels) {
        const item = channel.items.find((entry) => entry.contentId === "creative:canvas");
        if (item) {
          setSelectedChannelId(channel.id);
          setSelectedItemId(item.id);
          setPreviewScope("item");
          clearPreview();
          break;
        }
      }
    }
    if (nextView === "console") setMobileConsolePane("compose");
    setView(nextView);
  };

  const createCanvasTarget = () => {
    if (!workspace) return;
    const definition = catalog.find((entry) => entry.id === "creative:canvas");
    if (!definition) return;
    const item = newItem(definition);
    if (selectedChannel) {
      changeWorkspace((draft) => {
        draft.channels.find((channel) => channel.id === selectedChannel.id)?.items.push(item);
      }, selectedChannel.id);
      setSelectedItemId(item.id);
    } else {
      const channel = newChannel(workspace, catalog, "我的画板", "canvas", item);
      changeWorkspace((draft) => { draft.channels.push(channel); }, channel.id);
      setSelectedChannelId(channel.id);
      setSelectedItemId(item.id);
    }
    toast.success("画板内容已创建");
  };

  const applyCanvas = (pixels: number[]) => {
    if (!selectedChannel) return;
    if (canvasItem) {
      updateItem(canvasItem.id, (item) => { item.options.pixels = pixels.slice(); });
    } else {
      const definition = catalog.find((entry) => entry.id === "creative:canvas");
      if (!definition || !workspace) return;
      const item = newItem(definition);
      item.options.pixels = pixels.slice();
      if (selectedChannel) {
        changeWorkspace((draft) => {
          draft.channels.find((channel) => channel.id === selectedChannel.id)?.items.push(item);
        }, selectedChannel.id);
        setSelectedItemId(item.id);
      } else {
        const channel = newChannel(workspace, catalog, "我的画板", "canvas", item);
        changeWorkspace((draft) => { draft.channels.push(channel); }, channel.id);
        setSelectedChannelId(channel.id);
        setSelectedItemId(item.id);
      }
    }
    toast.success(`已写入到“${selectedChannel.name}”`, { description: "更改会自动保存，推送后显示在时钟上。" });
  };

  if (loading) {
    return (
      <div className="studio-page">
        <StudioHeader view={view} onViewChange={setView} runtime={runtime} />
        <div className="loading-state" role="status">
          <span className="loading-mark" aria-hidden="true" />
          <strong>正在载入内容工作台</strong>
          <span>连接本机时钟服务…</span>
        </div>
      </div>
    );
  }

  if (loadError || !workspace || !selectedChannel) {
    return (
      <div className="studio-page">
        <StudioHeader view={view} onViewChange={setView} runtime={runtime} />
        <div className="load-error" role="alert">
          <h1>控制台载入失败</h1>
          <p>{loadError ?? "没有可用频道。"}</p>
          <Button type="button" onClick={() => void loadStudio()}><RefreshCw />重新连接</Button>
        </div>
      </div>
    );
  }

  const pageCopy = view === "music"
    ? {
        kicker: "TC002 PIXEL RADIO",
        title: "音乐歌词播放器",
        description: "左侧选歌，右侧同步试听像素歌词；设备固件只在需要时打开。",
      }
    : view === "canvas"
    ? {
        kicker: "TC002 PIXEL STUDIO",
        title: "像素画板",
        description: "绘制像素、落字或转换图片，再写入到所选频道。",
      }
    : view === "library"
      ? {
          kicker: "TC002 PIXEL LIBRARY",
          title: "像素素材库",
          description: "浏览 Ulanzi 官方社区作品，导入到所选频道或设为独立 App。",
        }
      : {
          kicker: "TC002 CONTENT STUDIO",
          title: "时钟内容设置",
          description: "把内容组合成轮播，或作为独立 App 交给时钟旋钮切换。",
        };

  const pageClassName = view === "music"
    ? "studio-page is-music-page"
    : view === "canvas"
    ? "studio-page is-canvas-page"
    : view === "library"
      ? "studio-page is-library-page"
      : "studio-page";

  const layoutClassName = view === "music"
    ? "studio-layout is-music"
    : view === "canvas"
    ? "studio-layout is-canvas"
    : view === "library"
      ? "studio-layout is-library"
      : `studio-layout mobile-pane-${mobileConsolePane}`;

  return (
    <div className={pageClassName}>
      <StudioHeader view={view} onViewChange={changeView} runtime={runtime} />
      <div className="page-heading">
        <div>
          <span>{pageCopy.kicker}</span>
          <h1>{pageCopy.title}</h1>
          <p>{pageCopy.description}</p>
        </div>
      </div>

      {view === "canvas" && (
        <section className="canvas-orientation-gate" aria-labelledby="canvas-orientation-title">
          <span className="canvas-orientation-gate__icon" aria-hidden="true"><RotateCw /></span>
          <div>
            <span>52 × 16 PIXEL CANVAS</span>
            <h2 id="canvas-orientation-title">请将手机横过来</h2>
            <p>画板需要横屏空间来保证像素落点和工具操作准确；内容设置与素材库仍可竖屏使用。</p>
          </div>
        </section>
      )}

      <div className={layoutClassName}>
        {view !== "music" && (
          <ChannelSidebar
            channels={workspace.channels}
            selectedChannelId={selectedChannel.id}
            onSelect={selectChannel}
            onAdd={addChannel}
            onDelete={deleteChannel}
          />
        )}

        {view === "console" && (
          <nav className="mobile-console-navigation" aria-label="手机端内容工作区">
            <Tabs
              value={mobileConsolePane}
              onValueChange={(value) => showMobileConsolePane(value as MobileConsolePane)}
            >
              <TabsList
                className="mobile-console-tabs"
                size="sm"
                rounded
                activeColor="brand"
                activeVariant="solid-fill"
                activeOutline={false}
              >
                <Tab value="compose"><ListOrdered />频道编排</Tab>
                <Tab value="catalog"><Plus />添加内容</Tab>
              </TabsList>
            </Tabs>
          </nav>
        )}

        {view === "console" ? (
          <>
            <WorkspaceEditor
              channel={selectedChannel}
              selectedItemId={selectedItem?.id ?? null}
              catalog={catalog}
              instruments={instruments}
              previewUrl={previewUrl}
              previewing={previewing}
              previewError={previewError}
              previewFrameCount={previewFrameCount}
              previewScope={previewScope}
              busy={busy}
              dirty={dirty}
              saving={saving}
              lastSavedAt={lastSavedAt}
              deviceOutOfDate={deviceOutOfDate}
              lastPushAt={selectedChannelRuntime?.lastPushAt}
              onChannelChange={updateSelectedChannel}
              onSelectItem={selectItem}
              onPreviewScopeChange={setPreviewScope}
              onDurationChange={(itemId, durationMs) => updateItem(itemId, (item) => { item.durationMs = durationMs; })}
              onOptionChange={(itemId, key, value: JsonValue) => updateItem(itemId, (item) => { item.options[key] = value; })}
              onMoveItem={moveItem}
              onReorderItem={reorderItem}
              onRemoveItem={removeItem}
              onTimerStart={(itemId) => {
                updateItem(itemId, (item) => {
                  item.options.running = true;
                  item.options.startedAtMs = Date.now();
                });
                toast.success("计时器已从头开始", { description: "保存并推送后生效。" });
              }}
              onTimerPause={(itemId) => {
                updateItem(itemId, (item) => { item.options.running = false; });
                toast.success("计时器已暂停到起始画面");
              }}
              onOpenCatalog={() => showMobileConsolePane("catalog")}
              onPush={() => void push()}
            />
            <ContentMarket
              categories={categories}
              catalog={catalog}
              category={category}
              instruments={instruments}
              addedContentIds={selectedChannel.items.map((item) => item.contentId)}
              addedInstrumentRefs={selectedChannel.items.flatMap((item) =>
                item.contentId === "market:instrument" && typeof item.options.instrumentRef === "string"
                  ? [item.options.instrumentRef]
                  : []
              )}
              onCategoryChange={setCategory}
              onAdd={addToChannel}
              onStandalone={createStandalone}
              onAddInstrument={addRuntimeInstrument}
              onStandaloneInstrument={createStandaloneRuntimeInstrument}
            />
          </>
        ) : view === "canvas" ? (
          <CanvasWorkspace
            targetItem={canvasItem}
            targetChannelName={selectedChannel.name}
            busy={busy}
            dirty={dirty}
            saving={saving}
            lastSavedAt={lastSavedAt}
            deviceOutOfDate={deviceOutOfDate}
            lastPushAt={selectedChannelRuntime?.lastPushAt}
            onCreateTarget={createCanvasTarget}
            onApply={applyCanvas}
            onPreview={() => void preview()}
            onPush={() => void push()}
          />
        ) : view === "library" ? (
          <PixelAssetLibrary
            targetChannelName={selectedChannel.name}
            addedOfficialIds={selectedChannel.items.flatMap((item) =>
              item.contentId === "creative:pixel-asset" && typeof item.options.officialId === "string"
                ? [item.options.officialId]
                : []
            )}
            onAdd={addImportedPixelAsset}
            onStandalone={createStandalonePixelAsset}
          />
        ) : (
          <MusicPlayer />
        )}
      </div>
    </div>
  );
}
