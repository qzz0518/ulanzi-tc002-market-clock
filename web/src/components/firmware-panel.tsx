import { Play, Power, ShieldCheck, Wifi, X } from "lucide-react";
import { Button, Checkbox, Dialog } from "@cladd-ui/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { jsonApi } from "@/lib/api";
import type { FirmwareMode } from "@/lib/firmware-mode";
import { errorMessage } from "@/lib/utils";
import type { MusicDeviceAppStatus, MusicDeviceProbe } from "@/types";

// 侧载面板是两种固件（音乐 / 游戏）共用的：同一套三步流程、三重确认与恢复
// 指南，只有 API 前缀、确认口令和文案不同。状态与动作放在 hook 里，宿主页面
// 因此能用 statusLabel 渲染自己的触发按钮；<FirmwarePanel> 只负责抽屉本身。

// 侧载只占内存，所以「结束侧载 / 断电重启」之后回到的是**闪存里那一套**，
// 不一定是官方固件：本机的 ZOS 是刷进 res 分区的，断电重启回到的是 ZOS。
// 面板通篇的恢复承诺都用这个标签，别再写死「官方固件」。
const OFFICIAL_RESTORE_LABEL = "官方固件";
const ZOS_RESTORE_LABEL = "ZOS";

// 服务端的 restore 指南（src/tc002-music-installer.ts）是照官方固件写死的——它
// 不知道这台设备刷过 ZOS。所以刷过 ZOS 的机器上必须用这一份，而不是服务端那份。
const ZOS_RESTORE_GUIDE: MusicDeviceAppStatus["restore"] = {
  title: "回到 ZOS",
  steps: [
    "点「结束侧载」，时钟系统框架会重新拉起闪存里的 ZOS",
    "或直接断电重启 TC002——侧载固件只在内存里，重启后回到闪存里的 ZOS",
    "ZOS 起来后控制台「系统」页会重新收到设备上报，频道拉取与画面镜像随之恢复",
    "如需回到 Ulanzi 官方固件，得重新刷写 res 分区；断电重启做不到这件事",
  ],
};

export interface FirmwarePanelController {
  firmwareLabel: string;
  /** 结束侧载 / 断电重启之后回到的那套固件的名字。 */
  restoresTo: string;
  /** 闪存里是 ZOS：恢复路径与服务端写死的官方固件版本不一样。 */
  restoresToZos: boolean;
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
  /** 侧载前时钟在跑什么。ZOS 意味着闪存里是 ZOS，恢复承诺得跟着改。 */
  firmwareMode?: FirmwareMode;
}): FirmwarePanelController {
  const { apiPrefix, confirmation, firmwareLabel, firmwareMode = "official" } = options;
  // Latched, not read live: starting the sideload flips firmwareMode to
  // music/arcade, and forgetting that ZOS was underneath would put the panel
  // back to promising the official firmware exactly while it is most wrong.
  const [restoresToZos, setRestoresToZos] = useState(firmwareMode === "zos");
  useEffect(() => {
    if (firmwareMode === "zos") setRestoresToZos(true);
  }, [firmwareMode]);
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
    restoresTo: restoresToZos ? ZOS_RESTORE_LABEL : OFFICIAL_RESTORE_LABEL,
    restoresToZos,
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
    restoresTo,
    restoresToZos,
  } = controller;
  // 「恢复官方固件」在刷过 ZOS 的机器上是句假话——这个按钮做的事只有一件：
  // 结束侧载，把面板交还给闪存里的那套固件。
  const restoreActionLabel = restoresToZos ? "结束侧载" : `恢复${restoresTo}`;

  return (
    // fw-deploy--flow: the drawer body owns its vertical rhythm through the
    // container gap (globals.css), so nothing below adds a margin of its own —
    // including the cladd Surface the host page injects as {children}.
    <section className="fw-deploy fw-deploy--flow" aria-labelledby={headingId}>
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
            <span>3</span><div><strong>侧载固件</strong><small>{sessionMessage ?? (sessionActive ? `${firmwareLabel}运行中；点「${restoreActionLabel}」或断电重启即可回到${restoresTo}` : `固件包校验通过后解锁；由时钟系统框架从内存加载，不写入闪存，${restoresTo}原封不动`)}</small></div>
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

        {/* Consent, the two buttons it gates, and whatever the probe answers
            back are one decision — grouped so they sit at the tighter gap and
            the group as a whole keeps the section gap from its neighbours. */}
        <div className="fw-deploy-decision">
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
            {/* One string per node on purpose: React SSR splits adjacent text
                children with comment markers, which breaks copy assertions. */}
            <span>
              <strong>{`我知道如何回到${restoresTo}`}</strong>
              {`点「${restoreActionLabel}」立即回到${restoresTo}；断电重启同样自动恢复到${restoresTo}。仍异常时断电后按住 USB-C 旁的复位按钮再上电。`}
            </span>
          </label>

          <div className="fw-deploy-actions">
            <Button type="button" variant="transparent" outline loading={busy} disabled={busy} onClick={() => void controller.probeDevice()}><Wifi />检测 TC002</Button>
            {sessionActive ? (
              <Button type="button" color="brand" loading={busy} disabled={busy} onClick={() => void controller.stopSession()}><Power />{restoreActionLabel}</Button>
            ) : (
              <Button type="button" color="brand" loading={busy} disabled={!canStartSession || !recoveryAcknowledged || busy} onClick={() => void controller.startSession()}><Play />侧载固件</Button>
            )}
          </div>
          {error && <p className="music-inline-error" role="alert">{error}</p>}
          {(error || deviceProbe?.connected === false) && <DeviceReconnectGuidance />}
        </div>

        {/* 服务端也发一份恢复指南，但它是照官方固件写死的：刷过 ZOS 的机器上
            那份是错的（断电重启回到的是 ZOS），所以这时用本地这份，不用它的。 */}
        <div className="fw-recovery-guide">
          <span><ShieldCheck /> 非持久化设计</span>
          <h3>{(restoresToZos ? ZOS_RESTORE_GUIDE : deviceApp?.restore)?.title ?? "回到 Ulanzi 官方固件"}</h3>
          <ol>
            {((restoresToZos ? ZOS_RESTORE_GUIDE : deviceApp?.restore)?.steps ?? [
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
