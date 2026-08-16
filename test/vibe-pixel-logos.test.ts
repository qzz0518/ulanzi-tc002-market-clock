import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  VIBE_PIXEL_LOGO_IDS,
  VIBE_PIXEL_LOGOS,
  type PixelLogoRgba,
  type VibePixelLogo,
} from "../src/vibe/vibe-pixel-logos.ts";

const SIZE = 16;
const ASSET_DIR = join(import.meta.dir, "../src/assets/vibe-icons/pixel");

function rgbaAt(png: PNG, x: number, y: number): PixelLogoRgba {
  const offset = (y * png.width + x) * 4;
  return [
    png.data[offset]!,
    png.data[offset + 1]!,
    png.data[offset + 2]!,
    png.data[offset + 3]!,
  ];
}

describe("reusable 16x16 VIBE pixel logos", () => {
  test("the pack contains only the four requested providers", () => {
    expect(VIBE_PIXEL_LOGO_IDS).toEqual(["claude", "codex", "opencode", "grok"]);
    expect(Object.keys(VIBE_PIXEL_LOGOS)).toEqual([...VIBE_PIXEL_LOGO_IDS]);
    expect(readdirSync(ASSET_DIR).filter((file) => file.endsWith(".png")).sort()).toEqual([
      "claude.png",
      "codex.png",
      "grok.png",
      "opencode.png",
    ]);
  });

  test("every source grid is exactly 16x16 and uses declared colours", () => {
    for (const id of VIBE_PIXEL_LOGO_IDS) {
      const logo: VibePixelLogo = VIBE_PIXEL_LOGOS[id];
      expect(logo.rows, id).toHaveLength(SIZE);
      for (const row of logo.rows) {
        expect(row, `${id}: ${row}`).toHaveLength(SIZE);
        for (const cell of row) {
          expect(cell === "." || logo.palette[cell] !== undefined, `${id}: ${cell}`).toBe(true);
        }
      }
    }
  });

  test("the checked-in PNGs are transparent, native-size and pixel-exact", () => {
    for (const id of VIBE_PIXEL_LOGO_IDS) {
      const logo: VibePixelLogo = VIBE_PIXEL_LOGOS[id];
      const png = PNG.sync.read(readFileSync(join(ASSET_DIR, `${id}.png`)));
      expect([png.width, png.height], id).toEqual([SIZE, SIZE]);

      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const cell = logo.rows[y]![x]!;
          const expected: PixelLogoRgba = cell === "."
            ? [0, 0, 0, 0]
            : logo.palette[cell]!;
          expect(rgbaAt(png, x, y), `${id} (${x},${y})`).toEqual(expected);
        }
      }
    }
  });

  test("the silhouettes retain their identifying negative space", () => {
    const claude = PNG.sync.read(readFileSync(join(ASSET_DIR, "claude.png")));
    expect(rgbaAt(claude, 4, 5)[3]).toBe(0); // left eye
    expect(rgbaAt(claude, 11, 5)[3]).toBe(0); // right eye

    const opencode = PNG.sync.read(readFileSync(join(ASSET_DIR, "opencode.png")));
    expect(rgbaAt(opencode, 7, 7)[3]).toBe(0); // hollow centre
    // x=3, not 2: the frame was pulled in a ring and thinned to 2 px because at
    // its original weight it dominated the other three marks on the panel. The
    // claim this test makes — hollow centre, solid frame — is unchanged.
    expect(rgbaAt(opencode, 3, 7)[3]).toBe(255); // frame
    expect(rgbaAt(opencode, 2, 7)[3]).toBe(0); // and it no longer reaches x=2

    const codex = PNG.sync.read(readFileSync(join(ASSET_DIR, "codex.png")));
    const codexTones = new Set<number>();
    for (let offset = 0; offset < codex.data.length; offset += 4) {
      if (codex.data[offset + 3] !== 0) codexTones.add(codex.data[offset]!);
    }
    expect(codexTones.size).toBe(3);
  });
});
