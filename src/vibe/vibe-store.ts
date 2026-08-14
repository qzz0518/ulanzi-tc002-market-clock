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
 * Which metrics each provider pins, on disk.
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
      this.lastSaved = signature(restored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A star list is not worth refusing to boot over; the defaults are
        // right for a fresh install anyway and the next click overwrites.
        this.starred = {};
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

  /** Resolves once every queued write has landed. A test seam. */
  async settled(): Promise<void> {
    await this.writing;
  }

  private save(): void {
    const next = signature(this.starred);
    if (next === this.lastSaved) return;
    this.lastSaved = next;
    const snapshot = structuredClone(this.starred);
    this.writing = this.writing.then(() => this.write(snapshot)).catch(() => {
      this.lastSaved = null;
    });
  }

  private async write(starred: Record<string, string[]>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, starred }, null, 2)}\n`);
    await rename(temporaryPath, this.path);
  }
}

function isMetricKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_METRIC_KEY_LENGTH
    && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
}

function signature(starred: Record<string, string[]>): string {
  return Object.keys(starred)
    .sort()
    .map((providerId) => `${providerId}=${starred[providerId]!.join(",")}`)
    .join("\t");
}
