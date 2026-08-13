import { BluetoothOff } from "lucide-react";
import type { BleSupport } from "@/lib/ble-provisioning";

/**
 * Why there is no 蓝牙配网 button here, in the same words the wizard would have
 * used to refuse.
 *
 * Shared between the offline notice on the 系统 tab and the 常规设置 dialog:
 * both places must never render a button that cannot work, and both must give
 * the same reason for its absence.
 */
export function BleUnavailableNote({ support }: { support: BleSupport }) {
  return (
    <p className="flex items-start gap-2 text-cladd-fg-softer text-cladd-xs leading-relaxed" role="status">
      <BluetoothOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span><strong className="text-cladd-fg-soft">{support.title}</strong>：{support.detail}</span>
    </p>
  );
}
