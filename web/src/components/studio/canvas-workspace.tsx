import {
  useCallback,
  useEffect,
  useMemo,
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
  QrCode,
  Redo2,
  RotateCcw,
  FilePlus2,
  Save,
  Trash2,
  Type,
} from "lucide-react";
import { Button, Chip, Input, NumberScrubber, Select, Switch } from "@cladd-ui/react";
import { pixelizeImage, type PixelView, type PixelizeMethod } from "@/lib/canvas-pixelize";
import { connectRoomSocket, type RoomSocket } from "@/lib/game-socket";
import {
  createLiveScreen,
  LIVE_BATCH_FRAMES,
  LIVE_FRAME_MS,
  type LiveScreen,
} from "@/lib/live-screen";
import {
  beginTextPlacement,
  layoutTextBlock,
  measureTextBlockFit,
  moveTextPlacement,
  TEXT_FACES,
  textBlockHasInk,
  textPlacementRect,
  type TextFace,
  type TextPlacement,
} from "@/lib/pixel-text-block";
import { cn, errorMessage } from "@/lib/utils";
import { useAppToast } from "@/lib/use-app-toast";
import type { FirmwareMode } from "@/lib/firmware-mode";
import type { BusyAction, ContentItemConfig } from "@/types";
import { InviteQrDialog } from "@/components/game/invite-qr-dialog";
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
// The presets are the honest set the 16-row panel allows, not a taste menu:
// the 3x5 face at 1x/2x/3x (4x would be 20 rows), the 5x7 face at 1x/2x, and
// the firmware's own 12px blob, which is the only one with CJK and the only one
// that must not be resampled. `charset` is what the face can actually draw and
// is shown verbatim in the inspector — a face that quietly cannot type a comma
// is the failure mode worth spending a line on.
const TEXT_FACE_META: Record<TextFace, { name: string; note: string; charset: string }> = {
  "shared-12": {
    name: "12px 中日文",
    note: "与固件同字库，唯一能写中日文",
    charset: "中日文、假名与 ASCII",
  },
  "ascii-5": {
    name: "5px 小字",
    note: "3×5 点阵，仅 ASCII，可叠两行",
    charset: "3×5 点阵只有 ASCII 字母、数字和常用标点",
  },
  "ascii-10": {
    name: "10px 大字",
    note: "3×5 点阵放大一倍，仅 ASCII",
    charset: "3×5 点阵只有 ASCII 字母、数字和常用标点",
  },
  "ascii-15": {
    name: "15px 特大字",
    note: "3×5 点阵放大两倍，15 行几乎占满，一行 4 字",
    charset: "3×5 点阵只有 ASCII 字母、数字和常用标点",
  },
  "wide-7": {
    name: "7px 宽体",
    note: "5×7 变宽点阵，字形更圆润",
    charset: "5×7 宽体只有大写字母、数字和 ?",
  },
  "wide-14": {
    name: "14px 宽体大字",
    note: "5×7 放大一倍，一行 5 字左右",
    charset: "5×7 宽体只有大写字母、数字和 ?",
  },
};
// The probe character that measures a face's own row budget: a hanzi for the
// shared face (12px cells), a letter for the latin ones. The 5x7 face is
// variable-width, so its budget is only ever a typical-case number — "A" is its
// modal 4px width, which is what the inspector should promise.
const FACE_PROBE: Record<TextFace, string> = {
  "shared-12": "你",
  "ascii-5": "A",
  "ascii-10": "A",
  "ascii-15": "A",
  "wide-7": "A",
  "wide-14": "A",
};
// Doodle-wall live mode (pixel-playground.md §7): static art does not chase
// frame rate, one device frame per 300ms window is plenty.
const DOODLE_LIVE_THROTTLE_MS = 300;
// Board edits touching more cells than this travel as one snapshot message.
const DOODLE_STROKE_SYNC_LIMIT = 32;

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
  // Dragging freshly placed text: not a pixel lift but a repaint from the board
  // as it was before the text landed — see TextPlacement. `moved` stays false
  // until the origin really changes, so a click that only re-grabs the text
  // costs neither a history entry nor a status line claiming it went somewhere.
  | { kind: "text-move"; grabX: number; grabY: number; moved: boolean }
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
  /**
   * 频道的旋钮项名。ZOS 固定设备画面认的是它，不是显示名——拿不到就只能显示
   * 状态、给不出「在时钟上显示」这个按钮。
   */
  targetChannelAppName?: string;
  /** 未启用的频道不在设备菜单里，固定它在固件那侧会静默失败。 */
  targetChannelEnabled?: boolean;
  busy: BusyAction;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  deviceOutOfDate: boolean;
  lastPushAt?: string;
  // ZOS 下 /api/live/frames 那条即时上屏链路不存在（官方 Custom App 接收端随
  // 固件一起没了），但涂鸦墙本身是控制台内部的协作，照常可用。
  firmwareMode?: FirmwareMode;
  onCreateTarget: () => void;
  onApply: (pixels: number[]) => void;
  /** Writes the same pixels into a brand-new channel instead of the selected one. */
  onApplyAsChannel?: (pixels: number[]) => void;
  /** 见 WorkspaceActions.onFlushEdits：固定到时钟前先把待保存的改动落盘。 */
  onFlushEdits?: () => Promise<boolean>;
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

interface SwatchPickerProps {
  label: string;
  value: number;
  /** The pen row goes quiet while another tool is active, so highlight is opt-in. */
  active?: boolean;
  onSelect: (value: number) => void;
}

// One swatch row, used by both the pen and the text backdrop — a second colour
// control built by hand would drift from this one on the first restyle.
function SwatchPicker({ label, value, active = true, onSelect }: SwatchPickerProps) {
  return (
    <div className="palette" aria-label={label}>
      {PALETTE.map((swatch) => (
        <button
          key={swatch}
          type="button"
          className={cn("color-swatch", active && value === swatch && "is-active")}
          style={{ backgroundColor: hexColor(swatch) }}
          aria-label={`${label} ${hexColor(swatch)}`}
          aria-pressed={active && value === swatch}
          onClick={() => onSelect(swatch)}
        />
      ))}
      <Input
        className="custom-color"
        type="color"
        value={hexColor(value)}
        inputComponentProps={{ "aria-label": `${label}（自定义）` }}
        onChange={(nextValue) => onSelect(Number.parseInt(nextValue.slice(1), 16))}
      />
    </div>
  );
}

export function CanvasWorkspace({
  targetItem,
  targetChannelName,
  targetChannelAppName,
  targetChannelEnabled = true,
  busy,
  dirty,
  saving,
  lastSavedAt,
  deviceOutOfDate,
  lastPushAt,
  firmwareMode = "official",
  onCreateTarget,
  onApply,
  onApplyAsChannel,
  onFlushEdits,
  onPreview,
  onPush,
}: CanvasWorkspaceProps) {
  const zos = firmwareMode === "zos";
  const toast = useAppToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerActionRef = useRef<PointerAction | null>(null);
  // The last placed text, while it is still movable. Dropped by anything that
  // invalidates it (another tool, undo, a new selection), so the select tool
  // only ever sees it when the green box on screen really is that text.
  const textPlacementRef = useRef<TextPlacement | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const liveScreenRef = useRef<LiveScreen | null>(null);
  const liveSocketRef = useRef<RoomSocket | null>(null);
  const liveFrameRef = useRef<HTMLCanvasElement | null>(null);
  // Fake capture clock — see pushLiveFrame for why it steps a whole batch.
  const liveClockRef = useRef(0);
  const livePushTimerRef = useRef<number | null>(null);
  const livePendingRef = useRef(false);
  // The wall state this board last agreed on; null until the join snapshot.
  const lastSyncedRef = useRef<number[] | null>(null);
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
  // Defaults to the shared face: the console speaks Chinese, so the face that
  // can actually draw Chinese is the one to land on.
  const [textFace, setTextFace] = useState<TextFace>("shared-12");
  const [textFill, setTextFill] = useState(false);
  // Black is the panel's "LED off", so the default fill reads as "clear the
  // board and show only these words" — the least surprising thing a full-field
  // fill can do the first time it is switched on.
  const [textFillColor, setTextFillColor] = useState(0x000000);
  const [imageView, setImageView] = useState<PixelView | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState(13);
  const [imageMethod, setImageMethod] = useState<PixelizeMethod>("mode");
  const [snapPalette, setSnapPalette] = useState(true);
  const [invertImage, setInvertImage] = useState(false);
  const [exportScale, setExportScale] = useState(12);
  const [live, setLive] = useState(false);
  const [liveInviteOpen, setLiveInviteOpen] = useState(false);
  const pixelsRef = useRef(pixels);
  pixelsRef.current = pixels;

  // The green box and the live placement are one thing — a selection the user
  // framed by hand must not be draggable as text — so they are always set
  // together and can never drift apart.
  const applySelection = useCallback(
    (next: Selection | null, placement: TextPlacement | null = null) => {
      textPlacementRef.current = placement;
      setSelection(next);
    },
    [],
  );

  // Laid out on every keystroke so the inspector can state the row budget and
  // name the undrawable characters *before* the canvas is clicked.
  const textBlock = useMemo(() => layoutTextBlock(canvasText, textFace), [canvasText, textFace]);
  const textFit = useMemo(
    () => measureTextBlockFit(canvasText, textFace, WIDTH),
    [canvasText, textFace],
  );
  const faceBudget = useMemo(
    () => measureTextBlockFit(FACE_PROBE[textFace].repeat(64), textFace, WIDTH).capacity,
    [textFace],
  );

  useEffect(() => {
    const stored = validPixels(targetItem?.options.pixels);
    setPixels(stored ?? new Array(PIXEL_COUNT).fill(0));
    setHistory([]);
    setFuture([]);
    applySelection(null);
    pointerActionRef.current = null;
    const loaded = targetItem
      ? "已载入所选频道中的画板内容。"
      : "当前频道还没有画板内容，编辑后写入即可创建。";
    // Under ZOS the canvas' route to the panel changed shape rather than closing:
    // a written channel still reaches the device, the device just fetches it
    // itself — there is no "push once and it lights up" step to promise.
    setStatus(zos ? `${loaded}写入频道后由时钟自己拉取上屏。` : loaded);
  }, [targetItem?.id, zos]);

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

  // One call = one recorded batch of the same picture. createLiveScreen flushes
  // after LIVE_BATCH_FRAMES cadence slots, so a fake clock steps the full batch
  // per call instead of waiting for four separate edits; the board renders into
  // a clean offscreen 52×16 canvas (no grid, cursor, or selection overlays).
  const pushLiveFrame = useCallback(() => {
    const screen = liveScreenRef.current;
    if (!screen) return;
    let frame = liveFrameRef.current;
    if (!frame) {
      frame = document.createElement("canvas");
      frame.width = WIDTH;
      frame.height = HEIGHT;
      liveFrameRef.current = frame;
    }
    const context = frame.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    pixelsRef.current.forEach((pixel, index) => {
      context.fillStyle = hexColor(pixel || 0);
      context.fillRect(index % WIDTH, Math.floor(index / WIDTH), 1, 1);
    });
    for (let step = 0; step < LIVE_BATCH_FRAMES; step += 1) {
      liveClockRef.current += LIVE_FRAME_MS;
      screen.capture(context, liveClockRef.current);
    }
  }, []);

  // Leading + trailing 300ms throttle: a drawing stroke shows up immediately,
  // a burst of edits collapses into one refresh per window.
  const scheduleLivePush = useCallback(() => {
    if (livePushTimerRef.current !== null) {
      livePendingRef.current = true;
      return;
    }
    pushLiveFrame();
    livePushTimerRef.current = window.setTimeout(() => {
      livePushTimerRef.current = null;
      if (livePendingRef.current) {
        livePendingRef.current = false;
        scheduleLivePush();
      }
    }, DOODLE_LIVE_THROTTLE_MS);
  }, [pushLiveFrame]);

  // Wall messages need the freshest board state and helpers, so the handler
  // lives in a ref (same render-assign pattern as pixelsRef above).
  const applyRemoteRef = useRef<(message: Record<string, unknown>) => void>(() => undefined);
  applyRemoteRef.current = (message) => {
    if (
      message.type === "snapshot"
      && Array.isArray(message.pixels)
      && message.pixels.length === PIXEL_COUNT
    ) {
      const incoming = message.pixels.map((value) =>
        typeof value === "number" && Number.isFinite(value) ? value : 0
      );
      const local = pixelsRef.current;
      const wallEmpty = incoming.every((value) => value === 0);
      const boardEmpty = local.every((value) => value === 0);
      if (wallEmpty && !boardEmpty) {
        // Fresh wall, existing board art: seed the wall from the board.
        lastSyncedRef.current = local.slice();
        liveSocketRef.current?.send({ type: "snapshot", pixels: local });
        return;
      }
      lastSyncedRef.current = incoming.slice();
      if (!wallEmpty) {
        // The wall already has a session going — adopt it, undo can recover.
        snapshot();
        setPixels(incoming);
        // The board this text was placed on is gone, so it is no longer a thing
        // that can be moved back onto it.
        applySelection(null);
        setStatus("已同步涂鸦墙内容，访客笔画会实时合并进来。");
      }
      return;
    }
    if (message.type === "stroke" && typeof message.x === "number" && typeof message.y === "number") {
      const x = Math.floor(message.x);
      const y = Math.floor(message.y);
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      const value = typeof message.color === "number" && Number.isFinite(message.color)
        ? message.color
        : 0;
      const index = y * WIDTH + x;
      // Mirror into the agreed state too, so the local diff won't echo it back.
      const synced = lastSyncedRef.current;
      if (synced) synced[index] = value;
      // …and into the board a live text placement repaints from, or moving the
      // text would quietly wipe the guest's pixel.
      const placement = textPlacementRef.current;
      if (placement) placement.baseline[index] = value;
      setPixels((current) => {
        if (current[index] === value) return current;
        const next = current.slice();
        next[index] = value;
        return next;
      });
    }
  };

  // Live mode: one screen recorder for the device, one host socket for guests.
  // The two halves are independent, and only the first one depends on the stock
  // firmware — so under ZOS the doodle wall still opens, without a recorder that
  // could only ever answer 503. pushLiveFrame no-ops on a null recorder.
  useEffect(() => {
    if (!live) return;
    const screen = zos ? null : createLiveScreen("draw", {
      onError: (error) => setStatus(`直播上屏失败：${errorMessage(error)}`),
    });
    liveScreenRef.current = screen;
    const socket = connectRoomSocket({
      room: "draw",
      role: "host",
      onMessage: (message) => applyRemoteRef.current(message),
      // A dropped socket resyncs from the next join snapshot after reconnect.
      onOpenChange: (connected) => {
        if (!connected) lastSyncedRef.current = null;
      },
    });
    liveSocketRef.current = socket;
    return () => {
      socket.dispose();
      liveSocketRef.current = null;
      if (livePushTimerRef.current !== null) {
        window.clearTimeout(livePushTimerRef.current);
        livePushTimerRef.current = null;
      }
      livePendingRef.current = false;
      lastSyncedRef.current = null;
      // dispose() wipes the live_draw app from the device.
      screen?.dispose();
      liveScreenRef.current = null;
    };
  }, [live, zos]);

  // While live: every board change refreshes the device frame (throttled) and
  // mirrors to the wall — strokes for small diffs, one snapshot for bulk edits.
  useEffect(() => {
    if (!live) return;
    // No recorder under ZOS, so no throttle window to open either — the wall
    // sync below is the whole job there.
    if (!zos) scheduleLivePush();
    const synced = lastSyncedRef.current;
    const socket = liveSocketRef.current;
    if (!synced || !socket) return;
    const changed: number[] = [];
    for (let index = 0; index < PIXEL_COUNT; index += 1) {
      if ((pixels[index] ?? 0) !== (synced[index] ?? 0)) changed.push(index);
    }
    if (changed.length === 0) return;
    if (changed.length <= DOODLE_STROKE_SYNC_LIMIT) {
      for (const index of changed) {
        const value = pixels[index] ?? 0;
        socket.send({
          type: "stroke",
          x: index % WIDTH,
          y: Math.floor(index / WIDTH),
          color: value === 0 ? null : value,
        });
      }
    } else {
      socket.send({ type: "snapshot", pixels });
    }
    lastSyncedRef.current = pixels.slice();
  }, [live, pixels, scheduleLivePush, zos]);

  const toggleLive = (checked: boolean) => {
    setLive(checked);
    setStatus(checked
      ? zos
        ? "涂鸦墙已开启：扫码邀请朋友一起画。ZOS 下画面不会实时上屏，写入频道后由时钟自己拉取。"
        : "直播已开启：画布实时上屏，扫码邀请朋友一起涂鸦。"
      : zos
        ? "涂鸦墙已关闭。"
        : "直播已关闭，设备上的涂鸦画面已清除。");
  };

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
    applySelection(null);
    setPointerRevision((current) => current + 1);
    const messages: Record<CanvasTool, string> = {
      pen: "画笔：左键绘制，右键临时擦除。",
      eraser: "橡皮：拖动清除像素。",
      select: "选择：拖出选区，再从选区内部拖动搬移。",
      text: "文字：先在右侧设置内容与字体，再点击画布落字；落完自动变成可拖动的选区。",
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
    applySelection(null);
    toast.success("已撤销");
  };

  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setHistory((current) => [...current, pixels.slice()]);
    setPixels(next);
    setFuture((current) => current.slice(0, -1));
    applySelection(null);
    toast.success("已重做");
  };

  const clear = () => {
    snapshot();
    setPixels(new Array(PIXEL_COUNT).fill(0));
    applySelection(null);
    toast.success("画布已清空", { description: "可以撤销恢复。" });
  };

  const placeText = (x: number, y: number) => {
    if (!canvasText) {
      toast.error("请先输入文字");
      return;
    }
    const background = textFill ? textFillColor : null;
    // With a backdrop switched on, a line of blanks is still a real edit (it
    // clears a plate), so ink is only required when nothing else would land.
    if (!textBlockHasInk(textBlock) && background === null) {
      toast.error("没有可显示的字符", {
        description: textFace === "shared-12"
          ? "这些字不在设备字库里，换个写法试试。"
          : `${TEXT_FACE_META[textFace].charset}；中日文请切到「${TEXT_FACE_META["shared-12"].name}」。`,
      });
      return;
    }
    if (!textFit.fits) {
      toast.error("这一行放不下", {
        description: `${textBlock.cells} 个字要占 ${textFit.width}px，面板只有 ${WIDTH}px；最多放 ${textFit.capacity} 个字。`,
      });
      return;
    }
    const placed = beginTextPlacement(pixelsRef.current, textBlock, x, y, {
      color,
      background,
      panelWidth: WIDTH,
      panelHeight: HEIGHT,
    });
    const origin = placed.placement;
    snapshot();
    setPixels(placed.pixels);
    // Same hand-off as the image tool: the placed block stays selected and the
    // select tool is already live, so the position can be corrected by dragging
    // instead of by re-framing a marquee around text that is already down. The
    // selection is the glyph bounding box, never the filled field — a selection
    // the size of the panel has nowhere to be dragged to.
    setTool("select");
    applySelection(textPlacementRect(placed.placement), placed.placement);
    const nudged = origin.x !== x || origin.y !== y ? "（已内移以放下整块）" : "";
    const gaps = textBlock.missing.length > 0
      ? `；${textBlock.missing.join(" ")} 不在字库中，已留空`
      : "";
    setStatus(`已在 (${origin.x}, ${origin.y}) 落下“${canvasText}”${nudged}${gaps}；拖动绿色选区可再调位置，要继续落字请点「在画布上落字」。`);
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
      applySelection(null);
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
    applySelection({ x: 0, y: 0, width: block.width, height: block.height });
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

    if (action.kind === "text-move") {
      // The board was repainted on every move, so there is nothing to commit —
      // and the placement stays live, so the position can be nudged again.
      const placement = textPlacementRef.current;
      if (action.moved && placement) {
        setStatus(`文字已移到 (${placement.x}, ${placement.y})；还可以继续拖动微调。`);
      }
    } else if (action.kind === "move") {
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
      applySelection({ x: originX, y: originY, width: action.width, height: action.height });
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
      applySelection(nextSelection);
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
        // Freshly placed text is not a rectangle of board pixels — it repaints
        // from what was underneath instead of being cut out and stamped down.
        // That is the only way black glyphs survive a drag over a light fill,
        // and the only way a caption can be nudged without tearing the drawing
        // it was laid over. See TextPlacement.
        const placement = textPlacementRef.current;
        if (placement) {
          pointerActionRef.current = {
            kind: "text-move",
            grabX: x - placement.x,
            grabY: y - placement.y,
            moved: false,
          };
          setPointerRevision((current) => current + 1);
          return;
        }
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
        applySelection(null);
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
    if (action.kind === "text-move") {
      const placement = textPlacementRef.current;
      if (!placement) return;
      const moved = moveTextPlacement(placement, x - action.grabX, y - action.grabY);
      // Clamping and the 16px cell size mean most pointer moves land on the same
      // origin; repainting then would only churn the board and, in live mode,
      // the wall socket.
      if (moved.placement.x === placement.x && moved.placement.y === placement.y) return;
      // Snapshot on the first real move, so one drag is one undo step.
      if (!action.moved) {
        action.moved = true;
        snapshot();
      }
      applySelection(textPlacementRect(moved.placement), moved.placement);
      setPixels(moved.pixels);
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

  // Same pixels, different destination: a new channel of its own rather than
  // the selected one. Kept separate from writeToChannel because "add to what I
  // am editing" and "make a new thing" are different intentions and a modifier
  // on one button would hide that.
  const writeAsChannel = () => {
    onApplyAsChannel?.(pixels);
  };

  return (
    <>
      <main className="canvas-workspace">
        <div className="canvas-toolbar">
          <div className="preview-copy">
            <h2>画布编辑</h2>
            {/* The route to the panel is a standing fact about this page, so it
                lives here rather than in the status line, which any tool change
                overwrites a second later. */}
            <span>
              所选频道：{targetChannelName} · 52×16
              {zos ? " · 写入后由时钟自己拉取" : null}
            </span>
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
            firmwareMode={firmwareMode}
            channelAppName={targetChannelAppName}
            channelEnabled={targetChannelEnabled}
            onFlushEdits={onFlushEdits}
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
          <SwatchPicker
            label="颜色"
            value={color}
            active={tool === "pen"}
            onSelect={(value) => { setColor(value); activateTool("pen"); }}
          />
        </section>

        <section className="canvas-command-bar">
          <label className="grid-toggle">
            <Switch as="span" input checked={showGrid} onChange={setShowGrid} />
            显示网格
          </label>
          <label className="grid-toggle">
            <Switch as="span" input checked={live} onChange={toggleLive} />
            {zos ? "涂鸦墙" : "直播上屏"}
          </label>
          {live && (
            <Button type="button" size="sm" variant="transparent" onClick={() => setLiveInviteOpen(true)}>
              <QrCode />邀请涂鸦
            </Button>
          )}
          <div className="canvas-history-actions">
            <Button type="button" variant="transparent" outline={false} size="sm" square disabled={history.length === 0} onClick={undo} aria-label="撤销" title="撤销"><RotateCcw /></Button>
            <Button type="button" variant="transparent" outline={false} size="sm" square disabled={future.length === 0} onClick={redo} aria-label="重做" title="重做"><Redo2 /></Button>
            <Button type="button" color="red" variant="transparent" outline={false} size="sm" square onClick={clear} aria-label="清空画布" title="清空画布"><Trash2 /></Button>
          </div>
          <Button type="button" size="sm" onClick={writeAsChannel}><FilePlus2 />写入为单独 APP</Button>
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
              <div><h3>像素文字</h3><p>点击画布落字，落完直接拖动微调。</p></div>
            </div>
            <label className="canvas-field" htmlFor="canvas-text">
              <span>文字内容</span>
              <Input inputId="canvas-text" value={canvasText} maxLength={40} onChange={setCanvasText} />
            </label>
            <label className="canvas-field" htmlFor="canvas-text-face">
              <span>字体</span>
              <Select
                id="canvas-text-face"
                aria-label="像素文字字体"
                value={textFace}
                options={[...TEXT_FACES]}
                renderOption={({ value }) => TEXT_FACE_META[value].name}
                renderOptionInfo={({ value }) => TEXT_FACE_META[value].note}
                onChange={(value) => setTextFace(value)}
              >
                {TEXT_FACE_META[textFace].name}
              </Select>
            </label>
            {/* The budget has to be readable before the click, not discovered by
                a rejected one — so width, count and gaps all live next to the
                button rather than inside a toast. */}
            <div className="flex flex-wrap items-center gap-1">
              <Chip size="sm" variant="transparent" color={textFit.fits ? "neutral" : "red"}>
                {textFit.width} / {WIDTH} px
              </Chip>
              <Chip size="sm" variant="transparent" color="neutral">
                {textBlock.cells} 字 · 高 {textBlock.height}px
              </Chip>
              {!textFit.fits && (
                <Chip size="sm" variant="transparent" color="red">
                  超出 {textFit.overflow}px，最多 {textFit.capacity} 字
                </Chip>
              )}
            </div>
            <p className="m-0 text-[0.6rem] leading-[1.5] text-cladd-fg-softer">
              {textFace === "shared-12"
                ? `与固件同一套字模，一行最多 ${faceBudget} 个全角字（半角字母与标点各占 6px，还能多挤几个）；放不下会拒绝落字并提示能放几个字。`
                : `${TEXT_FACE_META[textFace].charset}，一行大约 ${faceBudget} 个字符；中日文请切到「${TEXT_FACE_META["shared-12"].name}」。`}
            </p>
            {textBlock.missing.length > 0 && (
              <p className="cladd-color-yellow m-0 text-[0.6rem] leading-[1.5] text-cladd-primary">
                字库里没有这些字，落字时会留空：{textBlock.missing.join(" ")}
              </p>
            )}
            <label className="canvas-switch-row">
              <span><strong>背景填色</strong><small>整屏铺满底色，只留笔画是文字颜色</small></span>
              <Switch as="span" input checked={textFill} onChange={setTextFill} />
            </label>
            {textFill && (
              <SwatchPicker label="整屏底色" value={textFillColor} onSelect={setTextFillColor} />
            )}
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

      <InviteQrDialog
        open={liveInviteOpen}
        onOpenChange={setLiveInviteOpen}
        title="邀请朋友来涂鸦"
        description={zos
          ? "手机连到同一 Wi-Fi，扫码打开涂鸦墙访客页，笔画会实时出现在这块画板上；ZOS 下不会同时投到时钟屏幕。"
          : "手机连到同一 Wi-Fi，扫码打开涂鸦墙访客页，笔画会实时出现在画板和时钟屏幕上。"}
        path="draw"
      />
    </>
  );
}
