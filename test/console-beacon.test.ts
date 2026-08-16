import { describe, expect, test } from "bun:test";
import { BEACON_INTERVAL_MS,
  BEACON_MAGIC,
  BEACON_PORT,
  ConsoleBeacon,
  encodeBeacon,
  type BeaconSocket,
} from "../src/console-beacon.ts";
import { loadConfig } from "../src/config.ts";

const interfaces = {
  lo0: [{
    address: "127.0.0.1",
    netmask: "255.0.0.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: true,
    cidr: "127.0.0.1/8",
  }],
  // A container bridge that is up, private, and NOT the LAN the clock is on.
  // This is the real shape of the machine the incident happened on.
  bridge0: [{
    address: "192.168.192.229",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:07",
    internal: false,
    cidr: "192.168.192.229/24",
  }],
  en0: [{
    address: "192.168.8.114",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:01",
    internal: false,
    cidr: "192.168.8.114/24",
  }],
} as never;

interface Sent {
  payload: string;
  port: number;
  address: string;
}

function fakeSocket(): BeaconSocket & {
  sent: Sent[];
  broadcast: boolean;
  unreffed: boolean;
  closed: boolean;
  failNext: boolean;
} {
  return {
    sent: [],
    broadcast: false,
    unreffed: false,
    closed: false,
    failNext: false,
    setBroadcast(enabled: boolean) { this.broadcast = enabled; },
    send(payload: string, port: number, address: string) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("ENETDOWN: network is down, send");
      }
      this.sent.push({ payload, port, address });
      return true;
    },
    close() { this.closed = true; },
    unref() { this.unreffed = true; },
  };
}

function beaconWith(socket: BeaconSocket, clockHost = "192.168.8.240"): ConsoleBeacon {
  return new ConsoleBeacon({
    consolePort: 43_820,
    clockHost: () => clockHost,
    interfaces: () => interfaces,
    createSocket: async () => socket,
  });
}

describe("console beacon payload", () => {
  // THE WIRE. This literal is duplicated on purpose in the firmware's host check
  // (checkConsoleDiscovery in device/tc002-os/hostcheck/selfcheck.cpp), which
  // parses these exact bytes. The two sides are pinned to the same string
  // because a silent disagreement here is a clock that cannot hear a console
  // that is plainly shouting at it.
  test("is one versioned tab-separated line, newline terminated", () => {
    expect(encodeBeacon("192.168.8.114", 43_820)).toBe("ZOSCON1\t192.168.8.114\t43820\n");
  });

  test("carries the version tag a future layout must change", () => {
    expect(BEACON_MAGIC).toBe("ZOSCON1");
    expect(encodeBeacon("10.0.0.2", 43_820).startsWith(`${BEACON_MAGIC}\t`)).toBe(true);
  });

  test("announces the console's real port rather than assuming the default", () => {
    expect(encodeBeacon("10.0.0.2", 8_080)).toBe("ZOSCON1\t10.0.0.2\t8080\n");
  });

  test("the announce port is the device's compile-time listener", () => {
    expect(BEACON_PORT).toBe(43_821);
  });
});

describe("console beacon announcer", () => {
  test("announces the LAN address on the clock's own subnet, not the bridge", async () => {
    const socket = fakeSocket();
    const beacon = beaconWith(socket);
    await beacon.start();
    try {
      expect(socket.sent).toHaveLength(1);
      expect(socket.sent[0]).toEqual({
        payload: "ZOSCON1\t192.168.8.114\t43820\n",
        port: 43_821,
        // The DIRECTED broadcast of that interface, not 255.255.255.255: the
        // latter is refused outright on macOS and elsewhere leaves the kernel
        // to pick a route, which on this machine is the bridge.
        address: "192.168.8.255",
      });
    } finally {
      beacon.stop();
    }
  });

  test("enables SO_BROADCAST, without which the send is refused", async () => {
    const socket = fakeSocket();
    const beacon = beaconWith(socket);
    await beacon.start();
    try {
      expect(socket.broadcast).toBe(true);
    } finally {
      beacon.stop();
    }
  });

  test("neither the timer nor the socket keeps the process alive", async () => {
    const socket = fakeSocket();
    const beacon = beaconWith(socket);
    await beacon.start();
    try {
      // A referenced interval means the service survives SIGTERM and only dies
      // when something SIGKILLs it, which on a launchd-managed service turns
      // every restart into a stall. This has been a real bug in this process.
      expect(beacon.timer).toBeDefined();
      expect(beacon.timer!.hasRef()).toBe(false);
      expect(socket.unreffed).toBe(true);
    } finally {
      beacon.stop();
    }
  });

  test("repeats on its interval and stops when the service does", async () => {
    const socket = fakeSocket();
    const beacon = new ConsoleBeacon({
      consolePort: 43_820,
      clockHost: () => "192.168.8.240",
      interfaces: () => interfaces,
      createSocket: async () => socket,
      intervalMs: 5,
    });
    await beacon.start();
    await Bun.sleep(30);
    beacon.stop();
    const afterStop = socket.sent.length;
    expect(afterStop).toBeGreaterThan(1);
    expect(socket.closed).toBe(true);
    await Bun.sleep(20);
    expect(socket.sent).toHaveLength(afterStop);
  });

  test("follows the clock when the console repoints it (ADR 0005)", async () => {
    const socket = fakeSocket();
    let clockHost = "192.168.192.7";
    const beacon = new ConsoleBeacon({
      consolePort: 43_820,
      clockHost: () => clockHost,
      interfaces: () => interfaces,
      createSocket: async () => socket,
    });
    await beacon.start();
    try {
      expect(socket.sent[0]!.payload).toBe("ZOSCON1\t192.168.192.229\t43820\n");
      clockHost = "192.168.8.240";
      const moved = await beacon.announce();
      expect(moved?.host).toBe("192.168.8.114");
      expect(moved?.broadcast).toBe("192.168.8.255");
    } finally {
      beacon.stop();
    }
  });

  test("says nothing rather than announcing loopback when there is no LAN", async () => {
    const socket = fakeSocket();
    const beacon = new ConsoleBeacon({
      consolePort: 43_820,
      clockHost: () => "192.168.8.240",
      interfaces: () => ({
        lo0: [{
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        }],
      }) as never,
      createSocket: async () => socket,
    });
    await beacon.start();
    try {
      expect(socket.sent).toHaveLength(0);
      expect(await beacon.announce()).toBeNull();
    } finally {
      beacon.stop();
    }
  });

  test("survives an interface disappearing under it", async () => {
    const socket = fakeSocket();
    const logged: string[] = [];
    const beacon = new ConsoleBeacon({
      consolePort: 43_820,
      clockHost: () => "192.168.8.240",
      interfaces: () => interfaces,
      createSocket: async () => socket,
      log: (event) => { logged.push(event); },
    });
    socket.failNext = true;
    await beacon.start();
    try {
      expect(logged).toContain("console_beacon_send_failed");
      // ...and the next tick still goes out.
      expect(await beacon.announce()).not.toBeNull();
    } finally {
      beacon.stop();
    }
  });

  test("logs the announced address on change only", async () => {
    const socket = fakeSocket();
    const logged: Record<string, unknown>[] = [];
    let clockHost = "192.168.8.240";
    const beacon = new ConsoleBeacon({
      consolePort: 43_820,
      clockHost: () => clockHost,
      interfaces: () => interfaces,
      createSocket: async () => socket,
      log: (event, details) => {
        if (event === "console_beacon_announcing") logged.push(details);
      },
    });
    await beacon.start();
    try {
      await beacon.announce();
      await beacon.announce();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toEqual({
        host: "192.168.8.114",
        port: 43_820,
        broadcast: "192.168.8.255",
      });
      clockHost = "192.168.192.7";
      await beacon.announce();
      expect(logged).toHaveLength(2);
      expect(logged[1]!.host).toBe("192.168.192.229");
    } finally {
      beacon.stop();
    }
  });
});

describe("console discovery configuration", () => {
  const base = { CLOCK_HOST: "192.168.8.240" };

  test("is on by default, on the port the firmware listens on", () => {
    const config = loadConfig({ ...base });
    expect(config.consoleDiscovery).toBe(true);
    expect(config.consoleDiscoveryPort).toBe(43_821);
  });

  test("can be turned off", () => {
    expect(loadConfig({ ...base, CONSOLE_DISCOVERY: "off" }).consoleDiscovery).toBe(false);
    expect(loadConfig({ ...base, CONSOLE_DISCOVERY: "0" }).consoleDiscovery).toBe(false);
    expect(loadConfig({ ...base, CONSOLE_DISCOVERY: "false" }).consoleDiscovery).toBe(false);
    expect(loadConfig({ ...base, CONSOLE_DISCOVERY: "on" }).consoleDiscovery).toBe(true);
  });

  test("refuses a value it does not understand rather than assuming on", () => {
    expect(() => loadConfig({ ...base, CONSOLE_DISCOVERY: "disabled" })).toThrow(
      /CONSOLE_DISCOVERY/,
    );
  });

  test("takes a port, and refuses one that is not a port", () => {
    expect(loadConfig({ ...base, CONSOLE_DISCOVERY_PORT: "45000" }).consoleDiscoveryPort)
      .toBe(45_000);
    expect(() => loadConfig({ ...base, CONSOLE_DISCOVERY_PORT: "80" })).toThrow(
      /CONSOLE_DISCOVERY_PORT/,
    );
  });

  test("announces often enough that a first heal is not a wait", () => {
    // 3 s, down from 10. The interval stopped being the dominant term when the
    // firmware started keeping the last hint it heard whether or not it was
    // lost — a clock that loses its console already has the address. What this
    // bounds now is only the FIRST heal after a console appears, and three
    // seconds of a 30-byte datagram is not a cost worth defending.
    expect(BEACON_INTERVAL_MS).toBe(3_000);
    expect(BEACON_INTERVAL_MS).toBeLessThanOrEqual(3_000);
  });
});
