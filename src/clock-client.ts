import type { AppConfig } from "./config.ts";
import {
  normalizeDeviceGeneralSettings,
  validateDeviceGeneralSettings,
  type DeviceGeneralSettings,
} from "./device-settings.ts";
import type { ClockPayload } from "./display.ts";
import type { FetchLike } from "./price.ts";

export interface ClockInfo {
  ip?: string;
  mcuVersion?: string;
  appVersion?: string;
}

// Everything the clock's own "设备信息" page shows. That page is static HTML which
// fetches /getBase itself and paints six rows (val-devSn / val-ssid / val-ip /
// val-mac / val-mcuVer / val-appVer) — the endpoint always returned all six, this
// client simply discarded three. They stay out of ClockInfo on purpose: that shape
// feeds /health, an unauthenticated snapshot anything on the LAN can poll.
export interface ClockDeviceInfo {
  serialNumber?: string;
  ssid?: string;
  ip?: string;
  mac?: string;
  mcuVersion?: string;
  appVersion?: string;
}

export class ClockRequestError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ClockRequestError";
  }
}

interface ClockHttpResponse {
  ok: boolean;
  status: number;
  body: string;
}

interface ClockRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  proxy?: string;
}

async function requestWithFetch(
  fetcher: FetchLike,
  url: string,
  timeoutMs: number,
  options: ClockRequestOptions = {},
): Promise<ClockHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      // Bun's fetch takes a per-request proxy, so the latency-critical transport
      // honours CLOCK_HTTP_PROXY too. A launchd-started service has no macOS
      // local-network permission: connecting straight to the clock's LAN
      // address fails to open a socket within milliseconds, and the loopback
      // proxy is the only way it can reach the device at all.
      ...(options.proxy ? { proxy: options.proxy } : {}),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ClockRequestError(`clock request timed out after ${timeoutMs}ms`);
    }
    const detail = error instanceof Error ? error.message : "unknown network error";
    throw new ClockRequestError(`clock request failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function curlClockRequest(
  url: string,
  timeoutMs: number,
  options: ClockRequestOptions = {},
): Promise<ClockHttpResponse> {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const args = [
    "/usr/bin/curl",
    "--silent",
    "--show-error",
    "--max-time",
    String(timeoutSeconds),
    "--connect-timeout",
    String(Math.max(1, Math.min(timeoutSeconds, 3))),
    "--write-out",
    "\n%{http_code}",
  ];
  if (options.proxy) {
    args.push("--proxy", options.proxy, "--noproxy", "");
  } else {
    args.push("--noproxy", "*");
  }
  if (options.method === "POST") args.push("--request", "POST");
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    args.push("--header", `${name}: ${value}`);
  }
  if (options.body !== undefined) args.push("--data-binary", "@-");
  args.push(url);

  const subprocess = Bun.spawn(args, {
    stdin: options.body === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.body !== undefined && subprocess.stdin) {
    subprocess.stdin.write(options.body);
    subprocess.stdin.end();
  }
  const [output, errorOutput, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    const detail = errorOutput.trim().replace(/\s+/g, " ").slice(0, 240);
    throw new ClockRequestError(
      detail.length > 0 ? `clock request failed: ${detail}` : `clock request failed with curl exit ${exitCode}`,
    );
  }
  const match = output.match(/\n(\d{3})$/);
  if (!match) throw new ClockRequestError("clock request returned no HTTP status");
  const status = Number(match[1]);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: output.slice(0, match.index),
  };
}

function requestClock(
  url: string,
  timeoutMs: number,
  options: ClockRequestOptions,
  fetcher?: FetchLike,
): Promise<ClockHttpResponse> {
  return fetcher
    ? requestWithFetch(fetcher, url, timeoutMs, options)
    : curlClockRequest(url, timeoutMs, options);
}

export async function readClockDeviceInfo(
  config: AppConfig,
  fetcher?: FetchLike,
): Promise<ClockDeviceInfo> {
  const response = await requestClock(
    `http://${config.clockHost}/getBase`,
    config.requestTimeoutMs,
    {
      headers: { Accept: "application/json" },
      proxy: config.clockHttpProxy,
    },
    fetcher,
  );
  if (!response.ok) {
    throw new ClockRequestError(`clock returned HTTP ${response.status}`, response.status);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    throw new ClockRequestError("clock returned invalid device information");
  }
  return {
    serialNumber: typeof body.devSn === "string" ? body.devSn : undefined,
    ssid: typeof body.ssid === "string" ? body.ssid : undefined,
    ip: typeof body.ip === "string" ? body.ip : undefined,
    mac: typeof body.mac === "string" ? body.mac : undefined,
    mcuVersion: typeof body.mcuVer === "string" ? body.mcuVer : undefined,
    appVersion: typeof body.appVer === "string" ? body.appVer : undefined,
  };
}

// The narrow projection every background caller keeps using: device detection,
// the sideload verify, and /health. Widening this would leak the serial number
// and MAC into the unauthenticated health snapshot.
export async function readClockInfo(
  config: AppConfig,
  fetcher?: FetchLike,
): Promise<ClockInfo> {
  const { ip, mcuVersion, appVersion } = await readClockDeviceInfo(config, fetcher);
  return { ip, mcuVersion, appVersion };
}

export async function readClockGeneralSettings(
  config: AppConfig,
  fetcher?: FetchLike,
): Promise<DeviceGeneralSettings> {
  const response = await requestClock(
    `http://${config.clockHost}/getConfig`,
    config.requestTimeoutMs,
    {
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      proxy: config.clockHttpProxy,
    },
    fetcher,
  );
  if (!response.ok) {
    throw new ClockRequestError(`clock returned HTTP ${response.status}`, response.status);
  }
  try {
    return normalizeDeviceGeneralSettings(JSON.parse(response.body));
  } catch (error) {
    if (error instanceof ClockRequestError) throw error;
    const detail = error instanceof Error ? error.message : "unknown settings format";
    throw new ClockRequestError(`clock returned invalid general settings: ${detail}`);
  }
}

export async function writeClockGeneralSettings(
  config: AppConfig,
  value: unknown,
  fetcher?: FetchLike,
): Promise<DeviceGeneralSettings> {
  const settings = validateDeviceGeneralSettings(value);
  const response = await requestClock(
    `http://${config.clockHost}/setConfig`,
    config.requestTimeoutMs,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
      proxy: config.clockHttpProxy,
    },
    fetcher,
  );
  if (!response.ok) {
    throw new ClockRequestError(`clock returned HTTP ${response.status}`, response.status);
  }
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    throw new ClockRequestError("clock returned an invalid settings response");
  }
  if (result.code !== 200) {
    const message = typeof result.message === "string" ? result.message.slice(0, 160) : "unknown error";
    throw new ClockRequestError(`clock rejected general settings: ${message}`);
  }
  return settings;
}

export async function pushClockPayload(
  config: AppConfig,
  payload: ClockPayload,
  fetcher?: FetchLike,
): Promise<{ status: number }> {
  return pushClockPayloadNamed(config, config.appName, payload, fetcher);
}

function validateCustomAppName(appName: string): string {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(appName)) {
    throw new ClockRequestError("custom app name is invalid");
  }
  return appName;
}

async function postCustomApp(
  config: AppConfig,
  appName: string,
  body: ClockPayload | Record<string, never>,
  fetcher?: FetchLike,
): Promise<{ status: number }> {
  const url = new URL(`http://${config.clockHost}/api/custom`);
  url.searchParams.set("name", validateCustomAppName(appName));
  const response = await requestClock(
    url.toString(),
    config.requestTimeoutMs,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      proxy: config.clockHttpProxy,
    },
    fetcher,
  );
  if (!response.ok) {
    throw new ClockRequestError(`clock returned HTTP ${response.status}`, response.status);
  }
  return { status: response.status };
}

export async function pushClockPayloadNamed(
  config: AppConfig,
  appName: string,
  payload: ClockPayload,
  fetcher?: FetchLike,
): Promise<{ status: number }> {
  return postCustomApp(config, appName, payload, fetcher);
}

export async function deleteClockApp(
  config: AppConfig,
  appName: string,
  fetcher?: FetchLike,
): Promise<{ status: number }> {
  return postCustomApp(config, appName, {}, fetcher);
}
