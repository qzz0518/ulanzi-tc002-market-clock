declare module "gifenc" {
  export type Palette = number[][];

  export interface GifFrameOptions {
    palette?: Palette;
    delay?: number;
    repeat?: number;
    dispose?: number;
  }

  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: GifFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  export function GIFEncoder(options?: {
    initialCapacity?: number;
    auto?: boolean;
  }): GifEncoderInstance;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: "rgb565" | "rgb444" | "rgba4444",
  ): Uint8Array;
}
