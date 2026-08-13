import { ListOrdered, Repeat1, Shuffle } from "lucide-react";
import { Button, Tooltip } from "@cladd-ui/react";
import type { ComponentProps, ComponentType } from "react";
import {
  MUSIC_PLAY_ORDER_HINTS,
  MUSIC_PLAY_ORDER_LABELS,
  nextMusicPlayOrder,
  type MusicPlayOrder,
} from "@/lib/music-play-order";

/**
 * 播放模式, the control NetEase puts left of 上一首.
 *
 * Icon-only, because it sits in a row of icon-only transport buttons and a
 * label would push the play button off centre — but the icon alone would be a
 * riddle, so the name rides in the tooltip, which cladd shows on focus and on
 * touch as well as on hover. The mode also tints the glyph: 顺序播放 is the
 * default and stays quiet, the two that change what happens light up.
 */

const ICONS: Readonly<Record<MusicPlayOrder, ComponentType>> = {
  sequence: ListOrdered,
  "repeat-one": Repeat1,
  shuffle: Shuffle,
};

export interface PlayModeButtonProps {
  order: MusicPlayOrder;
  onCycle: () => void;
  /** Match the row it sits in — "md" beside the console transport. */
  size?: ComponentProps<typeof Button>["size"];
}

export function PlayModeButton({ order, onCycle, size = "md" }: PlayModeButtonProps) {
  const Icon = ICONS[order];
  const label = MUSIC_PLAY_ORDER_LABELS[order];
  return (
    <Tooltip
      className="max-w-56"
      contentClassName="flex flex-col gap-0.5 px-2 py-1.5"
      tooltip={
        <>
          <span className="font-semibold">{label}</span>
          <span className="text-cladd-fg-soft">{MUSIC_PLAY_ORDER_HINTS[order]}</span>
          <span className="text-cladd-fg-softer">
            点击切换到 {MUSIC_PLAY_ORDER_LABELS[nextMusicPlayOrder(order)]}
          </span>
        </>
      }
    >
      <Button
        type="button"
        size={size}
        square
        variant="transparent"
        outline={false}
        tightFocusRing
        // One colour for every mode, the same as the 上一首 / 下一首 buttons it
        // sits beside. Tinting the two non-default modes made the transport row
        // read as "something is switched on" rather than as three peers, and the
        // icon already says which mode this is.
        aria-label={`播放模式：${label}`}
        onClick={onCycle}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}
