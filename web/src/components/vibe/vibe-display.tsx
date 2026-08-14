import { Button } from "@cladd-ui/react";
import { Info, MonitorCog, PinOff } from "lucide-react";
import { firmwareModeLabel, type FirmwareMode } from "@/lib/firmware-mode";
import { useZosFocus } from "@/lib/use-zos-focus";
import { VIBE_ZOS_FOCUS } from "@/lib/vibe";

interface VibeDisplayProps {
  /** Which firmware is answering right now; only ZOS has a VIBE app to open. */
  firmwareMode: FirmwareMode;
}

/**
 * 上屏 — what used to be 频道布置.
 *
 * VIBE is not a channel any more (docs/design/vibe-firmware-app.md): it is a
 * destination on the firmware's root ring, beside 音乐 and 游戏, and the service
 * publishes it into the ZOS menu. So there is nothing here to place and nothing
 * to remove — the section's whole job is to say where the page lives on the
 * clock, and to hand over the knob for the person who would rather not walk to
 * it. Same idiom as the music tab's 切到时钟音乐页 button, down to the second
 * press being the way back.
 */
export function VibeDisplay({ firmwareMode }: VibeDisplayProps) {
  const zos = firmwareMode === "zos";
  const focus = useZosFocus(zos);
  const pinned = focus.pinnedOn(VIBE_ZOS_FOCUS);

  return (
    <section className="vibe-display" aria-labelledby="vibe-display-title">
      <div className="vibe-section__head">
        <h2 id="vibe-display-title">上屏</h2>
        <p>VIBE 是时钟上的一个 App，旋钮转到「VIBE」就是这一页；再转就是每个代理各一页。</p>
      </div>

      {zos ? (
        <>
          <div className="vibe-display__actions">
            <Button
              type="button"
              color={pinned ? "brand" : "neutral"}
              variant="transparent"
              outline
              aria-pressed={pinned}
              aria-busy={focus.busy}
              disabled={focus.busy}
              title={pinned
                ? "交还旋钮，时钟恢复自己切台"
                : "把时钟切到它自己的「VIBE」页并锁住旋钮；那一页由设备绘制"}
              onClick={() => focus.toggle(VIBE_ZOS_FOCUS)}
            >
              {pinned ? <PinOff aria-hidden="true" /> : <MonitorCog aria-hidden="true" />}
              {pinned ? "交还旋钮" : "在时钟上打开"}
            </Button>
          </div>
          <p className="vibe-note" role="status">
            {pinned
              ? "时钟已锁在「VIBE」，旋钮暂时不切台。"
              : "数字由服务推给设备，页面由固件自己画——星标改了，时钟五分钟内跟上。"}
          </p>
          {focus.error && (
            <p className="vibe-note is-alert" role="alert">切换时钟界面失败：{focus.error}</p>
          )}
        </>
      ) : (
        // 不做半吊子降级：把用量塞回频道正是这次要去掉的东西（设计 §6）。
        // 只说实话——这一页在官方固件与两个侧载固件上不存在。用 info 不用警告色：
        // 这是「还没装」，不是「坏了」，跟左边那条未接入提示同一个道理。
        <p className="vibe-note" role="status">
          <Info aria-hidden="true" className="vibe-note__icon" />
          「VIBE」需要 ZOS 系统固件。时钟当前是{firmwareModeLabel(firmwareMode)}，上面没有这一页；
          刷 ZOS 请到「系统」页。左边的数字与星标在任何固件下都照常可用。
        </p>
      )}
    </section>
  );
}
