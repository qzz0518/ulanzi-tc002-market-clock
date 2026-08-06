import { describe, expect, test } from "bun:test";
import { pixelizeImage, type PixelView } from "../web/src/lib/canvas-pixelize";

function solid(width: number, height: number, rgba: [number, number, number, number]): PixelView {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = rgba[0];
    data[index * 4 + 1] = rgba[1];
    data[index * 4 + 2] = rgba[2];
    data[index * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

describe("canvas image pixelization", () => {
  test("keeps a solid subject color and aspect ratio", () => {
    const block = pixelizeImage(solid(4, 4, [255, 0, 0, 255]), {
      size: 4,
      method: "nearest",
      snap: false,
      invert: false,
      palette: [],
    });
    expect(block).not.toBeNull();
    expect(block?.width).toBe(4);
    expect(block?.height).toBe(4);
    expect(block?.pixels[0]).toBe(0xff0000);
  });

  test("returns null for a transparent background", () => {
    expect(pixelizeImage(solid(4, 4, [0, 0, 0, 0]), {
      size: 4,
      method: "nearest",
      snap: false,
      invert: false,
      palette: [],
    })).toBeNull();
  });

  test("snaps a nearby color to the closest palette entry", () => {
    const block = pixelizeImage(solid(4, 4, [250, 8, 4, 255]), {
      size: 4,
      method: "nearest",
      snap: true,
      invert: false,
      palette: [0xff0000, 0x0000ff],
    });
    expect(block?.pixels[0]).toBe(0xff0000);
  });

  test("can treat a dark icon as the subject", () => {
    const block = pixelizeImage(solid(4, 4, [0, 0, 0, 255]), {
      size: 4,
      method: "mode",
      snap: true,
      invert: true,
      palette: [0xffffff],
    });
    expect(block?.pixels.every((pixel) => pixel === 0xffffff)).toBe(true);
  });
});
