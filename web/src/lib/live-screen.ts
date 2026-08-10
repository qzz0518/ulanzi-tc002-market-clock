import { createLatestTaskRunner, type LatestTaskRunner } from "@/lib/latest-task-runner";
import { frameToBase64Rgb } from "@/lib/music-mirror";

// Record-and-replay batching for the live device channel. The browser runs the
// animation at rAF speed for a zero-latency preview while this module samples
// the canvas on a fixed cadence and ships short batches; the device then plays
// each batch as a seamless GIF instead of dropping to ~6fps on single frames
// (measured on hardware — see docs/design/pixel-playground.md §0).
//
// Both constants are deliberately central so on-device tuning is a two-line
// change: 4 frames × 25ms = one 100ms batch, which the measured <50ms link
// comfortably sustains as a constant ~150-200ms-delayed continuous animation.
export const LIVE_FRAME_MS = 25;
export const LIVE_BATCH_FRAMES = 4;
// How long the device keeps the live app alive with no further batches — long
// enough to bridge network hiccups, short enough to self-clean after a crash.
export const LIVE_HOLD_SECONDS = 6;
// A gap longer than this (hidden tab, GC pause) restarts the cadence instead of
// stuffing the batch with identical catch-up frames.
const RESYNC_GAP_MS = 250;

export interface LiveScreenOptions {
  /** A batch failed to reach the device. */
  onError?: (error: unknown) => void;
  /** A batch landed — callers typically clear a stale error banner here. */
  onPushed?: () => void;
  /** Injectable transport for tests; defaults to the page's fetch. */
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface LiveScreen {
  /**
   * Sample the canvas if the 25ms cadence says a frame is due. Call once per
   * rAF tick with the same clock used for the animation loop.
   */
  capture(context: CanvasRenderingContext2D, now: number): void;
  /** Wipe the device screen and drop recording state; capture may resume after. */
  clear(): void;
  /** Terminal clear — the screen stops accepting captures. */
  dispose(): void;
}

async function describeFailure(response: Response): Promise<string> {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // A non-JSON body still leaves the HTTP status above.
  }
  return message;
}

export function createLiveScreen(app: string, options: LiveScreenOptions = {}): LiveScreen {
  const fetcher = options.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let runner: LatestTaskRunner<string[]> | null = null;
  let inFlight: Promise<Response> | null = null;
  let generation = 0;
  let disposed = false;
  let batch: string[] = [];
  let nextRecordAt = 0;

  // Single-flight ring semantics: while one POST is on the wire, finished
  // batches collapse into a single latest pending batch, so a slow link skips
  // ahead instead of building a backlog of stale animation.
  const ensureRunner = (): LatestTaskRunner<string[]> => {
    if (runner) return runner;
    generation += 1;
    runner = createLatestTaskRunner<string[], void>({
      execute: async (frames) => {
        const request = fetcher("/api/live/frames", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app,
            frames: frames.map((pixels) => ({ delayMs: LIVE_FRAME_MS, pixels })),
            holdSeconds: LIVE_HOLD_SECONDS,
          }),
        });
        inFlight = request;
        try {
          const response = await request;
          if (!response.ok) throw new Error(await describeFailure(response));
        } finally {
          if (inFlight === request) inFlight = null;
        }
      },
      apply: () => options.onPushed?.(),
      onError: (error) => options.onError?.(error),
    });
    return runner;
  };

  const removeFromDevice = () => fetcher(
    `/api/live/frames?app=${encodeURIComponent(app)}`,
    { method: "DELETE", keepalive: true },
  ).catch(() => undefined);

  const clear = () => {
    batch = [];
    nextRecordAt = 0;
    const pendingRequest = inFlight;
    const clearGeneration = ++generation;
    runner?.dispose();
    runner = null;
    void removeFromDevice();
    // A POST that already reached the server finishes its serialized device
    // write after the first DELETE lands. Clear once more after that request
    // settles — unless play resumed and minted a newer generation meanwhile.
    if (pendingRequest) {
      void pendingRequest.catch(() => undefined).then(() => {
        if (generation === clearGeneration) void removeFromDevice();
      });
    }
  };

  return {
    capture(context, now) {
      if (disposed) return;
      if (nextRecordAt === 0 || now - nextRecordAt > RESYNC_GAP_MS) nextRecordAt = now;
      if (now < nextRecordAt) return;
      // One rasterization per call even when a late rAF owes several cadence
      // slots — duplicating the sample keeps the animation timeline honest.
      const pixels = frameToBase64Rgb(context);
      while (now >= nextRecordAt) {
        batch.push(pixels);
        nextRecordAt += LIVE_FRAME_MS;
        if (batch.length >= LIVE_BATCH_FRAMES) {
          void ensureRunner().enqueue(batch);
          batch = [];
        }
      }
    },
    clear,
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
    },
  };
}
