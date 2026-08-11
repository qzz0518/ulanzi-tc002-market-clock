/**
 * The link between the service and the tc002-os firmware.
 *
 * Replacing the official app deletes its `POST /api/custom` receiver, which is
 * how every host->device write in this project used to work. The direction is
 * therefore inverted: the device pulls. That is not just a workaround — it
 * removes the service's need to know the device's address at all, which is the
 * same class of problem that made the notify webhook fail (a launchd service
 * cannot open a LAN socket on this host).
 *
 * The wire format is line-oriented `KEY\tVALUE`, not JSON. The firmware parses
 * it with a split loop and no allocator pressure; a JSON parser would be another
 * dependency on a device with ~1 MB free, for a document with a dozen fields.
 */

export interface OsMenuEntry {
  /** Stable id the firmware echoes back when the user activates it. */
  id: string;
  /** UTF-8 label as shown on the panel. */
  label: string;
  kind: "channel" | "music" | "game" | "settings";
}

export interface OsDisplayCommand {
  /** Menu entry the firmware should be showing, or null to leave it alone. */
  focus: string | null;
  /** True while the console is driving the panel and the ring is locked. */
  pinned: boolean;
}

export interface OsTelemetry {
  screen: string;
  focus: string;
  wifi: string;
  ip: string;
  uptimeMs: number;
  freeKb: number;
  supplicantRestarts: number;
  receivedAt: number;
}

const MAX_LABEL_CELLS = 24;
const MAX_ENTRIES = 32;

function sanitizeField(value: string): string {
  // Tabs and newlines are the record separators, so they can never appear in a
  // value. Channel names are user-authored and arrive from workspace.json.
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

function clampLabel(value: string): string {
  const cells = Array.from(value);
  if (cells.length <= MAX_LABEL_CELLS) return value;
  // The firmware marquees anything too wide, so this cap only exists to stop a
  // pathological name from bloating every poll response.
  return cells.slice(0, MAX_LABEL_CELLS).join("");
}

interface Waiter {
  resolve: (body: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OsLinkHub {
  private seq = 1;
  private menu: OsMenuEntry[] = [];
  private display: OsDisplayCommand = { focus: null, pinned: false };
  private telemetry: OsTelemetry | null = null;
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  currentSeq(): number {
    return this.seq;
  }

  setMenu(entries: OsMenuEntry[]): void {
    const next = entries.slice(0, MAX_ENTRIES).map((entry) => ({
      id: sanitizeField(entry.id),
      label: clampLabel(sanitizeField(entry.label)),
      kind: entry.kind,
    }));
    if (this.serializeMenu(next) === this.serializeMenu(this.menu)) return;
    this.menu = next;
    this.bump();
  }

  setDisplay(command: OsDisplayCommand): void {
    const focus = command.focus === null ? null : sanitizeField(command.focus);
    if (focus === this.display.focus && command.pinned === this.display.pinned) return;
    this.display = { focus, pinned: command.pinned };
    this.bump();
  }

  getDisplay(): OsDisplayCommand {
    return { ...this.display };
  }

  getMenu(): OsMenuEntry[] {
    return this.menu.map((entry) => ({ ...entry }));
  }

  report(telemetry: Omit<OsTelemetry, "receivedAt">): void {
    // Telemetry never bumps the sequence: it flows device->console, and waking
    // every long poll on it would turn a status heartbeat into a broadcast storm.
    this.telemetry = { ...telemetry, receivedAt: this.now() };
  }

  getTelemetry(): OsTelemetry | null {
    return this.telemetry === null ? null : { ...this.telemetry };
  }

  /** True when a report arrived recently enough to believe. */
  isDeviceLive(withinMs = 15_000): boolean {
    if (this.telemetry === null) return false;
    return this.now() - this.telemetry.receivedAt < withinMs;
  }

  private serializeMenu(entries: OsMenuEntry[]): string {
    return entries.map((e) => `${e.kind}\t${e.id}\t${e.label}`).join("\n");
  }

  serialize(): string {
    const lines: string[] = [];
    lines.push(`seq\t${this.seq}`);
    lines.push(`pinned\t${this.display.pinned ? 1 : 0}`);
    if (this.display.focus !== null) lines.push(`focus\t${this.display.focus}`);
    lines.push(`menu\t${this.menu.length}`);
    for (const entry of this.menu) {
      lines.push(`item\t${entry.kind}\t${entry.id}\t${entry.label}`);
    }
    // A trailing newline lets the firmware treat every record identically
    // instead of special-casing the last one.
    return `${lines.join("\n")}\n`;
  }

  private bump(): void {
    this.seq += 1;
    const body = this.serialize();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(body);
    }
    this.waiters.clear();
  }

  /**
   * Long poll. Resolves immediately when the caller is behind, otherwise parks
   * until something changes or `holdMs` elapses — and then still answers with
   * the current document rather than a 204, so the firmware's parser has exactly
   * one shape to handle and a poll loop that never branches on status.
   */
  waitForChange(sinceSeq: number, holdMs: number): Promise<string> {
    if (!Number.isFinite(sinceSeq) || sinceSeq < this.seq) {
      return Promise.resolve(this.serialize());
    }
    return new Promise<string>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(this.serialize());
        }, holdMs),
      };
      this.waiters.add(waiter);
    });
  }

  /** Releases every parked poll; used when the service shuts down. */
  drain(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.serialize());
    }
    this.waiters.clear();
  }

  pendingWaiters(): number {
    return this.waiters.size;
  }
}
