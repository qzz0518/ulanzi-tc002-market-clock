/**
 * Holds the usage snapshots an out-of-process collector pushed to us.
 *
 * The four adapters read credentials that only exist on the machine the agent
 * CLIs are logged into: a Keychain item, a file under `~`. When the service
 * runs somewhere else — a container, another host — every adapter correctly
 * reports "not signed in" and the panel goes empty. `src/vibe-agent.ts` is the
 * same collection code compiled to a single binary that runs *there* and POSTs
 * the result here; this store is the receiving end.
 *
 * Three rules, all inherited from the local path rather than invented:
 *
 * - **Never fabricate.** Everything on the wire is validated field by field and
 *   a snapshot that fails is rejected whole. A metric we cannot read is dropped
 *   rather than defaulted, because a zero on this panel reads as "quota gone".
 * - **Never let a corpse linger.** A machine that stops pushing goes `stale`
 *   after STALE_MS and disappears entirely after EXPIRY_MS. An agent that died
 *   at 3am must not still be showing 3am's numbers at noon.
 * - **In memory, on purpose.** Pushed data is perishable and the agent re-sends
 *   within its interval, so a restart shows an empty panel for one interval
 *   instead of replaying a snapshot nobody can vouch for.
 */

import { VIBE_INGEST_SCHEMA } from "./ingest-schema.ts";
import type { VibeMetric, VibeProviderUsage, VibeSpendLine } from "./usage-service.ts";

/** Fresh. Past this the row still shows but is flagged `stale`. */
const STALE_MS = 5 * 60_000;
/** Past this the machine is dropped: nobody can say when the figures were true. */
const EXPIRY_MS = 15 * 60_000;

const MAX_MACHINES = 8;
const MAX_PROVIDERS_PER_PUSH = 32;
const MAX_METRICS_PER_PROVIDER = 32;
const MAX_SPEND_LINES = 8;
const MAX_STRING = 200;
/** Hostname characters plus the separators a user might type into --machine. */
const MACHINE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const METRIC_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export class VibeIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VibeIngestError";
  }
}

/**
 * One vendor the pushing machine could not read, and why.
 *
 * A different thing from the `VibeIngestError` above: that one is thrown when a
 * push is malformed, this one is a fact INSIDE a well-formed push. Naming them
 * apart matters because the store handles them in opposite ways — the exception
 * rejects the request, this travels through and lands on a row.
 */
export interface VibeIngestFailure {
  providerId: string;
  message: string;
}

export interface VibeIngestEnvelope {
  schema: string;
  machine: string;
  sentAt: string;
  providers: VibeProviderUsage[];
  /** Why the vendors that are missing are missing. Absent on an older agent. */
  errors: VibeIngestFailure[];
}

export interface VibeIngestMachine {
  machine: string;
  /** When we received it — our clock, not the agent's. */
  receivedAt: string;
  /** What the agent stamped. Kept for the console; never used for aging. */
  sentAt: string;
  providerIds: string[];
  stale: boolean;
}

interface StoredMachine {
  machine: string;
  atMs: number;
  sentAt: string;
  providers: VibeProviderUsage[];
  errors: VibeIngestFailure[];
}

export class VibeIngestStore {
  private readonly machines = new Map<string, StoredMachine>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Validates and stores one push. Throws `VibeIngestError` with a message the
   * agent's operator can act on — this is the only feedback they get, since the
   * agent runs unattended behind a launchd/systemd unit.
   */
  accept(body: unknown): VibeIngestEnvelope {
    const envelope = parseEnvelope(body);
    const nowMs = this.now();
    this.prune(nowMs);
    if (!this.machines.has(envelope.machine) && this.machines.size >= MAX_MACHINES) {
      throw new VibeIngestError(`at most ${MAX_MACHINES} machines may push usage`);
    }
    this.machines.set(envelope.machine, {
      machine: envelope.machine,
      atMs: nowMs,
      sentAt: envelope.sentAt,
      providers: envelope.providers,
      errors: envelope.errors,
    });
    return envelope;
  }

  /**
   * Every provider still worth showing, newest push wins.
   *
   * Two machines can be signed into the same vendor, and there is one row per
   * vendor on a 52x16 panel — so the most recent push takes the row and names
   * its machine in `source`. Silently averaging or alternating between them
   * would make a quota look like it was moving when it was not.
   */
  collect(): VibeProviderUsage[] {
    const nowMs = this.now();
    this.prune(nowMs);
    const byId = new Map<string, { usage: VibeProviderUsage; atMs: number }>();
    for (const stored of this.machines.values()) {
      const stale = nowMs - stored.atMs >= STALE_MS;
      for (const provider of stored.providers) {
        const existing = byId.get(provider.id);
        if (existing !== undefined && existing.atMs >= stored.atMs) continue;
        byId.set(provider.id, {
          atMs: stored.atMs,
          usage: {
            ...provider,
            stale: provider.stale || stale,
            // Structured rather than appended to `note`: the console prints the
            // machine as a badge on the row, and `note` is the vendor's own
            // message ("re-login for live limits") — merging the two made a
            // sentence neither of them wrote.
            source: { kind: "remote", machine: stored.machine },
          },
        });
      }
    }
    return [...byId.values()].map((entry) => entry.usage);
  }

  /**
   * Why a pushed vendor is missing.
   *
   * A row that failed over there has no row here to hang a badge on, so the
   * machine name goes into the message itself — but only when more than one
   * machine reports, for the same reason `source` does it that way.
   *
   * Errors expire with their machine: an explanation nobody can date is worth
   * no more than the numbers it stands in for.
   */
  collectErrors(): VibeIngestFailure[] {
    const nowMs = this.now();
    this.prune(nowMs);
    const multiMachine = this.machines.size > 1;
    const collected: VibeIngestFailure[] = [];
    for (const stored of this.machines.values()) {
      for (const error of stored.errors) {
        collected.push({
          providerId: error.providerId,
          message: multiMachine ? `${error.message}（${stored.machine}）` : error.message,
        });
      }
    }
    return collected;
  }

  /** What the console shows under 「远程采集」. */
  listMachines(): VibeIngestMachine[] {
    const nowMs = this.now();
    this.prune(nowMs);
    return [...this.machines.values()]
      .sort((left, right) => right.atMs - left.atMs)
      .map((stored) => ({
        machine: stored.machine,
        receivedAt: new Date(stored.atMs).toISOString(),
        sentAt: stored.sentAt,
        providerIds: stored.providers.map((provider) => provider.id),
        stale: nowMs - stored.atMs >= STALE_MS,
      }));
  }

  /**
   * Drops one machine's rows immediately.
   *
   * The console's 卸载 flow: stop the agent over there, then forget it here
   * rather than waiting out EXPIRY_MS with a dead machine on the panel. An
   * agent that is still running simply reappears on its next push, which is the
   * honest outcome — this forgets, it cannot uninstall anything remotely.
   */
  forget(machine: string): boolean {
    return this.machines.delete(machine);
  }

  private prune(nowMs: number): void {
    for (const [machine, stored] of this.machines) {
      if (nowMs - stored.atMs >= EXPIRY_MS) this.machines.delete(machine);
    }
  }
}

function parseEnvelope(body: unknown): VibeIngestEnvelope {
  const record = asRecord(body);
  if (record === undefined) throw new VibeIngestError("body must be a JSON object");

  const schema = asString(record.schema);
  if (schema !== VIBE_INGEST_SCHEMA) {
    throw new VibeIngestError(`unsupported schema: expected ${VIBE_INGEST_SCHEMA}`);
  }

  const machine = asString(record.machine);
  if (machine === undefined || !MACHINE_PATTERN.test(machine)) {
    throw new VibeIngestError("machine must be 1-64 characters of [A-Za-z0-9 ._-]");
  }

  // `sent_at` is the wire name (openusage's hub envelope uses snake_case and
  // matching it keeps a future third-party exporter one mapping away).
  const sentAt = asString(record.sent_at) ?? asString(record.sentAt);
  if (sentAt === undefined || !Number.isFinite(Date.parse(sentAt))) {
    throw new VibeIngestError("sent_at must be an ISO-8601 timestamp");
  }

  const raw = record.snapshots ?? record.providers;
  if (!Array.isArray(raw)) throw new VibeIngestError("snapshots must be an array");
  if (raw.length > MAX_PROVIDERS_PER_PUSH) {
    throw new VibeIngestError(`at most ${MAX_PROVIDERS_PER_PUSH} providers per push`);
  }

  const providers = raw.map(parseProvider);
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new VibeIngestError(`duplicate provider: ${provider.id}`);
    seen.add(provider.id);
  }

  // Optional: an agent built before errors travelled still pushes valid rounds.
  const rawErrors = record.errors ?? [];
  if (!Array.isArray(rawErrors)) throw new VibeIngestError("errors must be an array");
  if (rawErrors.length > MAX_PROVIDERS_PER_PUSH) {
    throw new VibeIngestError(`at most ${MAX_PROVIDERS_PER_PUSH} errors per push`);
  }
  const errors = rawErrors.map(parseError);

  return { schema, machine, sentAt, providers, errors };
}

function parseError(value: unknown): VibeIngestFailure {
  const record = asRecord(value);
  if (record === undefined) throw new VibeIngestError("each error must be an object");
  const providerId = asString(record.providerId);
  if (providerId === undefined || !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new VibeIngestError("error providerId must be 1-32 characters of [a-z0-9-]");
  }
  const message = boundedString(record.message);
  if (message === undefined) throw new VibeIngestError(`${providerId}: error message is required`);
  return { providerId, message };
}

function parseProvider(value: unknown): VibeProviderUsage {
  const record = asRecord(value);
  if (record === undefined) throw new VibeIngestError("each snapshot must be an object");

  const id = asString(record.id);
  if (id === undefined || !PROVIDER_ID_PATTERN.test(id)) {
    throw new VibeIngestError("provider id must be 1-32 characters of [a-z0-9-]");
  }
  const displayName = boundedString(record.displayName) ?? id;
  const fetchedAt = asString(record.fetchedAt);
  if (fetchedAt === undefined || !Number.isFinite(Date.parse(fetchedAt))) {
    throw new VibeIngestError(`${id}: fetchedAt must be an ISO-8601 timestamp`);
  }

  const metricsRaw = record.metrics;
  if (!Array.isArray(metricsRaw)) throw new VibeIngestError(`${id}: metrics must be an array`);
  if (metricsRaw.length > MAX_METRICS_PER_PROVIDER) {
    throw new VibeIngestError(`${id}: at most ${MAX_METRICS_PER_PROVIDER} metrics`);
  }
  const spendRaw = record.spendLines ?? [];
  if (!Array.isArray(spendRaw)) throw new VibeIngestError(`${id}: spendLines must be an array`);
  if (spendRaw.length > MAX_SPEND_LINES) {
    throw new VibeIngestError(`${id}: at most ${MAX_SPEND_LINES} spend lines`);
  }

  return {
    id,
    displayName,
    plan: boundedString(record.plan),
    fetchedAt,
    stale: record.stale === true,
    note: boundedString(record.note),
    metrics: metricsRaw.map((metric) => parseMetric(id, metric)),
    spendLines: spendRaw.map((line) => parseSpendLine(id, line)),
  };
}

function parseMetric(providerId: string, value: unknown): VibeMetric {
  const record = asRecord(value);
  if (record === undefined) throw new VibeIngestError(`${providerId}: each metric must be an object`);

  const key = asString(record.key);
  if (key === undefined || !METRIC_KEY_PATTERN.test(key)) {
    throw new VibeIngestError(`${providerId}: metric key must be 1-32 characters of [A-Za-z0-9_-]`);
  }
  const kind = asString(record.kind);
  if (kind !== "consumption" && kind !== "balance") {
    throw new VibeIngestError(`${providerId}.${key}: kind must be "consumption" or "balance"`);
  }
  const unit = boundedString(record.unit);
  if (unit === undefined) throw new VibeIngestError(`${providerId}.${key}: unit is required`);

  const resetsAt = asString(record.resetsAt);
  if (resetsAt !== undefined && !Number.isFinite(Date.parse(resetsAt))) {
    throw new VibeIngestError(`${providerId}.${key}: resetsAt must be an ISO-8601 timestamp`);
  }

  // Every numeric field is optional and each is dropped on its own when it is
  // not a finite number. A metric that arrives with a broken `used` still shows
  // its `limit`; substituting 0 would draw a full bar for missing data.
  return {
    key,
    label: boundedString(record.label) ?? key,
    kind,
    unit,
    used: finite(record.used),
    limit: finite(record.limit),
    remaining: finite(record.remaining),
    utilization: unitInterval(record.utilization),
    available: finite(record.available),
    resetsAt,
    windowSeconds: finite(record.windowSeconds),
  };
}

function parseSpendLine(providerId: string, value: unknown): VibeSpendLine {
  const record = asRecord(value);
  const label = record === undefined ? undefined : boundedString(record.label);
  const spend = record === undefined ? undefined : boundedString(record.value);
  if (label === undefined || spend === undefined) {
    throw new VibeIngestError(`${providerId}: each spend line needs a label and a value`);
  }
  return { label, value: spend };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A string we are willing to render. Over-long values are rejected, not cut. */
function boundedString(value: unknown): string | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  if (text.length > MAX_STRING) throw new VibeIngestError(`string exceeds ${MAX_STRING} characters`);
  return text;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `utilization` is 0–1 everywhere in VIBE; a percent here would draw a bar 100x too long. */
function unitInterval(value: unknown): number | undefined {
  const number = finite(value);
  if (number === undefined) return undefined;
  return number >= 0 && number <= 1 ? number : undefined;
}
