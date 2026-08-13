import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bluetooth,
  BluetoothSearching,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  RefreshCw,
  Signal,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import {
  Button,
  Chip,
  Dialog,
  Input,
  List,
  ListButton,
  ListItem,
  ListTitle,
  OTPField,
  Spinner,
  Surface,
  SurfaceCut,
} from "@cladd-ui/react";
import {
  BLE_CONNECT_STAGE_LABELS,
  ZOS_BLE_NAME_PREFIX,
  createProvisionSession,
  describeBleSupport,
  describeProgress,
  pskError,
  securityLabel,
  signalBars,
  signalLabel,
  ssidError,
  type BleSupport,
  type ProvisionSession,
  type ProvisionState,
} from "@/lib/ble-provisioning";
import {
  createWebBluetoothTransport,
  probeBleAdapter,
  readBleEnvironment,
} from "@/components/zos/web-bluetooth-transport";
import { useAppToast } from "@/lib/use-app-toast";

const CODE_LENGTH = 6;

// The dialog needs a clock of its own only for the lockout countdown; nothing
// else here changes without a device event.
const COUNTDOWN_TICK_MS = 500;

/** The one place the console admits what the no-Chrome path actually costs. */
function PortalFallback() {
  return (
    <p className="text-cladd-fg-softer text-cladd-xs leading-relaxed">
      兜底方案：时钟自带的配网页在设备地址的 <code className="font-mono">8080</code> 端口，
      Safari 和 Firefox 都能打开——但它要求时钟已经在网上，
      所以它只能救「换了路由器密码」这类情况，救不了一台完全连不上的时钟。
    </p>
  );
}

interface StepStripProps {
  step: ProvisionState["step"];
}

const STRIP: Array<{ key: ProvisionState["step"][]; label: string }> = [
  { key: ["ready", "connecting"], label: "选择时钟" },
  { key: ["code"], label: "验证" },
  { key: ["networks"], label: "选网络" },
  { key: ["password"], label: "密码" },
  { key: ["joining", "done"], label: "连接" },
];

function StepStrip({ step }: StepStripProps) {
  const current = STRIP.findIndex((entry) => entry.key.includes(step));
  if (current < 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="配网步骤">
      {STRIP.map((entry, index) => (
        <li key={entry.label} className="flex items-center gap-1.5">
          <span
            className={index <= current ? "text-cladd-primary text-cladd-xs" : "text-cladd-fg-softest text-cladd-xs"}
            aria-current={index === current ? "step" : undefined}
          >
            {entry.label}
          </span>
          {index < STRIP.length - 1 && (
            <span aria-hidden="true" className="text-cladd-fg-softest text-cladd-xs">›</span>
          )}
        </li>
      ))}
    </ol>
  );
}

interface ProvisionBodyProps {
  support: BleSupport;
  state: ProvisionState;
  code: string;
  psk: string;
  revealPsk: boolean;
  manualDraft: string;
  lockoutSeconds: number;
  onCodeChange: (value: string) => void;
  onPskChange: (value: string) => void;
  onRevealChange: (value: boolean) => void;
  onManualDraftChange: (value: string) => void;
  onStart: () => void;
  onSubmitCode: () => void;
  onRescan: () => void;
  onPickNetwork: (ssid: string) => void;
  onUseManual: () => void;
  onSubmitPassword: () => void;
  onBackToNetworks: () => void;
  onRetry: () => void;
}

/**
 * Exported for tests: cladd's Dialog renders through a portal and server-renders
 * to an empty string, so the body is the only seam markup can be asserted on.
 * The same trick `DeviceHostPanel` uses in the device settings dialog.
 */
export function ZosProvisionBody(props: ProvisionBodyProps) {
  const { support, state } = props;

  if (!support.ok) {
    return (
      <div className="flex flex-col gap-3">
        <Surface variant="solid" outline color="neutral" contentClassName="flex flex-col gap-2 p-4">
          <span className="flex items-center gap-2 text-cladd-fg">
            <CircleAlert aria-hidden="true" className="size-4" />
            <strong>{support.title}</strong>
          </span>
          <p className="text-cladd-fg-soft text-cladd-sm leading-relaxed">{support.detail}</p>
        </Surface>
        <PortalFallback />
      </div>
    );
  }

  if (state.step === "ready") {
    return (
      <div className="flex flex-col gap-3">
        <StepStrip step={state.step} />
        <p className="text-cladd-fg-soft text-cladd-sm leading-relaxed">
          点下面的按钮后，系统会弹出蓝牙设备列表。选名字以
          {" "}<code className="font-mono">{ZOS_BLE_NAME_PREFIX}</code>{" "}
          开头的那一台——时钟面板上正显示同一个名字，两边对上就不会选错。
        </p>
        <p className="text-cladd-fg-softer text-cladd-xs leading-relaxed">
          配网走蓝牙，时钟的无线网卡全程留在station模式，所以它能一边跟这里说话一边扫描和连接。
        </p>
      </div>
    );
  }

  if (state.step === "connecting") {
    return (
      <div className="flex flex-col gap-3">
        <StepStrip step={state.step} />
        <div className="flex items-center gap-2.5" role="status">
          <Spinner size="md" color="brand" />
          <span className="text-cladd-fg-soft text-cladd-sm">
            {state.connectStage === null ? "正在准备" : BLE_CONNECT_STAGE_LABELS[state.connectStage]}
          </span>
        </div>
        <p className="text-cladd-fg-softer text-cladd-xs leading-relaxed">
          每一行只在浏览器真的走到那一步时才前进，不按秒数走。
        </p>
      </div>
    );
  }

  if (state.step === "code") {
    const lockedOut = props.lockoutSeconds > 0;
    return (
      <div className="flex flex-col gap-3">
        <StepStrip step={state.step} />
        <p className="text-cladd-fg-soft text-cladd-sm leading-relaxed">
          输入时钟面板上正在显示的六位数字。它每次配网都会重新生成，
          既是授权，也是「你选的确实是眼前这台」的凭据。
        </p>
        <OTPField
          maxLength={CODE_LENGTH}
          size="lg"
          value={props.code}
          valid={state.codeError === null}
          disabled={state.busy || lockedOut}
          onChange={props.onCodeChange}
        />
        {state.device?.name ? (
          <div className="flex flex-wrap items-center gap-2">
            <Chip size="sm" color="brand" variant="transparent" icon={Bluetooth} iconProps={{ "aria-hidden": true }}>
              {state.device.name}
            </Chip>
            {state.device.build ? (
              <Chip size="sm" color="neutral" variant="transparent">固件 {state.device.build}</Chip>
            ) : null}
          </div>
        ) : null}
        {state.codeError ? (
          <p className="text-cladd-red text-cladd-sm" role="alert">{state.codeError}</p>
        ) : null}
        {lockedOut ? (
          <p className="text-cladd-fg-softer text-cladd-xs" role="status" aria-live="polite">
            时钟暂停接受验证码，还剩 {props.lockoutSeconds} 秒。
          </p>
        ) : null}
      </div>
    );
  }

  if (state.step === "networks") {
    const total = state.networkTotal;
    const pending = state.scanning && total !== null ? Math.max(0, total - state.networks.length) : 0;
    const empty = !state.scanning && state.networks.length === 0;
    const manualError = ssidError(props.manualDraft.trim());
    return (
      <div className="flex flex-col gap-3">
        <StepStrip step={state.step} />
        <p className="text-cladd-fg-soft text-cladd-sm leading-relaxed">
          这里只显示时钟自己扫到的 2.4G 网络——时钟没有 5G 射频，
          手机上看得到的 5G 网络在这里不会出现，也连不上。
        </p>
        {state.scanCached ? (
          <p className="text-cladd-yellow text-cladd-xs" role="status">
            这份列表来自时钟上一次扫描的缓存，可能已经过期。可以点「重新扫描」要一份新的。
          </p>
        ) : null}
        <List className="max-h-72 overflow-y-auto">
          <ListTitle>
            {state.scanning
              ? total === null ? "正在扫描…" : `正在扫描…已收到 ${state.networks.length} / ${total}`
              : `扫到 ${state.networks.length} 个网络`}
          </ListTitle>
          {state.networks.map((network) => (
            <ListButton
              key={network.ssid}
              size="md"
              color="brand"
              icon={network.secured ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
              footer={`${securityLabel(network.sec)} · 信号${signalLabel(network.rssi)}`}
              after={(
                <Chip size="sm" color="neutral" variant="transparent" icon={Signal} iconProps={{ "aria-hidden": true }}>
                  {signalBars(network.rssi)} / 4
                </Chip>
              )}
              onClick={() => props.onPickNetwork(network.ssid)}
            >
              {network.ssid}
            </ListButton>
          ))}
          {Array.from({ length: pending }).map((_, index) => (
            // A determinate skeleton: the device told us how many are coming, so
            // the list says so instead of leaving a spinner that might never end.
            <ListItem key={`pending-${index}`}>
              <span className="text-cladd-fg-softest">等待第 {state.networks.length + index + 1} 个…</span>
            </ListItem>
          ))}
          {empty ? (
            <ListItem>
              <span className="text-cladd-fg-soft">
                时钟没有扫到任何 2.4G 网络。可以再扫一次，或者直接手动填名称。
              </span>
            </ListItem>
          ) : null}
        </List>
        <SurfaceCut color="neutral" contentClassName="flex flex-col gap-2 p-3">
          <span className="text-cladd-fg-soft text-cladd-sm">找不到？直接输入网络名称</span>
          <div className="flex flex-wrap items-end gap-2">
            <Input
              inputId="zos-provision-manual-ssid"
              size="md"
              className="min-w-52 flex-1"
              value={props.manualDraft}
              placeholder="网络名称（SSID）"
              valid={props.manualDraft === "" || manualError === null}
              errorMessage={props.manualDraft === "" ? undefined : manualError ?? undefined}
              onChange={props.onManualDraftChange}
            />
            <Button
              type="button"
              size="md"
              color="neutral"
              disabled={manualError !== null}
              onClick={props.onUseManual}
            >
              下一步
            </Button>
          </div>
          {state.credentialError !== null ? (
            <span className="text-cladd-red text-cladd-xs" role="alert">{state.credentialError}</span>
          ) : null}
          <span className="text-cladd-fg-softest text-cladd-xs">
            隐藏 SSID 不会出现在扫描结果里；名称要一字不差，包括大小写。
          </span>
        </SurfaceCut>
      </div>
    );
  }

  if (state.step === "password") {
    // Mirrors the firmware's own pskIsSafe, so an 8-character rule costs a
    // keystroke here instead of a BLE round trip and an opaque `evt err`.
    const pskProblem = props.psk === "" ? null : pskError(props.psk, state.secured);
    return (
      <div className="flex flex-col gap-3">
        <StepStrip step={state.step} />
        <SurfaceCut color="neutral" contentClassName="flex items-center gap-2 p-3">
          <Wifi aria-hidden="true" className="size-4 text-cladd-fg-soft" />
          <span className="font-mono text-cladd-fg">{state.ssid}</span>
          {state.manualSsid ? <Chip size="sm" color="neutral" variant="transparent">手动输入</Chip> : null}
        </SurfaceCut>
        <Input
          inputId="zos-provision-psk"
          type={props.revealPsk ? "text" : "password"}
          size="lg"
          value={props.psk}
          placeholder={state.secured ? "Wi-Fi 密码" : "这个网络不需要密码"}
          disabled={!state.secured}
          valid={pskProblem === null}
          errorMessage={pskProblem ?? undefined}
          suffix={(
            <Button
              type="button"
              size="sm"
              variant="transparent"
              outline={false}
              color="neutral"
              className="mr-1"
              aria-label={props.revealPsk ? "隐藏密码" : "显示密码"}
              onClick={() => props.onRevealChange(!props.revealPsk)}
            >
              {props.revealPsk ? <EyeOff /> : <Eye />}
            </Button>
          )}
          onChange={props.onPskChange}
        />
        <p className="text-cladd-fg-softer text-cladd-xs leading-relaxed">
          从时钟那一头看，名字打错和密码打错是同一件事——都只是「连不上」。
          所以能在本地核对的那一半，这里让你看得见。
        </p>
        {state.credentialError !== null ? (
          // The session refused it, not the input. Both validate; only this one
          // is on the path every caller takes.
          <p className="text-cladd-red text-cladd-xs" role="alert">{state.credentialError}</p>
        ) : null}
        <p className="text-cladd-fg-softest text-cladd-xs leading-relaxed">
          密码只经蓝牙发给时钟，不写日志、不回显、也不经过服务。
          这一版蓝牙链路没有加密，六位数字是授权而不是保密——它挡得住邻居改你的时钟，挡不住同一房间里的嗅探。
        </p>
      </div>
    );
  }

  if (state.step === "joining") {
    const steps = describeProgress(state.phase);
    return (
      <div className="flex flex-col gap-3">
        <StepStrip step={state.step} />
        <ol className="flex flex-col gap-2" aria-label="连接进度">
          {steps.map((step) => (
            <li key={step.key} className="flex items-center gap-2">
              {step.state === "done" ? (
                <Check aria-hidden="true" className="size-4 text-cladd-primary" />
              ) : step.state === "active" ? (
                <Spinner size="sm" color="brand" />
              ) : (
                <span aria-hidden="true" className="size-4 text-center text-cladd-fg-softest">·</span>
              )}
              <span className={step.state === "pending" ? "text-cladd-fg-softest text-cladd-sm" : "text-cladd-fg text-cladd-sm"}>
                {step.label}
              </span>
            </li>
          ))}
        </ol>
        {state.bleDropped ? (
          // The single most important sentence in this flow: on this hardware the
          // BLE link usually dies at exactly the moment the join succeeds.
          <Surface variant="solid" outline color="neutral" contentClassName="flex flex-col gap-1.5 p-3">
            <span className="flex items-center gap-2 text-cladd-fg">
              <BluetoothSearching aria-hidden="true" className="size-4" />
              <strong>蓝牙断开了，这在连上 Wi-Fi 时是正常的</strong>
            </span>
            <span className="text-cladd-fg-soft text-cladd-sm leading-relaxed">
              时钟的 Wi-Fi 和蓝牙共用同一颗芯片，连上网络的那一刻蓝牙掉线是预期内的。
              现在改从局域网上等它出现，最多再等约 40 秒。
            </span>
          </Surface>
        ) : (
          <p className="text-cladd-fg-softer text-cladd-xs leading-relaxed">
            每一步只在时钟自己报告到那一步时才点亮。关联和获取地址是两件事，
            路由器认了密码不等于已经发了地址。
          </p>
        )}
      </div>
    );
  }

  if (state.step === "done") {
    return (
      <div className="flex flex-col gap-3">
        <StepStrip step={state.step} />
        <Surface variant="solid" outline color="brand" contentClassName="flex flex-col gap-1.5 p-4">
          <span className="flex items-center gap-2 text-cladd-fg">
            <Check aria-hidden="true" className="size-4" />
            <strong>时钟已经连上{state.ssid ? `「${state.ssid}」` : "网络"}</strong>
          </span>
          {state.ip ? (
            <span className="font-mono text-cladd-fg-soft text-cladd-sm">{state.ip}</span>
          ) : (
            <span className="text-cladd-fg-soft text-cladd-sm">
              时钟已经回到局域网上，地址稍后会出现在设备状态里。
            </span>
          )}
        </Surface>
        <p className="text-cladd-fg-softer text-cladd-xs leading-relaxed">
          局域网上没有任何东西会广播控制台地址。时钟还看不到频道的话，
          到「设备信息」里确认它拉取的服务地址填对了。
        </p>
      </div>
    );
  }

  const failure = state.failure;
  return (
    <div className="flex flex-col gap-3">
      <Surface variant="solid" outline color="red" contentClassName="flex flex-col gap-1.5 p-4">
        <span className="flex items-center gap-2 text-cladd-fg">
          <TriangleAlert aria-hidden="true" className="size-4" />
          <strong>{failure?.title ?? "配网没有完成"}</strong>
        </span>
        <span className="text-cladd-fg-soft text-cladd-sm leading-relaxed">
          {failure?.detail ?? "时钟没有说明原因。"}
        </span>
      </Surface>
      <p className="text-cladd-fg-softest text-cladd-xs leading-relaxed">
        这一轮的完整过程写在时钟的 <code className="font-mono">/data/zos-provision.log</code> 里，
        断电也还在——面板上的那句话和这里说的是同一个状态。
      </p>
    </div>
  );
}

/**
 * The browser gate, refined once `getAvailability()` answers.
 *
 * Shared with the panel on purpose: the entry point must never render a button
 * that cannot work, so whatever decides the dialog's first screen has to be the
 * same thing that decides whether the button exists at all.
 */
export function useBleSupport(active = true): BleSupport {
  const [adapter, setAdapter] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void probeBleAdapter().then((available) => {
      if (!cancelled) setAdapter(available);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return useMemo(
    () => describeBleSupport({ ...readBleEnvironment(), adapterAvailable: adapter }),
    [adapter],
  );
}

export interface ZosProvisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires once the clock is back on the LAN, so the panel can refresh at once. */
  onProvisioned?: () => void;
}

export function ZosProvisionDialog({
  open,
  onOpenChange,
  onProvisioned,
}: ZosProvisionDialogProps) {
  const toast = useAppToast();
  const sessionRef = useRef<ProvisionSession | null>(null);
  const [state, setState] = useState<ProvisionState | null>(null);
  const [code, setCode] = useState("");
  const [psk, setPsk] = useState("");
  const [revealPsk, setRevealPsk] = useState(false);
  const [manualDraft, setManualDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const support = useBleSupport(open);

  // Every session gets a fresh transport: Web Bluetooth has no silent
  // reconnect, so a device handle from a closed session is worth nothing.
  useEffect(() => {
    if (!open) return;
    const session = createProvisionSession({
      transport: createWebBluetoothTransport(),
      readOsState: async () => {
        const response = await fetch("/api/os/state", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // `seq` and `wifi` are the two fields that turn "the clock is live" into
        // "the clock came back on the network I asked for". Dropping them here
        // is what made a failed join report success at the old address.
        const body = await response.json() as {
          live?: boolean;
          telemetry?: { ip?: string; wifi?: string; seq?: number } | null;
        };
        return {
          live: body.live === true,
          ip: body.telemetry?.ip ?? null,
          ssid: body.telemetry?.wifi ?? null,
          reportSeq: body.telemetry?.seq ?? 0,
        };
      },
      onChange: setState,
    });
    sessionRef.current = session;
    setState(session.getState());
    setCode("");
    setPsk("");
    setRevealPsk(false);
    setManualDraft("");
    return () => {
      session.close();
      sessionRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || state?.lockedOutUntilMs == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [open, state?.lockedOutUntilMs]);

  const doneRef = useRef(false);
  useEffect(() => {
    if (state?.step === "done" && !doneRef.current) {
      doneRef.current = true;
      toast.success("时钟已连上网络", {
        description: state.ip ?? "地址稍后出现在设备状态里。",
      });
      onProvisioned?.();
    }
    if (state?.step !== "done") doneRef.current = false;
  }, [onProvisioned, state?.ip, state?.step, toast]);

  const lockoutSeconds = state?.lockedOutUntilMs == null
    ? 0
    : Math.max(0, Math.ceil((state.lockedOutUntilMs - now) / 1000));

  const submitCode = useCallback(() => {
    if (code.length !== CODE_LENGTH) return;
    void sessionRef.current?.submitCode(code);
  }, [code]);

  const requestClose = (next: boolean) => {
    if (!next) sessionRef.current?.close();
    onOpenChange(next);
  };

  const step = state?.step ?? "ready";
  const busy = state?.busy === true;

  const footer = (() => {
    if (!support.ok) {
      return <Button type="button" color="neutral" onClick={() => requestClose(false)}>知道了</Button>;
    }
    if (step === "ready") {
      return (
        <>
          <Button type="button" color="neutral" onClick={() => requestClose(false)}>取消</Button>
          <Button
            type="button"
            size="lg"
            color="brand"
            onClick={() => void sessionRef.current?.start()}
          >
            <Bluetooth />选择时钟
          </Button>
        </>
      );
    }
    if (step === "connecting") {
      return <Button type="button" color="neutral" onClick={() => requestClose(false)}>取消</Button>;
    }
    if (step === "code") {
      return (
        <>
          <Button type="button" color="neutral" onClick={() => requestClose(false)}>取消</Button>
          <Button
            type="button"
            color="brand"
            loading={busy}
            disabled={busy || code.length !== CODE_LENGTH || lockoutSeconds > 0}
            onClick={submitCode}
          >
            验证
          </Button>
        </>
      );
    }
    if (step === "networks") {
      return (
        <>
          <Button type="button" color="neutral" onClick={() => requestClose(false)}>取消</Button>
          <Button
            type="button"
            color="neutral"
            disabled={state?.scanning === true}
            onClick={() => void sessionRef.current?.rescan()}
          >
            <RefreshCw />重新扫描
          </Button>
        </>
      );
    }
    if (step === "password") {
      const blocked = ssidError(state?.ssid ?? "") !== null
        || pskError(psk, state?.secured !== false) !== null;
      return (
        <>
          <Button type="button" color="neutral" onClick={() => sessionRef.current?.backToNetworks()}>
            返回
          </Button>
          <Button
            type="button"
            color="brand"
            loading={busy}
            disabled={busy || blocked}
            onClick={() => void sessionRef.current?.submitPassword(psk)}
          >
            <Wifi />连接
          </Button>
        </>
      );
    }
    if (step === "joining") {
      return <Button type="button" color="neutral" onClick={() => requestClose(false)}>在后台继续</Button>;
    }
    if (step === "done") {
      return (
        <Button type="button" color="brand" onClick={() => requestClose(false)}>完成</Button>
      );
    }
    return (
      <>
        <Button type="button" color="neutral" onClick={() => requestClose(false)}>关闭</Button>
        {state?.failure?.retryTo === null ? null : (
          <Button type="button" color="brand" onClick={() => void sessionRef.current?.retry()}>
            {state?.failure?.retryLabel ?? "重试"}
          </Button>
        )}
      </>
    );
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={requestClose}
      title="蓝牙配网"
      text="给时钟换一个 Wi-Fi，或者让一台还没联网的时钟第一次上网。"
      className="zos-provision-dialog"
      buttons={<div className="flex w-full flex-wrap items-center justify-end gap-2">{footer}</div>}
    >
      {state && (
        <ZosProvisionBody
          support={support}
          state={state}
          code={code}
          psk={psk}
          revealPsk={revealPsk}
          manualDraft={manualDraft}
          lockoutSeconds={lockoutSeconds}
          onCodeChange={(value) => {
            setCode(value);
            if (value.length === CODE_LENGTH) void sessionRef.current?.submitCode(value);
          }}
          onPskChange={setPsk}
          onRevealChange={setRevealPsk}
          onManualDraftChange={setManualDraft}
          onStart={() => void sessionRef.current?.start()}
          onSubmitCode={submitCode}
          onRescan={() => void sessionRef.current?.rescan()}
          onPickNetwork={(ssid) => {
            setPsk("");
            setRevealPsk(false);
            sessionRef.current?.chooseNetwork(ssid);
          }}
          onUseManual={() => {
            setPsk("");
            setRevealPsk(false);
            sessionRef.current?.useManualSsid(manualDraft.trim());
          }}
          onSubmitPassword={() => void sessionRef.current?.submitPassword(psk)}
          onBackToNetworks={() => sessionRef.current?.backToNetworks()}
          onRetry={() => void sessionRef.current?.retry()}
        />
      )}
    </Dialog>
  );
}
