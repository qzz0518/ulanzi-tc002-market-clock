import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Button, Dialog, Input, SurfaceCut, ToggleButton, ToggleGroup } from "@cladd-ui/react";
import { Check, ChevronDown, Copy, KeyRound, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { Callout } from "@/components/callout";
import { Disclosure } from "@/components/disclosure";
import { jsonApi } from "@/lib/api";
import { useAppToast } from "@/lib/use-app-toast";
import { errorMessage } from "@/lib/utils";
import {
  generateIngestToken,
  vibeAgentCommands,
  vibeAutostartCommands,
  vibeDisableIngestCommand,
  vibePushUrl,
  vibeServiceCommand,
  vibeUninstallCommand,
  VIBE_AGENT_HOSTS,
  VIBE_SERVICE_KINDS,
  type VibeAgentHost,
  type VibeCommand,
  type VibeServiceKind,
} from "@/lib/vibe-remote-setup";
import { formatVibeRelativeTime, type VibeIngestStatus } from "@/lib/vibe";

interface VibeRemoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ingest: VibeIngestStatus | null;
  nowMs: number;
  /** Lets the panel re-read status after a machine is forgotten. */
  onChanged: () => void;
}

function defaultOrigin(): string {
  return typeof window === "undefined" ? "http://127.0.0.1:43820" : window.location.origin;
}

export function VibeRemoteDialog(
  { open, onOpenChange, ingest, nowMs, onChanged }: VibeRemoteDialogProps,
) {
  const toast = useAppToast();
  const [serviceKind, setServiceKind] = useState<VibeServiceKind>("docker");
  const [host, setHost] = useState<VibeAgentHost>("here");
  // Generated up front rather than behind a button: a token is not a decision,
  // it is a prerequisite, and an empty one leaves every command below incomplete.
  const [token, setToken] = useState(generateIngestToken);
  const [origin, setOrigin] = useState(defaultOrigin);
  const [showAutostart, setShowAutostart] = useState(false);
  const [showUninstall, setShowUninstall] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busyMachine, setBusyMachine] = useState<string | null>(null);

  const input = useMemo(
    () => ({ origin, path: ingest?.path ?? "/v1/push", token }),
    [origin, ingest?.path, token],
  );
  const machines = ingest?.machines ?? [];
  const installed = machines.length > 0;

  const forget = useCallback(async (machine: string) => {
    setBusyMachine(machine);
    try {
      await jsonApi(`/api/vibe/ingest/machine?machine=${encodeURIComponent(machine)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      onChanged();
      toast.success(`已移除 ${machine}`, {
        description: "采集器若仍在那台机器上跑，下次推送还会出现。",
      });
    } catch (error) {
      toast.error("移除失败", { description: errorMessage(error) });
    } finally {
      setBusyMachine(null);
    }
  }, [onChanged, toast]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="vibe-remote"
      contentClassName="vibe-remote__content"
      title={(
        <div className="vibe-remote__title">
          <div>
            <span>VIBE</span>
            <strong>远程采集</strong>
          </div>
          <Button
            type="button"
            size="sm"
            square
            variant="transparent"
            outline={false}
            aria-label="关闭远程采集"
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </div>
      )}
    >
      <div className="vibe-remote__body">
        <p className="vibe-remote__lede">
          服务读不到你电脑上的代理登录时（它跑在 Docker 或另一台机器上），就在<strong>有登录的那台机器</strong>上跑个小程序把额度推过来。选两下，复制两条命令。
        </p>

        {installed && (
          <SurfaceCut contentClassName="vibe-remote__machines">
            {machines.map((entry) => (
              <div key={entry.machine} className="vibe-remote__machine">
                <span
                  className={`vibe-remote__dot${entry.stale ? " is-stale" : ""}`}
                  aria-hidden="true"
                />
                <strong>{entry.machine}</strong>
                <span className="vibe-remote__machine-meta">
                  {entry.providerIds.join("、") || "无已登录代理"}
                  {" · "}
                  {entry.stale ? "已过期" : formatVibeRelativeTime(entry.receivedAt, nowMs) ?? "刚刚"}
                </span>
                <Button
                  type="button"
                  size="sm"
                  color="neutral"
                  variant="transparent"
                  disabled={busyMachine === entry.machine}
                  onClick={() => void forget(entry.machine)}
                >
                  <Trash2 aria-hidden="true" />移除
                </Button>
              </div>
            ))}
          </SurfaceCut>
        )}

        <section className="vibe-remote__step">
          <div className="vibe-remote__step-head">
            <h3>1 · 这个服务是怎么起的？</h3>
            <ChoiceTrack>
              <ToggleGroup
                value={serviceKind}
                size="sm"
                activeColor="brand"
                // A second click on the pressed option reports undefined; a
                // single choice keeps what it had instead of emptying.
                onValueChange={(value) => { if (typeof value === "string") setServiceKind(value as VibeServiceKind); }}
                aria-label="服务的启动方式"
              >
                {VIBE_SERVICE_KINDS.map((entry) => (
                  <ToggleButton key={entry.id} value={entry.id}>{entry.label}</ToggleButton>
                ))}
              </ToggleGroup>
            </ChoiceTrack>
          </div>
          {ingest?.enabled
            ? (
              <p className="vibe-remote__done">
                <Check aria-hidden="true" />已经在接收了，这一步跳过。
              </p>
            )
            : <CommandBlock command={vibeServiceCommand(serviceKind, input)} />}
        </section>

        <section className="vibe-remote__step">
          <div className="vibe-remote__step-head">
            <h3>2 · 装了 Claude Code / Codex 的是哪台机器？</h3>
            <ChoiceTrack>
              <ToggleGroup
                value={host}
                size="sm"
                activeColor="brand"
                onValueChange={(value) => { if (typeof value === "string") setHost(value as VibeAgentHost); }}
                aria-label="采集器所在的机器"
              >
                {VIBE_AGENT_HOSTS.map((entry) => (
                  <ToggleButton key={entry.id} value={entry.id}>{entry.label}</ToggleButton>
                ))}
              </ToggleGroup>
            </ChoiceTrack>
          </div>

          {host !== "here" && (
            <label className="vibe-remote__field">
              <span>那台机器要用哪个地址访问这个服务</span>
              <Input value={origin} spellCheck={false} onChange={setOrigin} />
            </label>
          )}

          {vibeAgentCommands(host, input).map((command, index) => (
            <CommandBlock key={index} command={command} />
          ))}
        </section>

        <div className="vibe-remote__extras">
          <DisclosureRow
            icon={<RefreshCw aria-hidden="true" />}
            label="让它开机自启（可选）"
            open={showAutostart}
            onToggle={() => setShowAutostart((value) => !value)}
          >
            {vibeAutostartCommands(host, input).map((command, index) => (
              <CommandBlock key={index} command={command} />
            ))}
          </DisclosureRow>

          {installed && (
            <DisclosureRow
              icon={<Trash2 aria-hidden="true" />}
              label="卸载"
              open={showUninstall}
              onToggle={() => setShowUninstall((value) => !value)}
            >
              <p>
                先在那台机器上停掉采集器，再回到上面点「移除」把它从面板去掉
                —— 反过来的话，它下次推送又会出现。
              </p>
              <CommandBlock command={vibeUninstallCommand(host)} />
              <p>连接收也一并关掉的话：</p>
              <CommandBlock command={vibeDisableIngestCommand(serviceKind)} />
            </DisclosureRow>
          )}
        </div>

        <Callout icon={ShieldAlert} tone="warning" title="只能在凭据所属的那台机器上跑">
          <p>
            采集器会读取、并在快过期时刷新各家 CLI 的登录。厂商每次刷新都会作废旧的凭据，所以把它拿到别人的电脑上跑，会把对方挤出自己的 CLI 登录。
          </p>
        </Callout>

        {/* Was a <details>; now the same fold as the two above, so all three
            open the same way instead of one snapping and two sliding. */}
        <DisclosureRow
          icon={<KeyRound aria-hidden="true" />}
          label="高级：换一个令牌"
          open={showAdvanced}
          onToggle={() => setShowAdvanced((value) => !value)}
        >
          <div className="vibe-remote__field-row">
            <Input value={token} spellCheck={false} onChange={(next) => setToken(next.trim())} />
            <Button type="button" color="neutral" onClick={() => setToken(generateIngestToken())}>
              重新生成
            </Button>
          </div>
          <p>
            服务端与采集器两边必须一致；改了这里，上面两条命令都要重新执行一遍。推送地址 <code>{vibePushUrl(input)}</code>。
          </p>
        </DisclosureRow>
      </div>
    </Dialog>
  );
}

// The recessed track every single-choice control in the console sits in.
function ChoiceTrack({ children }: { children: ReactNode }) {
  return (
    <SurfaceCut
      className="segmented-track vibe-remote__choices"
      color="neutral"
      outline={false}
      contentClassName="segmented-track__content"
    >
      {children}
    </SurfaceCut>
  );
}

// The three optional extras: a quiet trigger with the block it opens in place
// under it, wrapped together so a shut block adds no second grid gap.
function DisclosureRow({ icon, label, open, onToggle, children }: {
  icon: ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="vibe-remote__extra">
      <Button
        type="button"
        size="sm"
        color="neutral"
        variant="transparent"
        outline={false}
        className="vibe-remote__toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        {icon}
        {label}
        <ChevronDown aria-hidden="true" className="disclosure-chevron" data-open={open} />
      </Button>
      <Disclosure open={open} bodyClassName="vibe-remote__fold">{children}</Disclosure>
    </div>
  );
}

function CommandBlock({ command }: { command: VibeCommand }) {
  return (
    <div className="vibe-remote__command">
      {command.label && <strong className="vibe-remote__command-label">{command.label}</strong>}
      {command.detail && <p>{command.detail}</p>}
      {command.file && <p className="vibe-remote__file"><code>{command.file}</code></p>}
      <CodeBlock code={command.code} />
      {command.note && <p>{command.note}</p>}
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // A console served over plain http has no clipboard API. The text stays
      // selectable, so saying nothing beats a button that lies.
      setCopied(false);
    }
  }, [code]);

  return (
    <div className="vibe-remote__code">
      <pre><code>{code}</code></pre>
      <Button
        type="button"
        size="sm"
        color="neutral"
        aria-label="复制"
        className="vibe-remote__copy"
        onClick={() => void copy()}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}
