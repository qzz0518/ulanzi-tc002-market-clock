import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import { ChannelSidebar } from "../web/src/components/studio/channel-sidebar";
import type { ChannelConfig } from "../web/src/types";

const SIDEBAR_SOURCE = await Bun.file(
  new URL("../web/src/components/studio/channel-sidebar.tsx", import.meta.url),
).text();
const APP_SOURCE = await Bun.file(new URL("../web/src/app.tsx", import.meta.url)).text();
const GLOBALS = await Bun.file(new URL("../web/src/styles/globals.css", import.meta.url)).text();

function channel(id: string, name: string, appName: string, items: number): ChannelConfig {
  return {
    id,
    name,
    appName,
    enabled: true,
    refreshIntervalMs: 60_000,
    items: Array.from({ length: items }, (_, i) => ({
      id: `${id}-item-${i}`,
      contentId: "creative:canvas",
      durationMs: 5_000,
      options: {},
    })),
  };
}

function markup(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(createElement(CladdProvider, null, node));
}

describe("channel sidebar", () => {
  const channels = [channel("c1", "市场轮播", "btc", 4), channel("c2", "灯牌", "sign", 1)];

  test("lists every channel with the id and shape the user picks it out by", () => {
    const html = markup(
      createElement(ChannelSidebar, {
        channels,
        selectedChannelId: "c2",
        onSelect: () => {},
        onOpen: () => {},
        onAdd: () => {},
        onDelete: () => {},
      }),
    );

    expect(html).toContain("市场轮播");
    expect(html).toContain("btc");
    expect(html).toContain("轮播 4");
    expect(html).toContain("灯牌");
    expect(html).toContain("单内容");
    // 选中的那一个要自己说出来,不能只靠一层背景色。
    expect(html).toContain('aria-current="true"');
  });

  // 双击是「选中 + 去内容页」的捷径。它没有键盘等价物,所以下面这条断言的另一半是
  // 顶部导航必须继续存在 —— 捷径可以没有键盘路径,唯一路径不行。
  test("double-click opens the channel, and it is wired to the row, not the delete button", () => {
    // 挂在 .channel-select 上:整行还装着删除按钮,而「双击删除」是没人想要的语义。
    expect(SIDEBAR_SOURCE).toMatch(
      /className="channel-select"[\s\S]{0,200}?onDoubleClick=\{\(\) => onOpen\(channel\.id\)\}/,
    );
    // 单击的语义没有被改掉。
    expect(SIDEBAR_SOURCE).toContain("onClick={() => onSelect(channel.id)}");
    // 删除按钮那一支不许沾上 onOpen。
    const deleteBlock = SIDEBAR_SOURCE.slice(SIDEBAR_SOURCE.indexOf("<DialogRoot>"));
    expect(deleteBlock).not.toContain("onOpen");
  });

  test("opening goes through changeView, so it cannot outflank the firmware gate", () => {
    // changeView 挡着侧载固件在跑时的工作区页面。一个能绕开顶部导航的快捷方式
    // 不该顺带绕开那道闸门 —— 用 setView("console") 就会。
    expect(APP_SOURCE).toMatch(
      /const openChannelInConsole = \(channelId: string\) => \{\s*selectChannel\(channelId\);\s*changeView\("console"\);/,
    );
    expect(APP_SOURCE).toContain("onOpen={openChannelInConsole}");
  });

  test("the second click does not leave a selected word behind", () => {
    // 没有这一条,双击会把频道名当文字选中,跳过去之后上一页还留着一段高亮。
    expect(GLOBALS).toMatch(/\.channel-select \{[^}]*user-select: none;/);
  });
});
