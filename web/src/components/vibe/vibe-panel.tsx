import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip, Surface } from "@cladd-ui/react";
import { Gauge, Info, RefreshCw, TriangleAlert } from "lucide-react";
import { jsonApi } from "@/lib/api";
import type { FirmwareMode } from "@/lib/firmware-mode";
import { useAppToast } from "@/lib/use-app-toast";
import { cn, errorMessage } from "@/lib/utils";
import {
  formatVibeRelativeTime,
  toggleVibeStar,
  vibeSignedInCount,
  VIBE_MAX_STARRED,
  type VibeStarredResponse,
  type VibeStatusResponse,
} from "@/lib/vibe";
import { VibeDisplay } from "@/components/vibe/vibe-display";
import { VibeKeys } from "@/components/vibe/vibe-keys";
import { VibePreview } from "@/components/vibe/vibe-preview";
import { VibeProviderList } from "@/components/vibe/vibe-provider-list";

// Relative times ("3 分钟前", the >10 min Outdated notice) are the only thing on
// this page that changes without an event, so it keeps a slow clock of its own.
const AGE_TICK_MS = 30_000;

interface VibePanelProps {
  /** 上屏 needs it: only ZOS has an「VIBE」page to send the clock to. */
  firmwareMode: FirmwareMode;
}

export function VibePanel({ firmwareMode }: VibePanelProps) {
  const toast = useAppToast();
  const [status, setStatus] = useState<VibeStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [starBusyId, setStarBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // `load` is created once, so it reads the live status through a ref rather
  // than the closure it was born with.
  const statusRef = useRef<VibeStatusResponse | null>(null);
  statusRef.current = status;

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setRefreshing(true);
    try {
      const response = await jsonApi<VibeStatusResponse>(
        refresh ? "/api/vibe/status?refresh=1" : "/api/vibe/status",
      );
      setStatus(response);
      setLoadError(null);
      setNow(Date.now());
    } catch (error) {
      // A failed refresh keeps the page it already drew — throwing the whole
      // panel away over one bad round trip loses the numbers that are still
      // true. Only the very first read has nothing to fall back on.
      if (statusRef.current === null) setLoadError(errorMessage(error));
      else toast.error("刷新失败", { description: errorMessage(error) });
    } finally {
      setLoading(false);
      if (refresh) setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => { void load(false); }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const toggleStar = useCallback(async (providerId: string, key: string) => {
    if (!status) return;
    const entry = status.catalog.find((candidate) => candidate.id === providerId);
    const current = status.starred[providerId] ?? entry?.defaultStarred ?? [];
    const outcome = toggleVibeStar(current, key);
    if (!outcome.ok) {
      toast.error(`每个 Agent 最多 ${VIBE_MAX_STARRED} 个星标`);
      return;
    }
    const previous = status.starred;
    // Optimistic: the star is the one control on this page that must feel
    // instant — it is also what the LED strip reads, so a slow round trip would
    // make the clock look like it ignored the click.
    setStatus({ ...status, starred: { ...previous, [providerId]: outcome.starred } });
    setStarBusyId(providerId);
    try {
      const response = await jsonApi<VibeStarredResponse>("/api/vibe/starred", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, starred: outcome.starred }),
      });
      setStatus((live) => live === null ? live : { ...live, starred: response.starred });
    } catch (error) {
      setStatus((live) => live === null ? live : { ...live, starred: previous });
      toast.error("星标未保存", { description: errorMessage(error) });
    } finally {
      setStarBusyId(null);
    }
  }, [status, toast]);

  if (loading) {
    return (
      <main className="vibe-shell">
        <div className="loading-state" role="status">
          <span className="loading-mark" aria-hidden="true" />
          <strong>正在读取 VIBE</strong>
          <span>正在查看本机各代理的登录…</span>
        </div>
      </main>
    );
  }

  if (loadError || !status) {
    return (
      <main className="vibe-shell">
        {/* 页级标题只由 app.tsx 的骨架出，组件树里一个 h1 都不许有
            （test/zos-panel.test.ts 钉着这条：读屏器会把同一页连报两个名字）。 */}
        <div className="load-error" role="alert">
          <strong className="vibe-error-title">用量页载入失败</strong>
          <p>{loadError ?? "服务没有返回用量状态。"}</p>
          <Button type="button" onClick={() => void load(false)}><RefreshCw aria-hidden="true" />重试</Button>
        </div>
      </main>
    );
  }

  // The strip states a fact, not a connection: how many agents this machine is
  // signed into. Nothing is "connected" any more — the service reads the logins
  // each vendor's own CLI already left here.
  const signedIn = vibeSignedInCount(status.snapshot);
  const collectedAt = formatVibeRelativeTime(status.snapshot?.generatedAt, now);

  return (
    <main className="vibe-shell">
      <Surface variant="solid" outline className="vibe-panel">
        <div className="vibe-strip">
          <span className="vibe-strip__source">
            <Gauge className="vibe-strip__icon" aria-hidden="true" />
            <span className="vibe-strip__text">
              <strong>VIBE</strong>
              <small>读取本机各代理自己的登录</small>
            </span>
          </span>
          <div className="vibe-strip__state" role="status" aria-live="polite">
            <Chip size="md" color={signedIn > 0 ? "brand" : "neutral"} variant="transparent">
              {signedIn > 0 ? `已接入 ${signedIn} 个代理` : "未接入"}
            </Chip>
            {signedIn > 0 && collectedAt && <span className="vibe-strip__age">采集于 {collectedAt}</span>}
          </div>
          <Button
            type="button"
            color="neutral"
            disabled={refreshing}
            className="vibe-strip__refresh"
            onClick={() => void load(true)}
          >
            <RefreshCw aria-hidden="true" />刷新
          </Button>
        </div>

        {signedIn === 0 && (
          // Signed into nothing is the normal first-run state, so it gets an
          // info mark; only a collection that actually failed earns the amber
          // triangle. Dressing a setup step as a fault is the thing this page
          // used to do wrong.
          <div className={cn("vibe-setup", status.error && "is-error")} role="status">
            {status.error ? <TriangleAlert aria-hidden="true" /> : <Info aria-hidden="true" />}
            <div>
              <strong>本机还没有可读的代理登录</strong>
              <p>
                VIBE 不需要额外装什么，它读的是各家代理的 CLI 已经留在这台电脑上的登录：
                登录 Claude Code、Codex CLI 等任一支持的代理后回到这里刷新即可显示。
                OpenRouter 与 Z.ai 没有本地登录可借，需要在下方填 API 密钥。
                在此之前时钟会显示 OFFLINE 提示帧，不会编造数字。
              </p>
              {status.error && <p className="vibe-setup__error">本次采集的失败原因：{status.error}</p>}
            </div>
          </div>
        )}

        <div className="vibe-body">
          {/* Left column: everything about *who is plugged in* — the signed-in
              agents, then the two vendors that need a pasted key. */}
          <div className="vibe-main">
            <section className="vibe-list-section" aria-labelledby="vibe-providers-title">
              <div className="vibe-section__head">
                <h2 id="vibe-providers-title">代理与指标</h2>
                <p>展开可给指标加星；每个代理最多 {VIBE_MAX_STARRED} 个，星标就是屏上显示的两行。</p>
              </div>
              <VibeProviderList
                catalog={status.catalog}
                snapshot={status.snapshot}
                starred={status.starred}
                expandedId={expandedId}
                nowMs={now}
                busyProviderId={starBusyId}
                onToggleExpanded={(id) => setExpandedId((current) => current === id ? null : id)}
                onToggleStar={(providerId, key) => void toggleStar(providerId, key)}
              />
            </section>

            {/* A saved key only pays off after one real collection round, so the
                re-read is the forced one — same path as the 刷新 button. */}
            <VibeKeys catalog={status.catalog} keys={status.keys} onSaved={() => load(true)} />
          </div>

          <aside className="vibe-aside">
            <section className="vibe-preview-section" aria-labelledby="vibe-preview-title">
              <div className="vibe-section__head">
                <h2 id="vibe-preview-title">屏幕预览</h2>
                <p>时钟上旋钮翻的就是这几页；改星标，这里与时钟一起变。</p>
              </div>
              <VibePreview
                catalog={status.catalog}
                snapshot={status.snapshot}
                starred={status.starred}
              />
            </section>

            <VibeDisplay firmwareMode={firmwareMode} />
          </aside>
        </div>
      </Surface>
    </main>
  );
}
