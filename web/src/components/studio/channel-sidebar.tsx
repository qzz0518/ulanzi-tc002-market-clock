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
  /**
   * 双击一个频道:选中它,并跳到「内容」页。
   *
   * 这个侧栏在画板和素材库里也在,而在那两个页面选中一个频道之后,想去改它的编排
   * 只能把鼠标抬到顶部导航再点一次「内容」——目标就在手边,路径却绕了一圈。双击是
   * 这条路的捷径,不是新的能力:单击仍然只是选中,顶部导航仍然在原处,所以键盘和触屏
   * 用户什么都没少。
   */
  onOpen: (channelId: string) => void;
  onAdd: () => void;
  onDelete: (channelId: string) => void;
}

export function ChannelSidebar({ channels, selectedChannelId, onSelect, onOpen, onAdd, onDelete }: ChannelSidebarProps) {
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
                {/* 双击挂在选择按钮上而不是整行:整行还装着删除按钮,而「双击删除」
                    是没人想要的语义。onClick 会在 onDoubleClick 之前先跑两次,选中
                    是幂等的,所以这里只管跳转。 */}
                <button
                  type="button"
                  className="channel-select"
                  onClick={() => onSelect(channel.id)}
                  onDoubleClick={() => onOpen(channel.id)}
                  aria-current={active ? "true" : undefined}
                >
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
          <Button
            type="button"
            color="brand"
            className="add-channel add-channel--mobile"
            onClick={onAdd}
          >
            <Plus />新建频道
          </Button>
        </div>
      </div>
      <Button type="button" color="brand" className="add-channel add-channel--desktop" onClick={onAdd}>
        <Plus />新建频道
      </Button>
    </aside>
  );
}
