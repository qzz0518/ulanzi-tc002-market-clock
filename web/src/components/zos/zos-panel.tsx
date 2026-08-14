import { useCallback, useEffect, useRef, useState } from "react";
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
import { Button, Chip, SectionTitle, Surface } from "@cladd-ui/react";
import {
  createZosLink,
  describeDriver,
  describeMirror,
  describeVitals,
  type ZosFirmwareStatus,
  type ZosInputAction,
  type ZosInputEvent,
  type ZosLink,
  type ZosMirrorFrame,
  type ZosState,
  type ZosUpgradeRequest,
} from "@/lib/zos-link";
import { deriveFirmwareMode } from "@/lib/firmware-mode";
import {
  defaultOpenSection,
  describeSections,
  pinIntent,
  type ZosSection,
} from "@/lib/zos-sections";
import type { BleSupport } from "@/lib/ble-provisioning";
import { ZosMenu, type ZosPinTarget } from "@/components/zos/zos-menu";
import { ZosMirrorScreen } from "@/components/zos/zos-mirror-screen";
import { ZosInputDeck } from "@/components/zos/zos-input-deck";
import { ZosSendRows, type ZosSendSettingsPatch } from "@/components/zos/zos-send-row";
import { ZosFirmwareUpdate } from "@/components/zos/zos-firmware-update";
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
  // Three pieces of update state: what the service has packed, the install this
  // session asked for, and the consent a human has to tick by hand. The consent
  // is deliberately not persisted — coming back to this page starts it unticked.
  const [firmware, setFirmware] = useState<ZosFirmwareStatus | null>(null);
  const [firmwareError, setFirmwareError] = useState<string | null>(null);
  const [firmwareBusy, setFirmwareBusy] = useState(false);
  const [upgradeConsent, setUpgradeConsent] = useState(false);
  const [upgrade, setUpgrade] = useState<ZosUpgradeRequest | null>(null);
  // The gate is read here, not only in the dialog: a browser that cannot do
  // Web Bluetooth must never be offered the button in the first place.
  const bleSupport = useBleSupport();

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

  const loadFirmware = useCallback(async () => {
    const link = linkRef.current;
    if (!link) return;
    setFirmwareBusy(true);
    try {
      setFirmware(await link.readFirmwareStatus());
      setFirmwareError(null);
    } catch (error) {
      // A failed read is a failed read. Keeping the previous image facts would
      // leave a button that rewrites flash standing on a stale premise.
      setFirmware(null);
      setFirmwareError(errorMessage(error));
    } finally {
      setFirmwareBusy(false);
    }
  }, []);

  // The image is not device state: it changes only when someone repacks it. So
  // this reads once and 重新读取 covers the rest — no third poll. Effects run in
  // order, so linkRef is already set by the one above.
  useEffect(() => {
    void loadFirmware();
  }, [loadFirmware]);

  const startUpgrade = useCallback(async () => {
    const link = linkRef.current;
    if (!link) return;
    setFirmwareBusy(true);
    try {
      const seq = await link.requestUpgrade();
      setUpgrade({ seq, at: Date.now(), sawOffline: false });
      // Consent covers one install. Updating again after the device comes back
      // means ticking it again — a flash write should not stay unlocked because
      // someone agreed to the previous one.
      setUpgradeConsent(false);
      toast.success("已下发更新请求", {
        description: "时钟会自己下载镜像、写入 flash 并重启，期间面板不响应。",
      });
      // Read the state back at once: the sequence in the pull document is the
      // only evidence that the ask actually reached the wire.
      await link.refreshState();
    } catch (error) {
      toast.error("固件更新请求失败", { description: errorMessage(error) });
    } finally {
      setFirmwareBusy(false);
    }
  }, [toast]);

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
  // This page takes no firmwareMode prop (it polls /api/os/state itself), so the
  // mode is derived here from its own reading. The two sideload heartbeats are
  // not visible from here; passing false can only under-claim, never over-claim,
  // and the one verdict this section needs — "what is reporting is ZOS" — is
  // exactly the one that reading alone can settle.
  const firmwareMode = deriveFirmwareMode({
    osState: state,
    musicFirmwareOnline: false,
    arcadeOnline: false,
  });

  // Having actually seen the device leave is the whole difference between "it
  // rebooted" and "nothing happened". Miss that moment and being online again
  // can no longer be told as a reboot.
  useEffect(() => {
    if (live) return;
    setUpgrade((current) => (
      current === null || current.sawOffline ? current : { ...current, sawOffline: true }
    ));
  }, [live]);

  // The device's own root ring: four destinations, content one level down.
  const sections = describeSections({
    menu,
    display,
    telemetry: state?.telemetry ?? null,
    live,
  });

  // The accordion is controlled so the first non-empty menu can pick what is
  // open (the menu arrives a poll after mount, which an uncontrolled
  // defaultValue would miss). After that the user owns it, "all closed"
  // included — hence the ref rather than a re-derive on every render.
  const [openSection, setOpenSection] = useState<string | undefined>(undefined);
  const openChosenRef = useRef(false);
  const sectionsRef = useRef<ZosSection[]>(sections);
  sectionsRef.current = sections;
  const sectionsReady = sections.length > 0;
  useEffect(() => {
    if (!sectionsReady || openChosenRef.current) return;
    openChosenRef.current = true;
    setOpenSection(defaultOpenSection(sectionsRef.current));
  }, [sectionsReady]);

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
        {/* ── 状态条：此刻为真的事实，各说一次 ── */}
        <div className="zc-strip">
          <Chip
            size="md"
            color={deviceChip.color}
            variant="transparent"
            icon={deviceChip.icon}
            iconProps={{ "aria-hidden": true }}
          >
            {deviceChip.label}
          </Chip>
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
        </div>

        {/* ── 主体：左＝设备（镜像 + 遥控甲板），右＝设备菜单与下发 ── */}
        <div className="zc-body">
          <section className="zc-device" aria-label="设备镜像与遥控">
            <ZosMirrorScreen rgbBase64={frame?.rgbBase64 ?? null} status={mirror} />

            <ZosInputDeck live={live} onSend={sendInput} />

            {linkError && (
              <p className="zc-note zc-note--error" role="alert">
                读取设备状态失败：{linkError}
              </p>
            )}
            {!live && !linkError && (
              <ZosOfflineNotice
                zosFlashed={state?.zosFlashed === true}
                support={bleSupport}
                onProvision={() => setProvisionOpen(true)}
              />
            )}
          </section>

          <aside className="zc-menu">
            <SectionTitle>
              设备菜单
              {display.pinned && (
                <Button
                  type="button"
                  size="sm"
                  variant="transparent"
                  color="brand"
                  className="ml-auto normal-case"
                  disabled={busy}
                  onClick={release}
                >
                  <PinOff aria-hidden="true" />交还旋钮
                </Button>
              )}
            </SectionTitle>

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
            <SectionTitle className="zc-menu__title">下发到设备</SectionTitle>
            <ZosSendRows requested={requested} onSend={(patch) => void sendSettings(patch)} />
          </aside>
        </div>

        {/* Updating the whole device's system firmware belongs to neither
            column: it is not a menu entry and not a send. Hence full width, and
            last. */}
        <ZosFirmwareUpdate
          mode={firmwareMode}
          zosFlashed={state?.zosFlashed === true}
          live={live}
          status={firmware}
          statusError={firmwareError}
          request={upgrade}
          serverSeq={state?.upgradeSeq ?? null}
          now={now}
          busy={firmwareBusy}
          consent={upgradeConsent}
          onConsentChange={setUpgradeConsent}
          onUpgrade={() => void startUpgrade()}
          onRefreshStatus={() => void loadFirmware()}
        />
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
  if (zosFlashed) {
    return (
      <Surface
        variant="solid"
        outline
        color="brand"
        className="mt-3"
        contentClassName="flex flex-col gap-2 p-4"
      >
        <span className="flex items-center gap-2 text-cladd-fg">
          <WifiOff aria-hidden="true" className="size-4" />
          <strong>时钟掉线了</strong>
        </span>
        <span className="text-cladd-fg-soft text-cladd-sm leading-relaxed">
          ZOS 已经刷进闪存，所以它还在跑，只是没有在网上。
          最常见的原因是换了路由器或改了 Wi-Fi 密码——用蓝牙给它重新配一次就行，不用拆机也不用接线。
        </span>
        {support.ok ? (
          <div>
            <Button type="button" size="lg" color="brand" onClick={onProvision}>
              <Bluetooth />蓝牙配网
            </Button>
          </div>
        ) : (
          <BleUnavailableNote support={support} />
        )}
      </Surface>
    );
  }

  return (
    <>
      <p className="zc-note" role="status">
        <WifiOff aria-hidden="true" />
        时钟当前没有在跑 ZOS 固件。频道固定与音量亮度会保存在服务里，固件上线后第一次拉取即生效；远程按键则不会离线排队。
      </p>
      <p className="zc-note">
        {/* 服务只知道「没人上报」。这三种情况在局域网这一侧长得一模一样，
            所以把假设写出来，而不是让按钮替它断言。 */}
        没上报也可能是「刷了 ZOS 但掉线了」。如果时钟面板上确实是 ZOS 的界面，可以直接走蓝牙配网。
      </p>
      {support.ok ? (
        <div className="mt-2">
          <Button type="button" size="md" color="neutral" onClick={onProvision}>
            <Bluetooth />蓝牙配网
          </Button>
        </div>
      ) : (
        <div className="mt-2"><BleUnavailableNote support={support} /></div>
      )}
    </>
  );
}
