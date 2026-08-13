// The regression suite for "I changed the colour and the clock kept showing the
// old one".
//
// Under ZOS the device PULLS: it fetches a channel's frames from
// /api/os/frames once and caches them, and it only re-asks when the state
// document tells it something moved. Every one of these tests fails against the
// pre-fix service, and they fail for the right reason — the document compared
// equal after an edit, so the sequence never bumped, the parked long poll was
// never released, and nothing on the device ever learned there were new pixels
// to fetch.
//
// The assertions are on actual RGB bytes out of the frame bundle rather than on
// "did the encoder get called": the bug was that the SERVICE was already
// rendering correctly and the news never travelled, so anything short of
// comparing the bytes the device would receive proves nothing.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.ts";
import { createControlHandler } from "../src/control-api.ts";
import { OsLinkHub, type OsMenuEntry } from "../src/os-link.ts";
import { FRAME_BUNDLE_HEADER_BYTES } from "../src/os-frames.ts";
import { WorkspaceStore, type WorkspaceSettings } from "../src/workspace.ts";
import { WorkspaceController } from "../src/workspace-controller.ts";

const ORIGIN = "http://127.0.0.1:43820";
const W = 52;
const H = 16;
const FRAME_BYTES = W * H * 3;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function noticeWorkspace(options: Record<string, unknown>): WorkspaceSettings {
  return {
    version: 3,
    channels: [{
      id: "board",
      name: "通知板",
      appName: "notice_board",
      enabled: true,
      refreshIntervalMs: 30_000,
      items: [{
        id: "notice",
        contentId: "tools:notice",
        durationMs: 1_000,
        options: {
          message: "HI",
          color: "#00ff66",
          background: "#000000",
          scroll: false,
          fontScale: "2",
          speed: 12,
          ...options,
        },
      }],
    }],
  };
}

/** A channel whose only volatile input comes off the network, on a 30 s interval. */
function tickerWorkspace(): WorkspaceSettings {
  return {
    version: 3,
    channels: [{
      id: "btc",
      name: "比特币",
      appName: "ticker",
      enabled: true,
      refreshIntervalMs: 30_000,
      items: [{
        id: "price",
        contentId: "market:btc",
        durationMs: 15_000,
        options: { showChange: true, changeDurationMs: 2_500 },
      }],
    }],
  };
}

/** The pixels of frame 0, exactly as the firmware's FrameBundle would read them. */
function firstFramePixels(bundle: Uint8Array): Uint8Array {
  expect(String.fromCharCode(...bundle.slice(0, 4))).toBe("TCF1");
  expect(bundle[6]).toBe(W);
  expect(bundle[7]).toBe(H);
  // Header, then per frame: a 2-byte delay followed by the RGB plane.
  const start = FRAME_BUNDLE_HEADER_BYTES + 2;
  return bundle.slice(start, start + FRAME_BYTES);
}

/** Indices of pixels that are lit at all — the glyph strokes, on a black board. */
function litPixels(rgb: Uint8Array): number[] {
  const lit: number[] = [];
  for (let pixel = 0; pixel < W * H; pixel += 1) {
    const at = pixel * 3;
    if (rgb[at]! + rgb[at + 1]! + rgb[at + 2]! > 0) lit.push(pixel);
  }
  return lit;
}

interface Harness {
  controller: WorkspaceController;
  osLink: OsLinkHub;
  handler: ReturnType<typeof createControlHandler>;
  publishOsMenu: () => void;
  frames: (appName: string) => Promise<{ bundle: Uint8Array; rev: string | null }>;
  saveWorkspace: (workspace: WorkspaceSettings) => Promise<Response>;
}

async function harness(workspace: WorkspaceSettings): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "ulanzi-os-refresh-"));
  directories.push(directory);
  const controller = new WorkspaceController({
    config: loadConfig({ CLOCK_HOST: "tc002.test" }),
    workspace,
    workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
    marketClient: {} as never,
    pushPayload: async () => ({ status: 200 }),
    deleteApp: async () => ({ status: 200 }),
  });
  const osLink = new OsLinkHub();
  // Byte for byte what src/service.ts does. Copied rather than imported because
  // service.ts is a composition root that opens sockets on import; the point of
  // the copy is that the RESHAPE of the menu entry is what carries the edit, so
  // it has to be the shape service.ts actually publishes.
  const publishOsMenu = (): void => {
    const entries: OsMenuEntry[] = controller.getWorkspace().channels
      .filter((channel) => channel.enabled)
      .map((channel) => ({
        id: channel.appName,
        label: channel.name,
        kind: "channel" as const,
        rev: controller.channelContentRevision(channel),
        ttlMs: controller.getEffectiveRefreshIntervalMs(channel),
      }));
    entries.push({ id: "music", label: "音乐", kind: "music" });
    entries.push({ id: "settings", label: "设置", kind: "settings" });
    osLink.setMenu(entries);
  };
  const handler = createControlHandler(controller, {
    osLink,
    onSettingsChanged: publishOsMenu,
  });
  publishOsMenu();
  return {
    controller,
    osLink,
    handler,
    publishOsMenu,
    frames: async (appName: string) => {
      const response = await handler(new Request(`${ORIGIN}/api/os/frames?app=${appName}`));
      expect(response.status).toBe(200);
      return {
        bundle: new Uint8Array(await response.arrayBuffer()),
        rev: response.headers.get("X-Os-Rev"),
      };
    },
    saveWorkspace: (next: WorkspaceSettings) => handler(new Request(`${ORIGIN}/api/workspace`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(next),
    })),
  };
}

describe("an options edit reaches the panel", () => {
  test("recolouring an item changes the pixels the device would fetch", async () => {
    const os = await harness(noticeWorkspace({ color: "#00ff66" }));

    const before = firstFramePixels((await os.frames("notice_board")).bundle);
    const litBefore = litPixels(before);
    // Guard against the test that would pass on a blank panel: there has to be
    // something drawn before "the drawing changed" can mean anything.
    expect(litBefore.length).toBeGreaterThan(20);
    expect(before[litBefore[0]! * 3 + 1]).toBeGreaterThan(before[litBefore[0]! * 3]!);

    expect((await os.saveWorkspace(noticeWorkspace({ color: "#ff2200" }))).status).toBe(200);

    const after = firstFramePixels((await os.frames("notice_board")).bundle);
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(false);
    // The SAME strokes, in the new colour — not a differently laid out frame
    // that happens to hash differently. Green-dominant became red-dominant on
    // every pixel the glyphs occupy.
    expect(litPixels(after)).toEqual(litBefore);
    for (const pixel of litBefore) {
      expect(after[pixel * 3]!).toBeGreaterThan(after[pixel * 3 + 1]!);
    }
  });

  test("changing the message redraws the board", async () => {
    const os = await harness(noticeWorkspace({ message: "HI" }));
    const before = firstFramePixels((await os.frames("notice_board")).bundle);

    await os.saveWorkspace(noticeWorkspace({ message: "OK" }));
    const after = firstFramePixels((await os.frames("notice_board")).bundle);

    // Different glyphs, so the lit set itself moves — the strongest form of
    // "these are not the frames from before".
    expect(litPixels(after)).not.toEqual(litPixels(before));
    expect(litPixels(after).length).toBeGreaterThan(20);
  });

  test("the saved edit wakes a device parked in a long poll", async () => {
    // THIS is the test that would have caught the bug. Everything above passes
    // against the broken service too, because the service always rendered
    // correctly — what never happened was the device being told.
    const os = await harness(noticeWorkspace({ color: "#00ff66" }));
    const seq = os.osLink.currentSeq();
    const parked = os.osLink.waitForChange(seq, 5_000);
    await Bun.sleep(5);
    expect(os.osLink.pendingWaiters()).toBe(1);

    await os.saveWorkspace(noticeWorkspace({ color: "#ff2200" }));

    const document = await parked;
    expect(os.osLink.pendingWaiters()).toBe(0);
    expect(os.osLink.currentSeq()).toBeGreaterThan(seq);
    expect(document).toContain("item\tchannel\tnotice_board\t通知板");
  });

  test("publishes a revision that moves with the pixels and a ttl the render is good for", async () => {
    const os = await harness(noticeWorkspace({ color: "#00ff66" }));
    const revOf = (document: string): string | undefined =>
      document.split("\n").find((line) => line.startsWith("rev\tnotice_board\t"))?.split("\t")[2];

    const before = revOf(os.osLink.serialize());
    expect(before).toMatch(/^[0-9a-f]{12}$/);
    // Emitted as its own key, never as a fifth field on `item`: the deployed
    // firmware's parser matches `item` on a strict arity of four and would drop
    // the whole menu — and with it the channel ring — if that line grew.
    expect(os.osLink.serialize()).toContain("item\tchannel\tnotice_board\t通知板\n");
    // max(refreshIntervalMs, animation) — how long a render of a clock face
    // stays true, which is the other half of the frozen-panel problem.
    expect(os.osLink.serialize()).toContain("ttl\tnotice_board\t30000");

    await os.saveWorkspace(noticeWorkspace({ color: "#ff2200" }));
    const after = revOf(os.osLink.serialize());
    expect(after).toMatch(/^[0-9a-f]{12}$/);
    expect(after).not.toBe(before);
    // The header the device records, so a save landing between "read the
    // document" and "fetch the frames" does not cost it a redundant round trip.
    expect((await os.frames("notice_board")).rev).toBe(after!);
  });

  test("a rename does not invalidate frames that would come back identical", async () => {
    // Scope check. Blunt invalidation — hashing the whole channel — would make
    // every rename re-download a bundle byte for byte identical to the one the
    // device already holds, and every one of those fetches is a GIF-grade
    // render queued in front of the edit the user is actually waiting on.
    const os = await harness(noticeWorkspace({ color: "#00ff66" }));
    const before = os.controller.channelContentRevision(os.controller.getWorkspace().channels[0]!);

    const renamed = noticeWorkspace({ color: "#00ff66" });
    renamed.channels[0]!.name = "门口的牌子";
    renamed.channels[0]!.refreshIntervalMs = 45_000;
    await os.saveWorkspace(renamed);

    expect(os.controller.channelContentRevision(os.controller.getWorkspace().channels[0]!))
      .toBe(before);
    // The label still has to reach the panel — it is just not a reason to
    // re-fetch pixels.
    expect(os.osLink.serialize()).toContain("item\tchannel\tnotice_board\t门口的牌子");
    expect(os.osLink.serialize()).toContain(`rev\tnotice_board\t${before}`);
    expect(os.osLink.serialize()).toContain("ttl\tnotice_board\t45000");
  });

  test("only the edited channel's revision moves", async () => {
    const workspace = noticeWorkspace({ message: "HI" });
    workspace.channels.push({
      id: "second",
      name: "另一台",
      appName: "second_board",
      enabled: true,
      refreshIntervalMs: 30_000,
      items: [{
        id: "other",
        contentId: "tools:notice",
        durationMs: 1_000,
        options: { message: "ZZ", color: "#3388ff", background: "#000000", scroll: false },
      }],
    });
    const os = await harness(workspace);
    const revs = () => Object.fromEntries(
      os.osLink.serialize().split("\n")
        .filter((line) => line.startsWith("rev\t"))
        .map((line) => line.split("\t").slice(1) as [string, string]),
    );
    const before = revs();

    const edited = structuredClone(workspace);
    edited.channels[0]!.items[0]!.options.message = "NO";
    await os.saveWorkspace(edited);

    const after = revs();
    expect(after.notice_board).not.toBe(before.notice_board);
    expect(after.second_board).toBe(before.second_board);
  });

  test("a flashed ZOS takes away the device write and nothing else", async () => {
    // Two failures live here, and they pull in opposite directions.
    //
    // ZOS replaced the official app and with it `POST /api/custom`; what
    // answers now is a setup portal that returns the config page and HTTP 200
    // for EVERY unknown path. So every push "worked": updateCount climbed,
    // lastError stayed clear, the console showed a healthy channel — and the
    // pixels went into a captive-portal 404.
    //
    // The obvious fix — stop running the loop — is worse, and silently. The
    // scheduled push is the ONLY periodic caller that renders with
    // forceRefresh, and forceRefresh is the only thing that sends getMarket and
    // getWeather to the network; the device's own /api/os/frames pull renders
    // out of those caches with forceRefresh=false and no age bound. Skip the
    // schedule and BTC is fetched once, at startup, and never again — while the
    // panel keeps redrawing because the clock digits read a live nowMs.
    const directory = await mkdtemp(join(tmpdir(), "ulanzi-os-suspend-"));
    directories.push(directory);
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const osLink = new OsLinkHub();
    const quotes: number[] = [];
    const marketClient = {
      getAsset: async (assetId: string) => {
        const price = 20_000 + quotes.length * 1_000;
        quotes.push(price);
        return {
          assetId,
          provider: "coinbase",
          price,
          rawPrice: String(price),
          fetchedAt: new Date(nowMs).toISOString(),
          changePercent: 1.5,
          changePeriod: "24H",
        };
      },
    };
    const pushedApps: string[] = [];
    const controller = new WorkspaceController({
      config: loadConfig({ CLOCK_HOST: "tc002.test" }),
      workspace: tickerWorkspace(),
      workspaceStore: new WorkspaceStore(join(directory, "workspace.json")),
      marketClient: marketClient as never,
      pushPayload: async (appName) => {
        pushedApps.push(appName);
        return { status: 200 };
      },
      deleteApp: async () => ({ status: 200 }),
      devicePushSuspended: () => osLink.zosFlashed(),
      now: () => nowMs,
    });

    // Stock firmware: the loop pushes, and the quote is refreshed with it.
    await controller.pushDue();
    expect(pushedApps).toEqual(["ticker"]);
    expect(quotes.length).toBe(1);

    const report = (flashed: boolean) => osLink.report({
      screen: "channel", focus: "ticker", wifi: "home", ip: "192.168.8.240",
      uptimeMs: 60_000, freeKb: 900, supplicantRestarts: 0, proto: 0,
      batteryPercent: 87, charging: false, flashed,
    });
    report(true);
    expect(osLink.zosFlashed()).toBe(true);
    // Sticky on purpose: sideloading the music or arcade firmware over a flashed
    // ZOS takes ZOS off the air, and resuming pushes then would resume writing
    // into nothing while claiming it worked.
    report(false);
    expect(osLink.zosFlashed()).toBe(true);
    expect(controller.getState().devicePushSuspended).toBe(true);

    // One interval later: no write reached the device...
    nowMs += 31_000;
    await controller.pushDue();
    expect(pushedApps).toEqual(["ticker"]);
    // ...and the price moved anyway. This is the assertion the whole test
    // exists for: a second trip to the quote source after the interval elapsed.
    expect(quotes.length).toBe(2);

    // And the device, pulling with forceRefresh=false, reads the NEW number out
    // of the cache that scheduled render just refreshed rather than the startup
    // one — without a network trip of its own. previewChannel is the code path
    // behind /api/os/frames.
    expect(controller.getState().assets[0]!.price).toBe(21_000);
    await controller.previewChannel(controller.getWorkspace().channels[0]!.id);
    expect(quotes.length).toBe(2);
  });

  test("a revision survives a restart, so a reconnect does not re-download everything", async () => {
    // The device caches per revision. JSON.stringify follows insertion order, so
    // a channel parsed back out of workspace.json and the same channel straight
    // off the console's request body would hash differently — every service
    // restart would look like an edit of every channel at once, which on a
    // single-core device is a stall the user sees as the panel going blank.
    const os = await harness(noticeWorkspace({ message: "HI" }));
    const before = os.controller.channelContentRevision(os.controller.getWorkspace().channels[0]!);

    const reordered = noticeWorkspace({});
    reordered.channels[0]!.items[0]!.options = {
      speed: 12,
      scroll: false,
      background: "#000000",
      color: "#00ff66",
      fontScale: "2",
      message: "HI",
    };
    await os.saveWorkspace(reordered);

    expect(os.controller.channelContentRevision(os.controller.getWorkspace().channels[0]!))
      .toBe(before);
  });
});
