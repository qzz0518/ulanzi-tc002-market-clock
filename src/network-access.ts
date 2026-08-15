import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export interface ControlAccessInfo {
  port: number;
  address: string | null;
  url: string | null;
  suggestedUrl: string | null;
  lanEnabled: boolean;
  sameSubnetAsClock: boolean;
}

export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface SelectedAddress {
  address: string;
  /**
   * The directed broadcast of that interface's subnet (address | ~netmask).
   *
   * Carried alongside the address because the LAN beacon has to reach the clock
   * on the interface the address belongs to, and 255.255.255.255 does not do
   * that: macOS answers a send to it with EADDRNOTAVAIL on an unbound socket
   * (measured), and where it does work it leaves the kernel to pick a route —
   * which on a laptop with a VPN or a container bridge up is the wrong one.
   * Null when the netmask is not a usable IPv4 mask.
   */
  broadcast: string | null;
  sameSubnetAsClock: boolean;
}

function isIpv4(info: NetworkInterfaceInfo): boolean {
  return info.family === "IPv4" || (info.family as unknown) === 4;
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce(
    (value, octet) => ((value << 8) | Number(octet)) >>> 0,
    0,
  );
}

function isSameSubnet(address: string, netmask: string, clockAddress: string): boolean {
  const local = ipv4Number(address);
  const mask = ipv4Number(netmask);
  const clock = ipv4Number(clockAddress);
  return local !== null
    && mask !== null
    && clock !== null
    && ((local & mask) >>> 0) === ((clock & mask) >>> 0);
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function broadcastAddress(address: string, netmask: string): string | null {
  const local = ipv4Number(address);
  const mask = ipv4Number(netmask);
  if (local === null || mask === null) return null;
  const value = ((local | (~mask >>> 0)) >>> 0);
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

export function selectControlAddress(
  clockAddress: string | null,
  interfaces: InterfaceMap = networkInterfaces(),
): SelectedAddress | null {
  const candidates = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => isIpv4(entry) && !entry.internal && isIP(entry.address) === 4);

  if (clockAddress) {
    const matching = candidates.find((entry) =>
      isSameSubnet(entry.address, entry.netmask, clockAddress)
    );
    if (matching) {
      return {
        address: matching.address,
        broadcast: broadcastAddress(matching.address, matching.netmask),
        sameSubnetAsClock: true,
      };
    }
  }

  const fallback = candidates.find((entry) => isPrivateIpv4(entry.address)) ?? candidates[0];
  return fallback
    ? {
      address: fallback.address,
      broadcast: broadcastAddress(fallback.address, fallback.netmask),
      sameSubnetAsClock: false,
    }
    : null;
}

export async function resolveClockIpv4(clockHost: string): Promise<string | null> {
  if (isIP(clockHost) === 4) return clockHost;
  try {
    return (await lookup(clockHost, { family: 4 })).address;
  } catch {
    return null;
  }
}

export async function discoverControlAccess(options: {
  clockHost: string;
  controlHost: "127.0.0.1" | "0.0.0.0";
  port: number;
  interfaces?: InterfaceMap;
}): Promise<ControlAccessInfo> {
  const selected = selectControlAddress(
    await resolveClockIpv4(options.clockHost),
    options.interfaces ?? networkInterfaces(),
  );
  const suggestedUrl = selected ? `http://${selected.address}:${options.port}/` : null;
  const lanEnabled = options.controlHost === "0.0.0.0";
  return {
    port: options.port,
    address: selected?.address ?? null,
    url: lanEnabled ? suggestedUrl : null,
    suggestedUrl,
    lanEnabled,
    sameSubnetAsClock: selected?.sameSubnetAsClock ?? false,
  };
}
