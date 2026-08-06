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
});
