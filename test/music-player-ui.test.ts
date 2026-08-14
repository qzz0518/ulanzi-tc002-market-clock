import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeviceReconnectGuidance,
  MusicAccountAvatar,
  MusicPlayer,
} from "../web/src/components/music/music-player";
import {
  cascadeBandY,
  cascadePhase,
  MUSIC_MODES,
  skylineBarLevel,
  spanIndexAtPx,
  spotlightOffsetPx,
} from "../web/src/components/music/pixel-lyric-modes";
import {
  drawPixelLyricsFrame,
  focusGlyphIndexForProgress,
  lyricScrollOffsetForProgress,
  MusicThemePanel,
  pixelLyricCursor,
  pixelLyricScrollOffset,
  pixelTextWidth,
  projectedPlayheadMs,
  type PixelLyricLine,
  type PixelLyricsFrameInput,
} from "../web/src/components/music/pixel-lyrics-preview";
import { lyricCells } from "../web/src/lib/lyric-cursor";

// The preview only ever sets fillStyle and paints rectangles, so a recording
// stub is a whole rasterizer. That is what lets the browser's 52 × 16 be
// asserted pixel for pixel next to the firmware's, which is the only way the
// two can be held to the same geometry.
function rasterizePreview(input: PixelLyricsFrameInput): string[][] {
  const grid: string[][] = Array.from({ length: 16 }, () => Array.from({ length: 52 }, () => "#000000"));
  let fill = "#000000";
  const context = {
    imageSmoothingEnabled: true,
    clearRect: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      for (let row = y; row < y + h; row += 1) {
        for (let column = x; column < x + w; column += 1) {
          if (row < 0 || row > 15 || column < 0 || column > 51) continue;
          grid[row]![column] = fill;
        }
      }
    },
    get fillStyle() {
      return fill;
    },
    set fillStyle(value: string) {
      fill = value;
    },
  };
  drawPixelLyricsFrame(context as unknown as CanvasRenderingContext2D, input);
  return grid;
}

function litPixelsInRows(grid: string[][], from: number, to: number): number {
  let lit = 0;
  for (let row = from; row <= to; row += 1) {
    for (const color of grid[row]!) if (color !== "#000000") lit += 1;
  }
  return lit;
}

describe("music player UI", () => {
  test("renders source before preview with an honest empty state", () => {
    const html = renderToStaticMarkup(createElement(MusicPlayer));

    expect(html.indexOf("SOURCE / NETEASE")).toBeLessThan(html.indexOf("LIVE PREVIEW"));
    expect(html).toContain("从一首歌开始");
    expect(html).toContain("52 × 16 像素屏");
    expect(html).toContain('width="52" height="16"');
    expect(html).toContain("屏幕 52 × 16 · 字模 12 × 12");
    expect(html).toContain("整字格变速");
    expect(html).toContain('role="group"');
    expect(html).toContain('id="music-theme-skin-label"');
    expect(html).toContain('aria-labelledby="music-theme-skin-label"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("信号绿");
    expect(html).toContain("磁带橙");
    expect(html).toContain("蓝晒");
    expect(html).toContain("街机红");
    expect(html).toContain('id="music-theme-mode-label"');
    expect(html).toContain('aria-labelledby="music-theme-mode-label"');
    expect(html).toContain("显示形式");
    expect(html).toContain("走带");
    expect(html).toContain("天际");
    expect(html).toContain("聚光");
    expect(html).toContain("升降");
    expect(html).toContain('label for="music-search-input"');
    expect(html).toContain("cladd-search-field");
    expect(html).toContain("cladd-segmented");
    expect(html).toContain("cladd-chip");
    expect(html).toContain("搜索歌曲、歌手或专辑");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("侧载音乐固件");
    expect(html).toContain("设备同屏");
    expect(html).toContain("还没有选择歌曲");
    expect(html).toContain("歌词会在这里跟随播放");
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain("当前歌词会以 52 × 16 像素版式显示");
    expect(html).not.toContain("52 × 16 READY");
    expect(html).not.toContain("STANDBY");
    expect(html).not.toContain("MUSIC_U=");
  });

  test("offers both music sources and keeps Spotify a remote, not a player", async () => {
    const [source, storeSource] = await Promise.all([
      Bun.file(new URL("../web/src/components/music/music-player.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/lib/music-playback-store.ts", import.meta.url)).text(),
    ]);

    // The switch itself, and the two sources it moves between.
    expect(source).toContain('className="music-source-switch"');
    expect(source).toContain("/api/music/provider");
    expect(source).toContain("/api/music/providers");
    expect(source).toContain('切换到 ${PROVIDER_COPY[provider].label}');

    // Spotify Connect: transport goes to the service, never to an <audio> tag,
    // and the picker can move playback to another Connect device.
    expect(source).toContain("/api/music/remote");
    expect(source).toContain('action: "transfer"');
    expect(source).toContain("/api/music/spotify/devices");

    // The element itself is no longer this view's to own — it hung off the
    // now-playing section, so leaving 音乐 destroyed the player mid-song. The
    // rule it enforced survives the move: remote mode attaches no source to it
    // at all, because Spotify audio never reaches this origin.
    // A rendered element (`<audio ` with attributes) and the ref + media
    // handlers that made it this component's property. The prose comment
    // explaining its absence deliberately still says the word.
    expect(source).not.toMatch(/<audio\s/);
    expect(source).not.toContain("audioRef");
    expect(source).not.toMatch(/onTimeUpdate|onLoadedMetadata|onDurationChange/);
    expect(storeSource).toContain('if (state.playbackMode !== "remote") {');
    expect(storeSource).toContain("/api/music/tracks/${track.id}/stream");

    // PKCE setup guidance has to name the exact redirect URI Spotify demands.
    expect(source).toContain("/api/music/spotify/callback");
    expect(source).toContain("无需 Client Secret");

    const html = renderToStaticMarkup(createElement(MusicPlayer));
    expect(html).toContain("网易云");
    expect(html).toContain("Spotify");
  });

  test("puts 随机播放 and 每日推荐 under the playlist picker, gated on a signed-in NetEase", async () => {
    const source = await Bun.file(
      new URL("../web/src/components/music/music-player.tsx", import.meta.url),
    ).text();

    // 两个按钮在歌单选择器之后、歌曲列表之前——用户要的就是「歌单选择下面」。
    const playlistAt = source.indexOf('className="music-playlist-select"');
    const discoveryAt = source.indexOf('className="music-discovery"');
    const listAt = source.indexOf('className="music-track-list"');
    expect(playlistAt).toBeGreaterThan(-1);
    expect(discoveryAt).toBeGreaterThan(playlistAt);
    expect(listAt).toBeGreaterThan(discoveryAt);
    expect(source).toContain("随机播放");
    expect(source).toContain("每日推荐");

    // 两条数据都是账号私有的，Spotify 之下和未登录时不该出现一个按不动的按钮。
    expect(source).toContain(
      'const neteaseSignedIn = activeProviderId === "netease" && session?.loggedIn === true;',
    );
    expect(source).toContain("{neteaseSignedIn && (");

    // 动作本身在 lib 里（test/netease-discovery.ts 逐条核对顺序与守卫），
    // 视图不自己拼取数 → 入队 → 起播这段序列。
    expect(source).toContain("loadDailyRecommendations");
    expect(source).toContain("playRandomLikedTrack");
    expect(source).not.toContain("/api/music/netease/");

    // 未登录时渲染的是登录引导，不是这两个按钮。
    const html = renderToStaticMarkup(createElement(MusicPlayer));
    expect(html).not.toContain("随机播放");
    expect(html).not.toContain("每日推荐");
  });

  test("keeps the guarded sideload session flow in the secondary drawer", async () => {
    // 抽屉本体抽成了两页共用的 FirmwarePanel；音乐页保留触发按钮、口令与
    // 固件轮询，流程细节在共享组件里检查。
    const [source, panelSource, storeSource] = await Promise.all([
      Bun.file(new URL("../web/src/components/music/music-player.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/firmware-panel.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/lib/music-playback-store.ts", import.meta.url)).text(),
    ]);

    expect(source).toContain('dialogClassName="music-firmware-dialog"');
    expect(source).toContain("侧载音乐固件");
    expect(source).toContain("START_TC002_MUSIC_SESSION");
    // 固件轮询跟着播放走，不跟着这个视图走：切到别的标签页时设备心跳仍要被
    // 读到，否则回到音乐页会有 2.5 s 认不出已侧载的固件。
    expect(storeSource).toContain("/api/music/device/state?viewer=web");
    expect(storeSource).toContain("FWPOLL");
    expect(source).not.toContain("刷入");
    expect(source).not.toContain("update.img");

    // 恢复承诺按 restoresTo 说,不再写死「官方固件」——刷过 ZOS 的机器上断电
    // 重启回到的是 ZOS。渲染结果在 firmware-panel.test.ts 里逐句核对。
    expect(panelSource).toContain("我知道如何回到${restoresTo}");
    expect(panelSource).toContain("按住 USB-C 旁的复位按钮");
    expect(panelSource).toContain("侧载固件");
    expect(panelSource).toContain("restoreActionLabel");
    expect(panelSource).not.toContain("刷入");
    expect(panelSource).not.toContain("update.img");
    expect(panelSource.indexOf('className="fw-recovery-acknowledgement"')).toBeLessThan(
      panelSource.indexOf('className="fw-deploy-actions"'),
    );
  });

  test("uses Cladd UI for every replaceable music interaction primitive", async () => {
    const [playerSource, previewSource, panelSource] = await Promise.all([
      Bun.file(new URL("../web/src/components/music/music-player.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/music/pixel-lyrics-preview.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/components/firmware-panel.tsx", import.meta.url)).text(),
    ]);

    for (const component of [
      "<SearchField",
      "<Select",
      "<List",
      "<ListButton",
      "<Slider",
      "<Chip",
    ]) {
      expect(playerSource).toContain(component);
    }
    // 固件抽屉（含恢复确认的 Checkbox）抽到了共享面板里。
    expect(panelSource).toContain("<Checkbox");
    expect(panelSource).toContain("<Dialog");
    expect(previewSource).toContain("<ToggleGroup");
    expect(previewSource).toContain("<ToggleButton");
    expect(playerSource).not.toMatch(/<(button|input|select)\b/);
    expect(previewSource).not.toMatch(/<(button|input|select)\b/);
    expect(panelSource).not.toMatch(/<(button|input|select)\b/);
    expect(playerSource.indexOf('className="music-timeline__slider"')).toBeLessThan(
      playerSource.indexOf('className="music-timeline-slider"'),
    );
  });

  test("keeps library and lyric rows flat with hairline dividers", async () => {
    const [playerSource, css] = await Promise.all([
      Bun.file(new URL("../web/src/components/music/music-player.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/styles/music-player.css", import.meta.url)).text(),
    ]);

    expect(playerSource).not.toContain("selected={");
    expect(css).toMatch(/\.music-lyric-row \*\s*\{\s*border-radius:\s*0 !important;/s);
    expect(css).toMatch(/\.music-track-row\.is-active\s*\{[^}]*color-mix\(in oklab, var\(--music-acid\) 9%, transparent\)/s);
    expect(css).toMatch(/\.music-lyric-row\.is-active\s*\{[^}]*color-mix\(in oklab, var\(--music-acid\) 9%, transparent\)/s);
    expect(css).toMatch(/\.music-track-row__after svg\s*\{[^}]*opacity:\s*0;/s);
    expect(css).toMatch(/\.music-track-row:hover \.music-track-row__after svg/);
  });

  test("uses a divided light playback console without decorative player chrome", async () => {
    const [playerSource, css] = await Promise.all([
      Bun.file(new URL("../web/src/components/music/music-player.tsx", import.meta.url)).text(),
      Bun.file(new URL("../web/src/styles/music-player.css", import.meta.url)).text(),
    ]);

    expect(playerSource).toContain('className="music-now-playing__header"');
    expect(playerSource).toContain('className="music-now-playing__main"');
    expect(playerSource).toContain('className="music-timeline__meta"');
    expect(playerSource).toContain('className="music-transport"');
    expect(playerSource).toContain('variant="solid-fill"');
    expect(playerSource).toContain("tightFocusRing");
    expect(playerSource).not.toContain("<Disc3");
    expect(playerSource).not.toContain("music-level-meter");
    expect(css).toMatch(/\.music-now-playing\s*\{[^}]*border-block:\s*1px solid var\(--music-line\);/s);
    expect(css).toMatch(/\.music-now-playing\s*\{[^}]*border-radius:\s*0;/s);
    expect(css).toMatch(/\.music-now-playing\s*\{[^}]*background:\s*transparent;/s);
    expect(css).not.toContain("@keyframes music-meter");
  });

  test("moves long lyrics only by complete 12px glyph cells", () => {
    expect(lyricScrollOffsetForProgress(48, 0.75)).toBe(0);
    expect(lyricScrollOffsetForProgress(80, 0)).toBe(0);
    expect(lyricScrollOffsetForProgress(80, 0.08)).toBe(0);
    expect(lyricScrollOffsetForProgress(80, 0.5)).toBe(24);
    expect(lyricScrollOffsetForProgress(80, 0.92)).toBe(36);
    expect(lyricScrollOffsetForProgress(80, 1)).toBe(36);
    for (const width of [56, 64, 80, 96, 112]) {
      for (const progress of [0, 0.12, 0.27, 0.5, 0.73, 0.88, 1]) {
        expect(lyricScrollOffsetForProgress(width, progress) % 12).toBe(0);
      }
    }
  });

  test("offers four rendering modes in the order that IS the wire protocol", () => {
    // The index is what crosses the link to both firmwares — ticker=0 …
    // cascade=3 — matching LYRIC_MODES / OS_LYRIC_MODES on the service side and
    // MusicScreen::Mode on the device. Reordering this list for looks would
    // repaint the panel in a form the console is not showing, with nothing to
    // fail anywhere in between.
    expect(MUSIC_MODES.map((mode) => mode.id)).toEqual([
      "ticker",
      "skyline",
      "spotlight",
      "cascade",
    ]);
  });

  test("spotlight locks the sung pixel column to screen center", () => {
    expect(spotlightOffsetPx(120, 0)).toBe(26);
    expect(spotlightOffsetPx(120, 0.5)).toBe(-34);
    expect(spotlightOffsetPx(120, 1)).toBe(-94);
    const spans = [
      { start: 0, end: 12 },
      { start: 24, end: 36 },
    ];
    expect(spanIndexAtPx(spans, 3)).toBe(0);
    expect(spanIndexAtPx(spans, 18)).toBe(0);
    expect(spanIndexAtPx(spans, 30)).toBe(1);
    expect(spanIndexAtPx(spans, 999)).toBe(1);
    expect(spanIndexAtPx([], 3)).toBe(-1);
  });

  test("cascade lifts lines in from below and out through the top", () => {
    expect(cascadeBandY(0)).toBe(2);
    expect(cascadeBandY(0.001)).toBe(16);
    expect(cascadeBandY(0.14)).toBe(2);
    expect(cascadeBandY(0.5)).toBe(2);
    expect(cascadeBandY(1)).toBeLessThanOrEqual(-12);
    expect(cascadeBandY(0.001, true)).toBe(2);
    expect(cascadePhase(0.05)).toBe("enter");
    expect(cascadePhase(0.5)).toBe("hold");
    expect(cascadePhase(0.95)).toBe("exit");
    expect(cascadePhase(0.95, true)).toBe("hold");
  });

  test("skyline bars stay deterministic, bounded, and quiet while paused", () => {
    let peak = 0;
    for (let bar = 0; bar < 17; bar += 1) {
      for (const timeMs of [0, 125, 1_000, 5_375, 60_000]) {
        const playingLevel = skylineBarLevel(bar, timeMs, true, 1, 3);
        expect(playingLevel).toBe(skylineBarLevel(bar, timeMs, true, 1, 3));
        expect(Number.isInteger(playingLevel)).toBe(true);
        expect(playingLevel).toBeGreaterThanOrEqual(0);
        expect(playingLevel).toBeLessThanOrEqual(3);
        peak = Math.max(peak, playingLevel);
        expect(skylineBarLevel(bar, timeMs, false, 0, 3)).toBeLessThanOrEqual(1);
        expect(skylineBarLevel(bar, timeMs, true, 1, 12)).toBeLessThanOrEqual(12);
      }
    }
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(skylineBarLevel(0, 0, true, 0, 12, 1)).toBe(11);
    expect(skylineBarLevel(0, 99_999, true, 1, 12, 1)).toBe(12);
    expect(skylineBarLevel(0, 0, true, 1, 12, 0)).toBe(1);
  });

  // 天际's spectrum is a three-row FLOOR under a full-width line, in all three
  // implementations. It used to climb to twelve rows and drop the text whenever
  // `hasLyric` was false — and since the sideloaded player only ever paints once
  // a timed line exists, and ZOS always has a row to draw (the lyric, else the
  // title/artist rotation, else 播放中 / 已暂停), the preview was the only one of
  // the three that could show it. What it showed was the reported bug with the
  // words gone rather than merely covered.
  test("skyline keeps its spectrum a floor and never trades the line for it", () => {
    const base: PixelLyricsFrameInput = {
      skin: "signal",
      mode: "skyline",
      currentText: "Hey Jude",
      hasLyric: true,
      cursor: { index: 4, frac: 0, progress: 0.5, phase: "singing" },
      windowProgress: 0.5,
      trackProgress: 0.25,
      playing: true,
      scrollOffsetPx: 0,
      timeMs: 4_000,
      reducedMotion: false,
    };

    for (const hasLyric of [true, false]) {
      for (const playing of [true, false]) {
        const grid = rasterizePreview({ ...base, hasLyric, playing });
        const where = `hasLyric=${hasLyric} playing=${playing}`;
        // The line, on rows 0..11.
        expect(litPixelsInRows(grid, 0, 11), where).toBeGreaterThan(0);
        // Row 12 is the gutter between the line and the bars.
        expect(litPixelsInRows(grid, 12, 12), where).toBe(0);
        // And the bars stand at x = 1 + 3b for seventeen bars, so they span the
        // panel rather than owning a column of it.
        for (let row = 13; row <= 15; row += 1) {
          for (let column = 0; column < 52; column += 1) {
            if (grid[row]![column] === "#000000") continue;
            expect((column - 1) % 3 <= 1 && column >= 1 && column <= 50, `${where} x=${column}`)
              .toBe(true);
          }
        }
      }
    }
  });

  test("labels sources that cannot provide real spectrum audio", () => {
    const html = renderToStaticMarkup(createElement(MusicThemePanel, {
      mode: "skyline",
      skin: "signal",
      accent: null,
      onModeChange: () => {},
      onSkinChange: () => {},
      onAccentChange: () => {},
      syncsToDevice: false,
      simulatedSpectrum: true,
    }));
    expect(html).toContain("此音源为模拟律动");
  });

  test("hands the bright focus from the first glyph to the last", () => {
    expect(focusGlyphIndexForProgress(6, 0)).toBe(0);
    expect(focusGlyphIndexForProgress(6, 0.49)).toBe(2);
    expect(focusGlyphIndexForProgress(6, 0.5)).toBe(3);
    expect(focusGlyphIndexForProgress(6, 1)).toBe(5);
    expect(focusGlyphIndexForProgress(0, 0.5)).toBe(-1);
  });

  // --- the reported bug, on the preview canvas -------------------------------
  //
  // "谁说站在光里的才算英雄" is sung from 110330 for 5.29 s. The next line does not
  // start until 128880, and defining the end as the next start gave the wipe
  // 18.55 s to cross eleven glyphs — an eighth of the speed of the voice.
  const GUYONGZHE_TEXT = "谁说站在光里的才算英雄";
  const GUYONGZHE_LINE: PixelLyricLine = {
    startMs: 110_330,
    endMs: 115_620,
    untilMs: 128_880,
    cells: lyricCells({
      startMs: 110_330,
      endMs: 115_620,
      text: GUYONGZHE_TEXT,
      words: [
        [110_330, 350], [110_680, 250], [110_930, 460], [111_390, 400], [111_790, 400],
        [112_190, 400], [112_590, 640], [113_230, 380], [113_610, 390], [114_000, 340],
        [114_340, 1_280],
      ].map(([startMs, durationMs], index) => ({
        startMs: startMs!,
        endMs: startMs! + durationMs!,
        text: [...GUYONGZHE_TEXT][index]!,
      })),
    }),
  };

  test("the preview lights the glyph the singer is on, not the one a sweep would", () => {
    const at = (playheadMs: number) =>
      pixelLyricCursor(GUYONGZHE_TEXT, GUYONGZHE_LINE, playheadMs).cursor;
    const glyph = (index: number) => [...GUYONGZHE_TEXT][index];
    // What the three renderers computed before: the 18.55 s window spread
    // evenly over eleven glyphs.
    const sweep = (playheadMs: number) => glyph(focusGlyphIndexForProgress(
      11,
      (playheadMs - 110_330) / (128_880 - 110_330),
    ));

    expect(GUYONGZHE_LINE.cells).toHaveLength(11);

    // 0.67 s in the singer is on 站, the third glyph. The sweep is still on the
    // first one and will stay there for another two seconds.
    expect(glyph(at(111_000).index)).toBe("站");
    expect(sweep(111_000)).toBe("谁");

    // 2.67 s in: 的, glyph seven of eleven — the line is more than half sung.
    expect(glyph(at(113_000).index)).toBe("的");
    expect(sweep(113_000)).toBe("说");

    // 雄 is held for 1.28 s, four times the length of 谁. A uniform sweep cannot
    // express that at all, and lands five glyphs behind.
    expect(glyph(at(115_000).index)).toBe("雄");
    expect(at(115_000).phase).toBe("singing");
    expect(sweep(115_000)).toBe("站");

    // And here is the complaint itself. At 120 s the voice has been silent for
    // 4.4 seconds and the line is simply finished; the old sweep was only just
    // arriving at 光, glyph six of eleven, and had eight more seconds to go.
    expect(at(120_000).phase).toBe("held");
    expect(at(120_000).progress).toBe(1);
    expect(sweep(120_000)).toBe("里");
    expect(sweep(128_000)).toBe("雄");
  });

  test("nothing on the panel moves once the singing has stopped", () => {
    // The user's sentence, as a pixel assertion: the highlight completes at the
    // sung end and then holds. Three playheads spanning the instrumental have
    // to rasterize to the same 52 × 16 image.
    const base = {
      skin: "signal" as const,
      currentText: GUYONGZHE_TEXT,
      hasLyric: true,
      trackProgress: 0.4,
      playing: true,
      timeMs: 120_000,
      // Isolates the lyric clock: the spectrum and the beat are driven by
      // timeMs, which is held fixed here so any difference is the wipe's.
      reducedMotion: true,
    };
    for (const mode of ["ticker", "skyline", "spotlight"] as const) {
      const frameAt = (playheadMs: number) => {
        const { cursor, windowProgress } = pixelLyricCursor(
          GUYONGZHE_TEXT,
          GUYONGZHE_LINE,
          playheadMs,
        );
        return JSON.stringify(rasterizePreview({
          ...base,
          mode,
          cursor,
          windowProgress,
          scrollOffsetPx: pixelLyricScrollOffset(GUYONGZHE_TEXT, cursor, mode, true),
        }));
      };
      const finished = frameAt(115_620);
      expect(frameAt(120_000), `${mode} kept moving at 120 s`).toBe(finished);
      expect(frameAt(128_000), `${mode} kept moving at 128 s`).toBe(finished);
      // …and it is genuinely a different picture from mid-line, so the test is
      // not passing because everything is blank.
      expect(frameAt(113_000)).not.toBe(finished);
    }
  });

  test("a held line reads as sung end to end, with no glyph left glowing", () => {
    const { cursor, windowProgress } = pixelLyricCursor(
      GUYONGZHE_TEXT,
      GUYONGZHE_LINE,
      120_000,
    );
    // 走带: the text occupies rows 2..13 and the two cue rows are 0 and 15, so
    // this band is the line and nothing else.
    const grid = rasterizePreview({
      skin: "signal",
      mode: "ticker",
      currentText: GUYONGZHE_TEXT,
      hasLyric: true,
      cursor,
      windowProgress,
      trackProgress: 0.4,
      playing: true,
      scrollOffsetPx: 0,
      timeMs: 120_000,
      reducedMotion: true,
    });
    const colors = new Set<string>();
    for (let row = 2; row <= 13; row += 1) {
      for (const color of grid[row]!) if (color !== "#000000") colors.add(color);
    }
    // Exactly the sung tier: no bright focus character parked mid-line for
    // thirteen seconds, and nothing still dim as if it were yet to come.
    expect([...colors]).toEqual(["#6ca34e"]);
  });

  test("cascade keeps the line on the panel through the instrumental", () => {
    // The one place the two clocks must NOT be conflated. cascadeBandY flies the
    // row off the top at the end of its ramp; keyed on the sung progress the
    // line would leave at 115.6 s and the panel would sit blank for 13 s.
    const base = {
      skin: "signal" as const,
      mode: "cascade" as const,
      currentText: GUYONGZHE_TEXT,
      hasLyric: true,
      trackProgress: 0.4,
      playing: true,
      scrollOffsetPx: 0,
      reducedMotion: false,
    };
    for (const playheadMs of [116_000, 120_000, 125_000]) {
      const { cursor, windowProgress } = pixelLyricCursor(
        GUYONGZHE_TEXT,
        GUYONGZHE_LINE,
        playheadMs,
      );
      expect(cursor.phase, String(playheadMs)).toBe("held");
      const grid = rasterizePreview({ ...base, cursor, windowProgress, timeMs: playheadMs });
      expect(litPixelsInRows(grid, 0, 12), `blank at ${playheadMs}`).toBeGreaterThan(0);
    }
    // It does leave, once its successor is actually due.
    const late = pixelLyricCursor(GUYONGZHE_TEXT, GUYONGZHE_LINE, 128_800);
    expect(late.windowProgress).toBeGreaterThan(0.95);
  });

  test("spotlight locks the sung glyph to centre even when the glyphs are not equal in time", () => {
    // 雄 is held for 1.28 s, 说 for 250 ms. A `progress × textWidth` offset
    // assumes the row is crossed at a constant rate and lands on the wrong
    // column by whole cells the moment that stops being true.
    const width = pixelTextWidth(GUYONGZHE_TEXT);
    expect(width).toBe(11 * 12);
    for (const [playheadMs, glyphIndex] of [[111_000, 2], [113_000, 6], [115_000, 10]] as const) {
      const { cursor } = pixelLyricCursor(GUYONGZHE_TEXT, GUYONGZHE_LINE, playheadMs);
      expect(cursor.index).toBe(glyphIndex);
      const offset = pixelLyricScrollOffset(GUYONGZHE_TEXT, cursor, "spotlight");
      // The focused cell straddles screen centre (x = 26), which is the whole
      // contract of the mode.
      expect(offset + glyphIndex * 12).toBeLessThanOrEqual(26);
      expect(offset + (glyphIndex + 1) * 12).toBeGreaterThanOrEqual(26);
    }
  });

  test("the track title is parked, not treated as a line that already finished", () => {
    // With no lyric the panel shows the title, and the window for that case is
    // all zeros. That must be recognised as "there is no window" rather than
    // handed to the cursor as a span, which reads as "already over" and would
    // scroll a long title to its last glyph and leave it there.
    const title = "Sgt. Pepper's Lonely Hearts Club Band";
    const noWindow: PixelLyricLine = { startMs: 0, endMs: 0, untilMs: 0 };
    for (const playheadMs of [0, 1, 1_000, 41_000, 200_000]) {
      const { cursor, windowProgress } = pixelLyricCursor(title, noWindow, playheadMs);
      expect(cursor).toEqual({ index: 0, frac: 0, progress: 0, phase: "singing" });
      expect(windowProgress).toBe(0);
      expect(pixelLyricScrollOffset(title, cursor, "ticker")).toBe(0);
      // The regression that made this an assertion rather than a comment: the
      // no-window case used to be answered with a window of MAX_SAFE_INTEGER,
      // whose progress is tiny but STRICTLY POSITIVE (3.3e-12 at 30 s). That
      // misses cascadeBandY's `progress <= 0` guard, lands in the entrance ramp
      // and rounds the band to y = 16 — the twelve-row text blitted at rows
      // 16..27 of a sixteen-row panel, i.e. a blank screen for every song's
      // intro and for the whole of any track with no lyrics at all.
      expect(cascadeBandY(windowProgress)).toBe(2);
      expect(cascadePhase(windowProgress)).toBe("hold");
    }
  });

  test("a line with no word timings still sweeps exactly as it always did", () => {
    // The whole Spotify catalogue comes through lrclib as line-level LRC. The
    // cursor has to be a strict generalisation, not a replacement.
    const line: PixelLyricLine = { startMs: 4_000, endMs: 10_000, untilMs: 10_000 };
    for (let step = 0; step <= 20; step += 1) {
      const playheadMs = 4_000 + step * 300;
      const { cursor } = pixelLyricCursor("Hey Jude don't", line, playheadMs);
      const progress = Math.min(1, Math.max(0, (playheadMs - 4_000) / 6_000));
      const glyphCount = [..."Hey Jude don't"].length;
      expect(cursor.progress).toBeCloseTo(progress, 10);
      expect(cursor.index).toBe(focusGlyphIndexForProgress(glyphCount, progress));
    }
  });

  test("smooths between renders by advancing the playhead, not the progress", () => {
    // It used to advance a normalized progress by elapsed/lineDuration, which
    // made the smoothing inherit the very number this work exists to correct: a
    // 5-second line given an 18-second window smoothed at 3/8 speed. A playhead
    // is a playhead, and the cursor decides what it means.
    expect(projectedPlayheadMs(110_330, 500, true)).toBe(110_830);
    expect(projectedPlayheadMs(110_330, 500, false)).toBe(110_330);
    // A negative delta (a clock that stepped backwards between frames) never
    // rewinds the line.
    expect(projectedPlayheadMs(110_330, -500, true)).toBe(110_330);
  });

  test("explains the power-cycle fallback after device detection fails", () => {
    const html = renderToStaticMarkup(createElement(DeviceReconnectGuidance));

    expect(html).toContain('role="status"');
    expect(html).toContain("如果无法检测到设备，请关机并连接到电脑再开机。");
  });

  test("renders the NetEase profile image with a readable initial fallback", () => {
    const html = renderToStaticMarkup(createElement(MusicAccountAvatar, {
      profile: {
        provider: "netease",
        id: "42",
        nickname: "小皮皮蛋",
        avatarUrl: "https://p1.music.126.net/avatar.jpg",
      },
    }));

    // The proxy URL names the account, so switching sources cannot leave the
    // browser showing the other provider's face for an identical URL.
    expect(html).toContain('src="/api/music/avatar?provider=netease&amp;account=42"');
    expect(html).toContain('class="music-account-strip__avatar-image"');
    expect(html).toContain('class="music-account-strip__avatar-fallback"');
    expect(html).toContain(">小<");
    expect(html).not.toContain("p1.music.126.net");

    const spotify = renderToStaticMarkup(createElement(MusicAccountAvatar, {
      profile: {
        provider: "spotify",
        id: "pixel-listener",
        nickname: "小鸭",
        avatarUrl: "https://i.scdn.co/image/avatar",
      },
    }));
    expect(spotify).toContain('src="/api/music/avatar?provider=spotify&amp;account=pixel-listener"');
    expect(spotify).not.toContain("i.scdn.co");
  });

  test("keeps the long-form music workspace on document scrolling", async () => {
    const css = await Bun.file(new URL("../web/src/styles/music-player.css", import.meta.url)).text();
    const globals = await Bun.file(new URL("../web/src/styles/globals.css", import.meta.url)).text();

    expect(css).toContain(".studio-page.is-music-page");
    expect(css).toMatch(/\.studio-page\.is-music-page\s*\{[^}]*align-content:\s*start;/s);
    expect(css).toMatch(/\.studio-page\.is-music-page\s*\{[^}]*height:\s*auto;/s);
    expect(css).toMatch(/\.studio-page\.is-music-page\s*\{[^}]*overflow:\s*visible;/s);
    expect(css).toMatch(/\.studio-layout\.is-music\s*\{[^}]*overflow:\s*visible;/s);
    expect(css).toMatch(/\.music-track-list__viewport\s*\{[^}]*max-height:\s*none;/s);
    expect(css).toMatch(/\.music-track-list__viewport\s*\{[^}]*overflow:\s*visible;/s);
    expect(css).toMatch(/\.music-track-list__viewport\s*\{[^}]*overscroll-behavior:\s*auto;/s);
    expect(css).not.toMatch(/\.music-track-list__viewport\s*\{[^}]*overflow-y:\s*auto;/s);
    expect(css).not.toMatch(/\.music-track-list__viewport\s*\{[^}]*overscroll-behavior:\s*contain;/s);
    expect(css).toMatch(/\.music-lyric-tape\s*\{[^}]*max-height:\s*none;/s);
    expect(css).toMatch(/\.music-lyric-tape\s*\{[^}]*overflow:\s*visible;/s);
    expect(css).not.toMatch(/\.music-lyric-tape\s*\{[^}]*overscroll-behavior:\s*contain;/s);
    expect(css).toMatch(/\.music-stage__sticky\s*\{[^}]*overflow:\s*visible;/s);
    expect(css).not.toMatch(/\.music-stage__sticky\s*\{[^}]*overflow-y:\s*auto;/s);
    expect(css).not.toMatch(/\.music-stage__sticky\s*\{[^}]*overscroll-behavior:\s*contain;/s);
    expect(css).toContain(".music-firmware-dialog[data-open]");
    expect(css).toContain("--tw-translate-x: 0px !important");
    // 底部主导航一列一个主视图（内容/画板/素材库/音乐/游戏/VIBE/系统）。
    expect(globals).toMatch(
      /@media \(max-width: 52rem\)[\s\S]*?\.main-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\);/,
    );
    expect(globals).toMatch(
      /@media \(max-width: 60rem\) and \(max-height: 34rem\)[\s\S]*?\.main-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\);/,
    );
  });

  test("shares the app heading scale and gives the preview the wider desktop column", async () => {
    const css = await Bun.file(new URL("../web/src/styles/music-player.css", import.meta.url)).text();

    expect(css).not.toContain(".is-music-page .page-heading {");
    expect(css).not.toContain(".is-music-page .page-heading h1 {");
    expect(css).not.toContain(".is-music-page .page-heading p {");
    expect(css).toMatch(
      /@media \(min-width: 70rem\)[\s\S]*?\.music-studio\s*\{[^}]*grid-template-columns:\s*minmax\(22rem, 0\.72fr\) minmax\(32rem, 1\.28fr\);/,
    );
  });

  test("bounds the playlist popover and skin controls to their own layout boxes", async () => {
    const css = await Bun.file(new URL("../web/src/styles/music-player.css", import.meta.url)).text();

    expect(css).toMatch(/\.music-playlist-select\s*\{[^}]*width:\s*min\(100%, 20rem\);/s);
    expect(css).toMatch(
      /\.music-playlist-popover\s*\{[^}]*width:\s*min\(20rem, calc\(100vw - 2rem\)\) !important;/s,
    );
    expect(css).toMatch(
      /\.music-playlist-popover > div:last-child\s*\{[^}]*max-height:\s*min\(18rem, calc\(100dvh - 2rem\)\) !important;/s,
    );
    // 主题面板按自身宽度排版（容器查询），不看视口：它是右栏的一部分，宽度随分栏变化。
    expect(css).toMatch(/\.music-theme-panel\s*\{[^}]*container-type:\s*inline-size;/s);
    expect(css).toMatch(/\.music-theme-panel__group\s*\{[^}]*container-type:\s*inline-size;/s);
    // 窄面板两组堆叠、每组 2×2；宽面板两组并排、每组 4 列——横向吃满且不出现 3+1 断行。
    expect(css).toMatch(/\.music-theme-options\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(css).toMatch(
      /@container \(min-width: 38rem\)[\s\S]*?\.music-theme-options\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/,
    );
    expect(css).toMatch(
      /@container \(min-width: 50rem\)[\s\S]*?\.music-theme-panel__groups\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/,
    );
    expect(css).not.toMatch(/\.music-theme-option__content\s*\{[^}]*min-height:/s);
  });

  test("uses the same flat, divided workspace shell as the other tabs", async () => {
    const css = await Bun.file(new URL("../web/src/styles/music-player.css", import.meta.url)).text();

    expect(css).toMatch(/\.studio-layout\.is-music\s*\{[^}]*border-top:\s*1px solid var\(--border\);/s);
    expect(css).toMatch(/\.music-studio\s*\{[^}]*--music-line:\s*var\(--border\);/s);
    expect(css).toMatch(/\.music-studio\s*\{[^}]*border:\s*0;/s);
    expect(css).toMatch(/\.music-studio\s*\{[^}]*border-radius:\s*0;/s);
    expect(css).toMatch(/\.music-studio\s*\{[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.music-library\s*\{[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.music-stage\s*\{[^}]*background:\s*transparent;/s);
  });
});
