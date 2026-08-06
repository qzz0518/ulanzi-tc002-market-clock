import { deflateSync } from "node:zlib";
import { GIFEncoder, applyPalette } from "gifenc";
import { getAssetPreset, type AssetId, type ChangePeriod } from "./assets.ts";
import type { AssetMarketData } from "./price.ts";
import type { DashboardSettings } from "./settings.ts";

export type Rgb = readonly [number, number, number];

const WIDTH = 52;
const HEIGHT = 16;

// Background RGB zero is intentional: black pixels must switch LEDs fully off.
const COLORS = {
  background: [0, 0, 0] as Rgb,
  price: [202, 218, 230] as Rgb,
  green: [35, 194, 101] as Rgb,
  red: [226, 65, 82] as Rgb,
  neutral: [128, 145, 160] as Rgb,
  offline: [224, 153, 26] as Rgb,
  dim: [76, 82, 88] as Rgb,
  btc: [235, 133, 20] as Rgb,
  ethCircle: [236, 239, 240] as Rgb,
  ethMid: [130, 131, 132] as Rgb,
  ethDark: [47, 48, 48] as Rgb,
  ethBlack: [19, 19, 19] as Rgb,
  bnb: [240, 185, 11] as Rgb,
  bnbMark: [255, 255, 255] as Rgb,
  solPurple: [147, 72, 222] as Rgb,
  solBlue: [67, 139, 219] as Rgb,
  solGreen: [42, 194, 149] as Rgb,
  goldLight: [243, 213, 91] as Rgb,
  gold: [240, 196, 25] as Rgb,
  goldOrange: [242, 156, 31] as Rgb,
} as const;

const GIF_PALETTE: number[][] = [
  [...COLORS.background],
  [...COLORS.price],
  [...COLORS.green],
  [...COLORS.red],
  [...COLORS.neutral],
  [...COLORS.offline],
  [...COLORS.dim],
  [...COLORS.btc],
  [...COLORS.ethCircle],
  [...COLORS.ethMid],
  [...COLORS.ethDark],
  [...COLORS.ethBlack],
  [...COLORS.bnb],
  [...COLORS.bnbMark],
  [...COLORS.solPurple],
  [...COLORS.solBlue],
  [...COLORS.solGreen],
  [...COLORS.gold],
  [...COLORS.goldLight],
  [...COLORS.goldOrange],
];

export class PixelCanvas {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb = COLORS.background,
  ) {
    this.pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) this.setPixel(x, y, background);
    }
  }

  setPixel(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 4;
    this.pixels[offset] = color[0];
    this.pixels[offset + 1] = color[1];
    this.pixels[offset + 2] = color[2];
    this.pixels[offset + 3] = 255;
  }

  fillRect(x: number, y: number, width: number, height: number, color: Rgb): void {
    for (let py = y; py < y + height; py += 1) {
      for (let px = x; px < x + width; px += 1) this.setPixel(px, py, color);
    }
  }

  toPng(): Uint8Array {
    return encodePng(this.width, this.height, this.pixels);
  }
}

type Font = Record<string, readonly string[]>;

const ICON_FONT: Font = {
  C: ["111", "100", "100", "100", "111"],
  D: ["110", "101", "101", "101", "110"],
  N: ["1001", "1101", "1011", "1001", "1001"],
  S: ["111", "100", "111", "001", "111"],
  U: ["101", "101", "101", "101", "111"],
  Y: ["101", "101", "010", "010", "010"],
};

const PERIOD_FONT: Font = {
  "1": ["010", "110", "010", "010", "111"],
  "2": ["110", "001", "010", "100", "111"],
  "4": ["101", "101", "111", "001", "001"],
  D: ["110", "101", "101", "101", "110"],
  H: ["101", "101", "111", "101", "101"],
};

const OFFLINE_FONT: Font = {
  O: [
    "01110",
    "11011",
    "11011",
    "11011",
    "11011",
    "11011",
    "11011",
    "11011",
    "01110",
  ],
  F: [
    "11111",
    "11111",
    "11000",
    "11000",
    "11110",
    "11110",
    "11000",
    "11000",
    "11000",
  ],
};

function glyphWidth(pattern: readonly string[]): number {
  return pattern[0]?.length ?? 0;
}

function measureText(text: string, font: Font, spacing = 1, scale = 1): number {
  let width = 0;
  for (const [index, character] of [...text].entries()) {
    const pattern = font[character];
    if (!pattern) throw new Error(`unsupported pixel glyph: ${character}`);
    width += glyphWidth(pattern) * scale;
    if (index < text.length - 1) width += spacing;
  }
  return width;
}

function drawText(
  canvas: PixelCanvas,
  text: string,
  font: Font,
  x: number,
  y: number,
  color: Rgb,
  spacing = 1,
  scale = 1,
): void {
  let cursor = x;
  for (const character of text) {
    const pattern = font[character];
    if (!pattern) throw new Error(`unsupported pixel glyph: ${character}`);
    for (let row = 0; row < pattern.length; row += 1) {
      for (let column = 0; column < pattern[row]!.length; column += 1) {
        if (pattern[row]![column] !== "1") continue;
        canvas.fillRect(
          cursor + column * scale,
          y + row * scale,
          scale,
          scale,
          color,
        );
      }
    }
    cursor += glyphWidth(pattern) * scale + spacing;
  }
}

function fillMask(
  canvas: PixelCanvas,
  mask: readonly string[],
  x: number,
  y: number,
  color: Rgb,
): void {
  for (let row = 0; row < mask.length; row += 1) {
    for (let column = 0; column < mask[row]!.length; column += 1) {
      if (mask[row]![column] === "1") canvas.setPixel(x + column, y + row, color);
    }
  }
}

function fillMappedMask(
  canvas: PixelCanvas,
  mask: readonly string[],
  x: number,
  y: number,
  colors: Readonly<Record<string, Rgb>>,
): void {
  for (let row = 0; row < mask.length; row += 1) {
    for (let column = 0; column < mask[row]!.length; column += 1) {
      const color = colors[mask[row]![column]!];
      if (color) canvas.setPixel(x + column, y + row, color);
    }
  }
}

const COIN_MASK = [
  "000111111000",
  "011111111110",
  "111111111111",
  "111111111111",
  "111111111111",
  "111111111111",
  "111111111111",
  "111111111111",
  "111111111111",
  "111111111111",
  "011111111110",
  "000111111000",
] as const;

function drawBitcoinIcon(canvas: PixelCanvas, x: number, y: number, dimmed: boolean): void {
  fillMask(canvas, COIN_MASK, x, y, dimmed ? COLORS.dim : COLORS.btc);
  const mark = dimmed ? COLORS.neutral : COLORS.price;
  canvas.fillRect(x + 4, y + 1, 2, 10, mark);
  canvas.fillRect(x + 3, y + 3, 5, 2, mark);
  canvas.fillRect(x + 3, y + 6, 5, 2, mark);
  canvas.fillRect(x + 3, y + 9, 5, 2, mark);
  canvas.fillRect(x + 7, y + 4, 2, 2, mark);
  canvas.fillRect(x + 7, y + 7, 2, 2, mark);
}

function drawEthereumIcon(canvas: PixelCanvas, x: number, y: number): void {
  // Reference-locked 14x14 reduction: pale roundel with the four grayscale
  // facets from the user's Ethereum asset icon.
  const diamond = [
    "0000CCCCCC0000",
    "000CCCCMCCC000",
    "00CCCCMDCCCC00",
    "0CCCCCMDMCCCC0",
    "CCCCCMMDDCCCCC",
    "CCCCCMMDDDCCCC",
    "CCCCMDDKKKMCCC",
    "CCCCMDDKKDMCCC",
    "CCCCMMMDMMCCCC",
    "CCCCCMMMDMCCCC",
    "0CCCCCMDDCCCC0",
    "00CCCCMDCCCC00",
    "000CCCCMCCC000",
    "0000CCCCCC0000",
  ];
  fillMappedMask(canvas, diamond, x, y, {
    C: COLORS.ethCircle,
    M: COLORS.ethMid,
    D: COLORS.ethDark,
    K: COLORS.ethBlack,
  });
}

function drawBnbIcon(canvas: PixelCanvas, x: number, y: number): void {
  // Reference-locked 14x14 reduction: official yellow roundel and white cube.
  const logomark = [
    "0000YYYYYY0000",
    "000YYYYYYYY000",
    "00YYYYYYYYYY00",
    "0YYYYWWWWYYYY0",
    "YYYWYYYYYYWYYY",
    "YYYWYWYYWYWYYY",
    "YYYYYWWWWYYYYY",
    "YYYWYYWWYYWYYY",
    "YYYWYYWWYYWYYY",
    "YYYWWYWWYWWYYY",
    "0YYYYYWWYYYYY0",
    "00YYYYYYYYYY00",
    "000YYYYYYYY000",
    "0000YYYYYY0000",
  ];
  fillMappedMask(canvas, logomark, x, y, {
    Y: COLORS.bnb,
    W: COLORS.bnbMark,
  });
}

function drawSolanaIcon(canvas: PixelCanvas, x: number, y: number): void {
  const bars = [
    "0PPPPPPPPP00",
    "00PPPPPPPPP0",
    "000PPPPPPPPP",
    "000000000000",
    "000BBBBBBBBB",
    "00BBBBBBBBB0",
    "0BBBBBBBBB00",
    "000000000000",
    "0GGGGGGGGG00",
    "00GGGGGGGGG0",
    "000GGGGGGGGG",
    "000000000000",
  ];
  fillMappedMask(canvas, bars, x, y, {
    P: COLORS.solPurple,
    B: COLORS.solBlue,
    G: COLORS.solGreen,
  });
}

function drawGoldIcon(canvas: PixelCanvas, x: number, y: number): void {
  // Reference-locked 14x14 reduction of the user's diagonal gold bar.
  const bar = [
    "00000000000000",
    "000000000GG000",
    "00000000GGGGD0",
    "000000DGGGGLL0",
    "00000DGGGGLLLL",
    "0000DGGGGLLLL0",
    "000DGGGGLLLL00",
    "00GGGGLLLLL000",
    "0DDGGLLLLL0000",
    "0DDDGLLLD00000",
    "DDDDDLLD000000",
    "0DDDDLD0000000",
    "000DDD00000000",
    "00000000000000",
  ];
  fillMappedMask(canvas, bar, x, y, {
    L: COLORS.goldLight,
    G: COLORS.gold,
    D: COLORS.goldOrange,
  });
}

function drawUsdCnyIcon(canvas: PixelCanvas, x: number, y: number): void {
  drawText(canvas, "USD", ICON_FONT, x + 1, y, COLORS.price);
  drawText(canvas, "CNY", ICON_FONT, x, y + 7, COLORS.red);
}

export function drawAssetIcon(
  canvas: PixelCanvas,
  assetId: AssetId,
  x = 1,
  y = 2,
  dimmed = false,
): void {
  if (assetId === "btc") return drawBitcoinIcon(canvas, x, y, dimmed);
  if (dimmed) return drawBitcoinIcon(canvas, x, y, true);
  if (assetId === "eth") return drawEthereumIcon(canvas, x - 1, y - 1);
  if (assetId === "bnb") return drawBnbIcon(canvas, x - 1, y - 1);
  if (assetId === "sol") return drawSolanaIcon(canvas, x, y);
  if (assetId === "gold") return drawGoldIcon(canvas, x - 1, y - 1);
  drawUsdCnyIcon(canvas, x, y);
}

function assetAccent(assetId: AssetId): Rgb {
  if (assetId === "btc") return COLORS.btc;
  if (assetId === "eth") return COLORS.ethCircle;
  if (assetId === "bnb") return COLORS.bnb;
  if (assetId === "sol") return COLORS.solGreen;
  if (assetId === "gold") return COLORS.goldLight;
  return COLORS.price;
}

const DIGIT_SEGMENTS: Record<string, readonly string[]> = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "g", "e", "d"],
  "3": ["a", "b", "g", "c", "d"],
  "4": ["f", "g", "b", "c"],
  "5": ["a", "f", "g", "c", "d"],
  "6": ["a", "f", "g", "e", "c", "d"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
};

function drawSevenSegmentDigit(
  canvas: PixelCanvas,
  digit: string,
  x: number,
  y: number,
  width: 5 | 6,
  color: Rgb,
): void {
  const segments = DIGIT_SEGMENTS[digit];
  if (!segments) throw new Error(`unsupported numeric glyph: ${digit}`);
  const horizontalWidth = width - 2;
  const rightX = x + width - 2;
  const definitions: Record<string, readonly [number, number, number, number]> = {
    a: [x + 1, y, horizontalWidth, 2],
    b: [rightX, y + 1, 2, 4],
    c: [rightX, y + 6, 2, 4],
    d: [x + 1, y + 9, horizontalWidth, 2],
    e: [x, y + 6, 2, 4],
    f: [x, y + 1, 2, 4],
    g: [x + 1, y + 4, horizontalWidth, 2],
  };
  for (const segment of segments) {
    const [segmentX, segmentY, segmentWidth, segmentHeight] = definitions[segment]!;
    canvas.fillRect(segmentX, segmentY, segmentWidth, segmentHeight, color);
  }
}

function numericGlyphWidth(character: string, digitWidth: 5 | 6): number {
  if (/\d/.test(character)) return digitWidth;
  if (character === ".") return 2;
  throw new Error(`unsupported numeric glyph: ${character}`);
}

function measureNumericText(text: string, digitWidth: 5 | 6): number {
  return [...text].reduce(
    (width, character, index) => width + numericGlyphWidth(character, digitWidth) + (index > 0 ? 1 : 0),
    0,
  );
}

function drawNumericText(
  canvas: PixelCanvas,
  text: string,
  x: number,
  y: number,
  digitWidth: 5 | 6,
  color: Rgb,
): void {
  let cursor = x;
  for (const character of text) {
    if (character === ".") canvas.fillRect(cursor, y + 9, 2, 2, color);
    else drawSevenSegmentDigit(canvas, character, cursor, y, digitWidth, color);
    cursor += numericGlyphWidth(character, digitWidth) + 1;
  }
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  const absolute = Math.min(Math.abs(value), 999);
  if (absolute >= 10) return `${sign}${Math.round(absolute)}%`;
  return `${sign}${absolute.toFixed(1)}%`;
}

function trendColor(changePercent: number): Rgb {
  if (changePercent > 0.005) return COLORS.green;
  if (changePercent < -0.005) return COLORS.red;
  return COLORS.neutral;
}

function trendGlyphWidth(character: string): number {
  if (/\d/.test(character)) return 5;
  if (character === ".") return 2;
  if (["+", "-", "%"].includes(character)) return 5;
  throw new Error(`unsupported trend glyph: ${character}`);
}

function measureTrendText(text: string): number {
  return [...text].reduce(
    (width, character, index) => width + trendGlyphWidth(character) + (index > 0 ? 1 : 0),
    0,
  );
}

function drawTrendGlyph(
  canvas: PixelCanvas,
  character: string,
  x: number,
  y: number,
  color: Rgb,
): void {
  if (/\d/.test(character)) return drawSevenSegmentDigit(canvas, character, x, y, 5, color);
  if (character === "+") {
    canvas.fillRect(x + 2, y + 2, 2, 7, color);
    canvas.fillRect(x, y + 4, 5, 2, color);
    return;
  }
  if (character === "-") {
    canvas.fillRect(x, y + 4, 5, 2, color);
    return;
  }
  if (character === ".") {
    canvas.fillRect(x, y + 9, 2, 2, color);
    return;
  }
  if (character === "%") {
    canvas.fillRect(x, y, 2, 3, color);
    canvas.fillRect(x + 3, y + 8, 2, 3, color);
    canvas.fillRect(x + 4, y + 1, 1, 2, color);
    canvas.fillRect(x + 3, y + 3, 1, 2, color);
    canvas.fillRect(x + 2, y + 5, 1, 2, color);
    canvas.fillRect(x + 1, y + 7, 1, 2, color);
    return;
  }
  throw new Error(`unsupported trend glyph: ${character}`);
}

function drawTrendText(
  canvas: PixelCanvas,
  text: string,
  x: number,
  y: number,
  color: Rgb,
): void {
  let cursor = x;
  for (const character of text) {
    drawTrendGlyph(canvas, character, cursor, y, color);
    cursor += trendGlyphWidth(character) + 1;
  }
}

export function formatAssetValue(assetId: AssetId, price: number): string {
  if (!Number.isFinite(price) || price <= 0) throw new Error("price must be positive");
  const preset = getAssetPreset(assetId);
  const decimals = price >= 10_000 ? 0 : preset.decimals;
  return price.toFixed(decimals);
}

function renderPriceFrame(market: AssetMarketData): PixelCanvas {
  const canvas = new PixelCanvas(WIDTH, HEIGHT);
  let label = formatAssetValue(market.assetId, market.price);
  let digitWidth: 5 | 6 = measureNumericText(label, 6) <= 35 ? 6 : 5;
  let width = measureNumericText(label, digitWidth);
  while (width > 50 && label.includes(".")) {
    label = Number(label).toFixed(Math.max(0, label.split(".")[1]!.length - 1));
    width = measureNumericText(label, digitWidth);
  }
  if (width <= 35) drawAssetIcon(canvas, market.assetId);
  drawNumericText(canvas, label, Math.max(1, WIDTH - 1 - width), 3, digitWidth, COLORS.price);
  return canvas;
}

function renderChangeFrame(
  assetId: AssetId,
  changePercent: number,
  period: ChangePeriod,
): PixelCanvas {
  const canvas = new PixelCanvas(WIDTH, HEIGHT);
  drawText(canvas, period, PERIOD_FONT, 1, 3, assetAccent(assetId), 1, 2);
  const label = formatPercent(changePercent);
  const width = measureTrendText(label);
  drawTrendText(canvas, label, WIDTH - 1 - width, 3, trendColor(changePercent));
  return canvas;
}

function encodeGif(
  frames: readonly PixelCanvas[],
  frameDelaysMs: readonly number[],
): Uint8Array {
  if (frames.length === 0) throw new Error("GIF requires at least one frame");
  if (frames.length !== frameDelaysMs.length) {
    throw new Error("each GIF frame requires an explicit delay");
  }
  const gif = GIFEncoder();
  for (const [index, frame] of frames.entries()) {
    if (frame.width !== WIDTH || frame.height !== HEIGHT) {
      throw new Error(`GIF frame must be ${WIDTH}x${HEIGHT}`);
    }
    gif.writeFrame(applyPalette(frame.pixels, GIF_PALETTE), WIDTH, HEIGHT, {
      ...(index === 0 ? { palette: GIF_PALETTE, repeat: 0 } : {}),
      delay: frameDelaysMs[index],
      dispose: 1,
    });
  }
  gif.finish();
  return gif.bytes();
}

export interface RenderedDashboard {
  frames: readonly PixelCanvas[];
  frameDelaysMs: readonly number[];
  image: Uint8Array;
  mimeType: "image/gif" | "image/png";
  label: string;
  assetIds: readonly AssetId[];
  animationDurationMs: number;
}

export function renderDashboard(
  markets: readonly AssetMarketData[],
  settings: DashboardSettings,
): RenderedDashboard {
  const marketById = new Map(markets.map((market) => [market.assetId, market]));
  const frames: PixelCanvas[] = [];
  const frameDelaysMs: number[] = [];
  const renderedMarkets: AssetMarketData[] = [];

  for (const assetId of settings.assets) {
    const market = marketById.get(assetId);
    if (!market) continue;
    renderedMarkets.push(market);
    frames.push(renderPriceFrame(market));
    frameDelaysMs.push(settings.priceDurationMs);
    if (
      settings.showChange &&
      market.changePercent !== undefined &&
      market.changePeriod !== undefined
    ) {
      frames.push(renderChangeFrame(assetId, market.changePercent, market.changePeriod));
      frameDelaysMs.push(settings.changeDurationMs);
    }
  }

  if (frames.length === 0) throw new Error("no selected asset has market data");
  const animationDurationMs = frameDelaysMs.reduce((sum, delay) => sum + delay, 0);
  const image = frames.length === 1 ? frames[0]!.toPng() : encodeGif(frames, frameDelaysMs);
  return {
    frames,
    frameDelaysMs,
    image,
    mimeType: frames.length === 1 ? "image/png" : "image/gif",
    label: renderedMarkets
      .map((market) => `${getAssetPreset(market.assetId).symbol} ${formatAssetValue(market.assetId, market.price)}`)
      .join(" · "),
    assetIds: renderedMarkets.map((market) => market.assetId),
    animationDurationMs,
  };
}

export function renderOfflineDashboard(): RenderedDashboard {
  const canvas = new PixelCanvas(WIDTH, HEIGHT);
  drawAssetIcon(canvas, "btc", 1, 2, true);
  const label = "OFFLINE";
  const width = measureText("OFF", OFFLINE_FONT, 1);
  drawText(canvas, "OFF", OFFLINE_FONT, WIDTH - 1 - width, 3, COLORS.offline);
  return {
    frames: [canvas],
    frameDelaysMs: [30_000],
    image: canvas.toPng(),
    mimeType: "image/png",
    label,
    assetIds: [],
    animationDurationMs: 30_000,
  };
}

export function renderAssetIconTile(assetId: AssetId): PixelCanvas {
  const canvas = new PixelCanvas(16, 16);
  drawAssetIcon(canvas, assetId, 2, 2);
  return canvas;
}

function copyScaledCanvas(
  target: PixelCanvas,
  source: PixelCanvas,
  offsetX: number,
  offsetY: number,
  scale: number,
): void {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      const color: Rgb = [
        source.pixels[offset]!,
        source.pixels[offset + 1]!,
        source.pixels[offset + 2]!,
      ];
      target.fillRect(offsetX + x * scale, offsetY + y * scale, scale, scale, color);
    }
  }
}

export function createScaledPreview(canvas: PixelCanvas, scale = 12): Uint8Array {
  if (!Number.isInteger(scale) || scale < 1 || scale > 64) {
    throw new Error("preview scale must be an integer between 1 and 64");
  }
  const preview = new PixelCanvas(canvas.width * scale, canvas.height * scale);
  copyScaledCanvas(preview, canvas, 0, 0, scale);
  return preview.toPng();
}

export function createPreviewStrip(
  frames: readonly PixelCanvas[],
  scale = 12,
  gap = 2 * scale,
): Uint8Array {
  if (frames.length === 0) throw new Error("preview requires at least one frame");
  if (!Number.isInteger(scale) || scale < 1 || scale > 64) {
    throw new Error("preview scale must be an integer between 1 and 64");
  }
  if (!Number.isInteger(gap) || gap < 0) throw new Error("preview gap must be non-negative");
  const width = frames.reduce((sum, frame) => sum + frame.width * scale, 0)
    + gap * (frames.length - 1);
  const height = Math.max(...frames.map((frame) => frame.height * scale));
  const preview = new PixelCanvas(width, height);
  let offsetX = 0;
  for (const frame of frames) {
    copyScaledCanvas(preview, frame, offsetX, 0, scale);
    offsetX += frame.width * scale + gap;
  }
  return preview.toPng();
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
  return chunk;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (1 + width * 4);
    scanlines[rowOffset] = 0;
    Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(
      scanlines,
      rowOffset + 1,
    );
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", new Uint8Array()),
  ]);
}
