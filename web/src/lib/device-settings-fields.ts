// What 常规设置 may honestly offer, per firmware.
//
// The dialog used to be a single surface written against the Ulanzi firmware's
// /getDeviceInfo + /setConfig. Three firmwares reach it now and they answer
// different questions:
//
//   official — the stock firmware's own settings page, unchanged.
//   zos      — what ZOS actually exposes: two write-only controls and a
//              telemetry block. Everything the stock firmware reads from
//              /getDeviceInfo (SN / MAC / MCU / SOC / brand) simply does not
//              exist here, and an empty row for it is worse than no row.
//   sideload — the music/arcade firmware holds the device; the official
//              endpoints are gone and nothing has replaced them.
//
// What lives here is only what stays true away from the DOM: which surface a
// firmware gets, and the two row lists the panels render *from* — DEVICE_INFO_ROWS
// and describeZosDeviceFacts. Deliberately no parallel "these are the fields"
// constants: a list that nothing renders is a second answer to the same
// question, and the tests would then pin the copy rather than the form. Which
// fields each 常规 tab shows is asserted by rendering the panels themselves
// (test/device-settings-fields.test.ts).

import type { FirmwareMode } from "./firmware-mode";
import {
  describeResidency,
  describeTelemetry,
  describeVitals,
  type ZosReadoutRow,
  type ZosState,
} from "./zos-link";
import type { DeviceInfo } from "@/types";

export type DeviceSettingsSurface = "official" | "zos" | "sideload";

/**
 * Which surface the dialog renders.
 *
 * Deliberately collapses 音乐/游戏 into one: both are the same situation for
 * this dialog (a sideload occupies the device, the official endpoints answer
 * nothing), and the sideload panel is where their differences belong.
 *
 * `zosFlashed` is why this takes two arguments instead of one. `mode` is
 * derived from a *live* report, so a flashed ZOS that fell off the Wi-Fi reads
 * as "official" — and that is the one moment the dialog matters most, because
 * 蓝牙配网 is the way back. Serving it the stock firmware's form would name a
 * firmware the clock is not running, over endpoints that answer 503 on it, and
 * hide the only action that helps. The sideload check stays ahead of it: on a
 * flashed unit running a sideload, the sideload is what holds the device.
 */
export function deviceSettingsSurface(
  mode: FirmwareMode,
  zosFlashed = false,
): DeviceSettingsSurface {
  if (mode === "zos") return "zos";
  if (mode === "music" || mode === "arcade") return "sideload";
  if (zosFlashed) return "zos";
  return "official";
}

// The clock reports the MAC unseparated (ccc4b277a772); show it the way every
// other tool on the network does. Anything that is not 12 hex digits passes
// through untouched rather than being mangled into a plausible-looking address.
export function formatMacAddress(value: string): string {
  if (!/^[0-9a-f]{12}$/i.test(value)) return value;
  return (value.match(/.{2}/g) ?? []).join(":").toUpperCase();
}

export interface DeviceInfoRow {
  key: keyof DeviceInfo;
  label: string;
  format?: (value: string) => string;
}

/** The stock 设备信息 rows — the /getDeviceInfo fields, in render order. */
export const DEVICE_INFO_ROWS: readonly DeviceInfoRow[] = [
  { key: "serialNumber", label: "设备 SN" },
  { key: "ssid", label: "WiFi 名称" },
  { key: "ip", label: "IP 地址" },
  { key: "mac", label: "MAC 地址", format: formatMacAddress },
  { key: "mcuVersion", label: "MCU 固件版本" },
  { key: "appVersion", label: "SOC 固件版本" },
];

/**
 * The ZOS 设备信息 rows, resolved to text.
 *
 * Composed out of the panel's own helpers rather than re-read from telemetry:
 * describeVitals / describeTelemetry / describeResidency already encode the
 * rules that matter (offline collapses to 离线 instead of showing the last
 * numbers; residency is sticky so "what comes back after a power cycle" cannot
 * flip when the device goes quiet), and two surfaces deriving those rules
 * separately is exactly how they would come to disagree about one device.
 *
 * The one row assembled here is the battery, because the strip renders it as a
 * coloured chip and a table needs a sentence: `describeBattery` returns null
 * both for the -1 sentinel and for a service too old to send the field, and
 * neither may become 0% — on a live device that is 「尚未读到」, on a dead one it
 * is 离线, and those are different facts.
 */
export function describeZosDeviceFacts(state: ZosState | null, now: number): ZosReadoutRow[] {
  const live = state?.live === true;
  const vitals = describeVitals(state);
  const telemetry = describeTelemetry(state, now);
  const fact = (key: string): ZosReadoutRow =>
    telemetry.find((row) => row.key === key) ?? { key, label: key, value: "离线" };
  const battery = vitals.battery;
  const batteryRow: ZosReadoutRow = battery
    ? {
      key: "battery",
      label: "电量",
      value: `${battery.label}${battery.charging ? " · 充电中" : ""}`,
    }
    : live
      ? {
        key: "battery",
        label: "电量",
        value: "尚未读到",
        note: "时钟要等 MCU 第一次回读才有电量，刚开机时是正常的",
      }
      : { key: "battery", label: "电量", value: "离线" };

  return [
    { key: "wifi", label: "Wi-Fi 名称", value: vitals.wifi ?? "离线" },
    fact("ip"),
    batteryRow,
    { key: "uptime", label: "已运行", value: vitals.uptime ?? "离线" },
    fact("free"),
    fact("supplicant"),
    fact("heartbeat"),
    describeResidency(state),
  ];
}
