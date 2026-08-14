import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@cladd-ui/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  VIBE_SCREEN_HEIGHT,
  VIBE_SCREEN_WIDTH,
  drawVibeScreen,
  vibeScreenAgents,
  vibeScreenPageLabel,
  vibeScreenPages,
  type VibeCatalogEntry,
  type VibeUsageSnapshot,
} from "@/lib/vibe";

interface VibePreviewProps {
  catalog: VibeCatalogEntry[];
  snapshot: VibeUsageSnapshot | null;
  starred: Record<string, string[]>;
}

/**
 * The two device pages, drawn here.
 *
 * There is no server render to ask for any more — VIBE is a firmware app, and
 * the clock paints it from the rows in the pull document (design §5). So this
 * folds the snapshot into those same rows and draws them on a 52x16 canvas, the
 * way the mirror and the arcade stage already do: native resolution, upscaled by
 * `image-rendering: pixelated`, so a pixel here is the same object a pixel is
 * everywhere else in the console.
 *
 * The stepper is the knob: page 0 is the overview, then one page per signed-in
 * agent, in the order the document lists them. Nothing here is a setting — the
 * device decides its own ring, and this only walks it.
 */
export function VibePreview({ catalog, snapshot, starred }: VibePreviewProps) {
  const pages = useMemo(
    () => vibeScreenPages(vibeScreenAgents(snapshot, catalog, starred)),
    [catalog, snapshot, starred],
  );
  const [index, setIndex] = useState(0);
  // Signing into one more agent grows the ring; a star change can shrink it.
  // Clamping here rather than resetting keeps the page the user was reading.
  const page = pages[Math.min(index, pages.length - 1)]!;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    // createImageData + set rather than `new ImageData(...)`: the canvas owns
    // the buffer it will blit, same as the ZOS mirror.
    const image = context.createImageData(VIBE_SCREEN_WIDTH, VIBE_SCREEN_HEIGHT);
    image.data.set(drawVibeScreen(page));
    context.putImageData(image, 0, 0);
  }, [page]);

  const caption = vibeScreenPageLabel(page);
  const step = (delta: number) => setIndex((current) => {
    const clamped = Math.min(current, pages.length - 1);
    // A ring, like the knob: past the last page is the first one again.
    return (clamped + delta + pages.length) % pages.length;
  });

  return (
    <div className="vibe-preview">
      <figure className="vibe-screen device-stage">
        <div className="clock-device">
          <div className="clock-screen">
            <canvas
              ref={canvasRef}
              width={VIBE_SCREEN_WIDTH}
              height={VIBE_SCREEN_HEIGHT}
              role="img"
              aria-label={`时钟「VIBE」页 52 × 16 预览；${caption}`}
            />
          </div>
        </div>
        <figcaption>{caption}</figcaption>
      </figure>

      <div className="vibe-preview__pager">
        <Button
          type="button"
          size="sm"
          color="neutral"
          variant="transparent"
          disabled={pages.length < 2}
          aria-label="上一页"
          onClick={() => step(-1)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="vibe-preview__count" role="status">
          第 {Math.min(index, pages.length - 1) + 1} / {pages.length} 页
        </span>
        <Button
          type="button"
          size="sm"
          color="neutral"
          variant="transparent"
          disabled={pages.length < 2}
          aria-label="下一页"
          onClick={() => step(1)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
