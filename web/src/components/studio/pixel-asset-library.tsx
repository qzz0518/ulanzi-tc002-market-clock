import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AppWindow,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Link2,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { Button, Input, Select } from "@cladd-ui/react";
import { jsonApi } from "@/lib/api";
import { useAppToast } from "@/lib/use-app-toast";
import type { FirmwareMode } from "@/lib/firmware-mode";

const CLASSIFICATIONS = [
  { value: "0", label: "全部" },
  { value: "6", label: "文字" },
  { value: "8", label: "AI" },
  { value: "11", label: "自然" },
  { value: "12", label: "娱乐" },
  { value: "13", label: "图形" },
] as const;

const SORTS = [
  { value: "", label: "默认" },
  { value: "new", label: "最新" },
  { value: "hot", label: "热点" },
  { value: "star", label: "支持数" },
] as const;

interface PixelAssetListItem {
  id: string;
  title: string;
  author: string;
  description: string;
  classificationCode: number | null;
  detailUrl: string;
  createdAt: string;
  animatedPreview: boolean;
  previewUrl: string;
}

interface PixelAssetListResponse {
  count: number;
  page: number;
  limit: number;
  items: PixelAssetListItem[];
}

export interface ImportedPixelAsset {
  version: 1;
  ref: string;
  officialId: string;
  title: string;
  author: string;
  sourceUrl: string;
  mimeType: "image/png" | "image/gif";
  frameCount: number;
  nativeDurationMs: number;
  importedAt: string;
  previewUrl: string;
}

interface PixelAssetLibraryProps {
  addedOfficialIds: readonly string[];
  targetChannelName: string;
  // Nothing on this page writes to the device — import lands in the workspace
  // and travels with the channel — so the mode only changes how the last line
  // describes the route, not what any button does.
  firmwareMode?: FirmwareMode;
  onAdd: (asset: ImportedPixelAsset) => void;
  onStandalone: (asset: ImportedPixelAsset) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "导入失败";
}

const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const VIDEO_FITS = [
  { value: "cover", label: "铺满裁剪" },
  { value: "contain", label: "完整留边" },
] as const;

// fetch() cannot report upload progress, so the video upload goes through
// XMLHttpRequest; the server answers with the same asset shape as the
// Ulanzi import endpoint.
function uploadVideo(
  file: File,
  fit: string,
  onProgress: (percent: number) => void,
): Promise<ImportedPixelAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/library/video/import");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      const body = xhr.response as { asset?: ImportedPixelAsset; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.asset) resolve(body.asset);
      else reject(new Error(body?.error ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("网络错误，上传中断"));
    const form = new FormData();
    form.append("file", file);
    form.append("fit", fit);
    xhr.send(form);
  });
}

export function PixelAssetLibrary({
  addedOfficialIds,
  targetChannelName,
  firmwareMode = "official",
  onAdd,
  onStandalone,
}: PixelAssetLibraryProps) {
  const toast = useAppToast();
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [classificationId, setClassificationId] = useState("0");
  const [sort, setSort] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PixelAssetListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoFit, setVideoFit] = useState<"cover" | "contain">("cover");
  const [videoProgress, setVideoProgress] = useState<number | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const added = new Set(addedOfficialIds);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const parameters = new URLSearchParams({
        page: String(page),
        limit: "12",
        search: query,
        classificationId,
        sort,
      });
      setResult(await jsonApi<PixelAssetListResponse>(
        `/api/library/ulanzi/pixel-assets?${parameters}`,
        { signal },
      ));
    } catch (error) {
      if (signal?.aborted) return;
      setLoadError(errorMessage(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [classificationId, page, query, sort]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };

  const importAsset = async (assetSource: string, mode: "channel" | "standalone") => {
    const key = `${assetSource}:${mode}`;
    setImporting(key);
    try {
      const response = await jsonApi<{ asset: ImportedPixelAsset }>(
        "/api/library/ulanzi/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: assetSource }),
        },
      );
      if (mode === "channel") onAdd(response.asset);
      else onStandalone(response.asset);
      if (assetSource === source.trim()) setSource("");
    } catch (error) {
      toast.error("素材导入失败", { description: errorMessage(error) });
    } finally {
      setImporting(null);
    }
  };

  const importVideo = async (mode: "channel" | "standalone") => {
    if (!videoFile) return;
    if (videoFile.size > VIDEO_MAX_BYTES) {
      toast.error("视频超出 100MB 上限", { description: "请压缩或剪短后再导入" });
      return;
    }
    setImporting(`video:${mode}`);
    setVideoProgress(0);
    try {
      const asset = await uploadVideo(videoFile, videoFit, setVideoProgress);
      if (mode === "channel") onAdd(asset);
      else onStandalone(asset);
      setVideoFile(null);
      if (videoInputRef.current) videoInputRef.current.value = "";
    } catch (error) {
      toast.error("视频导入失败", { description: errorMessage(error) });
    } finally {
      setImporting(null);
      setVideoProgress(null);
    }
  };

  // "converting" once the upload itself is done but the server is still busy.
  const videoBusyLabel = videoProgress === null
    ? null
    : videoProgress < 100 ? `上传 ${videoProgress}%` : "转码中…";

  const pageCount = Math.max(1, Math.ceil((result?.count ?? 0) / (result?.limit ?? 12)));

  return (
    <section className="pixel-library" aria-labelledby="pixel-library-title">
      <div className="pixel-library-heading">
        <div>
          <h2 id="pixel-library-title">官方社区作品</h2>
          <span>
            {result ? `${result.count} 个公开作品` : "正在连接官方社区"}
            <i aria-hidden="true">/</i>
            加入目标：<strong>{targetChannelName}</strong>
          </span>
        </div>
        <a
          href="https://ugc.ulanzistudio.com/home/1818114700000000001"
          target="_blank"
          rel="noreferrer"
        >官方页面 <ExternalLink /></a>
      </div>

      <div className="pixel-library-controls">
        <form className="pixel-library-link" onSubmit={(event) => {
          event.preventDefault();
          if (source.trim()) void importAsset(source.trim(), "channel");
        }}>
          <Input
            value={source}
            placeholder="粘贴 Ulanzi contentView 链接"
            inputComponentProps={{ "aria-label": "Ulanzi 像素素材链接" }}
            onChange={setSource}
          />
          <Button
            type="submit"
            color="brand"
            disabled={!source.trim() || importing !== null}
          ><Link2 />{importing === `${source.trim()}:channel` ? "导入中" : "加入所选频道"}</Button>
        </form>

        {/* Layout is inline until the integration pass moves it into globals.css
            (owned by another workstream in this round). */}
        <form
          className="pixel-library-video"
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.35rem" }}
          onSubmit={(event) => {
            event.preventDefault();
            void importVideo("channel");
          }}
        >
          <input
            ref={videoInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.webm,.mkv,.avi"
            hidden
            onChange={(event) => setVideoFile(event.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            disabled={importing !== null}
            onClick={() => videoInputRef.current?.click()}
          ><Upload />导入视频</Button>
          <Select
            aria-label="视频画面适配方式"
            value={videoFit}
            options={VIDEO_FITS.map((entry) => entry.value)}
            renderOption={({ value }) => VIDEO_FITS.find((entry) => entry.value === value)?.label ?? value}
            onChange={(value) => setVideoFit(value as "cover" | "contain")}
          >{VIDEO_FITS.find((entry) => entry.value === videoFit)?.label}</Select>
          <Button
            type="submit"
            color="brand"
            disabled={!videoFile || importing !== null}
          ><Plus />{importing === "video:channel" && videoBusyLabel ? videoBusyLabel : "加入所选频道"}</Button>
          <Button
            type="button"
            disabled={!videoFile || importing !== null}
            onClick={() => void importVideo("standalone")}
          ><AppWindow />{importing === "video:standalone" && videoBusyLabel ? videoBusyLabel : "独立 App"}</Button>
          <span style={{ flexBasis: "100%", fontSize: "0.68rem", opacity: 0.75 }}>
            {videoFile
              ? `${videoFile.name} · ${(videoFile.size / (1024 * 1024)).toFixed(1)} MB`
              : "选择本地视频（≤100MB），服务器转成 52×16 像素动画后进素材库"}
          </span>
        </form>

        <div className="pixel-library-discovery">
          <form className="pixel-library-search" onSubmit={submitSearch}>
            <Input
              value={queryDraft}
              placeholder="搜索标题"
              inputComponentProps={{ "aria-label": "搜索像素素材" }}
              onChange={setQueryDraft}
            />
            <Button type="submit" square aria-label="搜索"><Search /></Button>
          </form>
          <div className="pixel-library-filters">
            <Select
              aria-label="素材分类"
              value={classificationId}
              options={CLASSIFICATIONS.map((entry) => entry.value)}
              renderOption={({ value }) => CLASSIFICATIONS.find((entry) => entry.value === value)?.label ?? value}
              onChange={(value) => { setClassificationId(value); setPage(1); }}
            >{CLASSIFICATIONS.find((entry) => entry.value === classificationId)?.label}</Select>
            <Select
              aria-label="素材排序"
              value={sort}
              options={SORTS.map((entry) => entry.value)}
              renderOption={({ value }) => SORTS.find((entry) => entry.value === value)?.label ?? value}
              onChange={(value) => { setSort(value); setPage(1); }}
            >{SORTS.find((entry) => entry.value === sort)?.label}</Select>
          </div>
        </div>
      </div>

      {loadError ? (
        <div className="pixel-library-state" role="alert">
          <strong>官方素材库暂时不可用</strong>
          <span>{loadError}</span>
          <Button type="button" size="sm" onClick={() => void load()}>重试</Button>
        </div>
      ) : loading && !result ? (
        <div className="pixel-library-state" role="status"><span>正在载入官方素材…</span></div>
      ) : result?.items.length === 0 ? (
        <div className="pixel-library-state"><span>没有找到匹配的素材。</span></div>
      ) : (
        <div className="pixel-library-list" aria-busy={loading}>
          {result?.items.map((item) => {
            const inChannel = added.has(item.id);
            const channelKey = `${item.id}:channel`;
            const standaloneKey = `${item.id}:standalone`;
            return (
              <article key={item.id} className="pixel-library-card">
                <a href={item.detailUrl} target="_blank" rel="noreferrer" className="pixel-library-preview">
                  <img src={item.previewUrl} alt={`${item.title} 像素素材预览`} loading="lazy" />
                  <span>{item.animatedPreview ? <><Film /> 动画</> : <><ImageIcon /> 静态</>}</span>
                </a>
                <div className="pixel-library-copy">
                  <strong title={item.title}>{item.title}</strong>
                  <span title={item.author}>作者：{item.author}</span>
                </div>
                <div className="pixel-library-actions">
                  <Button
                    type="button"
                    size="sm"
                    disabled={inChannel || importing !== null}
                    onClick={() => void importAsset(item.id, "channel")}
                  ><Plus />{inChannel ? "已在频道" : importing === channelKey ? "导入中" : "加入频道"}</Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={importing !== null}
                    onClick={() => void importAsset(item.id, "standalone")}
                  ><AppWindow />{importing === standaloneKey ? "导入中" : "独立 App"}</Button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="pixel-library-pagination">
        <Button type="button" size="sm" square disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)} aria-label="上一页"><ChevronLeft /></Button>
        <span>{page} / {pageCount}</span>
        <Button type="button" size="sm" square disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)} aria-label="下一页"><ChevronRight /></Button>
      </div>
      <p className="pixel-library-note">
        作品由官方社区用户上传；导入会保留作者和来源，不会绕过现有频道链路直接写设备。
        {firmwareMode === "zos"
          ? "时钟正在运行 ZOS：导入的素材随频道保存在本机，设备下次显示该频道时自己拉取，无需推送。"
          : null}
      </p>
    </section>
  );
}
