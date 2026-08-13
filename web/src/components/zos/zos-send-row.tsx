import { useEffect, useState } from "react";
import { Slider } from "@cladd-ui/react";
import {
  ZOS_BRIGHTNESS_MAX,
  ZOS_BRIGHTNESS_MIN,
  ZOS_BRIGHTNESS_START,
  ZOS_VOLUME_MAX,
  ZOS_VOLUME_MIN,
  ZOS_VOLUME_START,
  brightnessText,
  volumeText,
  type ZosRequestedSettings,
} from "@/lib/zos-link";
import "./zos-console.css";

// A drag fires per notch, and one PUT per notch would race itself. The Slider's
// own throttle coalesces it: the first notch goes out at once (so a click on the
// track feels immediate), then at most one write per interval, with a guaranteed
// trailing write for wherever the user settled.
export const SETTINGS_THROTTLE_MS = 250;

export interface ZosSendSettingsPatch {
  volume?: number;
  brightness?: number;
}

export interface ZosSendRowsProps {
  /** What the service says it will request; null before the first state read. */
  requested: ZosRequestedSettings | null;
  /** PUT /api/os/settings. Errors are the caller's to report — it owns the link. */
  onSend: (patch: ZosSendSettingsPatch) => void;
}

/**
 * 音量与亮度：两行「下发」，全 app 只此一份。
 *
 * 系统面板和常规设置对话框都在调这两个值，而它们说的必须是同一件事——同样的量程、
 * 同样的读数措辞、同样的「没下发过就不许假装是设备读数」。所以草稿状态和退场时机
 * 也留在这里：两边各写一份 useState，迟早会长成两套关于同一台设备的说法。
 *
 * 与一般设置行唯一的实质差别由协议决定：这两个值读不回来（序列号让设备旋钮和侧键
 * 压过控制台），所以没下发过的行读「未下发」、滑块压暗——半满的轨道不能冒充设备
 * 当前的亮度。
 */
export function ZosSendRows({ requested, onSend }: ZosSendRowsProps) {
  // Local drafts win the display until the service echoes the same value back;
  // without them every state poll would snap a mid-drag slider to the old number.
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [brightnessDraft, setBrightnessDraft] = useState<number | null>(null);

  const volumeShown = volumeDraft ?? requested?.volume ?? null;
  const brightnessShown = brightnessDraft ?? requested?.brightness ?? null;

  // Drafts retire once the service echoes them; until then they own the display.
  useEffect(() => {
    if (volumeDraft !== null && requested?.volume === volumeDraft) setVolumeDraft(null);
    if (brightnessDraft !== null && requested?.brightness === brightnessDraft) setBrightnessDraft(null);
  }, [requested?.volume, requested?.brightness, volumeDraft, brightnessDraft]);

  return (
    <div className="zc-out">
      <ZosSendRow
        label="音量"
        min={ZOS_VOLUME_MIN}
        max={ZOS_VOLUME_MAX}
        value={volumeShown ?? ZOS_VOLUME_START}
        sent={volumeShown !== null}
        readout={volumeText(volumeShown)}
        onChange={(value) => {
          setVolumeDraft(value);
          onSend({ volume: value });
        }}
      />
      <ZosSendRow
        label="亮度"
        min={ZOS_BRIGHTNESS_MIN}
        max={ZOS_BRIGHTNESS_MAX}
        value={brightnessShown ?? ZOS_BRIGHTNESS_START}
        sent={brightnessShown !== null}
        readout={brightnessText(brightnessShown)}
        onChange={(value) => {
          setBrightnessDraft(value);
          onSend({ brightness: value });
        }}
      />
    </div>
  );
}

interface ZosSendRowProps {
  label: string;
  min: number;
  max: number;
  value: number;
  /** 这一格下发过没有。没有的话滑块的位置只是个起点，不是设备读数。 */
  sent: boolean;
  readout: string;
  onChange: (value: number) => void;
}

/**
 * 一行「下发」：标签在左，滑块 + 右对齐读数在右。
 *
 * 排布、控件、字号都照「常规设置 → 显示与声音」那两行来——同一个 cladd Slider，
 * 同一套标签/控件/读数的列节奏。音量 0–6 是七格离散值，单看这一条 NumberField 的
 * 加减更贴切，但那样一上一下就是两种控件，全 app 也只有这里这么调音量；一致性优先。
 */
function ZosSendRow({ label, min, max, value, sent, readout, onChange }: ZosSendRowProps) {
  return (
    <div className={sent ? "zc-out__row" : "zc-out__row is-unsent"}>
      <span className="zc-out__label">{label}</span>
      <div className="zc-out__control">
        {/* Slider 拿不到 aria-label，label 包住原生 range 才有名字；量程由
            range 自己的 min/max 播报，不必再写进名字里。 */}
        <label className="zc-out__slider">
          <span className="sr-only">{label}</span>
          <Slider
            value={value}
            min={min}
            max={max}
            step={1}
            color="brand"
            throttle={SETTINGS_THROTTLE_MS}
            onChange={onChange}
          />
        </label>
        <span className="zc-out__value">{readout}</span>
      </div>
    </div>
  );
}
