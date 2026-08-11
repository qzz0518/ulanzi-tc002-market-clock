import { describe, expect, test } from "bun:test";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas } from "../src/pixel-ui.ts";
import { drawPixelText, measurePixelText } from "../src/pixel-font.ts";
import {
  renderVisualEffect,
  solarPosition,
  type VisualAnimation,
} from "../src/visual-effects.ts";
import { cjkTextWidth, drawCjkText } from "../src/pixel-cjk.ts";

const NOW = Date.parse("2026-08-10T09:36:00Z");

function litCount(frame: PixelCanvas): number {
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const [red, green, blue] = frame.getPixel(x, y);
      if (red + green + blue > 0) count += 1;
    }
  }
  return count;
}

function expectPanelContract(animation: VisualAnimation, durationMs: number): void {
  expect(animation.frames.length).toBeGreaterThan(0);
  expect(animation.frames.length).toBeLessThanOrEqual(120);
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

describe("visual effects", () => {
  test("matrix clock does not cover the rain with a green time backing panel", () => {
    const animation = renderVisualEffect(
      "matrixclock",
      1_000,
      Date.parse("2026-08-07T00:36:00Z"),
    );

    const labelWidth = measurePixelText("00:36", 2, 2);
    const labelX = Math.floor((DISPLAY_WIDTH - labelWidth) / 2);
    let backingPixelCount = 0;
    let dimmedRainPixelCount = 0;

    for (const frame of animation.frames) {
      for (let y = 0; y < frame.height; y += 1) {
        for (let x = 0; x < frame.width; x += 1) {
          const [red, green, blue] = frame.getPixel(x, y);
          if (red === 0 && green === 8 && blue === 0) backingPixelCount += 1;
          const insideTimeArea = x >= labelX - 1
            && x < labelX + labelWidth + 1
            && y >= 2
            && y < 14;
          if (insideTimeArea && red > 0 && green > red && blue > 0) {
            dimmedRainPixelCount += 1;
          }
        }
      }
    }

    expect(backingPixelCount).toBe(0);
    expect(dimmedRainPixelCount).toBeGreaterThan(0);
  });
});

describe("game of life", () => {
  test("seeds the first generation with the current HH:MM stamp", () => {
    const animation = renderVisualEffect("life", 4_000, NOW, { lifeStart: "digits" });
    expectPanelContract(animation, 4_000);

    const date = new Date(NOW);
    const label = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const stamp = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    const width = measurePixelText(label, 2, 2);
    drawPixelText(stamp, label, Math.floor((DISPLAY_WIDTH - width) / 2), 3, [255, 255, 255], 2, 2);

    const first = animation.frames[0]!;
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        expect(first.getPixel(x, y)[1] > 0).toBe(stamp.getPixel(x, y)[0] > 0);
      }
    }
  });

  test("keeps a soup opening different from the clock opening and stays deterministic", () => {
    const digits = renderVisualEffect("life", 4_000, NOW, { lifeStart: "digits" });
    const soup = renderVisualEffect("life", 4_000, NOW, { lifeStart: "soup" });
    expectPanelContract(soup, 4_000);
    expect(frameBytes(soup)).not.toBe(frameBytes(digits));
    expect(frameBytes(renderVisualEffect("life", 4_000, NOW, { lifeStart: "soup" }))).toBe(frameBytes(soup));
    expect(soup.label).toBe("生命游戏");
    expect(digits.label).toBe("生命游戏 · 时间");
  });

  test("never runs empty and caps long items at the 120-frame budget", () => {
    const animation = renderVisualEffect("life", 600_000, NOW, { speed: 2, lifeStart: "soup" });
    expect(animation.frames).toHaveLength(120);
    expectPanelContract(animation, 600_000);
    // Stalls and short oscillators reseed, so the board is never left blank.
    expect(animation.frames.every((frame) => litCount(frame) > 0)).toBe(true);
  });

  test("advances the board with wrapped neighbourhoods", () => {
    const animation = renderVisualEffect("life", 4_000, NOW, { lifeStart: "soup" });
    const alive = (frame: PixelCanvas, x: number, y: number) => frame.getPixel(x, y)[1] > 0;
    const seed = animation.frames[0]!;
    const next = animation.frames[1]!;
    for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        let neighbours = 0;
        for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
          const nx = (x + dx! + DISPLAY_WIDTH) % DISPLAY_WIDTH;
          const ny = (y + dy! + DISPLAY_HEIGHT) % DISPLAY_HEIGHT;
          if (alive(seed, nx, ny)) neighbours += 1;
        }
        const expected = alive(seed, x, y) ? neighbours === 2 || neighbours === 3 : neighbours === 3;
        expect(alive(next, x, y)).toBe(expected);
      }
    }
  });
});

describe("fireworks", () => {
  test("renders bursts inside the panel contract and stays deterministic", () => {
    const animation = renderVisualEffect("fireworks", 8_000, NOW, { fireworkDensity: 2 });
    expectPanelContract(animation, 8_000);
    expect(animation.label).toBe("烟花");
    expect(frameBytes(renderVisualEffect("fireworks", 8_000, NOW, { fireworkDensity: 2 })))
      .toBe(frameBytes(animation));
    // A burst scatters far more pixels than the rocket trail that precedes it.
    expect(Math.max(...animation.frames.map(litCount))).toBeGreaterThan(10);
  });

  test("honours the density boundaries without leaving the panel", () => {
    for (const density of [1, 3]) {
      const animation = renderVisualEffect("fireworks", 8_000, NOW, { fireworkDensity: density });
      expectPanelContract(animation, 8_000);
      expect(animation.frames.some((frame) => litCount(frame) > 0)).toBe(true);
    }
  });
});

describe("flux clock", () => {
  const litSet = (frame: PixelCanvas): string => {
    const cells: string[] = [];
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const [red, green, blue] = frame.getPixel(x, y);
        if (red + green + blue > 0) cells.push(`${x},${y}`);
      }
    }
    return cells.join(";");
  };

  const bottomRowLit = (animation: VisualAnimation): boolean =>
    animation.frames.some((frame) => {
      for (let x = 0; x < frame.width; x += 1) {
        const [red, green, blue] = frame.getPixel(x, DISPLAY_HEIGHT - 1);
        if (red + green + blue > 0) return true;
      }
      return false;
    });

  test("holds readable digits through the shimmer and scatters them in the burst", () => {
    const animation = renderVisualEffect("flux", 10_000, NOW);
    expectPanelContract(animation, 10_000);
    expect(animation.label).toBe("流光时钟");
    // Before the first second flips, shimmer twinkles in brightness only.
    expect(litSet(animation.frames[3]!)).toBe(litSet(animation.frames[0]!));
    // Mid-animation the burst has scattered pixels off the digit mask.
    const drifting = animation.frames[Math.floor(animation.frames.length * 0.5)]!;
    expect(litSet(drifting)).not.toBe(litSet(animation.frames[0]!));
    expect(animation.frames.every((frame) => litCount(frame) > 0)).toBe(true);
  });

  test("ticks the seconds column with a particle morph instead of a burst", () => {
    const animation = renderVisualEffect("flux", 4_000, NOW, { fluxBurst: "never" });
    expectPanelContract(animation, 4_000);
    // The digit masks sit on rows 1-14, so a burst-free render never touches
    // the bottom row — while the wall clock still advances the seconds digits.
    expect(bottomRowLit(animation)).toBe(false);
    expect(litSet(animation.frames[43]!)).not.toBe(litSet(animation.frames[0]!));
    // A bursting render bounces sparks off the panel floor.
    expect(bottomRowLit(renderVisualEffect("flux", 10_000, NOW))).toBe(true);
  });

  test("uses the burst as the minute-change transition when the clock flips mid-item", () => {
    const start = Date.parse("2026-08-10T09:36:55Z");
    const animation = renderVisualEffect("flux", 10_000, start);
    expectPanelContract(animation, 10_000);
    const last = litSet(animation.frames.at(-1)!);
    expect(last).not.toBe(litSet(animation.frames[0]!));
    // The settled digits equal a fresh render taken at the same wall instant.
    const lastElapsed = animation.frameDelaysMs.slice(0, -1).reduce((sum, delay) => sum + delay, 0);
    const next = renderVisualEffect("flux", 10_000, start + lastElapsed);
    expect(last).toBe(litSet(next.frames[0]!));
  });

  test("keeps the seconds column crisp when long durations stretch the frame delay", () => {
    // 600s caps at 120 frames of 5s each, so the seconds digits retarget on
    // every frame: the morph must snap onto the glyph instead of hovering at
    // a half-glide, and vacated slots must not leave multi-second ghosts.
    const animation = renderVisualEffect("flux", 600_000, NOW, { fluxBurst: "never" });
    expectPanelContract(animation, 600_000);
    for (const frameIndex of [7, 60, 119]) {
      const elapsed = animation.frameDelaysMs.slice(0, frameIndex).reduce((sum, delay) => sum + delay, 0);
      const fresh = renderVisualEffect("flux", 600_000, NOW + elapsed, { fluxBurst: "never" });
      expect(litSet(animation.frames[frameIndex]!)).toBe(litSet(fresh.frames[0]!));
    }
  });

  test("stays deterministic and caps long items at the 120-frame budget", () => {
    const animation = renderVisualEffect("flux", 600_000, NOW, { fluxPalette: "violet" });
    expect(animation.frames).toHaveLength(120);
    expectPanelContract(animation, 600_000);
    expect(frameBytes(renderVisualEffect("flux", 600_000, NOW, { fluxPalette: "violet" })))
      .toBe(frameBytes(animation));
    expect(frameBytes(renderVisualEffect("flux", 600_000, NOW, { fluxPalette: "ember" })))
      .not.toBe(frameBytes(animation));
  });

  test("short items cannot fit the burst yet still track the clock", () => {
    const animation = renderVisualEffect("flux", 1_000, NOW);
    expectPanelContract(animation, 1_000);
    const first = litSet(animation.frames[0]!);
    // 12 frames cover less than a second from :00.000: no flip, no burst.
    expect(animation.frames.every((frame) => litSet(frame) === first)).toBe(true);
    expect(bottomRowLit(animation)).toBe(false);
    const other = renderVisualEffect("flux", 1_000, Date.parse("2026-08-10T09:41:30Z"));
    expect(litSet(other.frames[0]!)).not.toBe(first);
  });
});

describe("weather particles", () => {
  const conditions = ["clear", "cloud", "fog", "rain", "snow", "thunder"] as const;

  test("renders every condition against the panel contract", () => {
    for (const condition of conditions) {
      const animation = renderVisualEffect("weather", 5_000, NOW, {
        weather: { condition, temperatureC: 18.4, precipitationMm: 1.2, cloudCoverPercent: 88 },
      });
      expectPanelContract(animation, 5_000);
      expect(animation.label).toBe(`天气 · ${condition}`);
      expect(animation.frames.some((frame) => litCount(frame) > 0)).toBe(true);
    }
  });

  test("scales rain density with the reported precipitation", () => {
    const total = (precipitationMm: number) =>
      renderVisualEffect("weather", 5_000, NOW, {
        weather: { condition: "rain", temperatureC: 12, precipitationMm, cloudCoverPercent: 90 },
      }).frames.reduce((sum, frame) => sum + litCount(frame), 0);
    expect(total(8)).toBeGreaterThan(total(0.2) * 1.5);
  });

  test("flashes the whole panel during a thunderstorm", () => {
    const animation = renderVisualEffect("weather", 5_000, NOW, {
      weather: { condition: "thunder", temperatureC: 21, precipitationMm: 4, cloudCoverPercent: 96 },
    });
    const brightest = Math.max(...animation.frames.map(litCount));
    expect(brightest).toBeGreaterThan(DISPLAY_WIDTH * DISPLAY_HEIGHT * 0.9);
  });

  test("captions the panel with the truncated ASCII place name", () => {
    const PLACE_INK = [154, 168, 187] as const;
    const placePixels = (frame: PixelCanvas): Array<[number, number]> => {
      const positions: Array<[number, number]> = [];
      for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
        for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
          const [red, green, blue] = frame.getPixel(x, y);
          if (red === PLACE_INK[0] && green === PLACE_INK[1] && blue === PLACE_INK[2]) {
            positions.push([x, y]);
          }
        }
      }
      return positions;
    };
    const expectedPixels = (text: string): Array<[number, number]> => {
      const overlay = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
      drawPixelText(overlay, text, 0, 0, [255, 255, 255], 1, 1);
      const positions: Array<[number, number]> = [];
      for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
        for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
          if (overlay.getPixel(x, y)[0] > 0) positions.push([x, y]);
        }
      }
      return positions;
    };

    // 18C ends at x=40, so the caption budget is 38px: "SHANGHAI, CHINA"
    // cuts to "SHANGHAI," and the dangling comma is dropped.
    const rendered = renderVisualEffect("weather", 2_000, NOW, {
      weather: { condition: "snow", temperatureC: 18.4, precipitationMm: 0.4, cloudCoverPercent: 90 },
      weatherPlace: "Shanghai, China",
    });
    for (const frame of rendered.frames) {
      expect(placePixels(frame)).toEqual(expectedPixels("SHANGHAI"));
    }

    // Diacritics fold to base letters instead of dissolving into "?" glyphs.
    const folded = renderVisualEffect("weather", 2_000, NOW, {
      weather: { condition: "snow", temperatureC: 18.4, precipitationMm: 0.4, cloudCoverPercent: 90 },
      weatherPlace: "São Paulo, Brazil",
    });
    expect(placePixels(folded.frames[0]!)).toEqual(expectedPixels("SAO PAULO"));

    // No place selected: the caption colour must not appear at all.
    const bare = renderVisualEffect("weather", 2_000, NOW, {
      weather: { condition: "snow", temperatureC: 18.4, precipitationMm: 0.4, cloudCoverPercent: 90 },
    });
    expect(placePixels(bare.frames[0]!)).toEqual([]);

    // A name with no drawable ASCII (un-geocoded CJK input) draws nothing
    // rather than a row of "?" glyphs.
    const cjk = renderVisualEffect("weather", 2_000, NOW, {
      weather: { condition: "snow", temperatureC: 18.4, precipitationMm: 0.4, cloudCoverPercent: 90 },
      weatherPlace: "上海",
    });
    expect(placePixels(cjk.frames[0]!)).toEqual([]);
  });

  test("shows one hint frame instead of failing when there is no observation", () => {
    const animation = renderVisualEffect("weather", 5_000, NOW, { weatherNotice: "未配置" });
    expect(animation.frames).toHaveLength(1);
    expect(animation.frameDelaysMs).toEqual([5_000]);
    expect(animation.label).toBe("天气 · 未配置");

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

describe("sunrise colour clock", () => {
  test("matches the NOAA reference elevations within half a degree", () => {
    // Equator at solar noon on a solstice: elevation = 90 - obliquity.
    expect(solarPosition(Date.parse("2026-06-21T12:00:00Z"), 0, 0).elevationDegrees)
      .toBeCloseTo(66.56, 0);
    expect(solarPosition(Date.parse("2026-06-21T12:00:00Z"), 51.4778, -0.0014).elevationDegrees)
      .toBeCloseTo(61.97, 0);
    // Polar night: the sun stays a full declination below the horizon all day.
    expect(solarPosition(Date.parse("2026-01-01T00:00:00Z"), 90, 0).elevationDegrees)
      .toBeCloseTo(-23.1, 0);
    expect(Math.abs(solarPosition(Date.parse("2026-06-21T12:00:00Z"), 0, 0).hourAngleDegrees))
      .toBeLessThan(1);
  });

  test("keeps the panel black and paints the digits with the sky colour", () => {
    const options = { latitude: 31.2304, longitude: 121.4737 };
    const night = renderVisualEffect("suncolor", 4_000, Date.parse("2026-08-10T16:00:00Z"), options);
    const day = renderVisualEffect("suncolor", 4_000, Date.parse("2026-08-10T04:00:00Z"), options);
    expectPanelContract(night, 4_000);
    expectPanelContract(day, 4_000);
    // Everything off the ink is switched-off LEDs: no sky fill, no grey wash.
    for (const frame of [day.frames[0]!, night.frames[0]!]) {
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        for (const y of [0, 1, 11, 12, 14, 15]) expect(frame.getPixel(x, y)).toEqual([0, 0, 0]);
      }
    }
    const inkColors = (frame: PixelCanvas): string[] => {
      const seen = new Set<string>();
      for (let y = 2; y <= 10; y += 1) {
        for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
          const [red, green, blue] = frame.getPixel(x, y);
          if (red + green + blue > 0) seen.add(`${red},${green},${blue}`);
        }
      }
      return [...seen];
    };
    // Solar noon over Shanghai: warm-white daylight digits at full brightness.
    expect(inkColors(day.frames[0]!)).toEqual(["255,244,224"]);
    // Deep night maps the ramp to black, so the digits take the readable floor.
    expect(inkColors(night.frames[0]!)).toEqual(["22,30,72"]);
  });

  test("draws the day colour-temperature axis with a moving white now-dot", () => {
    const options = { latitude: 31.2304, longitude: 121.4737 };
    const dotColumn = (nowMs: number): number => {
      const date = new Date(nowMs);
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      return Math.min(DISPLAY_WIDTH - 1, Math.floor((nowMs - midnight) / 86_400_000 * DISPLAY_WIDTH));
    };
    const stamps = [Date.parse("2026-08-10T00:00:00Z"), Date.parse("2026-08-10T10:00:00Z")];
    for (const nowMs of stamps) {
      const frame = renderVisualEffect("suncolor", 1_000, nowMs, options).frames[0]!;
      let axisLit = 0;
      for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
        const [red, green, blue] = frame.getPixel(x, 13);
        if (red + green + blue > 0) axisLit += 1;
      }
      // The daylight band plus the twilight shoulders light a wide stretch of the axis.
      expect(axisLit).toBeGreaterThan(20);
      expect(frame.getPixel(dotColumn(nowMs), 13)).toEqual([255, 255, 255]);
    }
    expect(dotColumn(stamps[0]!)).not.toBe(dotColumn(stamps[1]!));
  });

  test("advances the clock once per second and caps at 90 frames", () => {
    const animation = renderVisualEffect("suncolor", 600_000, NOW, { latitude: 0, longitude: 0 });
    expect(animation.frames).toHaveLength(90);
    expectPanelContract(animation, 600_000);
  });
});
