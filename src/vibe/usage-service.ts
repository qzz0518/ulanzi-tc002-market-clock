/**
 * Collects AI-coding-agent quota from every vendor this machine is signed into.
 *
 * This is the whole data layer for VIBE: it builds one adapter context, probes
 * each vendor for a credential, fetches the ones that have one **in parallel**,
 * and folds the results into a single snapshot. Failure is per vendor — one
 * dead endpoint costs that vendor's page, never the panel.
 *
 * Two rules from the market path are reproduced deliberately:
 *
 * - **Never fabricate.** A vendor with no credential is silently absent (a
 *   state, not an error). A vendor that failed keeps its last good values for
 *   VIBE_PROVIDER_STALE_MS and is flagged `stale`; past that it disappears and
 *   only the error remains.
 * - **Never hammer.** A 429 parks that vendor until its Retry-After passes; the
 *   cooldown is per vendor, so a rate-limited Claude does not stop Codex.
 */

import { VIBE_CATALOG, getVibeProvider } from "./vibe-catalog.ts";
import { VIBE_ADAPTERS } from "./providers/index.ts";
import {
  VibeCredentialsExpiredError,
  VibeCredentialsMissingError,
  VibeRateLimitedError,
  VibeRequestError,
  type FetchLike,
  type KeychainReader,
  type VibeAdapterContext,
  type VibeMetric,
  type VibeProviderAdapter,
  type VibeSpendLine,
} from "./providers/types.ts";
import { EmptyKeychain, SecurityKeychain } from "./providers/keychain.ts";

export type { VibeMetric, VibeSpendLine } from "./providers/types.ts";

export interface VibeProviderUsage {
  id: string;
  displayName: string;
  plan?: string;
  /** When these numbers were read from the vendor. */
  fetchedAt: string;
  /** True when the vendor refused this round and we are serving last-good. */
  stale: boolean;
  /** A non-fatal vendor note, e.g. "re-login to restore live limits". */
  note?: string;
  /** Catalog primary-metric order first; anything else keeps adapter order behind it. */
  metrics: VibeMetric[];
  spendLines: VibeSpendLine[];
}

export interface VibeUsageSnapshot {
  /** When this service ran the collection. */
  fetchedAt: string;
  /** Kept equal to fetchedAt: with no upstream app there is no second clock. */
  generatedAt: string;
  /** Catalog order; a vendor with no credential simply does not appear. */
  providers: VibeProviderUsage[];
  errors: { providerId: string; message: string }[];
}

/** The snapshot plus the starred table, already merged with the catalog defaults. */
export interface VibeUsageView {
  snapshot: VibeUsageSnapshot;
  starred: Record<string, string[]>;
}

/**
 * Thrown when not one vendor could be reached AND nothing is cached — i.e. the
 * machine is offline or signed out everywhere. Renderers catch it and draw the
 * offline panel the way the weather content draws 未配置, instead of turning
 * the channel red.
 */
export class VibeUnavailableError extends Error {
  constructor(message = "no AI usage source is available") {
    super(message);
    this.name = "VibeUnavailableError";
  }
}

/** How long a vendor's last-good values may stand in after a failed refresh. */
const PROVIDER_STALE_MS = 15 * 60_000;
/** Per-vendor request ceiling. Four of these run concurrently. */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Ceiling on a whole vendor round, not just one request.
 *
 * Some adapters make several calls (a token refresh, then usage, then a plan
 * lookup), so the per-request timeout alone lets a degraded
 * vendor hold the collection — and with it a channel render — for minutes. The
 * device expects a frame long before that, so the vendor is dropped instead.
 */
const ADAPTER_DEADLINE_MS = 20_000;

/** How long a rejected credential is left alone before we try it again. */
const EXPIRED_COOLDOWN_MS = 30 * 60_000;

export interface VibeUsageServiceOptions {
  adapters?: readonly VibeProviderAdapter[];
  fetcher?: FetchLike;
  keychain?: KeychainReader;
  env?: Record<string, string | undefined>;
  now?: () => number;
  timeoutMs?: number;
  /** Resolves a stored user API key for the key-based vendors. */
  apiKey?: (providerId: string) => string | null;
  /** Whole-round ceiling per vendor; the tests shorten it. */
  deadlineMs?: number;
  readTextFile?: (path: string) => Promise<string | null>;
  writeTextFile?: (path: string, content: string) => Promise<void>;
  listDirectory?: (path: string) => Promise<string[]>;
}

interface CachedProvider {
  usage: VibeProviderUsage;
  atMs: number;
}

export class VibeUsageService {
  private readonly adapters: readonly VibeProviderAdapter[];
  private readonly options: VibeUsageServiceOptions;
  private readonly now: () => number;
  private readonly lastGood = new Map<string, CachedProvider>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly cooldownReason = new Map<string, string>();

  constructor(options: VibeUsageServiceOptions = {}) {
    this.adapters = options.adapters ?? VIBE_ADAPTERS;
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Forgets every per-vendor cooldown.
   *
   * The console's 刷新 means "try again now". Without this a vendor parked for
   * thirty minutes stayed parked even after the user had gone and repaired the
   * very thing it was parked for — and the panel kept reporting the old reason,
   * which reads as the repair having failed.
   */
  clearCooldowns(): void {
    this.cooldownUntil.clear();
    this.cooldownReason.clear();
  }

  /** Which vendors have a credential on this machine — the first-run probe. */
  async detectProviders(): Promise<string[]> {
    const context = this.buildContext();
    const detected = await Promise.all(this.adapters.map(async (adapter) => {
      try {
        return await adapter.detect(context) ? adapter.id : undefined;
      } catch {
        // A probe that throws (unreadable keychain) is "not installed" for the
        // purposes of enablement; the real error surfaces on the first fetch.
        return undefined;
      }
    }));
    return detected.filter((id): id is string => id !== undefined);
  }

  async fetchSnapshot(): Promise<VibeUsageSnapshot> {
    const context = this.buildContext();
    const nowMs = this.now();
    const fetchedAt = new Date(nowMs).toISOString();
    const errors: { providerId: string; message: string }[] = [];

    const collected = await Promise.all(this.adapters.map(
      async (adapter) => await this.collect(adapter, context, nowMs, errors),
    ));

    const byId = new Map<string, VibeProviderUsage>();
    for (const usage of collected) if (usage) byId.set(usage.id, usage);

    // Catalog order, so the console list and the knob pages never disagree.
    const providers = VIBE_CATALOG
      .map((entry) => byId.get(entry.id))
      .filter((usage): usage is VibeProviderUsage => usage !== undefined);

    if (providers.length === 0 && errors.length === 0) {
      throw new VibeUnavailableError("no AI coding agent is signed in on this machine");
    }
    return { fetchedAt, generatedAt: fetchedAt, providers, errors };
  }

  private async collect(
    adapter: VibeProviderAdapter,
    context: VibeAdapterContext,
    nowMs: number,
    errors: { providerId: string; message: string }[],
  ): Promise<VibeProviderUsage | undefined> {
    const cooldown = this.cooldownUntil.get(adapter.id);
    if (cooldown !== undefined && cooldown > nowMs) {
      // Still parked. Keep saying why: without this the vendor would first look
      // stale, then — once last-good expires — indistinguishable from one that
      // was never signed in, which is a different thing entirely.
      const reason = this.cooldownReason.get(adapter.id);
      if (reason !== undefined) errors.push({ providerId: adapter.id, message: reason });
      return this.servedFromCache(adapter.id, nowMs);
    }

    try {
      let detected: boolean;
      try {
        detected = await adapter.detect(context);
      } catch (error) {
        // A probe that throws is not "no credential" — a locked keychain must
        // not look like a logout, or last-good would be dropped for a state
        // that may clear on its own in seconds.
        errors.push({ providerId: adapter.id, message: describe(error) });
        return this.servedFromCache(adapter.id, nowMs);
      }
      if (!detected) {
        // Not signed in: a state, not an error. Drop any stale cache so a
        // logout does not keep yesterday's numbers on the panel.
        this.lastGood.delete(adapter.id);
        return undefined;
      }
      const result = await withDeadline(
        adapter.fetchUsage(context),
        this.options.deadlineMs ?? ADAPTER_DEADLINE_MS,
        () => new VibeRequestError(adapter.id, "collection exceeded its deadline"),
      );
      const usage: VibeProviderUsage = {
        id: adapter.id,
        displayName: adapter.displayName,
        plan: result.plan,
        fetchedAt: new Date(nowMs).toISOString(),
        stale: false,
        note: result.note,
        metrics: orderMetrics(adapter.id, result.metrics),
        spendLines: result.spendLines ?? [],
      };
      this.lastGood.set(adapter.id, { usage, atMs: nowMs });
      this.cooldownUntil.delete(adapter.id);
      this.cooldownReason.delete(adapter.id);
      return usage;
    } catch (error) {
      if (error instanceof VibeCredentialsMissingError) {
        this.lastGood.delete(adapter.id);
        return undefined;
      }
      const message = describe(error);
      if (error instanceof VibeRateLimitedError) {
        // Default to the vendor's own five-minute window when it did not say.
        // A zero or negative Retry-After is a header we cannot use, not "now".
        const retry = error.retryAfterMs !== undefined && error.retryAfterMs > 0
          ? error.retryAfterMs
          : 5 * 60_000;
        this.park(adapter.id, nowMs + retry, message);
      } else if (error instanceof VibeCredentialsExpiredError) {
        // Retrying a rejected credential every round spends a refresh token per
        // round for a login only the user can repair.
        this.park(adapter.id, nowMs + EXPIRED_COOLDOWN_MS, message);
      }
      errors.push({ providerId: adapter.id, message });
      return this.servedFromCache(adapter.id, nowMs);
    }
  }

  private park(providerId: string, untilMs: number, reason: string): void {
    this.cooldownUntil.set(providerId, untilMs);
    this.cooldownReason.set(providerId, reason);
  }

  private servedFromCache(providerId: string, nowMs: number): VibeProviderUsage | undefined {
    const cached = this.lastGood.get(providerId);
    if (!cached) return undefined;
    if (nowMs - cached.atMs >= PROVIDER_STALE_MS) {
      // Past this nobody can say when the figure was true, so it goes.
      this.lastGood.delete(providerId);
      return undefined;
    }
    return { ...cached.usage, stale: true };
  }

  private buildContext(): VibeAdapterContext {
    const env = this.options.env ?? process.env;
    return {
      now: this.now,
      fetch: this.options.fetcher ?? ((input, init) => fetch(input, init)),
      env,
      keychain: this.options.keychain ?? (process.platform === "darwin"
        ? new SecurityKeychain(env.USER?.trim() || undefined)
        : new EmptyKeychain()),
      readTextFile: this.options.readTextFile ?? readTextFile,
      writeTextFile: this.options.writeTextFile ?? writeTextFile,
      listDirectory: this.options.listDirectory ?? listDirectory,
      apiKey: (providerId) => this.options.apiKey?.(providerId) ?? null,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }
}

/** Catalog primaries first, then whatever else the adapter reported. */
function orderMetrics(providerId: string, metrics: VibeMetric[]): VibeMetric[] {
  const order = getVibeProvider(providerId)?.percentKeys ?? [];
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...metrics].sort((left, right) => {
    const a = rank.get(left.key) ?? Number.MAX_SAFE_INTEGER;
    const b = rank.get(right.key) ?? Number.MAX_SAFE_INTEGER;
    return a - b;
  });
}

/** Bounds a whole vendor round, whatever it does internally. */
async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  // Deliberately NOT flattened to a fixed "sign-in expired": the adapters put
  // the HTTP status in the message, and that is the difference between a
  // credential the vendor rejected and one this process never got to use.
  return error instanceof Error ? error.message : String(error);
}

async function readTextFile(path: string): Promise<string | null> {
  const expanded = expandHome(path);
  const file = Bun.file(expanded);
  return await file.exists() ? await file.text() : null;
}

/** Atomic + 0600: a half-written credential file would lock the user out. */
async function writeTextFile(path: string, content: string): Promise<void> {
  const { chmod, mkdir, rename, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const target = expandHome(path);
  await mkdir(dirname(target), { recursive: true });
  const temporaryPath = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, target);
  await chmod(target, 0o600);
}

async function listDirectory(path: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(expandHome(path));
  } catch {
    return [];
  }
}

/** Only a leading `~` expands — a literal `~foo` is a real relative path. */
function expandHome(path: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = process.env.HOME ?? "";
  return path === "~" ? home : `${home}/${path.slice(1)}`;
}
