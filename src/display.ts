export interface ImageElement {
  data: string;
  position: [number, number];
}

export interface ClockPayload {
  duration: number;
  text: unknown[];
  image: ImageElement[];
  draw: unknown[];
}

export function buildImagePayload(
  image: Uint8Array,
  mimeType: "image/gif" | "image/png",
  durationSeconds: number,
): ClockPayload {
  return {
    duration: durationSeconds,
    text: [],
    image: [
      {
        data: `data:${mimeType};base64,${Buffer.from(image).toString("base64")}`,
        position: [0, 0],
      },
    ],
    draw: [],
  };
}
