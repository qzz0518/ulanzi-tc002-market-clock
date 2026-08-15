import { networkInterfaces } from "node:os";
import {
  resolveClockIpv4,
  selectControlAddress,
  type InterfaceMap,
} from "./network-access.ts";

/**
 * The console shouting where it lives, so a clock that lost it can find it again.
 *
 * THE INCIDENT. The device stores the console's address in /data/zos-host and
 * polls it for the rest of its life. It learns that address once — from a
 * sideload bundle's `host` file, or from a BLE join — and the console is a Bun
 * process on a laptop holding a DHCP lease. When the lease moved from .108 to
 * .114 the clock kept knocking on .108 forever: the panel still told the time,
 * so nothing looked wrong, but telemetry stopped, the console could not see the
 * device, and an OTA request could never reach it. Silent from both ends, and
 * the only fix was a cable and `adb push`.
 *
 * So this is a HINT, not a command. Everything that decides whether to act on it
 * lives on the device (net/ConsoleDiscovery), behind four gates; this half only
 * says "a console is here" to a subnet, ten times a minute, and is otherwise
 * inert. A device that is talking to its console never even parses these.
 *
 * NO CRYPTO, DELIBERATELY. There is no shared secret and no HMAC, because there
 * is nothing here for one to buy. The console's write API is guarded only by a
 * same-origin check, and a same-origin check stops browsers, not `curl`: anyone
 * already on this LAN can push firmware to the clock today, through
 * POST /api/os/upgrade. The LAN is therefore already the trust boundary and this
 * feature does not widen it. What the BLE pairing code guards is a DIFFERENT
 * attacker — someone in Bluetooth range who is *not* on the WiFi — and that
 * defence is untouched by anything here.
 */

/**
 * The version tag. Whatever this protocol becomes, a future payload must not be
 * mistakable for this one by a device that only understands this one, and the
 * device's parser requires this exact prefix — so the tag changes with the
 * layout rather than the layout changing under a fixed tag.
 */
export const BEACON_MAGIC = "ZOSCON1";

/**
 * Where the device listens.
 *
 * A CONSTANT, not `HEALTH_PORT + 1`, even though 43821 is what that works out
 * to today. The listener on the device is a compile-time number in a firmware
 * that is flashed rarely and updated over the very link this feature exists to
 * repair; deriving the default from a console-side setting would mean a user who
 * moves HEALTH_PORT silently announces to a port nothing is listening on. The
 * console's real port travels IN the payload instead, where the device reads it.
 */
export const BEACON_PORT = 43_821;

/** Every 10 s: a lost device is found within one interval of arriving. */
export const BEACON_INTERVAL_MS = 10_000;

/**
 * One ASCII line: `ZOSCON1\t<host>\t<port>\n`.
 *
 * Tab separated and newline terminated, like the pull document this device
 * already parses. The trailing newline is the FRAME: the device's parser
 * requires it, so a datagram that was cut short is rejected as truncated rather
 * than read as a shorter address (see ConsoleDiscovery::parseBeacon, whose host
 * check pins these exact bytes).
 */
export function encodeBeacon(host: string, port: number): string {
  return `${BEACON_MAGIC}\t${host}\t${port}\n`;
}

/** What one announcement went out as; the log line and the tests read this. */
export interface BeaconAnnouncement {
  host: string;
  port: number;
  broadcast: string;
}

/** The subset of Bun.udpSocket this needs, so tests do not open a real socket. */
export interface BeaconSocket {
  setBroadcast(enabled: boolean): void;
  send(data: string, port: number, address: string): boolean;
  close(): void;
  unref(): void;
}

export interface ConsoleBeaconOptions {
  /** The console's own port — what the device should poll. */
  consolePort: number;
  /** Where to announce. Defaults to BEACON_PORT. */
  announcePort?: number;
  /**
   * The clock's address, read per announcement rather than captured:
   * PUT /api/device/host repoints it in place and the beacon has to follow
   * (ADR 0005).
   */
  clockHost: () => string;
  intervalMs?: number;
  interfaces?: () => InterfaceMap;
  createSocket?: () => Promise<BeaconSocket>;
  log?: (event: string, details: Record<string, unknown>) => void;
}

async function defaultSocket(): Promise<BeaconSocket> {
  const socket = await Bun.udpSocket({ socket: { data() {} } });
  return {
    setBroadcast: (enabled) => socket.setBroadcast(enabled),
    send: (data, port, address) => socket.send(data, port, address),
    close: () => socket.close(),
    unref: () => socket.unref(),
  };
}

export class ConsoleBeacon {
  private readonly options: ConsoleBeaconOptions;
  private socket: BeaconSocket | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private resolvedClockHost = "";
  private resolvedClockIpv4: string | null = null;
  private lastAnnounced = "";

  constructor(options: ConsoleBeaconOptions) {
    this.options = options;
  }

  /** The live timer, so a test can assert it does not hold the process open. */
  get timer(): ReturnType<typeof setInterval> | undefined {
    return this.interval;
  }

  async start(): Promise<void> {
    if (this.socket) return;
    const create = this.options.createSocket ?? defaultSocket;
    const socket = await create();
    // Without SO_BROADCAST a send to a directed broadcast address is refused
    // outright with EACCES — measured on this machine, not inferred.
    socket.setBroadcast(true);
    // Neither the socket nor the timer may keep the event loop alive. This
    // process is stopped by a signal, and a referenced handle means it survives
    // SIGTERM and only dies when something works out to SIGKILL it — which on a
    // launchd-managed service turns every restart into a stall. That was a real
    // bug here days ago; osNowTimer and osVibeTimer carry the same unref for the
    // same reason.
    socket.unref();
    this.socket = socket;
    await this.announce();
    this.interval = setInterval(() => { void this.announce(); },
      this.options.intervalMs ?? BEACON_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * Sends one announcement, or returns null when there is nothing honest to say.
   *
   * WHICH INTERFACE. A laptop has several — a VPN tunnel, a container bridge,
   * Thunderbolt bridges, awdl0 — and the address announced has to be one the
   * clock can actually open a socket to. The choice is delegated to
   * selectControlAddress, which is the console's existing answer to exactly this
   * question (it is what the phone-control popover advertises), and its rule is:
   * the interface whose subnet CONTAINS THE CLOCK wins, then any private IPv4,
   * then the first non-internal one.
   *
   * That is a deliberate refinement of "prefer the interface carrying the
   * default route", and the two differ on a machine this project is actually
   * run on: with a corporate VPN up the default route is the tunnel, whose
   * address the clock cannot route to, while the clock's own /24 is unambiguous
   * about which NIC faces the LAN it is on. When several interfaces still tie,
   * insertion order decides and the announcement is logged — a wrong guess is
   * recoverable (the device refuses a hint from another /24, and refuses any
   * hint that does not answer as a console), whereas announcing nothing is the
   * failure this feature exists to end.
   */
  async announce(): Promise<BeaconAnnouncement | null> {
    const socket = this.socket;
    if (!socket) return null;
    const clockHost = this.options.clockHost();
    if (clockHost !== this.resolvedClockHost) {
      this.resolvedClockHost = clockHost;
      this.resolvedClockIpv4 = await resolveClockIpv4(clockHost);
    }
    const interfaces = (this.options.interfaces ?? networkInterfaces)();
    const selected = selectControlAddress(this.resolvedClockIpv4, interfaces);
    // No LAN address, or no usable netmask: the only address left would be
    // 127.0.0.1, which is a lie in a packet the device would then poll forever.
    if (!selected?.broadcast) return null;
    const announcement: BeaconAnnouncement = {
      host: selected.address,
      port: this.options.consolePort,
      broadcast: selected.broadcast,
    };
    const payload = encodeBeacon(announcement.host, announcement.port);
    try {
      socket.send(payload, this.options.announcePort ?? BEACON_PORT, announcement.broadcast);
    } catch (error) {
      // An interface going away between the read and the send is normal on a
      // laptop lid-open; the next tick picks the new one up.
      this.options.log?.("console_beacon_send_failed", {
        broadcast: announcement.broadcast,
        error: error instanceof Error ? error.message : "unknown error",
      });
      return null;
    }
    // Logged on CHANGE only. This runs every 10 s forever, and a line a tick is
    // a line nobody reads; a line when the announced address MOVES is exactly
    // the record that would have explained the incident above.
    const signature = `${announcement.host}:${announcement.port}>${announcement.broadcast}`;
    if (signature !== this.lastAnnounced) {
      this.lastAnnounced = signature;
      this.options.log?.("console_beacon_announcing", { ...announcement });
    }
    return announcement;
  }
}
