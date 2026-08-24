/**
 * VIBE usage collector, as a standalone binary.
 *
 * The four adapters read credentials that exist only where the agent CLIs are
 * logged in: a macOS Keychain item, a file under `~`. A service running in a
 * container or on another host finds none of them and correctly shows an empty
 * panel. This entry point is the SAME collection code — same adapters, same
 * refresh guards, same per-vendor isolation — compiled to one file so it can
 * run over there and POST the result to `/v1/push` (ADR 0013).
 *
 * It exists because `VibeAdapterContext` was always injectable: an adapter
 * never touches the device, never caches and never schedules, so moving the
 * collection out of the service process needed a new entry point and nothing
 * else.
 *
 * SAFETY: this binary inherits the adapters' right to write a rotated refresh
 * token back to the file it came from (`~/.claude/.credentials.json`,
 * `~/.codex/auth.json`). That is correct on the machine those files belong to
 * and catastrophic anywhere else — a copy of this binary run against someone
 * else's home directory would sign them out of their own CLI. Run it only on
 * the machine whose logins it reads.
 *
 * Build:  bun build --compile src/vibe-agent.ts --outfile vibe-agent
 */

import { hostname } from "node:os";
import { VIBE_INGEST_SCHEMA } from "./vibe/ingest-schema.ts";
import {
  VibeUnavailableError,
  VibeUsageService,
  type VibeProviderUsage,
  type VibeUsageSnapshot,
} from "./vibe/usage-service.ts";

/** Matches the store's MACHINE_PATTERN; a name it would reject is rejected here. */
const MACHINE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const DEFAULT_INTERVAL_SECONDS = 60;
/** Below this the vendors, not the service, are what you would be hammering. */
const MIN_INTERVAL_SECONDS = 15;
const MAX_INTERVAL_SECONDS = 3600;
const PUSH_TIMEOUT_MS = 10_000;

export interface VibeAgentOptions {
  url: string;
  token?: string;
  machine: string;
  intervalMs: number;
  /** Collect and push exactly once, then exit — for cron and for a smoke test. */
  once: boolean;
}

export class VibeAgentUsageError extends Error {}

const USAGE = `vibe-agent — 把本机 AI 代理的额度推送给 Ulanzi Clock 服务

用法:
  vibe-agent --url http://<服务地址>:43820/v1/push --token <令牌> [选项]

选项:
  --url <地址>        必填。服务的推送地址，以 /v1/push 结尾
  --token <令牌>      必填（除非服务端未设 VIBE_INGEST_TOKEN）。与服务端
                      VIBE_INGEST_TOKEN 完全一致
  --machine <名字>    这台机器在控制台里显示的名字，默认取主机名
  --interval <秒>     推送间隔，默认 ${DEFAULT_INTERVAL_SECONDS}，范围 ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS}
  --once              采集并推送一次就退出，用来验证配置是否正确
  -h, --help          显示这段帮助

也可以用环境变量代替: VIBE_PUSH_URL / VIBE_INGEST_TOKEN / VIBE_MACHINE /
VIBE_PUSH_INTERVAL。命令行参数优先。

注意: 本程序会读取并（在必要时）刷新本机各 CLI 的登录凭据，只能在这些凭据
所属的那台机器上运行。`;

export function parseAgentArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): VibeAgentOptions | "help" {
  let url = env.VIBE_PUSH_URL?.trim();
  let token = env.VIBE_INGEST_TOKEN?.trim();
  let machine = env.VIBE_MACHINE?.trim();
  let interval = env.VIBE_PUSH_INTERVAL?.trim();
  let once = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    // A flag whose value is missing must fail loudly: silently falling back to
    // the environment here is how an operator ends up pushing to the wrong host
    // and seeing no error anywhere.
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new VibeAgentUsageError(`${flag} 缺少取值`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "-h": case "--help": return "help";
      case "--once": once = true; break;
      case "--url": url = value(); break;
      case "--token": token = value(); break;
      case "--machine": machine = value(); break;
      case "--interval": interval = value(); break;
      default: throw new VibeAgentUsageError(`未知参数: ${flag}`);
    }
  }

  if (!url) throw new VibeAgentUsageError("缺少 --url（或环境变量 VIBE_PUSH_URL）");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VibeAgentUsageError(`--url 不是合法地址: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VibeAgentUsageError("--url 必须是 http:// 或 https://");
  }

  const resolvedMachine = machine ?? defaultMachineName();
  if (!MACHINE_PATTERN.test(resolvedMachine)) {
    throw new VibeAgentUsageError(
      `--machine 只能是 1–64 个 [A-Za-z0-9 ._-] 字符，当前为「${resolvedMachine}」`,
    );
  }

  const seconds = interval === undefined ? DEFAULT_INTERVAL_SECONDS : Number(interval);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)
    || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    throw new VibeAgentUsageError(
      `--interval 必须是 ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS} 之间的整数秒`,
    );
  }

  return {
    url: parsed.toString(),
    ...(token ? { token } : {}),
    machine: resolvedMachine,
    intervalMs: seconds * 1000,
    once,
  };
}

/**
 * Falls back rather than throws: an unusable hostname (empty, or all characters
 * the store rejects) must not stop an agent whose --url is perfectly good.
 */
function defaultMachineName(): string {
  const raw = hostname().split(".")[0] ?? "";
  const cleaned = raw.replace(/[^A-Za-z0-9 ._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  return cleaned === "" ? "unknown-host" : cleaned;
}

export function buildEnvelope(
  machine: string,
  round: VibeAgentRound,
  sentAtMs: number,
): Record<string, unknown> {
  return {
    schema: VIBE_INGEST_SCHEMA,
    machine,
    sent_at: new Date(sentAtMs).toISOString(),
    snapshots: round.providers,
    errors: round.errors,
  };
}

export interface VibeAgentRound {
  providers: VibeProviderUsage[];
  errors: { providerId: string; message: string }[];
}

/**
 * One collection round.
 *
 * `VibeUnavailableError` — nothing signed in here — is a result, not a failure:
 * it pushes an empty round so the console stops showing this machine's
 * providers rather than serving them until they expire.
 *
 * The errors travel too. Without them a vendor that failed over here simply
 * vanished from the panel over there, with no reason attached — the local path
 * says「sign-in rejected (HTTP 401)」and the remote path said nothing at all,
 * which is the harder of the two to debug and the one nobody is watching.
 */
export async function collectRound(service: VibeUsageService): Promise<VibeAgentRound> {
  try {
    const snapshot = await service.fetchSnapshot();
    return { providers: snapshot.providers, errors: snapshot.errors };
  } catch (error) {
    if (error instanceof VibeUnavailableError) return { providers: [], errors: [] };
    throw error;
  }
}

export async function pushEnvelope(
  options: VibeAgentOptions,
  envelope: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const response = await fetcher(options.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function report(message: string): void {
  process.stdout.write(`[vibe-agent] ${new Date().toISOString()} ${message}\n`);
}

async function main(): Promise<number> {
  let options: VibeAgentOptions | "help";
  try {
    options = parseAgentArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  if (options === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  // One service for the whole run: it carries the per-vendor last-good cache
  // and the 429 cooldowns, which only pay off across rounds.
  const service = new VibeUsageService();
  report(`机器名 ${options.machine}，推送到 ${options.url}，间隔 ${options.intervalMs / 1000}s`);

  let failures = 0;
  for (;;) {
    try {
      const round = await collectRound(service);
      await pushEnvelope(options, buildEnvelope(options.machine, round, Date.now()));
      failures = 0;
      const failed = round.errors.length === 0 ? "" : `（${round.errors.length} 家出错）`;
      report(round.providers.length === 0
        ? `已推送：本机暂无已登录的代理${failed}`
        : `已推送 ${round.providers.length} 个代理：${round.providers.map((p) => p.id).join(", ")}${failed}`);
    } catch (error) {
      failures += 1;
      // Best-effort, exactly like openusage's exporter: a service that is down
      // for a deploy must not take the agent with it, or every restart would
      // need someone to go and start it again by hand.
      report(`第 ${failures} 次推送失败：${error instanceof Error ? error.message : String(error)}`);
      if (options.once) return 1;
    }
    if (options.once) return 0;
    await Bun.sleep(options.intervalMs);
  }
}

if (import.meta.main) {
  process.exit(await main());
}
