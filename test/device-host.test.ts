import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClockHostStore, validateDeviceHost } from "../src/device-host.ts";
import { SettingsValidationError } from "../src/settings.ts";

const directories: string[] = [];

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clock-host-"));
  directories.push(directory);
  return join(directory, "clock-host.json");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("clock host override", () => {
  test("accepts the addresses the boot path accepts", () => {
    expect(validateDeviceHost("192.168.8.240")).toBe("192.168.8.240");
    expect(validateDeviceHost("tc002.local")).toBe("tc002.local");
    expect(validateDeviceHost("  192.168.8.240  ")).toBe("192.168.8.240");
  });

  test("rejects everything the boot path rejects, as a 400-mapping error", () => {
    // Only SettingsValidationError is funnelled to HTTP 400 by the control API;
    // a bare Error would surface as a 503 and read as "the clock is down".
    for (const value of ["", "   ", "http://192.168.8.240", "192.168.8.240:80", "a/b", "a b", "x".repeat(254)]) {
      expect(() => validateDeviceHost(value)).toThrow(SettingsValidationError);
    }
    for (const value of [42, null, undefined, {}]) {
      expect(() => validateDeviceHost(value)).toThrow(SettingsValidationError);
    }
  });

  test("round-trips through disk and leaves no temporary file behind", async () => {
    const path = await storePath();
    const store = new ClockHostStore(path);
    expect(await store.load()).toBeNull();

    expect(await store.save("192.168.8.240")).toBe("192.168.8.240");
    expect(await store.load()).toBe("192.168.8.240");
    expect(await readdir(join(path, ".."))).toEqual(["clock-host.json"]);

    await store.clear();
    expect(await store.load()).toBeNull();
  });

  test("falls back to the environment rather than refusing to boot on a bad file", async () => {
    const path = await storePath();
    const store = new ClockHostStore(path);

    await Bun.write(path, "{oops");
    expect(await store.load()).toBeNull();

    await Bun.write(path, JSON.stringify({ version: 1, host: "1.2.3.4:80" }));
    expect(await store.load()).toBeNull();

    await Bun.write(path, JSON.stringify({ version: 1 }));
    expect(await store.load()).toBeNull();
  });
});
