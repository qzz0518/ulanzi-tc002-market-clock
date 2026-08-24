export interface AppConfig {
  // The only field mutated after boot: PUT /api/device/host repoints the clock in
  // place. That is legal only because every consumer dereferences config.clockHost
  // at call time — read ADR 0005 before capturing it into a local or a constructor.
  clockHost: string;
  clockHttpProxy?: string;
  notifyToken?: string;
  /**
   * Shared secret for POST /v1/push. Unset means the route refuses every push:
   * it takes no same-origin check (the agent is not a browser), so without a
   * token anything on the LAN could put invented quota on the panel.
   */
  vibeIngestToken?: string;
  controlHost: "127.0.0.1" | "0.0.0.0";
  appName: string;
  requestTimeoutMs: number;
  sourceStaleMs: number;
  displayDurationSeconds: number;
  healthPort: number;
  /** The LAN beacon that lets a clock whose console moved find it again. */
  consoleDiscovery: boolean;
  consoleDiscoveryPort: number;
}

function validateClockHttpProxy(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLOCK_HTTP_PROXY must be a valid local HTTP proxy URL");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("CLOCK_HTTP_PROXY must point to an unauthenticated loopback HTTP proxy");
  }
  return url.toString().replace(/\/$/, "");
}

const DEFAULTS = {
  controlHost: "127.0.0.1",
  appName: "btc",
  requestTimeoutMs: 5_000,
  sourceStaleMs: 120_000,
  displayDurationSeconds: 90,
  healthPort: 43_820,
  // ON by default: the failure it repairs (a DHCP lease moving under a clock
  // that polls a static address) is silent from both ends, so a device that
  // needs this is by definition one nobody has thought to go and configure.
  consoleDiscovery: true,
  // Fixed rather than derived from healthPort — the device's listener is a
  // compile-time constant. See BEACON_PORT in console-beacon.ts.
  consoleDiscoveryPort: 43_821,
} satisfies Omit<AppConfig, "clockHost" | "clockHttpProxy" | "notifyToken" | "vibeIngestToken">;

function validateControlHost(value: string): AppConfig["controlHost"] {
  if (value !== "127.0.0.1" && value !== "0.0.0.0") {
    throw new Error("CONTROL_HOST must be 127.0.0.1 or 0.0.0.0");
  }
  return value;
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/**
 * A yes/no switch, strict like parseInteger above.
 *
 * An unrecognised value throws rather than falling back to the default: this
 * one turns a network broadcast off, and `CONSOLE_DISCOVERY=disabled` silently
 * meaning "on" is the shape of a setting someone believes they have changed.
 */
function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  throw new Error(`${name} must be one of on/off, true/false, 1/0, yes/no`);
}

export function loadRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return parseInteger(
    "REQUEST_TIMEOUT_MS",
    env.REQUEST_TIMEOUT_MS,
    DEFAULTS.requestTimeoutMs,
    1_000,
    30_000,
  );
}

export function loadHealthPort(
  env: Record<string, string | undefined> = process.env,
): number {
  return parseInteger(
    "HEALTH_PORT",
    env.HEALTH_PORT,
    DEFAULTS.healthPort,
    1_024,
    65_535,
  );
}

export function validateClockHost(value: string): string {
  const host = value.trim();
  if (
    host.length === 0 ||
    host.length > 253 ||
    /[\s/?#@]/.test(host) ||
    host.includes("://") ||
    host.includes(":")
  ) {
    throw new Error("CLOCK_HOST must be an IPv4 address or hostname without a URL scheme");
  }
  return host;
}

function validateAppName(value: string): string {
  const appName = value.trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(appName)) {
    throw new Error("APP_NAME must contain 1-32 ASCII letters, numbers, underscores, or hyphens");
  }
  return appName;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const clockHost = env.CLOCK_HOST;
  if (!clockHost?.trim()) {
    throw new Error("CLOCK_HOST is required; set it to the TC002 IPv4 address or hostname");
  }
  const clockHttpProxy = validateClockHttpProxy(env.CLOCK_HTTP_PROXY);
  const notifyToken = env.NOTIFY_TOKEN?.trim();
  const vibeIngestToken = env.VIBE_INGEST_TOKEN?.trim();
  return {
    clockHost: validateClockHost(clockHost),
    ...(clockHttpProxy ? { clockHttpProxy } : {}),
    ...(notifyToken ? { notifyToken } : {}),
    ...(vibeIngestToken ? { vibeIngestToken } : {}),
    controlHost: validateControlHost(env.CONTROL_HOST ?? DEFAULTS.controlHost),
    appName: validateAppName(env.APP_NAME ?? DEFAULTS.appName),
    requestTimeoutMs: loadRequestTimeoutMs(env),
    sourceStaleMs: parseInteger(
      "SOURCE_STALE_MS",
      env.SOURCE_STALE_MS,
      DEFAULTS.sourceStaleMs,
      60_000,
      3_600_000,
    ),
    displayDurationSeconds: parseInteger(
      "DISPLAY_DURATION_SECONDS",
      env.DISPLAY_DURATION_SECONDS,
      DEFAULTS.displayDurationSeconds,
      30,
      86_400,
    ),
    healthPort: loadHealthPort(env),
    consoleDiscovery: parseBoolean(
      "CONSOLE_DISCOVERY",
      env.CONSOLE_DISCOVERY,
      DEFAULTS.consoleDiscovery,
    ),
    consoleDiscoveryPort: parseInteger(
      "CONSOLE_DISCOVERY_PORT",
      env.CONSOLE_DISCOVERY_PORT,
      DEFAULTS.consoleDiscoveryPort,
      1_024,
      65_535,
    ),
  };
}
