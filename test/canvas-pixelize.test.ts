import { describe, expect, test } from "bun:test";
import {
  applyCropDrag,
  beginCropDrag,
  clampCrop,
  defaultCrop,
  moveCrop,
  pixelizeCrop,
  planPixelize,
  resizeCrop,
  PANEL_ASPECT,
  PANEL_HEIGHT,
  PANEL_WIDTH,
  type CropHandle,
  type CropRatio,
  type CropRect,
  type FitMode,
  type PixelView,
} from "../web/src/lib/canvas-pixelize";

function blank(width: number, height: number): PixelView {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function paint(
  view: PixelView,
  rect: { x: number; y: number; width: number; height: number },
  rgba: [number, number, number, number],
): PixelView {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = (y * view.width + x) * 4;
      view.data[index] = rgba[0];
      view.data[index + 1] = rgba[1];
      view.data[index + 2] = rgba[2];
      view.data[index + 3] = rgba[3];
    }
  }
  return view;
}

function solid(width: number, height: number, rgba: [number, number, number, number]): PixelView {
  return paint(blank(width, height), { x: 0, y: 0, width, height }, rgba);
}

const cell = (pixels: number[], x: number, y: number) => pixels[y * PANEL_WIDTH + x];

/**
 * A picture with structure on both axes and no flat regions, so every stage of
 * the pipeline — area average, levels, saturation, sharpen — contributes to the
 * result and any change to any of them moves the digest.
 */
function textured(width: number, height: number): PixelView {
  const view = blank(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      view.data[index] = (x * 7 + y * 3) % 256;
      view.data[index + 1] = (x * x + y * 11) % 256;
      view.data[index + 2] = (x + y * 5) % 256;
      view.data[index + 3] = 255;
    }
  }
  return view;
}

/** FNV-1a over the packed cells: one number that changes if any cell does. */
function digest(pixels: number[]): string {
  let hash = 0x811c9dc5;
  for (const pixel of pixels) {
    hash ^= pixel;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** Null means "no picture here"; every case below has one, so unwrap loudly. */
function panel(view: PixelView, rect: CropRect, fit?: FitMode): number[] {
  const pixels = pixelizeCrop(view, rect, fit);
  if (!pixels) throw new Error("expected a panel, got null");
  return pixels;
}

/**
 * Replays a real gesture — one pointerdown then a stream of pointermoves, the
 * result of each carried into the next exactly as the component's state does.
 * A drag is where crop bugs live; a single call to resizeCrop cannot see them.
 */
function replayDrag(
  view: PixelView,
  crop: CropRect,
  handle: CropHandle | null,
  down: readonly [number, number],
  moves: readonly (readonly [number, number])[],
  ratio: CropRatio = "panel",
): CropRect[] {
  const started = beginCropDrag(view, crop, handle, down[0], down[1], ratio);
  let live = started.rect;
  const frames = [live];
  for (const [x, y] of moves) {
    // The live rect is passed nowhere: that is the invariant under test.
    live = applyCropDrag(view, started.drag, x, y, ratio);
    frames.push(live);
  }
  return frames;
}

const corners = (rect: CropRect): [number, number][] => [
  [rect.x, rect.y],
  [rect.x + rect.width, rect.y],
  [rect.x, rect.y + rect.height],
  [rect.x + rect.width, rect.y + rect.height],
];

function expectCornerPinned(frames: CropRect[], anchor: readonly [number, number]): void {
  for (const [index, frame] of frames.entries()) {
    const hit = corners(frame).some(([x, y]) =>
      Math.abs(x - anchor[0]) < 1e-6 && Math.abs(y - anchor[1]) < 1e-6);
    if (!hit) {
      throw new Error(
        `frame ${index} lost the anchor (${anchor[0]}, ${anchor[1]}); corners were ` +
        corners(frame).map(([x, y]) => `(${x.toFixed(1)}, ${y.toFixed(1)})`).join(" "),
      );
    }
  }
}

describe("crop geometry", () => {
  test("defaults to the largest panel-shaped rectangle, centred", () => {
    // 400 wide needs 123.08 tall at 13:4, which fits, so width is the whole image.
    const wide = defaultCrop(blank(400, 300));
    expect(wide.width).toBe(400);
    expect(wide.height).toBeCloseTo(400 / PANEL_ASPECT, 10);
    expect(wide.x).toBe(0);
    expect(wide.y).toBeCloseTo((300 - 400 / PANEL_ASPECT) / 2, 10);

    // A panorama is limited by its height instead, and centres horizontally.
    const tall = defaultCrop(blank(400, 40));
    expect(tall.width).toBeCloseTo(40 * PANEL_ASPECT, 10);
    expect(tall.height).toBe(40);
    expect(tall.y).toBe(0);
    expect(tall.x).toBeCloseTo((400 - 40 * PANEL_ASPECT) / 2, 10);
  });

  test("holds the 52:16 ratio when a corner is dragged off-diagonal", () => {
    const view = blank(2000, 2000);
    const start = { x: 100, y: 100, width: 130, height: 40 };
    // Pointer pulled far more vertically than horizontally: the axis the user
    // dragged hardest wins and the other follows, rather than the box going square.
    const tall = resizeCrop(view, start, "se", 240, 240);
    expect(tall.width / tall.height).toBeCloseTo(PANEL_ASPECT, 10);
    expect(tall.height).toBeCloseTo(140, 10);
    expect(tall.width).toBeCloseTo(140 * PANEL_ASPECT, 10);
    // The opposite corner stays pinned.
    expect(tall.x).toBe(100);
    expect(tall.y).toBe(100);

    // …and the other way round: a mostly-sideways drag is driven by the width.
    const wide = resizeCrop(view, start, "se", 900, 140);
    expect(wide.width / wide.height).toBeCloseTo(PANEL_ASPECT, 10);
    expect(wide.width).toBeCloseTo(800, 10);
  });

  test("a corner cannot drag the box off the image, whatever the ratio asks for", () => {
    // Anchored at x=100 on a 400px-wide image, the box can never exceed 300 wide,
    // so a huge diagonal drag is capped by the width, not by the pointer.
    const capped = resizeCrop(blank(400, 300), { x: 100, y: 100, width: 130, height: 40 }, "se", 9000, 9000);
    expect(capped.width).toBeCloseTo(300, 10);
    expect(capped.height).toBeCloseTo(300 / PANEL_ASPECT, 10);
    expect(capped.x + capped.width).toBeLessThanOrEqual(400);
    expect(capped.y + capped.height).toBeLessThanOrEqual(300);
  });

  test("dragging a corner past the opposite one keeps the anchor pinned", () => {
    const view = blank(400, 300);
    const start = { x: 100, y: 100, width: 130, height: 40 };
    const flipped = resizeCrop(view, start, "nw", 30, 60);
    expect(flipped.width / flipped.height).toBeCloseTo(PANEL_ASPECT, 10);
    // "nw" anchors the south-east corner, which was at (230, 140).
    expect(flipped.x + flipped.width).toBeCloseTo(230, 10);
    expect(flipped.y + flipped.height).toBeCloseTo(140, 10);
  });

  test("clamps to the image instead of hanging off an edge", () => {
    const view = blank(400, 300);
    const pushed = moveCrop(view, { x: 0, y: 0, width: 260, height: 80 }, 900, -400);
    expect(pushed.x).toBeCloseTo(140, 10);
    expect(pushed.y).toBe(0);
    expect(pushed.width).toBe(260);

    // Oversized requests shrink to the widest rectangle the image can hold.
    const oversized = clampCrop(view, { x: -50, y: -50, width: 5000, height: 5000 });
    expect(oversized.width).toBeCloseTo(400, 10);
    expect(oversized.height).toBeCloseTo(400 / PANEL_ASPECT, 10);
    expect(oversized.x).toBe(0);
  });

  test("a zero-size drag becomes the minimum box, never a degenerate one", () => {
    const view = blank(400, 300);
    const tiny = clampCrop(view, { x: 10, y: 10, width: 0, height: 0 });
    expect(tiny.width).toBeGreaterThan(0);
    expect(tiny.height).toBeGreaterThan(0);
    expect(tiny.width / tiny.height).toBeCloseTo(PANEL_ASPECT, 10);

    // …and an image smaller than the floor still gets a box that fits inside it.
    const stamp = clampCrop(blank(6, 6), { x: 0, y: 0, width: 0, height: 0 });
    expect(stamp.width).toBeLessThanOrEqual(6);
    expect(stamp.height).toBeLessThanOrEqual(6);
    expect(stamp.width).toBeGreaterThan(0);
  });
});

describe("crop dragging", () => {
  test("classifies a press by where it landed", () => {
    const view = blank(400, 300);
    const crop = { x: 100, y: 100, width: 130, height: 40 };

    const onHandle = beginCropDrag(view, crop, "nw", 101, 101);
    expect(onHandle.drag).toEqual({ kind: "resize", handle: "nw", baseRect: crop });
    expect(onHandle.rect).toEqual(crop);

    const inside = beginCropDrag(view, crop, null, 150, 120);
    expect(inside.drag).toEqual({ kind: "move", grabX: 50, grabY: 20, baseRect: crop });
    expect(inside.rect).toEqual(crop);

    // Empty space starts a fresh box anchored on the pressed pixel, not on the
    // corner of the minimum-size box that gets drawn there.
    const outside = beginCropDrag(view, crop, null, 300, 250);
    expect(outside.drag).toEqual({
      kind: "resize",
      handle: "se",
      baseRect: { x: 300, y: 250, width: 0, height: 0 },
    });
    expect(outside.rect.x).toBe(300);
    expect(outside.rect.y).toBe(250);
  });

  test("a reverse drag from empty space keeps the pressed pixel pinned", () => {
    // The most ordinary marquee there is: press bottom-right, drag up-left. The
    // pressed pixel must stay a corner of the box for the whole gesture — when
    // the anchor was re-read from the live rect it walked (380,280) -> (120,170)
    // in five events and the box slid across the image trailing the cursor.
    const view = blank(400, 300);
    const frames = replayDrag(view, defaultCrop(view), null, [380, 280], [
      [350, 260], [300, 230], [240, 200], [180, 170], [60, 110],
    ]);
    expectCornerPinned(frames, [380, 280]);

    for (const frame of frames) expect(frame.width / frame.height).toBeCloseTo(PANEL_ASPECT, 10);
    // Growing monotonically: each event pulls further from the anchor, so the
    // box may only get bigger. The broken version froze at 97.5 and translated.
    for (let index = 2; index < frames.length; index += 1) {
      expect(frames[index]!.width).toBeGreaterThan(frames[index - 1]!.width);
    }
    // Last event is capped by the left edge (anchor at x=380), not by the pointer.
    expect(frames.at(-1)!.x).toBeCloseTo(0, 10);
    expect(frames.at(-1)!.width).toBeCloseTo(380, 10);
  });

  test("a handle dragged past the opposite corner and back recovers exactly", () => {
    const view = blank(400, 300);
    const crop = { x: 100, y: 100, width: 130, height: 40 };
    // Pull the SE handle left past the NW corner, then throw it back down-right.
    const frames = replayDrag(view, crop, "se", [230, 140], [
      [110, 103], [90, 98], [70, 95], [300, 180],
    ]);
    expectCornerPinned(frames, [100, 100]);
    // Crossing the anchor and coming back must land on the same origin it began
    // with; carrying the live rect forward lost it permanently (70, 90.8).
    const last = frames.at(-1)!;
    expect(last.x).toBeCloseTo(100, 10);
    expect(last.y).toBeCloseTo(100, 10);
    expect(last.width).toBeCloseTo(260, 10);
  });

  test("a move drag never changes size and is reversible", () => {
    const view = blank(400, 300);
    const crop = { x: 100, y: 100, width: 130, height: 40 };
    // Out past two edges, then back to the pixel that was grabbed.
    const frames = replayDrag(view, crop, null, [150, 120], [
      [40, 30], [-500, -500], [900, 900], [150, 120],
    ]);
    for (const frame of frames) {
      expect(frame.width).toBeCloseTo(130, 10);
      expect(frame.height).toBeCloseTo(40, 10);
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.x + frame.width).toBeLessThanOrEqual(400 + 1e-9);
      expect(frame.y + frame.height).toBeLessThanOrEqual(300 + 1e-9);
    }
    // Clamping at the edges must not eat the grab offset on the way back.
    expect(frames.at(-1)!.x).toBeCloseTo(100, 10);
    expect(frames.at(-1)!.y).toBeCloseTo(100, 10);
  });

  test("every frame of a drag depends only on the pointer, not on history", () => {
    // The property behind all of the above: replaying the same gesture with
    // extra intermediate events must land on the same rectangle.
    const view = blank(640, 480);
    const crop = defaultCrop(view);
    const coarse = replayDrag(view, crop, "nw", [0, 60], [[300, 200], [80, 40]]);
    const fine = replayDrag(view, crop, "nw", [0, 60], [
      [100, 90], [300, 200], [420, 300], [10, 10], [80, 40],
    ]);
    expect(fine.at(-1)).toEqual(coarse.at(-1)!);
  });
});

describe("crop pixelization", () => {
  test("always fills exactly one 52x16 panel", () => {
    const view = solid(200, 200, [10, 20, 30, 255]);
    expect(panel(view, defaultCrop(view))).toHaveLength(PANEL_WIDTH * PANEL_HEIGHT);
    expect(panel(view, { x: 0, y: 0, width: 4, height: 1 })).toHaveLength(
      PANEL_WIDTH * PANEL_HEIGHT,
    );
  });

  test("a crop over a solid region is that exact colour, end to end", () => {
    // Two blocks side by side; cropping only the right one must not leak the left.
    const view = solid(200, 100, [0, 0, 255, 255]);
    paint(view, { x: 100, y: 0, width: 100, height: 100 }, [255, 0, 0, 255]);
    const pixels = panel(view, { x: 100, y: 20, width: 100, height: 100 / PANEL_ASPECT });
    expect(new Set(pixels)).toEqual(new Set([0xff0000]));
  });

  test("a crop straddling two blocks maps each side to its own half", () => {
    const view = solid(104, 32, [0, 0, 255, 255]);
    paint(view, { x: 52, y: 0, width: 52, height: 32 }, [255, 255, 0, 255]);
    const pixels = panel(view, { x: 0, y: 0, width: 104, height: 32 });
    expect(cell(pixels, 2, 8)).toBe(0x0000ff);
    expect(cell(pixels, 49, 8)).toBe(0xffff00);
  });

  test("clamps at the image edge instead of sampling out of bounds", () => {
    const view = solid(60, 20, [0, 200, 100, 255]);
    // A rect that starts past the right edge and runs well beyond it.
    const pixels = panel(view, { x: 55, y: 18, width: 400, height: 123 });
    expect(pixels).toHaveLength(PANEL_WIDTH * PANEL_HEIGHT);
    expect(pixels.every((pixel) => pixel === 0x00c864)).toBe(true);
  });

  test("survives a one-pixel-tall crop and a zero-extent crop", () => {
    const view = solid(60, 20, [200, 40, 40, 255]);
    for (const rect of [
      { x: 0, y: 5, width: 60, height: 1 },
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 30, y: 10, width: Number.NaN, height: Number.NaN },
    ]) {
      const pixels = panel(view, rect);
      expect(pixels).toHaveLength(PANEL_WIDTH * PANEL_HEIGHT);
      expect(pixels.every((pixel) => Number.isFinite(pixel) && pixel >= 0 && pixel <= 0xffffff)).toBe(true);
    }
  });

  test("composites transparency over black, the panel's off state", () => {
    const view = blank(64, 32);
    paint(view, { x: 0, y: 0, width: 32, height: 32 }, [255, 255, 255, 255]);
    const pixels = panel(view, { x: 0, y: 0, width: 64, height: 64 / PANEL_ASPECT });
    expect(cell(pixels, 4, 8)).toBe(0xffffff);
    expect(cell(pixels, 47, 8)).toBe(0x000000);
  });

  test("area-averages the region rather than sampling one pixel per cell", () => {
    // 1px checkerboard: every output cell covers many source pixels, so an
    // average lands on grey. A nearest sample would give pure black or white.
    const view = blank(520, 160);
    for (let y = 0; y < 160; y += 1) {
      for (let x = 0; x < 520; x += 1) {
        const shade = (x + y) % 2 === 0 ? 255 : 0;
        paint(view, { x, y, width: 1, height: 1 }, [shade, shade, shade, 255]);
      }
    }
    const pixels = panel(view, { x: 0, y: 0, width: 520, height: 160 });
    for (const pixel of pixels) {
      const red = (pixel >> 16) & 0xff;
      expect(red).toBeGreaterThan(96);
      expect(red).toBeLessThan(160);
    }
  });

  test("lifts a washed-out photo's contrast without inventing detail", () => {
    // A gradient squeezed into 110..150 — the mid-grey mush an average produces.
    const view = blank(520, 160);
    for (let x = 0; x < 520; x += 1) {
      const shade = Math.round(110 + x / 519 * 40);
      paint(view, { x, y: 0, width: 1, height: 160 }, [shade, shade, shade, 255]);
    }
    const pixels = panel(view, { x: 0, y: 0, width: 520, height: 160 });
    const first = (cell(pixels, 0, 8) ?? 0) >> 16 & 0xff;
    const last = (cell(pixels, PANEL_WIDTH - 1, 8) ?? 0) >> 16 & 0xff;
    // Input spread was 40 levels; the gain cap allows at most 1.6x of that.
    expect(last - first).toBeGreaterThan(45);
    expect(last - first).toBeLessThanOrEqual(Math.round(40 * 1.6) + 12);
    // Monotonic left to right: the ramp is stretched, not re-ordered.
    for (let x = 1; x < PANEL_WIDTH; x += 1) {
      expect((cell(pixels, x, 8) ?? 0) >> 16 & 0xff).toBeGreaterThanOrEqual(
        (cell(pixels, x - 1, 8) ?? 0) >> 16 & 0xff,
      );
    }
  });

  test("leaves a saturated primary alone instead of clipping it to a new hue", () => {
    // The saturation lift must not push pure red out of gamut and back as orange.
    const view = solid(200, 80, [255, 0, 0, 255]);
    const pixels = panel(view, defaultCrop(view));
    expect(new Set(pixels)).toEqual(new Set([0xff0000]));
  });

  test("keeps a saturated dark colour coloured instead of crushing it to black", () => {
    // Blue scores 18/255 on luminance but 255 on its own channel. A luminance
    // stretch pins it to the black point and a blue-on-yellow graphic comes back
    // black on yellow, which is the whole reason levels run on the peak channel.
    const view = solid(208, 64, [255, 240, 0, 255]);
    paint(view, { x: 0, y: 0, width: 104, height: 64 }, [0, 0, 255, 255]);
    const pixels = panel(view, { x: 0, y: 0, width: 208, height: 64 });
    const left = cell(pixels, 4, 8) ?? 0;
    expect(left & 0xff).toBeGreaterThan(200);
    expect((left >> 16) & 0xff).toBeLessThan(40);
    expect((cell(pixels, 47, 8) ?? 0) >> 16 & 0xff).toBeGreaterThan(200);
  });

  test("refuses an unusable buffer instead of returning a black panel", () => {
    // 832 black cells look exactly like a successful generate, so the caller
    // would paint them over the user's artwork and report success.
    const empty: PixelView = { width: 0, height: 0, data: new Uint8ClampedArray(0) };
    expect(pixelizeCrop(empty, { x: 0, y: 0, width: 10, height: 3 })).toBeNull();
    // The signature of a decode that silently produced nothing: right-sized
    // buffer, every pixel transparent. A big photo on iOS Safari hits this when
    // the canvas exceeds ~16.7M px, which is what DECODE_MAX_EDGE prevents.
    expect(pixelizeCrop(blank(400, 300), defaultCrop(blank(400, 300)))).toBeNull();
  });

  test("refuses a crop that framed only transparency, not one that framed black", () => {
    // The distinction matters: a black region of a photo is a real picture and
    // must still generate. Only "there is nothing here" may refuse.
    const view = blank(400, 200);
    paint(view, { x: 0, y: 0, width: 200, height: 200 }, [0, 0, 0, 255]);
    expect(pixelizeCrop(view, { x: 240, y: 40, width: 130, height: 40 })).toBeNull();

    const opaqueBlack = panel(view, { x: 20, y: 40, width: 130, height: 40 });
    expect(opaqueBlack).toHaveLength(PANEL_WIDTH * PANEL_HEIGHT);
    expect(new Set(opaqueBlack)).toEqual(new Set([0x000000]));

    // A crop straddling the edge still has signal, so it generates.
    expect(pixelizeCrop(view, { x: 150, y: 40, width: 130, height: 40 })).not.toBeNull();
  });
});

describe("the untouched default path", () => {
  /**
   * Digests taken from the build before the ratio and fit controls existed.
   * A user who opens neither control must get the same 832 cells they always
   * got, so these are frozen: if one moves, the default path moved with it and
   * the change is a regression until proven otherwise.
   */
  const GOLDEN: readonly (readonly [number, number, string])[] = [
    [300, 300, "8e053215"],
    // 400x123 is 3.2520:1 — near enough to the panel that the default crop is
    // 399.75 wide, whose ratio is only 13:4 to within a rounding step. Cover
    // must treat that as "already panel-shaped" and cut nothing; shaving a
    // sub-pixel off it moves every cell boundary in the image.
    [400, 123, "b6f4e539"],
    [640, 480, "4ae120a5"],
    [40, 40, "ace261d"],
  ];

  test("renders every fixture exactly as it did before fit modes existed", () => {
    for (const [width, height, expected] of GOLDEN) {
      const view = textured(width, height);
      expect(digest(panel(view, defaultCrop(view)))).toBe(expected);
    }
  });

  test("spelling the defaults out loud changes nothing", () => {
    for (const [width, height] of GOLDEN) {
      const view = textured(width, height);
      expect(defaultCrop(view, "panel")).toEqual(defaultCrop(view));
      const crop = defaultCrop(view);
      expect(pixelizeCrop(view, crop, "cover")).toEqual(panel(view, crop));
    }
  });

  test("cover leaves a panel-locked box alone when its ratio only rounds to 13:4", () => {
    // A panel box gets its height by dividing by 3.25, and for 445 of the first
    // 4000 integer widths multiplying back does not land on the width exactly —
    // these are eight of them. The residue is ~1e-12, but a cover that treats
    // it as "needs cutting" re-centres every default crop by a hair and every
    // cell boundary with it, which is a silent change to every existing image.
    for (const width of [15, 27, 30, 54, 57, 63, 107, 113]) {
      const crop = defaultCrop(blank(width, width * 4));
      expect(crop.width * PANEL_HEIGHT - crop.height * PANEL_WIDTH).not.toBe(0);
      const plan = planPixelize(crop, "cover");
      expect(plan.source).toEqual(crop);
      expect(plan.cropped).toBe(false);
      expect(plan.padding).toBe("none");
    }
  });

  test("a panel-shaped selection is left alone by every mode that can", () => {
    const view = textured(640, 480);
    const crop = defaultCrop(view);
    // Cover has nothing to cut and contain has nothing to letterbox, so all
    // three modes agree — the only shape for which that is true.
    expect(pixelizeCrop(view, crop, "contain")).toEqual(panel(view, crop));
    expect(pixelizeCrop(view, crop, "stretch")).toEqual(panel(view, crop));

    const plan = planPixelize(crop);
    expect(plan.source).toEqual(crop);
    expect(plan.cropped).toBe(false);
    expect(plan.padding).toBe("none");
    expect(plan.destination).toEqual({ x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT });
  });
});

describe("selection ratios", () => {
  test("square frames the whole of a square picture, which panel never can", () => {
    const icon = blank(512, 512);
    const panelCrop = defaultCrop(icon, "panel");
    // The complaint: a 3.25:1 box on a square logo reaches a band through the
    // middle and nothing else. 157 of 512 rows, top and bottom unreachable.
    expect(panelCrop.height).toBeCloseTo(512 / PANEL_ASPECT, 10);
    expect(panelCrop.height).toBeLessThan(icon.height / 3);

    const squareCrop = defaultCrop(icon, "square");
    expect(squareCrop).toEqual({ x: 0, y: 0, width: 512, height: 512 });
    expect(defaultCrop(icon, "free")).toEqual({ x: 0, y: 0, width: 512, height: 512 });
  });

  test("square on a wide picture is the largest centred square", () => {
    const crop = defaultCrop(blank(400, 300), "square");
    expect(crop).toEqual({ x: 50, y: 0, width: 300, height: 300 });
  });

  test("a free corner drag moves the two axes independently", () => {
    const view = blank(2000, 2000);
    const start = { x: 100, y: 100, width: 130, height: 40 };
    const dragged = resizeCrop(view, start, "se", 900, 240, "free");
    // Panel would have taken the harder-pulled axis for both; free takes each
    // axis from its own pointer distance.
    expect(dragged.width).toBeCloseTo(800, 10);
    expect(dragged.height).toBeCloseTo(140, 10);
    expect(resizeCrop(view, start, "se", 900, 240).height).toBeCloseTo(800 / PANEL_ASPECT, 10);
  });

  test("a square corner drag stays square whichever way it is pulled", () => {
    const view = blank(2000, 2000);
    const start = { x: 100, y: 100, width: 130, height: 130 };
    for (const [x, y] of [[900, 240], [240, 900], [600, 600]] as const) {
      const dragged = resizeCrop(view, start, "se", x, y, "square");
      expect(dragged.width).toBeCloseTo(dragged.height, 10);
    }
  });

  test("every ratio stays inside the picture and above the floor", () => {
    const view = blank(400, 300);
    for (const ratio of ["panel", "free", "square"] as const) {
      const huge = clampCrop(view, { x: -80, y: -80, width: 9000, height: 9000 }, ratio);
      expect(huge.x).toBeGreaterThanOrEqual(0);
      expect(huge.y).toBeGreaterThanOrEqual(0);
      expect(huge.x + huge.width).toBeLessThanOrEqual(400 + 1e-9);
      expect(huge.y + huge.height).toBeLessThanOrEqual(300 + 1e-9);

      // A press with no drag at all is a mis-click, not a request for a zero box.
      const nothing = clampCrop(view, { x: 10, y: 10, width: 0, height: 0 }, ratio);
      expect(nothing.width).toBeGreaterThan(0);
      expect(nothing.height).toBeGreaterThan(0);

      // …and a picture smaller than the floor still gets a box that fits in it.
      const stamp = clampCrop(blank(6, 6), { x: 0, y: 0, width: 0, height: 0 }, ratio);
      expect(stamp.width).toBeLessThanOrEqual(6);
      expect(stamp.height).toBeLessThanOrEqual(6);
      expect(stamp.width).toBeGreaterThan(0);
      expect(stamp.height).toBeGreaterThan(0);
    }
  });

  test("only free lets a corner-to-corner marquee keep the corners", () => {
    const view = blank(300, 300);
    const small = { x: 100, y: 100, width: 50, height: 50 };
    // The same gesture — press one corner of the picture, drag to the other —
    // under each lock. Free takes it literally; panel can only answer with the
    // band the ratio allows, which is the whole of the user's complaint.
    const free = replayDrag(view, small, null, [0, 0], [[299, 299]], "free").at(-1)!;
    expect(free.width).toBeCloseTo(299, 10);
    expect(free.height).toBeCloseTo(299, 10);

    const locked = replayDrag(view, small, null, [0, 0], [[299, 299]]).at(-1)!;
    expect(locked.height).toBeLessThan(view.height / 3);
    expect(locked.width / locked.height).toBeCloseTo(PANEL_ASPECT, 10);

    const square = replayDrag(view, small, null, [0, 0], [[299, 299]], "square").at(-1)!;
    expect(square.width).toBeCloseTo(square.height, 10);
    expect(square.width).toBeCloseTo(299, 10);
  });
});

describe("fit modes", () => {
  test("contain centres a square in the panel and leaves the sides dark", () => {
    const plan = planPixelize({ x: 0, y: 0, width: 512, height: 512 }, "contain");
    expect(plan.destination).toEqual({ x: 18, y: 0, width: 16, height: 16 });
    expect(plan.padding).toBe("sides");
    expect(plan.cropped).toBe(false);
    // Nothing is thrown away: the source is the selection, whole.
    expect(plan.source).toEqual({ x: 0, y: 0, width: 512, height: 512 });
  });

  test("cover cuts the selection down to the panel's shape, centred", () => {
    const square = planPixelize({ x: 0, y: 0, width: 512, height: 512 }, "cover");
    expect(square.cropped).toBe(true);
    expect(square.source.width).toBe(512);
    expect(square.source.height).toBeCloseTo(512 / PANEL_ASPECT, 10);
    expect(square.source.y).toBeCloseTo((512 - 512 / PANEL_ASPECT) / 2, 10);
    expect(square.padding).toBe("none");

    // A selection wider than the panel loses its sides instead.
    const banner = planPixelize({ x: 0, y: 0, width: 1000, height: 100 }, "cover");
    expect(banner.source.width).toBeCloseTo(325, 10);
    expect(banner.source.x).toBeCloseTo(337.5, 10);
    expect(banner.source.height).toBe(100);
  });

  test("stretch keeps the whole selection and the whole panel, and distorts", () => {
    const plan = planPixelize({ x: 4, y: 8, width: 512, height: 512 }, "stretch");
    expect(plan.source).toEqual({ x: 4, y: 8, width: 512, height: 512 });
    expect(plan.destination).toEqual({ x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT });
    expect(plan.cropped).toBe(false);
    expect(plan.padding).toBe("none");
  });

  test("contain reports the letterbox on whichever axes are short", () => {
    // Taller than the panel is wide: bars on the sides.
    expect(planPixelize({ x: 0, y: 0, width: 100, height: 400 }, "contain").padding).toBe("sides");
    // 4:1 is wider than 3.25:1, so the panel fills across and bars appear above
    // and below: 52 columns, 13 rows.
    const wide = planPixelize({ x: 0, y: 0, width: 400, height: 100 }, "contain");
    expect(wide.destination).toEqual({ x: 0, y: 1, width: 52, height: 13 });
    expect(wide.padding).toBe("bands");
  });

  test("contain always touches one edge, so it never darkens both axes", () => {
    // The invariant behind the padding union having no "both": the scale is
    // chosen to make one extent exact, so a shape that letterboxes on all four
    // sides cannot exist and the readout never has to describe one.
    for (let width = 1; width <= 400; width += 1) {
      for (const height of [1, 7, 16, 53, 160, 399]) {
        const { destination, padding } = planPixelize({ x: 0, y: 0, width, height }, "contain");
        expect(destination.width === PANEL_WIDTH || destination.height === PANEL_HEIGHT).toBe(true);
        expect(destination.width).toBeGreaterThanOrEqual(1);
        expect(destination.height).toBeGreaterThanOrEqual(1);
        expect(destination.x + destination.width).toBeLessThanOrEqual(PANEL_WIDTH);
        expect(destination.y + destination.height).toBeLessThanOrEqual(PANEL_HEIGHT);
        // And the label the UI picks always matches the geometry it describes.
        expect(padding).toBe(
          destination.width < PANEL_WIDTH ? "sides" : destination.height < PANEL_HEIGHT ? "bands" : "none",
        );
      }
    }
  });

  test("a square icon lands centred, whole, and undistorted", () => {
    // A 32x32 white block centred in a 64x64 icon: at 4 source pixels per cell
    // it must come back as an 8x8 block, equal on both axes, or the fit
    // squashed it.
    const icon = solid(64, 64, [0, 0, 0, 255]);
    paint(icon, { x: 16, y: 16, width: 32, height: 32 }, [255, 255, 255, 255]);
    const pixels = panel(icon, defaultCrop(icon, "square"), "contain");

    const lit = (x: number, y: number) => ((cell(pixels, x, y) ?? 0) >> 16 & 0xff) > 128;
    const litColumns = Array.from({ length: PANEL_WIDTH }, (_, x) => x).filter((x) => lit(x, 8));
    const litRows = Array.from({ length: PANEL_HEIGHT }, (_, y) => y).filter((y) => lit(22, y));
    expect(litColumns).toEqual([22, 23, 24, 25, 26, 27, 28, 29]);
    expect(litRows).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);

    // The 18 columns either side are off, not dark grey, not a smear.
    for (let y = 0; y < PANEL_HEIGHT; y += 1) {
      for (const x of [0, 17, 34, PANEL_WIDTH - 1]) expect(cell(pixels, x, y)).toBe(0x000000);
    }
  });

  test("the dark surround never reaches the tone pipeline", () => {
    // Flat mid-grey has no range to stretch, so it must come back untouched.
    // Sampling into a 52x16 buffer and blacking the bars afterwards would put a
    // 0..120 histogram in front of the levels pass and lift the grey to 0xc0.
    const grey = solid(64, 64, [120, 120, 120, 255]);
    const pixels = panel(grey, defaultCrop(grey, "square"), "contain");
    expect(cell(pixels, 26, 8)).toBe(0x787878);
    expect(cell(pixels, 4, 8)).toBe(0x000000);
  });

  test("every fit mode survives the degenerate selections", () => {
    for (const fit of ["cover", "contain", "stretch"] as const) {
      // A source narrower than the panel itself, so cells are smaller than one
      // source pixel; a 1px band; a press with no drag; a box off the edge; and
      // a picture already at exactly 52:16.
      const cases: readonly (readonly [PixelView, CropRect])[] = [
        [solid(20, 20, [200, 40, 40, 255]), { x: 0, y: 0, width: 20, height: 20 }],
        [solid(60, 20, [200, 40, 40, 255]), { x: 0, y: 5, width: 60, height: 1 }],
        [solid(60, 20, [200, 40, 40, 255]), { x: 0, y: 0, width: 0, height: 0 }],
        [solid(60, 20, [200, 40, 40, 255]), { x: 30, y: 10, width: Number.NaN, height: Number.NaN }],
        [solid(60, 20, [200, 40, 40, 255]), { x: -50, y: -50, width: 5000, height: 5000 }],
        [solid(520, 160, [200, 40, 40, 255]), { x: 0, y: 0, width: 520, height: 160 }],
      ];
      for (const [view, rect] of cases) {
        const pixels = pixelizeCrop(view, rect, fit);
        expect(pixels).toHaveLength(PANEL_WIDTH * PANEL_HEIGHT);
        expect(pixels!.every((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel <= 0xffffff))
          .toBe(true);
        // Whatever the geometry decided, at least one cell has to carry the
        // picture — a plan that letterboxes everything away is a blank panel.
        expect(pixels!.some((pixel) => pixel !== 0)).toBe(true);
      }
    }
  });

  test("the reduction factor stays the number the panel path always quoted", () => {
    // The chip has always read crop.width / 52. Nothing about the default path
    // may change that, and on a shape that does not distort one factor is still
    // the whole truth.
    const view = textured(640, 480);
    const crop = defaultCrop(view);
    const plan = planPixelize(crop);
    expect(plan.shrink.x).toBeCloseTo(crop.width / PANEL_WIDTH, 10);
    expect(plan.shrink.uniform).toBe(true);
    expect(planPixelize({ x: 0, y: 0, width: 512, height: 512 }, "contain").shrink.uniform).toBe(true);
  });

  test("a distorting fit refuses to be described by one number", () => {
    // Stretch squeezes 512 rows into 16 and 512 columns into 52 — 32x against
    // 9.8x. Quoting only the width would tell the user the picture keeps three
    // times more detail than it does.
    const stretched = planPixelize({ x: 0, y: 0, width: 512, height: 512 }, "stretch");
    expect(stretched.shrink.x).toBeCloseTo(512 / 52, 10);
    expect(stretched.shrink.y).toBeCloseTo(32, 10);
    expect(stretched.shrink.uniform).toBe(false);

    // Contain distorts too once a row cannot be split any finer: a 1px band is
    // 52x1, so the axes disagree wildly and the readout has to say so.
    const band = planPixelize({ x: 0, y: 0, width: 1000, height: 1 }, "contain");
    expect(band.destination).toEqual({ x: 0, y: 7, width: 52, height: 1 });
    expect(band.shrink.uniform).toBe(false);
  });

  test("a 52:16 source is a fixed point of the plan under every mode", () => {
    const rect = { x: 0, y: 0, width: 520, height: 160 };
    for (const fit of ["cover", "contain", "stretch"] as const) {
      const plan = planPixelize(rect, fit);
      expect(plan.source).toEqual(rect);
      expect(plan.destination).toEqual({ x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT });
      expect(plan.cropped).toBe(false);
      expect(plan.padding).toBe("none");
    }
  });
});
