import { useEffect, useRef } from "react";
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
        {status.notice && (
          <p className="zc-screen__notice" role="status">
            <strong>{status.label}</strong>
            <span>{status.notice}</span>
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
