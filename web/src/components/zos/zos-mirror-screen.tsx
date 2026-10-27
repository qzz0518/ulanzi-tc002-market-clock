import { useEffect, useRef, useState } from "react";
import {
  ZOS_SCREEN_HEIGHT,
  ZOS_SCREEN_WIDTH,
  decodeMirrorFrame,
  type ZosMirrorStatus,
} from "@/lib/zos-link";

interface ZosMirrorScreenProps {
  /** Base64 RGB of the last frame the device put on its panel, or null. */
  rgbBase64: string | null;
  status: ZosMirrorStatus;
}

/**
 * The 52×16 mirror, painted at the panel's native resolution and upscaled by
 * the LED bezel's `image-rendering: pixelated` — the same treatment the arcade
 * stage uses, so a pixel here is the same object a pixel is everywhere else in
 * the console.
 *
 * The canvas is deliberately wiped whenever the status says the picture cannot
 * be trusted. A frozen last frame under a "device offline" label still reads as
 * a working screen at a glance, and the whole point of this panel is that what
 * you see is what the device received.
 */
export function ZosMirrorScreen({ rgbBase64, status }: ZosMirrorScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The notice stays mounted and fades, so offline → live is a cross-fade over
  // the first frame rather than the scrim vanishing in one paint. While it fades
  // out it keeps saying what it last said instead of going blank mid-fade.
  const [notice, setNotice] = useState(
    status.notice === null ? null : { label: status.label, text: status.notice },
  );
  if (status.notice !== null && (notice?.label !== status.label || notice?.text !== status.notice)) {
    setNotice({ label: status.label, text: status.notice });
  }
  const noticeShown = status.notice !== null;

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    if (!status.showsFrame || rgbBase64 === null) {
      context.clearRect(0, 0, ZOS_SCREEN_WIDTH, ZOS_SCREEN_HEIGHT);
      return;
    }
    const rgba = decodeMirrorFrame(rgbBase64);
    // A frame that failed to decode leaves the previous one in place rather
    // than flashing black: one malformed response should not strobe the mirror.
    if (!rgba) return;
    // createImageData + set rather than `new ImageData(rgba, …)`: the decoder
    // hands back a plain buffer, and the canvas owns the one it will blit.
    const image = context.createImageData(ZOS_SCREEN_WIDTH, ZOS_SCREEN_HEIGHT);
    image.data.set(rgba);
    context.putImageData(image, 0, 0);
  }, [rgbBase64, status.showsFrame]);

  return (
    <figure className="zc-screen">
      <div className="zc-screen__frame">
        <canvas
          ref={canvasRef}
          width={ZOS_SCREEN_WIDTH}
          height={ZOS_SCREEN_HEIGHT}
          role="img"
          aria-label={`时钟面板 52 × 16 实时镜像；${status.label}`}
        />
        {notice && (
          <p
            className="zc-screen__notice"
            data-shown={noticeShown}
            role="status"
            aria-hidden={noticeShown ? undefined : true}
          >
            <strong>{notice.label}</strong>
            <span>{notice.text}</span>
          </p>
        )}
      </div>
      <figcaption>
        <span>52 × 16 · 固件合成器直出</span>
        <span className={status.phase === "live" ? "zc-screen__state is-live" : "zc-screen__state"}>
          {status.label}
        </span>
      </figcaption>
    </figure>
  );
}
