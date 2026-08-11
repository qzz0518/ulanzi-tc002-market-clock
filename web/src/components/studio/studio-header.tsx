import { useState } from "react";
import { Circle, Gamepad2, Images, LayoutGrid, MonitorCog, Music2, Palette, Settings2 } from "lucide-react";
import { Button, Tab, Tabs, TabsList, Tooltip } from "@cladd-ui/react";
import type { FirmwareKind, RuntimeState, StudioView } from "@/types";
import { DeviceSettingsDialog } from "@/components/studio/device-settings-dialog";

interface StudioHeaderProps {
  view: StudioView;
  onViewChange: (view: StudioView) => void;
  runtime: RuntimeState | null;
  // 侧载固件直连中：其他视图与常规设置都走官方固件通道，此时全部禁用。
  firmwareLocked?: boolean;
  // 哪种固件在直连（音乐/游戏），决定状态 Chip 与 tooltip 的文案。
  firmwareKind?: FirmwareKind | null;
}

function runtimeLabel(runtime: RuntimeState | null): string {
  if (!runtime) return "正在连接时钟…";
  if (runtime.pushing) return "正在推送";
  if (runtime.healthy) return "设备正常";
  if (runtime.deviceReachable) return "设备待更新";
  return "设备离线";
}

export function StudioHeader({
  view,
  onViewChange,
  runtime,
  firmwareLocked = false,
  firmwareKind = null,
}: StudioHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const kindLabel = firmwareKind === "arcade" ? "游戏固件" : "音乐固件";
  const tone = firmwareLocked
    ? "is-good"
    : runtime?.healthy ? "is-good" : runtime?.degraded || runtime?.deviceReachable ? "is-warn" : "is-offline";
  const statusLabel = firmwareLocked ? `${kindLabel}直连` : runtimeLabel(runtime);
  return (
    <header className="studio-header">
      <div className="brand-lockup" aria-label="Pixel Market，Ulanzi TC002">
        <span className="brand-mark" aria-hidden="true">
          <i /><i /><i /><i />
        </span>
        <span className="brand-name">Pixel Market</span>
        <span className="brand-device">/ Ulanzi TC002</span>
      </div>

      <Tabs value={view} onValueChange={(value) => onViewChange(value as StudioView)}>
        <TabsList aria-label="主视图" className="main-tabs">
          <Tab contentClassName="main-tab__content" value="console" disabled={firmwareLocked}><LayoutGrid />内容</Tab>
          <Tab contentClassName="main-tab__content" value="canvas" disabled={firmwareLocked}><Palette />画板</Tab>
          <Tab contentClassName="main-tab__content" value="library" disabled={firmwareLocked}><Images />素材库</Tab>
          <Tab contentClassName="main-tab__content" value="music"><Music2 />音乐</Tab>
          <Tab contentClassName="main-tab__content" value="game"><Gamepad2 />游戏</Tab>
          {/* 系统固件页不随侧载固件锁定：它自己会如实显示「设备离线」，
              而且接管指令保存在服务端，固件上线后第一次拉取即生效。 */}
          <Tab contentClassName="main-tab__content" value="zos"><MonitorCog />系统</Tab>
        </TabsList>
      </Tabs>

      <div className="header-actions">
        <div className={`device-status ${tone}`} role="status" aria-live="polite">
          <Circle className="device-status__dot" fill="currentColor" aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>
        <Tooltip tooltip={firmwareLocked ? `${kindLabel}运行中，恢复官方固件后可用` : "常规设置"}>
          <Button
            type="button"
            size="sm"
            square
            color="neutral"
            variant="transparent"
            outline={false}
            className="device-settings-trigger"
            aria-label="打开常规设置"
            disabled={firmwareLocked}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 />
          </Button>
        </Tooltip>
      </div>
      <DeviceSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
