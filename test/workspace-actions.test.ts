import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceActions } from "../web/src/components/studio/workspace-actions";

describe("workspace actions", () => {
  test("keeps a visible push label while a channel is being sent", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceActions, {
      busy: "push",
      dirty: false,
      saving: false,
      lastSavedAt: Date.now(),
      deviceOutOfDate: false,
      lastPushAt: new Date().toISOString(),
      onPush: () => {},
    }));

    expect(html).toContain("推送中");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("cladd-spinner");
    expect(html).not.toContain('data-loading="true"');
  });

  test("stops promising that re-entering a ZOS channel refreshes it", () => {
    // 这句原本写的是「保存后进入该频道即为最新」,而重新进入频道恰恰是唯一不会
    // 刷新的动作——固件按 appName 缓存整包帧,进同一台只会重放旧的。现在服务端
    // 会随菜单发一份内容版本号,控制台能如实说的就只有「已经通知时钟了」。
    const html = renderToStaticMarkup(createElement(WorkspaceActions, {
      busy: null,
      dirty: false,
      saving: false,
      lastSavedAt: Date.now(),
      deviceOutOfDate: false,
      firmwareMode: "zos" as const,
      channelAppName: "notice_board",
      channelEnabled: true,
      onPush: () => {},
    }));

    expect(html).toContain("已通知时钟更新");
    expect(html).not.toContain("进入该频道即为最新");
    expect(html).toContain("在时钟上显示");
  });
});
