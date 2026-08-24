import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@cladd-ui/react";
import {
  INSTALL_RECORD_KEY,
  detectInstallPlatform,
  getDeferredInstallPrompt,
  installPromptState,
  parseInstallRecord,
  runDeferredInstallPrompt,
  subscribeInstallPrompt,
  type InstallRecord,
} from "@/lib/install-prompt";

/**
 * 「装成应用」的提示条。
 *
 * 出不出现、说什么，全在 lib/install-prompt.ts；这里只读浏览器现状、画，以及把
 * 用户的答复记进 localStorage。挂在应用外壳而不是某个视图里：它讲的是这个站点
 * 本身怎么打开，跟当前在看哪一页无关。
 */

const EMPTY_RECORD: InstallRecord = { installed: false, dismissedAtMs: null };

function readRecord(): InstallRecord {
  if (typeof window === "undefined") return EMPTY_RECORD;
  try {
    return parseInstallRecord(window.localStorage.getItem(INSTALL_RECORD_KEY));
  } catch {
    // 隐私模式或禁用存储：记不住就每次都问，总好过整块提示消失。
    return EMPTY_RECORD;
  }
}

function writeRecord(record: InstallRecord): InstallRecord {
  try {
    window.localStorage.setItem(INSTALL_RECORD_KEY, JSON.stringify(record));
  } catch {
    // 同上：写不进去不影响这一次的显示。
  }
  return record;
}

/** 此刻是不是已经在应用窗口里跑。iOS 上没有 display-mode，只有这个旧字段。 */
function readStandalone(): boolean {
  if (typeof window === "undefined") return true;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function InstallPrompt() {
  const deferred = useSyncExternalStore(subscribeInstallPrompt, getDeferredInstallPrompt, () => null);
  const [record, setRecord] = useState<InstallRecord>(readRecord);
  const [standalone, setStandalone] = useState<boolean>(readStandalone);

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const syncDisplayMode = () => setStandalone(readStandalone());
    // 装完的那一刻：Chrome 会把这一份窗口留在浏览器里，提示得当场收起来，
    // 而且往后从浏览器打开也不该再劝。
    const onInstalled = () => setRecord(writeRecord({ installed: true, dismissedAtMs: null }));
    media.addEventListener("change", syncDisplayMode);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      media.removeEventListener("change", syncDisplayMode);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const state = installPromptState({
    standalone,
    installed: record.installed,
    secureContext: typeof window === "undefined" ? false : window.isSecureContext,
    hasDeferredPrompt: deferred !== null,
    platform: typeof window === "undefined"
      ? "other"
      : detectInstallPlatform({
          userAgent: window.navigator.userAgent,
          maxTouchPoints: window.navigator.maxTouchPoints,
        }),
    dismissedAtMs: record.dismissedAtMs,
    nowMs: Date.now(),
  });

  if (!state.visible) return null;

  const dismiss = () => setRecord(writeRecord({ installed: false, dismissedAtMs: Date.now() }));
  const install = async () => {
    const outcome = await runDeferredInstallPrompt();
    // 用户在系统框里点了取消：那份事件已经作废，提示留着也调不起第二次，
    // 按「以后再说」处理。装成功由 appinstalled 收尾。
    if (outcome !== "accepted") dismiss();
  };

  return (
    <aside className="install-prompt" aria-label="安装为应用">
      <span className="install-prompt__icon" aria-hidden="true"><Download /></span>
      <div className="install-prompt__copy">
        <strong>{state.title}</strong>
        <span>{state.body}</span>
      </div>
      {state.mode === "prompt" && (
        <Button type="button" size="sm" color="brand" onClick={() => void install()}>安装</Button>
      )}
      <Button
        type="button"
        size="sm"
        square
        color="neutral"
        variant="transparent"
        outline={false}
        aria-label="以后再说"
        onClick={dismiss}
      >
        <X />
      </Button>
    </aside>
  );
}
