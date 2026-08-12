import { useCallback, useEffect, useRef, useState } from "react";
import {
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryWarning,
  Gamepad2,
  LayoutGrid,
  Music2,
  Pin,
  PinOff,
  Radio,
  RefreshCw,
  Settings2,
  SunMedium,
  Timer,
  TriangleAlert,
  Volume2,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  Chip,
  List,
  ListButton,
  ListItem,
  ListSeparator,
  ListTitle,
  Slider,
  Surface,
} from "@cladd-ui/react";
import {
  ZOS_GAME_SHORTCUTS,
  brightnessText,
  createZosLink,
  describeDriver,
  describeMirror,
  describeResidency,
  describeTelemetry,
  describeVitals,
  entryOnScreen,
  volumeText,
  zosGameFocus,
  zosPinnedOn,
  zosToggleFocus,
  type ZosInputAction,
  type ZosInputEvent,
  type ZosLink,
  type ZosMenuEntry,
  type ZosMirrorFrame,
  type ZosState,
} from "@/lib/zos-link";
import { ZosMirrorScreen } from "@/components/zos/zos-mirror-screen";
import { ZosInputDeck } from "@/components/zos/zos-input-deck";
import { useAppToast } from "@/lib/use-app-toast";
import { errorMessage } from "@/lib/utils";
import "./zos-console.css";

// The mirror is judged against wall-clock age, so the panel needs a clock of
// its own — nothing else here re-renders on a schedule, and a status that only
// updated when a frame arrived could never say "the frames stopped arriving".
const AGE_TICK_MS = 500;

// Slider drags fire per-notch; one PUT per notch would race itself. A quarter
// second of quiet coalesces a drag into the value the user actually settled on.
const SETTINGS_DEBOUNCE_MS = 250;

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
  const [busyId, setBusyId] = useState<string | null>(null);

  // Local drafts win the display until the service echoes the same value back;
  // without them every 2 s state poll would snap a mid-drag slider to the old
  // number.
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [brightnessDraft, setBrightnessDraft] = useState<number | null>(null);
  const settingsTimerRef = useRef<number | null>(null);
  const settingsPatchRef = useRef<{ volume?: number; brightness?: number }>({});

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

  useEffect(() => () => {
    if (settingsTimerRef.current !== null) window.clearTimeout(settingsTimerRef.current);
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

  const commitSettings = useCallback((patch: { volume?: number; brightness?: number }) => {
    settingsPatchRef.current = { ...settingsPatchRef.current, ...patch };
    if (settingsTimerRef.current !== null) window.clearTimeout(settingsTimerRef.current);
    settingsTimerRef.current = window.setTimeout(() => {
      settingsTimerRef.current = null;
      const payload = settingsPatchRef.current;
      settingsPatchRef.current = {};
      void (async () => {
        const link = linkRef.current;
        if (!link) return;
        try {
          const requested = await link.setSettings(payload);
          setState((current) => current === null ? current : { ...current, requestedSettings: requested });
        } catch (error) {
          toast.error("设置下发失败", { description: errorMessage(error) });
        }
      })();
    }, SETTINGS_DEBOUNCE_MS);
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
  const details = describeTelemetry(state, now);
  const residency = describeResidency(state);
  const driver = describeDriver(display, menu, state?.telemetry ?? null, live);
  const supplicantNote = details.find((row) => row.key === "supplicant")?.note;

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

  return (
    <main className="zc-shell">
      <div className="zc-topbar">
        <div className="zc-topbar__driver">
          {/* The page header above already says ZOS CONSOLE; this labels who is
              driving the panel, which is the thing that changes. */}
          <span>DISPLAY CONTROL</span>
          <strong>{driver.label}</strong>
          <small>{driver.detail}</small>
        </div>
        <div className="zc-topbar__status">
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

      <div className="zc-body">
        <section className="zc-device" aria-label="设备镜像与遥控">
          <ZosMirrorScreen rgbBase64={frame?.rgbBase64 ?? null} status={mirror} />

          {/* Battery / Wi-Fi / uptime are glanceable facts, not table rows.
              Offline they vanish entirely — the chip above already says why. */}
          {live && (
            <div className="zc-vitals" aria-label="设备概况">
              {vitals.battery && (
                <Chip
                  size="md"
                  variant="transparent"
                  color={BATTERY_COLORS[vitals.battery.tone]}
                  icon={vitals.battery.charging ? BatteryCharging : BATTERY_ICONS[vitals.battery.tone]}
                  iconProps={{ "aria-hidden": true }}
                >
                  {vitals.battery.label}{vitals.battery.charging ? " · 充电中" : ""}
                </Chip>
              )}
              {vitals.wifi && (
                <Chip size="md" variant="transparent" color="neutral" icon={Wifi} iconProps={{ "aria-hidden": true }}>
                  {vitals.wifi}
                </Chip>
              )}
              {vitals.uptime && (
                <Chip size="md" variant="transparent" color="neutral" icon={Timer} iconProps={{ "aria-hidden": true }}>
                  已运行 {vitals.uptime}
                </Chip>
              )}
            </div>
          )}

          <ZosInputDeck live={live} onSend={sendInput} />

          {linkError && (
            <p className="zc-note zc-note--error" role="alert">
              读取设备状态失败：{linkError}
            </p>
          )}
          {!live && !linkError && (
            <p className="zc-note" role="status">
              <WifiOff aria-hidden="true" />
              时钟当前没有在跑 ZOS 固件。频道固定与音量亮度会保存在服务里，固件上线后第一次拉取即生效；远程按键则不会离线排队。
            </p>
          )}
        </section>

        <aside className="zc-side">
          <Surface className="zc-card" variant="solid" outline>
            <List>
              {/* 频道之外还有音乐 / 游戏 / 设置三项，都是设备菜单里的真实条目。 */}
              <ListTitle>
                <span className="zc-cardtitle">
                  设备菜单
                  <Button
                    type="button"
                    size="sm"
                    variant="transparent"
                    color="brand"
                    disabled={!display.pinned || busyId !== null}
                    onClick={() => void applyDisplay(null, false, "已交还旋钮")}
                  >
                    <PinOff aria-hidden="true" />交还旋钮
                  </Button>
                </span>
              </ListTitle>
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
                  <div key={entry.id}>
                    <ListButton
                      size="md"
                      color="brand"
                      selected={pinnedHere}
                      disabled={busyId !== null}
                      icon={<Icon aria-hidden="true" />}
                      footer={entryOnScreenLabel(entry, state)}
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
                        // 拉取状态才切（真机实测 2–7 秒）。顶部的「控制台接管」一行
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
                    {/* game:<id> 直达某个游戏；纯 "game" 只到游戏列表（真机实测）。 */}
                    {entry.kind === "game" && (
                      <div className="zc-games" role="group" aria-label="直达游戏">
                        {ZOS_GAME_SHORTCUTS.map((game) => {
                          const focus = zosGameFocus(game.id);
                          const pinnedGame = zosPinnedOn(display, focus);
                          return (
                            <Button
                              key={game.id}
                              type="button"
                              size="sm"
                              variant={pinnedGame ? "gradient" : "transparent"}
                              color="brand"
                              outline
                              disabled={busyId !== null}
                              onClick={() => {
                                const next = zosToggleFocus(display, focus);
                                if (next === null) {
                                  void applyDisplay(null, false, "已交还旋钮");
                                } else {
                                  void applyDisplay(
                                    next,
                                    true,
                                    `已固定「${game.label}」`,
                                    "时钟下次拉取状态时直接进入游戏。",
                                  );
                                }
                              }}
                            >
                              {game.label}
                            </Button>
                          );
                        })}
                      </div>
                    )}
                  </div>
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

          <Surface className="zc-card" variant="solid" outline>
            <List>
              <ListTitle>音量与亮度</ListTitle>
              <ListItem>
                <div className="zc-setting">
                  <span className="zc-setting__label">
                    <Volume2 aria-hidden="true" />音量
                  </span>
                  <label className={volumeShown === null ? "zc-setting__slider is-unset" : "zc-setting__slider"}>
                    <span className="sr-only">音量（0 到 6 级）</span>
                    <Slider
                      value={volumeShown ?? 0}
                      min={0}
                      max={6}
                      step={1}
                      color="brand"
                      onChange={(value: number) => {
                        setVolumeDraft(value);
                        commitSettings({ volume: value });
                      }}
                    />
                  </label>
                  <span className="zc-setting__value">{volumeText(volumeShown)}</span>
                </div>
              </ListItem>
              <ListItem>
                <div className="zc-setting">
                  <span className="zc-setting__label">
                    <SunMedium aria-hidden="true" />亮度
                  </span>
                  <label className={brightnessShown === null ? "zc-setting__slider is-unset" : "zc-setting__slider"}>
                    <span className="sr-only">亮度（1 到 10 级）</span>
                    <Slider
                      value={brightnessShown ?? 1}
                      min={1}
                      max={10}
                      step={1}
                      color="brand"
                      onChange={(value: number) => {
                        setBrightnessDraft(value);
                        commitSettings({ brightness: value });
                      }}
                    />
                  </label>
                  <span className="zc-setting__value">{brightnessText(brightnessShown)}</span>
                </div>
              </ListItem>
              <ListItem>
                <span className="text-cladd-fg-softer">
                  这里显示的是控制台最近一次请求；设备上旋钮侧键也能调，那边的改动不会回读到这里。
                </span>
              </ListItem>
            </List>
          </Surface>

          <Surface className="zc-card" variant="solid" outline>
            <List>
              <ListTitle>
                <span className="zc-cardtitle">
                  详细状态
                  <Button
                    type="button"
                    size="sm"
                    variant="transparent"
                    disabled={busyId !== null}
                    aria-label="立即刷新设备状态"
                    onClick={() => void linkRef.current?.refreshState()}
                  >
                    <RefreshCw aria-hidden="true" />刷新
                  </Button>
                </span>
              </ListTitle>
              {details.map((row) => (
                <ListItem key={row.key}>
                  <span className="text-cladd-fg-soft">{row.label}</span>
                  <span className="ml-auto font-mono">{row.value}</span>
                </ListItem>
              ))}
              <ListItem>
                <span className="text-cladd-fg-soft">{residency.label}</span>
                <span className="ml-auto font-mono">{residency.value}</span>
              </ListItem>
              {(supplicantNote ?? residency.note) && (
                <ListItem>
                  <span className="text-cladd-fg-softer">
                    {supplicantNote}{supplicantNote && residency.note ? " " : ""}{residency.note}
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

/**
 * Footer line for a menu row, from the device's last report only. Offline no
 * row may claim the device is showing anything.
 */
function entryOnScreenLabel(entry: ZosMenuEntry, state: ZosState | null): string | undefined {
  if (state?.live !== true || !state.telemetry) return undefined;
  return entryOnScreen(entry, state.telemetry) ? "设备正在显示" : undefined;
}
