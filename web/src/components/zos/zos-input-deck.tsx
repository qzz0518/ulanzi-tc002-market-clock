import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { RotateCcw, RotateCw, Volume1, Volume2 } from "lucide-react";
import { Button, Shortcut, Surface } from "@cladd-ui/react";
import {
  ZOS_HOLD_MS,
  ZOS_INPUT_LABELS,
  ZOS_KNOB_DETENT_DEG,
  ZOS_WHEEL_DETENT_PX,
  accumulateDetents,
  angleDeltaDeg,
  createPressTracker,
  pointerAngleDeg,
  zosInputForKey,
  zosKeyCaptured,
  type ZosInputAction,
  type ZosInputEvent,
} from "@/lib/zos-link";

interface ZosInputDeckProps {
  /**
   * Remote injection only reaches a firmware that is polling. Offline the deck
   * goes inert instead of queueing: the service would hold the events and the
   * device would replay them on reconnect — a knob turn from ten minutes ago is
   * a press the user has long given up on.
   */
  live: boolean;
  /** Sends one event; resolves null when the service refused it (caller toasts). */
  onSend: (action: ZosInputAction) => Promise<ZosInputEvent | null>;
}

interface Receipt {
  seq: number;
  action: ZosInputAction;
}

/** Cap on detents emitted from a single pointer-move / wheel burst. The service
 * only keeps a tail of 8 events, so a violent flick past this cap would only
 * queue presses the firmware will discard anyway. */
const MAX_STEPS_PER_GESTURE = 3;

/** How long the core shows "返回" after a hold fires before returning to idle. */
const HOLD_FLASH_MS = 450;

/**
 * The device's own control surface, reproduced: two side buttons flanking a
 * rotary knob whose center is the press/hold button. The knob really rotates —
 * drag it, scroll it, tap its halves, or use ← / → — and the center button
 * carries the firmware's exact press-vs-hold split, including the 600 ms
 * threshold and hold-fires-at-the-threshold timing from osLogic.cc. Someone
 * who learns this deck has learned the physical clock, and vice versa.
 */
export function ZosInputDeck({ live, onSend }: ZosInputDeckProps) {
  const [dialDeg, setDialDeg] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0);
  const [coreHeld, setCoreHeld] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const dialRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    centerX: number;
    centerY: number;
    lastAngle: number;
    sendCarry: number;
    travelDeg: number;
  } | null>(null);
  const wheelCarryRef = useRef(0);
  const trackerRef = useRef(createPressTracker());
  const rafRef = useRef<number | null>(null);
  const holdFlashRef = useRef<number | null>(null);

  const dispatch = useCallback(async (action: ZosInputAction): Promise<ZosInputEvent | null> => {
    const event = await onSend(action);
    if (event) setReceipt({ seq: event.seq, action: event.action });
    return event;
  }, [onSend]);

  // Discrete inputs (tap, wheel, keyboard, AT buttons) animate the dial one
  // detent per accepted event — the service's answer turns the knob, so the
  // visual is a receipt rather than a hope. Drag is the exception: the dial
  // follows the finger there, which is what direct manipulation means.
  const dispatchTurn = useCallback(async (action: "cw" | "ccw") => {
    const event = await dispatch(action);
    if (event) setDialDeg((deg) => deg + (action === "cw" ? ZOS_KNOB_DETENT_DEG : -ZOS_KNOB_DETENT_DEG));
  }, [dispatch]);

  const emitSteps = useCallback((steps: number) => {
    const capped = Math.max(-MAX_STEPS_PER_GESTURE, Math.min(MAX_STEPS_PER_GESTURE, steps));
    for (let index = 0; index < Math.abs(capped); index += 1) {
      void dispatch(capped > 0 ? "cw" : "ccw");
    }
  }, [dispatch]);

  // --- knob drag -------------------------------------------------------------

  const onDialPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!live || dragRef.current !== null) return;
    const dial = dialRef.current;
    if (!dial) return;
    dial.setPointerCapture(event.pointerId);
    const rect = dial.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    dragRef.current = {
      pointerId: event.pointerId,
      centerX,
      centerY,
      lastAngle: pointerAngleDeg(centerX, centerY, event.clientX, event.clientY),
      sendCarry: 0,
      travelDeg: 0,
    };
  }, [live]);

  const onDialPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const angle = pointerAngleDeg(drag.centerX, drag.centerY, event.clientX, event.clientY);
    const delta = angleDeltaDeg(drag.lastAngle, angle);
    drag.lastAngle = angle;
    drag.travelDeg += Math.abs(delta);
    setDialDeg((deg) => deg + delta);
    const { steps, carry } = accumulateDetents(drag.sendCarry, delta);
    drag.sendCarry = carry;
    if (steps !== 0) emitSteps(steps);
  }, [emitSteps]);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    dialRef.current?.releasePointerCapture(event.pointerId);
    // A down-up with no meaningful travel is a tap on one half of the dial:
    // one detent toward that side, the mouse equivalent of flicking the knob.
    if (!cancelled && drag.travelDeg < 4) {
      void dispatchTurn(event.clientX >= drag.centerX ? "cw" : "ccw");
      return;
    }
    // Rest on a detent, like the hardware's spring does.
    setDialDeg((deg) => Math.round(deg / ZOS_KNOB_DETENT_DEG) * ZOS_KNOB_DETENT_DEG);
  }, [dispatchTurn]);

  // --- knob wheel ------------------------------------------------------------

  // Native listener because React's synthetic wheel handler cannot
  // preventDefault (the root listener is passive), and a knob that scrolls the
  // page while you turn it is worse than no wheel support at all.
  useEffect(() => {
    const knob = knobRef.current;
    if (!knob || !live) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // deltaMode 1 is lines (Firefox wheel); ~33px per line keeps one wheel
      // notch equal to one detent across browsers.
      const px = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      const { steps, carry } = accumulateDetents(wheelCarryRef.current, px, ZOS_WHEEL_DETENT_PX);
      wheelCarryRef.current = carry;
      for (let index = 0; index < Math.min(Math.abs(steps), MAX_STEPS_PER_GESTURE); index += 1) {
        void dispatchTurn(steps > 0 ? "cw" : "ccw");
      }
    };
    knob.addEventListener("wheel", onWheel, { passive: false });
    return () => knob.removeEventListener("wheel", onWheel);
  }, [live, dispatchTurn]);

  // --- core press / hold -----------------------------------------------------

  const stopHoldLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setHoldProgress(0);
  }, []);

  const flashHeld = useCallback(() => {
    setCoreHeld(true);
    if (holdFlashRef.current !== null) window.clearTimeout(holdFlashRef.current);
    holdFlashRef.current = window.setTimeout(() => setCoreHeld(false), HOLD_FLASH_MS);
  }, []);

  const onCorePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!live || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    trackerRef.current.down(performance.now());
    const loop = () => {
      const now = performance.now();
      // Fired from the frame that crosses the threshold, not on release —
      // waiting for the release makes every long press feel like it lagged.
      if (trackerRef.current.tick(now) === "hold") {
        void dispatch("hold");
        flashHeld();
        stopHoldLoop();
        return;
      }
      setHoldProgress(trackerRef.current.progress(now));
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [live, dispatch, flashHeld, stopHoldLoop]);

  const onCorePointerUp = useCallback(() => {
    const action = trackerRef.current.up(performance.now());
    stopHoldLoop();
    if (!action) return;
    if (action === "hold") flashHeld();
    void dispatch(action);
  }, [dispatch, flashHeld, stopHoldLoop]);

  const onCorePointerCancel = useCallback(() => {
    trackerRef.current.cancel();
    stopHoldLoop();
  }, [stopHoldLoop]);

  // Keyboard activation of the focused core button arrives as a click with
  // detail 0; pointer presses already went through the tracker above, and
  // letting their synthesized click through would double-send.
  const onCoreClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) void dispatch("press");
  }, [dispatch]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (holdFlashRef.current !== null) window.clearTimeout(holdFlashRef.current);
  }, []);

  // --- keyboard --------------------------------------------------------------

  useEffect(() => {
    if (!live) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = zosInputForKey(event.key, event.repeat);
      if (!action) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && zosKeyCaptured(event.key, {
        editable: target.closest("input, textarea, select, [contenteditable=\"true\"]") !== null,
        button: target.closest("button, a, [role=\"button\"]") !== null,
        slider: target.closest("[role=\"slider\"]") !== null,
      })) {
        return;
      }
      event.preventDefault();
      if (action === "hold") flashHeld();
      if (action === "cw" || action === "ccw") {
        void dispatchTurn(action);
      } else {
        void dispatch(action);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [live, dispatch, dispatchTurn, flashHeld]);

  // --- render ----------------------------------------------------------------

  const holdSeconds = (ZOS_HOLD_MS / 1000).toFixed(1).replace(/\.0$/, "");

  return (
    <Surface className="zc-deck" variant="solid" outline contentClassName="zc-deck__content">
      <div className={live ? "zc-deck__cluster" : "zc-deck__cluster is-off"}>
        <div className="zc-sidekey">
          <Button
            type="button"
            size="lg"
            variant="transparent"
            outline
            disabled={!live}
            aria-label="左键：短按音量减，游戏中为向左"
            onClick={() => void dispatch("left")}
          >
            <Volume1 aria-hidden="true" />
            左键
          </Button>
          <span className="zc-sidekey__hint">
            音量 − · 游戏 ←
            <Shortcut size="sm" variant="transparent" keyClassName="zc-hintkey">A</Shortcut>
          </span>
        </div>

        <div className="zc-knob" ref={knobRef}>
          <div
            ref={dialRef}
            className="zc-knob__dial"
            style={{ transform: `rotate(${dialDeg}deg)` }}
            aria-hidden="true"
            onPointerDown={onDialPointerDown}
            onPointerMove={onDialPointerMove}
            onPointerUp={(event) => endDrag(event, false)}
            onPointerCancel={(event) => endDrag(event, true)}
          >
            <span className="zc-knob__marker" />
          </div>
          {/* Rotation cues sit outside the rotating dial so they stay upright. */}
          <RotateCcw className="zc-knob__cue zc-knob__cue--ccw" aria-hidden="true" />
          <RotateCw className="zc-knob__cue zc-knob__cue--cw" aria-hidden="true" />
          <div
            className="zc-knob__ring"
            style={{ "--zc-hold": holdProgress } as CSSProperties}
            aria-hidden="true"
          />
          <button
            type="button"
            className={coreHeld ? "zc-knob__core is-held" : "zc-knob__core"}
            disabled={!live}
            aria-label={`旋钮中键：点按确认，按住 ${holdSeconds} 秒返回`}
            onPointerDown={onCorePointerDown}
            onPointerUp={onCorePointerUp}
            onPointerCancel={onCorePointerCancel}
            onClick={onCoreClick}
          >
            <span className="zc-knob__corelabel">{coreHeld ? "返回" : "确认"}</span>
            <span className="zc-knob__coresub">按住返回</span>
          </button>
          {/* The dial itself is pointer furniture; these carry its semantics
              for assistive tech, which cannot drag a circle. */}
          <span className="sr-only">
            <button type="button" disabled={!live} onClick={() => void dispatchTurn("ccw")}>
              旋钮左旋一格
            </button>
            <button type="button" disabled={!live} onClick={() => void dispatchTurn("cw")}>
              旋钮右旋一格
            </button>
          </span>
        </div>

        <div className="zc-sidekey">
          <Button
            type="button"
            size="lg"
            variant="transparent"
            outline
            disabled={!live}
            aria-label="右键：短按音量加，游戏中为向右"
            onClick={() => void dispatch("right")}
          >
            <Volume2 aria-hidden="true" />
            右键
          </Button>
          <span className="zc-sidekey__hint">
            音量 + · 游戏 →
            <Shortcut size="sm" variant="transparent" keyClassName="zc-hintkey">D</Shortcut>
          </span>
        </div>
      </div>

      <div className="zc-deck__hints">
        <span><Shortcut size="sm" variant="transparent" keyClassName="zc-hintkey">left right</Shortcut>旋钮</span>
        <span><Shortcut size="sm" variant="transparent" keyClassName="zc-hintkey">enter</Shortcut>确认</span>
        <span><Shortcut size="sm" variant="transparent" keyClassName="zc-hintkey">backspace</Shortcut>返回</span>
        <span className="zc-deck__hints-free">拖动、滚轮或点按旋钮两侧也可换台</span>
      </div>

      <p className="zc-deck__receipt" role="status" aria-live="polite">
        {receipt
          ? `事件 #${receipt.seq}「${ZOS_INPUT_LABELS[receipt.action]}」已入队，是否生效以上方镜像为准`
          : live
            ? "按键实时发往设备；固件在下一次拉取时注入"
            : "设备离线，远程按键不可用——离线排队的按键会在重连时一起爆发，所以这里不排队"}
      </p>
    </Surface>
  );
}
