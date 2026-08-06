import { CheckCircle2, Clock3, LoaderCircle, RefreshCw, Send } from "lucide-react";
import { Button } from "@cladd-ui/react";
import { relativeTimestamp } from "@/lib/studio-state";
import type { BusyAction } from "@/types";

interface WorkspaceActionsProps {
  busy: BusyAction;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  deviceOutOfDate: boolean;
  lastPushAt?: string;
  disabled?: boolean;
  onPreview?: () => void;
  onPush: () => void;
}

export function WorkspaceActions({
  busy,
  dirty,
  saving,
  lastSavedAt,
  deviceOutOfDate,
  lastPushAt,
  disabled,
  onPreview,
  onPush,
}: WorkspaceActionsProps) {
  const locked = disabled || busy !== null;
  const pushing = busy === "push";
  const saveLabel = saving
    ? "正在自动保存"
    : dirty
      ? "等待自动保存"
      : `已自动保存 · ${relativeTimestamp(lastSavedAt)}`;
  const deviceLabel = !lastPushAt
    ? "尚未推送到设备"
    : deviceOutOfDate
      ? `设备版本待更新 · 上次推送 ${relativeTimestamp(lastPushAt)}`
      : `设备已同步 · ${relativeTimestamp(lastPushAt)}`;

  return (
    <div className="workspace-actions" aria-label="当前频道操作">
      <div className="action-status" role="status" aria-live="polite">
        <span><CheckCircle2 aria-hidden="true" />{saveLabel}</span>
        <span className={deviceOutOfDate ? "is-behind" : undefined}>
          <Clock3 aria-hidden="true" />{deviceLabel}
        </span>
      </div>
      {onPreview && (
        <Button type="button" size="sm" disabled={locked} loading={busy === "preview"} onClick={onPreview}>
          <RefreshCw />
          {busy === "preview" ? "渲染中" : "预览"}
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        color="brand"
        variant="solid-fill"
        disabled={Boolean(disabled) || (busy !== null && !pushing)}
        readOnly={pushing}
        aria-busy={pushing}
        onClick={onPush}
      >
        {pushing ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Send />}
        {pushing ? "推送中" : "推送频道"}
      </Button>
    </div>
  );
}
