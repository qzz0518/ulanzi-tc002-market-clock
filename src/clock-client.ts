import type { AppConfig } from "./config.ts";
import type { ClockPayload } from "./display.ts";
import type { FetchLike } from "./price.ts";

export interface ClockInfo {
  ip?: string;
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

export async function readClockInfo(
  config: AppConfig,
  fetcher?: FetchLike,
): Promise<ClockInfo> {
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
    ip: typeof body.ip === "string" ? body.ip : undefined,
    mcuVersion: typeof body.mcuVer === "string" ? body.mcuVer : undefined,
    appVersion: typeof body.appVer === "string" ? body.appVer : undefined,
  };
}

export async function pushClockPayload(
  config: AppConfig,
  payload: ClockPayload,
  fetcher?: FetchLike,
): Promise<{ status: number }> {
  const url = new URL(`http://${config.clockHost}/api/custom`);
  url.searchParams.set("name", config.appName);
  const response = await requestClock(
    url.toString(),
    config.requestTimeoutMs,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      proxy: config.clockHttpProxy,
    },
    fetcher,
  );
  if (!response.ok) {
    throw new ClockRequestError(`clock returned HTTP ${response.status}`, response.status);
  }
  return { status: response.status };
}
