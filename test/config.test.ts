import { describe, expect, test } from "bun:test";
import { loadConfig, loadHealthPort, loadRequestTimeoutMs } from "../src/config.ts";

describe("loadConfig", () => {
  test("requires the TC002 host instead of guessing a device address", () => {
    expect(() => loadConfig({})).toThrow("CLOCK_HOST is required");
    expect(() => loadConfig({ CLOCK_HOST: "   " })).toThrow("CLOCK_HOST is required");
  });

  test("uses safe non-device defaults once the host is supplied", () => {
    expect(loadConfig({ CLOCK_HOST: "tc002.test" })).toEqual({
      clockHost: "tc002.test",
      controlHost: "127.0.0.1",
      appName: "btc",
      requestTimeoutMs: 5_000,
      sourceStaleMs: 120_000,
      displayDurationSeconds: 90,
      healthPort: 43_820,
    });
  });

  test("loads helper defaults without requiring a device address", () => {
    expect(loadHealthPort({})).toBe(43_820);
    expect(loadRequestTimeoutMs({})).toBe(5_000);
  });

  test("accepts environment overrides", () => {
    const config = loadConfig({
      CLOCK_HOST: "tc002.local",
      CONTROL_HOST: "0.0.0.0",
      APP_NAME: "btc_price",
      CLOCK_HTTP_PROXY: "http://127.0.0.1:6152",
      NOTIFY_TOKEN: "notify-test-token",
    });
    expect(config.clockHost).toBe("tc002.local");
    expect(config.controlHost).toBe("0.0.0.0");
    expect(config.appName).toBe("btc_price");
    expect(config.clockHttpProxy).toBe("http://127.0.0.1:6152");
    expect(config.notifyToken).toBe("notify-test-token");
  });

  test("rejects URLs and over-aggressive polling", () => {
    expect(() => loadConfig({ CLOCK_HOST: "http://192.0.2.240" })).toThrow();
    expect(() => loadConfig({ CLOCK_HOST: "tc002.test", REQUEST_TIMEOUT_MS: "100" })).toThrow();
    expect(() => loadConfig({
      CLOCK_HOST: "tc002.test",
      CLOCK_HTTP_PROXY: "http://example.com:8080",
    })).toThrow();
    expect(() => loadConfig({
      CLOCK_HOST: "tc002.test",
      CONTROL_HOST: "192.0.2.2",
    })).toThrow();
  });
});
