/**
 * The contract every AI-coding-agent usage adapter implements.
 *
 * One adapter = one vendor. It reads whatever credential that vendor's CLI
 * already left on this machine (file, Keychain, env var), calls that vendor's
 * usage endpoint, and returns normalised metrics. Adapters never touch the
 * device, never cache, and never schedule: the controller owns all of that,
 * exactly like a content renderer (ADR 0001).
 *
 * Everything an adapter needs from the outside world arrives through
 * `VibeAdapterContext`, so a test can hand it a fake fetch, a fake Keychain and
 * a frozen clock without a network or a login.
 */

export type VibeMetricKind = "consumption" | "balance";

export interface VibeMetric {
  /** Stable resource key, e.g. "session" / "weekly" / "credits". */
  key: string;
  /** Vendor's own label for the row, e.g. "Session", "Week (all models)". */
  label: string;
  kind: VibeMetricKind;
  /** "percent" | "usd" | "credits" | "requests" | "resets" | … */
  unit: string;
  /** consumption: how much of the pool is spent. */
  used?: number;
  limit?: number;
  remaining?: number;
  /** 0–1, never 0–100. */
  utilization?: number;
  /** balance: how much is left to spend. */
  available?: number;
  resetsAt?: string;
  windowSeconds?: number;
}

/** A pre-formatted spend line ("Today" → "$5.17 · 9.2M tokens"). */
export interface VibeSpendLine {
  label: string;
  value: string;
}

export interface VibeProviderResult {
  /** "Max 20x", "Pro 20x", "Free tier" … Vendor wording, not ours. */
  plan?: string;
  metrics: VibeMetric[];
  spendLines?: VibeSpendLine[];
  /**
   * A non-fatal note worth showing beside the provider (e.g. "re-login for
   * live usage", "serving cached values, rate limited"). Never an error.
   */
  note?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface KeychainReader {
  /**
   * Reads a generic password. `account` defaults to the current user, then
   * falls back to an account-less lookup — the two shapes `security` writes.
   * Returns null when the item does not exist; throws only on real failure
   * (locked keychain, denied access).
   */
  read(service: string, account?: string): Promise<string | null>;
}

export interface VibeAdapterContext {
  now(): number;
  fetch: FetchLike;
  env: Record<string, string | undefined>;
  keychain: KeychainReader;
  /** Reads a UTF-8 file, expanding a leading `~`. Missing file → null. */
  readTextFile(path: string): Promise<string | null>;
  /**
   * Rewrites a credential file the same way its owner would: atomically, 0600.
   *
   * This exists so a rotated refresh token gets back to the CLI that will need
   * it next. There is no keychain equivalent (see keychain.ts), so an adapter
   * whose credential lives in the keychain must not spend a refresh at all.
   */
  writeTextFile(path: string, content: string): Promise<void>;
  /** Lists a directory's entries (names only). Missing directory → []. */
  listDirectory(path: string): Promise<string[]>;
  /** User-supplied API key for the key-based vendors, or null. */
  apiKey(providerId: string): string | null;
  /** Per-request ceiling; adapters pass it to `requestJson`. */
  timeoutMs: number;
}

export interface VibeProviderAdapter {
  id: string;
  displayName: string;
  /**
   * Cheap local probe — no network, no Keychain prompt beyond a read that the
   * user already authorised. Answers "is this vendor's CLI installed and
   * logged in on this machine", which is what first-run enablement keys off.
   */
  detect(context: VibeAdapterContext): Promise<boolean>;
  /** Live quota. Throws one of the errors below; never returns partial lies. */
  fetchUsage(context: VibeAdapterContext): Promise<VibeProviderResult>;
}

/**
 * No credential on this machine. This is a STATE, not a failure: the console
 * shows the vendor greyed with a setup hint and the panel stays silent.
 */
export class VibeCredentialsMissingError extends Error {
  readonly providerId: string;
  constructor(providerId: string, message = "not signed in") {
    super(message);
    this.name = "VibeCredentialsMissingError";
    this.providerId = providerId;
  }
}

/** A credential exists but the vendor rejected it — the user must re-login. */
export class VibeCredentialsExpiredError extends Error {
  readonly providerId: string;
  constructor(providerId: string, message = "sign-in expired") {
    super(message);
    this.name = "VibeCredentialsExpiredError";
    this.providerId = providerId;
  }
}

/** Transport or non-2xx response. Carries the status when there was one. */
export class VibeRequestError extends Error {
  readonly providerId: string;
  readonly status?: number;
  constructor(providerId: string, message: string, status?: number) {
    super(message);
    this.name = "VibeRequestError";
    this.providerId = providerId;
    this.status = status;
  }
}

/** 429 with an optional cooldown, so the caller can back off rather than hammer. */
export class VibeRateLimitedError extends Error {
  readonly providerId: string;
  readonly retryAfterMs?: number;
  constructor(providerId: string, retryAfterMs?: number, message = "rate limited") {
    super(message);
    this.name = "VibeRateLimitedError";
    this.providerId = providerId;
    this.retryAfterMs = retryAfterMs;
  }
}
