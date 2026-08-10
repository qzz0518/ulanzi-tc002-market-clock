import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  PixelCanvas,
  encodePixelAnimation,
} from "./pixel-ui.ts";

export const VIDEO_IMPORT_MAX_BYTES = 100 * 1024 * 1024;
export const VIDEO_IMPORT_MAX_FRAMES = 360;
export const VIDEO_IMPORT_MAX_FPS = 12;
const FFMPEG_TIMEOUT_MS = 120_000;
const FRAME_BYTES = DISPLAY_WIDTH * DISPLAY_HEIGHT * 4;

export const FFMPEG_MISSING_MESSAGE =
  "未检测到 ffmpeg，视频导入不可用。请先安装：macOS 执行 brew install ffmpeg，Linux 执行 apt install ffmpeg";

export type VideoFitMode = "cover" | "contain";

export interface VideoImportRequest {
  bytes: Uint8Array;
  fileName: string;
  fit: VideoFitMode;
}

export interface VideoImportResult {
  // 52x16 looping GIF, ready for PixelAssetStore.save as image/gif.
  gifBytes: Uint8Array;
  frameCount: number;
  frameDelayMs: number;
  sourceFps: number;
  sourceDurationMs: number;
}

// Carries an HTTP status so the API route can answer 501 (ffmpeg missing),
// 413 (over the upload cap), or 408 (transcode timeout) without guessing.
export class VideoImportError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "VideoImportError";
  }
}

interface ProcessResult {
  exitCode: number;
  stderr: string;
  timedOut: boolean;
}

// Injection seam for tests: probe and subprocess execution are the only
// system dependencies of the pipeline.
export interface VideoImportTools {
  which(command: string): string | null;
  run(command: readonly string[], timeoutMs: number): Promise<ProcessResult>;
}

async function runProcess(command: readonly string[], timeoutMs: number): Promise<ProcessResult> {
  const child = Bun.spawn({
    cmd: [...command],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

// ffmpeg presence is probed lazily on the first import and then cached, so
// service startup never pays for (or requires) the binary.
let sFfmpegPath: string | null | undefined;

const defaultTools: VideoImportTools = {
  which(command) {
    if (command !== "ffmpeg") return Bun.which(command);
    if (sFfmpegPath === undefined) sFfmpegPath = Bun.which("ffmpeg");
    return sFfmpegPath;
  },
  run: runProcess,
};

// Parses `ffmpeg -i` stderr (it exits non-zero but prints the stream info we
// need) instead of requiring a separate ffprobe binary.
export function parseVideoProbe(stderr: string): { durationMs: number; sourceFps: number } {
  if (!/\bVideo:/.test(stderr)) {
    throw new VideoImportError("文件中没有视频流，无法导入", 400);
  }
  const duration = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d+(?:\.\d+)?)/);
  if (!duration) {
    throw new VideoImportError("无法读取视频时长，文件可能已损坏", 400);
  }
  const durationMs = Math.round(
    (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000,
  );
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new VideoImportError("无法读取视频时长，文件可能已损坏", 400);
  }
  const fps = stderr.match(/(\d+(?:\.\d+)?)\s*fps\b/) ?? stderr.match(/(\d+(?:\.\d+)?)\s*tbr\b/);
  const sourceFps = fps ? Number(fps[1]) : VIDEO_IMPORT_MAX_FPS;
  return { durationMs, sourceFps: sourceFps > 0 ? sourceFps : VIDEO_IMPORT_MAX_FPS };
}

// fps = min(12, source); when that would exceed 360 frames the rate is lowered
// so the 360 frames spread uniformly across the full duration.
export function planVideoExtraction(
  sourceFps: number,
  durationMs: number,
): { outputFps: number; expectedFrames: number; frameDelayMs: number } {
  const durationSeconds = durationMs / 1000;
  const targetFps = Math.min(VIDEO_IMPORT_MAX_FPS, sourceFps > 0 ? sourceFps : VIDEO_IMPORT_MAX_FPS);
  const outputFps = durationSeconds * targetFps > VIDEO_IMPORT_MAX_FRAMES
    ? VIDEO_IMPORT_MAX_FRAMES / durationSeconds
    : targetFps;
  return {
    outputFps,
    expectedFrames: Math.min(
      VIDEO_IMPORT_MAX_FRAMES,
      Math.max(1, Math.round(durationSeconds * outputFps)),
    ),
    frameDelayMs: Math.max(20, Math.round(1000 / outputFps)),
  };
}

// Evenly spaced sample of `count` frame indexes out of `total` (guards the
// rare case where ffmpeg's fps filter rounds up past the cap).
export function uniformFrameIndexes(total: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => Math.floor(index * total / count));
}

export function videoScaleFilter(fit: VideoFitMode): string {
  return fit === "cover"
    ? `scale=${DISPLAY_WIDTH}:${DISPLAY_HEIGHT}:force_original_aspect_ratio=increase:flags=area,`
      + `crop=${DISPLAY_WIDTH}:${DISPLAY_HEIGHT}`
    : `scale=${DISPLAY_WIDTH}:${DISPLAY_HEIGHT}:force_original_aspect_ratio=decrease:flags=area,`
      + `pad=${DISPLAY_WIDTH}:${DISPLAY_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

function safeExtension(fileName: string): string {
  const match = fileName.match(/\.([A-Za-z0-9]{1,5})$/);
  return match ? `.${match[1]!.toLowerCase()}` : "";
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "未知错误";
}

function canvasFromRgba(raw: Uint8Array, frameIndex: number): PixelCanvas {
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  const base = frameIndex * FRAME_BYTES;
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      const offset = base + (y * DISPLAY_WIDTH + x) * 4;
      canvas.setPixel(x, y, [raw[offset] ?? 0, raw[offset + 1] ?? 0, raw[offset + 2] ?? 0]);
    }
  }
  return canvas;
}

export async function importVideoAsGif(
  input: VideoImportRequest,
  tools: VideoImportTools = defaultTools,
): Promise<VideoImportResult> {
  if (input.fit !== "cover" && input.fit !== "contain") {
    throw new VideoImportError("fit 只支持 cover 或 contain", 400);
  }
  if (input.bytes.byteLength === 0) {
    throw new VideoImportError("视频文件为空", 400);
  }
  if (input.bytes.byteLength > VIDEO_IMPORT_MAX_BYTES) {
    throw new VideoImportError("视频超出 100MB 上限", 413);
  }
  const ffmpeg = tools.which("ffmpeg");
  if (!ffmpeg) throw new VideoImportError(FFMPEG_MISSING_MESSAGE, 501);

  // The upload lands in the system temp dir (never .runtime) and is removed
  // as soon as the conversion finishes, success or not.
  const directory = await mkdtemp(join(tmpdir(), "tc002-video-import-"));
  try {
    const inputPath = join(directory, `input${safeExtension(input.fileName)}`);
    await writeFile(inputPath, input.bytes);

    const probe = await tools.run([ffmpeg, "-hide_banner", "-i", inputPath], FFMPEG_TIMEOUT_MS);
    if (probe.timedOut) {
      throw new VideoImportError("视频分析超过 120 秒，已中止", 408);
    }
    const { durationMs, sourceFps } = parseVideoProbe(probe.stderr);
    const plan = planVideoExtraction(sourceFps, durationMs);

    const framesPath = join(directory, "frames.rgba");
    const extract = await tools.run([
      ffmpeg, "-hide_banner", "-loglevel", "error",
      "-i", inputPath,
      "-vf", `fps=${plan.outputFps},${videoScaleFilter(input.fit)}`,
      "-frames:v", String(VIDEO_IMPORT_MAX_FRAMES),
      "-pix_fmt", "rgba", "-f", "rawvideo",
      "-y", framesPath,
    ], FFMPEG_TIMEOUT_MS);
    if (extract.timedOut) {
      throw new VideoImportError("视频转码超过 120 秒，已中止，请缩短或压缩视频", 408);
    }
    if (extract.exitCode !== 0) {
      throw new VideoImportError(`视频转码失败：${firstLine(extract.stderr)}`, 400);
    }

    const raw = new Uint8Array(await readFile(framesPath));
    const totalFrames = Math.floor(raw.byteLength / FRAME_BYTES);
    if (totalFrames < 1) {
      throw new VideoImportError("视频中没有可用的画面帧", 400);
    }
    const indexes = totalFrames > VIDEO_IMPORT_MAX_FRAMES
      ? uniformFrameIndexes(totalFrames, VIDEO_IMPORT_MAX_FRAMES)
      : Array.from({ length: totalFrames }, (_, index) => index);
    const frames = indexes.map((frameIndex) => canvasFromRgba(raw, frameIndex));
    return {
      gifBytes: encodePixelAnimation(frames, frames.map(() => plan.frameDelayMs)),
      frameCount: frames.length,
      frameDelayMs: plan.frameDelayMs,
      sourceFps,
      sourceDurationMs: durationMs,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
