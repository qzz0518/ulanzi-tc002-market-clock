import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decompressFrames, parseGIF } from "gifuct-js";
import { PNG } from "pngjs";
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  PixelCanvas,
  encodePixelAnimation,
} from "./pixel-ui.ts";

const MAX_SOURCE_DIMENSION = 4_096;
const MAX_SOURCE_PIXELS = 8_000_000;
const MAX_SOURCE_GIF_FRAMES = 360;
const MAX_RENDER_FRAMES = 90;
const ASSET_REF_PATTERN = /^[a-f0-9]{64}$/;

export type PixelAssetMimeType = "image/png" | "image/gif";

export interface PixelAssetImportInput {
  officialId: string;
  title: string;
  author: string;
  sourceUrl: string;
  mimeType: PixelAssetMimeType;
  bytes: Uint8Array;
}

export interface StoredPixelAssetMetadata {
  version: 1;
  ref: string;
  officialId: string;
  title: string;
  author: string;
  sourceUrl: string;
  mimeType: PixelAssetMimeType;
  frameCount: number;
  nativeDurationMs: number;
  importedAt: string;
}

export interface RenderedPixelAsset {
  metadata: StoredPixelAssetMetadata;
  frames: PixelCanvas[];
  frameDelaysMs: number[];
}

interface DecodedAnimation {
  frames: PixelCanvas[];
  frameDelaysMs: number[];
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function assertSourceDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 1
    || height < 1
    || width > MAX_SOURCE_DIMENSION
    || height > MAX_SOURCE_DIMENSION
    || width * height > MAX_SOURCE_PIXELS
  ) {
    throw new Error("pixel asset image dimensions are not supported");
  }
  const ratioError = Math.abs(width / height - DISPLAY_WIDTH / DISPLAY_HEIGHT);
  if (ratioError > 0.02) {
    throw new Error("pixel asset must use the TC002 52:16 aspect ratio");
  }
}

function resizedCanvas(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): PixelCanvas {
  assertSourceDimensions(width, height);
  if (rgba.byteLength < width * height * 4) {
    throw new Error("pixel asset contains incomplete RGBA data");
  }
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / DISPLAY_HEIGHT));
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / DISPLAY_WIDTH));
      const offset = (sourceY * width + sourceX) * 4;
      if ((rgba[offset + 3] ?? 0) < 128) continue;
      canvas.setPixel(x, y, [
        rgba[offset] ?? 0,
        rgba[offset + 1] ?? 0,
        rgba[offset + 2] ?? 0,
      ]);
    }
  }
  return canvas;
}

function sameCanvas(left: PixelCanvas, right: PixelCanvas): boolean {
  if (left.pixels.length !== right.pixels.length) return false;
  return left.pixels.every((value, index) => value === right.pixels[index]);
}

function decodeGif(bytes: Uint8Array): DecodedAnimation {
  if (
    bytes.byteLength < 10
    || !["GIF87a", "GIF89a"].includes(new TextDecoder("ascii").decode(bytes.subarray(0, 6)))
  ) {
    throw new Error("pixel asset GIF signature is invalid");
  }
  const parsed = parseGIF(exactArrayBuffer(bytes));
  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  assertSourceDimensions(width, height);
  const encodedFrames = parsed.frames.filter((frame) => "image" in frame);
  if (encodedFrames.length < 1 || encodedFrames.length > MAX_SOURCE_GIF_FRAMES) {
    throw new Error(`pixel asset GIF must contain 1-${MAX_SOURCE_GIF_FRAMES} frames`);
  }
  for (const frame of encodedFrames) {
    const dimensions = frame.image.descriptor;
    if (
      dimensions.left < 0
      || dimensions.top < 0
      || dimensions.width < 1
      || dimensions.height < 1
      || dimensions.left + dimensions.width > width
      || dimensions.top + dimensions.height > height
      || dimensions.width * dimensions.height > MAX_SOURCE_PIXELS
    ) {
      throw new Error("pixel asset GIF frame bounds are invalid");
    }
  }
  const decoded = decompressFrames(parsed, true);
  if (decoded.length < 1 || decoded.length > MAX_SOURCE_GIF_FRAMES) {
    throw new Error(`pixel asset GIF must contain 1-${MAX_SOURCE_GIF_FRAMES} frames`);
  }

  const composite = new Uint8ClampedArray(width * height * 4);
  let previousDisposal = 0;
  let previousDimensions: { left: number; top: number; width: number; height: number } | null = null;
  let restoreBeforePrevious: Uint8ClampedArray | null = null;
  const frames: PixelCanvas[] = [];
  const frameDelaysMs: number[] = [];

  for (const frame of decoded) {
    if (previousDisposal === 2 && previousDimensions) {
      for (let y = 0; y < previousDimensions.height; y += 1) {
        for (let x = 0; x < previousDimensions.width; x += 1) {
          const targetX = previousDimensions.left + x;
          const targetY = previousDimensions.top + y;
          if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
          composite.fill(0, (targetY * width + targetX) * 4, (targetY * width + targetX) * 4 + 4);
        }
      }
    } else if (previousDisposal === 3 && restoreBeforePrevious) {
      composite.set(restoreBeforePrevious);
    }

    const restoreForCurrent = frame.disposalType === 3 ? composite.slice() : null;
    const { left, top, width: patchWidth, height: patchHeight } = frame.dims;
    if (
      left < 0
      || top < 0
      || patchWidth < 1
      || patchHeight < 1
      || left + patchWidth > width
      || top + patchHeight > height
      || frame.patch.byteLength < patchWidth * patchHeight * 4
    ) {
      throw new Error("pixel asset GIF frame bounds are invalid");
    }
    for (let y = 0; y < patchHeight; y += 1) {
      for (let x = 0; x < patchWidth; x += 1) {
        const sourceOffset = (y * patchWidth + x) * 4;
        const alpha = frame.patch[sourceOffset + 3] ?? 0;
        if (alpha === 0) continue;
        const targetOffset = ((top + y) * width + left + x) * 4;
        composite[targetOffset] = frame.patch[sourceOffset] ?? 0;
        composite[targetOffset + 1] = frame.patch[sourceOffset + 1] ?? 0;
        composite[targetOffset + 2] = frame.patch[sourceOffset + 2] ?? 0;
        composite[targetOffset + 3] = alpha;
      }
    }

    const nextCanvas = resizedCanvas(composite, width, height);
    const delay = Math.max(20, Math.min(10_000, Math.round(frame.delay || 100)));
    if (frames.length > 0 && sameCanvas(frames.at(-1)!, nextCanvas)) {
      frameDelaysMs[frameDelaysMs.length - 1] = frameDelaysMs.at(-1)! + delay;
    } else {
      frames.push(nextCanvas);
      frameDelaysMs.push(delay);
    }
    previousDisposal = frame.disposalType;
    previousDimensions = frame.dims;
    restoreBeforePrevious = restoreForCurrent;
  }

  return { frames, frameDelaysMs };
}

function decodePng(bytes: Uint8Array): DecodedAnimation {
  if (
    bytes.byteLength < 24
    || !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("pixel asset PNG signature is invalid");
  }
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredWidth = header.readUInt32BE(16);
  const declaredHeight = header.readUInt32BE(20);
  assertSourceDimensions(declaredWidth, declaredHeight);
  const decoded = PNG.sync.read(Buffer.from(bytes));
  if (decoded.width !== declaredWidth || decoded.height !== declaredHeight) {
    throw new Error("pixel asset PNG dimensions are inconsistent");
  }
  return {
    frames: [resizedCanvas(decoded.data, decoded.width, decoded.height)],
    frameDelaysMs: [0],
  };
}

function evenlyDistributedDelays(durationMs: number, count: number): number[] {
  const base = Math.floor(durationMs / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? durationMs - base * (count - 1) : base
  );
}

function frameAtTime(delays: readonly number[], timeMs: number): number {
  let elapsed = 0;
  for (let index = 0; index < delays.length; index += 1) {
    elapsed += delays[index]!;
    if (timeMs < elapsed) return index;
  }
  return Math.max(0, delays.length - 1);
}

function fitDuration(
  frames: readonly PixelCanvas[],
  nativeDelays: readonly number[],
  durationMs: number,
): { frames: PixelCanvas[]; frameDelaysMs: number[] } {
  if (frames.length === 1) return { frames: [frames[0]!], frameDelaysMs: [durationMs] };
  const cycleDuration = nativeDelays.reduce((sum, delay) => sum + delay, 0);
  if (cycleDuration <= 0) throw new Error("pixel asset animation has no duration");
  const estimatedFrames = Math.ceil(durationMs / cycleDuration) * frames.length;
  if (estimatedFrames <= MAX_RENDER_FRAMES) {
    const outputFrames: PixelCanvas[] = [];
    const outputDelays: number[] = [];
    let elapsed = 0;
    while (elapsed < durationMs) {
      for (let index = 0; index < frames.length && elapsed < durationMs; index += 1) {
        const delay = Math.min(nativeDelays[index]!, durationMs - elapsed);
        outputFrames.push(frames[index]!);
        outputDelays.push(delay);
        elapsed += delay;
      }
    }
    return { frames: outputFrames, frameDelaysMs: outputDelays };
  }

  const count = Math.max(1, Math.min(MAX_RENDER_FRAMES, Math.floor(durationMs / 20)));
  const outputDelays = evenlyDistributedDelays(durationMs, count);
  let elapsed = 0;
  const outputFrames = outputDelays.map((delay) => {
    const index = frameAtTime(nativeDelays, elapsed % cycleDuration);
    elapsed += delay;
    return frames[index]!;
  });
  return { frames: outputFrames, frameDelaysMs: outputDelays };
}

export function isPixelAssetRef(value: unknown): value is string {
  return typeof value === "string" && ASSET_REF_PATTERN.test(value);
}

export function normalizePixelAssetMedia(
  mimeType: PixelAssetMimeType,
  bytes: Uint8Array,
): { mimeType: PixelAssetMimeType; bytes: Uint8Array; frameCount: number; nativeDurationMs: number } {
  const decoded = mimeType === "image/gif" ? decodeGif(bytes) : decodePng(bytes);
  const nativeDurationMs = decoded.frameDelaysMs.reduce((sum, delay) => sum + delay, 0);
  if (decoded.frames.length === 1) {
    return {
      mimeType: "image/png",
      bytes: decoded.frames[0]!.toPng(),
      frameCount: 1,
      nativeDurationMs: 0,
    };
  }
  return {
    mimeType: "image/gif",
    bytes: encodePixelAnimation(decoded.frames, decoded.frameDelaysMs),
    frameCount: decoded.frames.length,
    nativeDurationMs,
  };
}

function validateMetadata(value: unknown, expectedRef: string): StoredPixelAssetMetadata {
  const input = value as Partial<StoredPixelAssetMetadata> | null;
  if (
    !input
    || input.version !== 1
    || input.ref !== expectedRef
    || !isPixelAssetRef(input.ref)
    || !/^\d{1,20}$/.test(input.officialId ?? "")
    || typeof input.title !== "string"
    || typeof input.author !== "string"
    || typeof input.sourceUrl !== "string"
    || !["image/png", "image/gif"].includes(input.mimeType ?? "")
    || !Number.isInteger(input.frameCount)
    || (input.frameCount ?? 0) < 1
    || !Number.isInteger(input.nativeDurationMs)
    || (input.nativeDurationMs ?? -1) < 0
    || typeof input.importedAt !== "string"
  ) {
    throw new Error("stored pixel asset metadata is invalid");
  }
  return input as StoredPixelAssetMetadata;
}

async function atomicWrite(path: string, data: Uint8Array | string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, data);
  await rename(temporaryPath, path);
}

export class PixelAssetStore {
  private readonly cache = new Map<string, Promise<{ metadata: StoredPixelAssetMetadata; animation: DecodedAnimation }>>();

  constructor(readonly directory: string) {}

  async save(input: PixelAssetImportInput): Promise<StoredPixelAssetMetadata> {
    const normalized = normalizePixelAssetMedia(input.mimeType, input.bytes);
    const ref = createHash("sha256")
      .update(input.officialId)
      .update("\0")
      .update(normalized.bytes)
      .digest("hex");
    const metadata: StoredPixelAssetMetadata = {
      version: 1,
      ref,
      officialId: input.officialId,
      title: input.title.slice(0, 96),
      author: input.author.slice(0, 96),
      sourceUrl: input.sourceUrl,
      mimeType: normalized.mimeType,
      frameCount: normalized.frameCount,
      nativeDurationMs: normalized.nativeDurationMs,
      importedAt: new Date().toISOString(),
    };
    await mkdir(this.directory, { recursive: true });
    const mediaPath = this.mediaPath(ref, normalized.mimeType);
    const metadataPath = this.metadataPath(ref);
    await atomicWrite(mediaPath, normalized.bytes);
    await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    this.cache.delete(ref);
    return metadata;
  }

  async getMedia(ref: string): Promise<{ metadata: StoredPixelAssetMetadata; bytes: Uint8Array }> {
    const metadata = await this.getMetadata(ref);
    return {
      metadata,
      bytes: new Uint8Array(await readFile(this.mediaPath(ref, metadata.mimeType))),
    };
  }

  async render(ref: string, durationMs: number): Promise<RenderedPixelAsset> {
    const loaded = await this.load(ref);
    const fitted = fitDuration(loaded.animation.frames, loaded.animation.frameDelaysMs, durationMs);
    return { metadata: loaded.metadata, ...fitted };
  }

  private async getMetadata(ref: string): Promise<StoredPixelAssetMetadata> {
    if (!isPixelAssetRef(ref)) throw new Error("pixel asset reference is invalid");
    return validateMetadata(JSON.parse(await readFile(this.metadataPath(ref), "utf8")), ref);
  }

  private load(ref: string): Promise<{ metadata: StoredPixelAssetMetadata; animation: DecodedAnimation }> {
    const cached = this.cache.get(ref);
    if (cached) return cached;
    const pending = (async () => {
      const { metadata, bytes } = await this.getMedia(ref);
      const animation = metadata.mimeType === "image/gif" ? decodeGif(bytes) : decodePng(bytes);
      return { metadata, animation };
    })().catch((error) => {
      this.cache.delete(ref);
      throw error;
    });
    this.cache.set(ref, pending);
    return pending;
  }

  private metadataPath(ref: string): string {
    if (!isPixelAssetRef(ref)) throw new Error("pixel asset reference is invalid");
    return join(this.directory, `${ref}.json`);
  }

  private mediaPath(ref: string, mimeType: PixelAssetMimeType): string {
    if (!isPixelAssetRef(ref)) throw new Error("pixel asset reference is invalid");
    return join(this.directory, `${ref}.${mimeType === "image/gif" ? "gif" : "png"}`);
  }
}
