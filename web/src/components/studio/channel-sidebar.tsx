import { Plus, Trash2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogRoot,
  DialogTrigger,
  Tooltip,
} from "@cladd-ui/react";
import { cn } from "@/lib/utils";
import type { ChannelConfig } from "@/types";

interface ChannelSidebarProps {
  channels: ChannelConfig[];
  selectedChannelId: string | null;
  onSelect: (channelId: string) => void;
  onAdd: () => void;
  onDelete: (channelId: string) => void;
}

export function ChannelSidebar({ channels, selectedChannelId, onSelect, onAdd, onDelete }: ChannelSidebarProps) {
  return (
    <aside className="channel-sidebar" aria-label="时钟频道">
      <div className="section-kicker"><span>01</span><span>/</span><span>时钟频道</span></div>
      <div className="channel-scroll">
        <div className="channel-list">
          {channels.map((channel) => {
            const active = channel.id === selectedChannelId;
            const kind = channel.items.length === 1 ? "单内容" : `轮播 ${channel.items.length}`;
            return (
              <div key={channel.id} className={cn("channel-entry", active && "is-active")}>
                <button type="button" className="channel-select" onClick={() => onSelect(channel.id)} aria-current={active ? "true" : undefined}>
                  <span className="channel-title">
                    <span className={cn("channel-dot", channel.enabled && "is-on")} aria-hidden="true" />
                    <strong>{channel.name}</strong>
                  </span>
                  <span className="channel-meta">{channel.appName} · {kind}</span>
                </button>

                <DialogRoot>
                  <DialogTrigger>
                    <Tooltip tooltip="删除频道">
                      <Button
                        type="button"
                        color="red"
                        variant="transparent"
                        outline={false}
                        size="sm"
                        square
                        className="channel-delete"
                        aria-label={`删除频道 ${channel.name}`}
                      >
                        <Trash2 />
                      </Button>
                    </Tooltip>
                  </DialogTrigger>
                  <Dialog
                    title={`删除“${channel.name}”？`}
                    text="保存后，对应的时钟旋钮项也会被移除。频道中的内容不会单独保留。"
                    cancelButtonText="取消"
                    confirmButtonText="删除频道"
                    confirmButtonColor="red"
                    stopPropagationOnClick
                    onConfirm={() => onDelete(channel.id)}
                  />
                </DialogRoot>
              </div>
            );
          })}
        </div>
      </div>
      <Button type="button" color="brand" className="add-channel" onClick={onAdd}>
        <Plus />新建频道
      </Button>
    </aside>
  );
}
