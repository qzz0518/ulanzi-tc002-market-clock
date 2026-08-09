import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Download,
  Eraser,
  ImagePlus,
  Move,
  Pencil,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Type,
} from "lucide-react";
import { Button, Input, NumberScrubber, Select, Switch } from "@cladd-ui/react";
import { pixelizeImage, type PixelView, type PixelizeMethod } from "@/lib/canvas-pixelize";
import { renderPixelText } from "@/lib/pixel-font";
import { cn } from "@/lib/utils";
import { useAppToast } from "@/lib/use-app-toast";
import type { BusyAction, ContentItemConfig } from "@/types";
import { WorkspaceActions } from "./workspace-actions";

const WIDTH = 52;
const HEIGHT = 16;
const PIXEL_COUNT = WIDTH * HEIGHT;
const INTERNAL_SCALE = 16;
const PALETTE = [
  0xffffff, 0x00ff66, 0xff3030, 0xffd000, 0x4285f4, 0xf25022,
  0x34a853, 0x00a4ef, 0x9aa0a6, 0xea4335, 0xffb900, 0x000000,
];
const IMAGE_METHODS: Record<PixelizeMethod, string> = {
  mode: "主色投票",
  nearest: "最近邻",
  smooth: "平滑采样",
};

type CanvasTool = "pen" | "eraser" | "select" | "text" | "image";

interface Selection {
  x: number;
  y: number;
  width: number;
  height: number;
}

type PointerAction =
  | { kind: "paint"; erase: boolean }
  | { kind: "marquee"; startX: number; startY: number; endX: number; endY: number }
  | {
      kind: "move";
      buffer: number[];
      width: number;
      height: number;
      grabX: number;
      grabY: number;
      cursorX: number;
      cursorY: number;
    };

interface CanvasWorkspaceProps {
  targetItem: ContentItemConfig | null;
  targetChannelName: string;
  busy: BusyAction;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  deviceOutOfDate: boolean;
  lastPushAt?: string;
  onCreateTarget: () => void;
  onApply: (pixels: number[]) => void;
  onPreview: () => void;
  onPush: () => void;
}

function validPixels(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== PIXEL_COUNT) return null;
  return value.map((pixel) => typeof pixel === "number" && Number.isFinite(pixel) ? pixel : 0);
}

function hexColor(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function insideSelection(selection: Selection | null, x: number, y: number): boolean {
  return Boolean(selection
    && x >= selection.x
    && y >= selection.y
    && x < selection.x + selection.width
    && y < selection.y + selection.height);
}

function boundedOrigin(value: number, extent: number, limit: number): number {
  return Math.max(0, Math.min(limit - extent, value));
}

export function CanvasWorkspace({
  targetItem,
  targetChannelName,
  busy,
  dirty,
  saving,
  lastSavedAt,
  deviceOutOfDate,
  lastPushAt,
  onCreateTarget,
  onApply,
  onPreview,
  onPush,
}: CanvasWorkspaceProps) {
  const toast = useAppToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerActionRef = useRef<PointerAction | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const [pixels, setPixels] = useState<number[]>(() => new Array(PIXEL_COUNT).fill(0));
  const [history, setHistory] = useState<number[][]>([]);
  const [future, setFuture] = useState<number[][]>([]);
  const [tool, setTool] = useState<CanvasTool>("pen");
  const [color, setColor] = useState(0x00ff66);
  const [showGrid, setShowGrid] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [coordinate, setCoordinate] = useState<[number, number]>([0, 0]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pointerRevision, setPointerRevision] = useState(0);
  const [status, setStatus] = useState("左键绘制，右键擦除；也可以选择文字、图片或框选工具。");
  const [canvasText, setCanvasText] = useState("HELLO");
  const [fontHeight, setFontHeight] = useState<5 | 10>(5);
  const [imageView, setImageView] = useState<PixelView | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState(13);
  const [imageMethod, setImageMethod] = useState<PixelizeMethod>("mode");
  const [snapPalette, setSnapPalette] = useState(true);
  const [invertImage, setInvertImage] = useState(false);
  const [exportScale, setExportScale] = useState(12);

  useEffect(() => {
    const stored = validPixels(targetItem?.options.pixels);
    setPixels(stored ?? new Array(PIXEL_COUNT).fill(0));
    setHistory([]);
    setFuture([]);
    setSelection(null);
    pointerActionRef.current = null;
    setStatus(targetItem ? "已载入所选频道中的画板内容。" : "当前频道还没有画板内容，编辑后写入即可创建。");
  }, [targetItem?.id]);

  useEffect(() => () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    context.imageSmoothingEnabled = false;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        context.fillStyle = hexColor(pixels[y * WIDTH + x] ?? 0);
        context.fillRect(x * INTERNAL_SCALE, y * INTERNAL_SCALE, INTERNAL_SCALE, INTERNAL_SCALE);
      }
    }

    if (showGrid) {
      context.strokeStyle = "#242a31";
      context.lineWidth = 1;
      context.setLineDash([]);
      for (let x = 0; x <= WIDTH; x += 1) {
        context.beginPath();
        context.moveTo(x * INTERNAL_SCALE + 0.5, 0);
        context.lineTo(x * INTERNAL_SCALE + 0.5, HEIGHT * INTERNAL_SCALE);
        context.stroke();
      }
      for (let y = 0; y <= HEIGHT; y += 1) {
        context.beginPath();
        context.moveTo(0, y * INTERNAL_SCALE + 0.5);
        context.lineTo(WIDTH * INTERNAL_SCALE, y * INTERNAL_SCALE + 0.5);
        context.stroke();
      }
    }

    const drawSelection = (value: Selection) => {
      context.save();
      context.strokeStyle = "#00ff66";
      context.lineWidth = 2;
      context.setLineDash([6, 4]);
      context.strokeRect(
        value.x * INTERNAL_SCALE + 1,
        value.y * INTERNAL_SCALE + 1,
        value.width * INTERNAL_SCALE - 2,
        value.height * INTERNAL_SCALE - 2,
      );
      context.restore();
    };

    const pointerAction = pointerActionRef.current;
    if (pointerAction?.kind === "move") {
      const originX = boundedOrigin(pointerAction.cursorX - pointerAction.grabX, pointerAction.width, WIDTH);
      const originY = boundedOrigin(pointerAction.cursorY - pointerAction.grabY, pointerAction.height, HEIGHT);
      pointerAction.buffer.forEach((pixel, index) => {
        if (pixel === 0) return;
        context.fillStyle = hexColor(pixel);
        context.fillRect(
          (originX + index % pointerAction.width) * INTERNAL_SCALE,
          (originY + Math.floor(index / pointerAction.width)) * INTERNAL_SCALE,
          INTERNAL_SCALE,
          INTERNAL_SCALE,
        );
      });
      drawSelection({ x: originX, y: originY, width: pointerAction.width, height: pointerAction.height });
    } else if (pointerAction?.kind === "marquee") {
      const x = Math.min(pointerAction.startX, pointerAction.endX);
      const y = Math.min(pointerAction.startY, pointerAction.endY);
      drawSelection({
        x,
        y,
        width: Math.abs(pointerAction.endX - pointerAction.startX) + 1,
        height: Math.abs(pointerAction.endY - pointerAction.startY) + 1,
      });
    } else if (selection) {
      drawSelection(selection);
    }

    const cursorX = cursor % WIDTH;
    const cursorY = Math.floor(cursor / WIDTH);
    context.strokeStyle = "#ffffff";
    context.lineWidth = 1;
    context.setLineDash([]);
    context.strokeRect(
      cursorX * INTERNAL_SCALE + 2,
      cursorY * INTERNAL_SCALE + 2,
      INTERNAL_SCALE - 4,
      INTERNAL_SCALE - 4,
    );
  }, [cursor, pixels, pointerRevision, selection, showGrid]);

  const snapshot = useCallback((value: number[] = pixels) => {
    setHistory((current) => [...current.slice(-49), value.slice()]);
    setFuture([]);
  }, [pixels]);

  const canvasPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const rectangle = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(WIDTH - 1, Math.floor((event.clientX - rectangle.left) / rectangle.width * WIDTH))),
      Math.max(0, Math.min(HEIGHT - 1, Math.floor((event.clientY - rectangle.top) / rectangle.height * HEIGHT))),
    ];
  }, []);

  const paintAt = useCallback((x: number, y: number, erase = false) => {
    const index = y * WIDTH + x;
    setCursor(index);
    setCoordinate([x, y]);
    setPixels((current) => {
      const value = erase || tool === "eraser" ? 0 : color;
      if (current[index] === value) return current;
      const next = current.slice();
      next[index] = value;
      return next;
    });
  }, [color, tool]);

  const activateTool = (nextTool: CanvasTool) => {
    pointerActionRef.current = null;
    setTool(nextTool);
    setSelection(null);
    setPointerRevision((current) => current + 1);
    const messages: Record<CanvasTool, string> = {
      pen: "画笔：左键绘制，右键临时擦除。",
      eraser: "橡皮：拖动清除像素。",
      select: "选择：拖出选区，再从选区内部拖动搬移。",
      text: "文字：先在右侧设置内容，再点击画布决定左上角。",
      image: "图片：从右侧上传并生成，生成后可整体搬移。",
    };
    setStatus(messages[nextTool]);
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((current) => [...current, pixels.slice()]);
    setPixels(previous);
    setHistory((current) => current.slice(0, -1));
    setSelection(null);
    toast.success("已撤销");
  };

  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setHistory((current) => [...current, pixels.slice()]);
    setPixels(next);
    setFuture((current) => current.slice(0, -1));
    setSelection(null);
    toast.success("已重做");
  };

  const clear = () => {
    snapshot();
    setPixels(new Array(PIXEL_COUNT).fill(0));
    setSelection(null);
    toast.success("画布已清空", { description: "可以撤销恢复。" });
  };

  const placeText = (x: number, y: number) => {
    if (!canvasText) {
      toast.error("请先输入 ASCII 文字");
      return;
    }
    const bitmap = renderPixelText(canvasText, fontHeight);
    if (!bitmap.on.some((value) => value === 1)) {
      toast.error("没有可显示的字符", { description: "设备像素字体仅支持 ASCII。" });
      return;
    }
    snapshot();
    setPixels((current) => {
      const next = current.slice();
      for (let bitmapY = 0; bitmapY < bitmap.height; bitmapY += 1) {
        for (let bitmapX = 0; bitmapX < bitmap.width; bitmapX += 1) {
          if (bitmap.on[bitmapY * bitmap.width + bitmapX] !== 1) continue;
          const pixelX = x + bitmapX;
          const pixelY = y + bitmapY;
          if (pixelX >= WIDTH || pixelY >= HEIGHT) continue;
          next[pixelY * WIDTH + pixelX] = color;
        }
      }
      return next;
    });
    setStatus(`已在 (${x}, ${y}) 放置“${canvasText}”，可继续点击放置。`);
  };

  const readImage = async (file: File) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("image load failed"));
        image.src = url;
      });
      const temporaryCanvas = document.createElement("canvas");
      temporaryCanvas.width = image.naturalWidth;
      temporaryCanvas.height = image.naturalHeight;
      const context = temporaryCanvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("canvas unavailable");
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, temporaryCanvas.width, temporaryCanvas.height);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = url;
      setImageUrl(url);
      setImageName(file.name);
      setImageView({ width: data.width, height: data.height, data: data.data });
      setTool("image");
      setSelection(null);
      setStatus("图片已读取；在右侧调整像素化参数，然后生成到画布。");
    } catch {
      URL.revokeObjectURL(url);
      toast.error("图片读取失败");
    }
  };

  const generateImage = () => {
    if (!imageView) {
      toast.error("请先上传一张图片");
      return;
    }
    const block = pixelizeImage(imageView, {
      size: imageSize,
      method: imageMethod,
      snap: snapPalette,
      invert: invertImage,
      palette: PALETTE,
    });
    if (!block) {
      toast.error("没有识别到主体", { description: "可以换一张图，或开启「暗色作为主体」。" });
      return;
    }
    snapshot();
    setPixels((current) => {
      const next = current.slice();
      block.pixels.forEach((pixel, index) => {
        if (pixel === null) return;
        const x = index % block.width;
        const y = Math.floor(index / block.width);
        if (x < WIDTH && y < HEIGHT) next[y * WIDTH + x] = pixel;
      });
      return next;
    });
    setTool("select");
    setSelection({ x: 0, y: 0, width: block.width, height: block.height });
    setStatus(`已生成 ${block.width}×${block.height} 像素块；拖动绿色选区可搬移。`);
  };

  const exportCanvas = () => {
    const output = document.createElement("canvas");
    const context = output.getContext("2d");
    if (!context) return;
    output.width = WIDTH * exportScale;
    output.height = HEIGHT * exportScale;
    pixels.forEach((pixel, index) => {
      context.fillStyle = hexColor(pixel || 0);
      context.fillRect(
        index % WIDTH * exportScale,
        Math.floor(index / WIDTH) * exportScale,
        exportScale,
        exportScale,
      );
    });
    const link = document.createElement("a");
    link.download = "tc002-canvas.png";
    link.href = output.toDataURL("image/png");
    link.click();
    toast.success(`已按 ${exportScale}× 倍率导出 PNG`);
  };

  const finishPointerAction = () => {
    const action = pointerActionRef.current;
    if (!action) return;
    pointerActionRef.current = null;

    if (action.kind === "move") {
      const originX = boundedOrigin(action.cursorX - action.grabX, action.width, WIDTH);
      const originY = boundedOrigin(action.cursorY - action.grabY, action.height, HEIGHT);
      setPixels((current) => {
        const next = current.slice();
        action.buffer.forEach((pixel, index) => {
          if (pixel === 0) return;
          const x = originX + index % action.width;
          const y = originY + Math.floor(index / action.width);
          next[y * WIDTH + x] = pixel;
        });
        return next;
      });
      setSelection({ x: originX, y: originY, width: action.width, height: action.height });
      setStatus(`选区已搬移到 (${originX}, ${originY})。`);
    } else if (action.kind === "marquee") {
      const x = Math.min(action.startX, action.endX);
      const y = Math.min(action.startY, action.endY);
      const nextSelection = {
        x,
        y,
        width: Math.abs(action.endX - action.startX) + 1,
        height: Math.abs(action.endY - action.startY) + 1,
      };
      setSelection(nextSelection);
      setStatus(`已框选 ${nextSelection.width}×${nextSelection.height}；从选区内部拖动即可搬移。`);
    }
    setPointerRevision((current) => current + 1);
  };

  const beginPointerAction = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const [x, y] = canvasPoint(event);
    setCursor(y * WIDTH + x);
    setCoordinate([x, y]);

    if (tool === "text") {
      placeText(x, y);
      return;
    }
    if (tool === "image") {
      toast.error("请先从右侧的图片工具生成像素块");
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "select") {
      if (insideSelection(selection, x, y) && selection) {
        snapshot();
        const buffer: number[] = [];
        for (let selectionY = 0; selectionY < selection.height; selectionY += 1) {
          for (let selectionX = 0; selectionX < selection.width; selectionX += 1) {
            buffer.push(pixels[(selection.y + selectionY) * WIDTH + selection.x + selectionX] ?? 0);
          }
        }
        setPixels((current) => {
          const next = current.slice();
          for (let selectionY = 0; selectionY < selection.height; selectionY += 1) {
            for (let selectionX = 0; selectionX < selection.width; selectionX += 1) {
              next[(selection.y + selectionY) * WIDTH + selection.x + selectionX] = 0;
            }
          }
          return next;
        });
        pointerActionRef.current = {
          kind: "move",
          buffer,
          width: selection.width,
          height: selection.height,
          grabX: x - selection.x,
          grabY: y - selection.y,
          cursorX: x,
          cursorY: y,
        };
        setSelection(null);
      } else {
        pointerActionRef.current = { kind: "marquee", startX: x, startY: y, endX: x, endY: y };
      }
      setPointerRevision((current) => current + 1);
      return;
    }

    snapshot();
    const erase = event.button === 2 || tool === "eraser";
    pointerActionRef.current = { kind: "paint", erase };
    paintAt(x, y, erase);
  };

  const continuePointerAction = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const [x, y] = canvasPoint(event);
    setCursor(y * WIDTH + x);
    setCoordinate([x, y]);
    const action = pointerActionRef.current;
    if (!action) return;
    if (action.kind === "paint") {
      paintAt(x, y, action.erase);
      return;
    }
    if (action.kind === "marquee") {
      action.endX = x;
      action.endY = y;
    } else {
      action.cursorX = x;
      action.cursorY = y;
    }
    setPointerRevision((current) => current + 1);
  };

  const writeToChannel = () => {
    onApply(pixels);
  };

  return (
    <>
      <main className="canvas-workspace">
        <div className="canvas-toolbar">
          <div className="preview-copy">
            <h2>画布编辑</h2>
            <span>所选频道：{targetChannelName} · 52×16</span>
          </div>
          <Button type="button" size="sm" onClick={onCreateTarget}>新建画板内容</Button>
          <WorkspaceActions
            busy={busy}
            dirty={dirty}
            saving={saving}
            lastSavedAt={lastSavedAt}
            deviceOutOfDate={deviceOutOfDate}
            lastPushAt={lastPushAt}
            disabled={!targetItem}
            onPreview={onPreview}
            onPush={onPush}
          />
        </div>

        <section className="pixel-canvas-panel">
          <canvas
            ref={canvasRef}
            width={WIDTH * INTERNAL_SCALE}
            height={HEIGHT * INTERNAL_SCALE}
            tabIndex={0}
            aria-label="52乘16像素画布；方向键移动光标，空格或回车绘制"
            onPointerDown={beginPointerAction}
            onPointerMove={continuePointerAction}
            onPointerUp={finishPointerAction}
            onPointerCancel={finishPointerAction}
            onLostPointerCapture={finishPointerAction}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              let x = cursor % WIDTH;
              let y = Math.floor(cursor / WIDTH);
              if (event.key === "ArrowLeft") x = Math.max(0, x - 1);
              else if (event.key === "ArrowRight") x = Math.min(WIDTH - 1, x + 1);
              else if (event.key === "ArrowUp") y = Math.max(0, y - 1);
              else if (event.key === "ArrowDown") y = Math.min(HEIGHT - 1, y + 1);
              else if (event.key === " " || event.key === "Enter") {
                if (tool === "text") placeText(x, y);
                else if (tool === "pen" || tool === "eraser") {
                  snapshot();
                  paintAt(x, y);
                }
                event.preventDefault();
                return;
              } else return;
              setCursor(y * WIDTH + x);
              setCoordinate([x, y]);
              event.preventDefault();
            }}
          />
          <span className="canvas-coordinate">坐标 ({coordinate[0]}, {coordinate[1]})</span>
        </section>

        <section className="canvas-controls" aria-label="画板工具">
          <div className="canvas-toolset" role="toolbar" aria-label="绘制工具">
            <Button type="button" size="sm" aria-pressed={tool === "pen"} color={tool === "pen" ? "brand" : "neutral"} onClick={() => activateTool("pen")}><Pencil />画笔</Button>
            <Button type="button" size="sm" aria-pressed={tool === "eraser"} color={tool === "eraser" ? "brand" : "neutral"} onClick={() => activateTool("eraser")}><Eraser />橡皮</Button>
            <Button type="button" size="sm" aria-pressed={tool === "select"} color={tool === "select" ? "brand" : "neutral"} onClick={() => activateTool("select")}><Move />选择</Button>
            <Button type="button" size="sm" aria-pressed={tool === "text"} color={tool === "text" ? "brand" : "neutral"} onClick={() => activateTool("text")}><Type />文字</Button>
            <Button type="button" size="sm" aria-pressed={tool === "image"} color={tool === "image" ? "brand" : "neutral"} onClick={() => activateTool("image")}><ImagePlus />图片</Button>
          </div>
          <div className="palette" aria-label="颜色">
            {PALETTE.map((value) => (
              <button
                key={value}
                type="button"
                className={cn("color-swatch", color === value && tool === "pen" && "is-active")}
                style={{ backgroundColor: hexColor(value) }}
                aria-label={`颜色 ${hexColor(value)}`}
                aria-pressed={color === value && tool === "pen"}
                onClick={() => { setColor(value); activateTool("pen"); }}
              />
            ))}
            <Input
              className="custom-color"
              type="color"
              value={hexColor(color)}
              inputComponentProps={{ "aria-label": "自定义颜色" }}
              onChange={(nextValue) => { setColor(Number.parseInt(nextValue.slice(1), 16)); activateTool("pen"); }}
            />
          </div>
        </section>

        <section className="canvas-command-bar">
          <label className="grid-toggle">
            <Switch as="span" input checked={showGrid} onChange={setShowGrid} />
            显示网格
          </label>
          <div className="canvas-history-actions">
            <Button type="button" variant="transparent" outline={false} size="sm" square disabled={history.length === 0} onClick={undo} aria-label="撤销" title="撤销"><RotateCcw /></Button>
            <Button type="button" variant="transparent" outline={false} size="sm" square disabled={future.length === 0} onClick={redo} aria-label="重做" title="重做"><Redo2 /></Button>
            <Button type="button" color="red" variant="transparent" outline={false} size="sm" square onClick={clear} aria-label="清空画布" title="清空画布"><Trash2 /></Button>
          </div>
          <Button type="button" color="brand" size="sm" onClick={writeToChannel}><Save />写入到所选频道</Button>
        </section>

        <p className="canvas-status" aria-live="polite">{status}</p>
      </main>

      <aside className="canvas-inspector" aria-label="画板设置">
        <div className="canvas-inspector-heading">
          <h2>画板设置</h2>
          <span>{targetItem ? "已关联内容" : "新内容"}</span>
        </div>
        <div className="canvas-inspector-scroll">
          <section className={cn("canvas-inspector-section", tool === "text" && "is-active")}>
            <div className="canvas-tool-heading">
              <Type aria-hidden="true" />
              <div><h3>ASCII 文字</h3><p>点击画布决定文字左上角。</p></div>
            </div>
            <label className="canvas-field" htmlFor="canvas-text">
              <span>文字内容</span>
              <Input inputId="canvas-text" value={canvasText} maxLength={40} onChange={setCanvasText} />
            </label>
            <label className="canvas-field" htmlFor="canvas-font-height">
              <span>字高</span>
              <Select
                id="canvas-font-height"
                aria-label="像素文字字高"
                value={String(fontHeight)}
                options={["5", "10"]}
                renderOption={({ value }) => `${value}px`}
                onChange={(value) => setFontHeight(value === "10" ? 10 : 5)}
              >
                {fontHeight}px
              </Select>
            </label>
            <Button type="button" color={tool === "text" ? "brand" : "neutral"} onClick={() => activateTool("text")}><Type />在画布上落字</Button>
          </section>

          <section className={cn("canvas-inspector-section", tool === "image" && "is-active")}>
            <div className="canvas-tool-heading">
              <ImagePlus aria-hidden="true" />
              <div><h3>图片像素化</h3><p>自动裁切主体，生成后可整体搬移。</p></div>
            </div>
            <Button as="label" className="file-trigger" htmlFor="canvas-image"><ImagePlus />选择图片</Button>
            <input
              id="canvas-image"
              className="sr-only"
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void readImage(file);
                event.currentTarget.value = "";
              }}
            />
            <div className={cn("canvas-image-preview", !imageUrl && "is-empty")}>
              {imageUrl ? <img src={imageUrl} alt="待像素化图片预览" /> : <span>尚未选择图片</span>}
            </div>
            {imageName && <span className="canvas-file-name" title={imageName}>{imageName}</span>}
            <label className="canvas-field" htmlFor="canvas-image-size">
              <span>输出高度</span>
              <NumberScrubber
                id="canvas-image-size"
                className="number-scrubber canvas-number-scrubber"
                contentClassName="number-scrubber__content"
                inputClassName="number-scrubber__input"
                value={imageSize}
                min={8}
                max={16}
                step={1}
                aria-label="输出高度，可左右拖动或点击输入"
                title="左右拖动调整，点击输入"
                color="neutral"
                displayValue={(value) => `${Math.round(value)} px`}
                onChange={(value) => setImageSize(Math.round(value))}
              />
            </label>
            <label className="canvas-field" htmlFor="canvas-image-method">
              <span>采样方法</span>
              <Select
                id="canvas-image-method"
                aria-label="图片像素化采样方法"
                value={imageMethod}
                options={Object.keys(IMAGE_METHODS)}
                renderOption={({ value }) => IMAGE_METHODS[value as PixelizeMethod]}
                onChange={(value) => setImageMethod(value as PixelizeMethod)}
              >
                {IMAGE_METHODS[imageMethod]}
              </Select>
            </label>
            <label className="canvas-switch-row">
              <span><strong>吸附纯色</strong><small>匹配设备调色板</small></span>
              <Switch as="span" input checked={snapPalette} onChange={setSnapPalette} />
            </label>
            <label className="canvas-switch-row">
              <span><strong>暗色作为主体</strong><small>适合纯黑 Logo</small></span>
              <Switch as="span" input checked={invertImage} onChange={setInvertImage} />
            </label>
            <Button type="button" color="brand" disabled={!imageView} onClick={generateImage}><ImagePlus />生成到画布</Button>
          </section>

          <section className="canvas-inspector-section">
            <div className="canvas-tool-heading">
              <Download aria-hidden="true" />
              <div><h3>导出 PNG</h3><p>保留像素边缘，适合分享或归档。</p></div>
            </div>
            <label className="canvas-field" htmlFor="canvas-export-scale">
              <span>放大倍率</span>
              <Select
                id="canvas-export-scale"
                aria-label="PNG 导出放大倍率"
                value={String(exportScale)}
                options={["8", "12", "16", "20"]}
                renderOption={({ value }) => `${value}×`}
                onChange={(value) => setExportScale(Number(value))}
              >
                {exportScale}×
              </Select>
            </label>
            <Button type="button" onClick={exportCanvas}><Download />导出 PNG</Button>
          </section>
        </div>
      </aside>
    </>
  );
}
