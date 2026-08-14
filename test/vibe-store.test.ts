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
    expect(starred.copilot).toEqual(["premiumCredits"]);
    expect(starred.grok).toEqual(["weekly"]);
  });

  test("persists one provider's pins without disturbing the other nine", async () => {
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

  test("accepts an unknown metric key but never an unknown provider or a third pin", async () => {
    const store = new VibeStore(await storePath());
    await store.load();
    // Upstream ships new resources before this catalog learns them, so a key we
    // do not know is legal — only its shape is checked.
    expect(store.setStarred("codex", ["gpt6Session"]).codex).toEqual(["gpt6Session"]);
    // Duplicates collapse rather than eating the second slot.
    expect(store.setStarred("codex", ["weekly", "weekly"]).codex).toEqual(["weekly"]);

    expect(() => store.setStarred("chatgpt", ["session"])).toThrow("unknown vibe provider");
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
});
