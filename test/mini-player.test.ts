import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CladdProvider } from "@cladd-ui/react";
import { miniPlayerKey, miniPlayerView } from "../web/src/lib/mini-player";
import { MiniPlayer } from "../web/src/components/music/mini-player";
import { StudioHeader } from "../web/src/components/studio/studio-header";
import { describeFirmware, type FirmwareStatus } from "../web/src/lib/firmware-mode";
import type { MusicPlaybackSnapshot } from "../web/src/lib/music-playback-store";
import type { MusicTrack, StudioView } from "../web/src/types";

const MINI_PLAYER_SOURCE = await Bun.file(
  new URL("../web/src/components/music/mini-player.tsx", import.meta.url),
).text();

// The header's mini player is the second consumer of the page-lifetime playback
// store. Everything it decides — whether it exists at all, whether previous and
// next lead anywhere, which of the three transports the user is driving — is
// derived, so it can be pinned here without a browser. The component is only
// checked for the things markup can prove: cladd primitives, one line of title,
// and the full title surviving the clip.

function track(over: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: "t1",
    title: "反方向的钟",
    artists: ["周杰伦"],
    album: "范特西",
    durationMs: 260_000,
    coverUrl: "https://p1.music.126.net/cover.jpg?param=200y200",
    ...over,
  };
}

function snapshot(over: Partial<MusicPlaybackSnapshot> = {}): MusicPlaybackSnapshot {
  return {
    provider: "netease",
    playbackMode: "device-audio",
    playOrder: "sequence",
    queue: [track(), track({ id: "t2", title: "晴天" })],
    queueLabel: "搜索结果",
    queueIndex: 0,
    detail: { track: track(), lyrics: [] },
    positionMs: 12_000,
    durationMs: 260_000,
    playing: true,
    loading: false,
    error: null,
    deviceOnline: false,
    deviceTrackId: null,
    remoteLive: false,
    ...over,
  };
}

describe("mini player — when it exists", () => {
  test("nothing loaded means no widget, not an empty one", () => {
    expect(miniPlayerView(snapshot({ detail: null }), "console")).toBeNull();
  });

  test("a track still fetching is not yet a widget either", () => {
    // `loading` with no detail is the gap between the click and the answer:
    // there is no title to show, so the header stays as it was.
    expect(miniPlayerView(snapshot({ detail: null, loading: true }), "console")).toBeNull();
  });

  test("the music tab has the real transport, so the header keeps quiet", () => {
    expect(miniPlayerView(snapshot(), "music")).toBeNull();
  });

  test("every other tab shows it", () => {
    const views: StudioView[] = ["console", "canvas", "library", "game", "zos"];
    for (const view of views) {
      expect([view, miniPlayerView(snapshot(), view)?.title]).toEqual([view, "反方向的钟"]);
    }
  });

  test("paused keeps the widget — the session did not end, it stopped", () => {
    const view = miniPlayerView(snapshot({ playing: false }), "console");
    expect(view?.playing).toBe(false);
    expect(view?.title).toBe("反方向的钟");
  });
});

describe("mini player — what it says", () => {
  test("artwork goes through the same-origin proxy, url-encoded", () => {
    expect(miniPlayerView(snapshot(), "console")?.coverSrc)
      .toBe("/api/music/art?url=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg%3Fparam%3D200y200");
  });

  test("no artwork falls back to the title's first glyph, never a hole", () => {
    const view = miniPlayerView(
      snapshot({ detail: { track: track({ coverUrl: undefined }), lyrics: [] } }),
      "console",
    );
    expect(view?.coverSrc).toBeNull();
    expect(view?.coverFallback).toBe("反");
  });

  test("a nameless artist is said out loud, not left blank", () => {
    const view = miniPlayerView(
      snapshot({ detail: { track: track({ artists: [] }), lyrics: [] } }),
      "console",
    );
    expect(view?.artists).toBe("未知音乐人");
  });

  test("several artists read the way the music view prints them", () => {
    const view = miniPlayerView(
      snapshot({ detail: { track: track({ artists: ["林俊杰", "孙燕姿"] }), lyrics: [] } }),
      "console",
    );
    expect(view?.artists).toBe("林俊杰 / 孙燕姿");
  });

  test("the hint carries the whole title, which the header itself must clip", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
    const view = miniPlayerView(
      snapshot({ detail: { track: track({ title: long }), lyrics: [] } }),
      "console",
    );
    expect(view?.hint).toBe(`${long} — 周杰伦`);
    expect(view?.trackLabel).toContain(long);
  });

  test("a transport failure is surfaced, not swallowed by the hint", () => {
    const view = miniPlayerView(snapshot({ error: "音频没有载入。" }), "console");
    expect(view?.error).toBe("音频没有载入。");
    expect(view?.hint).toBe("音频没有载入。");
  });

  test("a device still downloading says so rather than looking stuck", () => {
    const view = miniPlayerView(
      snapshot({ deviceOnline: true, deviceTrackId: "t9" }),
      "console",
    );
    expect(view?.hint).toBe("设备下载中…");
  });
});

describe("mini player — what the controls mean", () => {
  test("previous/next need somewhere to go", () => {
    expect(miniPlayerView(snapshot({ queue: [] }), "console")?.canSkip).toBe(false);
    expect(miniPlayerView(snapshot({ queue: [track()] }), "console")?.canSkip).toBe(false);
    expect(miniPlayerView(snapshot(), "console")?.canSkip).toBe(true);
  });

  test("a Connect player has its own queue, so skipping always leads somewhere", () => {
    const view = miniPlayerView(
      snapshot({ playbackMode: "remote", queue: [] }),
      "console",
    );
    expect(view?.canSkip).toBe(true);
  });

  test("the toggle names the player it is actually driving", () => {
    expect(miniPlayerView(snapshot(), "console")?.toggleLabel).toBe("暂停网页试听");
    expect(miniPlayerView(snapshot({ playing: false }), "console")?.toggleLabel)
      .toBe("继续网页试听");
    expect(miniPlayerView(snapshot({ deviceOnline: true, deviceTrackId: "t1" }), "console")
      ?.toggleLabel).toBe("暂停时钟播放");
    expect(miniPlayerView(snapshot({ playbackMode: "remote" }), "console")?.toggleLabel)
      .toBe("暂停 Spotify 播放");
  });

  test("the group label matches the music view's own transport wording", () => {
    expect(miniPlayerView(snapshot(), "console")?.groupLabel).toBe("网页试听控制");
    expect(miniPlayerView(snapshot({ deviceOnline: true, deviceTrackId: "t1" }), "console")
      ?.groupLabel).toBe("设备播放控制");
    expect(miniPlayerView(snapshot({ playbackMode: "remote" }), "console")?.groupLabel)
      .toBe("Spotify Connect 控制");
  });

  test("a track detail in flight parks the toggle", () => {
    expect(miniPlayerView(snapshot({ loading: true }), "console")?.busy).toBe(true);
    expect(miniPlayerView(snapshot(), "console")?.busy).toBe(false);
  });
});

describe("mini player — the header must not re-render at 10 Hz", () => {
  // The store notifies on every playhead tick. The header is the most expensive
  // subtree in the console, and the mini player has no progress bar — so the
  // playhead must not reach it.
  test("a moving playhead is not a change", () => {
    const before = miniPlayerView(snapshot({ positionMs: 1_000 }), "console");
    const after = miniPlayerView(snapshot({ positionMs: 41_000 }), "console");
    expect(miniPlayerKey(after)).toBe(miniPlayerKey(before));
  });

  test("everything it draws is a change", () => {
    const base = miniPlayerKey(miniPlayerView(snapshot(), "console"));
    const changed: [string, Partial<MusicPlaybackSnapshot>][] = [
      ["paused", { playing: false }],
      ["loading", { loading: true }],
      ["queue emptied", { queue: [] }],
      ["failed", { error: "音频没有载入。" }],
      ["went remote", { playbackMode: "remote" }],
      ["device took over", { deviceOnline: true, deviceTrackId: "t1" }],
      ["new track", { detail: { track: track({ id: "t2", title: "晴天" }), lyrics: [] } }],
    ];
    for (const [what, over] of changed) {
      expect([what, miniPlayerKey(miniPlayerView(snapshot(over), "console"))])
        .not.toEqual([what, base]);
    }
  });

  test("no track and the music tab share the one empty key", () => {
    expect(miniPlayerKey(null)).toBe("-");
    expect(miniPlayerKey(miniPlayerView(snapshot(), "music"))).toBe("-");
  });
});

describe("mini player — rendered", () => {
  const markup = (view: StudioView) =>
    renderToStaticMarkup(createElement(
      CladdProvider,
      null,
      createElement(MiniPlayer, { view, onOpen: () => {} }),
    ));

  test("renders nothing at all before anything is played", () => {
    // The store singleton is untouched in this process, so this is the state a
    // freshly opened console is in.
    expect(markup("console")).toBe("");
    expect(markup("music")).toBe("");
  });

  const headerHtml = (firmwareStatus?: FirmwareStatus) => renderToStaticMarkup(createElement(
    CladdProvider,
    null,
    createElement(StudioHeader, {
      view: "console" as StudioView,
      onViewChange: () => {},
      runtime: null,
      ...(firmwareStatus ? { firmwareStatus } : {}),
    }),
  ));

  test("the header carries it, and only ever one of it", () => {
    // Nothing is playing in this process, so the header is unchanged for anyone
    // who has not started a track — that is the whole point of returning null.
    const html = headerHtml();
    expect(html).not.toContain("mini-player");
    expect(html).toContain("firmware-chip");
  });

  test("the header declares the one state that leaves no room for a play button", () => {
    // Measured, not guessed: between 52rem and 70rem the tab strip still sits in
    // the header and the right column is about 117px. The official status line
    // ("正在连接时钟…") is wide enough that the artwork and one transport button
    // no longer fit beside it; ZOS's battery chip is not. The stylesheet cannot
    // see the difference, so the header names it.
    const official = describeFirmware({
      osState: null,
      musicFirmwareOnline: false,
      arcadeOnline: false,
    });
    expect(official.mode).toBe("official");
    expect(headerHtml(official)).toContain("has-wide-actions");

    const zos = describeFirmware({
      osState: { live: true, battery: { percent: 72, charging: false } } as never,
      musicFirmwareOnline: false,
      arcadeOnline: false,
    });
    expect(zos.mode).toBe("zos");
    expect(headerHtml(zos)).not.toContain("has-wide-actions");
  });
});

describe("mini player — built from cladd, not from divs", () => {
  const source = MINI_PLAYER_SOURCE;

  test("the shell and its controls are cladd primitives", () => {
    for (const primitive of ["Toolbar", "ToolbarButton", "ToolbarSeparator", "Tooltip"]) {
      expect([primitive, source.includes(primitive)]).toEqual([primitive, true]);
    }
  });

  test("the transport calls the store, so next means one thing in this console", () => {
    expect(source).toContain("store.skip(-1)");
    expect(source).toContain("store.skip(1)");
    expect(source).toContain("store.toggle()");
    // It is a window onto playback, never an owner: no element of its own.
    expect(source).not.toMatch(/<audio\s/);
    expect(source).not.toContain("createAudio");
  });
});
