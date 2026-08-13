// Shared vocabulary for every music source the studio can drive. NetEase and
// Spotify differ in almost everything except this shape, so the control API,
// the web studio and the TC002 firmware only ever speak these types.

export type MusicProviderId = "netease" | "spotify";

// How audio actually reaches the listener:
//   device-audio — the TC002 downloads the track and plays it through MI_AO.
//   remote       — playback lives on someone else's speaker (Spotify Connect);
//                  the TC002 only mirrors lyrics and drives the transport.
export type MusicPlaybackMode = "device-audio" | "remote";

export const MUSIC_PROVIDER_IDS: readonly MusicProviderId[] = ["netease", "spotify"];

export function isMusicProviderId(value: unknown): value is MusicProviderId {
  return typeof value === "string" && MUSIC_PROVIDER_IDS.includes(value as MusicProviderId);
}

export class MusicServiceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "MusicServiceError";
  }
}

export interface MusicProfile {
  provider: MusicProviderId;
  id: string;
  nickname: string;
  avatarUrl?: string;
  // Spotify: "premium" / "free" — Connect control needs Premium, so the studio
  // warns before the first 403. NetEase leaves it unset.
  plan?: string;
}

export interface MusicSessionStatus {
  loggedIn: boolean;
  profile?: MusicProfile;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  trackCount: number;
  coverUrl?: string;
}

export interface MusicTrack {
  id: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  coverUrl?: string;
}

/** One timed word, exactly as the source declared it. Absolute track time. */
export interface MusicLyricWord {
  startMs: number;
  endMs: number;
  /** Verbatim, including any trailing space the source put inside the word. */
  text: string;
}

/**
 * How a line's `endMs` was decided.
 *
 *   "words"    — the last word's end. Exact.
 *   "marker"   — a bare [mm:ss.xx] line in the LRC: the source's own end mark.
 *   "estimate" — our singing-rate cap. A guess, and it can cut a genuinely
 *                sustained note short.
 *   "next"     — the next line starts before either of the above could apply,
 *                so nothing had to be guessed.
 */
export type LyricEndSource = "words" | "marker" | "estimate" | "next";

export interface MusicLyricLine {
  startMs: number;
  /**
   * When the line finished being SUNG — deliberately NOT when the next line
   * starts. A verse's last line is followed by the instrumental, and defining
   * its end as the next line's start is what made the karaoke highlight crawl
   * for ten seconds after the singer stopped. See `endSource` for how confident
   * this number is.
   */
  endMs: number;
  text: string;
  translation?: string;
  /**
   * Per-word timings, present only when the source really carries them
   * (NetEase `yrc`). The absence is the signal that this line has line-level
   * timing only; nothing downstream may invent one.
   */
  words?: MusicLyricWord[];
  /**
   * Required rather than optional, so that "never fabricate timing data" is
   * enforced by the type system: every construction site has to answer where
   * its end came from, and the console can tell the user which lines are
   * measured and which are estimated.
   */
  endSource: LyricEndSource;
}

export interface MusicTrackDetail {
  track: MusicTrack;
  lyrics: MusicLyricLine[];
}

// What a remote (Connect) player is doing right now. Polled on a short TTL and
// republished to the device through /api/music/device/state.
export interface MusicRemoteSnapshot {
  trackId: string | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  deviceId?: string;
  deviceName?: string;
  volumePercent?: number;
  fetchedAt: number;
}

export interface MusicRemoteDevice {
  id: string;
  name: string;
  type: string;
  active: boolean;
  volumePercent?: number;
}

export interface MusicRemoteControl {
  // `force` skips the snapshot cache — used right after a transport command so
  // the UI doesn't show a stale playhead for a whole poll interval.
  snapshot(force?: boolean): Promise<MusicRemoteSnapshot>;
  play(input?: { trackId?: string; positionMs?: number }): Promise<void>;
  pause(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(percent: number): Promise<void>;
  devices(): Promise<MusicRemoteDevice[]>;
  transfer(deviceId: string, play: boolean): Promise<void>;
}

export interface MusicProvider {
  readonly id: MusicProviderId;
  readonly label: string;
  readonly playbackMode: MusicPlaybackMode;
  initialize(): Promise<void>;
  status(): MusicSessionStatus;
  logout(): Promise<void>;
  playlists(): Promise<MusicPlaylist[]>;
  playlistTracks(id: string): Promise<MusicTrack[]>;
  search(query: string): Promise<MusicTrack[]>;
  trackDetail(id: string): Promise<MusicTrackDetail>;
  avatar(): Promise<Response>;
  // Only providers whose playbackMode is "device-audio" can hand the TC002 an
  // audio stream; remote providers leave this undefined.
  stream?(id: string, range?: string | null): Promise<Response>;
  // Only remote providers expose a transport; device-audio providers leave it
  // undefined and the device drives its own playback.
  remote?: MusicRemoteControl;
}

/* ------------------------------------------------------------------ */
/* Shared parsing helpers — every upstream returns loosely typed JSON. */
/* ------------------------------------------------------------------ */

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

export function recordAt(value: UnknownRecord, path: string[]): UnknownRecord {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)[key];
  return asRecord(current);
}

export function stringAt(value: UnknownRecord, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else current = asRecord(current)[key];
  }
  return typeof current === "string" ? current : undefined;
}

export function arrayAt(value: UnknownRecord, path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)[key];
  return Array.isArray(current) ? current : [];
}

export function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A cover URL, upgraded from http to https when the host is one we already
 * proxy for.
 *
 * NetEase hands out `http://p3.music.126.net/…` for every search result and
 * every daily recommendation — plain http, on hosts that serve the identical
 * image over https. Running those through safeHttpsUrl dropped the field
 * entirely, so a whole search page fell back to index tiles while the playlist
 * page, whose covers happen to arrive as https, showed real art. That split is
 * what made it look like a rendering bug rather than a dropped field.
 *
 * This is not a hole in the guard. The upgrade only applies to hosts already on
 * the art allowlist, the proxy still refuses anything that is not https on an
 * allowlisted host, and nothing here is ever fetched by the browser — the page
 * CSP stays `img-src 'self'` and the request is made by the service.
 *
 * An https URL is passed through exactly as safeHttpsUrl would, allowlisted or
 * not. Rejecting a non-allowlisted https host here would be a second, stricter
 * copy of a rule the proxy already enforces, and this function's job is the
 * upgrade, not the policy.
 */
export function musicArtUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && isMusicArtHost(url)) url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

// Track and playlist IDs travel through URL paths and the tab-delimited device
// protocol, so they stay restricted to characters that are safe in both.
const SAFE_MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeMediaId(value: string): boolean {
  return SAFE_MEDIA_ID.test(value);
}

export function assertMediaId(value: string, label: string): string {
  if (!isSafeMediaId(value)) throw new MusicServiceError(`${label} ID 无效`);
  return value;
}

/* ------------------------------------------------------------------ */
/* Shared avatar proxying — never hand a browser an upstream image URL. */
/* ------------------------------------------------------------------ */

const MAX_PROFILE_AVATAR_BYTES = 5 * 1024 * 1024;
const PROFILE_AVATAR_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Album art is the one place the studio shows a remote image. It is proxied for
// the same reasons the avatar is: the page CSP stays `img-src 'self'`, and the
// browser never announces what the user is listening to to a third-party CDN.
const MUSIC_ART_HOSTS = [
  /^i\.scdn\.co$/,
  /(^|\.)scdn\.co$/,
  /(^|\.)spotifycdn\.com$/,
  /(^|\.)music\.126\.net$/,
  /(^|\.)126\.net$/,
  /(^|\.)music\.163\.com$/,
];

export function isMusicArtHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return MUSIC_ART_HOSTS.some((pattern) => pattern.test(host));
}

export async function proxyMusicArt(
  rawUrl: string,
  fetcher?: typeof fetch,
): Promise<Response> {
  const response = await proxyProfileImage({
    url: rawUrl,
    isAllowedHost: isMusicArtHost,
    ...(fetcher ? { fetcher } : {}),
    sourceLabel: "封面",
  });
  // Cover art for a given URL never changes, so let the browser keep it.
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, max-age=86400");
  return new Response(response.body, { status: response.status, headers });
}

export async function proxyProfileImage(input: {
  url: string;
  isAllowedHost: (url: URL) => boolean;
  fetcher?: typeof fetch;
  sourceLabel: string;
}): Promise<Response> {
  const { isAllowedHost, sourceLabel } = input;
  const upstreamUrl = new URL(input.url);
  if (upstreamUrl.protocol !== "https:" || !isAllowedHost(upstreamUrl)) {
    throw new MusicServiceError(`${sourceLabel}返回了不受信任的头像地址`, 502);
  }

  const fetcher = input.fetcher ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetcher(upstreamUrl, {
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8",
        "User-Agent": "Pixel-Market-TC002/3",
      },
      redirect: "follow",
    });
  } catch {
    throw new MusicServiceError(`无法读取${sourceLabel}头像，请稍后重试`, 502);
  }

  const finalUrl = upstream.url ? new URL(upstream.url) : upstreamUrl;
  if (finalUrl.protocol !== "https:" || !isAllowedHost(finalUrl)) {
    upstream.body?.cancel().catch(() => undefined);
    throw new MusicServiceError(`${sourceLabel}头像跳转到了不受信任的地址`, 502);
  }
  if (!upstream.ok) {
    upstream.body?.cancel().catch(() => undefined);
    throw new MusicServiceError(`${sourceLabel}头像源返回 HTTP ${upstream.status}`, 502);
  }

  const reportedContentType = (upstream.headers.get("Content-Type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  const contentType = reportedContentType === "image/jpg" ? "image/jpeg" : reportedContentType;
  if (!PROFILE_AVATAR_MIME_TYPES.has(contentType)) {
    upstream.body?.cancel().catch(() => undefined);
    throw new MusicServiceError(`${sourceLabel}头像源没有返回受支持的图片格式`, 502);
  }

  const bytes = await readBoundedBody(upstream, MAX_PROFILE_AVATAR_BYTES, sourceLabel);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Length": String(bytes.byteLength),
      "Content-Type": contentType,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function readBoundedBody(
  response: Response,
  maxBytes: number,
  sourceLabel: string,
): Promise<Uint8Array> {
  const limitMb = Math.round(maxBytes / (1024 * 1024));
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.body?.cancel().catch(() => undefined);
    throw new MusicServiceError(`${sourceLabel}响应超过 ${limitMb} MB 限制`, 502);
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new MusicServiceError(`${sourceLabel}响应超过 ${limitMb} MB 限制`, 502);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MusicServiceError) throw error;
    throw new MusicServiceError(`读取${sourceLabel}响应时连接中断`, 502);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
