import { useCallback, useEffect, useRef, useState } from "react";
import {
  Gamepad2,
  LayoutGrid,
  Music2,
  Pin,
  PinOff,
  Radio,
  RefreshCw,
  Settings2,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import {
  Chip,
  List,
  ListButton,
  ListItem,
  ListSeparator,
  ListTitle,
  Surface,
  Toolbar,
  ToolbarButton,
  ToolbarSeparator,
} from "@cladd-ui/react";
import {
  createZosLink,
  describeDriver,
  describeMirror,
  describeTelemetry,
  entryOnScreen,
  type ZosLink,
  type ZosMenuEntry,
  type ZosMirrorFrame,
  type ZosState,
} from "@/lib/zos-link";
import { ZosMirrorScreen } from "@/components/zos/zos-mirror-screen";
import { useAppToast } from "@/lib/use-app-toast";
import { errorMessage } from "@/lib/utils";

// The mirror is judged against wall-clock age, so the panel needs a clock of
// its own — nothing else here re-renders on a schedule, and a status that only
// updated when a frame arrived could never say "the frames stopped arriving".
const AGE_TICK_MS = 500;

const KIND_ICONS: Record<ZosMenuEntry["kind"], LucideIcon> = {
  channel: LayoutGrid,
  music: Music2,
  game: Gamepad2,
  settings: Settings2,
};

const KIND_LABELS: Record<ZosMenuEntry["kind"], string> = {
  channel: "频道",
  music: "音乐",
  game: "游戏",
  settings: "设置",
};

export function ZosPanel() {
  const toast = useAppToast();
  const linkRef = useRef<ZosLink | null>(null);
  const [state, setState] = useState<ZosState | null>(null);
  const [frame, setFrame] = useState<ZosMirrorFrame | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const link = createZosLink({
      onState: (next) => {
        setState(next);
        setLinkError(null);
      },
      onStateError: (message) => setLinkError(message),
      onFrame: (next) => setFrame(next),
    });
    linkRef.current = link;
    link.start();
    return () => {
      link.stop();
      linkRef.current = null;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const applyDisplay = useCallback(async (
    focus: string | null,
    pinned: boolean,
    label: string,
    description?: string,
  ) => {
    const link = linkRef.current;
    if (!link) return;
    setBusyId(focus ?? "__release__");
    try {
      const display = await link.setDisplay(focus, pinned);
      // Echo the service's own answer instead of the click's intent: it is the
      // sanitized command the firmware will actually pull.
      setState((current) => current === null ? current : { ...current, display });
      toast.success(label, description === undefined ? undefined : { description });
      await link.refreshState();
    } catch (error) {
      toast.error("设备控制失败", { description: errorMessage(error) });
    } finally {
      setBusyId(null);
    }
  }, [toast]);

  const live = state?.live === true;
  const menu = state?.menu ?? [];
  const display = state?.display ?? { focus: null, pinned: false };
  const mirror = describeMirror({
    live,
    frameReceivedAt: frame?.receivedAt ?? null,
    frameAgeMs: frame?.ageMs,
    now,
  });
  const readout = describeTelemetry(state, now);
  const driver = describeDriver(display, menu, state?.telemetry ?? null, live);
  // Offline means we know nothing about the panel, so no row may claim it.
  const deviceTelemetry = live ? state?.telemetry ?? null : null;

  const deviceChip = linkError
    ? { color: "red" as const, icon: TriangleAlert, label: "链路异常" }
    : live
      ? { color: "brand" as const, icon: Radio, label: "设备在线" }
      : { color: "neutral" as const, icon: WifiOff, label: "设备离线" };

  return (
    <main className="zos-shell">
      <div className="zos-topbar">
        <div className="zos-topbar__driver">
          <span>DISPLAY CONTROL</span>
          <strong>{driver.label}</strong>
          <small>{driver.detail}</small>
        </div>
        <div className="zos-topbar__status">
          <Chip
            size="md"
            color={deviceChip.color}
            variant="transparent"
            icon={deviceChip.icon}
            iconProps={{ "aria-hidden": true }}
            aria-live="polite"
          >
            {deviceChip.label}
          </Chip>
          <Chip
            size="md"
            color={mirror.phase === "live" ? "brand" : "neutral"}
            variant="transparent"
            icon={mirror.phase === "live" ? Radio : WifiOff}
            iconProps={{ "aria-hidden": true }}
            aria-live="polite"
          >
            {mirror.label}
          </Chip>
        </div>
      </div>

      <div className="zos-body">
        <section className="zos-stage" aria-label="时钟实时画面">
          <ZosMirrorScreen rgbBase64={frame?.rgbBase64 ?? null} status={mirror} />

          <Toolbar className="zos-actions" size="md" rounded={false} variant="solid">
            <ToolbarButton
              type="button"
              disabled={busyId !== null}
              onClick={() => void linkRef.current?.refreshState()}
            >
              <RefreshCw aria-hidden="true" />立即刷新
            </ToolbarButton>
            <ToolbarSeparator />
            <ToolbarButton
              type="button"
              color="brand"
              variant={display.pinned ? "gradient" : "transparent"}
              disabled={!display.pinned || busyId !== null}
              onClick={() => void applyDisplay(null, false, "已交还旋钮")}
            >
              <PinOff aria-hidden="true" />交还旋钮
            </ToolbarButton>
          </Toolbar>

          {linkError && (
            <p className="zos-note zos-note--error" role="alert">
              读取设备状态失败：{linkError}
            </p>
          )}
          {!live && !linkError && (
            <p className="zos-note" role="status">
              <WifiOff aria-hidden="true" />
              时钟当前没有在跑 ZOS 固件。指令会保存在服务里，固件上线后第一次拉取即生效。
            </p>
          )}
        </section>

        <aside className="zos-side">
          <Surface className="zos-card" variant="solid" outline>
            <List>
              {/* 频道之外还有音乐 / 游戏 / 设置三项，都是设备菜单里的真实条目。 */}
              <ListTitle>设备菜单</ListTitle>
              {menu.length === 0 && (
                <ListItem>
                  <span className="text-cladd-fg-soft">
                    {linkError ? "菜单不可用" : "正在读取设备菜单…"}
                  </span>
                </ListItem>
              )}
              {menu.map((entry) => {
                const Icon = KIND_ICONS[entry.kind];
                const pinnedHere = display.pinned && display.focus === entry.id;
                return (
                  <ListButton
                    key={entry.id}
                    size="md"
                    color="brand"
                    selected={pinnedHere}
                    disabled={busyId !== null}
                    icon={<Icon aria-hidden="true" />}
                    footer={entryOnScreen(entry, deviceTelemetry) ? "设备正在显示" : undefined}
                    after={pinnedHere
                      ? <Chip size="sm" color="brand" icon={Pin} iconProps={{ "aria-hidden": true }}>已固定</Chip>
                      : <Chip size="sm" color="neutral" variant="transparent">{KIND_LABELS[entry.kind]}</Chip>}
                    aria-label={`把设备固定在${entry.label}`}
                    onClick={() => {
                      if (pinnedHere) {
                        void applyDisplay(null, false, "已交还旋钮");
                        return;
                      }
                      // 「设备已固定在…」说早了：PUT 只到服务，设备要等自己下一次
                      // 拉取状态才切（真机实测 2–7 秒）。上面的「控制台接管」一行
                      // 会在心跳确认后改口，这里只承诺已经发生的事。
                      void applyDisplay(
                        entry.id,
                        true,
                        `已固定「${entry.label}」`,
                        "时钟下次拉取状态时切过去，通常几秒内。",
                      );
                    }}
                  >
                    {entry.label}
                  </ListButton>
                );
              })}
              <ListSeparator />
              <ListItem>
                <span className="text-cladd-fg-soft">
                  固定后旋钮暂时不切台；再点一次同一项，或按「交还旋钮」即可放开。
                </span>
              </ListItem>
            </List>
          </Surface>

          <Surface className="zos-card" variant="solid" outline>
            <List>
              <ListTitle>设备状态</ListTitle>
              {readout.map((row) => (
                <ListItem key={row.key}>
                  <span className="text-cladd-fg-soft">{row.label}</span>
                  <span className="ml-auto font-mono">{row.value}</span>
                </ListItem>
              ))}
              {readout.find((row) => row.key === "supplicant")?.note && (
                <ListItem>
                  <span className="text-cladd-fg-softer">
                    {readout.find((row) => row.key === "supplicant")?.note}
                  </span>
                </ListItem>
              )}
            </List>
          </Surface>
        </aside>
      </div>
    </main>
  );
}
