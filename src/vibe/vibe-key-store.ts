/**
 * API keys for the vendors that have no CLI to borrow a login from.
 *
 * OpenRouter and Z.ai are not signed in on this machine by anything — the user
 * pastes a key. That makes this file a credential, so unlike `vibe.json` it is
 * written 0600 and never leaves the process: `GET /api/vibe/status` reports
 * only whether a key is present, never the key.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { SettingsValidationError } from "../settings.ts";
import { getVibeProvider } from "./vibe-catalog.ts";

/** Vendors that authenticate with a user-supplied key rather than a CLI login. */
export const VIBE_KEY_PROVIDERS = ["openrouter", "zai"] as const;

/**
 * Env vars each vendor's own tooling already uses. A key in the environment
 * wins over nothing else — the stored key takes precedence, so pasting one in
 * the console can override a shell export the service inherited at boot.
 */
const ENV_KEYS: Record<string, readonly string[]> = {
  openrouter: ["OPENROUTER_API_KEY"],
  zai: ["ZAI_API_KEY", "Z_AI_API_KEY", "ZHIPUAI_API_KEY"],
};

const MAX_KEY_LENGTH = 512;

export class VibeKeyStore {
  private keys: Record<string, string> = {};
  private lastSaved: string | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly env: Record<string, string | undefined> = process.env) {}

  async load(): Promise<void> {
    try {
      const record = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
      const stored = typeof record.keys === "object" && record.keys !== null
        ? record.keys as Record<string, unknown>
        : {};
      const restored: Record<string, string> = {};
      for (const [providerId, value] of Object.entries(stored)) {
        if (!isKeyProvider(providerId) || typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed !== "" && trimmed.length <= MAX_KEY_LENGTH) restored[providerId] = trimmed;
      }
      this.keys = restored;
      this.lastSaved = JSON.stringify(restored);
    } catch {
      // Missing or corrupt: start empty. A key the user has to re-paste beats
      // a service that will not boot.
      this.keys = {};
      this.lastSaved = null;
    }
  }

  /** The key to use for a vendor: stored first, then the vendor's own env var. */
  resolve(providerId: string): string | null {
    const stored = this.keys[providerId];
    if (stored !== undefined) return stored;
    for (const name of ENV_KEYS[providerId] ?? []) {
      const value = this.env[name]?.trim();
      if (value) return value;
    }
    return null;
  }

  /** What the console may know: which vendors have a key, and where from. */
  status(): Record<string, "stored" | "environment" | "unset"> {
    const status: Record<string, "stored" | "environment" | "unset"> = {};
    for (const providerId of VIBE_KEY_PROVIDERS) {
      status[providerId] = this.keys[providerId] !== undefined
        ? "stored"
        : this.resolve(providerId) !== null ? "environment" : "unset";
    }
    return status;
  }

  /** Stores a key, or clears it when `key` is null/empty. */
  async set(providerId: string, key: string | null): Promise<void> {
    if (!isKeyProvider(providerId)) {
      throw new SettingsValidationError(`${providerId} does not take an API key`);
    }
    const trimmed = key?.trim() ?? "";
    if (trimmed.length > MAX_KEY_LENGTH) {
      throw new SettingsValidationError("API key is too long");
    }
    if (trimmed === "") delete this.keys[providerId];
    else this.keys[providerId] = trimmed;
    this.save();
  }

  /** Test seam: resolves once every queued write has landed. */
  async settled(): Promise<void> {
    await this.writing;
  }

  private save(): void {
    const signature = JSON.stringify(this.keys);
    if (signature === this.lastSaved) return;
    const snapshot = { ...this.keys };
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify({ version: 1, keys: snapshot }, null, 2)}\n`, { mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, this.path);
        await chmod(this.path, 0o600);
        // Stamped only once the bytes are on disk: marking it before the write
        // would make a failed save look done and skip every retry after it.
        this.lastSaved = signature;
      } catch {
        // A full disk must not fail the request that set the key; the key stays
        // live in memory and the next save retries.
      }
    });
  }
}

function isKeyProvider(providerId: string): boolean {
  return (VIBE_KEY_PROVIDERS as readonly string[]).includes(providerId) && getVibeProvider(providerId) !== undefined;
}
