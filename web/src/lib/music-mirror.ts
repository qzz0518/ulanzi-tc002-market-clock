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
// 400 帧覆盖一句 12 秒的歌词跑满 33fps；真机实测官方固件收 400 帧（48KB 请求体）只要
// 109ms，所以上限是按浏览器渲染成本定的，不是按设备容量定的。
const MAX_FRAMES = 400;
// GIF 只能表达厘秒级的帧延迟（编码器内部 delay/10 四舍五入），所以间隔必须落在
// 10ms 的整倍数上——67ms 那种值会被解码成 70ms，且每帧的取整方向不一定一致。
const FRAME_QUANTUM_MS = 10;
// 20ms = 50fps 的实用上限。真机标尺动画显示面板连 100fps（10ms，GIF 格式的尽头）都很
// 顺，但画面本身没有那么多状态可放：文字在走带/天际/升降里按 12 像素整格跳，频谱是
// 8fps 量化的，进度条光标一共只有 47 个位置——再快的帧只是同一张画面重复。
const MIN_FRAME_MS = 20;
// 33fps 基线：上面那些整格跳的元素在这一档已经饱和，给再多帧也不会更平滑。
const BASE_FRAME_MS = 30;

/**
 * Frame timing for one lyric line, kept separate from the rasterizer so the
 * frame-rate budget is testable without a DOM.
 *
 * `motionSteps` is how many distinct positions the line's motion actually has —
 * only the spotlight mode moves per pixel and needs more than the baseline.
 */
export function mirrorFrameSchedule(
  rawDurationMs: number,
  motionSteps = 0,
): { frameCount: number; delayMs: number } {
  const durationMs = Math.max(800, Math.min(60_000, Math.round(rawDurationMs) || 4_000));
  // 逐像素移动的模式要「文字每挪 1 像素就有一帧」，否则再高的帧率也是在跳格；其余模式
  // 的画面状态数远低于基线，多给的帧只会重复。两头都夹住：不慢于基线，也不快于实用上限。
  const wantedDelayMs = motionSteps > 0 ? durationMs / motionSteps : BASE_FRAME_MS;
  const idealDelayMs = Math.max(
    MIN_FRAME_MS,
    Math.min(BASE_FRAME_MS, wantedDelayMs),
    // 句子长到装不下时把间隔向上对齐一档，而不是把帧数硬压在上限上——后者会让 GIF
    // 总时长短于整句，句尾又从头滚一遍。
    durationMs / MAX_FRAMES,
  );
  const delayMs = Math.min(10_000, Math.ceil(idealDelayMs / FRAME_QUANTUM_MS) * FRAME_QUANTUM_MS);
  const frameCount = Math.max(2, Math.min(MAX_FRAMES, Math.round(durationMs / delayMs)));
  return { frameCount, delayMs };
}

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

  const textWidth = pixelTextWidth(input.text);
  // 聚光模式的文字逐像素扫过屏幕，所以它需要的帧数就是文字的像素宽；其余模式按整格
  // 跳字，用基线帧率即可。
  const motionSteps = input.mode === "spotlight" ? Math.max(0, Math.round(textWidth)) : 0;
  const { frameCount, delayMs } = mirrorFrameSchedule(input.durationMs, motionSteps);

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
