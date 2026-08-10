import { buildImagePayload, type ClockPayload } from "./display.ts";
import { cjkTextWidth, drawCjkText } from "./pixel-cjk.ts";
import { drawPixelText, measurePixelText, sanitizePixelText } from "./pixel-font.ts";
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  encodePixelAnimation,
  PixelCanvas,
  type Rgb,
} from "./pixel-ui.ts";
import { SettingsValidationError } from "./settings.ts";

export interface NotifyMessage {
  message: string;
  color: string;
  background: string;
  fontScale: 1 | 2;
  speed: number;
  holdSeconds: number;
}

export interface NotifyAnimation {
  frames: PixelCanvas[];
  frameDelaysMs: number[];
}

const DEFAULT_COLOR = "#00ff66";
const DEFAULT_BACKGROUND = "#000000";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function integerOption(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SettingsValidationError(`${label} is invalid`);
  }
  return value;
}

function colorOption(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new SettingsValidationError(`${label} must be a #RRGGBB color`);
  }
  return value.toLowerCase();
}

export function parseNotifyMessage(value: unknown): NotifyMessage {
  const input = record(value);
  if (!input || typeof input.message !== "string") {
    throw new SettingsValidationError("message is required");
  }
  const message = input.message.trim();
  const messageLength = Array.from(message).length;
  if (messageLength < 1 || messageLength > 96) {
    throw new SettingsValidationError("message must contain 1-96 characters");
  }
  const fontScale = integerOption(input.fontScale, 2, 1, 2, "fontScale");
  return {
    message,
    color: colorOption(input.color, DEFAULT_COLOR, "color"),
    background: colorOption(input.background, DEFAULT_BACKGROUND, "background"),
    fontScale: fontScale as 1 | 2,
    speed: integerOption(input.speed, 12, 4, 40, "speed"),
    holdSeconds: integerOption(input.holdSeconds, 45, 5, 300, "holdSeconds"),
  };
}

function rgb(value: string): Rgb {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function frameDelays(durationMs: number, preferredFrames: number): number[] {
  const count = Math.max(2, Math.min(120, preferredFrames, Math.floor(durationMs / 20)));
  const base = Math.floor(durationMs / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? durationMs - base * (count - 1) : base
  );
}

export function renderNotifyMessage(input: NotifyMessage): NotifyAnimation {
  const foreground = rgb(input.color);
  const background = rgb(input.background);
  const text = input.fontScale === 1 ? sanitizePixelText(input.message, 96) : input.message;
  const width = input.fontScale === 1
    ? measurePixelText(text, 1, 1)
    : cjkTextWidth(text);
  const y = input.fontScale === 1
    ? Math.floor((DISPLAY_HEIGHT - 5) / 2)
    : 2;
  const draw = (canvas: PixelCanvas, x: number): void => {
    if (input.fontScale === 1) drawPixelText(canvas, text, x, y, foreground, 1, 1);
    else drawCjkText(canvas, text, x, y, foreground);
  };

  if (width <= DISPLAY_WIDTH - 4) {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT, background);
    draw(canvas, Math.floor((DISPLAY_WIDTH - width) / 2));
    return { frames: [canvas], frameDelaysMs: [input.holdSeconds * 1_000] };
  }

  const distance = DISPLAY_WIDTH + width + 2;
  const scrollDurationMs = Math.max(40, Math.ceil(distance / input.speed * 1_000));
  const delays = frameDelays(scrollDurationMs, Math.ceil(scrollDurationMs / 125));
  const frames = delays.map((_, index) => {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT, background);
    const progress = index / (delays.length - 1);
    draw(canvas, Math.round(DISPLAY_WIDTH + 1 - progress * distance));
    return canvas;
  });
  return { frames, frameDelaysMs: delays };
}

interface NotifyManagerOptions {
  pushPayload: (payload: ClockPayload) => Promise<{ status: number }>;
  clearApp: () => Promise<{ status: number }>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onCleanupError?: (error: unknown) => void;
}

export class NotifyManager {
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private cleanupTimer: unknown;
  private revision = 0;

  constructor(private readonly options: NotifyManagerOptions) {
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async push(input: NotifyMessage): Promise<{ status: number }> {
    const revision = ++this.revision;
    this.cancelCleanup();
    const animation = renderNotifyMessage(input);
    const image = animation.frames.length === 1
      ? { bytes: animation.frames[0]!.toPng(), mimeType: "image/png" as const }
      : {
        bytes: encodePixelAnimation(animation.frames, animation.frameDelaysMs),
        mimeType: "image/gif" as const,
      };
    const result = await this.options.pushPayload(
      buildImagePayload(image.bytes, image.mimeType, input.holdSeconds),
    );
    if (revision === this.revision) {
      this.cleanupTimer = this.schedule(() => {
        this.cleanupTimer = undefined;
        void this.options.clearApp().catch((error) => this.options.onCleanupError?.(error));
      }, input.holdSeconds * 1_000);
    }
    return result;
  }

  async clear(): Promise<{ status: number }> {
    this.revision += 1;
    this.cancelCleanup();
    return await this.options.clearApp();
  }

  private cancelCleanup(): void {
    if (this.cleanupTimer === undefined) return;
    this.cancel(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }
}
