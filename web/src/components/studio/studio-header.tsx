import { useRef, useState, type KeyboardEvent, type SVGProps } from "react";
import {
  Battery,
  BatteryCharging,
  BatteryLow,
  BatteryMedium,
  Cpu,
  Gamepad2,
  Gauge,
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
import type { RuntimeState, StudioView } from "@/types";
import { DeviceSettingsDialog } from "@/components/studio/device-settings-dialog";

// The keys TabsList itself turns into a selection (automatic activation).
const TAB_NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

interface StudioHeaderProps {
  view: StudioView;
  // viaKeyboard: arrow-key stepping through the tabs lands without the view's
  // arrival motion (keyboard navigation is never animated).
  onViewChange: (view: StudioView, viaKeyboard: boolean) => void;
  runtime: RuntimeState | null;
  // 时钟此刻在跑哪套固件，以及（只有 ZOS 会上报的）电量读数。
  firmwareStatus?: FirmwareStatus;
  // 侧载的音乐固件直连中：其他视图与常规设置都走官方固件通道，此时全部禁用。
  firmwareLocked?: boolean;
}

// 还没人告诉过我们时钟在跑什么，就等于「没有任何固件在上报」——这正是控制台
// 拿到第一份 /api/os/state 之前的真实处境，不是一个「连接中」的假状态。
const UNREPORTED_FIRMWARE = describeFirmware({
  osState: null,
  musicFirmwareOnline: false,
});

const MODE_ICONS: Record<FirmwareMode, LucideIcon> = {
  official: Cpu,
  music: Music2,
  // 与「系统」标签同一个图标：Chip 说的就是那一页在讲的固件。
  zos: MonitorCog,
};

const MODE_COLORS: Record<FirmwareMode, "neutral" | "cyan" | "brand"> = {
  official: "neutral",
  music: "cyan",
  zos: "brand",
};

// 手机那套读法：充电看闪电，其余按格数掉档，百分比另有文字。
function batteryIcon(battery: FirmwareBattery): LucideIcon {
  if (battery.charging) return BatteryCharging;
  if (battery.percent !== null && battery.percent <= LOW_BATTERY_PERCENT) return BatteryLow;
  if (battery.percent !== null && battery.percent <= 60) return BatteryMedium;
  return Battery;
}

// The device-status chip's glyph. A Chip sizes its icon slot (16px at lg), so a
// filled lucide Circle would fill it edge to edge; the dot sits small inside the
// same slot instead, which keeps its label at the firmware label's offset.
function StatusDot(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" {...props}>
      <circle cx="8" cy="8" r="3.5" fill="currentColor" />
    </svg>
  );
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
}: StudioHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // One-shot: armed by a navigation key, spent by the change it causes. A
  // sticky "last input" would misfile a later click that fires no pointer
  // event (assistive tech, element.click()) as keyboard.
  const keyNavigation = useRef(false);
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

      <Tabs
        value={view}
        onValueChange={(value) => {
          const viaKeyboard = keyNavigation.current;
          keyNavigation.current = false;
          onViewChange(value as StudioView, viaKeyboard);
        }}
      >
        <TabsList
          aria-label="主视图"
          className="main-tabs"
          onKeyDownCapture={(event: KeyboardEvent) => { keyNavigation.current = TAB_NAV_KEYS.has(event.key); }}
          onPointerDownCapture={() => { keyNavigation.current = false; }}
        >
          <Tab contentClassName="main-tab__content" value="console" disabled={firmwareLocked}><LayoutGrid />内容</Tab>
          <Tab contentClassName="main-tab__content" value="canvas" disabled={firmwareLocked}><Palette />画板</Tab>
          <Tab contentClassName="main-tab__content" value="library" disabled={firmwareLocked}><Images />素材库</Tab>
          <Tab contentClassName="main-tab__content" value="music"><Music2 />音乐</Tab>
          <Tab contentClassName="main-tab__content" value="game"><Gamepad2 />游戏</Tab>
          {/* VIBE 页会改写 workspace 并按官方 Custom App 布置频道，侧载固件
              在线时那条通道不存在——和内容/画板/素材库一样锁。 */}
          <Tab contentClassName="main-tab__content" value="vibe" disabled={firmwareLocked}><Gauge />VIBE</Tab>
          {/* 系统固件页不随侧载固件锁定：它自己会如实显示「设备离线」，
              而且接管指令保存在服务端，固件上线后第一次拉取即生效。 */}
          <Tab contentClassName="main-tab__content" value="zos"><MonitorCog />系统</Tab>
        </TabsList>
      </Tabs>

      <div className="header-actions">
        {/* One status group, one grammar: every reading is the same cladd Chip
            (size, outline, type), so firmware, battery and link health sit on
            one baseline instead of a 10px chip beside an 11px mono line. One
            live region for all of it — nested ones double-announce. */}
        <div className="firmware-status" role="status" aria-live="polite">
          <Chip
            className="firmware-chip"
            size="lg"
            color={MODE_COLORS[firmwareStatus.mode]}
            variant="transparent"
            icon={MODE_ICONS[firmwareStatus.mode]}
            iconProps={{ "aria-hidden": true }}
            title={firmwareStatus.description}
            aria-label={`当前固件：${firmwareStatus.label}`}
          >
            {/* ≤34rem only: the link tone, so the phone header shows one chip
                (icon + dot) instead of a second box holding just a dot. A span,
                not an svg — a trailing svg would re-pad the chip at every width. */}
            {showRuntimeStatus && <span className={`device-status__dot firmware-chip__tone ${tone}`} aria-hidden="true" />}
            {/* 窄屏只留图标，标签仍留在 aria-label 里。 */}
            <span className="firmware-chip__label">{firmwareStatus.label}</span>
          </Chip>
          {/* 电量只有 ZOS 会上报；设备不在线或还没读到数就整块消失，
              绝不把上一次的读数当成现在的。 */}
          {battery.text !== null && (
            <Chip
              className="firmware-chip"
              size="lg"
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
          {/* Neutral like the official-firmware chip beside it: the dot is the
              only thing that carries the tone, so the row keeps one accent. */}
          {showRuntimeStatus && (
            <Chip
              className="device-status"
              size="lg"
              color="neutral"
              variant="transparent"
              icon={StatusDot}
              iconProps={{ className: `device-status__dot ${tone}`, "aria-hidden": true }}
              title={runtimeLabel(runtime)}
              aria-label={runtimeLabel(runtime)}
            >
              <span className="device-status__label">{runtimeLabel(runtime)}</span>
            </Chip>
          )}
        </div>
        <Tooltip tooltip={firmwareLocked ? "音乐固件运行中，结束侧载后可用" : "常规设置"}>
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
