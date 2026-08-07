import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import {
  curlClockRequest,
  deleteClockApp,
  pushClockPayload,
  pushClockPayloadNamed,
  readClockGeneralSettings,
  readClockInfo,
  writeClockGeneralSettings,
} from "../src/clock-client.ts";
import { DEFAULT_DEVICE_GENERAL_SETTINGS } from "../src/device-settings.ts";
import { buildImagePayload } from "../src/display.ts";
import { renderOfflineDashboard } from "../src/pixel-ui.ts";
import type { FetchLike } from "../src/price.ts";

const testConfig = () => loadConfig({ CLOCK_HOST: "192.0.2.240" });

describe("TC002 HTTP client", () => {
  test("uses the system curl transport for a background-safe request", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.method).toBe("POST");
        expect(await request.text()).toBe("pixel-frame");
        return new Response("accepted", { status: 202 });
      },
    });
    try {
      const response = await curlClockRequest(
        `http://127.0.0.1:${server.port}/custom`,
        2_000,
        { method: "POST", body: "pixel-frame" },
      );
      expect(response).toEqual({ ok: true, status: 202, body: "accepted" });
    } finally {
      server.stop(true);
    }
  });

  test("reads only non-sensitive device information", async () => {
    const fetcher: FetchLike = async () =>
      new Response(
        JSON.stringify({
          ip: "192.0.2.240",
          mcuVer: "V1.0.17",
          appVer: "1.0.5",
          devSn: "not-returned-by-client",
          mac: "not-returned-by-client",
        }),
      );
    expect(await readClockInfo(testConfig(), fetcher)).toEqual({
      ip: "192.0.2.240",
      mcuVersion: "V1.0.17",
      appVersion: "1.0.5",
    });
  });

  test("reads only the public general settings from the device config", async () => {
    const fetcher: FetchLike = async () => new Response(JSON.stringify({
      ...DEFAULT_DEVICE_GENERAL_SETTINGS,
      brightness: { level: "high", low: 50, mid: 80, high: 100 },
      weekStart: "Mon",
      wifiPassword: "must-not-leak",
      deviceToken: "must-not-leak",
    }));
    const settings = await readClockGeneralSettings(testConfig(), fetcher);
    expect(settings).toEqual({
      ...DEFAULT_DEVICE_GENERAL_SETTINGS,
      brightness: { level: "high", low: 50, mid: 80, high: 100 },
      weekStart: 1,
    });
    expect(settings).not.toHaveProperty("wifiPassword");
    expect(settings).not.toHaveProperty("deviceToken");
  });

  test("posts the exact validated general-settings payload", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetcher: FetchLike = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ code: 200, message: "success" }));
    };
    const settings = {
      ...DEFAULT_DEVICE_GENERAL_SETTINGS,
      brightness: { level: "high" as const, low: 40, mid: 70, high: 95 },
      volume: 1,
      carouselSpeed: 20 as const,
      scrollSpeed: 4,
      dateFormat: "DD/MM" as const,
      showWeek: false,
      weekStart: 0 as const,
      lowBatteryAutoSleep: true,
    };
    await expect(writeClockGeneralSettings(testConfig(), settings, fetcher)).resolves.toEqual(settings);
    expect(capturedUrl).toBe("http://192.0.2.240/setConfig");
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(String(capturedInit?.body))).toEqual(settings);
  });

  test("surfaces a device-side settings rejection", async () => {
    const fetcher: FetchLike = async () =>
      new Response(JSON.stringify({ code: 500, message: "invalid brightness" }));
    await expect(
      writeClockGeneralSettings(testConfig(), DEFAULT_DEVICE_GENERAL_SETTINGS, fetcher),
    ).rejects.toThrow("invalid brightness");
  });

  test("posts the official custom app payload", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetcher: FetchLike = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response("ok", { status: 200 });
    };
    const frame = renderOfflineDashboard();
    const payload = buildImagePayload(frame.image, frame.mimeType, 30);
    await pushClockPayload(testConfig(), payload, fetcher);
    expect(capturedUrl).toBe("http://192.0.2.240/api/custom?name=btc");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toMatchObject({
      duration: 30,
      text: [],
      image: [{ position: [0, 0] }],
    });
    expect(body.image[0].data.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("rejects a non-success response", async () => {
    const fetcher: FetchLike = async () => new Response("missing", { status: 404 });
    await expect(
      pushClockPayload(
        testConfig(),
        buildImagePayload(
          renderOfflineDashboard().image,
          renderOfflineDashboard().mimeType,
          30,
        ),
        fetcher,
      ),
    ).rejects.toThrow("HTTP 404");
  });

  test("targets independent knob apps and removes stale names with an empty object", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher: FetchLike = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("ok");
    };
    const payload = buildImagePayload(
      renderOfflineDashboard().image,
      renderOfflineDashboard().mimeType,
      30,
    );
    await pushClockPayloadNamed(testConfig(), "stocks", payload, fetcher);
    await deleteClockApp(testConfig(), "old_stocks", fetcher);
    expect(requests[0]?.url).toBe("http://192.0.2.240/api/custom?name=stocks");
    expect(requests[1]).toEqual({
      url: "http://192.0.2.240/api/custom?name=old_stocks",
      body: {},
    });
  });
});
