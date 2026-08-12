import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Bird,
  Blocks,
  Car,
  ChevronRight,
  Gamepad2,
  Grid2x2,
  HardDrive,
  MonitorCog,
  Pause,
  PinOff,
  Play,
  QrCode,
  Radio,
  Rocket,
  RotateCcw,
  Swords,
  TriangleAlert,
  TvMinimal,
  WifiOff,
  Worm,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  Chip,
  Surface,
  Switch,
  ToggleButton,
  ToggleGroup,
} from "@cladd-ui/react";
import { jsonApi } from "@/lib/api";
import {
  GAME_SCREEN_HEIGHT,
  GAME_SCREEN_WIDTH,
  emptyInput,
  type GameEngine,
  type GameHud,
  type GameInput,
} from "@/lib/games/engine";
import {
  BREAKOUT_PADDLE_WIDTHS,
  BreakoutEngine,
  type BreakoutPaddleWidth,
} from "@/lib/games/breakout";
import { createFlappyGame } from "@/lib/games/flappy";
import { createSnakeGame } from "@/lib/games/snake";
import { createPongGame } from "@/lib/games/pong";
import { createRacerGame } from "@/lib/games/racer";
import { createShooterGame } from "@/lib/games/shooter";
import { createTetrisGame } from "@/lib/games/tetris";
import { connectRoomSocket, type RoomSocket } from "@/lib/game-socket";
import { createLiveScreen, type LiveScreen } from "@/lib/live-screen";
import { useZosFocus } from "@/lib/use-zos-focus";
import { zosGameFocus } from "@/lib/zos-link";
import { FirmwarePanel, useFirmwarePanel } from "@/components/firmware-panel";
import { InviteQrDialog } from "@/components/game/invite-qr-dialog";
import { errorMessage } from "@/lib/utils";
import type { FirmwareMode } from "@/lib/firmware-mode";
import type { ArcadeStatus, FirmwareKind } from "@/types";

// How long the engine-rendered settlement screen keeps streaming to the device
// before the shell wipes it (same v1 semantics, now driven by hud().phase).
const GAME_OVER_STREAM_MS = 3_000;

interface GameRegistryEntry {
  id: GameEngine["meta"]["id"];
  /** Duplicate of engine.meta.title so the picker renders without an instance. */
  title: string;
  icon: LucideIcon;
  create: () => GameEngine;
}

// The arcade's catalogue: one row per engine, shell stays generic.
const GAME_REGISTRY: GameRegistryEntry[] = [
  { id: "breakout", title: "时间打砖块", icon: Blocks, create: () => new BreakoutEngine() },
  { id: "flappy", title: "像素小鸟", icon: Bird, create: () => createFlappyGame() },
  { id: "snake", title: "贪吃蛇", icon: Worm, create: () => createSnakeGame() },
  { id: "pong", title: "双人 Pong", icon: Swords, create: () => createPongGame() },
  // The last three were written for the firmware's knob first and ported back
  // here, so the console now carries the same seven games the device does. Their
  // simulations are asserted byte-identical against the C++ (test/racer.test.ts,
  // shooter.test.ts, tetris.test.ts) — which is what makes driving both from one
  // input stream possible later.
  //
  // Each is left on its engine's default seed on purpose: a fixed seed is what
  // lets a console session and a device session be lined up. A lockstep driver
  // must pass the SAME seed to both sides; the device seeds from time(0), so it
  // is the device that has to be told, not this side.
  { id: "racer", title: "像素赛车", icon: Car, create: () => createRacerGame() },
  { id: "shooter", title: "太空射击", icon: Rocket, create: () => createShooterGame() },
  { id: "tetris", title: "俄罗斯方块", icon: Grid2x2, create: () => createTetrisGame() },
];

// Pads join with a human-typeable 4-character room code; look-alike glyphs are
// skipped and "draw" stays reserved for the doodle wall.
const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function createRoomCode(): string {
  let code = "";
  do {
    code = Array.from(
      { length: 4 },
      () => ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]!,
    ).join("");
  } while (code === "draw");
  return code;
}

// v1 stored the breakout high score under a dedicated key; keep honouring it so
// nobody's record disappears in the redesign.
function highScoreKey(id: string): string {
  return id === "breakout" ? "pixel-market.breakout-high-score" : `pixel-market.game-high.${id}`;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing — the session still works, records just don't persist.
  }
}

const DIRECTION_KEYS: Record<string, NonNullable<GameInput["direction"]>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  KeyA: "left",
  KeyD: "right",
  KeyW: "up",
  KeyS: "down",
};

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.closest("input, textarea, select, [contenteditable]") !== null;
}

interface GameShellProps {
  // 任一侧载固件（音乐或游戏）直连中：官方固件的上屏通道此时不存在。
  firmwareOnline: boolean;
  firmwareKind?: FirmwareKind | null;
  // 时钟当前跑的固件。ZOS 与两套侧载固件互斥，所以 zos 时 firmwareOnline 必为
  // false——但上屏同样不可能：ZOS 没有官方的 Custom App 接收端。
  firmwareMode?: FirmwareMode;
  // 游戏页挂载期间轮询 /api/arcade/status，把在线状态上报给工作台归一。
  onArcadeOnlineChange?: (online: boolean) => void;
}

const ARCADE_STATUS_POLL_MS = 10_000;

export function GameShell({
  firmwareOnline,
  firmwareKind = null,
  firmwareMode = "official",
  onArcadeOnlineChange,
}: GameShellProps) {
  const zos = firmwareMode === "zos";
  // 上屏走 /api/live/frames → 官方 Custom App。两种情况下这条路都不存在：
  // 侧载固件顶掉了官方 app，ZOS 则整套换掉了固件（真机实测 503）。
  const liveBlocked = zos || firmwareOnline;
  // ZOS 上时钟自己跑着同样七款游戏，固件认 focus:"game:<engineId>"。这不是把这
  // 局投过去——两边各自开局（设备用 time(0) 播种），只是把设备叫到同一款游戏。
  const zosFocus = useZosFocus(zos);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  if (!engineRef.current) engineRef.current = GAME_REGISTRY[0]!.create();
  const inputRef = useRef<GameInput>(emptyInput());
  const heldDirectionsRef = useRef<NonNullable<GameInput["direction"]>[]>([]);
  const pausedRef = useRef(false);
  // 上屏默认关闭:进游戏页先在浏览器里玩,想投到时钟再手动打开。
  const screenOnRef = useRef(false);
  const liveBlockedRef = useRef(liveBlocked);
  liveBlockedRef.current = liveBlocked;
  const gameOverAtRef = useRef<number | null>(null);
  const gameOverClearedRef = useRef(false);
  const highScoreRef = useRef(0);
  // Seed the HUD from the engine so the first (and server) render is honest.
  const lastHudRef = useRef<GameHud>(engineRef.current.hud());
  const liveScreenRef = useRef<LiveScreen | null>(null);
  // The pad room code lives as long as the shell so the QR keeps working
  // across game switches and dialog reopenings.
  const padRoomRef = useRef<string | null>(null);
  if (!padRoomRef.current) padRoomRef.current = createRoomCode();
  const padSocketRef = useRef<RoomSocket | null>(null);

  const [gameId, setGameId] = useState<GameRegistryEntry["id"]>(GAME_REGISTRY[0]!.id);
  const [hud, setHud] = useState<GameHud>(() => lastHudRef.current);
  const [paused, setPaused] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [highScore, setHighScore] = useState(0);
  const [pushError, setPushError] = useState<string | null>(null);
  const [paddleWidth, setPaddleWidth] = useState<BreakoutPaddleWidth>(8);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [padOnline, setPadOnline] = useState(false);
  const [arcadeStatus, setArcadeStatus] = useState<ArcadeStatus | null>(null);
  // 游戏固件的侧载面板：与音乐页共用同一套组件与流程，仅前缀/口令/文案不同。
  const firmwarePanel = useFirmwarePanel({
    apiPrefix: "/api/arcade",
    confirmation: "START_TC002_ARCADE_SESSION",
    firmwareLabel: "游戏固件",
    firmwareMode,
  });

  pausedRef.current = paused;
  screenOnRef.current = screenOn;

  const engineMeta = engineRef.current.meta;
  const twoPlayers = Boolean(engineMeta.twoPlayers);

  const ensureLiveScreen = useCallback((): LiveScreen => {
    if (liveScreenRef.current) return liveScreenRef.current;
    liveScreenRef.current = createLiveScreen("game", {
      onError: (error) => setPushError(errorMessage(error)),
      onPushed: () => setPushError(null),
    });
    return liveScreenRef.current;
  }, []);

  const clearLive = useCallback(() => {
    liveScreenRef.current?.clear();
  }, []);

  useEffect(() => {
    const stored = Number(readStorage(highScoreKey(gameId)) ?? 0);
    const value = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
    highScoreRef.current = value;
    setHighScore(value);
  }, [gameId]);

  // Keyboard: space = action button, arrows/WASD = held direction. Events from
  // form fields must never steer the game.
  useEffect(() => {
    const resolveDirection = () => {
      inputRef.current.direction = heldDirectionsRef.current.at(-1) ?? null;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        inputRef.current.pressed = true;
        if (!event.repeat) inputRef.current.pressedEdge = true;
        return;
      }
      const direction = DIRECTION_KEYS[event.code];
      if (!direction) return;
      event.preventDefault();
      const held = heldDirectionsRef.current;
      if (!held.includes(direction)) held.push(direction);
      resolveDirection();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        inputRef.current.pressed = false;
        return;
      }
      const direction = DIRECTION_KEYS[event.code];
      if (!direction) return;
      heldDirectionsRef.current = heldDirectionsRef.current.filter((item) => item !== direction);
      resolveDirection();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      pausedRef.current = true;
      setPaused(true);
      clearLive();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [clearLive]);

  useEffect(() => {
    if (liveBlocked) clearLive();
  }, [clearLive, liveBlocked]);

  // 游戏固件在线检测（调研方案 A）：挂载期间 10 秒一轮询，纯内存读零成本；
  // 卸载时上报离线，避免锁死其他视图。
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await jsonApi<ArcadeStatus>("/api/arcade/status");
        if (cancelled) return;
        setArcadeStatus(status);
        onArcadeOnlineChange?.(status.online);
      } catch {
        if (cancelled) return;
        setArcadeStatus(null);
        onArcadeOnlineChange?.(false);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), ARCADE_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      onArcadeOnlineChange?.(false);
    };
  }, [onArcadeOnlineChange]);

  // Host side of the WS gamepad (two-player games only): pad {type:"input"}
  // messages steer the second paddle through GameInput.p2PointerY, and the
  // relay's {type:"peers"} notifications keep the invite dialog honest. While
  // the socket lives the last pad position is held; on disconnect the engine
  // sees null and its AI takes the paddle back.
  useEffect(() => {
    if (!twoPlayers) return;
    const socket = connectRoomSocket({
      room: padRoomRef.current!,
      role: "host",
      onMessage: (message) => {
        if (message.type === "input" && typeof message.y === "number" && Number.isFinite(message.y)) {
          inputRef.current.p2PointerY = Math.min(1, Math.max(0, message.y)) * GAME_SCREEN_HEIGHT;
        } else if (message.type === "peers") {
          setPadOnline(typeof message.pads === "number" && message.pads > 0);
        }
      },
      onOpenChange: (connected) => {
        if (connected) return;
        setPadOnline(false);
        inputRef.current.p2PointerY = null;
      },
    });
    padSocketRef.current = socket;
    return () => {
      socket.dispose();
      padSocketRef.current = null;
      setPadOnline(false);
      inputRef.current.p2PointerY = null;
    };
  }, [twoPlayers]);

  // Main loop: tick → render → HUD bridge → 25ms live capture (batched).
  useEffect(() => {
    const context = canvasRef.current?.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    const liveScreen = ensureLiveScreen();
    let animationFrame = 0;
    let previousAt = performance.now();

    const syncHud = (next: GameHud) => {
      const previous = lastHudRef.current;
      if (
        next.score !== previous.score
        || next.lives !== previous.lives
        || next.level !== previous.level
        || next.phase !== previous.phase
        || next.message !== previous.message
      ) {
        lastHudRef.current = next;
        setHud(next);
        // Optional state echo back to the pads (§6) so the phone shows phase.
        padSocketRef.current?.send({ type: "state", phase: next.phase, score: next.score });
      }
      if (next.score > highScoreRef.current) {
        highScoreRef.current = next.score;
        setHighScore(next.score);
        writeStorage(highScoreKey(engineRef.current!.meta.id), String(next.score));
      }
    };

    const frame = (now: number) => {
      const engine = engineRef.current!;
      const dtMs = now - previousAt;
      previousAt = now;
      const input = inputRef.current;
      if (!pausedRef.current) {
        engine.tick(dtMs, input);
        // The press edge is a one-tick signal; holding a key must not retrigger.
        input.pressedEdge = false;
      }
      engine.render(context);
      const nextHud = engine.hud();
      syncHud(nextHud);

      if (nextHud.phase === "game-over") {
        if (gameOverAtRef.current === null) {
          gameOverAtRef.current = now;
        } else if (
          now - gameOverAtRef.current >= GAME_OVER_STREAM_MS
          && !gameOverClearedRef.current
        ) {
          gameOverClearedRef.current = true;
          clearLive();
        }
      } else if (gameOverAtRef.current !== null) {
        gameOverAtRef.current = null;
        gameOverClearedRef.current = false;
      }

      const canPush = screenOnRef.current
        && !pausedRef.current
        && !liveBlockedRef.current
        && !gameOverClearedRef.current;
      if (canPush) liveScreen.capture(context, now);
      animationFrame = window.requestAnimationFrame(frame);
    };

    animationFrame = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      liveScreen.dispose();
      liveScreenRef.current = null;
    };
  }, [clearLive, ensureLiveScreen]);

  const pointToGameX = (event: ReactPointerEvent<HTMLCanvasElement>): number => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.min(
      GAME_SCREEN_WIDTH,
      Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width) * GAME_SCREEN_WIDTH),
    );
  };

  const pointToGameY = (event: ReactPointerEvent<HTMLCanvasElement>): number => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.min(
      GAME_SCREEN_HEIGHT,
      Math.max(0, (event.clientY - bounds.top) / Math.max(1, bounds.height) * GAME_SCREEN_HEIGHT),
    );
  };

  const beginPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    inputRef.current.pointerX = pointToGameX(event);
    inputRef.current.pointerY = pointToGameY(event);
    inputRef.current.pressed = true;
    inputRef.current.pressedEdge = true;
  };

  const movePointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "mouse" || event.currentTarget.hasPointerCapture(event.pointerId)) {
      inputRef.current.pointerX = pointToGameX(event);
      inputRef.current.pointerY = pointToGameY(event);
    }
  };

  const endPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    inputRef.current.pressed = false;
    // Hand control back to the keyboard once the finger lifts.
    if (event.pointerType !== "mouse") {
      inputRef.current.pointerX = null;
      inputRef.current.pointerY = null;
    }
  };

  const switchGame = (id: GameRegistryEntry["id"]) => {
    const entry = GAME_REGISTRY.find((candidate) => candidate.id === id);
    if (!entry || id === gameId) return;
    clearLive();
    const engine = entry.create();
    if (engine instanceof BreakoutEngine) engine.setPaddleWidth(paddleWidth);
    engineRef.current = engine;
    inputRef.current = emptyInput();
    heldDirectionsRef.current = [];
    gameOverAtRef.current = null;
    gameOverClearedRef.current = false;
    const freshHud = engine.hud();
    lastHudRef.current = freshHud;
    setHud(freshHud);
    setPaused(false);
    pausedRef.current = false;
    setGameId(id);
  };

  const pressStart = () => {
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
    }
    inputRef.current.pressedEdge = true;
  };

  const togglePaused = () => {
    if (hud.phase !== "playing") {
      pressStart();
      return;
    }
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) clearLive();
  };

  const restart = () => {
    engineRef.current!.restart();
    gameOverAtRef.current = null;
    gameOverClearedRef.current = false;
    pausedRef.current = false;
    setPaused(false);
  };

  const toggleScreen = (checked: boolean) => {
    if (liveBlocked) return;
    screenOnRef.current = checked;
    setScreenOn(checked);
    if (!checked) clearLive();
  };

  const choosePaddleWidth = (width: BreakoutPaddleWidth) => {
    setPaddleWidth(width);
    const engine = engineRef.current;
    if (engine instanceof BreakoutEngine) engine.setPaddleWidth(width);
  };

  const liveChip = zos
    ? { color: "neutral" as const, icon: MonitorCog, label: "ZOS 运行中" }
    : firmwareOnline
    ? { color: "neutral" as const, icon: WifiOff, label: "固件直连" }
    : pushError
      ? { color: "red" as const, icon: TriangleAlert, label: "上屏异常" }
      : !screenOn
        ? { color: "neutral" as const, icon: TvMinimal, label: "未上屏" }
        : paused
          ? { color: "neutral" as const, icon: Pause, label: "已暂停" }
          : { color: "brand" as const, icon: Radio, label: "直播中" };

  // The picker's id IS the device engine's id() — that shared vocabulary is what
  // lets a console-side pick name a device-side game (see zosGameFocus).
  const zosGameTarget = zosGameFocus(gameId);
  const zosGamePinned = zosFocus.pinnedOn(zosGameTarget);

  const startLabel = hud.phase === "ready"
    ? "开始"
    : hud.phase === "game-over"
      ? "再来一局"
      : paused
        ? "继续"
        : "暂停";

  return (
    <main className="game-shell">
      <div className="game-topbar">
        <ToggleGroup
          className="game-picker"
          value={gameId}
          size="md"
          variant="transparent"
          outline
          activeVariant="gradient"
          activeOutline
          role="group"
          aria-label="选择游戏"
          onValueChange={(next) => {
            if (typeof next === "string") switchGame(next as GameRegistryEntry["id"]);
          }}
        >
          {GAME_REGISTRY.map((entry) => {
            const Icon = entry.icon;
            return (
              <ToggleButton key={entry.id} value={entry.id} activeColor="lime">
                <Icon aria-hidden="true" />
                {entry.title}
              </ToggleButton>
            );
          })}
        </ToggleGroup>
        <div className="game-topbar__status">
          <Chip
            size="sm"
            color={liveChip.color}
            variant="transparent"
            icon={liveChip.icon}
            iconProps={{ "aria-hidden": true }}
            aria-live="polite"
          >
            {liveChip.label}
          </Chip>
          <label className="game-screen-toggle">
            <span>上屏</span>
            <Switch
              as="span"
              input
              checked={screenOn && !liveBlocked}
              disabled={liveBlocked}
              onChange={toggleScreen}
            />
          </label>
          <Button
            type="button"
            className="music-device-trigger game-firmware-trigger"
            contentClassName="music-device-trigger__content"
            size="sm"
            color="neutral"
            variant="transparent"
            outline
            tightFocusRing
            aria-haspopup="dialog"
            aria-label={`侧载游戏固件，${firmwarePanel.statusLabel}`}
            onClick={firmwarePanel.openPanel}
          >
            <HardDrive aria-hidden="true" />
            <span>游戏固件</span>
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="game-body">
        <section className="game-stage" aria-label={engineMeta.title}>
          <figure className="game-screen">
            <div className="game-screen__frame">
              <canvas
                ref={canvasRef}
                width={GAME_SCREEN_WIDTH}
                height={GAME_SCREEN_HEIGHT}
                tabIndex={0}
                role="img"
                aria-label={`52 × 16 ${engineMeta.title}；${engineMeta.hint}`}
                onPointerDown={beginPointer}
                onPointerMove={movePointer}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
                onPointerLeave={() => {
                  inputRef.current.pointerX = null;
                  inputRef.current.pointerY = null;
                }}
              />
            </div>
            <figcaption>
              <span>{engineMeta.hint}</span>
              {hud.message && <span className="game-screen__status">{hud.message}</span>}
            </figcaption>
          </figure>

          <div className="game-hud" aria-live="polite">
            <span><small>分数</small><strong>{hud.score}</strong></span>
            <span>
              <small>生命</small>
              <strong>{hud.lives === undefined ? "—" : "♥".repeat(hud.lives) || "0"}</strong>
            </span>
            <span><small>关卡</small><strong>{hud.level ?? "—"}</strong></span>
            <span><small>最高分</small><strong>{highScore}</strong></span>
          </div>

          <Surface className="game-console" variant="solid" outline contentClassName="game-console__row">
            <Button
              type="button"
              size="md"
              color="brand"
              variant={hud.phase === "playing" && !paused ? "transparent" : "gradient"}
              onClick={togglePaused}
            >
              {hud.phase === "playing" && !paused
                ? <Pause aria-hidden="true" />
                : <Play aria-hidden="true" />}
              {startLabel}
            </Button>
            <Button type="button" size="md" variant="transparent" onClick={restart}>
              <RotateCcw aria-hidden="true" />重开
            </Button>
            {zos && (
              // 「开始」已经占了这一排唯一的 brand 重音，所以这颗按钮走 transparent
              // + outline，只在真的接管了旋钮时才亮成 brand——与音乐页那颗同一写法。
              <Button
                type="button"
                size="md"
                color={zosGamePinned ? "brand" : undefined}
                variant="transparent"
                outline
                disabled={zosFocus.busy}
                aria-busy={zosFocus.busy}
                aria-pressed={zosGamePinned}
                title={zosGamePinned
                  ? "交还旋钮，时钟恢复自己切台"
                  : `把时钟切到它自带的「${engineMeta.title}」并锁住旋钮；两边各自开局，进度不共享`}
                onClick={() => zosFocus.toggle(zosGameTarget)}
              >
                {zosGamePinned
                  ? <PinOff aria-hidden="true" />
                  : <MonitorCog aria-hidden="true" />}
                {zosGamePinned ? "交还旋钮" : "在时钟上玩"}
              </Button>
            )}
            {twoPlayers && (
              <Button type="button" size="md" variant="transparent" onClick={() => setInviteOpen(true)}>
                <QrCode aria-hidden="true" />邀请手柄
              </Button>
            )}
            {gameId === "breakout" && (
              <div className="game-console__options" aria-label="挡板宽度">
                <span>难度</span>
                <ToggleGroup
                  value={String(paddleWidth)}
                  size="md"
                  variant="transparent"
                  outline={false}
                  activeVariant="gradient"
                  role="group"
                  aria-label="挡板宽度"
                  onValueChange={(next) => {
                    const width = Number(next) as BreakoutPaddleWidth;
                    if (BREAKOUT_PADDLE_WIDTHS.includes(width)) choosePaddleWidth(width);
                  }}
                >
                  {BREAKOUT_PADDLE_WIDTHS.map((width) => (
                    <ToggleButton key={width} value={String(width)} activeColor="brand">
                      {width === 6 ? "难" : width === 8 ? "标准" : "轻松"}
                    </ToggleButton>
                  ))}
                </ToggleGroup>
              </div>
            )}
          </Surface>

          {zos ? (
            // ZOS 上七款游戏是设备自己在跑（与这里同一套引擎），所以这不是"功能
            // 没了"，是入口换了地方——而 focus:"game:<id>" 之后控制台有钥匙了。
            // 措辞刻意不提"同步"：设备用 time(0) 播种，两边跑出来必然不一样。
            <p className="game-note game-note--warning" role="status">
              <MonitorCog aria-hidden="true" />
              时钟正在运行 ZOS，官方固件的上屏通道已经不存在，这局只在浏览器里跑。
              时钟自带同样七款游戏：点「在时钟上玩」把它切到当前这款，用旋钮和按键在设备上开一局；
              两边各自开局，进度和随机数都不共享。
            </p>
          ) : firmwareOnline && (
            <p className="game-note game-note--warning" role="status">
              <WifiOff aria-hidden="true" />
              {firmwareKind === "arcade"
                ? "游戏固件直连中，正在时钟上原生运行；恢复官方固件后才能上屏。"
                : "音乐固件直连中，恢复官方固件后才能上屏。"}
            </p>
          )}
          {paused && (
            <p className="game-note" role="status">
              {liveBlocked ? "游戏已暂停。" : "游戏已暂停，设备画面已清除。"}
            </p>
          )}
          {hud.phase === "game-over" && (
            <p className="game-note" role="status">
              <Gamepad2 aria-hidden="true" />
              {liveBlocked ? "游戏结束。" : "游戏结束，结算画面几秒后自动从设备清除。"}
            </p>
          )}
          {pushError && (
            <p className="game-note game-note--error" role="alert">上屏失败：{pushError}</p>
          )}
          {zosFocus.error && (
            <p className="game-note game-note--error" role="alert">切换时钟界面失败：{zosFocus.error}</p>
          )}
        </section>
      </div>

      <FirmwarePanel
        controller={firmwarePanel}
        heading="侧载游戏固件"
        description={zos
          ? "把游戏固件推进时钟内存临时运行，用旋钮和按键玩七款像素小游戏；它与 ZOS 互斥，侧载期间 ZOS 会被顶下去。"
          : "把游戏固件推进时钟内存临时运行，用旋钮和按键玩七款像素小游戏；官方固件原封不动，断电重启即自动恢复。"}
        dialogClassName="arcade-firmware-dialog"
      >
        {zos && (
          // 恢复承诺本身已经交给面板正文按 restoresTo 说（ZOS 刷在 mtd3 res 上，
          // 断电重启回到的是 ZOS）。这里只留侧载期间会中断什么——那是正文没有的。
          <Surface
            color="orange"
            variant="solid"
            outline
            className="rounded-lg"
            contentClassName="flex flex-col gap-1 px-3 py-2 text-xs leading-relaxed text-cladd-fg-soft"
          >
            <strong className="text-cladd-fg">时钟当前运行 ZOS，两套固件不能同时跑。</strong>
            <span>
              侧载会把 ZOS 顶下去，控制台的频道拉取、画面镜像与固定旋钮在这期间都会中断；
              结束侧载或断电重启后回到的是 ZOS，不是 Ulanzi 官方固件。
            </span>
          </Surface>
        )}
        {arcadeStatus?.online && (
          <dl className="fw-device-facts" aria-label="游戏固件实时状态">
            <div><dt>当前游戏</dt><dd>{arcadeStatus.game || "—"}</dd></div>
            <div><dt>阶段</dt><dd>{arcadeStatus.phase || "—"}</dd></div>
            <div><dt>分数</dt><dd>{arcadeStatus.score}</dd></div>
            <div>
              <dt>心跳</dt>
              <dd>{arcadeStatus.ageMs >= 0 ? `${Math.max(0, Math.round(arcadeStatus.ageMs / 1000))} 秒前` : "等待中"}</dd>
            </div>
          </dl>
        )}
      </FirmwarePanel>

      <InviteQrDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="邀请手机手柄"
        description="手机连到同一 Wi-Fi，扫码打开手柄页，上下拖动即可控制右侧挡板。"
        path={`pad?room=${padRoomRef.current}`}
        hint={(
          <Chip
            size="sm"
            color={padOnline ? "brand" : "neutral"}
            variant="transparent"
            icon={Gamepad2}
            iconProps={{ "aria-hidden": true }}
            aria-live="polite"
          >
            {padOnline ? "手柄已连接" : "等待手柄接入…"}
          </Chip>
        )}
      />
    </main>
  );
}
