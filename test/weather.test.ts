import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  WeatherClient,
  WeatherNotConfiguredError,
  classifyWeatherCode,
  parseCoordinate,
} from "../src/weather/client.ts";
import { GeocodeClient, parseGeocodeQuery } from "../src/weather/geocode.ts";
import {
  createDefaultContentItem,
  getContentDefinition,
  type ContentRenderContext,
} from "../src/content-registry.ts";
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, PixelCanvas } from "../src/pixel-ui.ts";
import { cjkTextWidth, drawCjkText } from "../src/pixel-cjk.ts";
import { WorkspaceStore, type WorkspaceSettings } from "../src/workspace.ts";
import { WorkspaceController } from "../src/workspace-controller.ts";

const NOW = Date.parse("2026-08-10T09:36:00Z");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function currentPayload(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    latitude: 31.25,
    longitude: 121.5,
    current: {
      time: "2026-08-10T09:30",
      temperature_2m: 28.4,
      precipitation: 1.2,
      weather_code: 61,
      cloud_cover: 88,
      ...overrides,
    },
  });
}

function noticeCanvas(text: string): PixelCanvas {
  const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  drawCjkText(canvas, text, Math.floor((DISPLAY_WIDTH - cjkTextWidth(text)) / 2), 2, [255, 176, 32]);
  return canvas;
}

// The place caption's blue-grey; no particle, dim or temperature colour hits it.
function isPlaceInk(frame: PixelCanvas, x: number, y: number): boolean {
  const [red, green, blue] = frame.getPixel(x, y);
  return red === 154 && green === 168 && blue === 187;
}

function countPlaceInk(frame: PixelCanvas): number {
  let count = 0;
  for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
    for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
      if (isPlaceInk(frame, x, y)) count += 1;
    }
  }
  return count;
}

describe("open-meteo weather client", () => {
  test("reads one current observation and classifies it", async () => {
    const urls: string[] = [];
    const client = new WeatherClient({
      now: () => NOW,
      fetcher: async (input) => {
        urls.push(String(input));
        return currentPayload();
      },
    });
    const observation = await client.getCurrent(31.2304, 121.4737);
    expect(urls).toEqual([
      "https://api.open-meteo.com/v1/forecast?latitude=31.2304&longitude=121.4737"
        + "&current=temperature_2m,precipitation,weather_code,cloud_cover",
    ]);
    expect(observation).toEqual({
      latitude: 31.2304,
      longitude: 121.4737,
      condition: "rain",
      weatherCode: 61,
      temperatureC: 28.4,
      precipitationMm: 1.2,
      cloudCoverPercent: 88,
      fetchedAt: new Date(NOW).toISOString(),
      sourceTime: "2026-08-10T09:30",
    });
  });

  test("serves the cache until the ten-minute floor has passed", async () => {
    let calls = 0;
    let now = NOW;
    const client = new WeatherClient({
      now: () => now,
      fetcher: async () => {
        calls += 1;
        return currentPayload({ temperature_2m: 20 + calls });
      },
    });
    expect((await client.getCurrent(31.2304, 121.4737)).temperatureC).toBe(21);
    now = NOW + 9 * 60_000;
    expect((await client.getCurrent("31.2304", "121.4737")).temperatureC).toBe(21);
    expect(calls).toBe(1);
    now = NOW + 10 * 60_000;
    expect((await client.getCurrent(31.2304, 121.4737)).temperatureC).toBe(22);
    expect(calls).toBe(2);
    // A different coordinate is a different cache entry.
    await client.getCurrent(48.8566, 2.3522);
    expect(calls).toBe(3);
  });

  test("rejects unusable coordinates before any request", async () => {
    let calls = 0;
    const client = new WeatherClient({ now: () => NOW, fetcher: async () => { calls += 1; return currentPayload(); } });
    await expect(client.getCurrent(91, 0)).rejects.toThrow("latitude must be a decimal degree");
    await expect(client.getCurrent(0, 181)).rejects.toThrow("longitude must be a decimal degree");
    await expect(client.getCurrent("", "")).rejects.toThrow("latitude must be a decimal degree");
    await expect(client.getCurrent("north", "0")).rejects.toThrow("latitude must be a decimal degree");
    expect(calls).toBe(0);
  });

  test("refuses malformed or failing responses", async () => {
    const failing = async (body: unknown, status = 200) => {
      const client = new WeatherClient({
        now: () => NOW,
        fetcher: async () => new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      });
      return client.getCurrent(31.2304, 121.4737);
    };
    await expect(failing({}, 503)).rejects.toThrow("open-meteo returned HTTP 503");
    await expect(failing({ current: null })).rejects.toThrow("no current conditions");
    await expect(failing({ current: { temperature_2m: "warm", precipitation: 0, weather_code: 0, cloud_cover: 0 } }))
      .rejects.toThrow("invalid temperature_2m");
    await expect(failing({ current: { temperature_2m: 20, precipitation: -1, weather_code: 0, cloud_cover: 0 } }))
      .rejects.toThrow("invalid precipitation");
    await expect(failing({ current: { temperature_2m: 20, precipitation: 0, weather_code: 0, cloud_cover: 140 } }))
      .rejects.toThrow("invalid cloud_cover");
    await expect(failing({ current: { temperature_2m: 20, precipitation: 0, cloud_cover: 10 } }))
      .rejects.toThrow("no weather_code");
  });

  test("turns an aborted request into a timeout message", async () => {
    const client = new WeatherClient({
      now: () => NOW,
      timeoutMs: 5,
      fetcher: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    });
    await expect(client.getCurrent(0, 0)).rejects.toThrow("open-meteo timed out after 5ms");
  });

  test("maps the WMO code groups onto the six particle styles", () => {
    expect(classifyWeatherCode(0, 10)).toBe("clear");
    expect(classifyWeatherCode(1, 85)).toBe("cloud");
    expect(classifyWeatherCode(3, 100)).toBe("cloud");
    expect(classifyWeatherCode(48, 100)).toBe("fog");
    expect(classifyWeatherCode(55, 90)).toBe("rain");
    expect(classifyWeatherCode(82, 90)).toBe("rain");
    expect(classifyWeatherCode(73, 90)).toBe("snow");
    expect(classifyWeatherCode(86, 90)).toBe("snow");
    expect(classifyWeatherCode(99, 90)).toBe("thunder");
    expect(parseCoordinate("  -12.34567 ", 90, "latitude")).toBe(-12.3457);
  });
});

describe("open-meteo geocoding client", () => {
  function geocodePayload(): Response {
    return Response.json({
      generationtime_ms: 0.6,
      results: [
        {
          id: 1796236,
          name: "Shanghai",
          latitude: 31.22222,
          longitude: 121.45806,
          elevation: 12,
          country: "China",
          country_code: "CN",
          admin1: "Shanghai",
          timezone: "Asia/Shanghai",
          population: 22_315_474,
        },
        // No country name and no admin1: the code still identifies it.
        { name: "Shanghai Reef", latitude: 9.9, longitude: 114.1, country_code: "ph" },
        // Unusable rows are dropped instead of poisoning the list.
        { name: "", latitude: 1, longitude: 2, country: "Nowhere" },
        { name: "Bad Coords", latitude: 91, longitude: 0, country: "Nowhere" },
      ],
    });
  }

  test("searches places and slims each result to what the studio needs", async () => {
    const urls: string[] = [];
    const client = new GeocodeClient({
      now: () => NOW,
      fetcher: async (input) => {
        urls.push(String(input));
        return geocodePayload();
      },
    });
    const places = await client.search(" Shanghai ");
    expect(urls).toEqual([
      "https://geocoding-api.open-meteo.com/v1/search?name=Shanghai&count=6&language=en&format=json",
    ]);
    expect(places).toEqual([
      { name: "Shanghai", admin1: "Shanghai", country: "China", latitude: 31.2222, longitude: 121.4581 },
      { name: "Shanghai Reef", country: "PH", latitude: 9.9, longitude: 114.1 },
    ]);
  });

  test("serves the cache for ten minutes per query, ignoring case", async () => {
    let calls = 0;
    let now = NOW;
    const client = new GeocodeClient({
      now: () => now,
      fetcher: async () => {
        calls += 1;
        return geocodePayload();
      },
    });
    await client.search("shanghai");
    now = NOW + 9 * 60_000;
    await client.search("SHANGHAI");
    expect(calls).toBe(1);
    now = NOW + 10 * 60_000;
    await client.search("shanghai");
    expect(calls).toBe(2);
    await client.search("paris");
    expect(calls).toBe(3);
  });

  test("rejects unusable queries before any request", async () => {
    let calls = 0;
    const client = new GeocodeClient({
      now: () => NOW,
      fetcher: async () => {
        calls += 1;
        return geocodePayload();
      },
    });
    await expect(client.search("")).rejects.toThrow("q must contain 1-64 characters");
    await expect(client.search("   ")).rejects.toThrow("q must contain 1-64 characters");
    await expect(client.search("x".repeat(65))).rejects.toThrow("q must contain 1-64 characters");
    expect(calls).toBe(0);
    expect(parseGeocodeQuery(" Lyon ")).toBe("Lyon");
    expect(() => parseGeocodeQuery(null)).toThrow("q must contain 1-64 characters");
  });

  test("treats a missing results field as no matches and surfaces HTTP failures", async () => {
    const withBody = (body: unknown, status = 200) =>
      new GeocodeClient({
        now: () => NOW,
        fetcher: async () => Response.json(body ?? {}, { status }),
      });
    expect(await withBody({ generationtime_ms: 0.2 }).search("nowhere")).toEqual([]);
    await expect(withBody({}, 503).search("paris"))
      .rejects.toThrow("open-meteo geocoding returned HTTP 503");
  });
});

describe("weather content definition", () => {
  const definition = getContentDefinition("visual:weather");

  function context(overrides: Partial<ContentRenderContext> = {}): ContentRenderContext {
    return {
      nowMs: NOW,
      forceRefresh: false,
      getMarket: () => { throw new Error("unused"); },
      getInstrumentMarket: () => { throw new Error("unused"); },
      getPixelAsset: () => { throw new Error("unused"); },
      async getWeather(latitude, longitude) {
        return {
          latitude,
          longitude,
          condition: "snow" as const,
          weatherCode: 73,
          temperatureC: -4.5,
          precipitationMm: 0.8,
          cloudCoverPercent: 96,
          fetchedAt: new Date(NOW).toISOString(),
        };
      },
      ...overrides,
    } as ContentRenderContext;
  }

  test("ships place plus hidden coordinate options and renders the observed condition", async () => {
    const item = createDefaultContentItem("visual:weather");
    item.durationMs = 3_000;
    expect(item.options).toEqual({
      place: "",
      latitude: "31.2304",
      longitude: "121.4737",
      speed: "1",
    });
    const rendered = await definition.render(context(), item);
    expect(rendered.label).toBe("天气 · snow");
    expect(rendered.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(3_000);
    expect(rendered.frames.every((frame) => frame.width === 52 && frame.height === 16)).toBe(true);
    // No place selected yet: the caption colour must not appear anywhere.
    expect(countPlaceInk(rendered.frames[0]!)).toBe(0);
  });

  test("draws the geocoded place name in the top-left caption colour", async () => {
    const item = createDefaultContentItem("visual:weather");
    item.durationMs = 3_000;
    item.options.place = "Shanghai, China";
    const rendered = await definition.render(context(), item);
    expect(rendered.label).toBe("天气 · snow");
    expect(countPlaceInk(rendered.frames[0]!)).toBeGreaterThan(0);
    // The 5px caption stays inside the top rows and clears the temperature block.
    for (const frame of rendered.frames) {
      for (let y = 0; y < DISPLAY_HEIGHT; y += 1) {
        for (let x = 0; x < DISPLAY_WIDTH; x += 1) {
          if (!isPlaceInk(frame, x, y)) continue;
          expect(y).toBeLessThan(5);
          expect(x).toBeLessThan(38);
        }
      }
    }
  });

  test("shows a hint frame when no weather client is wired up", async () => {
    const item = createDefaultContentItem("visual:weather");
    item.durationMs = 3_000;
    const rendered = await definition.render(
      context({ getWeather: async () => { throw new WeatherNotConfiguredError(); } }),
      item,
    );
    expect(rendered.label).toBe("天气 · 未配置");
    expect(rendered.frames).toHaveLength(1);
    expect(rendered.frames[0]!.pixels).toEqual(noticeCanvas("未配置").pixels);
  });

  test("shows a hint frame for coordinates that cannot be parsed", async () => {
    const item = createDefaultContentItem("visual:weather");
    item.durationMs = 3_000;
    item.options.latitude = "北纬三十一度";
    const rendered = await definition.render(context(), item);
    expect(rendered.label).toBe("天气 · 坐标错误");
    expect(rendered.frames[0]!.pixels).toEqual(noticeCanvas("坐标错误").pixels);
  });

  test("still reports a genuine source failure as a content error", async () => {
    const item = createDefaultContentItem("visual:weather");
    item.durationMs = 3_000;
    await expect(definition.render(
      context({ getWeather: async () => { throw new Error("open-meteo returned HTTP 500"); } }),
      item,
    )).rejects.toThrow("open-meteo returned HTTP 500");
  });
});

describe("workspace controller weather wiring", () => {
  function weatherWorkspace(): WorkspaceSettings {
    return {
      version: 3,
      channels: [{
        id: "weather",
        name: "天气",
        appName: "weather",
        enabled: true,
        refreshIntervalMs: 600_000,
        items: [{
          id: "weather_item",
          contentId: "visual:weather",
          durationMs: 2_000,
          options: { latitude: "31.2304", longitude: "121.4737", speed: "1" },
        }],
      }],
    };
  }

  async function controllerWith(weatherClient?: WeatherClient): Promise<WorkspaceController> {
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-weather-"));
    directories.push(directory);
    return new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace: weatherWorkspace(),
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      marketClient: {} as never,
      ...(weatherClient ? { weatherClient } : {}),
      pushPayload: async () => ({ status: 200 }),
      deleteApp: async () => ({ status: 200 }),
      now: () => NOW,
    });
  }

  test("renders live conditions through the injected client and caches them per render", async () => {
    let calls = 0;
    const controller = await controllerWith(new WeatherClient({
      now: () => NOW,
      fetcher: async () => {
        calls += 1;
        return currentPayload({ weather_code: 0, cloud_cover: 5, precipitation: 0, temperature_2m: 33 });
      },
    }));
    const rendered = await controller.previewChannel("weather", true);
    expect(rendered.label).toBe("天气 · clear");
    expect(rendered.contentErrors).toEqual({});
    expect(calls).toBe(1);
    await controller.previewChannel("weather", true);
    expect(calls).toBe(1);
  });

  test("falls back to the cached observation when a refresh fails", async () => {
    let calls = 0;
    const controller = await controllerWith(new WeatherClient({
      now: () => NOW,
      minRefreshMs: 0,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return currentPayload({ weather_code: 71, precipitation: 0.4, cloud_cover: 95 });
        throw new Error("network down");
      },
    }));
    expect((await controller.previewChannel("weather", true)).label).toBe("天气 · snow");
    expect((await controller.previewChannel("weather", true)).label).toBe("天气 · snow");
    expect(calls).toBe(2);
  });

  test("renders the not-configured hint instead of failing the channel", async () => {
    const controller = await controllerWith();
    const rendered = await controller.previewChannel("weather", true);
    expect(rendered.label).toBe("天气 · 未配置");
    expect(rendered.contentErrors).toEqual({});
    expect(rendered.frames).toHaveLength(1);
    expect(rendered.frames[0]!.pixels).toEqual(noticeCanvas("未配置").pixels);
  });
});
