/**
 * The 「远程采集」 walkthrough, as data.
 *
 * VIBE's adapters read credentials that exist only where each agent CLI is
 * logged in. A service in a container or on another host finds none of them, so
 * the collection has to run over there and push here (ADR 0013). That makes
 * setup a cross-machine, per-OS chore — the kind of thing people abandon
 * halfway.
 *
 * So the guide asks TWO questions and then shows ONE path:
 *
 *   ① how was this service started   → one command that turns ingest on
 *   ② which machine holds the logins → one command that starts the collector
 *
 * Every other branch stays hidden. An earlier cut laid all the branches out at
 * once — three ways to set the token, two ways to get the binary, a verify step,
 * an install step — and the reader had to work out which lines were theirs
 * before touching anything. Choosing for them is the whole design.
 *
 * Commands are generated with the reader's real values already in them (their
 * host, the token just generated), so nothing asks them to substitute a
 * placeholder — a walkthrough that does is a walkthrough with a typo in it.
 *
 * Pure and exported so `test/vibe-remote-setup.test.ts` can pin the commands:
 * a broken quote in a launchd plist is invisible in review and fatal at boot.
 */

/** How the console's own service process was started; decides where the token goes. */
export type VibeServiceKind = "docker" | "shell" | "launchd";
/** Which machine runs the collector; decides how it is obtained and started. */
export type VibeAgentHost = "here" | "macos" | "linux" | "windows";

export const VIBE_SERVICE_KINDS: readonly { id: VibeServiceKind; label: string }[] = [
  { id: "docker", label: "Docker" },
  { id: "launchd", label: "开机自启" },
  { id: "shell", label: "命令行" },
];

export const VIBE_AGENT_HOSTS: readonly { id: VibeAgentHost; label: string }[] = [
  { id: "here", label: "就是这台电脑" },
  { id: "macos", label: "另一台 Mac" },
  { id: "linux", label: "Linux" },
  { id: "windows", label: "Windows" },
];

export interface VibeSetupInput {
  /** Where the console is reachable, e.g. "http://192.168.1.20:43820". */
  origin: string;
  /** The ingest path the service reported; never hard-coded here. */
  path: string;
  token: string;
}

export interface VibeCommand {
  /** Only set when a block needs naming; the main line usually does not. */
  label?: string;
  detail?: string;
  /** Where `code` should be saved, when it is a file rather than a command. */
  file?: string;
  code: string;
  note?: string;
}

const TOKEN_BYTES = 32;
const PLACEHOLDER_TOKEN = "<先点上面的「生成」>";
/** Written by scripts/install.sh; the plist and the kickstart both need it. */
const LAUNCHD_LABEL = "com.zerah.ulanzi-market-clock";
const AGENT_LABEL = "com.zerah.vibe-agent";

/** 64 hex characters from the platform CSPRNG — never Math.random. */
export function generateIngestToken(
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(TOKEN_BYTES));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Joins origin and path without doubling or dropping the slash between them.
 * The origin comes from `window.location`, which may or may not carry a
 * trailing slash depending on how the user reached the console.
 */
export function vibePushUrl(input: Pick<VibeSetupInput, "origin" | "path">): string {
  const origin = input.origin.replace(/\/+$/, "");
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  return `${origin}${path}`;
}

/** Blank until the reader generates one, so a half-done command stays obvious. */
function tokenOrPlaceholder(token: string): string {
  return token === "" ? PLACEHOLDER_TOKEN : token;
}

/** Which cross-compile target a given host needs. `here` builds nothing. */
function buildTarget(host: VibeAgentHost): string {
  if (host === "linux") return "linux-x64";
  if (host === "windows") return "windows-x64";
  return "darwin-arm64";
}

function binaryName(host: VibeAgentHost): string {
  return host === "windows" ? "vibe-agent-windows-x64.exe" : `vibe-agent-${buildTarget(host)}`;
}

/** ① One command. Turns ingest on wherever this service happens to run. */
export function vibeServiceCommand(kind: VibeServiceKind, input: VibeSetupInput): VibeCommand {
  const token = tokenOrPlaceholder(input.token);
  if (kind === "docker") {
    return {
      detail: "写进 compose 读的环境文件，然后重起容器。",
      code: `echo 'VIBE_INGEST_TOKEN=${token}' >> .runtime/docker.env\ndocker compose up -d`,
    };
  }
  if (kind === "launchd") {
    // PlistBuddy rather than "open the plist and add a key": Add fails when the
    // key exists and when the dict does not, so the delete-then-add pair is what
    // makes this safe to paste twice. Both tolerated failures are the expected
    // ones on a first or repeat run.
    return {
      detail: "改开机自启的配置，然后重启服务。整段一起复制执行。",
      code: `PLIST=~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist\n`
        + `/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$PLIST" 2>/dev/null\n`
        + `/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:VIBE_INGEST_TOKEN" "$PLIST" 2>/dev/null\n`
        + `/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:VIBE_INGEST_TOKEN string ${token}" "$PLIST"\n`
        + `launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}"`,
      note: "前两行报不报错都不影响——它们负责「没有就建、有就先删」。",
    };
  }
  return {
    detail: "原来怎么起的还怎么起，只在命令前面多加一个变量。",
    code: `VIBE_INGEST_TOKEN=${token} CLOCK_HOST=<你的时钟 IP> bun start`,
  };
}

/** ② One or two commands. Gets the collector running where the logins are. */
export function vibeAgentCommands(host: VibeAgentHost, input: VibeSetupInput): VibeCommand[] {
  const url = vibePushUrl(input);
  const token = tokenOrPlaceholder(input.token);

  if (host === "here") {
    return [{
      detail: "这台电脑上有本仓库，直接跑就行。",
      code: `bun run agent -- --url ${url} --token ${token}`,
      note: "看到「已推送 N 个代理」就成了，本页下方会立刻列出这台机器。"
        + "Ctrl-C 停止；要让它一直跑，见下面的「开机自启」。",
    }];
  }

  const binary = binaryName(host);
  const run = host === "windows" ? `.\\${binary}` : `./${binary}`;
  return [
    {
      label: "在这台电脑上编译，拷过去",
      detail: `产物在 dist/agent/${binary}，自包含，那台机器不需要装 Bun。`,
      code: `bun run agent-build -- --target ${buildTarget(host)}`,
      note: host === "macos" ? "对方是 Intel Mac 的话，target 换成 darwin-x64。" : undefined,
    },
    {
      label: "在那台机器上运行",
      code: `${run} --url ${url} --token ${token}`,
      note: "看到「已推送 N 个代理」就成了。报「连接被拒」多半是上面的地址填的不对——"
        + "要填这个服务在局域网里的地址，不能是 localhost。",
    },
  ];
}

/** ③ Optional, folded away: survive a reboot. */
export function vibeAutostartCommands(host: VibeAgentHost, input: VibeSetupInput): VibeCommand[] {
  const url = vibePushUrl(input);
  const token = tokenOrPlaceholder(input.token);
  const binary = host === "here" ? "vibe-agent" : binaryName(host);

  if (host === "windows") {
    return [{
      detail: "在 PowerShell 里执行，路径换成 exe 的实际位置。",
      // Nested quoting is the whole difficulty: schtasks takes the entire
      // command line as ONE /tr value and the path contains a space. PowerShell
      // single quotes pass the inner double quotes through verbatim. One line —
      // cmd's `^` and PowerShell's backtick are different continuations.
      code: `schtasks /create /tn "VIBE Agent" /sc onlogon /rl limited /f `
        + `/tr '"C:\\Program Files\\vibe-agent\\${binary}" --url ${url} --token ${token}'`,
      note: "任务里带着明文令牌，别把这条留在共享的脚本或聊天记录里。",
    }];
  }

  if (host === "linux") {
    return [
      {
        detail: "保存成这个文件，ExecStart 换成二进制的实际绝对路径。",
        file: "~/.config/systemd/user/vibe-agent.service",
        code: `[Unit]\nDescription=VIBE usage agent\nAfter=network-online.target\n\n`
          + `[Service]\nType=simple\nEnvironment=VIBE_INGEST_TOKEN=${token}\n`
          + `ExecStart=/usr/local/bin/${binary} --url ${url}\nRestart=always\nRestartSec=30\n\n`
          + `[Install]\nWantedBy=default.target`,
      },
      {
        detail: "收权限、启用，并让它在你登出后继续跑。",
        code: `chmod 600 ~/.config/systemd/user/vibe-agent.service\n`
          + `systemctl --user daemon-reload\n`
          + `systemctl --user enable --now vibe-agent\n`
          + `sudo loginctl enable-linger $USER`,
        note: "看日志：journalctl --user -u vibe-agent -f",
      },
    ];
  }

  // macOS, whether it is this machine or another one.
  const program = host === "here"
    ? "<vibe-agent 的绝对路径>"
    : `/usr/local/bin/${binary}`;
  return [
    {
      detail: "保存成这个文件，第一个 <string> 换成二进制的实际绝对路径。"
        + (host === "here" ? "用仓库跑的话，请先 bun run agent-build 编一个出来。" : ""),
      file: `~/Library/LaunchAgents/${AGENT_LABEL}.plist`,
      code: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${program}</string>
    <string>--url</string>
    <string>${url}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VIBE_INGEST_TOKEN</key>
    <string>${token}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/vibe-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/vibe-agent.log</string>
</dict>
</plist>`,
    },
    {
      detail: "plist 里有明文令牌，先收权限再加载。",
      code: `chmod 600 ~/Library/LaunchAgents/${AGENT_LABEL}.plist\n`
        + `launchctl load ~/Library/LaunchAgents/${AGENT_LABEL}.plist\n`
        + `tail -f /tmp/vibe-agent.log`,
    },
  ];
}

/** ④ Only shown once something is actually pushing. */
export function vibeUninstallCommand(host: VibeAgentHost): VibeCommand {
  if (host === "windows") {
    return {
      detail: "在那台机器的 PowerShell 里停掉计划任务。",
      code: `schtasks /end /tn "VIBE Agent"\nschtasks /delete /tn "VIBE Agent" /f`,
    };
  }
  if (host === "linux") {
    return {
      detail: "在那台机器上停掉并禁用。",
      code: `systemctl --user disable --now vibe-agent\n`
        + `rm ~/.config/systemd/user/vibe-agent.service`,
    };
  }
  return {
    detail: "在那台机器上停掉并移除。前台跑的直接 Ctrl-C 就够了。",
    code: `launchctl unload ~/Library/LaunchAgents/${AGENT_LABEL}.plist 2>/dev/null\n`
      + `rm -f ~/Library/LaunchAgents/${AGENT_LABEL}.plist`,
  };
}

/** ④b Turning the service back off, which is a different machine's job. */
export function vibeDisableIngestCommand(kind: VibeServiceKind): VibeCommand {
  if (kind === "docker") {
    return {
      detail: "删掉那一行环境变量再重起容器，服务就不再接收任何推送。",
      code: `sed -i '' '/^VIBE_INGEST_TOKEN=/d' .runtime/docker.env\ndocker compose up -d`,
    };
  }
  if (kind === "launchd") {
    return {
      detail: "从开机自启的配置里删掉令牌，然后重启服务。",
      code: `PLIST=~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist\n`
        + `/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:VIBE_INGEST_TOKEN" "$PLIST"\n`
        + `launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}"`,
    };
  }
  return {
    detail: "下次启动时不再带这个变量即可。",
    code: `CLOCK_HOST=<你的时钟 IP> bun start`,
  };
}
