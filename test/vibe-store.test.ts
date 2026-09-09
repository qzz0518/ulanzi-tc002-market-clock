import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VibeStore } from "../src/vibe/vibe-store.ts";
import { VIBE_CATALOG } from "../src/vibe/vibe-catalog.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ulanzi-vibe-"));
  directories.push(directory);
  return join(directory, "vibe.json");
}

describe("vibe starred store", () => {
  test("starts on the OpenUsage default pins for every catalog provider", async () => {
    const store = new VibeStore(await storePath());
    const starred = await store.load();
    expect(Object.keys(starred).sort()).toEqual(VIBE_CATALOG.map((entry) => entry.id).sort());
    expect(starred.claude).toEqual(["session", "weekly"]);
    expect(starred.opencode).toEqual(["session", "weekly"]);
    expect(starred.grok).toEqual(["weekly"]);
  });

  test("persists one provider's pins without disturbing the other three", async () => {
    const path = await storePath();
    const store = new VibeStore(path);
    await store.load();
    const starred = store.setStarred("claude", ["weekly", "fable"]);
    expect(starred.claude).toEqual(["weekly", "fable"]);
    expect(starred.codex).toEqual(["session", "weekly"]);
    await store.settled();

    // Only what the user changed is on disk; the rest stays derived from the
    // catalog, so a future default change reaches providers nobody touched.
    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(file).toEqual({ version: 1, starred: { claude: ["weekly", "fable"] } });

    const reopened = new VibeStore(path);
    expect((await reopened.load()).claude).toEqual(["weekly", "fable"]);
  });

  test("persists the page dwell beside the pins, and keeps 0 out of the file", async () => {
    const path = await storePath();
    const store = new VibeStore(path);
    await store.load();
    // 0 is the default AND a legal value, so writing it must not create a file
    // that pins today's default against a future one — same rule the untouched
    // providers' stars follow.
    expect(store.getPageIntervalSec()).toBe(0);
    expect(store.setPageIntervalSec(20)).toBe(20);
    await store.settled();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      starred: {},
      pageIntervalSec: 20,
    });

    const reopened = new VibeStore(path);
    await reopened.load();
    expect(reopened.getPageIntervalSec()).toBe(20);
    reopened.setPageIntervalSec(0);
    await reopened.settled();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, starred: {} });
  });

  test("页内两段停留是部分写入，默认值不落盘", async () => {
    const path = await storePath();
    const store = new VibeStore(path);
    await store.load();
    expect(store.getCellDwell()).toEqual({ valueMs: 3_200, resetMs: 1_600 });

    // Naming one half must leave the other alone — two controls on one section,
    // same rule PUT /api/os/sleep follows.
    expect(store.setCellDwell({ valueMs: 5_000 })).toEqual({ valueMs: 5_000, resetMs: 1_600 });
    expect(store.setCellDwell({ resetMs: 0 })).toEqual({ valueMs: 5_000, resetMs: 0 });
    await store.settled();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      starred: {},
      valueDwellMs: 5_000,
      resetDwellMs: 0,
    });

    // Back to the shipped values and the keys leave the file entirely.
    store.setCellDwell({ valueMs: 3_200, resetMs: 1_600 });
    await store.settled();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, starred: {} });
  });

  test("0 只对倒计时那半合法，越界一律拒绝", async () => {
    const store = new VibeStore(await storePath());
    await store.load();
    // A cell that never shows the number is not a row, so 0 is refused there.
    expect(() => store.setCellDwell({ valueMs: 0 })).toThrow("valueDwellMs must be between 500 and 20000");
    expect(() => store.setCellDwell({ resetMs: 0 })).not.toThrow();
    expect(() => store.setCellDwell({ resetMs: 100 })).toThrow("resetDwellMs must be 0 or between 500 and 20000");
    expect(() => store.setCellDwell({ valueMs: 20_001 })).toThrow("between 500 and 20000");
    expect(() => store.setCellDwell({ valueMs: 3_200.5 })).toThrow("must be an integer");

    // A hand-edited file keeps the half it got right and defaults the other.
    const path = await storePath();
    await writeFile(path, JSON.stringify({ version: 1, starred: {}, valueDwellMs: 5_000, resetDwellMs: 7 }));
    const reopened = new VibeStore(path);
    await reopened.load();
    expect(reopened.getCellDwell()).toEqual({ valueMs: 5_000, resetMs: 1_600 });
  });

  test("the page dwell is 0 or in range, and a file it cannot read means off", async () => {
    const store = new VibeStore(await storePath());
    await store.load();
    // Rejected rather than clamped: this is the write path a person drove, and
    // storing 5 when they asked for 2 is the console lying about what it saved.
    expect(() => store.setPageIntervalSec(2)).toThrow("must be 0 or between 5 and 300");
    expect(() => store.setPageIntervalSec(301)).toThrow("must be 0 or between 5 and 300");
    expect(() => store.setPageIntervalSec(7.5)).toThrow("must be an integer");
    expect(() => store.setPageIntervalSec("20" as unknown as number)).toThrow("must be an integer");
    expect(store.getPageIntervalSec()).toBe(0);

    // A hand-edited file is dropped to off, not repaired upward: a value nobody
    // can make sense of must not become a clock that starts turning its pages.
    const path = await storePath();
    await writeFile(path, JSON.stringify({ version: 1, starred: {}, pageIntervalSec: 2 }));
    const reopened = new VibeStore(path);
    await reopened.load();
    expect(reopened.getPageIntervalSec()).toBe(0);
  });

  test("accepts an unknown metric key but never an unknown provider or a third pin", async () => {
    const store = new VibeStore(await storePath());
    await store.load();
    // Upstream ships new resources before this catalog learns them, so a key we
    // do not know is legal — only its shape is checked.
    expect(store.setStarred("codex", ["gpt6Session"]).codex).toEqual(["gpt6Session"]);
    // Duplicates collapse rather than eating the second slot.
    expect(store.setStarred("codex", ["weekly", "weekly"]).codex).toEqual(["weekly"]);

    expect(() => store.setStarred("chatgpt", ["session"])).toThrow("unknown vibe provider");
    // A vendor VIBE used to collect is exactly as unknown as one it never had:
    // dropping an agent must not leave a back door that writes its id to disk.
    expect(() => store.setStarred("cursor", ["autoUsage"])).toThrow("unknown vibe provider");
    expect(() => store.setStarred("claude", ["session", "weekly", "fable"]))
      .toThrow("at most 2 starred metrics per provider");
    expect(() => store.setStarred("claude", "session" as unknown as string[]))
      .toThrow("starred must be an array");
    expect(() => store.setStarred("claude", ["../etc/passwd"])).toThrow("metric keys are invalid");
    expect(() => store.setStarred("claude", ["9lives"])).toThrow("metric keys are invalid");
    expect(() => store.setStarred("claude", ["s".repeat(33)])).toThrow("metric keys are invalid");
  });

  test("boots on the defaults rather than failing when the file is unreadable", async () => {
    const path = await storePath();
    await writeFile(path, "{ this is not json");
    const store = new VibeStore(path);
    expect((await store.load()).claude).toEqual(["session", "weekly"]);

    // Entries for providers and keys that do not survive validation are dropped
    // on load, not carried forward into the merged table.
    await writeFile(
      path,
      JSON.stringify({ version: 1, starred: { claude: ["weekly", 7, "fable"], nope: ["x"] } }),
    );
    const second = new VibeStore(path);
    const starred = await second.load();
    expect(starred.claude).toEqual(["weekly", "fable"]);
    expect(starred.nope).toBeUndefined();
  });

  test("a file left by an older build naming a dropped provider is ignored", async () => {
    // The six agents VIBE used to collect are gone from the catalog, but a user
    // who starred one still has it in .runtime/vibe.json. Loading that must not
    // throw, and must not resurrect the id into the merged table — otherwise the
    // console would render a provider nothing can ever fetch and the device
    // would be handed a page with no mark to draw.
    const path = await storePath();
    await writeFile(path, JSON.stringify({
      version: 1,
      starred: {
        cursor: ["autoUsage", "apiUsage"],
        copilot: ["premiumCredits"],
        antigravity: ["geminiSession"],
        devin: ["daily"],
        openrouter: ["credits"],
        zai: ["session"],
        claude: ["weekly", "fable"],
      },
    }));
    const store = new VibeStore(path);
    const starred = await store.load();

    expect(Object.keys(starred).sort()).toEqual(VIBE_CATALOG.map((entry) => entry.id).sort());
    for (const dropped of ["cursor", "copilot", "antigravity", "devin", "openrouter", "zai"]) {
      expect(starred[dropped]).toBeUndefined();
    }
    // The one surviving provider's pins are still honoured, so a partial clean-up
    // costs the user nothing they can still use.
    expect(starred.claude).toEqual(["weekly", "fable"]);
  });
});
