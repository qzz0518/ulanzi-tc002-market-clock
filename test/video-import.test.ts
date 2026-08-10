import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlHandler } from "../src/control-api.ts";
import { PixelAssetStore } from "../src/pixel-asset-store.ts";
import { PixelCanvas, encodePixelAnimation } from "../src/pixel-ui.ts";
import type { UlanziPixelAssetClient } from "../src/ulanzi-pixel-assets.ts";
import type { WorkspaceController } from "../src/workspace-controller.ts";
import {
  FFMPEG_MISSING_MESSAGE,
  VIDEO_IMPORT_MAX_BYTES,
  VIDEO_IMPORT_MAX_FRAMES,
  VideoImportError,
  importVideoAsGif,
  parseVideoProbe,
  planVideoExtraction,
  uniformFrameIndexes,
  videoScaleFilter,
  type VideoImportResult,
  type VideoImportTools,
} from "../src/video-import.ts";

const FRAME_BYTES = 52 * 16 * 4;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const PROBE_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:00:05.00, start: 0.000000, bitrate: 616 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x720, 610 kb/s, 24 fps, 24 tbr, 12288 tbn (default)
At least one output file must be specified
`;

function solidFrame(red: number, green: number, blue: number): Uint8Array {
  const frame = new Uint8Array(FRAME_BYTES);
  for (let offset = 0; offset < FRAME_BYTES; offset += 4) {
    frame[offset] = red;
    frame[offset + 1] = green;
    frame[offset + 2] = blue;
    frame[offset + 3] = 255;
  }
  return frame;
}

// Fake tools: the probe call answers with canned stream info, the extract call
// writes the given raw RGBA frames to the output path ffmpeg would have used.
function fakeTools(rawFrames: Uint8Array[], probeStderr = PROBE_STDERR): VideoImportTools {
  return {
    which: () => "/opt/fake/ffmpeg",
    async run(command) {
      if (!command.includes("-vf")) {
        return { exitCode: 1, stderr: probeStderr, timedOut: false };
      }
      const merged = new Uint8Array(rawFrames.length * FRAME_BYTES);
      rawFrames.forEach((frame, index) => merged.set(frame, index * FRAME_BYTES));
      await writeFile(String(command.at(-1)), merged);
      return { exitCode: 0, stderr: "", timedOut: false };
    },
  };
}

describe("ffmpeg probe parsing", () => {
  test("reads duration and source fps from ffmpeg -i stderr", () => {
    expect(parseVideoProbe(PROBE_STDERR)).toEqual({ durationMs: 5000, sourceFps: 24 });
  });

  test("rejects files without a video stream", () => {
    const audioOnly = "  Duration: 00:00:05.00\n  Stream #0:0: Audio: mp3, 44100 Hz\n";
    expect(() => parseVideoProbe(audioOnly)).toThrow(VideoImportError);
    expect(() => parseVideoProbe(audioOnly)).toThrow("没有视频流");
  });

  test("rejects streams with an unknown duration", () => {
    const noDuration = "  Duration: N/A\n  Stream #0:0: Video: h264, 24 fps\n";
    expect(() => parseVideoProbe(noDuration)).toThrow("无法读取视频时长");
  });

  test("falls back to tbr and then to the 12fps cap", () => {
    expect(parseVideoProbe("Duration: 00:00:02.00\nVideo: vp9, 25 tbr\n").sourceFps).toBe(25);
    expect(parseVideoProbe("Duration: 00:00:02.00\nVideo: vp9\n").sourceFps).toBe(12);
  });
});

describe("extraction planning math", () => {
  test("caps the rate at 12fps for fast sources", () => {
    expect(planVideoExtraction(24, 5000)).toEqual({
      outputFps: 12,
      expectedFrames: 60,
      frameDelayMs: 83,
    });
  });

  test("keeps the native rate for slow sources", () => {
    expect(planVideoExtraction(10, 5000)).toEqual({
      outputFps: 10,
      expectedFrames: 50,
      frameDelayMs: 100,
    });
  });

  test("spreads 360 frames uniformly across long videos", () => {
    expect(planVideoExtraction(30, 60_000)).toEqual({
      outputFps: 6,
      expectedFrames: 360,
      frameDelayMs: 167,
    });
    const hourLong = planVideoExtraction(12, 3_600_000);
    expect(hourLong.outputFps).toBeCloseTo(0.1);
    expect(hourLong.expectedFrames).toBe(VIDEO_IMPORT_MAX_FRAMES);
    expect(hourLong.frameDelayMs).toBe(10_000);
  });

  test("uniform sampling picks evenly spaced, strictly increasing indexes", () => {
    expect(uniformFrameIndexes(10, 5)).toEqual([0, 2, 4, 6, 8]);
    expect(uniformFrameIndexes(7, 3)).toEqual([0, 2, 4]);
    const sampled = uniformFrameIndexes(365, 360);
    expect(sampled).toHaveLength(360);
    expect(sampled[0]).toBe(0);
    expect(sampled.at(-1)).toBe(363);
    expect(sampled.every((value, index) => index === 0 || value > sampled[index - 1]!)).toBe(true);
  });

  test("builds cover and contain scale filters for 52x16", () => {
    expect(videoScaleFilter("cover")).toContain("force_original_aspect_ratio=increase");
    expect(videoScaleFilter("cover")).toContain("crop=52:16");
    expect(videoScaleFilter("contain")).toContain("force_original_aspect_ratio=decrease");
    expect(videoScaleFilter("contain")).toContain("pad=52:16");
  });
});

describe("import pipeline", () => {
  const clip = (bytes = new Uint8Array([1, 2, 3])) =>
    ({ bytes, fileName: "clip.mp4", fit: "cover" as const });

  test("fails functionally with 501 when ffmpeg is missing", async () => {
    const tools: VideoImportTools = {
      which: () => null,
      run: () => Promise.reject(new Error("must not spawn")),
    };
    await expect(importVideoAsGif(clip(), tools)).rejects.toThrow(FFMPEG_MISSING_MESSAGE);
    try {
      await importVideoAsGif(clip(), tools);
    } catch (error) {
      expect((error as VideoImportError).status).toBe(501);
    }
  });

  test("validates fit, empty and oversized uploads before spawning anything", async () => {
    const tools: VideoImportTools = {
      which: () => "/opt/fake/ffmpeg",
      run: () => Promise.reject(new Error("must not spawn")),
    };
    await expect(
      importVideoAsGif({ ...clip(), fit: "stretch" as never }, tools),
    ).rejects.toThrow("fit 只支持");
    await expect(importVideoAsGif(clip(new Uint8Array(0)), tools)).rejects.toThrow("视频文件为空");
    const oversized = clip(new Uint8Array(VIDEO_IMPORT_MAX_BYTES + 1));
    try {
      await importVideoAsGif(oversized, tools);
      throw new Error("oversized upload must be rejected");
    } catch (error) {
      expect((error as VideoImportError).status).toBe(413);
    }
  });

  test("maps subprocess timeouts to a 408 import error", async () => {
    const tools: VideoImportTools = {
      which: () => "/opt/fake/ffmpeg",
      run: async () => ({ exitCode: 137, stderr: "", timedOut: true }),
    };
    try {
      await importVideoAsGif(clip(), tools);
      throw new Error("timeout must be rejected");
    } catch (error) {
      expect((error as VideoImportError).status).toBe(408);
    }
  });

  test("surfaces ffmpeg transcode failures as 400", async () => {
    const tools: VideoImportTools = {
      which: () => "/opt/fake/ffmpeg",
      async run(command) {
        if (!command.includes("-vf")) return { exitCode: 1, stderr: PROBE_STDERR, timedOut: false };
        return { exitCode: 1, stderr: "input.mp4: Invalid data found\n", timedOut: false };
      },
    };
    await expect(importVideoAsGif(clip(), tools)).rejects.toThrow("视频转码失败");
  });

  test("turns extracted RGBA frames into a store-compatible 52x16 GIF", async () => {
    const result = await importVideoAsGif(
      clip(),
      fakeTools([solidFrame(255, 0, 0), solidFrame(0, 0, 255)]),
    );
    expect(result.frameCount).toBe(2);
    expect(result.frameDelayMs).toBe(83);
    expect(result.sourceFps).toBe(24);
    expect(result.sourceDurationMs).toBe(5000);
    expect(new TextDecoder("ascii").decode(result.gifBytes.subarray(0, 6))).toBe("GIF89a");

    const directory = await mkdtemp(join(tmpdir(), "video-import-store-"));
    directories.push(directory);
    const metadata = await new PixelAssetStore(directory).save({
      officialId: "17000",
      title: "试片",
      author: "本地视频",
      sourceUrl: "upload://clip.mp4",
      mimeType: "image/gif",
      bytes: result.gifBytes,
    });
    expect(metadata.frameCount).toBe(2);
    expect(metadata.mimeType).toBe("image/gif");
  });
});

describe("POST /api/library/video/import", () => {
  function handlerWith(importVideo?: (input: never) => Promise<VideoImportResult>) {
    return (async () => {
      const directory = await mkdtemp(join(tmpdir(), "video-import-api-"));
      directories.push(directory);
      return createControlHandler({} as unknown as WorkspaceController, {
        pixelAssetLibrary: {
          client: {} as unknown as UlanziPixelAssetClient,
          store: new PixelAssetStore(directory),
          importVideo: importVideo as never,
        },
      });
    })();
  }

  function multipart(fields: Record<string, string | File>): Request {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return new Request("http://127.0.0.1:43820/api/library/video/import", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:43820" },
      body: form,
    });
  }

  const videoFile = () =>
    new File([new Uint8Array([0, 0, 0, 24])], "bad apple.mp4", { type: "video/mp4" });

  test("stores the converted GIF and answers with the Ulanzi asset shape", async () => {
    const first = new PixelCanvas(52, 16, [255, 0, 0]);
    const second = new PixelCanvas(52, 16, [0, 0, 255]);
    const handler = await handlerWith(async () => ({
      gifBytes: encodePixelAnimation([first, second], [100, 100]),
      frameCount: 2,
      frameDelayMs: 100,
      sourceFps: 24,
      sourceDurationMs: 200,
    }));
    const response = await handler(multipart({ file: videoFile(), fit: "contain" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.asset).toMatchObject({
      title: "bad apple",
      author: "本地视频",
      mimeType: "image/gif",
      frameCount: 2,
      sourceUrl: "upload://bad apple.mp4",
    });
    expect(body.asset.officialId).toMatch(/^\d+$/);
    expect(body.asset.previewUrl).toMatch(/^\/api\/library\/ulanzi\/imported\/[a-f0-9]{64}$/);

    const media = await handler(new Request(`http://127.0.0.1:43820${body.asset.previewUrl}`));
    expect(media.headers.get("Content-Type")).toBe("image/gif");
    const bytes = new Uint8Array(await media.arrayBuffer());
    expect(new TextDecoder("ascii").decode(bytes.subarray(0, 6))).toBe("GIF89a");
  });

  test("answers 501 with the install hint when ffmpeg is unavailable", async () => {
    const handler = await handlerWith(async () => {
      throw new VideoImportError(FFMPEG_MISSING_MESSAGE, 501);
    });
    const response = await handler(multipart({ file: videoFile() }));
    expect(response.status).toBe(501);
    expect((await response.json()).error).toContain("brew install ffmpeg");
  });

  test("validates the multipart request before converting", async () => {
    const handler = await handlerWith(async () => {
      throw new Error("importer must not run");
    });
    const missingFile = await handler(multipart({ fit: "cover" }));
    expect(missingFile.status).toBe(400);
    const badFit = await handler(multipart({ file: videoFile(), fit: "stretch" }));
    expect(badFit.status).toBe(400);
    const crossOrigin = await handler(new Request(
      "http://127.0.0.1:43820/api/library/video/import",
      { method: "POST", headers: { Origin: "http://evil.example" }, body: new FormData() },
    ));
    expect(crossOrigin.status).toBe(400);
  });

  test("rejects uploads over the dedicated 100MB cap upfront", async () => {
    const handler = await handlerWith(async () => {
      throw new Error("importer must not run");
    });
    const response = await handler(new Request(
      "http://127.0.0.1:43820/api/library/video/import",
      {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:43820",
          "Content-Type": "multipart/form-data; boundary=x",
          "Content-Length": String(VIDEO_IMPORT_MAX_BYTES * 2),
        },
        body: "x",
      },
    ));
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain("100MB");
  });

  test("answers 404 when the pixel asset library is not wired", async () => {
    const handler = createControlHandler({} as unknown as WorkspaceController, {});
    const response = await handler(multipart({ file: videoFile() }));
    expect(response.status).toBe(404);
  });
});

// Real transcode coverage runs only where ffmpeg is installed; CI without it
// still exercises every branch above through the injected tools.
const ffmpegBinary = Bun.which("ffmpeg");

describe.skipIf(!ffmpegBinary)("real ffmpeg transcode", () => {
  test("converts a generated 1-second lavfi clip end to end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "video-import-e2e-"));
    directories.push(directory);
    const videoPath = join(directory, "test.mp4");
    const synth = Bun.spawn({
      cmd: [
        ffmpegBinary!, "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=1:size=104x32:rate=24",
        "-pix_fmt", "yuv420p", "-y", videoPath,
      ],
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await synth.exited).toBe(0);

    const result = await importVideoAsGif({
      bytes: new Uint8Array(await readFile(videoPath)),
      fileName: "test.mp4",
      fit: "contain",
    });
    // 1 second at min(12, 24) fps; ffmpeg's fps filter may round by one frame.
    expect(result.sourceFps).toBe(24);
    expect(result.frameDelayMs).toBe(83);
    expect(result.frameCount).toBeGreaterThanOrEqual(11);
    expect(result.frameCount).toBeLessThanOrEqual(13);
    expect(new TextDecoder("ascii").decode(result.gifBytes.subarray(0, 6))).toBe("GIF89a");

    const metadata = await new PixelAssetStore(join(directory, "assets")).save({
      officialId: "17001",
      title: "lavfi",
      author: "本地视频",
      sourceUrl: "upload://test.mp4",
      mimeType: "image/gif",
      bytes: result.gifBytes,
    });
    // testsrc animates, so consecutive frames stay distinct after quantization.
    expect(metadata.frameCount).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
