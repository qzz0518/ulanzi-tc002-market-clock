import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryWarning,
  Bluetooth,
  CircleDot,
  Pin,
  PinOff,
  Radio,
  Timer,
  TriangleAlert,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button, Chip, Surface } from "@cladd-ui/react";
import {
  createZosLink,
  describeDriver,
  describeMirror,
  describeVitals,
  type ZosInputAction,
  type ZosInputEvent,
  type ZosLink,
  type ZosMirrorFrame,
  type ZosState,
} from "@/lib/zos-link";
import {
  defaultOpenSection,
  describeSections,
  pinIntent,
} from "@/lib/zos-sections";
import type { BleSupport } from "@/lib/ble-provisioning";
import { Callout } from "@/components/callout";
import { ZosMenu, type ZosPinTarget } from "@/components/zos/zos-menu";
import { ZosMirrorScreen } from "@/components/zos/zos-mirror-screen";
import { ZosInputDeck } from "@/components/zos/zos-input-deck";
import { ZosSendRows, type ZosSendSettingsPatch } from "@/components/zos/zos-send-row";
import { BleUnavailableNote } from "@/components/zos/zos-ble-note";
import { ZosProvisionDialog, useBleSupport } from "@/components/zos/zos-provision-dialog";
import { useAppToast } from "@/lib/use-app-toast";
import { errorMessage } from "@/lib/utils";
import "./zos-console.css";

// The mirror is judged against wall-clock age, so the panel needs a clock of
// its own — nothing else here re-renders on a schedule, and a status that only
// updated when a frame arrived could never say "the frames stopped arriving".
const AGE_TICK_MS = 500;

const BATTERY_ICONS = {
  ok: BatteryFull,
  low: BatteryLow,
  critical: BatteryWarning,
} as const;

const BATTERY_COLORS = {
  ok: "neutral",
  low: "orange",
  critical: "red",
} as const;

export function ZosPanel() {
  const toast = useAppToast();
  const linkRef = useRef<ZosLink | null>(null);
  const [state, setState] = useState<ZosState | null>(null);
  const [frame, setFrame] = useState<ZosMirrorFrame | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // One display write at a time, and while it is in flight the menu stops
  // taking commands: the service keeps a single focus, so a second click would
  // only race the first.
  const [busy, setBusy] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);
  // The gate is read here, not only in the dialog: a browser that cannot do
  // Web Bluetooth must never be offered the button in the first place.
  const bleSupport = useBleSupport();
  const headId = useId();

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
    setBusy(true);
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
      setBusy(false);
    }
  }, [toast]);

  const sendInput = useCallback(async (action: ZosInputAction): Promise<ZosInputEvent | null> => {
    const link = linkRef.current;
    if (!link) return null;
    try {
      return await link.sendInput(action);
    } catch (error) {
      toast.error("按键发送失败", { description: errorMessage(error) });
      return null;
    }
  }, [toast]);

  // No debounce of our own: both sliders coalesce their own drags through the
  // component's throttle (SETTINGS_THROTTLE_MS).
  const sendSettings = useCallback(async (patch: ZosSendSettingsPatch) => {
    const link = linkRef.current;
    if (!link) return;
    try {
      const requested = await link.setSettings(patch);
      setState((current) => current === null ? current : { ...current, requestedSettings: requested });
    } catch (error) {
      toast.error("设置下发失败", { description: errorMessage(error) });
    }
  }, [toast]);

  const live = state?.live === true;
  const menu = state?.menu ?? [];
  const display = state?.display ?? { focus: null, pinned: false };
  const requested = state?.requestedSettings ?? null;
  const mirror = describeMirror({
    live,
    frameReceivedAt: frame?.receivedAt ?? null,
    frameAgeMs: frame?.ageMs,
    now,
  });
  const vitals = describeVitals(state);
  const driver = describeDriver(display, menu, state?.telemetry ?? null, live);
  // The device's own root ring: five destinations, content one level down.
  const sections = describeSections({
    menu,
    display,
    telemetry: state?.telemetry ?? null,
    live,
  });

  // The open section is controlled so the first non-empty menu can pick what is
  // open (the menu arrives a poll after mount, which an uncontrolled default
  // would miss). After that the user owns it, "all closed" included — hence the
  // one-shot flag rather than a re-derive on every render. Chosen during render,
  // not in an effect: the menu's first committed frame already has the default
  // section open, so it does not land closed and then animate open on load.
  const [openSection, setOpenSection] = useState<string | undefined>(undefined);
  const [openChosen, setOpenChosen] = useState(false);
  if (!openChosen && sections.length > 0) {
    setOpenChosen(true);
    setOpenSection(defaultOpenSection(sections));
  }

  const deviceChip = linkError
    ? { color: "red" as const, icon: TriangleAlert, label: "链路异常" }
    : live
      ? { color: "brand" as const, icon: Radio, label: "设备在线" }
      : { color: "neutral" as const, icon: WifiOff, label: "设备离线" };

  const release = () => void applyDisplay(null, false, "已交还旋钮");

  // 点一行菜单：固定，或者——同一行再点一次——交还。指令和回执由 pinIntent 决定。
  const pin = (target: ZosPinTarget) => {
    const intent = pinIntent(target);
    void applyDisplay(intent.focus, intent.pinned, intent.title, intent.detail ?? undefined);
  };

  return (
    <main className="zc-shell">
      {/* 页级标题由 app.tsx 的 .page-heading 出，和其他 Tab 同一块骨架；这里再补一个
          sr-only 的 h1 就是同一页有两个名字，读屏器按标题跳转会连报两次。 */}
      <Surface variant="solid" outline className="zc-panel" contentClassName="flex flex-col">
        {/* ── 状态条：此刻为真的事实，各说一次。与 VIBE 同一种排法：左边图标＋标题／
            说明，右边状态芯片。 ── */}
        <div className="zc-strip">
          {/* 只有「谁在开」这一行播报：运行时长每分钟变一次，整条都设成 live
              区域的话读屏器会跟着报时。 */}
          <span className="zc-driver" role="status" aria-live="polite">
            {driver.pinned
              ? <Pin aria-hidden="true" className="zc-driver__icon" />
              : <CircleDot aria-hidden="true" className="zc-driver__icon" />}
            <span className="zc-driver__text">
              <strong>{driver.label}</strong>
              <small>{driver.detail}</small>
            </span>
          </span>
          <span className="zc-strip__state">
            <Chip
              size="md"
              color={deviceChip.color}
              variant="transparent"
              icon={deviceChip.icon}
              iconProps={{ "aria-hidden": true }}
            >
              {deviceChip.label}
            </Chip>
            {/* 每个 chip 自己说清是什么：图标是装饰，读屏器只拿得到文字。 */}
            {live && (
              <span className="zc-strip__vitals">
                {vitals.battery && (
                  <Chip
                    size="md"
                    variant="transparent"
                    color={BATTERY_COLORS[vitals.battery.tone]}
                    icon={vitals.battery.charging ? BatteryCharging : BATTERY_ICONS[vitals.battery.tone]}
                    iconProps={{ "aria-hidden": true }}
                    aria-label={`电量 ${vitals.battery.label}${vitals.battery.charging ? "，充电中" : ""}`}
                  >
                    {vitals.battery.label}{vitals.battery.charging ? " · 充电中" : ""}
                  </Chip>
                )}
                {vitals.wifi && (
                  <Chip
                    size="md"
                    variant="transparent"
                    color="neutral"
                    icon={Wifi}
                    iconProps={{ "aria-hidden": true }}
                    aria-label={`Wi-Fi ${vitals.wifi}`}
                  >
                    {vitals.wifi}
                  </Chip>
                )}
                {vitals.uptime && (
                  <Chip size="md" variant="transparent" color="neutral" icon={Timer} iconProps={{ "aria-hidden": true }}>
                    已运行 {vitals.uptime}
                  </Chip>
                )}
              </span>
            )}
          </span>
        </div>

        {/* ── 主体：左＝设备（镜像 + 遥控甲板），右＝设备菜单与下发 ── */}
        <div className="zc-body">
          <section className="zc-device" aria-label="设备镜像与遥控">
            <ZosMirrorScreen rgbBase64={frame?.rgbBase64 ?? null} status={mirror} />

            <ZosInputDeck live={live} onSend={sendInput} />

            {linkError && (
              <Callout className="zc-callout" icon={TriangleAlert} tone="error" title="读取设备状态失败" role="alert">
                <p>{linkError}</p>
              </Callout>
            )}
            {!live && !linkError && (
              <ZosOfflineNotice
                zosFlashed={state?.zosFlashed === true}
                support={bleSupport}
                onProvision={() => setProvisionOpen(true)}
              />
            )}
          </section>

          {/* 栏头与 VIBE 同一套：一栏一个 h2 加一行说明，栏内小节 h3。 */}
          <aside className="zc-menu" aria-labelledby={`${headId}-menu`}>
            <div className="zc-menu__heading zc-menu__head">
              <h2 id={`${headId}-menu`}>设备菜单</h2>
              <p>与时钟上的菜单一一对应；点条目固定到屏上，再点一次交还。</p>
              {display.pinned && (
                // aria-disabled + 守卫，与菜单行同一个说法：disabled 会让它在每次
                // 固定写入时单独闪到 40%。
                <Button
                  type="button"
                  size="sm"
                  variant="transparent"
                  color="brand"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) release();
                  }}
                >
                  <PinOff aria-hidden="true" />交还旋钮
                </Button>
              )}
            </div>

            <ZosMenu
              sections={sections}
              open={openSection}
              onOpenChange={setOpenSection}
              busy={busy}
              emptyLabel={linkError ? "菜单不可用" : "正在读取设备菜单…"}
              onPin={pin}
            />

            {/* 音量亮度不回读——设备旋钮和侧键要能压过控制台，代价就是这里
                只知道自己发过什么。所以它们是「下发」，不是「读数」。
                同一对滑块也长在常规设置里（zos-send-row.tsx），一份组件两处用。 */}
            <section className="zc-out-section" aria-labelledby={`${headId}-out`}>
              <div className="zc-menu__heading">
                <h3 id={`${headId}-out`}>下发到设备</h3>
                <p>设备不回读这两项，这里显示的是最后一次下发的值。</p>
              </div>
              <ZosSendRows requested={requested} onSend={(patch) => void sendSettings(patch)} />
            </section>
          </aside>
        </div>

      </Surface>

      <ZosProvisionDialog
        open={provisionOpen}
        onOpenChange={setProvisionOpen}
        // The device comes back on the LAN before the 2 s state loop notices;
        // asking once immediately is what makes the panel agree with the dialog.
        onProvisioned={() => void linkRef.current?.refreshState()}
      />
    </main>
  );
}

interface ZosOfflineNoticeProps {
  /** ZOS is in flash, so the clock is still running it — it is just off the air. */
  zosFlashed: boolean;
  support: BleSupport;
  onProvision: () => void;
}

/**
 * What to say when nothing is reporting.
 *
 * Three different situations hide behind one silence, and the console can tell
 * two of them apart: a flashed ZOS that dropped off the network is a clock that
 * needs configuring, not a clock that might be running someone else's firmware.
 * Saying "时钟当前没有在跑 ZOS 固件" to that user is simply wrong, and it hides
 * the one action that would fix it.
 *
 * This is the BLE wizard's second home. 常规设置 is where it lives as a setting
 * (and it stays reachable there when the clock is offline — the dialog reads the
 * sticky zosFlashed, not the live report). This card is the same wizard offered
 * as recovery, right where the user already is: the mirror above it just went
 * dark, and telling that person to go and open a dialog on another tab is a step
 * they should not have to take.
 */
function ZosOfflineNotice({ zosFlashed, support, onProvision }: ZosOfflineNoticeProps) {
  // Same callout either way; only the claim and the weight of the button differ.
  // Brand is earned by the case where the wizard is the known fix.
  const action = support.ok ? (
    <Button type="button" size="md" color={zosFlashed ? "brand" : "neutral"} onClick={onProvision}>
      <Bluetooth />蓝牙配网
    </Button>
  ) : (
    <BleUnavailableNote support={support} />
  );

  if (zosFlashed) {
    return (
      <Callout className="zc-callout" icon={WifiOff} title="时钟掉线了" action={action}>
        {/* One literal: a JSX line break between two CJK sentences renders as a stray space. */}
        <p>{"ZOS 已经刷进闪存，所以它还在跑，只是没有在网上。最常见的原因是换了路由器或改了 Wi-Fi 密码——用蓝牙给它重新配一次就行，不用拆机也不用接线。"}</p>
      </Callout>
    );
  }

  return (
    <Callout className="zc-callout" icon={WifiOff} title="时钟当前没有在跑 ZOS 固件" role="status" action={action}>
      <p>频道固定与音量亮度会保存在服务里，固件上线后第一次拉取即生效；远程按键则不会离线排队。</p>
      {/* 服务只知道「没人上报」。这三种情况在局域网这一侧长得一模一样，
          所以把假设写出来，而不是让按钮替它断言。 */}
      <p>没上报也可能是「刷了 ZOS 但掉线了」。如果时钟面板上确实是 ZOS 的界面，可以直接走蓝牙配网。</p>
    </Callout>
  );
}
