import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * THE APPS THIS SERVICE STILL OWES THE DEVICE A DELETE FOR.
 *
 * Disabling or renaming a channel makes its Custom App an orphan: the pixels
 * stay on the clock and the name stays on the knob, one entry the user can turn
 * to that nothing will ever refresh again. `saveWorkspace` deletes it right
 * away, and when that write fails the appName lands in `cleanupErrors`, which
 * `retryCleanup` drains on every `pushDue` (with a ≤60 s wake so it does not
 * wait out a slow channel's interval).
 *
 * That retry loop only ever existed in memory, and the failure it retries is
 * not the rare case. On the machine this runs on the service is started by
 * launchd, which has no macOS local-network permission, so every device write
 * goes through a loopback proxy; when the clock is asleep, off, or the proxy is
 * not up yet, the DELETE fails. A restart in that window — and a restart is
 * routine here, since every web/ change needs `bun start` again — dropped the
 * whole list on the floor. Nothing retried it afterwards, because the workspace
 * no longer mentions those channels at all: the only record that they had ever
 * been on the device was the one that just went away.
 *
 * The consequence is cosmetic, not data loss, which is exactly why it survived
 * so long: a stale entry on the knob looks like something the user forgot to
 * clean up rather than something the service forgot to do.
 *
 * WHY THE ERROR STRINGS AND NOT JUST THE NAMES. `cleanupErrors` is a
 * Record<appName, message> and both halves are load-bearing: the message is
 * what `/api/state` shows and what makes `degraded` explicable rather than a
 * bare boolean. Persisting only the keys would resume a list of names with no
 * account of why they are on it, and the first thing the console would show
 * after a restart is "something is wrong" with nothing to say about what.
 *
 * Three mechanics are inherited from OsSleepRequestStore and LyricThemeStore,
 * for the reasons their headers give: an atomic temp-then-rename, a CHAINED
 * write queue so two saves cannot race their renames, and a lastSaved
 * comparison so an unchanged list does not rewrite the file. 0600 is not used:
 * an app name is not a credential.
 */
export class AppCleanupStore {
  private lastSaved: string | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    // Injected rather than console.log'd so the service's JSON log format stays
    // in one place. A store that cannot read or write is otherwise invisible.
    private readonly onWarn: (event: string, details: Record<string, unknown>) => void = () => {},
  ) {}

  /**
   * The apps still owed a delete, or an empty record when there is nothing to
   * resume.
   *
   * Never throws. This runs before Bun.serve, and refusing to boot over a list
   * of names whose only consequence is a stale menu entry would be a far worse
   * failure than the one being fixed. An empty record is the honest answer for
   * every bad case — no file yet, a truncated file, a file someone hand-edited
   * into something that is not an object of strings — and it lands the
   * controller exactly where it is today.
   */
  async load(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const pending: Record<string, string> = {};
      for (const [appName, message] of Object.entries(parsed as Record<string, unknown>)) {
        // Validated on the way in, not just on the way out: this list feeds a
        // DELETE addressed by name, and the device's route takes whatever it is
        // given. The pattern is the same one clock-client enforces before any
        // write, so a hand-mangled file cannot widen it.
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(appName)) continue;
        pending[appName] = typeof message === "string" ? message : "pending cleanup";
      }
      this.lastSaved = JSON.stringify(pending);
      return pending;
    } catch (error) {
      this.onWarn("app_cleanup_load_failed", { path: this.path, error: String(error) });
      return {};
    }
  }

  /**
   * Records the current list. Awaited by nobody on the hot path — a push must
   * not wait on a disk write to a file whose whole job is to survive a restart
   * — so failures are logged rather than thrown.
   */
  save(pending: Record<string, string>): Promise<void> {
    const serialized = JSON.stringify(pending);
    if (serialized === this.lastSaved) return Promise.resolve();
    this.lastSaved = serialized;
    const next = this.writing.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, `${serialized}\n`, "utf8");
        await rename(temporary, this.path);
      } catch (error) {
        // Forget what we thought was on disk, so the next save tries again
        // rather than short-circuiting against a file that was never written.
        this.lastSaved = null;
        this.onWarn("app_cleanup_save_failed", { path: this.path, error: String(error) });
      }
    });
    this.writing = next;
    return next;
  }
}
