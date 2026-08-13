import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  OS_SLEEP_MAX_IDLE_SEC,
  OS_SLEEP_MAX_MINUTE,
  OS_SLEEP_MIN_IDLE_SEC,
  type OsSleepRequestSnapshot,
} from "./os-link.ts";

/**
 * WHAT THE CONSOLE LAST ASKED FOR about 夜间息屏 — deliberately not "the setting".
 *
 * The DEVICE owns the setting. ZOS writes its SleepConfig to prefs on /data, so
 * the effective window survives a power cycle and even a reflash, and the 设置
 * rows are a second writer the service cannot see. What is written here is only
 * the console's side of that conversation: the four optional fields it has named
 * so far, plus the sequence they were named at.
 *
 * THE SEQUENCE IS THE POINT. The firmware applies a request only when its
 * sequence EXCEEDS the last one it applied (tcos::applySleepRequest), which is
 * the same rising-edge discipline volume and brightness use and exists so the
 * knob wins afterwards and so a reboot does not replay a stale console write.
 * OsLinkHub kept that counter in module memory, so every `bun start` — routine,
 * since every web/ change needs a rebuild — put it back at 0 while the device
 * was still up holding, say, 5. The console's next change shipped seq 1, the
 * device correctly refused it, the route still answered 200, and the user had to
 * make six changes before one took. Nothing logged anything. The device's
 * applied sequence is not in telemetry either, so it cannot be asked for: the
 * only way to keep the counter monotonic across a restart is to write it down.
 *
 * THE WHOLE REQUEST, NOT JUST THE SEQUENCE, even though the sequence alone is
 * what the device gates on. The state document is PULLED, not pushed, so a field
 * the device has not polled yet has to still be in it — which is why setSleep()
 * keeps re-emitting every field ever named. Persisting the counter while
 * dropping the fields would leave a document that says `sleepseq 5` and names
 * nothing: a device that had not yet read seq 5 would then spend that sequence
 * on an empty request, adopt nothing, and the write would be lost for good with
 * no number left to carry it. Keeping both makes the restart invisible instead —
 * the device is served the same bytes it was served before, so it has nothing to
 * apply — and it is also what stops /api/os/state's `requestedSleep` from
 * claiming the console has never asked for anything.
 *
 * Three mechanics are inherited from LyricThemeStore, for the same reasons its
 * header gives: an atomic temp-then-rename, a CHAINED write queue (two saves in
 * flight race their renames and the last to land is not the last one asked for),
 * and a lastSaved comparison so a save that would not change the file does not
 * write at all. 0600 is not used: a bedtime is not a credential.
 */
export class OsSleepRequestStore {
  // What is already on disk, so a repeated save does not rewrite it. Every
  // setSleep() raises the sequence, so in practice each one really does need a
  // write; this guards the paths that re-save an unchanged snapshot.
  private lastSaved: string | null = null;
  // Chained, not fired in parallel: each write has its own tmp name, so two in
  // flight both succeed and whichever rename lands last wins — which is not
  // whichever the user asked for last. Losing that race here would leave the
  // LOWER sequence on disk, i.e. exactly the bug this file exists to prevent.
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    // Injected rather than console.log'd so the service's JSON log format stays
    // in one place. A store that cannot read or write is invisible otherwise:
    // its only symptom is a device silently ignoring a change, months later.
    private readonly onWarn: (event: string, details: Record<string, unknown>) => void = () => {},
  ) {}

  /**
   * The console's last request, or null when there is nothing usable to resume.
   *
   * Never throws. This runs before Bun.serve, and a service that refuses to boot
   * over a bedtime file would be a far worse failure than the one being fixed.
   * Null is the honest answer for all three bad cases — no file yet, a truncated
   * or hand-mangled file, a file whose sequence is missing — and it lands the
   * hub exactly where it is today, with the firmware's own "a lower sequence
   * means the counter restarted" tolerance as the remaining safety net.
   */
  async load(): Promise<OsSleepRequestSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; // first run
      this.onWarn("os_sleep_request_unreadable", {
        path: this.path,
        reason: (error as Error).message,
      });
      return null;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      // A half-written file cannot happen through save() — the rename is atomic —
      // so reaching here means something outside this process wrote the path.
      this.onWarn("os_sleep_request_unreadable", {
        path: this.path,
        reason: (error as Error).message,
      });
      return null;
    }
    if (record === null || typeof record !== "object") {
      this.onWarn("os_sleep_request_unreadable", { path: this.path, reason: "not an object" });
      return null;
    }
    // Field by field, and every unrecognised key ignored: a file written by a
    // later version that grew a fifth field must still hand this one its four,
    // rather than being refused wholesale over a `version` it does not know.
    const seq = readInteger(record.seq, 0, Number.MAX_SAFE_INTEGER);
    if (seq === null) {
      // The fields without the sequence are worse than nothing: they would be
      // re-emitted under a counter that starts at 0, which is a request the
      // device is guaranteed to refuse.
      this.onWarn("os_sleep_request_unreadable", { path: this.path, reason: "no usable seq" });
      return null;
    }
    const snapshot: OsSleepRequestSnapshot = {
      seq,
      enabled: typeof record.enabled === "boolean" ? record.enabled : null,
      // Out of range is DROPPED, not clamped. A clamp would invent a request the
      // user never made; null means "the console has never named this", the
      // field is then never emitted, and the device keeps whatever its own 设置
      // rows hold — the safe direction, because the device is the authority.
      startMin: readInteger(record.startMin, 0, OS_SLEEP_MAX_MINUTE),
      endMin: readInteger(record.endMin, 0, OS_SLEEP_MAX_MINUTE),
      idleSec: readInteger(record.idleSec, OS_SLEEP_MIN_IDLE_SEC, OS_SLEEP_MAX_IDLE_SEC),
    };
    // Only what was actually read counts as "already saved", so a file missing a
    // field does not stop the first write from adding it.
    this.lastSaved = signature(snapshot);
    return snapshot;
  }

  /**
   * Fire and forget, by design: a bedtime must not fail on a full disk, and the
   * caller is a hub reached from a request handler that has already answered.
   */
  save(request: OsSleepRequestSnapshot): void {
    const next = signature(request);
    if (next === this.lastSaved) return;
    this.lastSaved = next;
    const snapshot: OsSleepRequestSnapshot = { ...request };
    this.writing = this.writing.then(() => this.write(snapshot)).catch((error) => {
      // Cleared so the next request retries rather than being skipped as
      // "already saved", and warned because a store that stopped writing is a
      // sequence that will not survive the next restart.
      this.lastSaved = null;
      this.onWarn("os_sleep_request_write_failed", {
        path: this.path,
        reason: (error as Error).message,
      });
    });
  }

  /** Resolves once every queued write has landed. A test seam. */
  async settled(): Promise<void> {
    await this.writing;
  }

  private async write(request: OsSleepRequestSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Rename over a unique tmp name, so a reader never sees half a file and two
    // processes pointed at one path cannot take each other's temporary.
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, ...request }, null, 2)}\n`);
    await rename(temporaryPath, this.path);
  }
}

function readInteger(value: unknown, low: number, high: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded < low || rounded > high ? null : rounded;
}

function signature(request: OsSleepRequestSnapshot): string {
  return [
    request.seq,
    request.enabled === null ? "-" : request.enabled ? "1" : "0",
    request.startMin ?? "-",
    request.endMin ?? "-",
    request.idleSec ?? "-",
  ].join("\t");
}
