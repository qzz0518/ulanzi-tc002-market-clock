// 「把控制台装成应用」这条提示什么时候出现、出现时说什么。
//
// 判定与文案都在这里，组件只负责画（与 firmware-mode.ts 同一分工）。三条硬规则，
// 每条对应一个装不了或不必装的真实处境，不是保守起见的猜测：
//
//   1. 已经在应用窗口里跑就没什么可装的了 —— display-mode: standalone，iOS 上
//      是 navigator.standalone。装完那一刻也算：appinstalled 会记进本机。
//   2. 只有 Chromium 系会发 beforeinstallprompt，拿到它才谈得上「点一下就装」。
//      WebKit 从不发这个事件，Safari 与 iOS 只能手动，所以那两处必须换成步骤文案，
//      而不是给一个按下去没反应的按钮。
//   3. 安装要求安全上下文。桌面上的 127.0.0.1 算安全；手机上按局域网地址打开
//      （http://192.168.x.x:43820）不算 —— 那里 Chrome 根本不会给安装入口，
//      提示也就只能是空头支票。iOS 的「添加到主屏幕」不受这条限制，照常可用。
//
// 关掉之后 14 天内不再出现：这是一条便利提示，不是待办事项。

/** Chromium 的安装事件；标准 DOM 类型里没有它。 */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallPlatform = "chromium" | "ios" | "safari-desktop" | "other";

export interface InstallEnvironment {
  /** 此刻就在应用窗口里跑。 */
  standalone: boolean;
  /** 本机装过（appinstalled 记下的），换回浏览器打开也不必再劝。 */
  installed: boolean;
  /** 安装要求的安全上下文：https 或 localhost。 */
  secureContext: boolean;
  /** beforeinstallprompt 已经到手，可以直接调起系统安装框。 */
  hasDeferredPrompt: boolean;
  platform: InstallPlatform;
  /** 上次关掉提示的时刻；从没关过是 null。 */
  dismissedAtMs: number | null;
  nowMs: number;
}

export interface InstallPromptCopy {
  title: string;
  body: string;
}

export type InstallPromptState =
  | { visible: false }
  /** 有系统安装框可以调起：给按钮。 */
  | ({ visible: true; mode: "prompt" } & InstallPromptCopy)
  /** 只能手动装：给步骤。 */
  | ({ visible: true; mode: "manual" } & InstallPromptCopy);

/** 关掉之后多久才再问一次。 */
export const INSTALL_DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1_000;

const PROMPT_COPY: InstallPromptCopy = {
  title: "把控制台装成应用",
  body: "独立窗口打开，不再占用浏览器标签页。",
};

const IOS_COPY: InstallPromptCopy = {
  title: "添加到主屏幕",
  body: "点浏览器底部的「分享」，选「添加到主屏幕」。",
};

const SAFARI_COPY: InstallPromptCopy = {
  title: "添加到程序坞",
  body: "Safari 菜单栏「文件」→「添加到程序坞」。",
};

/** 识别平台需要的那几项 navigator 字段。 */
export interface InstallAgent {
  userAgent: string;
  /** iPadOS 的 UA 与桌面 Mac 完全一致，只有触点数能把它认出来。 */
  maxTouchPoints: number;
}

export function detectInstallPlatform(agent: InstallAgent): InstallPlatform {
  const ua = agent.userAgent;
  // iOS 上所有浏览器都是 WebKit（Chrome 也是 CriOS），一律按 iOS 招待，
  // 包括那台报着桌面 UA 的 iPad。
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Macintosh/.test(ua) && agent.maxTouchPoints > 1) return "ios";
  if (/Edg\/|Chrome\/|Chromium\/|OPR\//.test(ua)) return "chromium";
  if (/Safari\//.test(ua)) return "safari-desktop";
  return "other";
}

export function installPromptState(environment: InstallEnvironment): InstallPromptState {
  if (environment.standalone || environment.installed) return { visible: false };
  if (
    environment.dismissedAtMs !== null
    && environment.nowMs - environment.dismissedAtMs < INSTALL_DISMISS_TTL_MS
  ) {
    return { visible: false };
  }
  // 拿到事件就说明这个浏览器此刻真的能装，其余条件浏览器自己已经查过了。
  if (environment.hasDeferredPrompt) return { visible: true, mode: "prompt", ...PROMPT_COPY };
  if (environment.platform === "ios") return { visible: true, mode: "manual", ...IOS_COPY };
  if (environment.platform === "safari-desktop" && environment.secureContext) {
    return { visible: true, mode: "manual", ...SAFARI_COPY };
  }
  // Chromium 没给事件（装过了、或还没满足安装条件）、Firefox 没有安装这回事、
  // 局域网 IP 上的非安全上下文 —— 都属于「说了也装不上」，索性不说。
  return { visible: false };
}

// ——— 本机记下的那两件事 ———

export interface InstallRecord {
  installed: boolean;
  dismissedAtMs: number | null;
}

export const INSTALL_RECORD_KEY = "pixel-market.install-prompt";

const EMPTY_RECORD: InstallRecord = { installed: false, dismissedAtMs: null };

/** 存储里的东西是用户能改的，也可能是上个版本写的：读不懂就当没记过。 */
export function parseInstallRecord(raw: string | null): InstallRecord {
  if (!raw) return EMPTY_RECORD;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_RECORD;
    const record = parsed as Partial<InstallRecord>;
    return {
      installed: record.installed === true,
      dismissedAtMs: typeof record.dismissedAtMs === "number" && Number.isFinite(record.dismissedAtMs)
        ? record.dismissedAtMs
        : null,
    };
  } catch {
    return EMPTY_RECORD;
  }
}

// ——— 事件捕获 ———
//
// beforeinstallprompt 可能在 React 挂载之前就发过一次，而且只发这一次：入口
// 一加载就先接住它存起来，组件挂载后再来订阅。preventDefault 是必须的 —— 不拦
// 下来，Chrome 会自己弹一条迷你横幅，那正是这块提示要替掉的东西。

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let capturing = false;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** 在应用入口调用一次。 */
export function captureInstallPrompt(): void {
  if (capturing || typeof window === "undefined") return;
  capturing = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    announce();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    announce();
  });
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

/**
 * 调起系统安装框。事件是一次性的：无论用户装没装，这一份都不能再用，用完就扔。
 */
export async function runDeferredInstallPrompt(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferredPrompt;
  if (!event) return "unavailable";
  deferredPrompt = null;
  announce();
  try {
    await event.prompt();
    return (await event.userChoice).outcome;
  } catch {
    return "unavailable";
  }
}
