import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  LoaderCircle,
  MonitorCog,
  Pin,
  PinOff,
  RefreshCw,
  Send,
} from "lucide-react";
import { Button } from "@cladd-ui/react";
import { relativeTimestamp } from "@/lib/studio-state";
import { createZosLink, type ZosDisplay, type ZosLink } from "@/lib/zos-link";
import { errorMessage } from "@/lib/utils";
import type { FirmwareMode } from "@/lib/firmware-mode";
import type { BusyAction } from "@/types";

interface WorkspaceActionsProps {
  busy: BusyAction;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  deviceOutOfDate: boolean;
  lastPushAt?: string;
  disabled?: boolean;
  // 时钟此刻在跑哪套固件。ZOS 下没有官方的 Custom App 接收端，"推送"这个动作
  // 本身不存在——频道改由设备自己拉取。
  firmwareMode?: FirmwareMode;
  /** ZOS 固定设备画面用的是旋钮项名（appName），不是频道显示名。 */
  channelAppName?: string;
  /** 未启用的频道不在设备菜单里，固定它在固件那侧会静默失败。 */
  channelEnabled?: boolean;
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
  firmwareMode = "official",
  channelAppName,
  channelEnabled = true,
  onPreview,
  onPush,
}: WorkspaceActionsProps) {
  const zos = firmwareMode === "zos";
  const linkRef = useRef<ZosLink | null>(null);
  const [display, setDisplay] = useState<ZosDisplay | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  // One read, not a loop. This drives a button label; the live pin state belongs
  // to the 系统 panel, which polls. Every action here answers with the display
  // the service accepted, so the label stays correct without a second cadence.
  useEffect(() => {
    if (!zos) {
      setDisplay(null);
      return;
    }
    let cancelled = false;
    const link = createZosLink({
      onState: (state) => {
        if (!cancelled) setDisplay(state.display);
      },
    });
    linkRef.current = link;
    void link.refreshState();
    return () => {
      cancelled = true;
      linkRef.current = null;
    };
  }, [zos]);

  const applyDisplay = useCallback(async (focus: string | null) => {
    const link = linkRef.current ?? createZosLink();
    setPinBusy(true);
    setPinError(null);
    try {
      setDisplay(await link.setDisplay(focus, focus !== null));
    } catch (error) {
      setPinError(errorMessage(error));
    } finally {
      setPinBusy(false);
    }
  }, []);

  const locked = disabled || busy !== null;
  const pushing = busy === "push";
  const pinnedHere = zos
    && channelAppName !== undefined
    && display?.pinned === true
    && display.focus === channelAppName;
  const saveLabel = saving
    ? "正在自动保存"
    : dirty
      ? "等待自动保存"
      : `已自动保存 · ${relativeTimestamp(lastSavedAt)}`;
  // Under the stock firmware the console pushes and then reports how stale the
  // device copy is. ZOS inverts that: the device fetches the channel's frames
  // when it shows it, so there is no push to be behind on — saying "尚未推送到
  // 设备" about a channel the clock can already display would be the lie.
  const deviceLabel = zos
    ? pinError
      ? `固定失败：${pinError}`
      : !channelEnabled
        ? "频道未启用 · 不在时钟菜单里"
        : pinnedHere
          ? "已固定在时钟上 · 旋钮暂时不切台"
          : "ZOS 主动拉取 · 保存后进入该频道即为最新"
    : !lastPushAt
      ? "尚未推送到设备"
      : deviceOutOfDate
        ? `设备版本待更新 · 上次推送 ${relativeTimestamp(lastPushAt)}`
        : `设备已同步 · ${relativeTimestamp(lastPushAt)}`;

  return (
    <div className="workspace-actions" aria-label="当前频道操作">
      <div className="action-status" role="status" aria-live="polite">
        <span><CheckCircle2 aria-hidden="true" />{saveLabel}</span>
        <span className={(zos ? Boolean(pinError) : deviceOutOfDate) ? "is-behind" : undefined}>
          {zos ? <MonitorCog aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
          {deviceLabel}
        </span>
      </div>
      {onPreview && (
        <Button type="button" disabled={locked} loading={busy === "preview"} onClick={onPreview}>
          <RefreshCw />
          {busy === "preview" ? "渲染中" : "预览"}
        </Button>
      )}
      {zos ? (
        // 频道在 ZOS 上一直可达，控制台能做的是把设备叫到这一台上——即 ADR 0005
        // 那条 PUT /api/os/display。没有 appName（画板页拿不到）就只留状态，不给
        // 一个按下去必然落空的按钮。
        channelAppName !== undefined && (
          <Button
            type="button"
            color="brand"
            variant={pinnedHere ? "transparent" : undefined}
            outline={pinnedHere}
            disabled={Boolean(disabled) || !channelEnabled || pinBusy}
            aria-busy={pinBusy}
            title={channelEnabled
              ? "把时钟切到这个频道并锁住旋钮"
              : "频道未启用，不会出现在时钟菜单里"}
            onClick={() => void applyDisplay(pinnedHere ? null : channelAppName)}
          >
            {pinBusy
              ? <LoaderCircle className="animate-spin" aria-hidden="true" />
              : pinnedHere ? <PinOff /> : <Pin />}
            {pinnedHere ? "交还旋钮" : "在时钟上显示"}
          </Button>
        )
      ) : (
        <Button
          type="button"
          color="brand"
          disabled={Boolean(disabled) || (busy !== null && !pushing)}
          readOnly={pushing}
          aria-busy={pushing}
          onClick={onPush}
        >
          {pushing ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Send />}
          {pushing ? "推送中" : "推送频道"}
        </Button>
      )}
    </div>
  );
}
