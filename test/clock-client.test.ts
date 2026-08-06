import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import {
  curlClockRequest,
  pushClockPayload,
  readClockInfo,
} from "../src/clock-client.ts";
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
});
