export interface PixelView {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type PixelizeMethod = "mode" | "nearest" | "smooth";
export type PixelCell = number | null;

export interface PixelizeOptions {
  size: number;
  method: PixelizeMethod;
  snap: boolean;
  invert: boolean;
  palette: number[];
}

export interface PixelBlock {
  width: number;
  height: number;
  pixels: PixelCell[];
}

function isBackground(pixel: readonly number[]): boolean {
  return (pixel[3] ?? 0) < 100 || Math.min(pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0) > 200;
}

function pack(red: number, green: number, blue: number): number {
  return (red << 16) | (green << 8) | blue;
}

function unpack(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

function nearestPaletteColor(pixel: readonly number[], palette: number[]): number {
  if (palette.length === 0) return pack(pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0);
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestColor = palette[0] ?? 0;
  for (const color of palette) {
    const [red, green, blue] = unpack(color);
    const distance = ((pixel[0] ?? 0) - red) ** 2
      + ((pixel[1] ?? 0) - green) ** 2
      + ((pixel[2] ?? 0) - blue) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestColor = color;
    }
  }
  return bestColor;
}

/**
 * Crops the non-background subject and reduces it to a movable block.
 * This follows the PixDeck canvas import model: transparent/near-white pixels
 * are background, the output is 8–16 pixels tall and at most 16 pixels wide.
 */
export function pixelizeImage(image: PixelView, options: PixelizeOptions): PixelBlock | null {
  const { width, height, data } = image;
  if (width < 1 || height < 1 || data.length < width * height * 4) return null;

  const pixelAt = (x: number, y: number): [number, number, number, number] => {
    const index = (y * width + x) * 4;
    return [
      data[index] ?? 0,
      data[index + 1] ?? 0,
      data[index + 2] ?? 0,
      data[index + 3] ?? 0,
    ];
  };

  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelAt(x, y);
      const isSubject = options.invert
        ? pixel[3] >= 100 && (pixel[0] + pixel[1] + pixel[2]) / 3 < 128
        : !isBackground(pixel);
      if (!isSubject) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  if (maximumX < 0 || maximumY < 0) return null;

  const subjectWidth = maximumX - minimumX + 1;
  const subjectHeight = maximumY - minimumY + 1;
  const outputHeight = Math.max(1, Math.round(options.size));
  const outputWidth = Math.min(16, Math.round(subjectWidth * outputHeight / subjectHeight));
  if (outputWidth < 1) return null;

  const output: PixelCell[] = new Array(outputWidth * outputHeight).fill(null);
  for (let outputY = 0; outputY < outputHeight; outputY += 1) {
    for (let outputX = 0; outputX < outputWidth; outputX += 1) {
      const sourceX0 = minimumX + Math.floor(outputX * subjectWidth / outputWidth);
      const sourceX1 = Math.max(sourceX0 + 1, minimumX + Math.floor((outputX + 1) * subjectWidth / outputWidth));
      const sourceY0 = minimumY + Math.floor(outputY * subjectHeight / outputHeight);
      const sourceY1 = Math.max(sourceY0 + 1, minimumY + Math.floor((outputY + 1) * subjectHeight / outputHeight));
      let color: PixelCell = null;

      if (options.invert) {
        let subjectCount = 0;
        let backgroundCount = 0;
        for (let y = sourceY0; y < sourceY1; y += 1) {
          for (let x = sourceX0; x < sourceX1; x += 1) {
            const pixel = pixelAt(x, y);
            if (pixel[3] >= 100 && (pixel[0] + pixel[1] + pixel[2]) / 3 < 128) subjectCount += 1;
            else backgroundCount += 1;
          }
        }
        if (subjectCount >= backgroundCount && subjectCount > 0) color = 0xffffff;
      } else if (options.method === "mode") {
        let backgroundCount = 0;
        const votes = new Map<number, number>();
        for (let y = sourceY0; y < sourceY1; y += 1) {
          for (let x = sourceX0; x < sourceX1; x += 1) {
            const pixel = pixelAt(x, y);
            if (isBackground(pixel)) {
              backgroundCount += 1;
              continue;
            }
            const candidate = options.snap
              ? nearestPaletteColor(pixel, options.palette)
              : pack(pixel[0], pixel[1], pixel[2]);
            votes.set(candidate, (votes.get(candidate) ?? 0) + 1);
          }
        }
        let foregroundCount = 0;
        let bestVotes = 0;
        for (const [candidate, count] of votes) {
          foregroundCount += count;
          if (count > bestVotes) {
            bestVotes = count;
            color = candidate;
          }
        }
        if (foregroundCount <= backgroundCount) color = null;
      } else {
        // PixDeck's nearest and smooth modes both sample the center of a cell.
        const centerX = Math.min(maximumX, Math.floor((sourceX0 + sourceX1) / 2));
        const centerY = Math.min(maximumY, Math.floor((sourceY0 + sourceY1) / 2));
        const pixel = pixelAt(centerX, centerY);
        if (!isBackground(pixel)) {
          color = options.snap
            ? nearestPaletteColor(pixel, options.palette)
            : pack(pixel[0], pixel[1], pixel[2]);
        }
      }

      output[outputY * outputWidth + outputX] = color;
    }
  }

  return { width: outputWidth, height: outputHeight, pixels: output };
}
