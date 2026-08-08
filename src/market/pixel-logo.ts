import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import {
  PixelCanvas,
  renderRuntimeMarketDashboard,
  type Rgb,
} from "../pixel-ui.ts";
import type { MarketInstrument } from "./instruments.ts";

export const MAX_LOGO_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_DIMENSION = 1_024;
export const LOGO_PIPELINE_VERSION = "catalog-png-v2" as const;
export const LOGO_VARIANT_IDS = ["balanced", "compact", "background"] as const;

export type LogoVariantId = typeof LOGO_VARIANT_IDS[number];
export const AUTOMATIC_LOGO_VARIANT_ID: LogoVariantId = "compact";

export interface PixelLogoBitmap {
  width: 16;
  height: 16;
  pixels: Uint8Array;
}

export interface ProcessedLogoVariant {
  id: LogoVariantId;
  label: string;
  description: string;
  bitmap: PixelLogoBitmap;
  pixelSha256: string;
  foregroundPixels: number;
  paletteSize: number;
  backgroundRemoved: boolean;
  warnings: string[];
}

export interface ProcessedLogoSource {
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  variants: ProcessedLogoVariant[];
}

interface PngInspection {
  width: number;
  height: number;
}

interface Bounds {
  minimumX: number;
  minimumY: number;
  maximumX: number;
  maximumY: number;
}

interface PaletteEntry {
  red: number;
  green: number;
  blue: number;
  count: number;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000
    + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!
  );
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function inspectPng(bytes: Uint8Array): PngInspection {
  if (bytes.byteLength < 33 || bytes.byteLength > MAX_LOGO_SOURCE_BYTES) {
    throw new Error(`PNG must be between 33 bytes and ${MAX_LOGO_SOURCE_BYTES} bytes`);
  }
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new Error("file does not have a valid PNG signature");
  }
  if (readUint32(bytes, 8) !== 13 || chunkType(bytes, 12) !== "IHDR") {
    throw new Error("PNG must begin with a valid IHDR chunk");
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (
    width < 1
    || height < 1
    || width > MAX_LOGO_DIMENSION
    || height > MAX_LOGO_DIMENSION
    || width * height > MAX_LOGO_DIMENSION * MAX_LOGO_DIMENSION
  ) {
    throw new Error(`PNG dimensions must be within ${MAX_LOGO_DIMENSION}x${MAX_LOGO_DIMENSION}`);
  }

  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32(bytes, offset);
    if (length > bytes.byteLength - offset - 12) throw new Error("PNG contains a truncated chunk");
    const type = chunkType(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (type === "iCCP") {
      throw new Error("PNG with an embedded ICC profile is not supported in pipeline v1");
    }
    if (type === "acTL") {
      throw new Error("animated PNG is not supported for market logos");
    }
    if (type === "gAMA") {
      if (length !== 4 || readUint32(bytes, dataOffset) !== 45_455) {
        throw new Error("PNG uses a non-sRGB gamma profile that pipeline v1 cannot preserve");
      }
    }
    offset += length + 12;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || offset !== bytes.byteLength) throw new Error("PNG has an invalid chunk layout");
  return { width, height };
}

function borderIndexes(width: number, height: number): number[] {
  const indexes: number[] = [];
  for (let x = 0; x < width; x += 1) indexes.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y += 1) indexes.push(y * width, y * width + width - 1);
  return [...new Set(indexes)];
}

function automaticAlpha(
  rgba: Uint8Array,
  width: number,
  height: number,
): { alpha: Uint8Array; backgroundRemoved: boolean } {
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3]!;
  const border = borderIndexes(width, height);
  if (border.some((index) => alpha[index]! < 245)) {
    return { alpha, backgroundRemoved: false };
  }

  const buckets = new Map<number, { count: number; red: number; green: number; blue: number }>();
  for (const index of border) {
    const offset = index * 4;
    const red = rgba[offset]!;
    const green = rgba[offset + 1]!;
    const blue = rgba[offset + 2]!;
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }
  const dominant = [...buckets.entries()].sort((left, right) =>
    right[1].count - left[1].count || left[0] - right[0]
  )[0]?.[1];
  if (!dominant || dominant.count / border.length < 0.45) {
    return { alpha, backgroundRemoved: false };
  }
  const background: Rgb = [
    Math.round(dominant.red / dominant.count),
    Math.round(dominant.green / dominant.count),
    Math.round(dominant.blue / dominant.count),
  ];
  const similarToBackground = (index: number): boolean => {
    const offset = index * 4;
    const red = rgba[offset]! - background[0];
    const green = rgba[offset + 1]! - background[1];
    const blue = rgba[offset + 2]! - background[2];
    return alpha[index]! >= 245 && red * red + green * green + blue * blue <= 2_200;
  };

  const queued = new Uint8Array(width * height);
  const queue: number[] = [];
  for (const index of border) {
    if (!queued[index] && similarToBackground(index)) {
      queued[index] = 1;
      queue.push(index);
    }
  }
  let removed = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]!;
    if (alpha[index] === 0) continue;
    alpha[index] = 0;
    removed += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    const neighbours = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y + 1 < height ? index + width : -1,
    ];
    for (const neighbour of neighbours) {
      if (neighbour < 0 || queued[neighbour] || !similarToBackground(neighbour)) continue;
      queued[neighbour] = 1;
      queue.push(neighbour);
    }
  }
  if (removed === 0 || alpha.every((value) => value === 0)) {
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3]!;
    return { alpha, backgroundRemoved: false };
  }
  return { alpha, backgroundRemoved: true };
}

function opaqueAlpha(rgba: Uint8Array): Uint8Array {
  const alpha = new Uint8Array(rgba.byteLength / 4);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3]!;
  return alpha;
}

function subjectBounds(alpha: Uint8Array, width: number, height: number): Bounds | undefined {
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alpha[y * width + x]! < 24) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  return maximumX < 0 ? undefined : { minimumX, minimumY, maximumX, maximumY };
}

function roundedFiveBit(value: number): number {
  return Math.max(0, Math.min(255, Math.round(Math.round(value * 31 / 255) * 255 / 31)));
}

function paletteFor(pixels: Uint8Array, maximum: number): Rgb[] {
  const counts = new Map<number, PaletteEntry>();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const red = roundedFiveBit(pixels[offset]!);
    const green = roundedFiveBit(pixels[offset + 1]!);
    const blue = roundedFiveBit(pixels[offset + 2]!);
    const key = (red << 16) | (green << 8) | blue;
    const entry = counts.get(key) ?? { red, green, blue, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const entries = [...counts.values()].sort((left, right) =>
    right.count - left.count
    || left.red - right.red
    || left.green - right.green
    || left.blue - right.blue
  );
  if (entries.length <= maximum) return entries.map(({ red, green, blue }) => [red, green, blue]);

  const boxes: PaletteEntry[][] = [entries];
  while (boxes.length < maximum) {
    let selectedIndex = -1;
    let selectedScore = -1;
    for (const [index, box] of boxes.entries()) {
      if (box.length < 2) continue;
      const reds = box.map((entry) => entry.red);
      const greens = box.map((entry) => entry.green);
      const blues = box.map((entry) => entry.blue);
      const range = Math.max(
        Math.max(...reds) - Math.min(...reds),
        Math.max(...greens) - Math.min(...greens),
        Math.max(...blues) - Math.min(...blues),
      );
      const score = range * box.reduce((sum, entry) => sum + entry.count, 0);
      if (score > selectedScore) {
        selectedScore = score;
        selectedIndex = index;
      }
    }
    if (selectedIndex < 0) break;
    const selected = boxes[selectedIndex]!;
    const ranges = [
      Math.max(...selected.map((entry) => entry.red)) - Math.min(...selected.map((entry) => entry.red)),
      Math.max(...selected.map((entry) => entry.green)) - Math.min(...selected.map((entry) => entry.green)),
      Math.max(...selected.map((entry) => entry.blue)) - Math.min(...selected.map((entry) => entry.blue)),
    ];
    const channel = ranges.indexOf(Math.max(...ranges));
    selected.sort((left, right) => {
      const leftValue = channel === 0 ? left.red : channel === 1 ? left.green : left.blue;
      const rightValue = channel === 0 ? right.red : channel === 1 ? right.green : right.blue;
      return leftValue - rightValue || left.red - right.red || left.green - right.green || left.blue - right.blue;
    });
    const total = selected.reduce((sum, entry) => sum + entry.count, 0);
    let cumulative = 0;
    let split = 1;
    for (; split < selected.length; split += 1) {
      cumulative += selected[split - 1]!.count;
      if (cumulative >= total / 2) break;
    }
    boxes.splice(selectedIndex, 1, selected.slice(0, split), selected.slice(split));
  }
  return boxes.map((box): Rgb => {
    const total = box.reduce((sum, entry) => sum + entry.count, 0);
    return [
      Math.round(box.reduce((sum, entry) => sum + entry.red * entry.count, 0) / total),
      Math.round(box.reduce((sum, entry) => sum + entry.green * entry.count, 0) / total),
      Math.round(box.reduce((sum, entry) => sum + entry.blue * entry.count, 0) / total),
    ];
  });
}

function applyPalette(pixels: Uint8Array, maximum = 12): void {
  const palette = paletteFor(pixels, maximum);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    let best = palette[0] ?? [255, 255, 255];
    let distance = Number.POSITIVE_INFINITY;
    for (const candidate of palette) {
      const red = pixels[offset]! - candidate[0];
      const green = pixels[offset + 1]! - candidate[1];
      const blue = pixels[offset + 2]! - candidate[2];
      const next = red * red + green * green + blue * blue;
      if (next < distance) {
        distance = next;
        best = candidate;
      }
    }
    pixels[offset] = best[0];
    pixels[offset + 1] = best[1];
    pixels[offset + 2] = best[2];
  }
}

const TARGET_BLACK_BACKGROUND_LUMINANCE = 68;

function ensureBlackBackgroundContrast(pixels: Uint8Array): boolean {
  let foregroundPixels = 0;
  let luminance = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    foregroundPixels += 1;
    luminance += pixels[offset]! * 0.2126
      + pixels[offset + 1]! * 0.7152
      + pixels[offset + 2]! * 0.0722;
  }
  if (foregroundPixels === 0) return false;
  const average = luminance / foregroundPixels;
  if (average >= TARGET_BLACK_BACKGROUND_LUMINANCE) return false;
  const whiteMix = Math.min(
    1,
    (TARGET_BLACK_BACKGROUND_LUMINANCE - average) / (255 - average),
  );
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    pixels[offset] = Math.round(pixels[offset]! + (255 - pixels[offset]!) * whiteMix);
    pixels[offset + 1] = Math.round(pixels[offset + 1]! + (255 - pixels[offset + 1]!) * whiteMix);
    pixels[offset + 2] = Math.round(pixels[offset + 2]! + (255 - pixels[offset + 2]!) * whiteMix);
  }
  return true;
}

function resizeSubject(
  rgba: Uint8Array,
  alpha: Uint8Array,
  sourceWidth: number,
  bounds: Bounds,
  targetSize: number,
  alphaThreshold: number,
): PixelLogoBitmap {
  const subjectWidth = bounds.maximumX - bounds.minimumX + 1;
  const subjectHeight = bounds.maximumY - bounds.minimumY + 1;
  const scale = Math.min(targetSize / subjectWidth, targetSize / subjectHeight);
  const outputWidth = Math.max(1, Math.min(targetSize, Math.round(subjectWidth * scale)));
  const outputHeight = Math.max(1, Math.min(targetSize, Math.round(subjectHeight * scale)));
  const offsetX = Math.floor((16 - outputWidth) / 2);
  const offsetY = Math.floor((16 - outputHeight) / 2);
  const output = new Uint8Array(16 * 16 * 4);

  for (let outputY = 0; outputY < outputHeight; outputY += 1) {
    const sourceY0 = bounds.minimumY + outputY * subjectHeight / outputHeight;
    const sourceY1 = bounds.minimumY + (outputY + 1) * subjectHeight / outputHeight;
    for (let outputX = 0; outputX < outputWidth; outputX += 1) {
      const sourceX0 = bounds.minimumX + outputX * subjectWidth / outputWidth;
      const sourceX1 = bounds.minimumX + (outputX + 1) * subjectWidth / outputWidth;
      let alphaWeight = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let y = Math.floor(sourceY0); y < Math.ceil(sourceY1); y += 1) {
        const yWeight = Math.max(0, Math.min(sourceY1, y + 1) - Math.max(sourceY0, y));
        for (let x = Math.floor(sourceX0); x < Math.ceil(sourceX1); x += 1) {
          const xWeight = Math.max(0, Math.min(sourceX1, x + 1) - Math.max(sourceX0, x));
          const index = y * sourceWidth + x;
          const weight = xWeight * yWeight * alpha[index]! / 255;
          if (weight <= 0) continue;
          const inputOffset = index * 4;
          alphaWeight += weight;
          red += rgba[inputOffset]! * weight;
          green += rgba[inputOffset + 1]! * weight;
          blue += rgba[inputOffset + 2]! * weight;
        }
      }
      const cellArea = (sourceX1 - sourceX0) * (sourceY1 - sourceY0);
      if (alphaWeight / cellArea < alphaThreshold || alphaWeight === 0) continue;
      const outputOffset = ((offsetY + outputY) * 16 + offsetX + outputX) * 4;
      output[outputOffset] = Math.round(red / alphaWeight);
      output[outputOffset + 1] = Math.round(green / alphaWeight);
      output[outputOffset + 2] = Math.round(blue / alphaWeight);
      output[outputOffset + 3] = 255;
    }
  }
  applyPalette(output);
  ensureBlackBackgroundContrast(output);
  return { width: 16, height: 16, pixels: output };
}

function analyzeBitmap(bitmap: PixelLogoBitmap): {
  foregroundPixels: number;
  paletteSize: number;
  warnings: string[];
} {
  const colors = new Set<number>();
  let foregroundPixels = 0;
  let luminance = 0;
  for (let offset = 0; offset < bitmap.pixels.length; offset += 4) {
    if (bitmap.pixels[offset + 3] === 0) continue;
    foregroundPixels += 1;
    const red = bitmap.pixels[offset]!;
    const green = bitmap.pixels[offset + 1]!;
    const blue = bitmap.pixels[offset + 2]!;
    colors.add((red << 16) | (green << 8) | blue);
    luminance += red * 0.2126 + green * 0.7152 + blue * 0.0722;
  }
  const warnings: string[] = [];
  if (foregroundPixels < 18) warnings.push("主体像素较少，实机上可能过细");
  if (foregroundPixels > 0 && luminance / foregroundPixels < 48) {
    warnings.push("平均亮度较低，请重点检查黑底预览");
  }
  return { foregroundPixels, paletteSize: colors.size, warnings };
}

function variant(
  id: LogoVariantId,
  label: string,
  description: string,
  rgba: Uint8Array,
  alpha: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetSize: number,
  alphaThreshold: number,
  backgroundRemoved: boolean,
): ProcessedLogoVariant | undefined {
  const bounds = subjectBounds(alpha, sourceWidth, sourceHeight);
  if (!bounds) return undefined;
  const bitmap = resizeSubject(
    rgba,
    alpha,
    sourceWidth,
    bounds,
    targetSize,
    alphaThreshold,
  );
  const analysis = analyzeBitmap(bitmap);
  if (analysis.foregroundPixels === 0) return undefined;
  return {
    id,
    label,
    description,
    bitmap,
    pixelSha256: hash(bitmap.pixels),
    ...analysis,
    backgroundRemoved,
  };
}

export function processLogoPng(bytes: Uint8Array): ProcessedLogoSource {
  const inspection = inspectPng(bytes);
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(Buffer.from(bytes));
  } catch {
    throw new Error("PNG cannot be decoded safely");
  }
  if (decoded.width !== inspection.width || decoded.height !== inspection.height) {
    throw new Error("PNG decoded dimensions do not match IHDR");
  }
  const rgba = new Uint8Array(decoded.data);
  const automatic = automaticAlpha(rgba, decoded.width, decoded.height);
  const preserved = opaqueAlpha(rgba);
  const candidates = [
    variant(
      "balanced",
      "平衡",
      "自动识别边缘背景，主体占 14 px，适合多数 Logo。",
      rgba,
      automatic.alpha,
      decoded.width,
      decoded.height,
      14,
      0.24,
      automatic.backgroundRemoved,
    ),
    variant(
      "compact",
      "留白",
      "主体占 12 px，给细节和外轮廓更多安全边。",
      rgba,
      automatic.alpha,
      decoded.width,
      decoded.height,
      12,
      0.18,
      automatic.backgroundRemoved,
    ),
    variant(
      "background",
      "保留底色",
      "不移除原图底色，适合本来就是方形图标的素材。",
      rgba,
      preserved,
      decoded.width,
      decoded.height,
      14,
      0.24,
      false,
    ),
  ].filter((candidate): candidate is ProcessedLogoVariant => Boolean(candidate));

  const seen = new Set<string>();
  const variants = candidates.filter((candidate) => {
    if (seen.has(candidate.pixelSha256)) return false;
    seen.add(candidate.pixelSha256);
    return true;
  });
  if (variants.length === 0) throw new Error("PNG does not contain a visible logo subject");
  return {
    sourceSha256: hash(bytes),
    sourceWidth: decoded.width,
    sourceHeight: decoded.height,
    variants,
  };
}

export function encodePixelLogoPng(bitmap: PixelLogoBitmap): Uint8Array {
  if (bitmap.width !== 16 || bitmap.height !== 16 || bitmap.pixels.byteLength !== 16 * 16 * 4) {
    throw new Error("pixel logo bitmap must be canonical 16x16 RGBA");
  }
  return new Uint8Array(PNG.sync.write({
    width: bitmap.width,
    height: bitmap.height,
    data: Buffer.from(bitmap.pixels),
  } as PNG, { colorType: 6, inputHasAlpha: true }));
}

export function pixelLogoToCanvas(bitmap: PixelLogoBitmap): PixelCanvas {
  const canvas = new PixelCanvas(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const offset = (y * 16 + x) * 4;
      const alpha = bitmap.pixels[offset + 3]! / 255;
      if (alpha <= 0) continue;
      canvas.setPixel(x, y, [
        Math.round(bitmap.pixels[offset]! * alpha),
        Math.round(bitmap.pixels[offset + 1]! * alpha),
        Math.round(bitmap.pixels[offset + 2]! * alpha),
      ]);
    }
  }
  return canvas;
}

function accentFromCanvas(canvas: PixelCanvas): Rgb {
  let brightest: Rgb = [90, 155, 255];
  let score = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const color = canvas.getPixel(x, y);
      const next = color[0] + color[1] + color[2];
      if (next > score) {
        score = next;
        brightest = color;
      }
    }
  }
  return brightest;
}

function samplePrice(instrument: MarketInstrument): number {
  if (instrument.kind === "fx") return 1.1662;
  if (instrument.kind === "metal") return 2_384.7;
  if (instrument.kind === "stock") return 189.42;
  return instrument.decimals > 4 ? 0.12345678 : 101.25;
}

export function renderLogoDevicePreview(
  bitmap: PixelLogoBitmap,
  instrument: MarketInstrument,
): Uint8Array {
  const icon = pixelLogoToCanvas(bitmap);
  const rendered = renderRuntimeMarketDashboard(
    { price: samplePrice(instrument) },
    {
      symbol: instrument.displaySymbol,
      decimals: instrument.decimals,
      accent: accentFromCanvas(icon),
      icon,
    },
    { priceDurationMs: 15_000, changeDurationMs: 500, showChange: false },
  );
  return rendered.frames[0]!.toPng();
}

export function isLogoVariantId(value: unknown): value is LogoVariantId {
  return typeof value === "string" && LOGO_VARIANT_IDS.includes(value as LogoVariantId);
}
