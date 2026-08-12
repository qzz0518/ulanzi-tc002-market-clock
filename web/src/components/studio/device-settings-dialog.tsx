import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  RefreshCw,
  RotateCcw,
  Save,
  Smartphone,
  SlidersHorizontal,
  Wifi,
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
  SurfaceCut,
  Switch,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
} from "@cladd-ui/react";
import { jsonApi } from "@/lib/api";
import type { FirmwareMode } from "@/lib/firmware-mode";
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
   * 这个对话框读写的是官方固件自带的设备接口（/getConfig、/setConfig，服务经
   * CLOCK_HOST 转发）。ZOS 把整套固件换掉了，两端在真机上都只回
   * `clock returned HTTP 503`——所以这里必须知道时钟在跑什么。
   */
  firmwareMode?: FirmwareMode;
}

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

// The clock reports the MAC unseparated (ccc4b277a772); show it the way every
// other tool on the network does. Anything that is not 12 hex digits passes
// through untouched rather than being mangled into a plausible-looking address.
export function formatMacAddress(value: string): string {
  if (!/^[0-9a-f]{12}$/i.test(value)) return value;
  return (value.match(/.{2}/g) ?? []).join(":").toUpperCase();
}

const DEVICE_INFO_ROWS: Array<{
  key: keyof DeviceInfo;
  label: string;
  format?: (value: string) => string;
}> = [
  { key: "serialNumber", label: "设备 SN" },
  { key: "ssid", label: "WiFi 名称" },
  { key: "ip", label: "IP 地址" },
  { key: "mac", label: "MAC 地址", format: formatMacAddress },
  { key: "mcuVersion", label: "MCU 固件版本" },
  { key: "appVersion", label: "SOC 固件版本" },
];

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
            <h3 id="settings-info-title">设备信息</h3>
            <p>与时钟本机的「设备信息」页一致。</p>
          </div>
        </div>
        {infoLoading && !hasAnyField ? (
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
        ) : zos ? (
          // 不是错误，是这套固件没有这个接口——重试一百次也一样。地址表单还在
          // 下面，因为服务确实用它去找时钟（ZOS 的拉取端也在同一台设备上）。
          <div className="device-settings-state" role="status">
            <strong>ZOS 不提供官方固件的设备信息接口</strong>
            <span>时钟正在跑 ZOS，这些字段来自官方固件的 /getDeviceInfo，读取只会返回 503。</span>
            <span>Wi-Fi、IP、运行时长与电量请看「系统」标签页的设备状态。</span>
          </div>
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
            <p>时钟换了 IP 就在这里改，立即生效，重启后仍然有效。</p>
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
}: DeviceSettingsDialogProps) {
  const zos = firmwareMode === "zos";
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
  }, []);

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
    if (open && !zos) void loadSettings();
  }, [loadSettings, open, zos]);

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

  const save = async () => {
    if (!draft || saving || zos) return;
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

  // The clock's /setConfig still wants level + three tier percentages. Writing the
  // slider value into every tier makes the physical level button a no-op, so one
  // number fully describes brightness regardless of which tier the device is on.
  const setBrightness = (value: number) => {
    setDraft((current) => current ? {
      ...current,
      brightness: { ...current.brightness, low: value, mid: value, high: value },
    } : current);
  };

  return (
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
        ? "这里读写的是 Ulanzi 官方固件的设备接口；时钟正在跑 ZOS，它不提供这套接口。"
        : "直接读取并修改时钟本机配置。保存后会立即写入设备。"}
      className="device-settings-dialog"
      contentClassName="device-settings-dialog__content"
      closeOnBackdropClick={!dirty && !saving}
      closeOnEscape={!dirty && !saving}
      buttons={(
        // The device tab saves through its own button, so the footer's write action
        // would be a no-op there — it offers a re-probe and a plain close instead.
        <div className="device-settings-actions">
          <Button
            type="button"
            color="neutral"
            variant="transparent"
            outline={false}
            disabled={tab === "general" ? zos || loading || saving : infoLoading || savingHost}
            onClick={() => void (tab === "general" ? loadSettings() : loadDeviceTab())}
          >
            <RefreshCw />重新读取
          </Button>
          <span className="device-settings-actions__spacer" />
          {tab === "general" ? (
            <>
              <Button type="button" color="neutral" onClick={cancel} disabled={saving}>{zos ? "关闭" : "取消"}</Button>
              <Button
                type="button"
                color="brand"
                loading={saving}
                disabled={zos || !dirty || loading || saving}
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
        // 不渲染表单本身：一份填得好好的、保存却必然 503 的表单，比一句说明更
        // 误导人。亮度/音量 ZOS 自己有设置页，用旋钮进；轮播与时区归频道编排。
        <div className="device-settings-state" role="status">
          <strong>常规设置在 ZOS 上不可用</strong>
          <span>
            这一页读写的是 Ulanzi 官方固件的设备接口。时钟正在跑 ZOS，官方接口已随固件一起换掉，
            读和写都只会返回 503。
          </span>
          <span>
            亮度与音量在时钟自带的「设置」界面里调（用旋钮进，或到「系统」标签页把设备固定到设置项）；
            轮播与时区跟着频道编排走。
          </span>
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
                    onChange={(value) => setDraft({ ...draft, volume: value })}
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
                    onChange={(value) => setDraft({
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
                    onChange={(value) => setDraft({ ...draft, scrollSpeed: value })}
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
                  onChange={(value) => setDraft({ ...draft, timezone: value })}
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
                      onClick={() => setDraft({ ...draft, dateFormat: format })}
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
                  onChange={(checked) => setDraft({ ...draft, showWeek: checked })}
                />
              </SettingField>
              <SettingField id="device-week-start" label="一周第一天">
                <Segmented aria-label="一周第一天" activeColor="brand">
                  {([{ value: 0, label: "周日" }, { value: 1, label: "周一" }] as const).map((day) => (
                    <SegmentedButton
                      key={day.value}
                      type="button"
                      active={draft.weekStart === day.value}
                      onClick={() => setDraft({ ...draft, weekStart: day.value })}
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
                  onChange={(checked) => setDraft({ ...draft, lowBatteryAutoSleep: checked })}
                />
              </SettingField>
            </div>
          </section>

          <section className="device-settings-section" aria-labelledby="settings-about-title">
            <div className="device-settings-section__heading">
              <span>05</span>
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
        </div>
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
              onHostDraftChange={setHostDraft}
              onSaveHost={() => void saveHost()}
              onResetHost={() => void resetHost()}
              onRetry={() => void loadDeviceTab()}
            />
          </div>
        </TabPanel>
      </Tabs>
    </Dialog>
  );
}
