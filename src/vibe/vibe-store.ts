import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SettingsValidationError } from "../settings.ts";
import { defaultVibeStarred, getVibeProvider } from "./vibe-catalog.ts";

// OpenUsage caps the menu-bar strip at two pins per provider ("Up to 2 stars
// per provider"), and the LED格 is built for exactly that: two 3x5 rows or one
// 5x7 row. A third star would have nowhere to go.
const MAX_STARRED_PER_PROVIDER = 2;
const MAX_METRIC_KEY_LENGTH = 32;

/**
 * How long the panel's VIBE app holds a page before turning itself.
 *
 * Seconds rather than the ms this codebase otherwise uses for durations,
 * because this number crosses the `KEY\tVALUE` link to the firmware unchanged
 * (`vibeauto`), the way `sleepidle` does. 0 — the default, and what the app did
 * before this existed — means the knob is the only thing that turns the ring.
 */
export const VIBE_PAGE_INTERVAL_OFF = 0;
export const VIBE_MIN_PAGE_INTERVAL_SEC = 5;
export const VIBE_MAX_PAGE_INTERVAL_SEC = 300;

/**
 * How long each half of a metric row's value cell holds, in milliseconds.
 *
 * Milliseconds and not seconds: the shipped 3200/1600 have no whole-second
 * rounding that keeps the layout. 0 is legal for the countdown half alone and
 * means the cell never leaves the number.
 */
export const VIBE_MIN_CELL_DWELL_MS = 500;
export const VIBE_MAX_CELL_DWELL_MS = 20_000;
export const VIBE_DEFAULT_VALUE_DWELL_MS = 3_200;
export const VIBE_DEFAULT_RESET_DWELL_MS = 1_600;

export interface VibeCellDwell {
  valueMs: number;
  resetMs: number;
}

/**
 * What the user set for 「VIBE」 on disk: which metrics each provider pins, and
 * how long the panel holds a page before turning itself.
 *
 * Same shape as LyricThemeStore and for the same reasons: a unique tmp name so
 * two processes on one path cannot take each other's temporary, writes chained
 * so two renames cannot land out of order, a signature so a save that would
 * change nothing does not touch the disk, and a corrupt file tolerated rather
 * than fatal. 0600 is deliberately not used — a list of metric names is a
 * preference, not a credential.
 */
export class VibeStore {
  private starred: Record<string, string[]> = {};
  private pageIntervalSec = VIBE_PAGE_INTERVAL_OFF;
  private cellDwell: VibeCellDwell = {
    valueMs: VIBE_DEFAULT_VALUE_DWELL_MS,
    resetMs: VIBE_DEFAULT_RESET_DWELL_MS,
  };
  private lastSaved: string | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<Record<string, string[]>> {
    try {
      const record = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
      const starred = typeof record.starred === "object" && record.starred !== null
        ? record.starred as Record<string, unknown>
        : {};
      const restored: Record<string, string[]> = {};
      for (const [providerId, keys] of Object.entries(starred)) {
        if (!getVibeProvider(providerId) || !Array.isArray(keys)) continue;
        const valid = [...new Set(keys.filter(isMetricKey))].slice(0, MAX_STARRED_PER_PROVIDER);
        restored[providerId] = valid;
      }
      this.starred = restored;
      // Dropped to 0 rather than floored up, the same way a metric key this file
      // cannot read is dropped rather than repaired: a value nobody can make
      // sense of must not become a clock that starts turning its own pages.
      this.pageIntervalSec = isPageInterval(record.pageIntervalSec)
        ? record.pageIntervalSec
        : VIBE_PAGE_INTERVAL_OFF;
      // Each half falls back on its own: a file that names one and mangles the
      // other should keep the half it got right.
      this.cellDwell = {
        valueMs: isCellDwell(record.valueDwellMs, false)
          ? record.valueDwellMs
          : VIBE_DEFAULT_VALUE_DWELL_MS,
        resetMs: isCellDwell(record.resetDwellMs, true)
          ? record.resetDwellMs
          : VIBE_DEFAULT_RESET_DWELL_MS,
      };
      this.lastSaved = signature(restored, this.pageIntervalSec, this.cellDwell);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A star list is not worth refusing to boot over; the defaults are
        // right for a fresh install anyway and the next click overwrites.
        this.starred = {};
        this.pageIntervalSec = VIBE_PAGE_INTERVAL_OFF;
        this.cellDwell = {
          valueMs: VIBE_DEFAULT_VALUE_DWELL_MS,
          resetMs: VIBE_DEFAULT_RESET_DWELL_MS,
        };
      }
    }
    return this.getStarred();
  }

  /** The complete table: catalog defaults, overridden per provider by what the user pinned. */
  getStarred(): Record<string, string[]> {
    const merged = defaultVibeStarred();
    for (const [providerId, keys] of Object.entries(this.starred)) {
      merged[providerId] = [...keys];
    }
    return merged;
  }

  setStarred(providerId: string, keys: unknown): Record<string, string[]> {
    if (!getVibeProvider(providerId)) {
      throw new SettingsValidationError(`unknown vibe provider: ${providerId}`);
    }
    if (!Array.isArray(keys)) {
      throw new SettingsValidationError("starred must be an array of metric keys");
    }
    // No whitelist against the catalog: upstream ships new resources before we
    // do, and a star on one of those must survive the version gap. The shape
    // check is what keeps arbitrary strings out of the file.
    if (!keys.every(isMetricKey)) {
      throw new SettingsValidationError("starred metric keys are invalid");
    }
    const unique = [...new Set(keys as string[])];
    if (unique.length > MAX_STARRED_PER_PROVIDER) {
      throw new SettingsValidationError(
        `at most ${MAX_STARRED_PER_PROVIDER} starred metrics per provider`,
      );
    }
    this.starred = { ...this.starred, [providerId]: unique };
    this.save();
    return this.getStarred();
  }

  /** 0 = the knob is the only thing that turns the VIBE ring. */
  getPageIntervalSec(): number {
    return this.pageIntervalSec;
  }

  /**
   * Rejects rather than clamps, unlike the hub: this is the write path a person
   * drove, and silently storing 5 when they asked for 2 is the console lying
   * about what it saved.
   */
  setPageIntervalSec(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new SettingsValidationError("pageIntervalSec must be an integer number of seconds");
    }
    if (
      value !== VIBE_PAGE_INTERVAL_OFF
      && (value < VIBE_MIN_PAGE_INTERVAL_SEC || value > VIBE_MAX_PAGE_INTERVAL_SEC)
    ) {
      throw new SettingsValidationError(
        `pageIntervalSec must be 0 or between ${VIBE_MIN_PAGE_INTERVAL_SEC} and ${VIBE_MAX_PAGE_INTERVAL_SEC}`,
      );
    }
    this.pageIntervalSec = value;
    this.save();
    return this.pageIntervalSec;
  }

  /** How the panel splits a metric row's value cell, in ms. */
  getCellDwell(): VibeCellDwell {
    return { ...this.cellDwell };
  }

  /**
   * A partial write: naming one half must not overwrite the other, the way the
   * sleep route's field-withholding PUT works. Rejects out of range rather than
   * clamping, for the same reason the page interval does.
   */
  setCellDwell(patch: { valueMs?: unknown; resetMs?: unknown }): VibeCellDwell {
    const next = { ...this.cellDwell };
    if (patch.valueMs !== undefined) {
      next.valueMs = validateDwell(patch.valueMs, "valueDwellMs", false);
    }
    if (patch.resetMs !== undefined) {
      next.resetMs = validateDwell(patch.resetMs, "resetDwellMs", true);
    }
    this.cellDwell = next;
    this.save();
    return this.getCellDwell();
  }

  /** Resolves once every queued write has landed. A test seam. */
  async settled(): Promise<void> {
    await this.writing;
  }

  private save(): void {
    const next = signature(this.starred, this.pageIntervalSec, this.cellDwell);
    if (next === this.lastSaved) return;
    this.lastSaved = next;
    const snapshot = structuredClone(this.starred);
    const interval = this.pageIntervalSec;
    const dwell = { ...this.cellDwell };
    this.writing = this.writing.then(() => this.write(snapshot, interval, dwell)).catch(() => {
      this.lastSaved = null;
    });
  }

  private async write(
    starred: Record<string, string[]>,
    pageIntervalSec: number,
    cellDwell: VibeCellDwell,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    // Defaults stay OUT of the file, the way an untouched provider's stars do:
    // the file holds what the user changed, so a future default can still reach
    // an install that never opened these controls.
    const payload: Record<string, unknown> = { version: 1, starred };
    if (pageIntervalSec !== VIBE_PAGE_INTERVAL_OFF) payload.pageIntervalSec = pageIntervalSec;
    if (cellDwell.valueMs !== VIBE_DEFAULT_VALUE_DWELL_MS) payload.valueDwellMs = cellDwell.valueMs;
    if (cellDwell.resetMs !== VIBE_DEFAULT_RESET_DWELL_MS) payload.resetDwellMs = cellDwell.resetMs;
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(temporaryPath, this.path);
  }
}

/**
 * A dwell the user typed. `allowZero` is the countdown half, where 0 means
 * "never show it" — on the value half there is no such state, because a cell
 * that never shows the number is not a row.
 */
function validateDwell(value: unknown, name: string, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SettingsValidationError(`${name} must be an integer number of milliseconds`);
  }
  if (allowZero && value === 0) return 0;
  if (value < VIBE_MIN_CELL_DWELL_MS || value > VIBE_MAX_CELL_DWELL_MS) {
    throw new SettingsValidationError(
      `${name} must be ${allowZero ? "0 or " : ""}between ${VIBE_MIN_CELL_DWELL_MS} and ${VIBE_MAX_CELL_DWELL_MS}`,
    );
  }
  return value;
}

function isCellDwell(value: unknown, allowZero: boolean): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  if (allowZero && value === 0) return true;
  return value >= VIBE_MIN_CELL_DWELL_MS && value <= VIBE_MAX_CELL_DWELL_MS;
}

function isPageInterval(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= VIBE_MIN_PAGE_INTERVAL_SEC
    && value <= VIBE_MAX_PAGE_INTERVAL_SEC;
}

function isMetricKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_METRIC_KEY_LENGTH
    && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
}

function signature(
  starred: Record<string, string[]>,
  pageIntervalSec: number,
  cellDwell: VibeCellDwell,
): string {
  const stars = Object.keys(starred)
    .sort()
    .map((providerId) => `${providerId}=${starred[providerId]!.join(",")}`)
    .join("\t");
  return `${stars}\npage=${pageIntervalSec}\ncell=${cellDwell.valueMs},${cellDwell.resetMs}`;
}
