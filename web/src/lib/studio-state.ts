import type {
  ChannelConfig,
  ChannelRuntimeState,
  PreviewScope,
  RuntimeState,
} from "@/types";

export function channelForPreview(
  channel: ChannelConfig,
  selectedItemId: string | null,
  scope: PreviewScope,
): ChannelConfig {
  if (scope === "channel") return channel;
  const selected = channel.items.find((item) => item.id === selectedItemId) ?? channel.items[0];
  return selected ? { ...channel, items: [selected] } : channel;
}

export function channelRuntime(
  runtime: RuntimeState | null,
  channelId: string,
): ChannelRuntimeState | undefined {
  return runtime?.channels?.find((channel) => channel.id === channelId);
}

export function deviceIsBehind(lastPushAt: string | undefined, editedAt: number | undefined): boolean {
  if (!editedAt) return false;
  return !lastPushAt || Date.parse(lastPushAt) < editedAt;
}

export function relativeTimestamp(value: string | number | null, now = Date.now()): string {
  if (value === null) return "尚未";
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "未知时间";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
