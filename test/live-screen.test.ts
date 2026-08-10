import { describe, expect, test } from "bun:test";
import {
  createLiveScreen,
  LIVE_BATCH_FRAMES,
  LIVE_FRAME_MS,
  LIVE_HOLD_SECONDS,
} from "../web/src/lib/live-screen.ts";

const PIXEL_COUNT = 52 * 16;

// A canvas stand-in whose pixel data changes every sample, so tests can tell
// which capture produced which frame.
function fakeContext() {
  let stamp = 0;
  return {
    nextStamp: () => stamp,
    context: {
      getImageData: () => {
        const data = new Uint8ClampedArray(PIXEL_COUNT * 4);
        data.fill(stamp % 256);
        stamp += 1;
        return { data };
      },
    } as unknown as CanvasRenderingContext2D,
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  keepalive: boolean;
  body?: {
    app: string;
    frames: { delayMs: number; pixels: string }[];
    holdSeconds: number;
  };
}

function recordingFetcher(options: { deferFirstPost?: boolean } = {}) {
  const requests: RecordedRequest[] = [];
  let releaseFirstPost: (() => void) | null = null;
  let postCount = 0;
  const fetcher = (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      keepalive: init?.keepalive === true,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (method === "POST") {
      postCount += 1;
      if (options.deferFirstPost && postCount === 1) {
        return new Promise((resolve) => {
          releaseFirstPost = () => resolve(new Response(null, { status: 204 }));
        });
      }
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  return {
    requests,
    fetcher,
    releaseFirstPost: () => releaseFirstPost?.(),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("live screen record-and-replay", () => {
  test("records on the 25ms cadence and posts one batch per four frames", async () => {
    const { fetcher, requests } = recordingFetcher();
    const { context } = fakeContext();
    const screen = createLiveScreen("game", { fetcher });

    // rAF at ~60Hz: only ticks that cross a 25ms slot record a frame.
    for (let tick = 0; tick < 9; tick += 1) {
      screen.capture(context, 1_000 + tick * 16.7);
    }
    await settle();

    expect(requests).toHaveLength(1);
    const post = requests[0]!;
    expect(post.url).toBe("/api/live/frames");
    expect(post.method).toBe("POST");
    expect(post.body?.app).toBe("game");
    expect(post.body?.holdSeconds).toBe(LIVE_HOLD_SECONDS);
    expect(post.body?.frames).toHaveLength(LIVE_BATCH_FRAMES);
    expect(post.body?.frames.every((frame) => frame.delayMs === LIVE_FRAME_MS)).toBe(true);
    screen.dispose();
  });

  test("keeps only the latest finished batch while a post is in flight", async () => {
    const { fetcher, requests, releaseFirstPost } = recordingFetcher({ deferFirstPost: true });
    const { context } = fakeContext();
    const screen = createLiveScreen("game", { fetcher });

    // Three complete batches on a perfect cadence while the first POST hangs.
    for (let frame = 0; frame < 12; frame += 1) {
      screen.capture(context, 1_000 + frame * LIVE_FRAME_MS);
    }
    await settle();
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);

    releaseFirstPost();
    await settle();
    const posts = requests.filter((request) => request.method === "POST");
    // Batch 2 was superseded by batch 3 — only the newest followed the first.
    expect(posts).toHaveLength(2);
    const firstPixels = posts[0]!.body!.frames.map((frame) => frame.pixels);
    const lastPixels = posts[1]!.body!.frames.map((frame) => frame.pixels);
    // Frames arrive in capture order and the second POST carries the newest batch.
    expect(new Set([...firstPixels, ...lastPixels]).size).toBe(LIVE_BATCH_FRAMES * 2);
    screen.dispose();
  });

  test("resynchronizes after a stall instead of flooding catch-up frames", async () => {
    const { fetcher, requests } = recordingFetcher();
    const { context } = fakeContext();
    const screen = createLiveScreen("game", { fetcher });

    screen.capture(context, 1_000);          // frame 1
    screen.capture(context, 3_000);          // 2s stall → resync, frame 2
    screen.capture(context, 3_000 + 25);     // frame 3
    screen.capture(context, 3_000 + 50);     // frame 4 → flush
    await settle();

    const posts = requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body?.frames).toHaveLength(LIVE_BATCH_FRAMES);
    screen.dispose();
  });

  test("clear deletes immediately and again after the in-flight post settles", async () => {
    const { fetcher, requests, releaseFirstPost } = recordingFetcher({ deferFirstPost: true });
    const { context } = fakeContext();
    const screen = createLiveScreen("game", { fetcher });

    for (let frame = 0; frame < 4; frame += 1) {
      screen.capture(context, 1_000 + frame * LIVE_FRAME_MS);
    }
    await settle();
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);

    screen.clear();
    await settle();
    const deletesBefore = requests.filter((request) => request.method === "DELETE");
    expect(deletesBefore).toHaveLength(1);
    expect(deletesBefore[0]!.url).toBe("/api/live/frames?app=game");
    expect(deletesBefore[0]!.keepalive).toBe(true);

    // The straggler POST settles after the DELETE → one compensating DELETE.
    releaseFirstPost();
    await settle();
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(2);
    screen.dispose();
  });

  test("skips the compensating delete when capture resumed with a new generation", async () => {
    const { fetcher, requests, releaseFirstPost } = recordingFetcher({ deferFirstPost: true });
    const { context } = fakeContext();
    const screen = createLiveScreen("game", { fetcher });

    for (let frame = 0; frame < 4; frame += 1) {
      screen.capture(context, 1_000 + frame * LIVE_FRAME_MS);
    }
    await settle();
    screen.clear();
    await settle();
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);

    // Play resumed before the stale POST settled — its late success must not
    // wipe the fresh stream.
    for (let frame = 0; frame < 4; frame += 1) {
      screen.capture(context, 2_000 + frame * LIVE_FRAME_MS);
    }
    await settle();
    releaseFirstPost();
    await settle();
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST").length).toBeGreaterThanOrEqual(2);
    screen.dispose();
  });

  test("surfaces push failures and recovery through the callbacks", async () => {
    const events: string[] = [];
    let failNext = true;
    const fetcher = (_url: string, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? "GET") === "POST" && failNext) {
        failNext = false;
        return Promise.resolve(Response.json({ error: "设备不在线" }, { status: 503 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const { context } = fakeContext();
    const screen = createLiveScreen("game", {
      fetcher,
      onError: (error) => events.push(`error:${error instanceof Error ? error.message : "?"}`),
      onPushed: () => events.push("pushed"),
    });

    for (let frame = 0; frame < 8; frame += 1) {
      screen.capture(context, 1_000 + frame * LIVE_FRAME_MS);
      await settle();
    }
    expect(events[0]).toBe("error:设备不在线");
    expect(events).toContain("pushed");
    screen.dispose();
  });
});
