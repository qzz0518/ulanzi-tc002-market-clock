import { createHash } from "node:crypto";
import { drawPixelText, measurePixelText, sanitizePixelText } from "../pixel-font.ts";
import { PixelCanvas, type Rgb } from "../pixel-ui.ts";
import type { MarketInstrumentDraft, MarketInstrumentKind } from "./instruments.ts";

const ACCENTS: readonly Rgb[] = [
  [255, 176, 32],
  [75, 205, 255],
  [80, 224, 138],
  [205, 117, 255],
  [255, 103, 139],
  [244, 221, 83],
  [90, 155, 255],
  [255, 135, 74],
];

function accentFor(key: string): Rgb {
  const digest = createHash("sha256").update(key).digest();
  return ACCENTS[digest[0]! % ACCENTS.length]!;
}

function dim(color: Rgb): Rgb {
  return [Math.round(color[0] * 0.56), Math.round(color[1] * 0.56), Math.round(color[2] * 0.56)];
}

function compactCode(value: string, maximum = 3): string {
  const code = sanitizePixelText(value.replace(/[^a-zA-Z0-9]/g, ""), maximum);
  return code || "?";
}

function centeredText(canvas: PixelCanvas, text: string, y: number, color: Rgb): void {
  drawPixelText(canvas, text, Math.floor((canvas.width - measurePixelText(text)) / 2), y, color);
}

function drawKindCorners(canvas: PixelCanvas, kind: MarketInstrumentKind, color: Rgb): void {
  const lengths: Record<MarketInstrumentKind, number> = { crypto: 3, fx: 4, metal: 5, stock: 2 };
  const length = lengths[kind];
  canvas.fillRect(0, 0, length, 1, color);
  canvas.fillRect(0, 0, 1, length, color);
  canvas.fillRect(16 - length, 15, length, 1, color);
  canvas.fillRect(15, 16 - length, 1, length, color);
}

export function renderInstrumentFallbackIcon(
  instrument: Pick<MarketInstrumentDraft, "canonicalKey" | "kind" | "baseCode" | "quoteCode" | "displaySymbol">,
): PixelCanvas {
  const canvas = new PixelCanvas(16, 16);
  const accent = accentFor(instrument.canonicalKey);
  drawKindCorners(canvas, instrument.kind, dim(accent));
  if (instrument.kind === "fx") {
    centeredText(canvas, compactCode(instrument.baseCode), 2, accent);
    centeredText(canvas, compactCode(instrument.quoteCode), 9, dim(accent));
    return canvas;
  }
  const label = compactCode(instrument.baseCode || instrument.displaySymbol);
  centeredText(canvas, label, 5, accent);
  if (instrument.kind === "metal") {
    canvas.fillRect(4, 12, 8, 1, dim(accent));
  } else if (instrument.kind === "stock") {
    canvas.fillRect(3, 12, 10, 1, dim(accent));
    canvas.setPixel(5, 11, accent);
    canvas.setPixel(8, 10, accent);
    canvas.setPixel(11, 8, accent);
  } else {
    canvas.setPixel(7, 12, accent);
    canvas.setPixel(8, 12, accent);
  }
  return canvas;
}
