import { Button, NumberScrubber, Select } from "@cladd-ui/react";
import { Info, MonitorCog, PinOff } from "lucide-react";
import { firmwareModeLabel, type FirmwareMode } from "@/lib/firmware-mode";
import { useZosFocus } from "@/lib/use-zos-focus";
import {
  VIBE_MAX_CELL_DWELL_MS,
  VIBE_MIN_CELL_DWELL_MS,
  VIBE_ZOS_FOCUS,
  vibeCellDwellLabel,
  vibePageIntervalChoices,
  vibePageIntervalLabel,
} from "@/lib/vibe";

interface VibeDisplayProps {
  /** Which firmware is answering right now; only ZOS has a VIBE app to open. */
  firmwareMode: FirmwareMode;
  /** Seconds the clock holds one page before turning itself; 0 = 旋钮说了算. */
  pageIntervalSec: number;
  /** How the value cell is split between the number and the countdown, in ms. */
  valueDwellMs: number;
  /** 0 = the cell never leaves the number. */
  resetDwellMs: number;
  /** True while a PUT is in flight, so the controls cannot be raced. */
  savingInterval: boolean;
  onDisplayChange: (patch: {
    pageIntervalSec?: number;
    valueDwellMs?: number;
    resetDwellMs?: number;
  }) => void;
}

/**
 * 上屏 — what used to be 频道布置.
 *
 * VIBE is not a channel any more (docs/design/vibe-firmware-app.md): it is a
 * destination on the firmware's root ring, beside 音乐 and 游戏, and the service
 * publishes it into the ZOS menu. So there is nothing here to place and nothing
 * to remove — the section's whole job is how the page GETS THERE and how the
 * clock moves through it: hand over the knob for the person who would rather
 * not walk to it, and decide whether the clock turns its own pages. Same idiom
 * as the music tab's 切到时钟音乐页 button, down to the second press being the
 * way back.
 */
export function VibeDisplay({
  firmwareMode,
  pageIntervalSec,
  valueDwellMs,
  resetDwellMs,
  savingInterval,
  onDisplayChange,
}: VibeDisplayProps) {
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
          {/* 一个持久设置，不是上面那种一次性动作，所以自带 label 与说明行，
              不复用 .vibe-note（那一条是 role=status，归按钮的回执用）。 */}
          <div className="vibe-field">
            <div className="vibe-field__copy">
              <label id="vibe-page-interval-label" htmlFor="vibe-page-interval">自动翻页</label>
              <p id="vibe-page-interval-help">
                隔多久时钟自己翻到下一页。手动转旋钮或按一下会重新计时，所以不会从手底下抢走正在看的那页。
              </p>
            </div>
            <div className="vibe-field__control">
              <Select
                id="vibe-page-interval"
                aria-labelledby="vibe-page-interval-label"
                aria-describedby="vibe-page-interval-help"
                aria-busy={savingInterval}
                disabled={savingInterval}
                value={pageIntervalSec}
                options={vibePageIntervalChoices(pageIntervalSec)}
                renderOption={({ value }) => vibePageIntervalLabel(value)}
                onChange={(value) => onDisplayChange({ pageIntervalSec: value })}
              >
                {vibePageIntervalLabel(pageIntervalSec)}
              </Select>
            </div>
          </div>
          {/* 一行里数值和倒计时是分时共用同一格的——进度条占 x=21..34、三位数值占
              x=37..51，行里没有第三个位置。所以这两个数决定的是「各自占多久」，
              不是「显示不显示」（倒计时拖到 0 才是不显示）。 */}
          <div className="vibe-field">
            <div className="vibe-field__copy">
              <label id="vibe-value-dwell-label" htmlFor="vibe-value-dwell">数值停留</label>
              <p id="vibe-value-dwell-help">
                一行里「已用/剩余」的百分比先亮多久，然后这一格才让给重置倒计时。
              </p>
            </div>
            <div className="vibe-field__control">
              <NumberScrubber
                id="vibe-value-dwell"
                className="number-scrubber"
                contentClassName="number-scrubber__content"
                inputClassName="number-scrubber__input"
                aria-labelledby="vibe-value-dwell-label"
                aria-describedby="vibe-value-dwell-help"
                aria-busy={savingInterval}
                disabled={savingInterval}
                color="neutral"
                value={Math.round(valueDwellMs / 100) / 10}
                min={VIBE_MIN_CELL_DWELL_MS / 1000}
                max={VIBE_MAX_CELL_DWELL_MS / 1000}
                step={0.1}
                title="左右拖动调整，点击输入"
                displayValue={(next) => `${next} 秒`}
                onChange={(next) => onDisplayChange({ valueDwellMs: Math.round(next * 1000) })}
              />
            </div>
          </div>
          <div className="vibe-field">
            <div className="vibe-field__copy">
              <label id="vibe-reset-dwell-label" htmlFor="vibe-reset-dwell">倒计时停留</label>
              <p id="vibe-reset-dwell-help">
                然后倒计时占这一格多久，之后换回数值。拖到 0 就一直显示数值、不显示倒计时。
                （厂商没给重置时间的指标本来就没有倒计时。）
              </p>
            </div>
            <div className="vibe-field__control">
              <NumberScrubber
                id="vibe-reset-dwell"
                className="number-scrubber"
                contentClassName="number-scrubber__content"
                inputClassName="number-scrubber__input"
                aria-labelledby="vibe-reset-dwell-label"
                aria-describedby="vibe-reset-dwell-help"
                aria-busy={savingInterval}
                disabled={savingInterval}
                color="neutral"
                value={resetDwellMs <= 0 ? 0 : Math.round(resetDwellMs / 100) / 10}
                min={0}
                max={VIBE_MAX_CELL_DWELL_MS / 1000}
                step={0.1}
                title="左右拖动调整，拖到 0 表示不显示倒计时"
                displayValue={(next) => vibeCellDwellLabel(Math.round(next * 1000))}
                onChange={(next) => {
                  // 0 是「不显示」，其余不足下限的一律按下限存——拖动经过 0.1 秒
                  // 不该被后端拒成一次报错。
                  const ms = Math.round(next * 1000);
                  onDisplayChange({
                    resetDwellMs: ms <= 0 ? 0 : Math.max(ms, VIBE_MIN_CELL_DWELL_MS),
                  });
                }}
              />
            </div>
          </div>
          <p className="vibe-note" role="status">
            {pinned
              // 「锁住旋钮」锁的是切台，不是这一页内部的翻页——两个控件挨着，
              // 不说清楚就会读成互相矛盾。
              ? "时钟已锁在「VIBE」，旋钮暂时不切台；这一页内部照样按上面的间隔翻。"
              : "数字由服务推给设备，页面由固件自己画——星标或翻页间隔改了，服务立刻重发一次。"}
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
          「VIBE」需要 ZOS 系统固件。时钟当前是{firmwareModeLabel(firmwareMode)}，上面没有这一页，
          自动翻页也无处可翻（设置会存下来，刷了 ZOS 就生效）；刷 ZOS 请到「系统」页。
          左边的数字与星标在任何固件下都照常可用。
        </p>
      )}
    </section>
  );
}
