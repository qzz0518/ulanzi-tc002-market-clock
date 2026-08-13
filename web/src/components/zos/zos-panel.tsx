import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryWarning,
  Bluetooth,
  BluetoothOff,
  ChevronRight,
  CircleDot,
  Pin,
  PinOff,
  Radio,
  RefreshCw,
  Timer,
  TriangleAlert,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  Button,
  Chip,
  CollapsibleIndicator,
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
  SectionTitle,
  Slider,
  Surface,
  SurfaceCut,
} from "@cladd-ui/react";
import {
  ZOS_BRIGHTNESS_MAX,
  ZOS_BRIGHTNESS_MIN,
  ZOS_BRIGHTNESS_START,
  ZOS_VOLUME_MAX,
  ZOS_VOLUME_MIN,
  ZOS_VOLUME_START,
  brightnessText,
  createZosLink,
  describeDriver,
  describeMirror,
  describeResidency,
  describeTelemetry,
  describeVitals,
  volumeText,
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
  type ZosSection,
} from "@/lib/zos-sections";
import type { BleSupport } from "@/lib/ble-provisioning";
import { ZosMenu, type ZosPinTarget } from "@/components/zos/zos-menu";
import { ZosMirrorScreen } from "@/components/zos/zos-mirror-screen";
import { ZosInputDeck } from "@/components/zos/zos-input-deck";
import { ZosProvisionDialog, useBleSupport } from "@/components/zos/zos-provision-dialog";
import { useAppToast } from "@/lib/use-app-toast";
import { errorMessage } from "@/lib/utils";
import "./zos-console.css";

// The mirror is judged against wall-clock age, so the panel needs a clock of
// its own — nothing else here re-renders on a schedule, and a status that only
// updated when a frame arrived could never say "the frames stopped arriving".
const AGE_TICK_MS = 500;

// A drag fires per notch, and one PUT per notch would race itself. The Slider's
// own throttle coalesces it: the first notch goes out at once (so a click on the
// track feels immediate), then at most one write per interval, with a guaranteed
// trailing write for wherever the user settled. Volume and brightness share the
// value because they are now the same control writing to the same endpoint.
const SETTINGS_THROTTLE_MS = 250;

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
  // Web Bluetooth must never be offered the row in the first place.
  const bleSupport = useBleSupport();

  // Local drafts win the display until the service echoes the same value back;
  // without them every 2 s state poll would snap a mid-drag slider to the old
  // number.
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [brightnessDraft, setBrightnessDraft] = useState<number | null>(null);

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
  const sendSettings = useCallback(async (patch: { volume?: number; brightness?: number }) => {
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
  const facts = describeTelemetry(state, now);
  const residency = describeResidency(state);
  const driver = describeDriver(display, menu, state?.telemetry ?? null, live);
  const supplicantNote = facts.find((row) => row.key === "supplicant")?.note;

  // The device's own root ring: four destinations, content one level down.
  const sections = describeSections({
    menu,
    display,
    telemetry: state?.telemetry ?? null,
    live,
    bleAvailable: bleSupport.ok,
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

  // Drafts retire once the service echoes them; until then they own the display.
  const volumeShown = volumeDraft ?? requested?.volume ?? null;
  const brightnessShown = brightnessDraft ?? requested?.brightness ?? null;
  useEffect(() => {
    if (volumeDraft !== null && requested?.volume === volumeDraft) setVolumeDraft(null);
    if (brightnessDraft !== null && requested?.brightness === brightnessDraft) setBrightnessDraft(null);
  }, [requested?.volume, requested?.brightness, volumeDraft, brightnessDraft]);

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
              bleNote={bleSupport.ok ? undefined : <BleUnavailableNote support={bleSupport} />}
              onPin={pin}
              onProvision={() => setProvisionOpen(true)}
            />

            {/* 音量亮度不回读——设备旋钮和侧键要能压过控制台，代价就是这里
                只知道自己发过什么。所以它们是「下发」，不是「读数」。 */}
            <SectionTitle className="zc-menu__title">下发到设备</SectionTitle>
            <div className="zc-out">
              <ZosSendRow
                label="音量"
                min={ZOS_VOLUME_MIN}
                max={ZOS_VOLUME_MAX}
                value={volumeShown ?? ZOS_VOLUME_START}
                sent={volumeShown !== null}
                readout={volumeText(volumeShown)}
                onChange={(value) => {
                  setVolumeDraft(value);
                  void sendSettings({ volume: value });
                }}
              />
              <ZosSendRow
                label="亮度"
                min={ZOS_BRIGHTNESS_MIN}
                max={ZOS_BRIGHTNESS_MAX}
                value={brightnessShown ?? ZOS_BRIGHTNESS_START}
                sent={brightnessShown !== null}
                readout={brightnessText(brightnessShown)}
                onChange={(value) => {
                  setBrightnessDraft(value);
                  void sendSettings({ brightness: value });
                }}
              />
            </div>
          </aside>
        </div>

        {/* ── 诊断：排障才看的事实，默认收起 ── */}
        <CollapsibleRoot>
          <div className="zc-diag">
            <CollapsibleTrigger>
              <Button
                type="button"
                variant="transparent"
                outline={false}
                size="md"
                className="zc-diag__trigger"
                contentClassName="justify-start gap-2 px-0"
              >
                <CollapsibleIndicator className="text-cladd-fg-softer transition-transform data-[open]:rotate-90">
                  <ChevronRight className="size-3.5" />
                </CollapsibleIndicator>
                诊断
                <span className="zc-diag__hint">IP · 内存 · 心跳 · 固件驻留</span>
              </Button>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="zc-diag__inner">
                {/* 只读事实做成「刻进去」的槽，而不是又一张卡片。 */}
                <SurfaceCut className="zc-facts" contentClassName="zc-facts__grid">
                  {facts.map((row) => (
                    <span key={row.key} className="zc-fact">
                      <span>{row.label}</span>
                      <span>{row.value}</span>
                    </span>
                  ))}
                  <span className="zc-fact">
                    <span>{residency.label}</span>
                    <span>{residency.value}</span>
                  </span>
                </SurfaceCut>
                <div className="zc-diag__foot">
                  <Button
                    type="button"
                    size="md"
                    variant="transparent"
                    outline
                    disabled={busy}
                    onClick={() => void linkRef.current?.refreshState()}
                  >
                    <RefreshCw aria-hidden="true" />刷新
                  </Button>
                  {(supplicantNote ?? residency.note) && (
                    <p className="zc-diag__note">
                      {supplicantNote}{supplicantNote && residency.note ? "；" : ""}{residency.note}
                    </p>
                  )}
                </div>
              </div>
            </CollapsiblePanel>
          </div>
        </CollapsibleRoot>
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

interface ZosSendRowProps {
  label: string;
  min: number;
  max: number;
  value: number;
  /** 这一格下发过没有。没有的话滑块的位置只是个起点，不是设备读数。 */
  sent: boolean;
  readout: string;
  onChange: (value: number) => void;
}

/**
 * 一行「下发」：标签在左，滑块 + 右对齐读数在右。
 *
 * 排布、控件、字号都照「常规设置 → 显示与声音」那两行（device-settings-dialog）
 * 来——同一个 cladd Slider，同一套标签/控件/读数的列节奏。音量 0–6 是七格离散
 * 值，单看这一条 NumberField 的加减更贴切，但那样一上一下就是两种控件，全 app
 * 也只有这里这么调音量；一致性优先。写成一个组件而不是两段 JSX，也是为了这两行
 * 只可能长得一样。
 *
 * 与参考实现唯一的实质差别由协议决定：这两个值读不回来（序列号让设备旋钮和侧键
 * 压过控制台），所以没下发过的行读「未下发」、滑块压暗——半满的轨道不能冒充设备
 * 当前的亮度。
 */
function ZosSendRow({ label, min, max, value, sent, readout, onChange }: ZosSendRowProps) {
  return (
    <div className={sent ? "zc-out__row" : "zc-out__row is-unsent"}>
      <span className="zc-out__label">{label}</span>
      <div className="zc-out__control">
        {/* Slider 拿不到 aria-label，label 包住原生 range 才有名字；量程由
            range 自己的 min/max 播报，不必再写进名字里。 */}
        <label className="zc-out__slider">
          <span className="sr-only">{label}</span>
          <Slider
            value={value}
            min={min}
            max={max}
            step={1}
            color="brand"
            throttle={SETTINGS_THROTTLE_MS}
            onChange={onChange}
          />
        </label>
        <span className="zc-out__value">{readout}</span>
      </div>
    </div>
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
 * This is the second home of the BLE wizard, and the loud one: online it is a
 * row under 设置 because it is a setting, but offline it is the only thing
 * worth doing, so it gets a card of its own next to the dead mirror.
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

/** Why there is no button here, in the same words the dialog would have used. */
function BleUnavailableNote({ support }: { support: BleSupport }): ReactNode {
  return (
    <p className="flex items-start gap-2 text-cladd-fg-softer text-cladd-xs leading-relaxed" role="status">
      <BluetoothOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span><strong className="text-cladd-fg-soft">{support.title}</strong>：{support.detail}</span>
    </p>
  );
}
