import { describe, expect, test } from "bun:test";
import {
  INSTALL_DISMISS_TTL_MS,
  detectInstallPlatform,
  installPromptState,
  parseInstallRecord,
  type InstallEnvironment,
} from "../web/src/lib/install-prompt";

const NOW = 1_770_000_000_000;

function environment(patch: Partial<InstallEnvironment> = {}): InstallEnvironment {
  return {
    standalone: false,
    installed: false,
    secureContext: true,
    hasDeferredPrompt: false,
    platform: "chromium",
    dismissedAtMs: null,
    nowMs: NOW,
    ...patch,
  };
}

describe("detectInstallPlatform", () => {
  test("iOS 上所有浏览器都是 WebKit，Chrome for iOS 也算 iOS", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    const criOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";
    expect(detectInstallPlatform({ userAgent: iphone, maxTouchPoints: 5 })).toBe("ios");
    expect(detectInstallPlatform({ userAgent: criOS, maxTouchPoints: 5 })).toBe("ios");
  });

  test("iPad 报的是桌面 Mac UA，只有触点数能把它认出来", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
    expect(detectInstallPlatform({ userAgent: ua, maxTouchPoints: 5 })).toBe("ios");
    expect(detectInstallPlatform({ userAgent: ua, maxTouchPoints: 0 })).toBe("safari-desktop");
  });

  test("Chromium 系与 Firefox 分得开", () => {
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
    const firefox = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0";
    expect(detectInstallPlatform({ userAgent: chrome, maxTouchPoints: 0 })).toBe("chromium");
    expect(detectInstallPlatform({ userAgent: edge, maxTouchPoints: 0 })).toBe("chromium");
    expect(detectInstallPlatform({ userAgent: firefox, maxTouchPoints: 0 })).toBe("other");
  });
});

describe("installPromptState", () => {
  test("拿到 beforeinstallprompt 就给按钮", () => {
    const state = installPromptState(environment({ hasDeferredPrompt: true }));
    expect(state).toMatchObject({ visible: true, mode: "prompt" });
  });

  test("已经在应用窗口里跑，或本机装过，都不再提示", () => {
    expect(installPromptState(environment({ standalone: true, hasDeferredPrompt: true })).visible).toBe(false);
    expect(installPromptState(environment({ installed: true, hasDeferredPrompt: true })).visible).toBe(false);
  });

  test("关掉之后 14 天内不再出现，之后才回来", () => {
    const justDismissed = environment({ hasDeferredPrompt: true, dismissedAtMs: NOW - 1_000 });
    const longAgo = environment({
      hasDeferredPrompt: true,
      dismissedAtMs: NOW - INSTALL_DISMISS_TTL_MS - 1,
    });
    expect(installPromptState(justDismissed).visible).toBe(false);
    expect(installPromptState(longAgo).visible).toBe(true);
  });

  test("WebKit 没有安装事件，只能给步骤：iOS 说分享，Safari 说程序坞", () => {
    const ios = installPromptState(environment({ platform: "ios" }));
    const safari = installPromptState(environment({ platform: "safari-desktop" }));
    expect(ios).toMatchObject({ visible: true, mode: "manual" });
    expect(safari).toMatchObject({ visible: true, mode: "manual" });
    expect(ios.visible && ios.body).toContain("添加到主屏幕");
    expect(safari.visible && safari.body).toContain("程序坞");
  });

  test("iOS 的「添加到主屏幕」不要求安全上下文，Safari 的安装要求", () => {
    // 手机按局域网 IP 打开控制台就是 http://192.168.x.x:43820 这种非安全上下文。
    expect(installPromptState(environment({ platform: "ios", secureContext: false })).visible).toBe(true);
    expect(installPromptState(environment({ platform: "safari-desktop", secureContext: false })).visible).toBe(false);
  });

  test("Chromium 没给事件、Firefox 根本不能装，就不画空头支票", () => {
    expect(installPromptState(environment({ platform: "chromium" })).visible).toBe(false);
    expect(installPromptState(environment({ platform: "other" })).visible).toBe(false);
  });
});

describe("parseInstallRecord", () => {
  test("没记过、坏数据、旧版本的字段，一律当没记过", () => {
    expect(parseInstallRecord(null)).toEqual({ installed: false, dismissedAtMs: null });
    expect(parseInstallRecord("not json")).toEqual({ installed: false, dismissedAtMs: null });
    expect(parseInstallRecord("42")).toEqual({ installed: false, dismissedAtMs: null });
    expect(parseInstallRecord('{"dismissedAtMs":"yesterday"}')).toEqual({ installed: false, dismissedAtMs: null });
  });

  test("读回自己写的那两件事", () => {
    expect(parseInstallRecord(JSON.stringify({ installed: true, dismissedAtMs: null })))
      .toEqual({ installed: true, dismissedAtMs: null });
    expect(parseInstallRecord(JSON.stringify({ installed: false, dismissedAtMs: NOW })))
      .toEqual({ installed: false, dismissedAtMs: NOW });
  });
});
