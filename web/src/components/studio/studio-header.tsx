import { useState } from "react";
import { Circle, Images, LayoutGrid, Music2, Palette, Settings2 } from "lucide-react";
import { Button, Tab, Tabs, TabsList, Tooltip } from "@cladd-ui/react";
import type { RuntimeState, StudioView } from "@/types";
import { DeviceSettingsDialog } from "@/components/studio/device-settings-dialog";

interface StudioHeaderProps {
  view: StudioView;
  onViewChange: (view: StudioView) => void;
  runtime: RuntimeState | null;
  // 音乐固件直连中：其他视图与常规设置都走官方固件通道，此时全部禁用。
  musicLocked?: boolean;
}

function runtimeLabel(runtime: RuntimeState | null): string {
  if (!runtime) return "正在连接时钟…";
  if (runtime.pushing) return "正在推送";
  if (runtime.healthy) return "设备正常";
  if (runtime.deviceReachable) return "设备待更新";
  return "设备离线";
}

export function StudioHeader({ view, onViewChange, runtime, musicLocked = false }: StudioHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tone = musicLocked
    ? "is-good"
    : runtime?.healthy ? "is-good" : runtime?.degraded || runtime?.deviceReachable ? "is-warn" : "is-offline";
  const statusLabel = musicLocked ? "音乐固件直连" : runtimeLabel(runtime);
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
          <Tab value="console" disabled={musicLocked}><LayoutGrid />内容</Tab>
          <Tab value="canvas" disabled={musicLocked}><Palette />画板</Tab>
          <Tab value="library" disabled={musicLocked}><Images />素材库</Tab>
          <Tab value="music"><Music2 />音乐</Tab>
        </TabsList>
      </Tabs>

      <div className="header-actions">
        <div className={`device-status ${tone}`} role="status" aria-live="polite">
          <Circle className="device-status__dot" fill="currentColor" aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>
        <Tooltip tooltip={musicLocked ? "音乐固件运行中，恢复官方固件后可用" : "常规设置"}>
          <Button
            type="button"
            size="sm"
            square
            color="neutral"
            variant="transparent"
            outline={false}
            className="device-settings-trigger"
            aria-label="打开常规设置"
            disabled={musicLocked}
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
