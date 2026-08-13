import { describe, expect, test } from "bun:test";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas, type Rgb } from "../src/pixel-ui.ts";
import { drawPixelText } from "../src/pixel-font.ts";
import { cjkTextWidth, drawCjkText } from "../src/pixel-cjk.ts";
import type { VisualAnimation } from "../src/visual-effects.ts";
import {
  renderViewfinderClock,
  VIEWFINDER_DEFAULT_PALETTE,
  VIEWFINDER_PALETTES,
  VIEWFINDER_PALETTE_IDS,
  type ViewfinderPaletteId,
} from "../src/visual/viewfinder.ts";
import { CONTENT_DEFINITIONS, createDefaultContentItem } from "../src/content-registry.ts";

// Local-time construction keeps the expected HH:MM and day stable in any zone.
const NOW = new Date(2026, 7, 13, 9, 18, 0).getTime();

const PAPER = VIEWFINDER_PALETTES.paper;
const VIEWFINDER_FIELD = PAPER.field;
const VIEWFINDER_INK = PAPER.ink;
const VIEWFINDER_COLON_SOFT = PAPER.colonSoft;

// 09:18 — the leading "0" sits at x=11. Its bitmap is spelled out here rather
// than imported so the test fails if the glyph table is edited, which is the
// only way an assertion about a font means anything.
const ZERO_GLYPH = [
  ".####.", "######", "##..##", "##..##", "##..##", "##..##",
  "##..##", "##..##", "##..##", "##..##", "######", ".####.",
] as const;

function expectPanelContract(animation: VisualAnimation, durationMs: number): void {
  expect(animation.frames.length).toBeGreaterThan(0);
  expect(animation.frames.length).toBeLessThanOrEqual(90);
  expect(animation.frames.length).toBe(animation.frameDelaysMs.length);
  expect(animation.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(durationMs);
  expect(animation.frameDelaysMs.every((delay) => delay > 0)).toBe(true);
  for (const frame of animation.frames) {
    expect(frame.width).toBe(DISPLAY_WIDTH);
    expect(frame.height).toBe(DISPLAY_HEIGHT);
  }
}

function frameBytes(animation: VisualAnimation): string {
  return animation.frames.map((frame) => Buffer.from(frame.pixels).toString("base64")).join("|");
}

/** Pixels of `color` inside the given box, as "x,y" strings for set equality. */
function inkPixels(
  frame: PixelCanvas,
  color: Rgb,
  box: { x: number; y: number; width: number; height: number },
): string[] {
  const positions: string[] = [];
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const [red, green, blue] = frame.getPixel(x, y);
      if (red === color[0] && green === color[1] && blue === color[2]) {
        positions.push(`${x},${y}`);
      }
    }
  }
  return positions;
}

function overlayPixels(
  draw: (canvas: PixelCanvas) => void,
  box: { x: number; y: number; width: number; height: number },
): string[] {
  const overlay = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  draw(overlay);
  const positions: string[] = [];
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (overlay.getPixel(x, y)[0] > 0) positions.push(`${x},${y}`);
    }
  }
  return positions;
}

// sRGB relative luminance, the standard model, used here for two things the
// palettes are actually judged on: how much light the panel throws into a room,
// and whether a 2px stroke separates from its field.
function channelLuminance(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance([red, green, blue]: Rgb): number {
  return 0.2126 * channelLuminance(red)
    + 0.7152 * channelLuminance(green)
    + 0.0722 * channelLuminance(blue);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [high, low] = luminance(a) >= luminance(b)
    ? [luminance(a), luminance(b)]
    : [luminance(b), luminance(a)];
  return (high + 0.05) / (low + 0.05);
}

/** Panel light output as a percentage of an all-white 832-LED panel. */
function lightOutputPercent(frame: PixelCanvas): number {
  let total = 0;
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) total += luminance(frame.getPixel(x, y));
  }
  return Math.round((total / (DISPLAY_WIDTH * DISPLAY_HEIGHT)) * 1_000) / 10;
}

function paletteFrame(id: ViewfinderPaletteId, phase = 0): PixelCanvas {
  return renderViewfinderClock(2_000, NOW, { temperatureC: 28, palette: id }).frames[phase]!;
}

describe("viewfinder clock", () => {
  test("holds the panel contract, stays deterministic, caps long items at 90 frames", () => {
    const animation = renderViewfinderClock(4_000, NOW, { temperatureC: 28 });
    expectPanelContract(animation, 4_000);
    expect(animation.label).toBe("取景框钟");
    expect(frameBytes(renderViewfinderClock(4_000, NOW, { temperatureC: 28 })))
      .toBe(frameBytes(animation));
    expect(frameBytes(renderViewfinderClock(4_000, NOW + 60_000, { temperatureC: 28 })))
      .not.toBe(frameBytes(animation));
    const long = renderViewfinderClock(600_000, NOW, { temperatureC: 28 });
    expect(long.frames).toHaveLength(90);
    expectPanelContract(long, 600_000);
  });

  test("fills the field with warm paper and insets both brackets one pixel", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28 }).frames[0]!;
    // The very corners stay field: the brackets are inset, not flush.
    for (const [x, y] of [[0, 0], [51, 0], [0, 15], [51, 15]] as const) {
      expect(frame.getPixel(x, y)).toEqual(VIEWFINDER_FIELD);
    }
    // Top-left L: 6px arm along row 1, 5px arm down column 1.
    for (let x = 1; x <= 6; x += 1) expect(frame.getPixel(x, 1)).toEqual(VIEWFINDER_INK);
    for (let y = 1; y <= 5; y += 1) expect(frame.getPixel(1, y)).toEqual(VIEWFINDER_INK);
    // Bottom-right L, the 180° rotation of it.
    for (let x = 45; x <= 50; x += 1) expect(frame.getPixel(x, 14)).toEqual(VIEWFINDER_INK);
    for (let y = 10; y <= 14; y += 1) expect(frame.getPixel(50, y)).toEqual(VIEWFINDER_INK);
  });

  test("draws a 12-row digit, and rows 0 and 15 stay pure field", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28 }).frames[0]!;
    expect(ZERO_GLYPH).toHaveLength(12);
    for (let row = 0; row < 12; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        expect(frame.getPixel(11 + column, 2 + row))
          .toEqual(ZERO_GLYPH[row]![column] === "#" ? VIEWFINDER_INK : VIEWFINDER_FIELD);
      }
    }
    // The time is the full height of the composition minus one row of air at
    // each edge — that margin is what the inset brackets need to read as a frame.
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      expect(frame.getPixel(x, 0)).toEqual(VIEWFINDER_FIELD);
      expect(frame.getPixel(x, 15)).toEqual(VIEWFINDER_FIELD);
    }
  });

  test("breathes the colon on the panel's centre seam instead of blinking it", () => {
    const animation = renderViewfinderClock(4_000, NOW, { temperatureC: 28 });
    const dots = [[25, 5], [26, 5], [25, 6], [26, 6], [25, 9], [26, 9], [25, 10], [26, 10]] as const;
    for (const [x, y] of dots) {
      expect(animation.frames[0]!.getPixel(x, y)).toEqual(VIEWFINDER_INK);
      expect(animation.frames[1]!.getPixel(x, y)).toEqual(VIEWFINDER_COLON_SOFT);
      expect(animation.frames[2]!.getPixel(x, y)).toEqual(VIEWFINDER_INK);
    }
    // Only the colon moves: the digits are byte-identical between the two
    // phases, so the breath cannot be mistaken for the time changing.
    const timeBox = { x: 11, y: 2, width: 30, height: 12 };
    const digitsOnly = (frame: PixelCanvas) =>
      inkPixels(frame, VIEWFINDER_INK, timeBox).filter((at) => {
        const [x, y] = at.split(",").map(Number);
        return !(x! >= 25 && x! <= 26);
      });
    expect(digitsOnly(animation.frames[1]!)).toEqual(digitsOnly(animation.frames[0]!));
  });

  test("right-aligns the temperature and hangs its degree mark above the number", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28.4 }).frames[0]!;
    // The whole right margin, from the digit gutter to the panel edge, above
    // the bottom-right bracket.
    const chipBox = { x: 41, y: 0, width: 11, height: 10 };
    expect(inkPixels(frame, VIEWFINDER_INK, chipBox)).toEqual(
      overlayPixels((canvas) => {
        drawPixelText(canvas, "28", 43, 4, [255, 255, 255], 1, 1);
        canvas.fillRect(48, 1, 2, 2, [255, 255, 255]);
      }, chipBox),
    );
  });

  test("lifts the minus beside the degree mark rather than dropping a digit", () => {
    // "-12" is 11px and the number line holds 7. The sign goes aloft; the two
    // digits stay, because a temperature missing its sign is worse than one
    // whose sign moved.
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: -12 }).frames[0]!;
    const chipBox = { x: 41, y: 0, width: 11, height: 10 };
    expect(inkPixels(frame, VIEWFINDER_INK, chipBox)).toEqual(
      overlayPixels((canvas) => {
        drawPixelText(canvas, "12", 43, 4, [255, 255, 255], 1, 1);
        canvas.fillRect(48, 1, 2, 2, [255, 255, 255]);
        canvas.fillRect(43, 1, 3, 2, [255, 255, 255]);
      }, chipBox),
    );
  });

  test("marks missing weather with an honest -- instead of a fabricated number", () => {
    const frame = renderViewfinderClock(1_000, NOW, {}).frames[0]!;
    const chipBox = { x: 41, y: 0, width: 11, height: 10 };
    expect(inkPixels(frame, VIEWFINDER_INK, chipBox)).toEqual(
      overlayPixels((canvas) => {
        drawPixelText(canvas, "--", 43, 4, [255, 255, 255], 1, 1);
        canvas.fillRect(48, 1, 2, 2, [255, 255, 255]);
      }, chipBox),
    );
    // An off-planet reading is unknown, not clipped.
    const absurd = renderViewfinderClock(1_000, NOW, { temperatureC: 250 }).frames[0]!;
    expect(inkPixels(absurd, VIEWFINDER_INK, chipBox))
      .toEqual(inkPixels(frame, VIEWFINDER_INK, chipBox));
  });

  test("puts the bare day number in the bottom-left corner", () => {
    const frame = renderViewfinderClock(1_000, NOW, { temperatureC: 28 }).frames[0]!;
    const dateBox = { x: 0, y: 8, width: 10, height: 8 };
    expect(inkPixels(frame, VIEWFINDER_INK, dateBox)).toEqual(
      overlayPixels((canvas) => drawPixelText(canvas, "13", 2, 9, [255, 255, 255], 1, 1), dateBox),
    );
    // Unpadded, so a single-digit day is narrower rather than zero-prefixed.
    const ninth = renderViewfinderClock(
      1_000, new Date(2026, 7, 9, 9, 18, 0).getTime(), { temperatureC: 28 },
    ).frames[0]!;
    expect(inkPixels(ninth, VIEWFINDER_INK, dateBox)).toEqual(
      overlayPixels((canvas) => drawPixelText(canvas, "9", 2, 9, [255, 255, 255], 1, 1), dateBox),
    );
  });

  test("keeps both gutters clear of ink even at the widest state", () => {
    // Dec 31 23:59 at -12°C is the widest this face gets: a two-digit day, a
    // sign aloft, and the four widest-stroked digits. Columns 9-10 and 41-42
    // are the collision budget between the time and the two chips, and they
    // are asserted directly because the layout has no slack anywhere else.
    const worst = renderViewfinderClock(
      1_000,
      new Date(2026, 11, 31, 23, 59, 0).getTime(),
      { temperatureC: -12 },
    ).frames[0]!;
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (const x of [9, 10, 41, 42]) {
        expect(worst.getPixel(x, y)).toEqual(VIEWFINDER_FIELD);
      }
    }
  });

  test("shows the weather-effect style notice frame when configuration is missing", () => {
    const animation = renderViewfinderClock(5_000, NOW, { weatherNotice: "未配置" });
    expect(animation.frames).toHaveLength(1);
    expect(animation.frameDelaysMs).toEqual([5_000]);
    expect(animation.label).toBe("取景框钟 · 未配置");
    const expected = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    drawCjkText(
      expected,
      "未配置",
      Math.floor((DISPLAY_WIDTH - cjkTextWidth("未配置")) / 2),
      2,
      [255, 176, 32],
    );
    expect(animation.frames[0]!.pixels).toEqual(expected.pixels);
  });
});

describe("viewfinder palettes", () => {
  test("leaves existing channels on the shipped paper look", () => {
    // No option, an explicit paper, and a garbage id must all produce the same
    // bytes: adding the option must not repaint a single already-saved channel,
    // and an id from a future build must degrade to the default rather than to
    // a black panel.
    const shipped = frameBytes(renderViewfinderClock(4_000, NOW, { temperatureC: 28 }));
    expect(VIEWFINDER_DEFAULT_PALETTE).toBe("paper");
    expect(frameBytes(renderViewfinderClock(4_000, NOW, { temperatureC: 28, palette: "paper" })))
      .toBe(shipped);
    expect(frameBytes(renderViewfinderClock(4_000, NOW, { temperatureC: 28, palette: "chartreuse" })))
      .toBe(shipped);
    expect(PAPER.field).toEqual([200, 191, 164]);
    expect(PAPER.ink).toEqual([84, 88, 41]);
    expect(PAPER.colonSoft).toEqual([142, 140, 103]);
    // Every other palette must actually change the panel.
    for (const id of VIEWFINDER_PALETTE_IDS) {
      if (id === "paper") continue;
      expect(frameBytes(renderViewfinderClock(4_000, NOW, { temperatureC: 28, palette: id })))
        .not.toBe(shipped);
    }
  });

  test("repaints the whole face — field, brackets, digits, chips — in each palette", () => {
    for (const id of VIEWFINDER_PALETTE_IDS) {
      const palette = VIEWFINDER_PALETTES[id];
      const frame = paletteFrame(id);
      // The full "0" bitmap in this palette's own two colours: the swap must
      // reach the glyph interior, not just the background.
      for (let row = 0; row < 12; row += 1) {
        for (let column = 0; column < 6; column += 1) {
          expect(frame.getPixel(11 + column, 2 + row))
            .toEqual(ZERO_GLYPH[row]![column] === "#" ? palette.ink : palette.field);
        }
      }
      // Composition holds in every palette: bare corners, inset brackets,
      // untouched top and bottom rows.
      for (const [x, y] of [[0, 0], [51, 0], [0, 15], [51, 15]] as const) {
        expect(frame.getPixel(x, y)).toEqual(palette.field);
      }
      for (let x = 1; x <= 6; x += 1) expect(frame.getPixel(x, 1)).toEqual(palette.ink);
      for (let y = 10; y <= 14; y += 1) expect(frame.getPixel(50, y)).toEqual(palette.ink);
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        expect(frame.getPixel(x, 0)).toEqual(palette.field);
        expect(frame.getPixel(x, 15)).toEqual(palette.field);
      }
      // The two readouts follow the ink too — a chip left in olive on a red
      // panel is the exact bug a per-palette assertion is here to catch.
      const chipBox = { x: 41, y: 0, width: 11, height: 10 };
      expect(inkPixels(frame, palette.ink, chipBox)).toEqual(
        overlayPixels((canvas) => {
          drawPixelText(canvas, "28", 43, 4, [255, 255, 255], 1, 1);
          canvas.fillRect(48, 1, 2, 2, [255, 255, 255]);
        }, chipBox),
      );
      const dateBox = { x: 0, y: 8, width: 10, height: 8 };
      expect(inkPixels(frame, palette.ink, dateBox)).toEqual(
        overlayPixels((canvas) => drawPixelText(canvas, "13", 2, 9, [255, 255, 255], 1, 1), dateBox),
      );
    }
  });

  test("derives every colon-soft tone as the exact ink/field midpoint", () => {
    const dots = [[25, 5], [26, 5], [25, 6], [26, 6], [25, 9], [26, 9], [25, 10], [26, 10]] as const;
    for (const id of VIEWFINDER_PALETTE_IDS) {
      const palette = VIEWFINDER_PALETTES[id];
      expect(palette.colonSoft).toEqual([
        Math.round((palette.field[0] + palette.ink[0]) / 2),
        Math.round((palette.field[1] + palette.ink[1]) / 2),
        Math.round((palette.field[2] + palette.ink[2]) / 2),
      ]);
      // A midpoint is only useful if it lands between the two, so assert the
      // ordering per channel rather than trusting the arithmetic above.
      for (let channel = 0; channel < 3; channel += 1) {
        const low = Math.min(palette.field[channel]!, palette.ink[channel]!);
        const high = Math.max(palette.field[channel]!, palette.ink[channel]!);
        expect(palette.colonSoft[channel]!).toBeGreaterThanOrEqual(low);
        expect(palette.colonSoft[channel]!).toBeLessThanOrEqual(high);
      }
      // And the derived tone is what the odd second actually paints.
      const even = paletteFrame(id, 0);
      const odd = paletteFrame(id, 1);
      for (const [x, y] of dots) {
        expect(even.getPixel(x, y)).toEqual(palette.ink);
        expect(odd.getPixel(x, y)).toEqual(palette.colonSoft);
      }
    }
  });

  test("orders the palettes brightest to darkest and pins each one's light output", () => {
    // Light output as a share of an all-white panel — the number that decides
    // whether this face can stay on at night. The ladder is the order the
    // studio's select shows, so a new palette cannot be slotted in without
    // measuring where it lands.
    const expected: Record<ViewfinderPaletteId, number> = {
      paper: 38.6,
      cyanotype: 25.4,
      sunset: 16.6,
      amber: 14.2,
      nightvision: 12.5,
      darkroom: 6.1,
    };
    const measured = VIEWFINDER_PALETTE_IDS.map((id) => lightOutputPercent(paletteFrame(id)));
    expect(measured).toEqual(VIEWFINDER_PALETTE_IDS.map((id) => expected[id]));
    for (let index = 1; index < measured.length; index += 1) {
      expect(measured[index]!).toBeLessThan(measured[index - 1]!);
    }
    // The darkest palette is a genuinely different proposition, not a tint:
    // it throws about a sixth of the default's light.
    expect(measured[0]! / measured.at(-1)!).toBeGreaterThan(6);
  });

  test("splits the set into lit-field and ember-ground palettes", () => {
    const lit: ViewfinderPaletteId[] = ["paper", "cyanotype", "sunset"];
    for (const id of lit) {
      // A lit field means all 832 LEDs carry real drive; that is the cost and
      // the whole look of these three.
      const palette = VIEWFINDER_PALETTES[id];
      expect(Math.max(...palette.field)).toBeGreaterThan(100);
      let litLeds = 0;
      const frame = paletteFrame(id);
      for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
        for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
          if (Math.max(...frame.getPixel(x, y)) >= 26) litLeds += 1;
        }
      }
      expect(litLeds).toBe(DISPLAY_WIDTH * DISPLAY_HEIGHT);
    }
    for (const id of ["amber", "nightvision", "darkroom"] as const) {
      const palette = VIEWFINDER_PALETTES[id];
      // The ground is the ink at 7%, computed rather than typed, so the frame
      // still reads as a rectangle without adding to the output.
      for (let channel = 0; channel < 3; channel += 1) {
        expect(palette.field[channel]!).toBe(Math.round(palette.ink[channel]! * 0.07));
      }
      // Only the type burns: the ~263 ink pixels plus nothing else above ember.
      const frame = paletteFrame(id);
      let litLeds = 0;
      for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
        for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
          if (Math.max(...frame.getPixel(x, y)) >= 26) litLeds += 1;
        }
      }
      expect(litLeds).toBe(263);
    }
  });

  test("keeps every palette readable at a 2px stroke", () => {
    // The 12px digits carry a 2px stroke; at LED scale a weak field/ink split
    // is lost to bloom before it is lost to the eye. 胶片米 is the shipped
    // baseline at 4.08, so no palette added later may sit below it.
    // (For the ember-ground palettes this model is pessimistic — its flare term
    // assumes a reflective screen — which only makes the floor safer.)
    const baseline = contrastRatio(PAPER.field, PAPER.ink);
    expect(Math.round(baseline * 100) / 100).toBe(4.08);
    for (const id of VIEWFINDER_PALETTE_IDS) {
      const palette = VIEWFINDER_PALETTES[id];
      expect(contrastRatio(palette.field, palette.ink)).toBeGreaterThanOrEqual(baseline);
      // The breath must be visible against the ink yet still read as the same
      // colon, so the soft tone has to separate from both ends without
      // reaching either.
      expect(contrastRatio(palette.colonSoft, palette.ink)).toBeGreaterThan(1.8);
      expect(contrastRatio(palette.colonSoft, palette.field)).toBeGreaterThan(1.8);
      expect(contrastRatio(palette.colonSoft, palette.ink))
        .toBeLessThan(contrastRatio(palette.field, palette.ink));
    }
  });

  test("offers all six palettes in the studio and routes the choice through the registry", async () => {
    const definition = CONTENT_DEFINITIONS.find((entry) => entry.id === "visual:viewfinder")!;
    const field = definition.options.find((option) => option.key === "viewfinderPalette")!;
    expect(field.type).toBe("select");
    expect(field.label).toBe("配色");
    expect(field.default).toBe("paper");
    expect(field.choices?.map((choice) => choice.value)).toEqual([...VIEWFINDER_PALETTE_IDS]);
    expect(field.choices?.map((choice) => choice.label)).toEqual(
      ["胶片米", "蓝晒", "落霞橙", "琥珀夜", "夜视绿", "暗房红"],
    );
    const context = {
      nowMs: NOW,
      forceRefresh: false,
      async getMarket(): Promise<never> { throw new Error("unused"); },
      async getInstrumentMarket(): Promise<never> { throw new Error("unused"); },
      async getWeather() {
        return {
          latitude: 31.2304,
          longitude: 121.4737,
          condition: "clear" as const,
          weatherCode: 0,
          temperatureC: 28,
          precipitationMm: 0,
          cloudCoverPercent: 5,
          fetchedAt: "2026-08-13T01:18:00Z",
        };
      },
      async getPixelAsset(): Promise<never> { throw new Error("unused"); },
    };
    const render = async (options: Record<string, string>) => {
      const item = createDefaultContentItem(definition.id);
      item.durationMs = 2_000;
      item.options = { ...item.options, ...options };
      const rendered = await definition.render(context, item);
      return rendered.frames[0]!;
    };
    const shipped = await render({});
    expect(shipped.getPixel(0, 0)).toEqual(PAPER.field);
    const darkroom = await render({ viewfinderPalette: "darkroom" });
    expect(darkroom.getPixel(0, 0)).toEqual(VIEWFINDER_PALETTES.darkroom.field);
    expect(darkroom.getPixel(11, 3)).toEqual(VIEWFINDER_PALETTES.darkroom.ink);
    // Unknown ids must not leak through the registry either.
    const unknown = await render({ viewfinderPalette: "chartreuse" });
    expect(unknown.pixels).toEqual(shipped.pixels);
  });
});
