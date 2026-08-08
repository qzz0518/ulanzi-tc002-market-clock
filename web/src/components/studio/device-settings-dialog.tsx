import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, RefreshCw, Save, Smartphone, Wifi } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  Button,
  Dialog,
  NumberScrubber,
  Popover,
  PopoverRoot,
  PopoverTrigger,
  Select,
  Switch,
} from "@cladd-ui/react";
import { jsonApi } from "@/lib/api";
import { useAppToast } from "@/lib/use-app-toast";
import { errorMessage } from "@/lib/utils";
import type {
  DeviceBrightnessLevel,
  DeviceCarouselSpeed,
  DeviceGeneralSettings,
  DeviceTimezone,
  ControlAccessInfo,
} from "@/types";

interface DeviceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface DeviceSettingsResponse {
  settings: DeviceGeneralSettings;
}

interface ControlAccessResponse {
  access: ControlAccessInfo;
}

const BRIGHTNESS_LEVELS: Array<{ value: DeviceBrightnessLevel; label: string }> = [
  { value: "low", label: "低" },
  { value: "mid", label: "中" },
  { value: "high", label: "高" },
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

interface SettingFieldProps {
  id: string;
  label: string;
  help?: string;
  children: React.ReactNode;
}

function SettingField({ id, label, help, children }: SettingFieldProps) {
  return (
    <div className="device-setting-field">
      <div className="device-setting-copy">
        <label id={`${id}-label`} htmlFor={id}>{label}</label>
        {help && <p id={`${id}-help`}>{help}</p>}
      </div>
      <div className="device-setting-control">{children}</div>
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

export function DeviceSettingsDialog({ open, onOpenChange }: DeviceSettingsDialogProps) {
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
  const loadRevisionRef = useRef(0);
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
    } catch (error) {
      if (revision !== loadRevisionRef.current) return;
      setLoadError(errorMessage(error));
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

  useEffect(() => {
    if (open) void loadSettings();
  }, [loadSettings, open]);

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
  const validationError = draft && (
    draft.brightness.low > draft.brightness.mid
    || draft.brightness.mid > draft.brightness.high
  )
    ? "亮度必须满足：低档 ≤ 中档 ≤ 高档"
    : null;

  const requestOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && saving) return;
    if (!nextOpen) {
      loadRevisionRef.current += 1;
      accessRevisionRef.current += 1;
      setLoading(false);
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
    if (!draft || validationError || saving) return;
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

  const updateBrightness = (
    key: keyof DeviceGeneralSettings["brightness"],
    value: number | DeviceBrightnessLevel,
  ) => {
    setDraft((current) => current ? {
      ...current,
      brightness: { ...current.brightness, [key]: value },
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
                variant={accessPopoverOpen ? "solid-fill" : "transparent"}
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
      text="直接读取并修改时钟本机配置。保存后会立即写入设备。"
      className="device-settings-dialog"
      contentClassName="device-settings-dialog__content"
      closeOnBackdropClick={!dirty && !saving}
      closeOnEscape={!dirty && !saving}
      buttons={(
        <div className="device-settings-actions">
          <Button
            type="button"
            color="neutral"
            variant="transparent"
            outline={false}
            disabled={loading || saving}
            onClick={() => void loadSettings()}
          >
            <RefreshCw />重新读取
          </Button>
          <span className="device-settings-actions__spacer" />
          <Button type="button" color="neutral" onClick={cancel} disabled={saving}>取消</Button>
          <Button
            type="button"
            color="brand"
            loading={saving}
            disabled={!dirty || Boolean(validationError) || loading || saving}
            onClick={() => void save()}
          >
            <Save />保存设置
          </Button>
        </div>
      )}
    >
      {loading && !draft ? (
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
          {loadError && (
            <div className="device-settings-inline-error" role="alert">
              重新读取失败：{loadError}
            </div>
          )}

          <section className="device-settings-section" aria-labelledby="settings-display-title">
            <div className="device-settings-section__heading">
              <span>01</span>
              <div>
                <h3 id="settings-display-title">显示与声音</h3>
                <p>当前档位使用下方对应的亮度百分比。</p>
              </div>
            </div>
            <div className="device-settings-fields">
              <SettingField id="device-brightness-level" label="屏幕亮度">
                <Select
                  id="device-brightness-level"
                  aria-labelledby="device-brightness-level-label"
                  value={draft.brightness.level}
                  options={BRIGHTNESS_LEVELS.map((option) => option.value)}
                  renderOption={({ value }) => labelFor(BRIGHTNESS_LEVELS, value)}
                  onChange={(value) => updateBrightness("level", value)}
                >
                  {labelFor(BRIGHTNESS_LEVELS, draft.brightness.level)}
                </Select>
              </SettingField>

              {(["low", "mid", "high"] as const).map((level) => {
                const labels = { low: "低档亮度", mid: "中档亮度", high: "高档亮度" };
                const id = `device-brightness-${level}`;
                return (
                  <SettingField key={level} id={id} label={`${labels[level]}（%）`}>
                    <NumberScrubber
                      id={id}
                      className="device-settings-number"
                      contentClassName="number-scrubber__content"
                      inputClassName="number-scrubber__input"
                      color="neutral"
                      value={draft.brightness[level]}
                      min={5}
                      max={100}
                      step={1}
                      displayValue={(value) => `${value} %`}
                      aria-labelledby={`${id}-label`}
                      title="左右拖动调整，点击输入"
                      onTemporaryChange={(value) => updateBrightness(level, value)}
                      onChange={(value) => updateBrightness(level, value)}
                    />
                  </SettingField>
                );
              })}

              <SettingField id="device-volume" label="音量调节">
                <Select
                  id="device-volume"
                  aria-labelledby="device-volume-label"
                  value={String(draft.volume)}
                  options={["0", "1", "2", "3", "4", "5", "6"]}
                  renderOption={({ value }) => value === "0" ? "静音" : `${value} 级`}
                  onChange={(value) => setDraft({ ...draft, volume: Number(value) })}
                >
                  {draft.volume === 0 ? "静音" : `${draft.volume} 级`}
                </Select>
              </SettingField>
            </div>
            {validationError && <p className="device-settings-validation" role="alert">{validationError}</p>}
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
              <SettingField id="device-carousel-speed" label="自动翻页速度">
                <Select
                  id="device-carousel-speed"
                  aria-labelledby="device-carousel-speed-label"
                  value={String(draft.carouselSpeed)}
                  options={CAROUSEL_SPEEDS.map((option) => String(option.value))}
                  renderOption={({ value }) => labelFor(CAROUSEL_SPEEDS, Number(value) as DeviceCarouselSpeed)}
                  onChange={(value) => setDraft({
                    ...draft,
                    carouselSpeed: Number(value) as DeviceCarouselSpeed,
                  })}
                >
                  {labelFor(CAROUSEL_SPEEDS, draft.carouselSpeed)}
                </Select>
              </SettingField>
              <SettingField id="device-scroll-speed" label="滚动速度">
                <Select
                  id="device-scroll-speed"
                  aria-labelledby="device-scroll-speed-label"
                  value={String(draft.scrollSpeed)}
                  options={["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]}
                  renderOption={({ value }) => value === "0" ? "不滚动" : `${value} 档`}
                  onChange={(value) => setDraft({ ...draft, scrollSpeed: Number(value) })}
                >
                  {draft.scrollSpeed === 0 ? "不滚动" : `${draft.scrollSpeed} 档`}
                </Select>
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
                <Select
                  id="device-date-format"
                  aria-labelledby="device-date-format-label"
                  value={draft.dateFormat}
                  options={["MM/DD", "DD/MM"]}
                  onChange={(value) => setDraft({ ...draft, dateFormat: value })}
                >
                  {draft.dateFormat}
                </Select>
              </SettingField>
              <SettingField id="device-show-week" label="显示星期">
                <DeviceSettingSwitch
                  label="显示星期"
                  checked={draft.showWeek}
                  onChange={(checked) => setDraft({ ...draft, showWeek: checked })}
                />
              </SettingField>
              <SettingField id="device-week-start" label="一周第一天">
                <Select
                  id="device-week-start"
                  aria-labelledby="device-week-start-label"
                  value={String(draft.weekStart)}
                  options={["0", "1"]}
                  renderOption={({ value }) => value === "0" ? "周日" : "周一"}
                  onChange={(value) => setDraft({ ...draft, weekStart: value === "0" ? 0 : 1 })}
                >
                  {draft.weekStart === 0 ? "周日" : "周一"}
                </Select>
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
        </div>
      ) : null}
    </Dialog>
  );
}
