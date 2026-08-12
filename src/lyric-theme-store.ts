import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  OS_LYRIC_MODES,
  OS_LYRIC_SKINS,
  type OsLyricTheme,
} from "./os-link.ts";

/**
 * The 主题设置 on disk.
 *
 * ADR 0007 makes one store drive both firmwares, and that store is module memory
 * in control-api.ts — which means a `bun start` used to serve spotlight/signal
 * no matter what the user had chosen. That is worse than merely forgetting:
 * ZOS applies the document's theme unconditionally (a theme has no second writer
 * on the device, so there is no sequence to gate on) and then stages it into
 * /data, so one restart repainted the panel green AND destroyed the device-side
 * cache whose entire job is to survive a restart. The only thing left holding
 * the user's choice was the console's localStorage, on whichever browser
 * happened to open the 音乐 page.
 *
 * Three fields, so this is a whole-file rewrite rather than a merge, and 0600 is
 * not used: unlike music-session.json there is no secret here, only a colour.
 */
export class LyricThemeStore {
  // What is already on disk, so a republish that changed nothing does not write.
  // publishLyricTheme() runs on every handler construction and after every
  // control write, and most of those carry the same three values.
  private lastSaved: string | null = null;
  // Writes are CHAINED, not merely fired. Two saves in flight would otherwise
  // race their renames — each has its own tmp name, so both succeed and the last
  // one to land wins, which is not the last one asked for. Observed: a handler
  // constructed on the defaults and a colour chosen a millisecond later left the
  // defaults on disk.
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<Partial<OsLyricTheme> | null> {
    try {
      const record = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
      const theme: Partial<OsLyricTheme> = {};
      if (typeof record.mode === "string" && (OS_LYRIC_MODES as readonly string[]).includes(record.mode)) {
        theme.mode = record.mode as OsLyricTheme["mode"];
      }
      if (typeof record.skin === "string" && (OS_LYRIC_SKINS as readonly string[]).includes(record.skin)) {
        theme.skin = record.skin as OsLyricTheme["skin"];
      }
      if (record.accent === null) theme.accent = null;
      else if (typeof record.accent === "string" && /^[0-9a-fA-F]{6}$/.test(record.accent)) {
        theme.accent = record.accent.toLowerCase();
      }
      // Only what was actually read counts as "already saved": a file missing a
      // field must not stop the first write from adding it.
      this.lastSaved = signature(theme);
      return theme;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A corrupt file is a colour, not a credential. Starting on the defaults
      // and overwriting it on the next click beats refusing to boot.
      return null;
    }
  }

  /**
   * Fire and forget, by design: a colour change must not fail on a full disk,
   * and the caller is a request handler that has already answered. A write that
   * would not change the file is skipped entirely.
   */
  save(theme: OsLyricTheme): void {
    const next = signature(theme);
    if (next === this.lastSaved) return;
    this.lastSaved = next;
    const snapshot: OsLyricTheme = { ...theme };
    this.writing = this.writing.then(() => this.write(snapshot)).catch(() => {
      // Retried by the next change; nothing here is worth failing a request for.
      this.lastSaved = null;
    });
  }

  /** Resolves once every queued write has landed. A test seam. */
  async settled(): Promise<void> {
    await this.writing;
  }

  private async write(theme: OsLyricTheme): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Rename over a unique tmp name, so a reader never sees half a file and two
    // processes pointed at one path cannot take each other's temporary.
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, ...theme }, null, 2)}\n`);
    await rename(temporaryPath, this.path);
  }
}

function signature(theme: Partial<OsLyricTheme>): string {
  return `${theme.mode ?? "-"}\t${theme.skin ?? "-"}\t${theme.accent ?? "-"}`;
}
