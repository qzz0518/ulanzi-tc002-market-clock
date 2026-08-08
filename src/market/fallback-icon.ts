import { createHash } from "node:crypto";
import {
  drawPixelText,
  drawPixelText5x7,
  measurePixelText,
  measurePixelText5x7,
  sanitizePixelText,
} from "../pixel-font.ts";
import { PixelCanvas, type Rgb } from "../pixel-ui.ts";
import type { MarketInstrumentDraft } from "./instruments.ts";

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

function compactCode(value: string, maximum = 4): string {
  const code = sanitizePixelText(value.replace(/[^a-zA-Z0-9]/g, ""), maximum);
  return code || "?";
}

function centeredText(canvas: PixelCanvas, text: string, y: number, color: Rgb): void {
  drawPixelText(canvas, text, Math.floor((canvas.width - measurePixelText(text)) / 2), y, color);
}

// 徽章式兜底图标：代码字母尽量大、居中，正下方留 2 px 空隙再压一条暗色底线。
// 字母永远不与装饰相邻，避免笔画被视觉粘连成别的字符。
export function renderInstrumentFallbackIcon(
  instrument: Pick<MarketInstrumentDraft, "canonicalKey" | "kind" | "baseCode" | "quoteCode" | "displaySymbol">,
): PixelCanvas {
  const canvas = new PixelCanvas(16, 16);
  const accent = accentFor(instrument.canonicalKey);
  if (instrument.kind === "fx") {
    centeredText(canvas, compactCode(instrument.baseCode, 3), 2, accent);
    centeredText(canvas, compactCode(instrument.quoteCode, 3), 9, dim(accent));
    return canvas;
  }
  const label = compactCode(instrument.baseCode || instrument.displaySymbol);
  const wide = measurePixelText5x7(label);
  if (wide <= canvas.width) {
    const x = Math.floor((canvas.width - wide) / 2);
    drawPixelText5x7(canvas, label, x, 3, accent);
    canvas.fillRect(x, 12, wide, 1, dim(accent));
    return canvas;
  }
  const width = measurePixelText(label);
  const x = Math.floor((canvas.width - width) / 2);
  drawPixelText(canvas, label, x, 4, accent);
  canvas.fillRect(x, 11, width, 1, dim(accent));
  return canvas;
}
