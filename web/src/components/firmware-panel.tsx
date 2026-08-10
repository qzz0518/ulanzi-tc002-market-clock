import { Play, Power, ShieldCheck, Wifi, X } from "lucide-react";
import { Button, Checkbox, Dialog } from "@cladd-ui/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { jsonApi } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import type { MusicDeviceAppStatus, MusicDeviceProbe } from "@/types";

// 侧载面板是两种固件（音乐 / 游戏）共用的：同一套三步流程、三重确认与恢复
// 指南，只有 API 前缀、确认口令和文案不同。状态与动作放在 hook 里，宿主页面
// 因此能用 statusLabel 渲染自己的触发按钮；<FirmwarePanel> 只负责抽屉本身。

export interface FirmwarePanelController {
  firmwareLabel: string;
  open: boolean;
  /** Busy-guarded: ignored while a device operation is in flight. */
  setOpen: (open: boolean) => void;
  /** Opens the drawer and immediately re-probes the device. */
  openPanel: () => void;
  deviceApp: MusicDeviceAppStatus | null;
  deviceProbe: MusicDeviceProbe | null;
  busy: boolean;
  error: string | null;
  sessionMessage: string | null;
  recoveryAcknowledged: boolean;
  setRecoveryAcknowledged: (value: boolean) => void;
  sessionActive: boolean;
  canStartSession: boolean;
  statusLabel: string;
  loadDeviceApp: () => Promise<void>;
  probeDevice: () => Promise<void>;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
}

// 触发按钮上的一句话状态；单独导出方便直接测试。
export function firmwareStatusLabel(
  deviceApp: MusicDeviceAppStatus | null,
  deviceProbe: MusicDeviceProbe | null,
  firmwareLabel: string,
): string {
  if (deviceApp?.session?.active === true) return `${firmwareLabel}运行中`;
  if (deviceProbe?.connected) return "TC002 已连接";
  if (deviceApp?.artifact.state === "ready") return "固件包已就绪";
  return "侧载固件";
}

export function useFirmwarePanel(options: {
  apiPrefix: string;      // "/api/music" | "/api/arcade"
  confirmation: string;   // the exact phrase the server demands
  firmwareLabel: string;  // "音乐固件" | "游戏固件"
}): FirmwarePanelController {
  const { apiPrefix, confirmation, firmwareLabel } = options;
  const [open, setOpenState] = useState(false);
  const [deviceApp, setDeviceApp] = useState<MusicDeviceAppStatus | null>(null);
  const [deviceProbe, setDeviceProbe] = useState<MusicDeviceProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);

  const loadDeviceApp = useCallback(async () => {
    try {
      const result = await jsonApi<{ deviceApp: MusicDeviceAppStatus }>(`${apiPrefix}/device-app`);
      setDeviceApp(result.deviceApp);
      setError(null);
    } catch (error) {
      setError(errorMessage(error));
    }
  }, [apiPrefix]);

  useEffect(() => {
    void loadDeviceApp();
  }, [loadDeviceApp]);

  const probeDevice = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await jsonApi<{ device: MusicDeviceProbe }>(
        `${apiPrefix}/device-app/probe`,
        { method: "POST" },
      );
      setDeviceProbe(result.device);
      // 探测让服务端核实了会话真实状态（断电重启后自动回落为未运行），
      // 回读一次让按钮和步骤跟随设备现状。
      await loadDeviceApp();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [apiPrefix, loadDeviceApp]);

  const startSession = useCallback(async () => {
    if (!deviceApp?.artifact.bundleId || !recoveryAcknowledged) return;
    setBusy(true);
    setError(null);
    try {
      const result = await jsonApi<{ result: { message: string } }>(
        `${apiPrefix}/device-app/session/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmation,
            expectedBundleId: deviceApp.artifact.bundleId,
          }),
        },
      );
      setSessionMessage(result.result.message);
      await loadDeviceApp();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [apiPrefix, confirmation, deviceApp, loadDeviceApp, recoveryAcknowledged]);

  const stopSession = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await jsonApi<{ result: { message: string } }>(
        `${apiPrefix}/device-app/session/stop`,
        { method: "POST" },
      );
      setSessionMessage(result.result.message);
      await loadDeviceApp();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [apiPrefix, loadDeviceApp]);

  const sessionActive = deviceApp?.session?.active === true;
  const canStartSession = deviceApp?.artifact.state === "ready"
    && deviceProbe?.connected === true
    && !sessionActive;

  return {
    firmwareLabel,
    open,
    setOpen: (next) => {
      if (!busy) setOpenState(next);
    },
    openPanel: () => {
      setOpenState(true);
      // 打开面板即核实设备现状：断电重启后按钮要回到「侧载固件」。
      void probeDevice();
    },
    deviceApp,
    deviceProbe,
    busy,
    error,
    sessionMessage,
    recoveryAcknowledged,
    setRecoveryAcknowledged,
    sessionActive,
    canStartSession,
    statusLabel: firmwareStatusLabel(deviceApp, deviceProbe, firmwareLabel),
    loadDeviceApp,
    probeDevice,
    startSession,
    stopSession,
  };
}

export function DeviceReconnectGuidance() {
  return (
    <p className="music-device-reconnect-guidance" role="status">
      <Power aria-hidden="true" />
      <span><strong>仍然无法检测？</strong>如果无法检测到设备，请关机并连接到电脑再开机。</span>
    </p>
  );
}

// The drawer body, exported separately: the Cladd Dialog renders through a
// portal (nothing in SSR), so tests exercise the body directly.
export function FirmwarePanelBody({
  controller,
  heading,
  description,
  headingId,
  children,
}: {
  controller: FirmwarePanelController;
  heading: string;
  description: string;
  headingId: string;
  children?: ReactNode;
}) {
  const {
    deviceApp,
    deviceProbe,
    busy,
    error,
    sessionMessage,
    recoveryAcknowledged,
    setRecoveryAcknowledged,
    sessionActive,
    canStartSession,
    firmwareLabel,
  } = controller;

  return (
    <section className="fw-deploy" aria-labelledby={headingId}>
        <div className="music-section-heading">
          <span>SIDELOAD FIRMWARE</span>
          <h2 id={headingId}>{heading}</h2>
          <p>{description}</p>
        </div>

        <ol className="fw-deploy-steps">
          <li className={deviceApp?.artifact.state === "ready" ? "is-done" : "is-current"}>
            <span>1</span><div><strong>校验固件包</strong><small>{deviceApp?.artifact.message ?? "正在读取发布清单…"}</small></div>
          </li>
          <li className={deviceProbe?.connected ? "is-done" : deviceApp?.artifact.state === "ready" ? "is-current" : undefined}>
            <span>2</span><div><strong>检测 TC002</strong><small>{deviceProbe?.message ?? (deviceApp?.adb === "missing" ? "后台服务尚未识别 adb；请重新运行安装脚本" : "通过 HTTP 与 Wi-Fi ADB 双重确认")}</small></div>
          </li>
          <li className={sessionActive ? "is-done" : canStartSession ? "is-current" : undefined}>
            <span>3</span><div><strong>侧载固件</strong><small>{sessionMessage ?? (sessionActive ? `${firmwareLabel}运行中；点「恢复官方固件」或断电重启即可回到原样` : "固件包校验通过后解锁；由时钟系统框架从内存加载，不写入官方固件")}</small></div>
          </li>
        </ol>

        {deviceProbe?.connected && (
          <dl className="fw-device-facts">
            <div><dt>设备</dt><dd>{deviceProbe.model || "TC002"}</dd></div>
            <div><dt>平台</dt><dd>{deviceProbe.platform || "Z21"}</dd></div>
            <div><dt>应用</dt><dd>{deviceProbe.appVersion || "—"}</dd></div>
            <div><dt>MCU</dt><dd>{deviceProbe.mcuVersion || "—"}</dd></div>
          </dl>
        )}

        {children}

        <label className="fw-recovery-acknowledgement">
          <Checkbox
            as="span"
            className="fw-recovery-checkbox"
            input
            size="md"
            color="brand"
            checked={recoveryAcknowledged}
            onChange={setRecoveryAcknowledged}
          />
          <span><strong>我知道如何回到官方固件</strong>点「恢复官方固件」立即回到官方界面；断电重启同样自动恢复。仍异常时断电后按住 USB-C 旁的复位按钮再上电。</span>
        </label>

        <div className="fw-deploy-actions">
          <Button type="button" variant="transparent" outline loading={busy} disabled={busy} onClick={() => void controller.probeDevice()}><Wifi />检测 TC002</Button>
          {sessionActive ? (
            <Button type="button" color="brand" loading={busy} disabled={busy} onClick={() => void controller.stopSession()}><Power />恢复官方固件</Button>
          ) : (
            <Button type="button" color="brand" loading={busy} disabled={!canStartSession || !recoveryAcknowledged || busy} onClick={() => void controller.startSession()}><Play />侧载固件</Button>
          )}
        </div>
        {error && <p className="music-inline-error" role="alert">{error}</p>}
        {(error || deviceProbe?.connected === false) && <DeviceReconnectGuidance />}

        <div className="fw-recovery-guide">
          <span><ShieldCheck /> 非持久化设计</span>
          <h3>{deviceApp?.restore?.title ?? "回到 Ulanzi 官方固件"}</h3>
          <ol>
            {(deviceApp?.restore?.steps ?? [
              "点「恢复官方固件」，官方界面立即恢复",
              "或直接断电重启 TC002——固件只在内存里，重启后自动回到官方固件",
              "如界面仍异常，断电后按住 USB-C 旁的复位按钮再上电（官方恢复方式）",
              "恢复后重新检查 Wi-Fi、亮度、时区和音量设置",
            ]).map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      </section>
  );
}

export function FirmwarePanel({
  controller,
  heading,
  description,
  dialogClassName,
  eyebrow = "DEVICE / FIRMWARE",
  title = "设备与固件",
  children,
}: {
  controller: FirmwarePanelController;
  heading: string;          // "侧载音乐固件" | "侧载游戏固件"
  description: string;
  dialogClassName: string;  // "music-firmware-dialog" | "arcade-firmware-dialog"
  eyebrow?: string;
  title?: string;
  /** Extra live status (e.g. the arcade's current game) below the probe facts. */
  children?: ReactNode;
}) {
  const { busy } = controller;
  const headingId = `${dialogClassName}-deploy-title`;

  return (
    <Dialog
      open={controller.open}
      onOpenChange={controller.setOpen}
      className={dialogClassName}
      contentClassName={`${dialogClassName}__content`}
      closeOnBackdropClick={!busy}
      closeOnEscape={!busy}
      title={(
        <div className={`${dialogClassName}__title`}>
          <div><span>{eyebrow}</span><strong>{title}</strong></div>
          <Button
            type="button"
            size="sm"
            square
            variant="transparent"
            outline={false}
            aria-label={`关闭${title}`}
            disabled={busy}
            onClick={() => controller.setOpen(false)}
          >
            <X />
          </Button>
        </div>
      )}
    >
      <FirmwarePanelBody
        controller={controller}
        heading={heading}
        description={description}
        headingId={headingId}
      >
        {children}
      </FirmwarePanelBody>
    </Dialog>
  );
}
