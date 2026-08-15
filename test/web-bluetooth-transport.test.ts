import { beforeEach, describe, expect, test } from "bun:test";
import { createWebBluetoothTransport } from "../web/src/components/zos/web-bluetooth-transport";

// A fake GATT stack. Chrome's real one hands back the SAME device, service and
// characteristic objects for a device the user has already picked, which is the
// property both accumulation bugs below depend on — so these fakes are created
// once per "device" and reused across connects, exactly as the browser does.

class FakeCharacteristic extends EventTarget {
  value?: DataView;
  writes: Uint8Array[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  notifyStarts = 0;
  private release: (() => void) | null = null;

  /** Holds the next write open so a second one can be attempted underneath it. */
  block(): () => void {
    let unblock = () => {};
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    this.release = () => { void gate; };
    this.gate = gate;
    return unblock;
  }
  private gate: Promise<void> | null = null;

  async writeValueWithResponse(value: Uint8Array): Promise<void> {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    if (this.gate !== null) {
      const gate = this.gate;
      this.gate = null;
      await gate;
    }
    this.writes.push(value);
    this.concurrent -= 1;
    void this.release;
  }

  async startNotifications(): Promise<FakeCharacteristic> {
    this.notifyStarts += 1;
    return this;
  }

  /** What the device sending a chunk looks like from here. */
  emit(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class FakeDevice extends EventTarget {
  rx = new FakeCharacteristic();
  tx = new FakeCharacteristic();
  gatt = {
    connected: true,
    connect: async () => this.gatt,
    disconnect: () => { this.gatt.connected = false; },
    getPrimaryService: async () => ({
      getCharacteristic: async (uuid: string) =>
        (uuid.startsWith("7a1f5b62") ? this.tx : this.rx),
    }),
  };

  drop(): void {
    this.dispatchEvent(new Event("gattserverdisconnected"));
  }
}

let device: FakeDevice;

beforeEach(() => {
  device = new FakeDevice();
  (globalThis as { navigator?: unknown }).navigator = {
    bluetooth: {
      getAvailability: async () => true,
      requestDevice: async () => device,
    },
  };
});

function handlers() {
  const chunks: Uint8Array[] = [];
  let drops = 0;
  const stages: string[] = [];
  return {
    chunks,
    stages,
    drops: () => drops,
    sink: {
      onStage: (stage: string) => { stages.push(stage); },
      onChunk: (chunk: Uint8Array) => { chunks.push(chunk); },
      onDisconnect: () => { drops += 1; },
    },
  };
}

describe("web bluetooth transport", () => {
  test("never has two GATT operations outstanding at once", async () => {
    // The rule this enforces is the browser's, not ours: a second GATT
    // operation issued while one is outstanding is rejected outright with
    // "GATT operation already in progress", and on this hardware the link then
    // drops. It only ever worked because a human typing six digits sat between
    // the writes; taking the code off the common path removed that accidental
    // serialisation and the clock logged `hello` twice, 0 ms apart, then hung up.
    const h = handlers();
    const transport = createWebBluetoothTransport();
    await transport.connect(h.sink);

    const unblock = device.rx.block();
    const first = transport.write(new Uint8Array([1]));
    const second = transport.write(new Uint8Array([2]));
    unblock();
    await Promise.all([first, second]);

    expect(device.rx.maxConcurrent).toBe(1);
    expect(device.rx.writes.map((w) => w[0])).toEqual([1, 2]);
  });

  test("a failed write does not poison the ones behind it", async () => {
    const h = handlers();
    const transport = createWebBluetoothTransport();
    await transport.connect(h.sink);

    const original = device.rx.writeValueWithResponse.bind(device.rx);
    let calls = 0;
    device.rx.writeValueWithResponse = async (value: Uint8Array) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return original(value);
    };

    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow("boom");
    await transport.write(new Uint8Array([2]));
    expect(device.rx.writes.map((w) => w[0])).toEqual([2]);
  });

  test("reconnecting does not multiply the disconnect handler", async () => {
    // Chrome returns the same BluetoothDevice for a device already picked, so a
    // listener added per connect() survives into the next attempt. After one
    // 重新连接 a single drop restarted the session twice, and two connects in
    // flight is how the collision above got started.
    const h = handlers();
    const transport = createWebBluetoothTransport();
    await transport.connect(h.sink);
    await transport.connect(h.sink);
    await transport.connect(h.sink);

    device.drop();
    expect(h.drops()).toBe(1);
  });

  test("reconnecting does not multiply the notification handler", async () => {
    // Same cause, worse symptom: one inbound chunk fed to the reassembler once
    // per past attempt is a stream of frame errors, not a lost byte.
    const h = handlers();
    const transport = createWebBluetoothTransport();
    await transport.connect(h.sink);
    await transport.connect(h.sink);

    device.tx.emit(new Uint8Array([7, 7, 7]));
    expect(h.chunks).toHaveLength(1);
  });

  test("disconnect detaches both listeners, so a later drop is silent", async () => {
    const h = handlers();
    const transport = createWebBluetoothTransport();
    await transport.connect(h.sink);
    transport.disconnect();

    device.drop();
    device.tx.emit(new Uint8Array([1]));
    expect(h.drops()).toBe(0);
    expect(h.chunks).toHaveLength(0);
  });
});
