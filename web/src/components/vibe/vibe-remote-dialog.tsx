import { useCallback, useMemo, useState } from "react";
import { Button, Dialog, Input, SurfaceCut, ToggleButton, ToggleGroup } from "@cladd-ui/react";
import { Check, Copy, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
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
          服务读不到你电脑上的代理登录时（它跑在 Docker 或另一台机器上），
          就在<strong>有登录的那台机器</strong>上跑个小程序把额度推过来。选两下，复制两条命令。
        </p>

        {installed && (
          <SurfaceCut className="vibe-remote__machines">
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
            <ToggleGroup
              value={serviceKind}
              onValueChange={(value) => setServiceKind(value as VibeServiceKind)}
              aria-label="服务的启动方式"
              className="vibe-remote__choices"
            >
              {VIBE_SERVICE_KINDS.map((entry) => (
                <ToggleButton key={entry.id} value={entry.id}>{entry.label}</ToggleButton>
              ))}
            </ToggleGroup>
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
            <ToggleGroup
              value={host}
              onValueChange={(value) => setHost(value as VibeAgentHost)}
              aria-label="采集器所在的机器"
              className="vibe-remote__choices"
            >
              {VIBE_AGENT_HOSTS.map((entry) => (
                <ToggleButton key={entry.id} value={entry.id}>{entry.label}</ToggleButton>
              ))}
            </ToggleGroup>
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
          <button
            type="button"
            className="vibe-remote__toggle"
            aria-expanded={showAutostart}
            onClick={() => setShowAutostart((value) => !value)}
          >
            <RefreshCw aria-hidden="true" />让它开机自启（可选）
          </button>
          {showAutostart && (
            <div className="vibe-remote__fold">
              {vibeAutostartCommands(host, input).map((command, index) => (
                <CommandBlock key={index} command={command} />
              ))}
            </div>
          )}

          {installed && (
            <>
              <button
                type="button"
                className="vibe-remote__toggle"
                aria-expanded={showUninstall}
                onClick={() => setShowUninstall((value) => !value)}
              >
                <Trash2 aria-hidden="true" />卸载
              </button>
              {showUninstall && (
                <div className="vibe-remote__fold">
                  <p>
                    先在那台机器上停掉采集器，再回到上面点「移除」把它从面板去掉
                    —— 反过来的话，它下次推送又会出现。
                  </p>
                  <CommandBlock command={vibeUninstallCommand(host)} />
                  <p>连接收也一并关掉的话：</p>
                  <CommandBlock command={vibeDisableIngestCommand(serviceKind)} />
                </div>
              )}
            </>
          )}
        </div>

        <SurfaceCut className="vibe-remote__warning">
          <ShieldAlert aria-hidden="true" />
          <div>
            <strong>只能在凭据所属的那台机器上跑</strong>
            <p>
              采集器会读取、并在快过期时刷新各家 CLI 的登录。厂商每次刷新都会作废旧的凭据，
              所以把它拿到别人的电脑上跑，会把对方挤出自己的 CLI 登录。
            </p>
          </div>
        </SurfaceCut>

        <details className="vibe-remote__advanced">
          <summary>高级：换一个令牌</summary>
          <div className="vibe-remote__field-row">
            <Input value={token} spellCheck={false} onChange={(next) => setToken(next.trim())} />
            <Button type="button" color="neutral" onClick={() => setToken(generateIngestToken())}>
              重新生成
            </Button>
          </div>
          <p>
            服务端与采集器两边必须一致；改了这里，上面两条命令都要重新执行一遍。
            推送地址 <code>{vibePushUrl(input)}</code>。
          </p>
        </details>
      </div>
    </Dialog>
  );
}

function CommandBlock({ command }: { command: VibeCommand }) {
  return (
    <div className="vibe-remote__command">
      {command.label && <strong className="vibe-remote__command-label">{command.label}</strong>}
      {command.detail && <p>{command.detail}</p>}
      {command.file && <p className="vibe-remote__file"><code>{command.file}</code></p>}
      <CodeBlock code={command.code} />
      {command.note && <p className="vibe-remote__note">{command.note}</p>}
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
