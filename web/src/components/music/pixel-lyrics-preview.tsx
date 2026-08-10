import { Button, Chip, ColorPicker, ToggleButton, ToggleGroup } from "@cladd-ui/react";
import { AudioLines, Check, Monitor, MoveHorizontal, Radar, Radio, Rows3 } from "lucide-react";
import { useEffect, useRef } from "react";
import { FULL_WIDTH_CELL, GLYPH_HEIGHT, glyphCellWidth, glyphRows } from "@/lib/pixel-glyphs";
import { SPECTRUM_HOP_MS, type SpectrumLookup } from "@/lib/spectrum-timeline";
import {
  beatKick,
  cascadeBandY,
  cascadePhase,
  isMusicMode,
  MUSIC_MODES,
  musicModeNote,
  SKYLINE_BARS,
  skylineBarLevel,
  spanIndexAtPx,
  spotlightOffsetPx,
  type MusicMode,
} from "./pixel-lyric-modes";

export const MUSIC_SKINS = [
  { id: "signal", name: "信号绿", note: "终端荧光", color: "lime" },
  { id: "tape", name: "磁带橙", note: "暖色录音", color: "orange" },
  { id: "blueprint", name: "蓝晒", note: "冷蓝电台", color: "cyan" },
  { id: "arcade", name: "街机红", note: "红白像素", color: "red" },
] as const;

export type MusicSkin = typeof MUSIC_SKINS[number]["id"];

interface PixelPalette {
  primary: string;
  secondary: string;
  context: string;
  muted: string;
  progressTrack: string;
}

// The background is always #000000: on the LED matrix black means the LED is
// switched off, so skins only define the lit-pixel tiers.
const PALETTES: Record<MusicSkin, PixelPalette> = {
  signal: {
    primary: "#c1ff3d",
    secondary: "#6ca34e",
    context: "#47733d",
    muted: "#284b2c",
    progressTrack: "#18311e",
  },
  tape: {
    primary: "#ffb341",
    secondary: "#f0782a",
    context: "#a75522",
    muted: "#73401e",
    progressTrack: "#482710",
  },
  blueprint: {
    primary: "#d6f4ff",
    secondary: "#55b7e8",
    context: "#347ba8",
    muted: "#1e527a",
    progressTrack: "#123454",
  },
  arcade: {
    primary: "#fff0cf",
    secondary: "#ff4c58",
    context: "#b33a43",
    muted: "#7b2930",
    progressTrack: "#4b171d",
  },
};

export function isMusicSkin(value: string | null): value is MusicSkin {
  return MUSIC_SKINS.some((skin) => skin.id === value);
}

// The skin's default primary (used as the accent color picker's starting value).
export function skinPrimaryHex(skin: MusicSkin): string {
  return PALETTES[skin].primary;
}

const PIXEL_TEXT_HEIGHT = GLYPH_HEIGHT;
const PIXEL_TEXT_VIEWPORT_X = 2;
const PIXEL_TEXT_VIEWPORT_WIDTH = 48;
const PIXEL_TEXT_Y = 2;
// Scrolling steps by whole full-width cells, matching LyricsPage::scrollOffsetFor.
const PIXEL_GLYPH_CELL = FULL_WIDTH_CELL;
const LYRIC_SCROLL_START = 0.08;
const LYRIC_SCROLL_END = 0.92;
const BITMAP_CACHE_LIMIT = 256;

interface PixelGlyphSpan {
  start: number;
  end: number;
}

interface PixelTextBitmap {
  width: number;
  height: number;
  on: Uint8Array;
  focusSpans: PixelGlyphSpan[];
}

const bitmapCache = new Map<string, PixelTextBitmap>();

function normalizedCopy(value: string): string {
  const characters = Array.from(value.replace(/\s+/g, " ").trim() || "· · ·");
  return characters.slice(0, 160).join("");
}

/**
 * Lays a line out exactly as `LyricsPage::layoutRow` does on the panel: cells
 * butted together with no tracking, ASCII half-width, everything else
 * full-width, and characters outside the generated charset left blank rather
 * than substituted.
 */
function bitmapForText(value: string): PixelTextBitmap {
  const copy = normalizedCopy(value);
  const cached = bitmapCache.get(copy);
  if (cached) return cached;

  const cells = Array.from(copy).map((character) => {
    const codepoint = character.codePointAt(0)!;
    return { character, codepoint, cellWidth: glyphCellWidth(codepoint) };
  });
  const width = Math.max(
    FULL_WIDTH_CELL,
    cells.reduce((total, cell) => total + cell.cellWidth, 0),
  );

  const on = new Uint8Array(width * PIXEL_TEXT_HEIGHT);
  const focusSpans: PixelGlyphSpan[] = [];
  let cellX = 0;
  for (const cell of cells) {
    const rows = glyphRows(cell.codepoint);
    if (rows) {
      for (let row = 0; row < PIXEL_TEXT_HEIGHT; row += 1) {
        const mask = rows[row]!;
        for (let column = 0; column < cell.cellWidth; column += 1) {
          if ((mask >> (cell.cellWidth - 1 - column)) & 1) {
            on[row * width + cellX + column] = 1;
          }
        }
      }
    }
    if (cell.character.trim().length > 0) {
      focusSpans.push({ start: cellX, end: cellX + cell.cellWidth });
    }
    cellX += cell.cellWidth;
  }

  const bitmap = { width, height: PIXEL_TEXT_HEIGHT, on, focusSpans };
  if (bitmapCache.size >= BITMAP_CACHE_LIMIT) {
    const oldest = bitmapCache.keys().next().value;
    if (oldest) bitmapCache.delete(oldest);
  }
  bitmapCache.set(copy, bitmap);
  return bitmap;
}

function unit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(value: number): number {
  const progress = unit(value);
  return progress * progress * (3 - 2 * progress);
}

export function pixelTextWidth(text: string): number {
  return bitmapForText(text).width;
}

export function focusGlyphIndexForProgress(
  glyphCount: number,
  lyricProgress: number,
): number {
  if (glyphCount <= 0) return -1;
  return Math.min(glyphCount - 1, Math.floor(unit(lyricProgress) * glyphCount));
}

export function projectedLyricProgress(
  anchorProgress: number,
  elapsedMs: number,
  lyricDurationMs: number,
  playing: boolean,
): number {
  if (!playing || lyricDurationMs <= 0) return unit(anchorProgress);
  return unit(anchorProgress + Math.max(0, elapsedMs) / lyricDurationMs);
}

export function lyricScrollOffsetForProgress(
  textWidth: number,
  lyricProgress: number,
  reducedMotion = false,
): number {
  const alignedTextWidth = Math.ceil(
    Math.max(0, Math.round(textWidth)) / PIXEL_GLYPH_CELL,
  ) * PIXEL_GLYPH_CELL;
  const travel = Math.max(0, alignedTextWidth - PIXEL_TEXT_VIEWPORT_WIDTH);
  if (travel === 0) return 0;
  const travelProgress = smoothstep(
    (unit(lyricProgress) - LYRIC_SCROLL_START)
      / (LYRIC_SCROLL_END - LYRIC_SCROLL_START),
  );
  // Round to whole pixels before snapping so float noise cannot flip a
  // half-cell boundary; the device core snaps from integers the same way.
  const continuousOffset = Math.round(travel * travelProgress);
  const step = reducedMotion ? PIXEL_TEXT_VIEWPORT_WIDTH : PIXEL_GLYPH_CELL;
  const snappedOffset = Math.round(continuousOffset / step) * step;
  return Math.min(travel, snappedOffset);
}

export interface PixelLyricsFrameInput {
  skin: MusicSkin;
  accent?: string | null;
  mode: MusicMode;
  currentText: string;
  hasLyric: boolean;
  lyricProgress: number;
  trackProgress: number;
  playing: boolean;
  scrollOffsetPx: number;
  timeMs: number;
  spectrum?: SpectrumLookup;
  reducedMotion: boolean;
}

function lineStartX(bitmapWidth: number, offsetPx: number): number {
  return bitmapWidth <= PIXEL_TEXT_VIEWPORT_WIDTH
    ? Math.floor((52 - bitmapWidth) / 2)
    : PIXEL_TEXT_VIEWPORT_X - offsetPx;
}

function blitLine(
  context: CanvasRenderingContext2D,
  bitmap: PixelTextBitmap,
  screenX: number,
  screenY: number,
  viewportX: number,
  viewportWidth: number,
  colorAt: (bitmapX: number) => string | null,
): void {
  for (let bitmapY = 0; bitmapY < bitmap.height; bitmapY += 1) {
    const targetY = screenY + bitmapY;
    if (targetY < 0 || targetY > 15) continue;
    for (let bitmapX = 0; bitmapX < bitmap.width; bitmapX += 1) {
      if (bitmap.on[bitmapY * bitmap.width + bitmapX] !== 1) continue;
      const targetX = screenX + bitmapX;
      if (targetX < viewportX || targetX >= viewportX + viewportWidth) continue;
      const color = colorAt(bitmapX);
      if (!color) continue;
      context.fillStyle = color;
      context.fillRect(targetX, targetY, 1, 1);
    }
  }
}

function karaokeColorAt(
  palette: PixelPalette,
  focusSpan: PixelGlyphSpan | undefined,
): (bitmapX: number) => string {
  return (bitmapX) => !focusSpan || bitmapX < focusSpan.start
    ? palette.secondary
    : bitmapX < focusSpan.end
      ? palette.primary
      : palette.context;
}

function paintCueRow(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  y: number,
  progress: number,
  trailPx: number,
): void {
  const startX = PIXEL_TEXT_VIEWPORT_X;
  const travel = PIXEL_TEXT_VIEWPORT_WIDTH - 1;
  context.fillStyle = palette.progressTrack;
  for (const position of [0, 0.5, 1]) {
    context.fillRect(startX + Math.round(travel * position), y, 1, 1);
  }
  const cursorX = startX + Math.round(travel * unit(progress));
  context.fillStyle = palette.secondary;
  const trail = Math.min(trailPx, cursorX - startX);
  if (trail > 0) context.fillRect(cursorX - trail, y, trail, 1);
  context.fillStyle = palette.primary;
  context.fillRect(cursorX, y, 1, 1);
}

function paintTicker(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
): void {
  paintCueRow(context, palette, 0, input.lyricProgress, 2);
  paintCueRow(context, palette, 15, input.trackProgress, 1);

  const focusIndex = focusGlyphIndexForProgress(
    bitmap.focusSpans.length,
    input.lyricProgress,
  );
  const focusSpan = focusIndex >= 0 ? bitmap.focusSpans[focusIndex] : undefined;
  blitLine(
    context,
    bitmap,
    lineStartX(bitmap.width, input.scrollOffsetPx),
    PIXEL_TEXT_Y,
    PIXEL_TEXT_VIEWPORT_X,
    PIXEL_TEXT_VIEWPORT_WIDTH,
    karaokeColorAt(palette, focusSpan),
  );
}

function paintSkyline(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
): void {
  const showText = input.hasLyric || !input.playing;
  const maxLevel = showText ? 3 : 12;
  const animated = !input.reducedMotion;
  const kick = animated
    ? beatKick(
      input.playing,
      input.hasLyric,
      input.lyricProgress,
      bitmap.focusSpans.length,
      input.timeMs,
    )
    : 0;

  for (let bar = 0; bar < SKYLINE_BARS; bar += 1) {
    const x = 1 + bar * 3;
    const level = skylineBarLevel(
      bar,
      animated ? input.timeMs : 0,
      animated && input.playing,
      kick,
      maxLevel,
      input.spectrum?.(input.timeMs, bar),
    );
    context.fillStyle = palette.muted;
    context.fillRect(x, 15, 2, 1);
    if (level <= 0) continue;
    for (let step = 1; step <= level; step += 1) {
      context.fillStyle = level <= 1
        ? palette.muted
        : step === level && level === maxLevel
          ? palette.primary
          : palette.secondary;
      context.fillRect(x, 15 - (step - 1), 2, 1);
    }
  }

  if (!showText) return;
  const focusIndex = focusGlyphIndexForProgress(
    bitmap.focusSpans.length,
    input.lyricProgress,
  );
  const focusSpan = focusIndex >= 0 ? bitmap.focusSpans[focusIndex] : undefined;
  blitLine(
    context,
    bitmap,
    lineStartX(bitmap.width, input.scrollOffsetPx),
    0,
    PIXEL_TEXT_VIEWPORT_X,
    PIXEL_TEXT_VIEWPORT_WIDTH,
    karaokeColorAt(palette, focusSpan),
  );
}

function paintSpotlight(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
): void {
  context.fillStyle = palette.muted;
  context.fillRect(19, 1, 1, 1);
  context.fillRect(32, 1, 1, 1);
  paintCueRow(context, palette, 15, input.trackProgress, 1);

  const spans = bitmap.focusSpans;
  const focusPx = unit(input.lyricProgress) * bitmap.width;
  const focusIndex = spanIndexAtPx(spans, focusPx);
  blitLine(
    context,
    bitmap,
    input.scrollOffsetPx,
    PIXEL_TEXT_Y,
    0,
    52,
    (bitmapX) => {
      for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index]!;
        if (bitmapX < span.start || bitmapX >= span.end) continue;
        const distance = Math.abs(index - focusIndex);
        return distance === 0
          ? palette.primary
          : distance === 1
            ? palette.secondary
            : palette.context;
      }
      return palette.context;
    },
  );

  if (focusIndex < 0) return;
  const span = spans[focusIndex]!;
  const fraction = unit((focusPx - span.start) / Math.max(1, span.end - span.start));
  const barWidth = Math.round(fraction * PIXEL_GLYPH_CELL);
  if (barWidth > 0) {
    context.fillStyle = palette.secondary;
    context.fillRect(20, 14, barWidth, 1);
  }
}

function paintCascade(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
): void {
  const fill = Math.round(unit(input.trackProgress) * 16);
  for (let step = 0; step < fill; step += 1) {
    context.fillStyle = step === fill - 1 ? palette.primary : palette.muted;
    context.fillRect(51, 15 - step, 1, 1);
  }

  const phase = cascadePhase(input.lyricProgress, input.reducedMotion);
  const focusIndex = focusGlyphIndexForProgress(
    bitmap.focusSpans.length,
    input.lyricProgress,
  );
  const focusSpan = focusIndex >= 0 ? bitmap.focusSpans[focusIndex] : undefined;
  const colorAt = phase === "enter"
    ? () => palette.secondary
    : phase === "exit"
      ? () => palette.context
      : karaokeColorAt(palette, focusSpan);
  blitLine(
    context,
    bitmap,
    lineStartX(bitmap.width, input.scrollOffsetPx),
    cascadeBandY(input.lyricProgress, input.reducedMotion),
    PIXEL_TEXT_VIEWPORT_X,
    PIXEL_TEXT_VIEWPORT_WIDTH,
    colorAt,
  );
}

export function drawPixelLyricsFrame(
  context: CanvasRenderingContext2D,
  input: PixelLyricsFrameInput,
): void {
  const palette = input.accent && /^[0-9a-fA-F]{6}$/.test(input.accent)
    ? { ...PALETTES[input.skin], primary: `#${input.accent}` }
    : PALETTES[input.skin];
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, 52, 16);
  context.fillStyle = "#000000";
  context.fillRect(0, 0, 52, 16);

  // The spotlight glide runs negative once the line passes screen center,
  // so the offset is rounded but deliberately not clamped to zero here.
  const safeInput = {
    ...input,
    lyricProgress: unit(input.lyricProgress),
    trackProgress: unit(input.trackProgress),
    scrollOffsetPx: Math.round(input.scrollOffsetPx),
  };
  const bitmap = bitmapForText(safeInput.currentText);
  if (safeInput.mode === "skyline") paintSkyline(context, palette, bitmap, safeInput);
  else if (safeInput.mode === "spotlight") paintSpotlight(context, palette, bitmap, safeInput);
  else if (safeInput.mode === "cascade") paintCascade(context, palette, bitmap, safeInput);
  else paintTicker(context, palette, bitmap, safeInput);
}

interface PixelLyricsPreviewProps {
  currentText: string;
  hasLyric: boolean;
  lyricProgress: number;
  lyricDurationMs: number;
  trackProgress: number;
  timeMs: number;
  playing: boolean;
  skin: MusicSkin;
  accent: string | null;
  mode: MusicMode;
  spectrum?: SpectrumLookup;
}

export function PixelLyricsPreview({
  currentText,
  hasLyric,
  lyricProgress,
  lyricDurationMs,
  trackProgress,
  timeMs,
  playing,
  skin,
  accent,
  mode,
  spectrum,
}: PixelLyricsPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestFrameRef = useRef({
    currentText,
    hasLyric,
    lyricProgress,
    lyricDurationMs,
    trackProgress,
    timeMs,
    playing,
    skin,
    accent,
    mode,
    spectrum,
  });
  const lyricClockRef = useRef({
    currentText,
    lyricProgress,
    lyricDurationMs,
    receivedAt: 0,
  });
  const trackClockRef = useRef({ timeMs, receivedAt: 0 });
  latestFrameRef.current = {
    currentText,
    hasLyric,
    lyricProgress,
    lyricDurationMs,
    trackProgress,
    timeMs,
    playing,
    skin,
    accent,
    mode,
    spectrum,
  };

  useEffect(() => {
    lyricClockRef.current = {
      currentText,
      lyricProgress,
      lyricDurationMs,
      receivedAt: performance.now(),
    };
  }, [currentText, lyricDurationMs, lyricProgress]);

  useEffect(() => {
    trackClockRef.current = { timeMs, receivedAt: performance.now() };
  }, [timeMs]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    let animationFrame = 0;
    let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let lastSignature = "";
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      lastSignature = "";
    };
    motionPreference.addEventListener("change", handleMotionPreference);

    const render = (now: number) => {
      const frame = latestFrameRef.current;
      const lyricClock = lyricClockRef.current;
      const trackClock = trackClockRef.current;
      const smoothTimeMs = Math.max(
        0,
        trackClock.timeMs + (frame.playing ? now - trackClock.receivedAt : 0),
      );
      const smoothLyricProgress = lyricClock.currentText === frame.currentText
        ? projectedLyricProgress(
          lyricClock.lyricProgress,
          now - lyricClock.receivedAt,
          lyricClock.lyricDurationMs,
          frame.playing,
        )
        : unit(frame.lyricProgress);
      const bitmap = bitmapForText(frame.currentText);
      const scrollOffsetPx = frame.mode === "spotlight"
        ? reducedMotion
          ? 26 - Math.round(
            unit(smoothLyricProgress) * bitmap.width / PIXEL_GLYPH_CELL,
          ) * PIXEL_GLYPH_CELL
          : spotlightOffsetPx(bitmap.width, smoothLyricProgress)
        : lyricScrollOffsetForProgress(bitmap.width, smoothLyricProgress, reducedMotion);
      const signature = [
        frame.currentText,
        frame.skin,
        frame.accent ?? "-",
        frame.mode,
        frame.hasLyric,
        frame.playing,
        scrollOffsetPx,
        focusGlyphIndexForProgress(bitmap.focusSpans.length, smoothLyricProgress),
        Math.round(smoothLyricProgress * 47),
        Math.round(frame.trackProgress * 52),
        frame.mode === "skyline" && !reducedMotion ? Math.floor(smoothTimeMs / 125) : 0,
        frame.mode === "skyline" && frame.spectrum && !reducedMotion
          ? Math.floor(smoothTimeMs / SPECTRUM_HOP_MS)
          : 0,
        frame.mode === "cascade" ? cascadeBandY(smoothLyricProgress, reducedMotion) : 0,
      ].join(":");
      if (signature !== lastSignature) {
        drawPixelLyricsFrame(context, {
          skin: frame.skin,
          accent: frame.accent,
          mode: frame.mode,
          currentText: frame.currentText,
          hasLyric: frame.hasLyric,
          lyricProgress: smoothLyricProgress,
          trackProgress: frame.trackProgress,
          playing: frame.playing,
          scrollOffsetPx,
          timeMs: smoothTimeMs,
          spectrum: frame.spectrum,
          reducedMotion,
        });
        lastSignature = signature;
      }
      animationFrame = window.requestAnimationFrame(render);
    };

    animationFrame = window.requestAnimationFrame(render);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      motionPreference.removeEventListener("change", handleMotionPreference);
    };
  }, [currentText, mode, skin, spectrum]);

  return (
    <figure className={`pixel-lyric-screen${playing ? " is-playing" : ""}`}>
      <div className="pixel-lyric-screen__frame">
        <canvas
          ref={canvasRef}
          width={52}
          height={16}
          role="img"
          aria-label={`52 × 16 像素歌词预览：${currentText}`}
        >
          52 × 16 像素歌词预览：{currentText}
        </canvas>
      </div>
      <figcaption>
        <span>屏幕 52 × 16 · 字模 12 × 12</span>
        <span>{musicModeNote(mode)}</span>
      </figcaption>
    </figure>
  );
}

interface MusicThemePanelProps {
  mode: MusicMode;
  skin: MusicSkin;
  accent: string | null;
  onModeChange: (mode: MusicMode) => void;
  onSkinChange: (skin: MusicSkin) => void;
  onAccentChange: (accent: string | null) => void;
  syncsToDevice: boolean;
  simulatedSpectrum: boolean;
}

const MODE_ICON: Record<MusicMode, typeof MoveHorizontal> = {
  ticker: MoveHorizontal,
  skyline: AudioLines,
  spotlight: Radar,
  cascade: Rows3,
};

// One consolidated theme card — display form + palette + accent in a single
// panel, built from cladd toggle groups. Selection accents stay per-button
// (activeColor), so choosing a skin never bleeds into the page chrome.
export function MusicThemePanel({
  mode,
  skin,
  accent,
  onModeChange,
  onSkinChange,
  onAccentChange,
  syncsToDevice,
  simulatedSpectrum,
}: MusicThemePanelProps) {
  const accentValue = accent ? `#${accent}` : skinPrimaryHex(skin);
  return (
    <section className="music-theme-panel">
      <header className="music-theme-panel__head">
        <strong>主题设置</strong>
        <Chip
          size="sm"
          color={syncsToDevice ? "brand" : "neutral"}
          variant="transparent"
          icon={syncsToDevice ? Radio : Monitor}
          iconProps={{ "aria-hidden": true }}
          aria-live="polite"
        >
          {syncsToDevice ? "实时同步到设备" : "仅影响预览"}
        </Chip>
      </header>

      <div className="music-theme-panel__groups">
        <div className="music-theme-panel__group">
          <span className="music-theme-panel__label" id="music-theme-mode-label">显示形式</span>
          <ToggleGroup
            className="music-theme-options"
            value={mode}
            size="lg"
            rounded={false}
            variant="transparent"
            outline
            activeVariant="gradient"
            activeOutline
            role="group"
            aria-labelledby="music-theme-mode-label"
            onValueChange={(nextValue) => {
              if (typeof nextValue === "string" && isMusicMode(nextValue)) onModeChange(nextValue);
            }}
          >
            {MUSIC_MODES.map((item) => {
              const Icon = MODE_ICON[item.id];
              return (
                <ToggleButton
                  key={item.id}
                  value={item.id}
                  className="music-theme-option"
                  contentClassName="music-theme-option__content"
                  activeColor="lime"
                  aria-label={item.name + "，" + item.note}
                >
                  <Icon aria-hidden="true" />
                  <span className="music-theme-option__text">
                    <strong>{item.name}</strong>
                    <small>{item.note}</small>
                  </span>
                  {mode === item.id && <Check className="music-theme-option__check" aria-hidden="true" />}
                </ToggleButton>
              );
            })}
          </ToggleGroup>
        </div>

        <div className="music-theme-panel__group">
          <span className="music-theme-panel__label" id="music-theme-skin-label">像素配色</span>
          <ToggleGroup
            className="music-theme-options"
            value={skin}
            size="lg"
            rounded={false}
            variant="transparent"
            outline
            activeVariant="gradient"
            activeOutline
            role="group"
            aria-labelledby="music-theme-skin-label"
            onValueChange={(nextValue) => {
              if (typeof nextValue === "string" && isMusicSkin(nextValue)) onSkinChange(nextValue);
            }}
          >
            {MUSIC_SKINS.map((item) => {
              const pal = PALETTES[item.id];
              return (
                <ToggleButton
                  key={item.id}
                  value={item.id}
                  className="music-theme-option"
                  contentClassName="music-theme-option__content"
                  activeColor={item.color}
                  aria-label={item.name + "，" + item.note}
                >
                  <span className="music-theme-swatch" aria-hidden="true">
                    <i style={{ background: pal.primary }} />
                    <i style={{ background: pal.secondary }} />
                    <i style={{ background: pal.context }} />
                  </span>
                  <span className="music-theme-option__text">
                    <strong>{item.name}</strong>
                    <small>{item.note}</small>
                  </span>
                  {skin === item.id && <Check className="music-theme-option__check" aria-hidden="true" />}
                </ToggleButton>
              );
            })}
          </ToggleGroup>
        </div>
      </div>

      <div className="music-theme-panel__accent">
        <span className="music-theme-panel__label">主色微调</span>
        <ColorPicker
          className="music-theme-accent-picker"
          size="sm"
          alpha={false}
          inputs={false}
          debounce={200}
          swatches={MUSIC_SKINS.map((item) => PALETTES[item.id].primary)}
          value={accentValue}
          popoverPosition="top-start"
          aria-label="自定义歌词主色"
          onChange={(value) => onAccentChange(value.hex.replace(/^#/, "").slice(0, 6).toLowerCase())}
        >
          {accent ? `#${accent}` : "跟随配色"}
        </ColorPicker>
        <Button
          type="button"
          size="sm"
          variant="transparent"
          outline={false}
          tightFocusRing
          disabled={!accent}
          onClick={() => onAccentChange(null)}
        >
          还原预设
        </Button>
      </div>
      {simulatedSpectrum && (
        <p className="music-theme-panel__spectrum-note">此音源为模拟律动</p>
      )}
    </section>
  );
}
