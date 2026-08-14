import { Chip } from "@cladd-ui/react";
import { ChevronDown, Info, Star, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatVibeReset,
  formatVibeRelativeTime,
  formatVibeValue,
  isVibeSnapshotOutdated,
  vibeIconMarkup,
  vibeMeterFill,
  vibeSeverity,
  type VibeCatalogEntry,
  type VibeMetric,
  type VibeProviderUsage,
  type VibeUsageSnapshot,
} from "@/lib/vibe";

interface VibeProviderListProps {
  catalog: VibeCatalogEntry[];
  snapshot: VibeUsageSnapshot | null;
  starred: Record<string, string[]>;
  expandedId: string | null;
  nowMs: number;
  busyProviderId: string | null;
  onToggleExpanded: (providerId: string) => void;
  onToggleStar: (providerId: string, key: string) => void;
}

function VibeMetricRow({
  metric,
  starred,
  disabled,
  nowMs,
  onToggleStar,
}: {
  metric: VibeMetric;
  starred: boolean;
  disabled: boolean;
  nowMs: number;
  onToggleStar: () => void;
}) {
  const fill = vibeMeterFill(metric);
  const severity = vibeSeverity(metric.utilization);
  // "—" is the empty state, never a zero: a missing field and an unused quota
  // are different facts, and only one of them is ours to state.
  const value = formatVibeValue(metric) ?? "—";
  const reset = formatVibeReset(metric.resetsAt, nowMs);
  return (
    <li className="vibe-metric">
      <button
        type="button"
        className={cn("vibe-star", starred && "is-on")}
        aria-pressed={starred}
        aria-label={`${starred ? "取消星标" : "设为星标"}：${metric.label}`}
        disabled={disabled}
        onClick={onToggleStar}
      >
        <Star aria-hidden="true" />
      </button>
      <span className="vibe-metric__label">{metric.label}</span>
      {/* The meter is decoration for the number beside it — announcing both
          would read the same value twice. */}
      {fill !== null && (
        <span className={cn("vibe-meter", `is-${severity}`)} aria-hidden="true">
          <span className="vibe-meter__fill" style={{ width: `${fill * 100}%` }} />
        </span>
      )}
      <span className={cn("vibe-metric__value", `is-${severity}`)}>{value}</span>
      {reset && <span className="vibe-metric__reset">{reset}</span>}
    </li>
  );
}

export function VibeProviderList({
  catalog,
  snapshot,
  starred,
  expandedId,
  nowMs,
  busyProviderId,
  onToggleExpanded,
  onToggleStar,
}: VibeProviderListProps) {
  const usageById = new Map<string, VibeProviderUsage>(
    (snapshot?.providers ?? []).map((provider) => [provider.id, provider]),
  );
  const errorById = new Map<string, string>(
    (snapshot?.errors ?? []).map((entry) => [entry.providerId, entry.message]),
  );
  const outdated = isVibeSnapshotOutdated(snapshot, nowMs);
  const outdatedAge = formatVibeRelativeTime(snapshot?.generatedAt, nowMs);

  return (
    <ul className="vibe-providers">
      {catalog.map((entry) => {
        const usage = usageById.get(entry.id);
        const error = errorById.get(entry.id);
        const icon = vibeIconMarkup(entry.id);
        const open = expandedId === entry.id && usage !== undefined;
        const pinned = starred[entry.id] ?? entry.defaultStarred;
        return (
          <li key={entry.id} className={cn("vibe-provider", !usage && "is-empty")}>
            <button
              type="button"
              className="vibe-provider__head"
              aria-expanded={usage ? open : undefined}
              disabled={!usage}
              onClick={() => onToggleExpanded(entry.id)}
            >
              <span
                className="vibe-provider__icon"
                aria-hidden="true"
                // Generated at build time from src/assets/vibe-icons/ — no user
                // or network string ever reaches this map.
                dangerouslySetInnerHTML={icon ? { __html: icon } : undefined}
              />
              <span className="vibe-provider__name">
                <strong>{entry.displayName}</strong>
                <small>{usage ? usage.plan ?? "已登录" : "无数据"}</small>
              </span>
              {/* The server marks a vendor stale when this round failed and its
                  last good numbers are standing in. Saying so is the whole
                  point of the flag — a number nobody can date reads as current
                  otherwise. */}
              {usage?.stale && (
                <Chip size="sm" color="amber" variant="transparent" className="vibe-provider__stale">
                  上次数据
                </Chip>
              )}
              {usage && <span className="vibe-provider__count">{usage.metrics.length} 项指标</span>}
              {usage && <ChevronDown className={cn("vibe-provider__chevron", open && "is-open")} aria-hidden="true" />}
            </button>

            {/* A vendor note is a hint the adapter chose to pass on ("re-login
                for live limits"), not a failure — soft ink, no alert role, and
                it sits above the error so the two never read as one sentence. */}
            {usage?.note && (
              <p className="vibe-provider__note">
                <Info aria-hidden="true" />
                {usage.note}
              </p>
            )}

            {error && (
              <p className="vibe-provider__error" role="alert">
                <TriangleAlert aria-hidden="true" />
                {error}
              </p>
            )}

            {open && usage && (
              <div className="vibe-provider__detail">
                {outdated && (
                  <p className="vibe-outdated" role="status">
                    数据已过时{outdatedAge ? `（${outdatedAge}）` : ""}
                  </p>
                )}
                {usage.metrics.length === 0
                  ? <p className="vibe-note">这个代理暂时没有可用指标。</p>
                  : (
                    <ul className="vibe-metrics">
                      {usage.metrics.map((metric) => (
                        <VibeMetricRow
                          key={metric.key}
                          metric={metric}
                          starred={pinned.includes(metric.key)}
                          disabled={busyProviderId === entry.id}
                          nowMs={nowMs}
                          onToggleStar={() => onToggleStar(entry.id, metric.key)}
                        />
                      ))}
                    </ul>
                  )}
                {usage.spendLines.length > 0 && (
                  <p className="vibe-spend">
                    {usage.spendLines.map((line) => `${line.label}: ${line.value}`).join(" · ")}
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
