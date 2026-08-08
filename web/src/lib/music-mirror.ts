import {
  spotlightOffsetPx,
  type MusicMode,
} from "@/components/music/pixel-lyric-modes";
import {
  drawPixelLyricsFrame,
  lyricScrollOffsetForProgress,
  pixelTextWidth,
  type MusicSkin,
} from "@/components/music/pixel-lyrics-preview";

export interface MirrorFrame {
  delayMs: number;
  pixels: string;
}

const SCREEN_WIDTH = 52;
const SCREEN_HEIGHT = 16;
const MAX_FRAMES = 60;
const TARGET_FRAME_MS = 67; // ~15 fps (was an effective ~2.5 fps at 400ms/frame)

/**
 * Rasterizes one lyric line into the same 52×16 frames the preview canvas
 * shows, encoded as base64 RGB rows for the official custom-app channel.
 */
export function renderMirrorFrames(input: {
  text: string;
  hasLyric: boolean;
  durationMs: number;
  mode: MusicMode;
  skin: MusicSkin;
  trackProgress: number;
  playing: boolean;
}): MirrorFrame[] {
  const canvas = document.createElement("canvas");
  canvas.width = SCREEN_WIDTH;
  canvas.height = SCREEN_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];

  const durationMs = Math.max(800, Math.min(60_000, Math.round(input.durationMs) || 4_000));
  const frameCount = Math.max(2, Math.min(MAX_FRAMES, Math.round(durationMs / TARGET_FRAME_MS)));
  const delayMs = Math.max(40, Math.min(10_000, Math.round(durationMs / frameCount)));
  const textWidth = pixelTextWidth(input.text);

  const frames: MirrorFrame[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const progress = index / (frameCount - 1);
    const scrollOffsetPx = input.mode === "spotlight"
      ? spotlightOffsetPx(textWidth, progress)
      : lyricScrollOffsetForProgress(textWidth, progress, false);
    drawPixelLyricsFrame(context, {
      skin: input.skin,
      mode: input.mode,
      currentText: input.text,
      hasLyric: input.hasLyric,
      lyricProgress: progress,
      trackProgress: input.trackProgress,
      playing: input.playing,
      scrollOffsetPx,
      timeMs: index * delayMs,
      reducedMotion: false,
    });
    frames.push({ delayMs, pixels: frameToBase64Rgb(context) });
  }
  return frames;
}

function frameToBase64Rgb(context: CanvasRenderingContext2D): string {
  const rgba = context.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT).data;
  const pixelCount = SCREEN_WIDTH * SCREEN_HEIGHT;
  let binary = "";
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    binary += String.fromCharCode(
      rgba[pixel * 4]!,
      rgba[pixel * 4 + 1]!,
      rgba[pixel * 4 + 2]!,
    );
  }
  return btoa(binary);
}
