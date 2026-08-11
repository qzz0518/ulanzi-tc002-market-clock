import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateClockHost } from "./config.ts";
import { SettingsValidationError } from "./settings.ts";

export interface DeviceHostStatus {
  /** The address every device request currently uses. */
  host: string;
  /** What CLOCK_HOST said at boot, kept so the console can show the two diverging. */
  envHost: string;
  source: "env" | "override";
}

// Wraps the boot-path validator so the control API's error funnel maps a bad
// address to 400 instead of 503 — it only special-cases SettingsValidationError.
export function validateDeviceHost(value: unknown): string {
  if (typeof value !== "string") {
    throw new SettingsValidationError("host must be a string");
  }
  try {
    return validateClockHost(value);
  } catch {
    throw new SettingsValidationError(
      "host must be an IPv4 address or hostname, without a scheme or port",
    );
  }
}

interface StoredClockHost {
  version: 1;
  host: string;
}

/**
 * Persists the clock address the console set, so a DHCP move survives a restart.
 * CLOCK_HOST stays required at boot but becomes a first-run seed: once this file
 * exists it wins, because the launchd plist is not editable from the UI and an
 * env-wins rule would silently revert the fix on the next start (ADR 0005).
 */
export class ClockHostStore {
  constructor(readonly path: string) {}

  async load(): Promise<string | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return null;
    }
    // A corrupt or hand-edited override must never stop the service from booting;
    // falling back to CLOCK_HOST is strictly better than refusing to start.
    try {
      const parsed = JSON.parse(raw) as Partial<StoredClockHost>;
      if (typeof parsed?.host !== "string") return null;
      return validateDeviceHost(parsed.host);
    } catch {
      return null;
    }
  }

  async save(host: string): Promise<string> {
    const validated = validateDeviceHost(host);
    const body: StoredClockHost = { version: 1, host: validated };
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(body, null, 2)}\n`);
    await rename(temporaryPath, this.path);
    return validated;
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
