import { Button, Chip, ColorPicker, Switch, ToggleButton, ToggleGroup } from "@cladd-ui/react";
import { AudioLines, Check, Monitor, MoveHorizontal, Quote, Radar, Radio, Rows3, Target } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  lyricCursorAt,
  lyricWindowProgress,
  type LyricCell,
  type LyricCursor,
} from "@/lib/lyric-cursor";
import { FULL_WIDTH_CELL, GLYPH_HEIGHT, glyphCellWidth, glyphRows } from "@/lib/pixel-glyphs";
import { SPECTRUM_HOP_MS, type SpectrumLookup } from "@/lib/spectrum-timeline";
import {
  beatKick,
  cascadeBandY,
  cascadePhase,
  haloRadius,
  haloTier,
  INTERLUDE_BREATH_MS,
  INTERLUDE_DOT_X,
  INTERLUDE_DOT_Y,
  interludeDotTier,
  interludeProgress,
  isMusicMode,
  MUSIC_MODES,
  musicModeNote,
  ringsHopPx,
  SKYLINE_BARS,
  SPARK_COUNT,
  SPARK_COUNT_LAST,
  sparkPixels,
  sparkTier,
  tiltLeanOffset,
  tiltLeanUnit,
  tiltStage,
  tiltUnits,
  skylineBarLevel,
  spotlightOffsetForFocusPx,
  type MusicMode,
} from "./pixel-lyric-modes";

export const MUSIC_SKINS = [
  { id: "signal", name: "信号绿", note: "终端荧光" },
  { id: "tape", name: "磁带橙", note: "暖色录音" },
  { id: "blueprint", name: "蓝晒", note: "冷蓝电台" },
  { id: "arcade", name: "街机红", note: "红白像素" },
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
  /** False for a whitespace cell: it holds an index but can never be focused. */
  lit: boolean;
}

interface PixelTextBitmap {
  width: number;
  height: number;
  on: Uint8Array;
  /**
   * ONE SPAN PER CODEPOINT, whitespace included.
   *
   * It used to skip spaces, which made the browser's glyph index disagree with
   * both firmwares' (`layoutRow` counts every cell). That was a cosmetic
   * mismatch until the wire started carrying a per-cell timing table indexed by
   * exactly this number — now a skipped space lights the wrong character.
   */
  cells: PixelGlyphSpan[];
}

const bitmapCache = new Map<string, PixelTextBitmap>();

function normalizedCopy(value: string): string {
  // Collapses only the record separators, exactly as `sanitizeField` does on
  // the service before the label goes on the wire. Collapsing all whitespace
  // (the old `\s+`) made a line like "伸出手  搭便车" 84 px wide here and 96 px
  // on the panel, which moved the spotlight offset by half a cell — and now
  // would also shift every cell index in the timing table.
  const characters = Array.from(value.replace(/[\t\r\n]+/g, " ").trim() || "· · ·");
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
  const spans: PixelGlyphSpan[] = [];
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
    spans.push({
      start: cellX,
      end: cellX + cell.cellWidth,
      lit: cell.character.trim().length > 0,
    });
    cellX += cell.cellWidth;
  }

  const bitmap = { width, height: PIXEL_TEXT_HEIGHT, on, cells: spans };
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

/**
 * The pre-cursor formula: spread the line's window evenly over its glyphs.
 *
 * No longer used to paint anything — kept as the REFERENCE the untimed cursor
 * path is held to. A line with no word timings has to keep behaving exactly as
 * it did (that is the whole Spotify catalogue), and the cheapest way to keep
 * that true is to leave the old arithmetic here and assert the new code against
 * it. Its answers are wrong for a word-timed line by whole glyphs, which is the
 * point.
 */
export function focusGlyphIndexForProgress(
  glyphCount: number,
  lyricProgress: number,
): number {
  if (glyphCount <= 0) return -1;
  return Math.min(glyphCount - 1, Math.floor(unit(lyricProgress) * glyphCount));
}

/**
 * Where the playhead is between two React renders.
 *
 * This used to advance a *progress* by `elapsed / lineDuration`, which meant the
 * smoothing inherited whatever the line duration claimed — including the
 * inflated one that gave a 5-second line an 18-second window. Extrapolating the
 * playhead instead keeps the smoothing honest: the cursor decides what that
 * time means.
 */
export function projectedPlayheadMs(
  anchorMs: number,
  elapsedMs: number,
  playing: boolean,
): number {
  if (!playing) return anchorMs;
  return anchorMs + Math.max(0, elapsedMs);
}

/**
 * The bitmap pixel the cursor is on: the start of its cell plus however far
 * into the cell it has travelled. `progress * bitmapWidth` cannot answer this
 * once time is unevenly distributed across the row.
 */
export function focusPixelAt(cells: readonly PixelGlyphSpan[], cursor: LyricCursor): number {
  if (cells.length === 0) return 0;
  const index = Math.min(cells.length - 1, Math.max(0, cursor.index));
  const cell = cells[index]!;
  if (cursor.index < 0) return cell.start;
  return cell.start + unit(cursor.frac) * (cell.end - cell.start);
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

/**
 * Where the row sits on the panel for this cursor, for every mode.
 *
 * Shared rather than duplicated because the preview canvas and the mirrored GIF
 * have to agree pixel for pixel — they are the same picture, one drawn live and
 * one shipped to the clock — and the spotlight offset in particular can no
 * longer be recovered from a scalar progress.
 */
export function pixelLyricScrollOffset(
  text: string,
  cursor: LyricCursor,
  mode: MusicMode,
  reducedMotion = false,
): number {
  const bitmap = bitmapForText(text);
  if (mode !== "spotlight") {
    return lyricScrollOffsetForProgress(bitmap.width, cursor.progress, reducedMotion);
  }
  const focusPx = focusPixelAt(bitmap.cells, cursor);
  // Reduced motion snaps the glide to whole glyph cells so the row steps
  // instead of gliding, but it locks onto the same column.
  if (reducedMotion) {
    return 26 - Math.round(focusPx / PIXEL_GLYPH_CELL) * PIXEL_GLYPH_CELL;
  }
  return spotlightOffsetForFocusPx(focusPx);
}

/**
 * The line the panel is currently showing, in track time.
 *
 * `endMs` and `untilMs` answer two different questions and the gap between them
 * is the whole subject of this change: the first is when the singer stopped,
 * the second is when the next line takes over. They coincide on a line followed
 * immediately by another and diverge by ten or more seconds on the last line of
 * a verse.
 */
export interface PixelLyricLine {
  startMs: number;
  endMs: number;
  untilMs: number;
  /** One entry per codepoint of the text, when the source carries word timings. */
  cells?: readonly LyricCell[] | undefined;
  /** The line belongs to the chorus; every mode then ripples the glyph being sung. */
  chorus?: boolean | undefined;
}

/**
 * The row at rest: nothing sung, the cursor parked on the first glyph.
 *
 * What the panel shows while it is displaying the track title — a song's intro
 * before its first line, or a track with no lyrics at all. `phase` is not
 * "pending" because pending means "the line has not started" and is defined at
 * index -1, which paints the row in the sung colour with no focus glyph; a
 * title has not been sung at all. This is byte-for-byte what a lyric progress
 * of exactly 0 used to produce.
 */
const IDLE_CURSOR: LyricCursor = { index: 0, frac: 0, progress: 0, phase: "singing" };

/** True when the line carries a real window, i.e. something is actually timed. */
function hasLyricWindow(line: PixelLyricLine): boolean {
  return line.endMs > line.startMs || line.untilMs > line.startMs;
}

/**
 * The cursor and the window progress for a line, at a playhead position.
 *
 * A line with no window is answered with the idle cursor rather than by
 * synthesising a window for it, and both failure modes of synthesising one are
 * why. A zero-length window reads as "already over": a long title scrolls to
 * its last glyph and parks there. An enormous one reads as "just barely
 * started", which is worse — the window progress is then tiny but strictly
 * positive, so cascade's entrance ramp rounds the band to y = 16 and blits all
 * twelve rows off the bottom of a sixteen-row panel, blanking the preview for
 * every intro and for the whole of any track without lyrics.
 */
export function pixelLyricCursor(
  text: string,
  line: PixelLyricLine,
  playheadMs: number,
): { cursor: LyricCursor; windowProgress: number; interlude: number; sinceLineMs: number } {
  if (!hasLyricWindow(line)) {
    return { cursor: IDLE_CURSOR, windowProgress: 0, interlude: -1, sinceLineMs: Number.POSITIVE_INFINITY };
  }
  const cellCount = bitmapForText(text).cells.length;
  return {
    cursor: lyricCursorAt({ ...line, cellCount }, playheadMs),
    windowProgress: lyricWindowProgress(line, playheadMs),
    interlude: interludeProgress(line.endMs, line.untilMs, playheadMs),
    sinceLineMs: playheadMs - line.startMs,
  };
}

export interface PixelLyricsFrameInput {
  skin: MusicSkin;
  accent?: string | null;
  mode: MusicMode;
  currentText: string;
  hasLyric: boolean;
  /**
   * Which glyph is being sung and how far into it. Everything the eye reads as
   * "the highlight" comes from here: the coloured prefix, the focus cell, the
   * spotlight lock, the scroll, the beat.
   */
  cursor: LyricCursor;
  /**
   * How far through the line's DISPLAY window the playhead is — which is later
   * than `cursor.progress` whenever an instrumental follows the line.
   *
   * Only the cascade choreography reads it. Flying the line out on the sung
   * progress would clear the panel the instant the singer stops and leave it
   * blank for the whole 13-second break. (A break that long now shows the
   * interlude dots instead — see `interlude` below — but a shorter hold still
   * keeps the line up.)
   */
  windowProgress: number;
  trackProgress: number;
  playing: boolean;
  scrollOffsetPx: number;
  timeMs: number;
  spectrum?: SpectrumLookup;
  reducedMotion: boolean;
  /**
   * How far through the instrumental after this line, 0..1, or -1 (the
   * default) while the line owns the panel. See `interludeProgress`.
   */
  interlude?: number;
  /** The line belongs to the chorus: every mode ripples the glyph being sung. */
  chorus?: boolean;
  /**
   * The line's start in track ms, seeding which 倾诉 phrase leans and where each
   * spark flies, and how far into the line the playhead is (倾诉's glyphs
   * surface one by one from it). Absent: no lean, every glyph already shown.
   */
  lineStartMs?: number;
  sinceLineMs?: number;
  /** 火花: each glyph throws sparks as it is sung. */
  sparks?: boolean;
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

/**
 * The karaoke wipe: sung glyphs behind the cursor, the focus glyph lit, the
 * rest waiting.
 *
 * `held` paints the WHOLE line in the sung colour with no focus glyph. That is
 * what the panel shows between the last word of a line and the next one — the
 * line stays up, complete and finished, instead of one character glowing or the
 * row going dark — until the gap is long enough to be an instrumental, when the
 * interlude dots take the row (`interludeProgress`).
 */
function karaokeColorAt(
  palette: PixelPalette,
  focusSpan: PixelGlyphSpan | undefined,
  held: boolean,
): (bitmapX: number) => string {
  if (held) return () => palette.secondary;
  return (bitmapX) => !focusSpan || bitmapX < focusSpan.start
    ? palette.secondary
    : bitmapX < focusSpan.end
      ? palette.primary
      : palette.context;
}

/** The cell the cursor is on, or undefined before the line starts. */
function focusSpanOf(bitmap: PixelTextBitmap, cursor: LyricCursor): PixelGlyphSpan | undefined {
  if (cursor.index < 0 || cursor.index >= bitmap.cells.length) return undefined;
  return bitmap.cells[cursor.index];
}

/** The glyph actually being sung, or -1 before the line, after it, or on a space. */
function singingIndex(bitmap: PixelTextBitmap, cursor: LyricCursor): number {
  if (cursor.phase !== "singing") return -1;
  const cell = bitmap.cells[cursor.index];
  return cell?.lit ? cursor.index : -1;
}

/** True when a glyph other than `focusIndex` has ink within one pixel of (x, y). */
function neighbourInkNear(
  bitmap: PixelTextBitmap,
  focusIndex: number,
  lineX: number,
  lineY: number,
  x: number,
  y: number,
): boolean {
  // Only the two neighbours can reach: the ring goes at most two columns past
  // its own cell and the gutter one more, and the narrowest cell is six wide.
  for (const index of [focusIndex - 1, focusIndex + 1]) {
    const span = bitmap.cells[index];
    if (!span) continue;
    for (let dy = -1; dy <= 1; dy += 1) {
      const row = y + dy - lineY;
      if (row < 0 || row >= bitmap.height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const column = x + dx - lineX;
        if (column < span.start || column >= span.end) continue;
        if (bitmap.on[row * bitmap.width + column] === 1) return true;
      }
    }
  }
  return false;
}

/**
 * One ring around the glyph being sung: every pixel at exactly `radius`
 * (Chebyshev) from its ink, drawn before the row so text and cues land on top.
 *
 * The glyph's own cell stays clear — a ring in its counters reads as a bolder
 * glyph, not as light leaving it — and so does a one-pixel gutter around every
 * other glyph's strokes, so the ring can run down the gaps between characters
 * without fattening a neighbour. On a full line that gap and the rows above and
 * below are all the room there is; anything less and the ring was invisible.
 *
 * Mirrored by `paintHalo` in ZOS's ui/MusicScreen.cpp, pixel for pixel.
 */
function paintHalo(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  focusIndex: number,
  lineX: number,
  lineY: number,
  hopPx: number,
  radius: number,
): void {
  const span = bitmap.cells[focusIndex];
  if (!span) return;
  const glyphY = lineY - hopPx;
  const ink: number[] = [];
  for (let row = 0; row < bitmap.height; row += 1) {
    for (let column = span.start; column < span.end; column += 1) {
      if (bitmap.on[row * bitmap.width + column] === 1) ink.push(lineX + column, glyphY + row);
    }
  }
  if (ink.length === 0) return;
  const glyphLeft = lineX + span.start;
  const glyphRight = lineX + span.end;
  context.fillStyle = palette[haloTier(radius)];
  for (let y = glyphY - radius; y < glyphY + bitmap.height + radius; y += 1) {
    if (y < 0 || y > 15) continue;
    for (let x = glyphLeft - radius; x < glyphRight + radius; x += 1) {
      if (x < 0 || x > 51) continue;
      if (y >= glyphY && y < glyphY + bitmap.height && x >= glyphLeft && x < glyphRight) continue;
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < ink.length && distance >= radius; index += 2) {
        distance = Math.min(distance, Math.max(Math.abs(x - ink[index]!), Math.abs(y - ink[index + 1]!)));
      }
      if (distance !== radius) continue;
      if (neighbourInkNear(bitmap, focusIndex, lineX, lineY, x, y)) continue;
      context.fillRect(x, y, 1, 1);
    }
  }
}

/** The chorus ripple the four classic modes share: no lift, row where the mode put it. */
function paintChorusHalo(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
  lineX: number,
  lineY: number,
): void {
  if (!input.chorus) return;
  const focus = singingIndex(bitmap, input.cursor);
  if (focus < 0) return;
  paintHalo(context, palette, bitmap, focus, lineX, lineY, 0, haloRadius(input.cursor.frac));
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
  paintChorusHalo(context, palette, bitmap, input, lineStartX(bitmap.width, input.scrollOffsetPx), PIXEL_TEXT_Y);
  paintCueRow(context, palette, 0, input.cursor.progress, 2);
  paintCueRow(context, palette, 15, input.trackProgress, 1);

  blitLine(
    context,
    bitmap,
    lineStartX(bitmap.width, input.scrollOffsetPx),
    PIXEL_TEXT_Y,
    PIXEL_TEXT_VIEWPORT_X,
    PIXEL_TEXT_VIEWPORT_WIDTH,
    karaokeColorAt(palette, focusSpanOf(bitmap, input.cursor), input.cursor.phase === "held"),
  );
}

function paintSkyline(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
): void {
  // Three levels, always: a floor on rows 13..15, row 12 the gutter, the line on
  // 0..11. This used to be `hasLyric || !playing ? 3 : 12` — a track without
  // lyrics turned the whole panel into a visualizer and dropped the row. Neither
  // firmware can reach that state (the sideloaded player only paints once a
  // timed line exists, and ZOS always has a row: the lyric, or the title/artist
  // rotation, or 播放中 / 已暂停), so the preview was the only one of the three
  // that showed it — and what it showed was the user's own complaint, 频谱挡字,
  // with the words gone entirely rather than merely covered.
  const maxLevel = 3;
  paintChorusHalo(context, palette, bitmap, input, lineStartX(bitmap.width, input.scrollOffsetPx), 0);
  const animated = !input.reducedMotion;
  const kick = animated
    ? beatKick(input.playing, input.hasLyric, input.cursor.frac, input.timeMs)
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

  blitLine(
    context,
    bitmap,
    lineStartX(bitmap.width, input.scrollOffsetPx),
    0,
    PIXEL_TEXT_VIEWPORT_X,
    PIXEL_TEXT_VIEWPORT_WIDTH,
    karaokeColorAt(palette, focusSpanOf(bitmap, input.cursor), input.cursor.phase === "held"),
  );
}

function paintSpotlight(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
): void {
  paintChorusHalo(context, palette, bitmap, input, input.scrollOffsetPx, PIXEL_TEXT_Y);
  context.fillStyle = palette.muted;
  context.fillRect(19, 1, 1, 1);
  context.fillRect(32, 1, 1, 1);
  paintCueRow(context, palette, 15, input.trackProgress, 1);

  const spans = bitmap.cells;
  const held = input.cursor.phase === "held";
  // The focus comes from the cursor, not from a pixel position derived from a
  // scalar progress: with word timings the two disagree by whole glyphs.
  const focusIndex = held ? -1 : Math.min(spans.length - 1, input.cursor.index);
  blitLine(
    context,
    bitmap,
    input.scrollOffsetPx,
    PIXEL_TEXT_Y,
    0,
    52,
    (bitmapX) => {
      if (held) return palette.secondary;
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

  // A finished line has no glyph in progress, so it gets no fill bar either.
  if (held || focusIndex < 0) return;
  const barWidth = Math.round(unit(input.cursor.frac) * PIXEL_GLYPH_CELL);
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
  // Only while the line holds still: a ring left behind by a row in flight
  // would mark where the row was, not where the singer is. Before the track
  // fill, so a ring off a right-edge glyph never punches a hole in column 51.
  if (cascadePhase(input.windowProgress, input.reducedMotion) === "hold") {
    paintChorusHalo(context, palette, bitmap, input, lineStartX(bitmap.width, input.scrollOffsetPx), cascadeBandY(input.windowProgress, input.reducedMotion));
  }
  const fill = Math.round(unit(input.trackProgress) * 16);
  for (let step = 0; step < fill; step += 1) {
    context.fillStyle = step === fill - 1 ? palette.primary : palette.muted;
    context.fillRect(51, 15 - step, 1, 1);
  }

  // The choreography rides the DISPLAY window, the colour rides the singing.
  //
  // These were one number until the sung end became real. Keyed on the sung
  // progress, the exit ramp starts at 0.86 of the SINGING — so the line of a
  // verse would fly off the panel the instant the voice stopped and leave the
  // screen blank for the whole thirteen-second instrumental that follows. The
  // line has to stay up until its successor is due, which is what the window
  // means, while the karaoke wipe finishes when the singer does. A break of 3 s
  // or more is the exception: drawPixelLyricsFrame hands the row to the
  // interlude dots before this painter runs (`interludeProgress`).
  const phase = cascadePhase(input.windowProgress, input.reducedMotion);
  const colorAt = phase === "enter"
    ? () => palette.secondary
    : phase === "exit"
      ? () => palette.context
      : karaokeColorAt(palette, focusSpanOf(bitmap, input.cursor), input.cursor.phase === "held");
  blitLine(
    context,
    bitmap,
    lineStartX(bitmap.width, input.scrollOffsetPx),
    cascadeBandY(input.windowProgress, input.reducedMotion),
    PIXEL_TEXT_VIEWPORT_X,
    PIXEL_TEXT_VIEWPORT_WIDTH,
    colorAt,
  );
}

/**
 * 年轮: the karaoke row of 走带, with each glyph lifting a pixel as it is sung
 * and throwing a ring outward (folia's 52Hz, on a 52 × 16 grid). No cue rows at
 * all: rows 0–1 and 14–15 are where the ring has room on a full line, and a cue
 * drawn over them hid most of it.
 */
function paintRings(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
): void {
  const lineX = lineStartX(bitmap.width, input.scrollOffsetPx);
  const focus = singingIndex(bitmap, input.cursor);
  const hop = focus >= 0 ? ringsHopPx(input.cursor.frac) : 0;
  if (focus >= 0) {
    paintHalo(context, palette, bitmap, focus, lineX, PIXEL_TEXT_Y, hop, haloRadius(input.cursor.frac));
  }
  const colorAt = karaokeColorAt(palette, focusSpanOf(bitmap, input.cursor), input.cursor.phase === "held");
  const span = focus >= 0 ? bitmap.cells[focus] : undefined;
  const inFocus = (bitmapX: number) => span !== undefined && bitmapX >= span.start && bitmapX < span.end;
  blitLine(context, bitmap, lineX, PIXEL_TEXT_Y, PIXEL_TEXT_VIEWPORT_X, PIXEL_TEXT_VIEWPORT_WIDTH,
    (bitmapX) => (inFocus(bitmapX) ? null : colorAt(bitmapX)));
  if (span) {
    blitLine(context, bitmap, lineX, PIXEL_TEXT_Y - hop, PIXEL_TEXT_VIEWPORT_X, PIXEL_TEXT_VIEWPORT_WIDTH,
      (bitmapX) => (inFocus(bitmapX) ? colorAt(bitmapX) : null));
  }
}

/**
 * 倾诉 (mygo/folia's tilt, on one 16-row line): the glyphs surface one after
 * another from just below the row, the one being sung lifts a pixel, and one
 * phrase — chosen per line, the same on every replay — is set in the focus
 * colour with its glyphs up and down by turns. The track cue sits under it on
 * row 15.
 */
function paintTilt(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
): void {
  paintCueRow(context, palette, 15, input.trackProgress, 1);
  const lineX = lineStartX(bitmap.width, input.scrollOffsetPx);
  const since = input.hasLyric ? (input.sinceLineMs ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const codepoints = Array.from(normalizedCopy(input.currentText)).map((c) => c.codePointAt(0)!);
  const units = tiltUnits(codepoints);
  const lean = input.hasLyric && input.lineStartMs !== undefined
    ? tiltLeanUnit(input.lineStartMs, units.length)
    : -1;
  const [leanFrom, leanTo] = lean >= 0 ? units[lean]! : [-1, -1];
  const focus = singingIndex(bitmap, input.cursor);
  const hop = focus >= 0 ? ringsHopPx(input.cursor.frac) : 0;
  const colorAt = karaokeColorAt(palette, focusSpanOf(bitmap, input.cursor), input.cursor.phase === "held");
  bitmap.cells.forEach((span, index) => {
    const stage = tiltStage(index, since);
    if (stage === 0) return;
    const leaning = index >= leanFrom && index < leanTo;
    let y = PIXEL_TEXT_Y;
    if (leaning) y += tiltLeanOffset(index - leanFrom, stage);
    else if (stage === 1) y += 1;
    if (index === focus) y -= hop;
    blitLine(context, bitmap, lineX, y, PIXEL_TEXT_VIEWPORT_X, PIXEL_TEXT_VIEWPORT_WIDTH, (bitmapX) => {
      if (bitmapX < span.start || bitmapX >= span.end) return null;
      if (stage === 1) return palette.muted;
      return leaning ? palette.primary : colorAt(bitmapX);
    });
  });
}

const DIMMER: Record<"primary" | "secondary" | "context", "secondary" | "context" | "muted"> = {
  primary: "secondary",
  secondary: "context",
  context: "muted",
};

/**
 * 火花: sparks off the glyph being sung, drawn first so everything the mode
 * paints lands on top of them. Where the glyph sits is the mode's own row —
 * skyline's row 0, cascade's band, spotlight's lock — without the pixel a lift
 * or a lean adds, which no spark this size can show. Mirrored by `paintSparks`
 * in ZOS's ui/MusicScreen.cpp.
 */
function paintSparks(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  bitmap: PixelTextBitmap,
  input: PixelLyricsFrameInput,
): void {
  if (!input.sparks || !input.hasLyric || input.lineStartMs === undefined) return;
  const focus = singingIndex(bitmap, input.cursor);
  if (focus < 0) return;
  let lineY = PIXEL_TEXT_Y;
  if (input.mode === "skyline") lineY = 0;
  if (input.mode === "cascade") {
    if (cascadePhase(input.windowProgress, input.reducedMotion) !== "hold") return;
    lineY = cascadeBandY(input.windowProgress, input.reducedMotion);
  }
  const lineX = input.mode === "spotlight" ? input.scrollOffsetPx : lineStartX(bitmap.width, input.scrollOffsetPx);
  const span = bitmap.cells[focus]!;
  const hw = (span.end - span.start) / 2;
  const cx = lineX + span.start + hw - 0.5;
  const cy = lineY + bitmap.height / 2 - 0.5;
  const last = focus === bitmap.cells.length - 1;
  const count = last ? SPARK_COUNT_LAST : SPARK_COUNT;
  const seed = (input.lineStartMs + focus * 7919) >>> 0;
  const t = input.cursor.frac;
  if (t >= 1) return;
  const tier = sparkTier(t);
  for (let spark = 0; spark < count; spark += 1) {
    const { head, tail } = sparkPixels(cx, cy, hw, bitmap.height / 2, seed, spark, count, last, t);
    context.fillStyle = palette[DIMMER[tier]];
    if (tail[0] >= 0 && tail[0] < 52 && tail[1] >= 0 && tail[1] < 16) context.fillRect(tail[0], tail[1], 1, 1);
    context.fillStyle = palette[tier];
    if (head[0] >= 0 && head[0] < 52 && head[1] >= 0 && head[1] < 16) context.fillRect(head[0], head[1], 1, 1);
  }
}

/**
 * The instrumental after a line, the same in every mode: three dots filling as
 * the next line nears, and the track cue on row 15. Mirrored by
 * `paintInterlude` in ZOS's ui/MusicScreen.cpp.
 */
function paintInterlude(
  context: CanvasRenderingContext2D,
  palette: PixelPalette,
  progress: number,
  input: PixelLyricsFrameInput,
): void {
  paintCueRow(context, palette, 15, input.trackProgress, 1);
  INTERLUDE_DOT_X.forEach((x, dot) => {
    context.fillStyle = palette[interludeDotTier(dot, progress, input.timeMs)];
    context.fillRect(x, INTERLUDE_DOT_Y, 2, 2);
  });
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
    windowProgress: unit(input.windowProgress),
    trackProgress: unit(input.trackProgress),
    scrollOffsetPx: Math.round(input.scrollOffsetPx),
  };
  const interlude = safeInput.interlude ?? -1;
  if (safeInput.hasLyric && interlude >= 0) {
    paintInterlude(context, palette, interlude, safeInput);
    return;
  }
  const bitmap = bitmapForText(safeInput.currentText);
  paintSparks(context, palette, bitmap, safeInput);
  if (safeInput.mode === "rings") paintRings(context, palette, bitmap, safeInput);
  else if (safeInput.mode === "tilt") paintTilt(context, palette, bitmap, safeInput);
  else if (safeInput.mode === "skyline") paintSkyline(context, palette, bitmap, safeInput);
  else if (safeInput.mode === "spotlight") paintSpotlight(context, palette, bitmap, safeInput);
  else if (safeInput.mode === "cascade") paintCascade(context, palette, bitmap, safeInput);
  else paintTicker(context, palette, bitmap, safeInput);
}

interface PixelLyricsPreviewProps {
  currentText: string;
  hasLyric: boolean;
  /** The window and word timings of the line being shown, in track time. */
  line: PixelLyricLine;
  trackProgress: number;
  /** Track playhead. Both the lyric cursor and the spectrum read it. */
  timeMs: number;
  playing: boolean;
  skin: MusicSkin;
  accent: string | null;
  mode: MusicMode;
  spectrum?: SpectrumLookup;
  /** 火花. */
  sparks?: boolean;
}

export function PixelLyricsPreview({
  currentText,
  hasLyric,
  line,
  trackProgress,
  timeMs,
  playing,
  skin,
  accent,
  mode,
  spectrum,
  sparks = false,
}: PixelLyricsPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestFrameRef = useRef({
    currentText,
    hasLyric,
    line,
    trackProgress,
    timeMs,
    playing,
    skin,
    accent,
    mode,
    spectrum,
    sparks,
  });
  const trackClockRef = useRef({ timeMs, receivedAt: 0 });
  latestFrameRef.current = {
    currentText,
    hasLyric,
    line,
    trackProgress,
    timeMs,
    playing,
    skin,
    accent,
    mode,
    spectrum,
    sparks,
  };

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
      const trackClock = trackClockRef.current;
      // ONE clock for the whole frame. There used to be a second one that
      // extrapolated the lyric *progress* between renders, which meant the
      // smoothing inherited whatever the line duration claimed — and the line
      // duration was the thing that was wrong. Advancing the playhead and
      // letting the cursor interpret it keeps the two in step by construction.
      const smoothTimeMs = Math.max(
        0,
        projectedPlayheadMs(trackClock.timeMs, now - trackClock.receivedAt, frame.playing),
      );
      const { cursor, windowProgress, interlude, sinceLineMs } = pixelLyricCursor(
        frame.currentText,
        frame.line,
        smoothTimeMs,
      );
      const scrollOffsetPx = pixelLyricScrollOffset(
        frame.currentText,
        cursor,
        frame.mode,
        reducedMotion,
      );
      const signature = [
        frame.currentText,
        frame.skin,
        frame.accent ?? "-",
        frame.mode,
        frame.hasLyric,
        frame.playing,
        scrollOffsetPx,
        cursor.index,
        cursor.phase,
        // Sparks fly through the glyph's own span, so they need a finer step.
        Math.round(cursor.frac * (frame.sparks ? 48 : 12)),
        frame.sparks,
        // 倾诉's glyphs surface 50 ms apart; past the last one nothing moves.
        frame.mode === "tilt" && Number.isFinite(sinceLineMs)
          ? Math.min(Math.floor(sinceLineMs / 40), 4_000)
          : 0,
        Math.round(frame.trackProgress * 52),
        frame.mode === "skyline" && !reducedMotion ? Math.floor(smoothTimeMs / 125) : 0,
        frame.mode === "skyline" && frame.spectrum && !reducedMotion
          ? Math.floor(smoothTimeMs / SPECTRUM_HOP_MS)
          : 0,
        frame.mode === "cascade" ? cascadeBandY(windowProgress, reducedMotion) : 0,
        frame.line.chorus === true,
        // Nothing else moves through an instrumental, so the dots have to be
        // in the signature or the canvas would never redraw them.
        interlude >= 0 ? Math.floor(interlude * INTERLUDE_DOT_X.length) : -1,
        interlude >= 0 ? Math.floor(smoothTimeMs / INTERLUDE_BREATH_MS) : 0,
      ].join(":");
      if (signature !== lastSignature) {
        drawPixelLyricsFrame(context, {
          skin: frame.skin,
          accent: frame.accent,
          mode: frame.mode,
          currentText: frame.currentText,
          hasLyric: frame.hasLyric,
          cursor,
          windowProgress,
          trackProgress: frame.trackProgress,
          playing: frame.playing,
          scrollOffsetPx,
          timeMs: smoothTimeMs,
          spectrum: frame.spectrum,
          reducedMotion,
          interlude,
          chorus: frame.line.chorus === true,
          lineStartMs: frame.line.startMs,
          sinceLineMs,
          sparks: frame.sparks,
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
  sparks: boolean;
  onSparksChange: (sparks: boolean) => void;
  syncsToDevice: boolean;
  simulatedSpectrum: boolean;
}

const MODE_ICON: Record<MusicMode, typeof MoveHorizontal> = {
  ticker: MoveHorizontal,
  skyline: AudioLines,
  spotlight: Radar,
  cascade: Rows3,
  rings: Target,
  tilt: Quote,
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
  sparks,
  onSparksChange,
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
          {/* `xl`: each tile carries a name and a note, which a `lg` tile
              could only fit at 10px with no air above or below. */}
          <ToggleGroup
            className="music-theme-options music-theme-options--modes"
            value={mode}
            size="xl"
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
                  activeColor="brand"
                  aria-label={item.name + "，" + item.note}
                >
                  <Icon aria-hidden="true" />
                  <span className="music-theme-option__text">
                    <strong>{item.name}</strong>
                    <small>{item.note}</small>
                  </span>
                  <Check className="music-theme-option__check" data-on={mode === item.id} aria-hidden="true" />
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
            size="xl"
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
                  // One accent for a selected tile in both groups. The skin's
                  // own colour already sits in its swatch; tinting the tile
                  // with it too made four selected states for one control.
                  activeColor="brand"
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
                  <Check className="music-theme-option__check" data-on={skin === item.id} aria-hidden="true" />
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
      <div className="music-theme-panel__toggle">
        <span className="music-theme-panel__label" id="music-theme-sparks-label">火花</span>
        <Switch
          size="sm"
          checked={sparks}
          onChange={(checked) => onSparksChange(checked)}
          aria-labelledby="music-theme-sparks-label"
        />
        <span className="music-theme-panel__hint">每个字开唱时迸出像素火花</span>
      </div>
      {simulatedSpectrum && (
        <p className="music-theme-panel__spectrum-note">此音源为模拟律动</p>
      )}
    </section>
  );
}
