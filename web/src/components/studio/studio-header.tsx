import { useState } from "react";
import { Circle, Images, LayoutGrid, Music2, Palette, Settings2 } from "lucide-react";
import { Button, Tab, Tabs, TabsList, Tooltip } from "@cladd-ui/react";
import type { RuntimeState, StudioView } from "@/types";
import { DeviceSettingsDialog } from "@/components/studio/device-settings-dialog";

interface StudioHeaderProps {
  view: StudioView;
  onViewChange: (view: StudioView) => void;
  runtime: RuntimeState | null;
}

function runtimeLabel(runtime: RuntimeState | null): string {
  if (!runtime) return "正在连接时钟…";
  if (runtime.pushing) return "正在推送";
  if (runtime.healthy) return "设备正常";
  if (runtime.deviceReachable) return "设备待更新";
  return "设备离线";
}

export function StudioHeader({ view, onViewChange, runtime }: StudioHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tone = runtime?.healthy ? "is-good" : runtime?.degraded || runtime?.deviceReachable ? "is-warn" : "is-offline";
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
          <Tab value="console"><LayoutGrid />内容</Tab>
          <Tab value="canvas"><Palette />画板</Tab>
          <Tab value="library"><Images />素材库</Tab>
          <Tab value="music"><Music2 />音乐</Tab>
        </TabsList>
      </Tabs>

      <div className="header-actions">
        <div className={`device-status ${tone}`} role="status" aria-live="polite">
          <Circle className="device-status__dot" fill="currentColor" aria-hidden="true" />
          <span>{runtimeLabel(runtime)}</span>
        </div>
        <Tooltip tooltip="常规设置">
          <Button
            type="button"
            size="sm"
            square
            color="neutral"
            variant="transparent"
            outline={false}
            className="device-settings-trigger"
            aria-label="打开常规设置"
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
