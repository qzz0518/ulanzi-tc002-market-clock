/**
 * The one HTTP path every adapter uses.
 *
 * Two behaviours matter and are easy to get wrong per-adapter, so they live
 * here instead: a hard timeout (a vendor that hangs must not stall the render
 * loop) and the auth dance — 401/403 means "refresh once, then give up", while
 * 429 and 5xx are handed back untouched so the caller can serve last-good
 * values rather than blank the panel.
 */

import {
  VibeCredentialsExpiredError,
  VibeRateLimitedError,
  VibeRequestError,
  type FetchLike,
} from "./types.ts";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  fetch: FetchLike;
  providerId: string;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  text: string;
  headers: Headers;
}

export async function request(url: string, options: RequestOptions): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    return {
      status: response.status,
      ok: response.ok,
      text: await response.text(),
      headers: response.headers,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const timedOut = controller.signal.aborted;
    throw new VibeRequestError(
      options.providerId,
      timedOut ? `request timed out after ${options.timeoutMs}ms` : reason,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function parseBody(response: RawResponse): unknown {
  if (response.text.trim() === "") return undefined;
  try {
    return JSON.parse(response.text);
  } catch {
    return undefined;
  }
}

/** Retry-After is either delta-seconds or an HTTP date; both appear in the wild. */
export function retryAfterMs(response: RawResponse, nowMs: number): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  // A blank header is a header we cannot use. Number("") is 0, which would read
  // as "retry immediately" and defeat the back-off the vendor just asked for.
  if (header === undefined || header === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/**
 * Turns a response into either a parsed body or the right typed error. 401/403
 * is deliberately NOT retried here — only the adapter knows whether it holds a
 * refresh token worth spending (see `withTokenRefresh`).
 */
export function requireSuccess(response: RawResponse, providerId: string, nowMs: number): unknown {
  if (response.status === 401 || response.status === 403) {
    throw new VibeCredentialsExpiredError(providerId);
  }
  if (response.status === 429) {
    throw new VibeRateLimitedError(providerId, retryAfterMs(response, nowMs));
  }
  if (!response.ok) {
    throw new VibeRequestError(providerId, `HTTP ${response.status}`, response.status);
  }
  return parseBody(response);
}

export function isAuthFailure(response: RawResponse): boolean {
  return response.status === 401 || response.status === 403;
}

/**
 * Runs `attempt` with the current token; on 401/403 refreshes once and repeats.
 * A second rejection is final — looping on a dead refresh token would lock the
 * account out rather than tell the user to sign in again.
 */
export async function withTokenRefresh(input: {
  providerId: string;
  token: string;
  attempt: (token: string) => Promise<RawResponse>;
  refresh: (() => Promise<string>) | undefined;
}): Promise<RawResponse> {
  const first = await input.attempt(input.token);
  if (!isAuthFailure(first)) return first;
  if (input.refresh === undefined) throw new VibeCredentialsExpiredError(input.providerId);
  const fresh = await input.refresh();
  const second = await input.attempt(fresh);
  if (isAuthFailure(second)) throw new VibeCredentialsExpiredError(input.providerId);
  return second;
}
