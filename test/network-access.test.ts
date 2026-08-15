import { describe, expect, test } from "bun:test";
import { discoverControlAccess, selectControlAddress } from "../src/network-access.ts";

const interfaces = {
  en0: [{
    address: "192.0.2.12",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:01",
    internal: false,
    cidr: "192.0.2.12/24",
  }],
  en7: [{
    address: "198.51.100.5",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:02",
    internal: false,
    cidr: "198.51.100.5/24",
  }],
  lo0: [{
    address: "127.0.0.1",
    netmask: "255.0.0.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: true,
    cidr: "127.0.0.1/8",
  }],
} as never;

describe("mobile control access discovery", () => {
  test("selects the local IPv4 interface on the clock subnet", () => {
    expect(selectControlAddress("192.0.2.240", interfaces)).toEqual({
      address: "192.0.2.12",
      broadcast: "192.0.2.255",
      sameSubnetAsClock: true,
    });
  });

  // The LAN beacon sends to this, not to 255.255.255.255: an unbound socket is
  // refused outright on macOS, and where a global broadcast does work it leaves
  // the kernel to pick the route — which on a laptop with a VPN or a container
  // bridge up is the wrong interface.
  test("carries the directed broadcast of the interface it chose", () => {
    expect(selectControlAddress("198.51.100.240", interfaces)?.broadcast)
      .toBe("198.51.100.255");
    expect(selectControlAddress(null, {
      en0: [{
        address: "10.1.2.3",
        netmask: "255.255.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:03",
        internal: false,
        cidr: "10.1.2.3/16",
      }],
    } as never)?.broadcast).toBe("10.1.255.255");
  });

  test("returns a usable phone URL only when the LAN listener is enabled", async () => {
    const enabled = await discoverControlAccess({
      clockHost: "192.0.2.240",
      controlHost: "0.0.0.0",
      port: 43_820,
      interfaces,
    });
    expect(enabled).toEqual({
      port: 43_820,
      address: "192.0.2.12",
      url: "http://192.0.2.12:43820/",
      suggestedUrl: "http://192.0.2.12:43820/",
      lanEnabled: true,
      sameSubnetAsClock: true,
    });

    const disabled = await discoverControlAccess({
      clockHost: "192.0.2.240",
      controlHost: "127.0.0.1",
      port: 43_820,
      interfaces,
    });
    expect(disabled.url).toBeNull();
    expect(disabled.suggestedUrl).toBe("http://192.0.2.12:43820/");
    expect(disabled.lanEnabled).toBe(false);
  });
});
