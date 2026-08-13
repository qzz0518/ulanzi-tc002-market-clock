import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bluetooth,
  Check,
  Copy,
  RefreshCw,
  RotateCcw,
  Save,
  Smartphone,
  SlidersHorizontal,
  Wifi,
  WifiOff,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  Button,
  Dialog,
  Input,
  Popover,
  PopoverRoot,
  PopoverTrigger,
  Segmented,
  SegmentedButton,
  Select,
  Slider,
  Surface,
  SurfaceCut,
  Switch,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
} from "@cladd-ui/react";
import { jsonApi } from "@/lib/api";
import {
  DEVICE_INFO_ROWS,
  describeZosDeviceFacts,
  deviceSettingsSurface,
} from "@/lib/device-settings-fields";
import type { FirmwareMode } from "@/lib/firmware-mode";
import type { BleSupport } from "@/lib/ble-provisioning";
import {
  createZosLink,
  type ZosLink,
  type ZosReadoutRow,
  type ZosRequestedSettings,
  type ZosSleepReport,
  type ZosState,
} from "@/lib/zos-link";
import { ZosSendRows, type ZosSendSettingsPatch } from "@/components/zos/zos-send-row";
import {
  SLEEP_IDLE_OPTIONS,
  SLEEP_WINDOW_MINUTES,
  effectiveSleepView,
  reconcileSleepPending,
  sleepIdleLabel,
  sleepMinuteLabel,
  sleepSwitchHelp,
  type SleepPatch,
} from "@/lib/zos-sleep";
import { BleUnavailableNote } from "@/components/zos/zos-ble-note";
import { ZosProvisionDialog, useBleSupport } from "@/components/zos/zos-provision-dialog";
import { useAppToast } from "@/lib/use-app-toast";
import { errorMessage } from "@/lib/utils";
import type {
  DeviceCarouselSpeed,
  DeviceGeneralSettings,
  DeviceHostProbe,
  DeviceHostStatus,
  DeviceInfo,
  DeviceTimezone,
  ControlAccessInfo,
} from "@/types";

interface DeviceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 这个对话框有三副面孔，取决于时钟此刻在跑什么（见 lib/device-settings-fields）：
   * 官方固件读写 /getConfig、/setConfig 与 /getDeviceInfo；ZOS 把整套固件换掉了，
   * 那三个端点只会回 503，但它自己有一套能设的和能读的；侧载固件则两样都没有。
   */
  firmwareMode?: FirmwareMode;
  /**
   * ZOS 在这台钟的闪存里（服务端记的黏性事实）。掉线的 ZOS 仍然是 ZOS，
   * 而那正是最需要这个对话框的时候——蓝牙配网就在里面。
   */
  zosFlashed?: boolean;
}

/** 心跳「多少秒前」要自己走秒，别的都只在设备上报时才变。 */
const FACT_TICK_MS = 1_000;

interface DeviceSettingsResponse {
  settings: DeviceGeneralSettings;
}

interface ControlAccessResponse {
  access: ControlAccessInfo;
}

interface DeviceInfoResponse {
  info: DeviceInfo;
}

interface DeviceHostResponse {
  host: DeviceHostStatus;
}

interface DeviceHostWriteResponse {
  host: DeviceHostStatus;
  probe: DeviceHostProbe;
}

// Mirrors validateClockHost in src/config.ts, field by field and in the same order
// so the two can be diffed by eye. The server stays authoritative; this only spares
// the user a round trip on the obvious paste of "http://192.168.1.9:80".
export function clockHostError(value: string): string | null {
  const host = value.trim();
  if (host.length === 0) return "请填写时钟的局域网地址";
  if (host.length > 253) return "地址过长";
  if (host.includes("://")) return "不要带 http:// 前缀";
  if (host.includes(":")) return "不要带端口号";
  if (/[\s/?#@]/.test(host)) return "地址不能包含空格或 / ? # @";
  return null;
}

const CAROUSEL_SPEEDS: Array<{ value: DeviceCarouselSpeed; label: string }> = [
  { value: 0, label: "不翻页" },
  { value: 10, label: "10 秒" },
  { value: 20, label: "20 秒" },
  { value: 30, label: "30 秒" },
  { value: 40, label: "40 秒" },
  { value: 50, label: "50 秒" },
  { value: 60, label: "60 秒" },
];

const TIMEZONES: DeviceTimezone[] = [
  "UTC-12", "UTC-11", "UTC-10", "UTC-9", "UTC-8", "UTC-7", "UTC-6",
  "UTC-5", "UTC-4", "UTC-3", "UTC-2", "UTC-1", "UTC+0", "UTC+1",
  "UTC+2", "UTC+3", "UTC+4", "UTC+5", "UTC+6", "UTC+7", "UTC+8",
  "UTC+9", "UTC+10", "UTC+11", "UTC+12",
];

function copySettings(settings: DeviceGeneralSettings): DeviceGeneralSettings {
  return { ...settings, brightness: { ...settings.brightness } };
}

function labelFor<T extends string | number>(
  options: Array<{ value: T; label: string }>,
  value: T,
): string {
  return options.find((option) => option.value === value)?.label ?? String(value);
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy unavailable");
}

// lucide-react no longer ships brand icons, so the two marks are inlined;
// Button's `[&>svg]:size-4` handles the sizing.
function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.09 0 4.41-2.69 5.38-5.25 5.66.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.67.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.67l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23Zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64Z" />
    </svg>
  );
}

interface SettingFieldProps {
  id: string;
  label: string;
  help?: string;
  controlClassName?: string;
  children: React.ReactNode;
}

function SettingField({ id, label, help, controlClassName, children }: SettingFieldProps) {
  return (
    <div className="device-setting-field">
      <div className="device-setting-copy">
        <label id={`${id}-label`} htmlFor={id}>{label}</label>
        {help && <p id={`${id}-help`}>{help}</p>}
      </div>
      <div className={controlClassName ? `device-setting-control ${controlClassName}` : "device-setting-control"}>{children}</div>
    </div>
  );
}

interface DeviceSettingSwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function DeviceSettingSwitch({ label, checked, onChange }: DeviceSettingSwitchProps) {
  return (
    <label className="device-settings-switch">
      <span className="sr-only">{label}</span>
      <Switch
        as="span"
        input
        checked={checked}
        onChange={onChange}
      />
    </label>
  );
}

interface DeviceHostPanelProps {
  info: DeviceInfo | null;
  infoLoading: boolean;
  infoError: string | null;
  host: DeviceHostStatus | null;
  hostDraft: string;
  savingHost: boolean;
  /** ZOS 不提供官方固件的 /getDeviceInfo，读不到不是网络问题。 */
  zos?: boolean;
  /**
   * ZOS 的遥测块，已经解析成文字（describeZosDeviceFacts）。null = 还没拿到第一份
   * 状态；空数组不会出现。官方固件那一列的字段这里一个都没有，反过来也一样，所以
   * 这不是「同一张表填不满」，是两张不同的表。
   */
  zosFacts?: ZosReadoutRow[] | null;
  onHostDraftChange: (value: string) => void;
  onSaveHost: () => void;
  onResetHost: () => void;
  onRetry: () => void;
}

// Exported for tests: cladd's Dialog renders through a portal and server-renders to
// an empty string, so the panel body is the only seam that can be asserted on.
export function DeviceHostPanel({
  info,
  infoLoading,
  infoError,
  host,
  hostDraft,
  savingHost,
  zos = false,
  zosFacts = null,
  onHostDraftChange,
  onSaveHost,
  onResetHost,
  onRetry,
}: DeviceHostPanelProps) {
  const draftError = clockHostError(hostDraft);
  const dirty = host ? hostDraft.trim() !== host.host : hostDraft.trim().length > 0;
  const hasAnyField = info ? DEVICE_INFO_ROWS.some((row) => info[row.key]) : false;

  return (
    <>
      <section className="device-settings-section" aria-labelledby="settings-info-title">
        <div className="device-settings-section__heading">
          <span>01</span>
          <div>
            <h3 id="settings-info-title">{zos ? "设备状态" : "设备信息"}</h3>
            {/* Under ZOS the section needs no blurb: every row below is a
                labelled value, and explaining the reporting cadence is telling
                the user about the protocol rather than about their clock. */}
            {zos ? null : <p>与时钟本机的「设备信息」页一致。</p>}
          </div>
        </div>
        {zos ? (
          zosFacts === null ? (
            <div className="device-settings-state" role="status">
              <span className="loading-mark" aria-hidden="true" />
              <strong>正在读取设备状态</strong>
              <span>等时钟的下一次上报。</span>
            </div>
          ) : (
            // 同一套只读行的排版（见下面官方固件那份），行里的每一句话都来自
            // 系统面板用的那几个 helper——两处说的必须是同一台设备。
            <dl className="device-settings-fields device-info-list">
              {zosFacts.map((row) => (
                <div key={row.key} className="device-setting-field">
                  <div className="device-setting-copy">
                    <dt>{row.label}</dt>
                    {row.note && <p>{row.note}</p>}
                  </div>
                  <dd className="device-setting-control device-info-value">{row.value}</dd>
                </div>
              ))}
            </dl>
          )
        ) : infoLoading && !hasAnyField ? (
          <div className="device-settings-state" role="status">
            <span className="loading-mark" aria-hidden="true" />
            <strong>正在读取设备信息</strong>
            <span>正在访问 {host?.host ?? "时钟"}。</span>
          </div>
        ) : hasAnyField && info ? (
          // Same row markup as every settings field, so the two tabs share one
          // type scale instead of inventing a second one for read-only rows.
          <dl className="device-settings-fields device-info-list">
            {DEVICE_INFO_ROWS.map((row) => {
              const value = info[row.key];
              return (
                <div key={row.key} className="device-setting-field">
                  <div className="device-setting-copy"><dt>{row.label}</dt></div>
                  <dd className="device-setting-control device-info-value">
                    {value ? row.format?.(value) ?? value : "—"}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <div className="device-settings-state is-error" role="alert">
            <strong>无法读取设备信息</strong>
            <span>{infoError ?? "时钟没有响应。请在下方确认它的局域网地址。"}</span>
            <Button type="button" size="sm" onClick={onRetry}><RefreshCw />重试</Button>
          </div>
        )}
      </section>

      <section className="device-settings-section" aria-labelledby="settings-host-title">
        <div className="device-settings-section__heading">
          <span>02</span>
          <div>
            <h3 id="settings-host-title">时钟地址</h3>
            {/* The address is not how ZOS is reached — the device pulls — but
                saying so here explains our architecture to someone who only
                wants to know whether to touch the field. What they need is the
                consequence: under ZOS it changes nothing today, and it is what
                the stock firmware would use. */}
            <p>
              {zos
                ? "ZOS 用不到这个地址；换回官方固件时才会用它。"
                : "时钟换了 IP 就在这里改，立即生效，重启后仍然有效。"}
            </p>
          </div>
        </div>
        <div className="device-settings-fields">
          <SettingField
            id="device-clock-host"
            label="局域网地址"
            help="填 IP 或主机名，不要带 http:// 和端口号。"
            controlClassName="device-setting-control--host"
          >
            <Input
              inputId="device-clock-host"
              size="md"
              className="device-host-input"
              value={hostDraft}
              placeholder="192.168.1.9"
              valid={!draftError || !dirty}
              errorMessage={dirty ? draftError : undefined}
              onChange={(value) => onHostDraftChange(value)}
            />
            <Button
              type="button"
              size="md"
              color="brand"
              loading={savingHost}
              disabled={savingHost || Boolean(draftError) || !dirty}
              onClick={onSaveHost}
            >
              <Save />保存并连接
            </Button>
          </SettingField>
          {host && host.source === "override" && host.envHost !== host.host ? (
            <p className="device-host-note">
              安装时配置的是 <code>{host.envHost}</code>，当前生效的是控制台设置的地址。
            </p>
          ) : null}
          {host?.source === "override" ? (
            <div className="device-host-actions">
              <Button
                type="button"
                size="sm"
                color="neutral"
                variant="transparent"
                outline={false}
                disabled={savingHost}
                onClick={onResetHost}
              >
                <RotateCcw />恢复安装时地址
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}

export function DeviceSettingsDialog({
  open,
  onOpenChange,
  firmwareMode = "official",
  zosFlashed = false,
}: DeviceSettingsDialogProps) {
  const surface = deviceSettingsSurface(firmwareMode, zosFlashed);
  const zos = surface === "zos";
  const toast = useAppToast();
  const [saved, setSaved] = useState<DeviceGeneralSettings | null>(null);
  const [draft, setDraft] = useState<DeviceGeneralSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [access, setAccess] = useState<ControlAccessInfo | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState(false);
  const [accessCopied, setAccessCopied] = useState(false);
  const [accessPopoverOpen, setAccessPopoverOpen] = useState(false);
  const [tab, setTab] = useState<"general" | "device">("general");
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [host, setHost] = useState<DeviceHostStatus | null>(null);
  const [hostDraft, setHostDraft] = useState("");
  const [savingHost, setSavingHost] = useState(false);
  // ZOS 这一路的全部真相都在状态文档里；镜像不订阅（见 createZosLink 的 mirror），
  // 这个对话框不画那块屏，问一帧就等于让固件白白开始推流。
  const [zosState, setZosState] = useState<ZosState | null>(null);
  const [zosNow, setZosNow] = useState(() => Date.now());
  const [provisionOpen, setProvisionOpen] = useState(false);
  const zosLinkRef = useRef<ZosLink | null>(null);
  // 不能渲染一个按下去必然失败的按钮，所以配网入口的有无和向导的第一屏由同一个
  // 判断决定。只在对话框打开时探，省掉常驻的适配器查询。
  const bleSupport = useBleSupport(open && zos);
  const infoRevisionRef = useRef(0);
  const loadRevisionRef = useRef(0);
  // 已经有草稿时，重读失败不该顶掉正在编辑的表单——走 toast，和同对话框的保存失败一致。
  const hasDraftRef = useRef(false);
  const accessRevisionRef = useRef(0);
  const copyResetRef = useRef<number | null>(null);

  const loadSettings = useCallback(async () => {
    const revision = ++loadRevisionRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await jsonApi<DeviceSettingsResponse>("/api/device/settings/general", {
        cache: "no-store",
      });
      if (revision !== loadRevisionRef.current) return;
      const next = copySettings(response.settings);
      setSaved(next);
      setDraft(copySettings(next));
      hasDraftRef.current = true;
    } catch (error) {
      if (revision !== loadRevisionRef.current) return;
      if (hasDraftRef.current) toast.error("重新读取设置失败", { description: errorMessage(error) });
      else setLoadError(errorMessage(error));
    } finally {
      if (revision === loadRevisionRef.current) setLoading(false);
    }
  }, []);

  const loadAccess = useCallback(async () => {
    const revision = ++accessRevisionRef.current;
    setAccessLoading(true);
    setAccessError(false);
    try {
      const response = await jsonApi<ControlAccessResponse>("/api/access", { cache: "no-store" });
      if (revision === accessRevisionRef.current) setAccess(response.access);
    } catch {
      if (revision === accessRevisionRef.current) setAccessError(true);
    } finally {
      if (revision === accessRevisionRef.current) setAccessLoading(false);
    }
  }, []);

  // The device tab must work when the clock is unreachable, so its two reads are
  // independent: the host status comes from the service and always succeeds, the
  // info probe may fail and only degrades the panel above the address form.
  const loadDeviceTab = useCallback(async () => {
    const revision = ++infoRevisionRef.current;
    setInfoLoading(true);
    setInfoError(null);
    try {
      const status = await jsonApi<DeviceHostResponse>("/api/device/host", { cache: "no-store" });
      if (revision !== infoRevisionRef.current) return;
      setHost(status.host);
      setHostDraft((current) => (current.trim().length > 0 ? current : status.host.host));
    } catch {
      // A missing host adapter is not worth a toast; the info error below says enough.
    }
    // ZOS 下这一条注定 503，而且这一页根本不显示它的字段：发出去只会在网络面板里
    // 留一条红色的失败，让人去查一个没有问题的网络。
    if (zos) {
      if (revision === infoRevisionRef.current) {
        setInfo(null);
        setInfoError(null);
        setInfoLoading(false);
      }
      return;
    }
    try {
      const response = await jsonApi<DeviceInfoResponse>("/api/device/info", { cache: "no-store" });
      if (revision !== infoRevisionRef.current) return;
      setInfo(response.info);
      setInfoError(null);
    } catch (error) {
      if (revision !== infoRevisionRef.current) return;
      setInfo(null);
      setInfoError(errorMessage(error));
    } finally {
      if (revision === infoRevisionRef.current) setInfoLoading(false);
    }
  }, [zos]);

  const saveHost = async () => {
    const next = hostDraft.trim();
    if (savingHost || clockHostError(next)) return;
    setSavingHost(true);
    try {
      const response = await jsonApi<DeviceHostWriteResponse>("/api/device/host", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: next }),
      });
      setHost(response.host);
      setHostDraft(response.host.host);
      if (zos) {
        // 服务的探针走的是官方固件的 /getDeviceInfo，在 ZOS 上永远失败。把这个
        // 必然的结果报成「仍读不到设备」，是让人去修一件本来就不该发生的事。
        toast.success("时钟地址已更新", { description: "ZOS 不走这个地址，改动只影响官方固件通道。" });
        return;
      }
      setInfo(response.probe.info ?? null);
      setInfoError(response.probe.ok ? null : response.probe.error ?? "时钟没有响应");
      if (response.probe.ok) {
        toast.success("时钟地址已更新", { description: "已连上设备，服务无需重启。" });
        await loadSettings();
      } else {
        toast.error("地址已保存，但仍读不到设备", { description: response.probe.error });
      }
    } catch (error) {
      toast.error("时钟地址保存失败", { description: errorMessage(error) });
    } finally {
      setSavingHost(false);
    }
  };

  const resetHost = async () => {
    if (savingHost) return;
    setSavingHost(true);
    try {
      const response = await jsonApi<DeviceHostResponse>("/api/device/host", { method: "DELETE" });
      setHost(response.host);
      setHostDraft(response.host.host);
      toast.success("已恢复安装时的时钟地址", { description: response.host.host });
      await loadDeviceTab();
    } catch (error) {
      toast.error("恢复失败", { description: errorMessage(error) });
    } finally {
      setSavingHost(false);
    }
  };

  // ZOS 下这条读取只会拿回 503。不发它，是为了别把一次注定的失败包装成
  // 「无法读取设备设置」——那句话会让人去查网络，而网络没有任何问题。
  useEffect(() => {
    if (open && surface === "official") void loadSettings();
  }, [loadSettings, open, surface]);

  // 只在对话框开着的时候连：ZOS 的状态是设备十秒一次的上报，关掉的窗口没有理由
  // 继续替它计时。链路用的是系统面板同一份实现（节奏、退避、写入语义都在那里），
  // 只是关掉了镜像。
  useEffect(() => {
    if (!open || !zos) return;
    const link = createZosLink({ mirror: false, onState: setZosState });
    zosLinkRef.current = link;
    link.start();
    return () => {
      link.stop();
      zosLinkRef.current = null;
      // 下次打开先显示「正在读取」，而不是上一次的读数——设备可能已经掉线了。
      setZosState(null);
    };
  }, [open, zos]);

  useEffect(() => {
    if (!open || !zos) return;
    setZosNow(Date.now());
    const timer = window.setInterval(() => setZosNow(Date.now()), FACT_TICK_MS);
    return () => window.clearInterval(timer);
  }, [open, zos]);

  useEffect(() => {
    if (open && tab === "device") void loadDeviceTab();
  }, [loadDeviceTab, open, tab]);

  // Reading the clock's settings failing means the address is the user's real
  // problem — land them on the tab that can fix it instead of on a dead form.
  useEffect(() => {
    if (open && loadError && !hasDraftRef.current) setTab("device");
  }, [loadError, open]);

  useEffect(() => {
    if (open && accessPopoverOpen) void loadAccess();
  }, [accessPopoverOpen, loadAccess, open]);

  useEffect(() => () => {
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
  }, []);

  const dirty = useMemo(
    () => Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft)),
    [draft, saved],
  );
  const requestOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (saving || savingHost)) return;
    if (!nextOpen) {
      loadRevisionRef.current += 1;
      accessRevisionRef.current += 1;
      infoRevisionRef.current += 1;
      setLoading(false);
      setInfoLoading(false);
      setAccessLoading(false);
      setAccessCopied(false);
      setAccessPopoverOpen(false);
    }
    onOpenChange(nextOpen);
  };

  const cancel = () => {
    loadRevisionRef.current += 1;
    accessRevisionRef.current += 1;
    setLoading(false);
    setAccessPopoverOpen(false);
    if (saved) setDraft(copySettings(saved));
    onOpenChange(false);
  };

  const copyAccessUrl = async () => {
    if (!access?.url) return;
    try {
      await copyText(access.url);
      setAccessCopied(true);
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setAccessCopied(false), 2_000);
      toast.success("手机访问地址已复制");
    } catch {
      toast.error("复制失败", { description: "请长按地址手动复制。" });
    }
  };

  // 没有草稿，也没有保存按钮：PUT /api/os/settings 是即时的，滑块松手就是下发。
  // 服务回的是它接下来会向设备请求的值，原样收下——设备旋钮随时会再压过去。
  const sendZosSettings = async (patch: ZosSendSettingsPatch) => {
    const link = zosLinkRef.current;
    if (!link) return;
    try {
      const requested = await link.setSettings(patch);
      setZosState((current) => current === null ? current : { ...current, requestedSettings: requested });
    } catch (error) {
      toast.error("设置下发失败", { description: errorMessage(error) });
    }
  };

  const sendZosSleep = async (patch: SleepPatch) => {
    const link = zosLinkRef.current;
    if (!link) return;
    try {
      const requested = await link.setSleep(patch);
      setZosState((current) => current === null ? current : { ...current, requestedSleep: requested });
    } catch (error) {
      toast.error("息屏设置下发失败", { description: errorMessage(error) });
    }
  };

  const save = async () => {
    if (!draft || saving || surface !== "official") return;
    setSaving(true);
    try {
      const response = await jsonApi<DeviceSettingsResponse>("/api/device/settings/general", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      setSaved(copySettings(response.settings));
      setDraft(copySettings(response.settings));
      onOpenChange(false);
      toast.success("常规设置已保存", { description: "设置已经写入 Ulanzi TC002。" });
    } catch (error) {
      toast.error("常规设置保存失败", { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const zosFacts = zos && zosState !== null ? describeZosDeviceFacts(zosState, zosNow) : null;
  // 拿到自己的第一份状态之前，就先用 App 那条轮询已经给出的判断（firmwareMode 只有
  // 在设备正在上报时才是 zos）——总比在一台掉线的钟上先画一屏在线的样子好。
  const zosLive = zosState !== null ? zosState.live === true : firmwareMode === "zos";

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={requestOpenChange}
      title={(
        <div className="device-settings-titlebar">
          <span>常规设置</span>
          <PopoverRoot open={accessPopoverOpen} onOpenChange={setAccessPopoverOpen}>
            <PopoverTrigger>
              <Button
                type="button"
                size="sm"
                color={accessPopoverOpen ? "brand" : "neutral"}
                variant="transparent"
                outline={false}
                className="device-access-trigger"
                aria-label="打开手机控制"
                aria-expanded={accessPopoverOpen}
              >
                <Smartphone />
                <span className="device-access-trigger__label">手机控制</span>
                {access?.url && <span className="device-access-trigger__status" aria-hidden="true" />}
              </Button>
            </PopoverTrigger>
            <Popover
              position="bottom-end"
              offset={8}
              viewportMargin={12}
              className="device-access-popover"
              contentClassName="device-access-popover__content"
              aria-label="手机访问"
            >
              <div className="device-access-popover__heading">
                <div>
                  <strong>手机访问</strong>
                  <span>扫码后在同一 Wi-Fi 下设置时钟</span>
                </div>
                {access?.lanEnabled && access.url ? (
                  <span className="device-access-network"><Wifi />{access.sameSubnetAsClock ? "与时钟同网段" : "局域网可用"}</span>
                ) : null}
              </div>

              {accessLoading && !access ? (
                <div className="device-access-popover__state" role="status">
                  <span className="loading-mark" aria-hidden="true" />
                  <span>正在查找手机访问地址…</span>
                </div>
              ) : access?.url ? (
                <>
                  <div className="device-access-qr" aria-label="手机访问地址二维码">
                    <QRCodeSVG
                      value={access.url}
                      size={176}
                      level="M"
                      marginSize={2}
                      bgColor="#ffffff"
                      fgColor="#111511"
                    />
                  </div>
                  <div className="device-access-popover__address">
                    <span>访问地址</span>
                    <code>{access.url}</code>
                  </div>
                  <Button
                    type="button"
                    color="brand"
                    onClick={() => void copyAccessUrl()}
                    aria-label="复制手机访问地址"
                  >
                    {accessCopied ? <Check /> : <Copy />}{accessCopied ? "已复制" : "复制地址"}
                  </Button>
                  <p>也可以复制地址到手机浏览器；添加到主屏幕后可像 App 一样使用。</p>
                </>
              ) : (
                <div className="device-access-popover__state is-error" role={accessError ? "alert" : "status"}>
                  <Smartphone aria-hidden="true" />
                  <strong>{accessError ? "暂时无法获取地址" : "当前仅本机可用"}</strong>
                  <span>{access?.suggestedUrl ?? "请确认服务已启用局域网访问。"}</span>
                  <Button type="button" size="sm" onClick={() => void loadAccess()}><RefreshCw />重新获取</Button>
                </div>
              )}
            </Popover>
          </PopoverRoot>
        </div>
      )}
      text={zos
        // Online, the rows speak for themselves and a sentence saying "these are
        // the ones ZOS provides" is us describing our own scoping decision.
        // Offline it earns its place: it explains why the values are missing and
        // that provisioning still works, which is the one thing the user needs.
        ? zosLive
          ? "时钟正在跑 ZOS。"
          : "时钟刷的是 ZOS，此刻没有在上报。配网走蓝牙，不需要它在网上。"
        : surface === "sideload"
          ? "这里读写的是 Ulanzi 官方固件的设备接口；侧载固件正占着时钟。"
          : "直接读取并修改时钟本机配置。保存后会立即写入设备。"}
      className="device-settings-dialog"
      contentClassName="device-settings-dialog__content"
      closeOnBackdropClick={!dirty && !saving}
      // 配网向导开着时这一层不吃 Escape，否则一次按键会把向导和它下面的设置一起关掉，
      // 而正在配网的人恰恰是最不该被清场的那个。cladd 自己有一套判断（Popup.js:111）
      // 「下一个兄弟节点是不是对话框」，但它只在子对话框紧挨着时成立：overlays root
      // 里常驻着标题栏那颗按钮的 .cladd-tooltip，正好插在两个对话框中间。这一层自己
      // 知道有没有子对话框，不必去猜 DOM 的顺序。
      closeOnEscape={!dirty && !saving && !provisionOpen}
      buttons={(
        // The device tab saves through its own button, so the footer's write action
        // would be a no-op there — it offers a re-probe and a plain close instead.
        // ZOS 两个标签页都一样：下发是即时的，没有草稿可保存，「重新读取」问的是
        // 同一份状态文档。
        <div className="device-settings-actions">
          <Button
            type="button"
            color="neutral"
            variant="transparent"
            outline={false}
            disabled={zos
              ? zosState === null
              : tab === "general" ? loading || saving : infoLoading || savingHost}
            onClick={() => void (zos
              ? zosLinkRef.current?.refreshState()
              : tab === "general" ? loadSettings() : loadDeviceTab())}
          >
            <RefreshCw />重新读取
          </Button>
          <span className="device-settings-actions__spacer" />
          {tab === "general" && surface === "official" ? (
            <>
              <Button type="button" color="neutral" onClick={cancel} disabled={saving}>取消</Button>
              <Button
                type="button"
                color="brand"
                loading={saving}
                disabled={!dirty || loading || saving}
                onClick={() => void save()}
              >
                <Save />保存设置
              </Button>
            </>
          ) : (
            <Button
              type="button"
              color="neutral"
              onClick={() => requestOpenChange(false)}
              disabled={savingHost}
            >
              关闭
            </Button>
          )}
        </div>
      )}
    >
      <Tabs value={tab} onValueChange={(value) => setTab(value as "general" | "device")}>
        <SurfaceCut
          className="segmented-track device-settings-tabs"
          color="neutral"
          outline={false}
          contentClassName="segmented-track__content"
        >
          <TabsList size="sm" rounded activeColor="brand" aria-label="设置分类">
            <Tab value="general"><SlidersHorizontal />常规</Tab>
            <Tab value="device"><Wifi />设备信息</Tab>
          </TabsList>
        </SurfaceCut>

        <TabPanel value="general" className="device-settings-panel" keepMounted>
      {zos ? (
        <ZosGeneralPanel
          requested={zosState?.requestedSettings ?? null}
          live={zosLive}
          sleep={zosState?.telemetry?.sleep ?? null}
          bleSupport={bleSupport}
          onSend={(patch) => void sendZosSettings(patch)}
          onSleepSend={(patch) => void sendZosSleep(patch)}
          onProvision={() => setProvisionOpen(true)}
        />
      ) : surface === "sideload" ? (
        // 侧载固件占着设备，官方接口没了、也没有替代品——这一页是真的空的。
        // 一句话说清，不铺开一整段解释一个没有内容的页面。
        <div className="device-settings-state" role="status">
          <strong>常规设置在侧载固件下不可用</strong>
          <span>侧载固件正直连时钟，官方固件的设备接口不会响应；断电重启即可恢复。</span>
        </div>
      ) : loading && !draft ? (
        <div className="device-settings-state" role="status">
          <span className="loading-mark" aria-hidden="true" />
          <strong>正在读取设备设置</strong>
          <span>请保持时钟与电脑处于同一网络。</span>
        </div>
      ) : loadError && !draft ? (
        <div className="device-settings-state is-error" role="alert">
          <strong>无法读取设备设置</strong>
          <span>{loadError}</span>
          <Button type="button" onClick={() => void loadSettings()}><RefreshCw />重试</Button>
        </div>
      ) : draft ? (
        <DeviceGeneralPanel draft={draft} onChange={setDraft} />
      ) : null}
        </TabPanel>

        <TabPanel value="device" className="device-settings-panel" keepMounted>
          <div className="device-settings-form">
            <DeviceHostPanel
              info={info}
              infoLoading={infoLoading}
              infoError={infoError}
              host={host}
              hostDraft={hostDraft}
              savingHost={savingHost}
              zos={zos}
              zosFacts={zosFacts}
              onHostDraftChange={setHostDraft}
              onSaveHost={() => void saveHost()}
              onResetHost={() => void resetHost()}
              onRetry={() => void loadDeviceTab()}
            />
          </div>
        </TabPanel>
      </Tabs>
    </Dialog>

    {/* 配网向导开在这个对话框之上，而不是取代它：改完 Wi-Fi 回到的还是刚才那一页。
        让路的是上面那个 closeOnEscape，不是 cladd 的自动判断——见那里的注释。 */}
    <ZosProvisionDialog
      open={provisionOpen}
      onOpenChange={setProvisionOpen}
      // 设备回到局域网比 2 秒一次的状态轮询快，立刻问一次，免得这一页还写着掉线。
      onProvisioned={() => void zosLinkRef.current?.refreshState()}
    />
    </>
  );
}

interface DeviceGeneralPanelProps {
  draft: DeviceGeneralSettings;
  onChange: (next: DeviceGeneralSettings) => void;
}

/**
 * 官方固件的「常规」：/getConfig 读出来、/setConfig 写回去的那一整套。
 *
 * 单独拆成组件，是为了让它能被渲染着断言——cladd 的 Dialog 走 portal，服务端渲染
 * 出来是空串，面板本体是唯一能测的接缝（ZosGeneralPanel、DeviceHostPanel 同理）。
 * 刷着原厂固件的人看到的必须和以前一模一样，而「一模一样」只有把表单真的渲染出来
 * 才算钉住了；一份写在别处的字段清单钉住的是那份清单自己。
 */
export function DeviceGeneralPanel({ draft, onChange }: DeviceGeneralPanelProps) {
  // The clock's /setConfig still wants level + three tier percentages. Writing the
  // slider value into every tier makes the physical level button a no-op, so one
  // number fully describes brightness regardless of which tier the device is on.
  const setBrightness = (value: number) => {
    onChange({
      ...draft,
      brightness: { ...draft.brightness, low: value, mid: value, high: value },
    });
  };

  return (
        <div className="device-settings-form">
          <section className="device-settings-section" aria-labelledby="settings-display-title">
            <div className="device-settings-section__heading">
              <span>01</span>
              <div>
                <h3 id="settings-display-title">显示与声音</h3>
                <p>屏幕亮度与提示音量。</p>
              </div>
            </div>
            <div className="device-settings-fields">
              <SettingField
                id="device-brightness"
                label="屏幕亮度"
                controlClassName="device-setting-control--slider"
              >
                <label className="device-setting-slider">
                  <span className="sr-only">屏幕亮度</span>
                  <Slider
                    value={draft.brightness[draft.brightness.level]}
                    min={5}
                    max={100}
                    step={1}
                    color="brand"
                    onChange={setBrightness}
                  />
                </label>
                <span className="device-setting-slider-value">
                  {draft.brightness[draft.brightness.level]} %
                </span>
              </SettingField>

              <SettingField
                id="device-volume"
                label="音量调节"
                controlClassName="device-setting-control--slider"
              >
                <label className="device-setting-slider">
                  <span className="sr-only">音量调节</span>
                  <Slider
                    value={draft.volume}
                    min={0}
                    max={6}
                    step={1}
                    color="brand"
                    onChange={(value) => onChange({ ...draft, volume: value })}
                  />
                </label>
                <span className="device-setting-slider-value">
                  {draft.volume === 0 ? "静音" : `${draft.volume} 级`}
                </span>
              </SettingField>
            </div>
          </section>

          <section className="device-settings-section" aria-labelledby="settings-motion-title">
            <div className="device-settings-section__heading">
              <span>02</span>
              <div>
                <h3 id="settings-motion-title">播放行为</h3>
                <p>控制设备原生页面的自动切换和滚动速度。</p>
              </div>
            </div>
            <div className="device-settings-fields">
              <SettingField
                id="device-carousel-speed"
                label="自动翻页速度"
                controlClassName="device-setting-control--slider"
              >
                <label className="device-setting-slider">
                  <span className="sr-only">自动翻页速度</span>
                  <Slider
                    value={draft.carouselSpeed}
                    min={0}
                    max={60}
                    step={10}
                    color="brand"
                    onChange={(value) => onChange({
                      ...draft,
                      carouselSpeed: value as DeviceCarouselSpeed,
                    })}
                  />
                </label>
                <span className="device-setting-slider-value">
                  {labelFor(CAROUSEL_SPEEDS, draft.carouselSpeed)}
                </span>
              </SettingField>
              <SettingField
                id="device-scroll-speed"
                label="滚动速度"
                controlClassName="device-setting-control--slider"
              >
                <label className="device-setting-slider">
                  <span className="sr-only">滚动速度</span>
                  <Slider
                    value={draft.scrollSpeed}
                    min={0}
                    max={10}
                    step={1}
                    color="brand"
                    onChange={(value) => onChange({ ...draft, scrollSpeed: value })}
                  />
                </label>
                <span className="device-setting-slider-value">
                  {draft.scrollSpeed === 0 ? "不滚动" : `${draft.scrollSpeed} 档`}
                </span>
              </SettingField>
            </div>
          </section>

          <section className="device-settings-section" aria-labelledby="settings-time-title">
            <div className="device-settings-section__heading">
              <span>03</span>
              <div>
                <h3 id="settings-time-title">日期与时间</h3>
                <p>设置设备时区、日期顺序和星期显示方式。</p>
              </div>
            </div>
            <div className="device-settings-fields">
              <SettingField id="device-timezone" label="时区设置">
                <Select
                  id="device-timezone"
                  aria-labelledby="device-timezone-label"
                  value={draft.timezone}
                  options={TIMEZONES}
                  popoverClassName="device-settings-timezone-options"
                  onChange={(value) => onChange({ ...draft, timezone: value })}
                >
                  {draft.timezone}
                </Select>
              </SettingField>
              <SettingField id="device-date-format" label="日期">
                <Segmented aria-label="日期格式" activeColor="brand">
                  {(["MM/DD", "DD/MM"] as const).map((format) => (
                    <SegmentedButton
                      key={format}
                      type="button"
                      active={draft.dateFormat === format}
                      onClick={() => onChange({ ...draft, dateFormat: format })}
                    >
                      {format}
                    </SegmentedButton>
                  ))}
                </Segmented>
              </SettingField>
              <SettingField id="device-show-week" label="显示星期">
                <DeviceSettingSwitch
                  label="显示星期"
                  checked={draft.showWeek}
                  onChange={(checked) => onChange({ ...draft, showWeek: checked })}
                />
              </SettingField>
              <SettingField id="device-week-start" label="一周第一天">
                <Segmented aria-label="一周第一天" activeColor="brand">
                  {([{ value: 0, label: "周日" }, { value: 1, label: "周一" }] as const).map((day) => (
                    <SegmentedButton
                      key={day.value}
                      type="button"
                      active={draft.weekStart === day.value}
                      onClick={() => onChange({ ...draft, weekStart: day.value })}
                    >
                      {day.label}
                    </SegmentedButton>
                  ))}
                </Segmented>
              </SettingField>
            </div>
          </section>

          <section className="device-settings-section" aria-labelledby="settings-power-title">
            <div className="device-settings-section__heading">
              <span>04</span>
              <div>
                <h3 id="settings-power-title">电源</h3>
                <p>设备低电量时是否自动进入休眠。</p>
              </div>
            </div>
            <div className="device-settings-fields">
              <SettingField id="device-low-battery-sleep" label="低电量自动休眠">
                <DeviceSettingSwitch
                  label="低电量自动休眠"
                  checked={draft.lowBatteryAutoSleep}
                  onChange={(checked) => onChange({ ...draft, lowBatteryAutoSleep: checked })}
                />
              </SettingField>
            </div>
          </section>

          <AboutSection index="05" />
        </div>
  );
}

/**
 * 关于：两块「常规」共用的最后一节。
 *
 * 两页的字段各不相同，但这一节讲的是控制台自己，与时钟在跑什么无关——所以它是一份，
 * 不是各抄一份。序号不同是因为上面的节数不同，其余完全一致。
 */
function AboutSection({ index }: { index: string }) {
  return (
    <section className="device-settings-section" aria-labelledby="settings-about-title">
      <div className="device-settings-section__heading">
        <span>{index}</span>
        <div>
          <h3 id="settings-about-title">关于</h3>
          <p>开源项目，欢迎关注。</p>
        </div>
      </div>
      <div className="device-settings-fields">
        <div className="device-settings-links">
          <Button
            as="a"
            href="https://github.com/qzz0518/ulanzi-tc002-market-clock"
            target="_blank"
            rel="noreferrer"
            color="neutral"
            title="qzz0518/ulanzi-tc002-market-clock"
          >
            <GithubIcon />GitHub
          </Button>
          <Button
            as="a"
            href="https://x.com/zerah_eth"
            target="_blank"
            rel="noreferrer"
            color="neutral"
            title="在 X 上关注 @zerah_eth"
          >
            <XIcon />@zerah_eth
          </Button>
        </div>
      </div>
    </section>
  );
}

interface ZosGeneralPanelProps {
  /** 服务接下来会向设备请求的值；null = 还没读到，或从没下发过。 */
  requested: ZosRequestedSettings | null;
  /** 设备此刻有没有在上报。false 时这一页不是死的，只是慢一拍。 */
  live: boolean;
  /** 夜间息屏的设备实况——和音量不同，它是读得回来的。 */
  sleep: ZosSleepReport | null;
  bleSupport: BleSupport;
  onSend: (patch: ZosSendSettingsPatch) => void;
  onSleepSend: (patch: SleepPatch) => void;
  onProvision: () => void;
}

/**
 * ZOS 的「常规」：能设的就这些。
 *
 * 官方固件那一页的翻页速度、时区、日期顺序、低电量休眠都不在这里——它们是官方固件
 * 从 /getConfig 读出来的概念，ZOS 没有对应的东西。留一排读不到也写不了的空行，比
 * 不列出来更糟。
 *
 * 两条滑块是系统面板那一对的本体（zos-send-row.tsx），连「未下发」的措辞和压暗都
 * 是同一份；一台设备不该在两个页面上有两种说法。
 *
 * 掉线时这一页照常打开，因为掉线恰恰是它最有用的时候：配网走蓝牙，不需要时钟在网上；
 * 音量亮度是写给服务的，固件回来第一次拉取就生效。所以少的只是「立刻」，不是功能。
 */
export function ZosGeneralPanel({
  requested,
  live,
  sleep,
  bleSupport,
  onSend,
  onSleepSend,
  onProvision,
}: ZosGeneralPanelProps) {
  // The edit overlay. Sleep is read back (unlike volume), but the round trip is
  // slow by design — the device applies on its next poll, the report follows a
  // heartbeat later — so an edit has to stay visible in the controls for those
  // seconds. The report is the arbiter: each field retires when it agrees.
  const [pendingSleep, setPendingSleep] = useState<SleepPatch>({});
  useEffect(() => {
    setPendingSleep((current) => reconcileSleepPending(current, sleep));
  }, [sleep]);
  const sleepView = effectiveSleepView(pendingSleep, sleep);
  const editSleep = (patch: SleepPatch) => {
    setPendingSleep((current) => ({ ...current, ...patch }));
    onSleepSend(patch);
  };
  // A value set by the knob or an older console can sit off the half-hour
  // grid; the select must carry it rather than snap it, or opening this dialog
  // would silently edit the device.
  const windowOptions = (current: number): number[] =>
    SLEEP_WINDOW_MINUTES.includes(current)
      ? [...SLEEP_WINDOW_MINUTES]
      : [...SLEEP_WINDOW_MINUTES, current].sort((a, b) => a - b);
  const idleOptions = SLEEP_IDLE_OPTIONS.some((option) => option.seconds === sleepView.idleSec)
    ? SLEEP_IDLE_OPTIONS.map((option) => option.seconds)
    : [...SLEEP_IDLE_OPTIONS.map((option) => option.seconds), sleepView.idleSec].sort((a, b) => a - b);
  return (
    <div className="device-settings-form">
      {!live && (
        <Surface
          variant="solid"
          outline
          color="brand"
          role="status"
          className="device-settings-banner"
          contentClassName="flex flex-col gap-1.5 p-4"
        >
          <span className="flex items-center gap-2 text-cladd-fg text-cladd-sm">
            <WifiOff aria-hidden="true" className="size-4" />
            <strong>时钟掉线了</strong>
          </span>
          <span className="text-cladd-fg-soft text-cladd-xs leading-relaxed">
            ZOS 已经刷进闪存，所以它还在跑，只是没有在网上。最常见的原因是换了路由器或改了 Wi-Fi
            密码——用下面的蓝牙配网重连一次就行，不用拆机也不用接线。
            这期间下发的音量和亮度会先存在服务里，等它回来第一次拉取时生效。
          </span>
        </Surface>
      )}

      <section className="device-settings-section" aria-labelledby="zos-output-title">
        <div className="device-settings-section__heading">
          <span>01</span>
          <div>
            <h3 id="zos-output-title">显示与声音</h3>
            <p>松手即下发，没有保存这一步。</p>
          </div>
        </div>
        <div className="device-settings-fields">
          <ZosSendRows requested={requested} onSend={onSend} />
          {/* 读不回来不是缺陷，是序列号让设备旋钮和侧键压过控制台的代价。 */}
          <p className="device-settings-note">
            这两个值只下发、读不回来：时钟的旋钮和侧键随时可以改，而且它们说了算，
            所以这里只能显示这台控制台发过什么。
          </p>
        </div>
      </section>

      <section className="device-settings-section" aria-labelledby="zos-sleep-title">
        <div className="device-settings-section__heading">
          <span>02</span>
          <div>
            <h3 id="zos-sleep-title">夜间息屏</h3>
            <p>时段内没人动它就熄屏；旋钮、按键或控制台任何操作立刻点亮。</p>
          </div>
        </div>
        <div className="device-settings-fields">
          <SettingField id="zos-sleep-on" label="自动息屏" help={sleepSwitchHelp(sleep, live)}>
            <DeviceSettingSwitch
              label="自动息屏"
              checked={sleepView.enabled}
              onChange={(checked) => editSleep({ enabled: checked })}
            />
          </SettingField>
          <SettingField id="zos-sleep-start" label="开始时间">
            <Select
              id="zos-sleep-start"
              aria-labelledby="zos-sleep-start-label"
              value={sleepView.startMin}
              options={windowOptions(sleepView.startMin)}
              renderOption={({ value }) => sleepMinuteLabel(value)}
              popoverClassName="device-settings-timezone-options"
              onChange={(value) => editSleep({ startMin: value })}
            >
              {sleepMinuteLabel(sleepView.startMin)}
            </Select>
          </SettingField>
          <SettingField
            id="zos-sleep-end"
            label="结束时间"
            help="时段可以跨午夜；起止相同表示全天。"
          >
            <Select
              id="zos-sleep-end"
              aria-labelledby="zos-sleep-end-label"
              value={sleepView.endMin}
              options={windowOptions(sleepView.endMin)}
              renderOption={({ value }) => sleepMinuteLabel(value)}
              popoverClassName="device-settings-timezone-options"
              onChange={(value) => editSleep({ endMin: value })}
            >
              {sleepMinuteLabel(sleepView.endMin)}
            </Select>
          </SettingField>
          <SettingField id="zos-sleep-idle" label="息屏等待" help="时段内无操作多久后熄屏。">
            <Select
              id="zos-sleep-idle"
              aria-labelledby="zos-sleep-idle-label"
              value={sleepView.idleSec}
              options={idleOptions}
              renderOption={({ value }) => sleepIdleLabel(value)}
              popoverClassName="device-settings-timezone-options"
              onChange={(value) => editSleep({ idleSec: value })}
            >
              {sleepIdleLabel(sleepView.idleSec)}
            </Select>
          </SettingField>
        </div>
      </section>

      <section className="device-settings-section" aria-labelledby="zos-network-title">
        <div className="device-settings-section__heading">
          <span>03</span>
          <div>
            <h3 id="zos-network-title">网络</h3>
            <p>换了路由器或改了密码时，用蓝牙重新连一次。</p>
          </div>
        </div>
        <div className="device-settings-fields">
          {bleSupport.ok ? (
            <SettingField
              id="zos-provision"
              label="蓝牙配网"
              help="不用拆机也不用接线；时钟掉线时也能配。"
            >
              <Button type="button" size="md" color="brand" onClick={onProvision}>
                <Bluetooth />开始配网
              </Button>
            </SettingField>
          ) : (
            // 按不动的按钮不如没有按钮：这里给的是同一个向导会给的理由。
            <div className="device-settings-note"><BleUnavailableNote support={bleSupport} /></div>
          )}
        </div>
      </section>

      <AboutSection index="04" />
    </div>
  );
}
