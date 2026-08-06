import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PixelAssetStore, normalizePixelAssetMedia } from "../src/pixel-asset-store.ts";
import { PixelCanvas, encodePixelAnimation } from "../src/pixel-ui.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function solid(width: number, height: number, color: readonly [number, number, number]): PixelCanvas {
  return new PixelCanvas(width, height, color);
}

describe("imported pixel asset store", () => {
  test("restores an enlarged 52:16 PNG to the full TC002 canvas", async () => {
    const source = new PixelCanvas(104, 32);
    source.fillRect(0, 0, 52, 32, [255, 0, 0]);
    source.fillRect(52, 0, 52, 32, [0, 0, 255]);
    const normalized = normalizePixelAssetMedia("image/png", source.toPng());
    expect(normalized.mimeType).toBe("image/png");
    expect(normalized.frameCount).toBe(1);

    const directory = await mkdtemp(join(tmpdir(), "ulanzi-pixel-assets-"));
    directories.push(directory);
    const store = new PixelAssetStore(directory);
    const metadata = await store.save({
      officialId: "1091",
      title: "Test Castle",
      author: "Tester",
      sourceUrl: "https://ugc.ulanzistudio.com/contentView/1091",
      mimeType: "image/png",
      bytes: source.toPng(),
    });
    const rendered = await store.render(metadata.ref, 1_500);
    expect(rendered.frames).toHaveLength(1);
    expect(rendered.frameDelaysMs).toEqual([1_500]);
    expect(rendered.frames[0]?.getPixel(0, 0)).toEqual([255, 0, 0]);
    expect(rendered.frames[0]?.getPixel(51, 15)).toEqual([0, 0, 255]);
  });

  test("keeps GIF frames and repeats them to fill the content duration", async () => {
    const red = solid(52, 16, [255, 0, 0]);
    const blue = solid(52, 16, [0, 0, 255]);
    const gif = encodePixelAnimation([red, blue], [100, 200]);
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-pixel-assets-"));
    directories.push(directory);
    const store = new PixelAssetStore(directory);
    const metadata = await store.save({
      officialId: "1011",
      title: "Animated Crab",
      author: "Tester",
      sourceUrl: "https://ugc.ulanzistudio.com/contentView/1011",
      mimeType: "image/gif",
      bytes: gif,
    });
    expect(metadata.mimeType).toBe("image/gif");
    expect(metadata.frameCount).toBe(2);
    expect(metadata.nativeDurationMs).toBe(300);

    const rendered = await store.render(metadata.ref, 700);
    expect(rendered.frames.length).toBeGreaterThan(2);
    expect(rendered.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(700);
    expect(rendered.frames[0]?.getPixel(0, 0)).toEqual([255, 0, 0]);
    expect(rendered.frames[1]?.getPixel(0, 0)).toEqual([0, 0, 255]);
  });

  test("rejects artwork that is not in the TC002 aspect ratio", () => {
    expect(() => normalizePixelAssetMedia("image/png", solid(16, 16, [0, 255, 0]).toPng()))
      .toThrow("52:16 aspect ratio");
  });
});
