// The only place in the console that touches `navigator.bluetooth`.
//
// Deliberately thin: bun:test cannot drive Web Bluetooth at all, so every rule
// worth verifying lives in `@/lib/ble-provisioning` behind the `BleTransport`
// seam and this file is left with nothing but the browser calls themselves.
//
// Web Bluetooth is not in lib.dom.d.ts and `@types/web-bluetooth` is not a
// dependency, so the handful of members used here are declared locally rather
// than pulling a package in for six method signatures.

import {
  ZOS_BLE_RX_UUID,
  ZOS_BLE_SERVICE_UUID,
  ZOS_BLE_TX_UUID,
  type BleEnvironment,
  type BleTransport,
  type BleTransportHandlers,
} from "@/lib/ble-provisioning";

interface GattCharacteristic extends EventTarget {
  value?: DataView;
  // Narrower than the spec's `BufferSource` on purpose: this is the only kind of
  // buffer the framer ever produces, and BufferSource's ArrayBuffer generic does
  // not accept a plain Uint8Array under this tsconfig.
  writeValueWithResponse(value: Uint8Array<ArrayBufferLike>): Promise<void>;
  startNotifications(): Promise<GattCharacteristic>;
}

interface GattService {
  getCharacteristic(uuid: string): Promise<GattCharacteristic>;
}

interface GattServer {
  connected: boolean;
  connect(): Promise<GattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<GattService>;
}

interface BluetoothDeviceLike extends EventTarget {
  name?: string;
  gatt?: GattServer;
}

interface BluetoothLike {
  getAvailability?(): Promise<boolean>;
  requestDevice(options: {
    filters?: Array<{ services?: string[]; namePrefix?: string }>;
    optionalServices?: string[];
  }): Promise<BluetoothDeviceLike>;
}

function bluetooth(): BluetoothLike | null {
  // Guarded rather than assumed: this module is imported by a component the test
  // suite server-renders, and `navigator` does not exist there.
  if (typeof navigator === "undefined") return null;
  const candidate = (navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth;
  return candidate ?? null;
}

/**
 * The synchronous half of the gate. `adapterAvailable` starts null because
 * `getAvailability()` is a promise; the caller refines it with `probeAdapter`.
 */
export function readBleEnvironment(): BleEnvironment {
  return {
    secureContext: typeof window !== "undefined" && window.isSecureContext === true,
    hasBluetooth: bluetooth() !== null,
    adapterAvailable: null,
  };
}

/** null when the browser has no `getAvailability` — unknown, not unavailable. */
export async function probeBleAdapter(): Promise<boolean | null> {
  const api = bluetooth();
  if (api?.getAvailability === undefined) return null;
  try {
    return await api.getAvailability();
  } catch {
    return null;
  }
}

/**
 * One session's transport. `connect` must be called from a user gesture — the
 * spec throws SecurityError on `requestDevice` outside transient activation.
 */
export function createWebBluetoothTransport(): BleTransport {
  let device: BluetoothDeviceLike | null = null;
  let rx: GattCharacteristic | null = null;
  let closed = false;
  // ONE GATT OPERATION AT A TIME, PER DEVICE. That is the Web Bluetooth rule,
  // not a suggestion: a second operation issued while one is outstanding is
  // rejected with "GATT operation already in progress", and on this hardware the
  // link then drops. Nothing here used to enforce it, and the flow only got away
  // with it because a human typing six digits sat between the writes. Taking the
  // code out of the common path removed that accidental serialisation and the
  // collision surfaced on the very first exchange — the clock logged `hello`
  // twice, 0 ms apart, then `BLE_DISC reason=hup`.
  let gattQueue: Promise<unknown> = Promise.resolve();
  const serialise = <T>(operation: () => Promise<T>): Promise<T> => {
    // `catch` before chaining so one failed write does not poison every later
    // one; the caller still sees its own rejection through the returned promise.
    const next = gattQueue.then(operation, operation);
    gattQueue = next.catch(() => undefined);
    return next;
  };
  // Chrome hands back the SAME BluetoothDevice object for a device the user has
  // already picked, so a listener added per connect() accumulates across
  // retries: after one 重新连接 a single drop calls onDisconnect twice, which
  // restarts the session twice, which is how two connects end up in flight.
  let onDropped: (() => void) | null = null;
  // Same accumulation, same cause: Chrome hands back the same characteristic
  // object too, so a notification listener added per connect() means one inbound
  // chunk is fed to the reassembler once per past attempt.
  let onNotify: ((event: Event) => void) | null = null;
  let notifySource: GattCharacteristic | null = null;

  return {
    async connect(handlers: BleTransportHandlers) {
      const api = bluetooth();
      if (api === null) throw new DOMException("web bluetooth unavailable", "NotSupportedError");
      closed = false;
      handlers.onStage("chooser");
      // Filter on the service rather than a name prefix: it keeps the chooser to
      // ZOS clocks only, and Web Bluetooth grants access only to services named
      // in `filters` / `optionalServices`.
      device = await api.requestDevice({
        filters: [{ services: [ZOS_BLE_SERVICE_UUID] }],
        optionalServices: [ZOS_BLE_SERVICE_UUID],
      });

      // Registered before the first write: a drop during the join is the normal
      // shape of success on this hardware, and the session has to see it.
      if (onDropped !== null) device.removeEventListener("gattserverdisconnected", onDropped);
      onDropped = () => {
        if (closed) return;
        handlers.onDisconnect();
      };
      device.addEventListener("gattserverdisconnected", onDropped);

      handlers.onStage("connecting");
      const gatt = device.gatt;
      if (gatt === undefined) throw new DOMException("device exposes no GATT", "NotSupportedError");
      const server = await serialise(() => gatt.connect());

      handlers.onStage("service");
      const service = await serialise(() => server.getPrimaryService(ZOS_BLE_SERVICE_UUID));
      rx = await serialise(() => service.getCharacteristic(ZOS_BLE_RX_UUID));
      const tx = await serialise(() => service.getCharacteristic(ZOS_BLE_TX_UUID));

      handlers.onStage("subscribing");
      if (notifySource !== null && onNotify !== null) {
        notifySource.removeEventListener("characteristicvaluechanged", onNotify);
      }
      onNotify = (event: Event) => {
        const value = (event.target as GattCharacteristic).value;
        if (value === undefined) return;
        handlers.onChunk(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      };
      notifySource = tx;
      tx.addEventListener("characteristicvaluechanged", onNotify);
      await serialise(() => tx.startNotifications());
      handlers.onStage("ready");
    },

    async write(chunk: Uint8Array) {
      if (rx === null) throw new Error("蓝牙尚未连接");
      const target = rx;
      await serialise(() => target.writeValueWithResponse(chunk));
    },

    disconnect() {
      closed = true;
      rx = null;
      const gatt = device?.gatt;
      if (device !== null && onDropped !== null) {
        device.removeEventListener("gattserverdisconnected", onDropped);
      }
      onDropped = null;
      if (notifySource !== null && onNotify !== null) {
        notifySource.removeEventListener("characteristicvaluechanged", onNotify);
      }
      notifySource = null;
      onNotify = null;
      device = null;
      if (gatt?.connected === true) gatt.disconnect();
    },
  };
}
