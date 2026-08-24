import { createRoot } from "react-dom/client";
import { CladdProvider } from "@cladd-ui/react";
import { App } from "@/app";
import { InstallPrompt } from "@/components/studio/install-prompt";
import { captureInstallPrompt } from "@/lib/install-prompt";
import { attachMediaSession } from "@/lib/media-session";
import "@/styles/globals.css";
import "@/styles/music-player.css";

// beforeinstallprompt 只发一次，而且可能赶在 React 挂载之前：先接住，
// 提示条挂上来以后再问它拿。
captureInstallPrompt();

const root = document.getElementById("root");
if (!root) throw new Error("Pixel Market root element is missing");

createRoot(root).render(
  <CladdProvider
    theme="light"
    accentColor="brand"
    overlaysRoot="#root"
    defaults={{
      Button: { size: "md", variant: "gradient", outline: true },
      Input: { size: "md" },
      NumberScrubber: { size: "md", variant: "gradient", outline: true },
      Select: { size: "md", outline: true },
      Tooltip: { position: "top" },
    }}
  >
    <div className="app-container">
      <App />
      <InstallPrompt />
    </div>
  </CladdProvider>,
);

// 锁屏 / 灵动岛 / 蓝牙耳机上的「正在播放」。挂在页面这一层而不是某个视图里：
// 播放器是模块单例，切到内容页歌照放，那块卡片也得跟着照放歌名而不是网页标题。
attachMediaSession();

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, { once: true });
}
