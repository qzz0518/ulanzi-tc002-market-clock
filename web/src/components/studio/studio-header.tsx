import { useState } from "react";
import {
  Battery,
  BatteryCharging,
  BatteryLow,
  BatteryMedium,
  Circle,
  Cpu,
  Gamepad2,
  Images,
  LayoutGrid,
  MonitorCog,
  Music2,
  Palette,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { Button, Chip, Tab, Tabs, TabsList, Tooltip } from "@cladd-ui/react";
import {
  LOW_BATTERY_PERCENT,
  describeFirmware,
  type FirmwareBattery,
  type FirmwareMode,
  type FirmwareStatus,
} from "@/lib/firmware-mode";
import type { FirmwareKind, RuntimeState, StudioView } from "@/types";
import { DeviceSettingsDialog } from "@/components/studio/device-settings-dialog";

interface StudioHeaderProps {
  view: StudioView;
  onViewChange: (view: StudioView) => void;
  runtime: RuntimeState | null;
  // 时钟此刻在跑哪套固件，以及（只有 ZOS 会上报的）电量读数。
  firmwareStatus?: FirmwareStatus;
  // 侧载固件直连中：其他视图与常规设置都走官方固件通道，此时全部禁用。
  firmwareLocked?: boolean;
  // 哪种固件在直连（音乐/游戏），决定设置按钮 tooltip 的文案。
  firmwareKind?: FirmwareKind | null;
}

// 还没人告诉过我们时钟在跑什么，就等于「没有任何固件在上报」——这正是控制台
// 拿到第一份 /api/os/state 之前的真实处境，不是一个「连接中」的假状态。
const UNREPORTED_FIRMWARE = describeFirmware({
  osState: null,
  musicFirmwareOnline: false,
  arcadeOnline: false,
});

const MODE_ICONS: Record<FirmwareMode, LucideIcon> = {
  official: Cpu,
  music: Music2,
  arcade: Gamepad2,
  // 与「系统」标签同一个图标：Chip 说的就是那一页在讲的固件。
  zos: MonitorCog,
};

const MODE_COLORS: Record<FirmwareMode, "neutral" | "cyan" | "brand"> = {
  official: "neutral",
  music: "cyan",
  arcade: "cyan",
  zos: "brand",
};

// 手机那套读法：充电看闪电，其余按格数掉档，百分比另有文字。
function batteryIcon(battery: FirmwareBattery): LucideIcon {
  if (battery.charging) return BatteryCharging;
  if (battery.percent !== null && battery.percent <= LOW_BATTERY_PERCENT) return BatteryLow;
  if (battery.percent !== null && battery.percent <= 60) return BatteryMedium;
  return Battery;
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
  firmwareStatus = UNREPORTED_FIRMWARE,
  firmwareLocked = false,
  firmwareKind = null,
}: StudioHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const kindLabel = firmwareKind === "arcade" ? "游戏固件" : "音乐固件";
  const tone = runtime?.healthy
    ? "is-good"
    : runtime?.degraded || runtime?.deviceReachable ? "is-warn" : "is-offline";
  const { battery } = firmwareStatus;
  const BatteryIcon = batteryIcon(battery);
  // 这盏灯说的是「官方 Custom App 推送链路健不健康」。跑侧载或 ZOS 时那条通道
  // 根本不存在，再报「设备离线」就是在说一台正在上报的设备掉线了——固件身份
  // 交给 Chip，这里只在官方固件下发言。
  const showRuntimeStatus = firmwareStatus.mode === "official";
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
        <div className="firmware-status" role="status" aria-live="polite">
          <Chip
            className="firmware-chip"
            size="sm"
            color={MODE_COLORS[firmwareStatus.mode]}
            variant="transparent"
            icon={MODE_ICONS[firmwareStatus.mode]}
            iconProps={{ "aria-hidden": true }}
            title={firmwareStatus.description}
            aria-label={`当前固件：${firmwareStatus.label}`}
          >
            {/* 窄屏只留图标，标签仍留在 aria-label 里。 */}
            <span className="firmware-chip__label">{firmwareStatus.label}</span>
          </Chip>
          {/* 电量只有 ZOS 会上报；设备不在线或还没读到数就整块消失，
              绝不把上一次的读数当成现在的。 */}
          {battery.text !== null && (
            <Chip
              className="firmware-chip"
              size="sm"
              color={battery.charging ? "green" : battery.low ? "red" : "neutral"}
              variant="transparent"
              icon={BatteryIcon}
              iconProps={{ "aria-hidden": true }}
              title={`电量 ${battery.text}`}
              aria-label={`电量 ${battery.text}`}
            >
              {battery.percent}%
            </Chip>
          )}
        </div>
        {showRuntimeStatus && (
          <div className={`device-status ${tone}`} role="status" aria-live="polite">
            <Circle className="device-status__dot" fill="currentColor" aria-hidden="true" />
            <span>{runtimeLabel(runtime)}</span>
          </div>
        )}
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
      {/* 常规设置读写的是官方固件的设备接口，所以它必须知道时钟在跑什么。
          两个都要给：mode 说的是「谁在上报」，zosFlashed 说的是「闪存里是什么」——
          掉线的 ZOS 两者不一致，而那正是这个对话框最该按 ZOS 招待它的时候。 */}
      <DeviceSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        firmwareMode={firmwareStatus.mode}
        zosFlashed={firmwareStatus.zosFlashed}
      />
    </header>
  );
}
