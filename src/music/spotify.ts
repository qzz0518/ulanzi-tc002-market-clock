import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  arrayAt,
  asRecord,
  assertMediaId,
  MusicServiceError,
  numberValue,
  proxyProfileImage,
  readBoundedBody,
  recordAt,
  safeHttpsUrl,
  stringAt,
  type MusicPlaylist,
  type MusicProfile,
  type MusicProvider,
  type MusicRemoteControl,
  type MusicRemoteDevice,
  type MusicRemoteSnapshot,
  type MusicSessionStatus,
  type MusicTrack,
  type MusicTrackDetail,
  type UnknownRecord,
} from "./core.ts";
import type { LyricsLookup } from "./lyrics.ts";

const ACCOUNTS_ORIGIN = "https://accounts.spotify.com";
const API_ORIGIN = "https://api.spotify.com";
const MAX_JSON_BYTES = 2 * 1024 * 1024;

// Everything the studio needs: read the player and the library, and drive
// Spotify Connect. `streaming` is deliberately absent — it only powers the
// browser Web Playback SDK, and playback belongs on the user's own Spotify
// clients, which the studio and the clock follow rather than replace.
export const SPOTIFY_SCOPES = [
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
] as const;

// Spotify's own id for "喜欢的音乐" is not a playlist, so it gets a reserved key
// that can never collide with a real 22-character base62 playlist id.
export const SPOTIFY_LIKED_PLAYLIST_ID = "liked";

export interface SpotifyLoginStart {
  authorizeUrl: string;
  state: string;
  expiresAt: string;
}

export interface SpotifyAppStatus {
  configured: boolean;
  clientId: string | null;
  redirectUri: string;
}

interface StoredSpotifySession {
  version: 1;
  refreshToken: string;
  profile: MusicProfile;
  country?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

async function writePrivateJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// The Spotify application the user registered in their own developer dashboard.
// PKCE keeps this a public client, so only the client ID is ever stored — there
// is no secret to leak.
export class SpotifyAppStore {
  constructor(private readonly path: string) {}

  async load(): Promise<string | null> {
    const record = asRecord(await readJsonFile(this.path));
    const clientId = typeof record.clientId === "string" ? record.clientId.trim() : "";
    return isValidClientId(clientId) ? clientId : null;
  }

  async save(clientId: string): Promise<void> {
    await writePrivateJson(this.path, { version: 1, clientId });
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export class SpotifySessionStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StoredSpotifySession | null> {
    const record = asRecord(await readJsonFile(this.path));
    if (record.version !== 1 || typeof record.refreshToken !== "string") return null;
    const profile = parseStoredProfile(record.profile);
    if (!profile || !isValidToken(record.refreshToken)) return null;
    const accessToken = typeof record.accessToken === "string" && isValidToken(record.accessToken)
      ? record.accessToken
      : undefined;
    const accessTokenExpiresAt = numberValue(record.accessTokenExpiresAt);
    return {
      version: 1,
      refreshToken: record.refreshToken,
      profile,
      ...(typeof record.country === "string" ? { country: record.country } : {}),
      ...(accessToken ? { accessToken } : {}),
      ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
    };
  }

  async save(session: StoredSpotifySession): Promise<void> {
    if (!isValidToken(session.refreshToken)) {
      throw new MusicServiceError("Spotify 登录凭据格式无效", 502);
    }
    await writePrivateJson(this.path, session);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

interface PendingLogin {
  verifier: string;
  redirectUri: string;
  expiresAtMs: number;
}

export class SpotifyMusicService implements MusicProvider, MusicRemoteControl {
  readonly id = "spotify" as const;
  readonly label = "Spotify";
  // Spotify audio is DRM-protected and never leaves Spotify's own clients, so
  // the TC002 mirrors a Connect player instead of streaming the track itself.
  readonly playbackMode = "remote" as const;

  private clientId: string | null = null;
  private session: StoredSpotifySession | null = null;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private snapshotCache: MusicRemoteSnapshot | null = null;
  private snapshotInFlight: Promise<MusicRemoteSnapshot> | null = null;

  constructor(
    private readonly options: {
      appStore: SpotifyAppStore;
      sessionStore: SpotifySessionStore;
      redirectUri: string;
      lyrics: LyricsLookup;
      fetcher?: typeof fetch;
      now?: () => number;
      timeoutMs?: number;
      snapshotTtlMs?: number;
    },
  ) {}

  get remote(): MusicRemoteControl {
    return this;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get fetcher(): typeof fetch {
    return this.options.fetcher ?? fetch;
  }

  async initialize(): Promise<void> {
    this.clientId = await this.options.appStore.load();
    this.session = await this.options.sessionStore.load();
  }

  status(): MusicSessionStatus {
    return this.session
      ? { loggedIn: true, profile: structuredClone(this.session.profile) }
      : { loggedIn: false };
  }

  appStatus(): SpotifyAppStatus {
    return {
      configured: this.clientId !== null,
      clientId: this.clientId,
      redirectUri: this.options.redirectUri,
    };
  }

  async saveApp(clientId: string): Promise<SpotifyAppStatus> {
    const normalized = clientId.trim();
    if (!isValidClientId(normalized)) {
      throw new MusicServiceError("Spotify Client ID 应为 32 位十六进制字符");
    }
    // Re-pointing the studio at a different Spotify application invalidates any
    // token minted by the old one, so the session goes with it.
    if (this.clientId !== null && this.clientId !== normalized) await this.logout();
    await this.options.appStore.save(normalized);
    this.clientId = normalized;
    return this.appStatus();
  }

  async logout(): Promise<void> {
    this.session = null;
    this.pendingLogins.clear();
    this.snapshotCache = null;
    await this.options.sessionStore.clear();
  }

  /* -------------------------------- OAuth -------------------------------- */

  beginLogin(): SpotifyLoginStart {
    const clientId = this.requireClientId();
    this.prunePendingLogins();
    if (this.pendingLogins.size >= 5) {
      throw new MusicServiceError("同时进行的 Spotify 登录过多，请稍后重试", 429);
    }
    const verifier = base64Url(randomBytes(64));
    const state = randomBytes(16).toString("hex");
    const expiresAtMs = this.now + 10 * 60_000;
    this.pendingLogins.set(state, {
      verifier,
      redirectUri: this.options.redirectUri,
      expiresAtMs,
    });

    const authorize = new URL(`${ACCOUNTS_ORIGIN}/authorize`);
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("redirect_uri", this.options.redirectUri);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set(
      "code_challenge",
      base64Url(createHash("sha256").update(verifier).digest()),
    );
    return { authorizeUrl: authorize.toString(), state, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async completeLogin(input: { code: string; state: string }): Promise<MusicProfile> {
    const clientId = this.requireClientId();
    this.prunePendingLogins();
    const pending = findPendingLogin(this.pendingLogins, input.state);
    if (!pending) {
      throw new MusicServiceError("Spotify 登录会话已过期，请重新发起登录", 400);
    }
    this.pendingLogins.delete(pending.state);
    if (!/^[\w.~-]{1,1024}$/.test(input.code)) {
      throw new MusicServiceError("Spotify 返回的授权码无效");
    }

    const token = await this.requestToken({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: pending.login.redirectUri,
      client_id: clientId,
      code_verifier: pending.login.verifier,
    });
    if (!token.refreshToken) {
      throw new MusicServiceError("Spotify 没有返回刷新令牌，请确认应用使用 PKCE 授权", 502);
    }

    const me = asRecord(await this.apiRequest("GET", "/v1/me", { accessToken: token.accessToken }));
    const profile = parseSpotifyProfile(me);
    if (!profile) throw new MusicServiceError("登录成功，但没有取得 Spotify 用户资料", 502);
    const country = typeof me.country === "string" ? me.country.toUpperCase() : undefined;

    this.session = {
      version: 1,
      refreshToken: token.refreshToken,
      profile,
      ...(country ? { country } : {}),
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.expiresAt,
    };
    await this.options.sessionStore.save(this.session);
    return structuredClone(profile);
  }

  // Same exchange, but driven by a redirect URL the user pasted back — the
  // loopback callback can only land on the machine running the service, so a
  // phone or tablet browser finishes the login this way.
  async completeLoginFromRedirect(redirectUrl: string): Promise<MusicProfile> {
    let url: URL;
    try {
      url = new URL(redirectUrl.trim());
    } catch {
      throw new MusicServiceError("回调地址无效，请粘贴完整的 http://127.0.0.1… 链接");
    }
    const error = url.searchParams.get("error");
    if (error) throw new MusicServiceError(`Spotify 拒绝了授权：${error}`, 400);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      throw new MusicServiceError("回调地址里没有 code 与 state 参数");
    }
    return await this.completeLogin({ code, state });
  }

  /* ------------------------------- Library ------------------------------- */

  async playlists(): Promise<MusicPlaylist[]> {
    const [owned, liked] = await Promise.all([
      this.pagedItems("/v1/me/playlists", ["items"], 50),
      this.apiRequest("GET", "/v1/me/tracks").catch(() => null),
    ]);
    const likedTotal = numberValue(asRecord(liked).total) ?? 0;
    const playlists: MusicPlaylist[] = likedTotal > 0
      ? [{ id: SPOTIFY_LIKED_PLAYLIST_ID, name: "喜欢的音乐", trackCount: likedTotal }]
      : [];
    for (const item of owned) {
      const parsed = parsePlaylist(item);
      if (parsed) playlists.push(parsed);
    }
    return dedupeById(playlists);
  }

  async playlistTracks(id: string): Promise<MusicTrack[]> {
    const path = id === SPOTIFY_LIKED_PLAYLIST_ID
      ? "/v1/me/tracks"
      : `/v1/playlists/${assertMediaId(id, "歌单")}/tracks`;
    const items = await this.pagedItems(path, ["items"], 100);
    return dedupeById(items
      .map((item) => parseTrack(asRecord(item).track))
      .filter((track): track is MusicTrack => track !== null));
  }

  async search(query: string): Promise<MusicTrack[]> {
    const normalized = query.trim();
    if (normalized.length < 1 || normalized.length > 80) {
      throw new MusicServiceError("搜索词需要包含 1–80 个字符");
    }
    const items = await this.pagedItems(
      `/v1/search?q=${encodeURIComponent(normalized)}&type=track`,
      ["tracks", "items"],
      30,
    );
    return dedupeById(items
      .map(parseTrack)
      .filter((track): track is MusicTrack => track !== null));
  }

  // Spotify rejects an explicit `limit` on some endpoints ("Invalid limit") for
  // applications still in development mode, and the page size it then picks
  // varies per endpoint — /v1/search hands back five rows at a time. So never
  // ask for a page size: take whatever the server gives and walk `offset` until
  // there is enough. Pages can overlap as the result set shifts underneath, so
  // callers dedupe by ID.
  private async pagedItems(
    path: string,
    itemsAt: string[],
    target: number,
  ): Promise<unknown[]> {
    const collected: unknown[] = [];
    const separator = path.includes("?") ? "&" : "?";
    let offset = 0;
    for (let page = 0; page < 8 && collected.length < target; page += 1) {
      const url = offset === 0 ? path : `${path}${separator}offset=${offset}`;
      const items = arrayAt(asRecord(await this.apiRequest("GET", url)), itemsAt);
      if (items.length === 0) break;
      collected.push(...items);
      offset += items.length;
    }
    return collected.slice(0, target);
  }

  async trackDetail(id: string): Promise<MusicTrackDetail> {
    const body = await this.apiRequest("GET", `/v1/tracks/${assertMediaId(id, "歌曲")}`);
    const track = parseTrack(body);
    if (!track) throw new MusicServiceError("没有找到这首歌曲", 404);
    return { track, lyrics: await this.options.lyrics.lyrics(track) };
  }

  async avatar(): Promise<Response> {
    const profile = this.requireSession().profile;
    if (!profile.avatarUrl) throw new MusicServiceError("当前 Spotify 账号没有头像", 404);
    return await proxyProfileImage({
      url: profile.avatarUrl,
      isAllowedHost: isSpotifyImageHost,
      ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
      sourceLabel: "Spotify",
    });
  }

  /* ---------------------------- Spotify Connect --------------------------- */

  async snapshot(force = false): Promise<MusicRemoteSnapshot> {
    const ttl = this.options.snapshotTtlMs ?? 2_000;
    const cached = this.snapshotCache;
    if (!force && cached && this.now - cached.fetchedAt < ttl) return cached;
    // Both the firmware and the web studio poll on their own cadence; one
    // in-flight request serves whoever asks while it is running.
    if (this.snapshotInFlight) return await this.snapshotInFlight;

    const request = (async (): Promise<MusicRemoteSnapshot> => {
      try {
        const body = await this.apiRequest("GET", "/v1/me/player");
        const snapshot = parseSnapshot(body, this.now);
        this.snapshotCache = snapshot;
        return snapshot;
      } catch (error) {
        // A transient upstream hiccup must not blank the device's lyric view;
        // keep serving the last good reading until it goes stale on its own.
        if (cached) return cached;
        throw error;
      } finally {
        this.snapshotInFlight = null;
      }
    })();
    this.snapshotInFlight = request;
    return await request;
  }

  async play(input: { trackId?: string; positionMs?: number } = {}): Promise<void> {
    const body: UnknownRecord = {};
    if (input.trackId) {
      body.uris = [`spotify:track:${assertMediaId(input.trackId, "歌曲")}`];
    }
    if (typeof input.positionMs === "number" && input.positionMs >= 0) {
      body.position_ms = Math.round(input.positionMs);
    }
    await this.playerRequest("PUT", "/v1/me/player/play", Object.keys(body).length > 0 ? body : undefined);
  }

  async pause(): Promise<void> {
    await this.playerRequest("PUT", "/v1/me/player/pause");
  }

  async next(): Promise<void> {
    await this.playerRequest("POST", "/v1/me/player/next");
  }

  async previous(): Promise<void> {
    await this.playerRequest("POST", "/v1/me/player/previous");
  }

  async seek(positionMs: number): Promise<void> {
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      throw new MusicServiceError("跳转位置无效");
    }
    await this.playerRequest("PUT", `/v1/me/player/seek?position_ms=${Math.round(positionMs)}`);
  }

  async setVolume(percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new MusicServiceError("音量需要在 0–100 之间");
    }
    await this.playerRequest("PUT", `/v1/me/player/volume?volume_percent=${Math.round(percent)}`);
  }

  async devices(): Promise<MusicRemoteDevice[]> {
    const body = asRecord(await this.apiRequest("GET", "/v1/me/player/devices"));
    return arrayAt(body, ["devices"])
      .map(parseDevice)
      .filter((device): device is MusicRemoteDevice => device !== null);
  }

  async transfer(deviceId: string, play: boolean): Promise<void> {
    if (!/^[A-Za-z0-9]{1,128}$/.test(deviceId)) {
      throw new MusicServiceError("Spotify 设备 ID 无效");
    }
    await this.playerRequest("PUT", "/v1/me/player", { device_ids: [deviceId], play });
  }

  /* ------------------------------- Internals ------------------------------ */

  private async playerRequest(method: string, path: string, body?: UnknownRecord): Promise<void> {
    // Player commands carry no useful response: Spotify answers 204, or 200 with
    // a bare command id that is not JSON. Only the status matters here.
    try {
      await this.apiRequest(method, path, {
        ...(body === undefined ? {} : { body }),
        expectBody: false,
      });
    } catch (error) {
      // "Restriction violated" means the command does not apply right now —
      // pausing an already-paused player, or skipping past the end of a queue.
      // The desired state is the actual state, so this is a no-op, not a
      // failure worth showing anyone.
      if (!(error instanceof MusicServiceError) || !isNoOpRestriction(error)) throw error;
    }
    // The next poll must observe the command, not the pre-command state.
    this.snapshotCache = null;
  }

  private requireClientId(): string {
    if (!this.clientId) {
      throw new MusicServiceError("请先填写 Spotify 应用的 Client ID", 409);
    }
    return this.clientId;
  }

  private requireSession(): StoredSpotifySession {
    if (!this.session) throw new MusicServiceError("请先登录 Spotify", 401);
    return this.session;
  }

  private async accessToken(): Promise<string> {
    const session = this.requireSession();
    if (
      session.accessToken &&
      session.accessTokenExpiresAt &&
      session.accessTokenExpiresAt - this.now > 60_000
    ) {
      return session.accessToken;
    }
    const token = await this.requestToken({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: this.requireClientId(),
    });
    // Spotify rotates the refresh token on some responses and omits it on
    // others; keeping the previous one when it is absent is required.
    this.session = {
      ...session,
      refreshToken: token.refreshToken ?? session.refreshToken,
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.expiresAt,
    };
    await this.options.sessionStore.save(this.session);
    return token.accessToken;
  }

  private async requestToken(
    form: Record<string, string>,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
    let response: Response;
    try {
      response = await this.fetcher(`${ACCOUNTS_ORIGIN}/api/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(form).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new MusicServiceError("无法连接 Spotify 账号服务，请检查网络", 502);
    }

    const body = asRecord(await this.readJsonResponse(response));
    if (!response.ok) {
      const description = typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : `HTTP ${response.status}`;
      // A rejected refresh token can never recover on its own — drop the
      // session so the studio shows the login button again.
      if (response.status === 400 && form.grant_type === "refresh_token") {
        await this.logout();
        throw new MusicServiceError("Spotify 登录已失效，请重新登录", 401);
      }
      throw new MusicServiceError(`Spotify 授权失败：${description}`, response.status === 400 ? 400 : 502);
    }

    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    if (!isValidToken(accessToken)) {
      throw new MusicServiceError("Spotify 没有返回有效的访问令牌", 502);
    }
    const expiresIn = numberValue(body.expires_in) ?? 3_600;
    const refreshToken = typeof body.refresh_token === "string" && isValidToken(body.refresh_token)
      ? body.refresh_token
      : undefined;
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: this.now + Math.max(60, expiresIn) * 1_000,
    };
  }

  private async apiRequest(
    method: string,
    path: string,
    options: {
      body?: UnknownRecord;
      accessToken?: string;
      retryOn401?: boolean;
      // Player commands answer with a bare command id, not JSON; skip the parse.
      expectBody?: boolean;
    } = {},
  ): Promise<unknown> {
    const accessToken = options.accessToken ?? await this.accessToken();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetcher(`${API_ORIGIN}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new MusicServiceError("无法连接 Spotify 服务，请检查网络", 502);
    }

    if (response.status === 401 && options.accessToken === undefined && options.retryOn401 !== false) {
      // The cached access token was revoked early; mint a fresh one once.
      response.body?.cancel().catch(() => undefined);
      if (this.session) {
        this.session = { ...this.session, accessToken: "", accessTokenExpiresAt: 0 };
      }
      return await this.apiRequest(method, path, { ...options, retryOn401: false });
    }
    if (response.status === 204 || response.status === 202) {
      response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) throw await this.apiError(response, path);
    if (options.expectBody === false) {
      response.body?.cancel().catch(() => undefined);
      return null;
    }
    return await this.readJsonResponse(response);
  }

  private async apiError(response: Response, path: string): Promise<MusicServiceError> {
    const body = asRecord(await this.readJsonResponse(response).catch(() => null));
    const reason = stringAt(body, ["error", "reason"]) ?? "";
    const message = stringAt(body, ["error", "message"]) ?? "";
    if (response.status === 401) {
      return new MusicServiceError("Spotify 登录已过期，请重新登录", 401);
    }
    if (response.status === 403) {
      return new MusicServiceError(
        reason === "PREMIUM_REQUIRED" || message.toLowerCase().includes("premium")
          ? "Spotify Connect 远程控制需要 Premium 账号"
          : `Spotify 拒绝了该操作${message ? `：${message}` : ""}`,
        403,
      );
    }
    if (response.status === 404 && path.startsWith("/v1/me/player")) {
      return new MusicServiceError(
        "没有正在活动的 Spotify 播放设备；先在手机或电脑上播放一次，再回到这里选择设备",
        404,
      );
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "");
      return new MusicServiceError(
        `Spotify 请求过于频繁，请 ${Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 30} 秒后重试`,
        429,
      );
    }
    return new MusicServiceError(
      `Spotify 返回 HTTP ${response.status}${message ? `：${message}` : ""}`,
      response.status >= 500 ? 502 : response.status,
    );
  }

  private async readJsonResponse(response: Response): Promise<unknown> {
    const bytes = await readBoundedBody(response, MAX_JSON_BYTES, "Spotify");
    if (bytes.byteLength === 0) return null;
    const text = new TextDecoder().decode(bytes);
    // Some player endpoints answer 200 with an empty-ish body instead of 204.
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      // Name what actually came back: an opaque "unparseable" leaves nobody
      // anywhere to look.
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, 120);
      throw new MusicServiceError(
        `Spotify 返回了无法解析的内容（HTTP ${response.status}：${snippet}）`,
        502,
      );
    }
  }

  private prunePendingLogins(): void {
    for (const [state, login] of this.pendingLogins) {
      if (login.expiresAtMs <= this.now) this.pendingLogins.delete(state);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

// Overlapping pages can hand back the same row twice.
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function parseSpotifyProfile(record: UnknownRecord): MusicProfile | null {
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const nickname = typeof record.display_name === "string" && record.display_name.trim()
    ? record.display_name.trim()
    : id;
  const avatarUrl = safeHttpsUrl(asRecord(arrayAt(record, ["images"])[0]).url);
  const plan = typeof record.product === "string" ? record.product : undefined;
  return {
    provider: "spotify",
    id,
    nickname,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(plan ? { plan } : {}),
  };
}

function parseStoredProfile(value: unknown): MusicProfile | null {
  const record = asRecord(value);
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const nickname = typeof record.nickname === "string" ? record.nickname.trim() : "";
  if (!id || !nickname) return null;
  const avatarUrl = safeHttpsUrl(record.avatarUrl);
  const plan = typeof record.plan === "string" ? record.plan : undefined;
  return {
    provider: "spotify",
    id,
    nickname,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(plan ? { plan } : {}),
  };
}

function parsePlaylist(value: unknown): MusicPlaylist | null {
  const record = asRecord(value);
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || !name) return null;
  const coverUrl = safeHttpsUrl(asRecord(arrayAt(record, ["images"])[0]).url);
  return {
    id,
    name,
    trackCount: Math.max(0, Math.floor(numberValue(recordAt(record, ["tracks"]).total) ?? 0)),
    ...(coverUrl ? { coverUrl } : {}),
  };
}

function parseTrack(value: unknown): MusicTrack | null {
  const record = asRecord(value);
  // Saved-track and playlist rows can carry podcast episodes and local files;
  // neither has a usable Spotify track id.
  if (record.type !== undefined && record.type !== "track") return null;
  const id = typeof record.id === "string" ? record.id : "";
  const title = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || !title) return null;
  const artists = arrayAt(record, ["artists"])
    .map((artist) => asRecord(artist).name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
  const albumRecord = recordAt(record, ["album"]);
  const album = typeof albumRecord.name === "string" ? albumRecord.name.trim() : "";
  const coverUrl = safeHttpsUrl(asRecord(arrayAt(albumRecord, ["images"])[0]).url);
  return {
    id,
    title,
    artists,
    album,
    durationMs: Math.max(0, Math.floor(numberValue(record.duration_ms) ?? 0)),
    ...(coverUrl ? { coverUrl } : {}),
  };
}

function parseDevice(value: unknown): MusicRemoteDevice | null {
  const record = asRecord(value);
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || !name) return null;
  const volumePercent = numberValue(record.volume_percent);
  return {
    id,
    name,
    type: typeof record.type === "string" ? record.type : "Unknown",
    active: record.is_active === true,
    ...(volumePercent === undefined ? {} : { volumePercent: Math.round(volumePercent) }),
  };
}

function parseSnapshot(value: unknown, fetchedAt: number): MusicRemoteSnapshot {
  const record = asRecord(value);
  const item = asRecord(record.item);
  const trackId = item.type === "track" && typeof item.id === "string" ? item.id : null;
  const device = recordAt(record, ["device"]);
  const deviceId = typeof device.id === "string" ? device.id : undefined;
  const deviceName = typeof device.name === "string" ? device.name : undefined;
  const volumePercent = numberValue(device.volume_percent);
  return {
    trackId,
    positionMs: Math.max(0, Math.round(numberValue(record.progress_ms) ?? 0)),
    durationMs: Math.max(0, Math.round(numberValue(item.duration_ms) ?? 0)),
    playing: record.is_playing === true,
    ...(deviceId ? { deviceId } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(volumePercent === undefined ? {} : { volumePercent: Math.round(volumePercent) }),
    fetchedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Small validators                                                    */
/* ------------------------------------------------------------------ */

// Spotify reports "no-op" transport commands as a 403 restriction; they are not
// errors from the user's point of view. Premium and device problems are.
function isNoOpRestriction(error: MusicServiceError): boolean {
  return error.status === 403 && /restriction violated/i.test(error.message);
}

function isValidClientId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value);
}

function isValidToken(value: string): boolean {
  return value.length >= 8 && value.length <= 8_192 && !/[\r\n\0]/.test(value);
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

// Constant-time state comparison so a login callback cannot be brute-forced by
// timing the lookup.
function findPendingLogin(
  pending: Map<string, PendingLogin>,
  state: string,
): { state: string; login: PendingLogin } | null {
  const candidate = Buffer.from(state);
  for (const [known, login] of pending) {
    const knownBytes = Buffer.from(known);
    if (knownBytes.length === candidate.length && timingSafeEqual(knownBytes, candidate)) {
      return { state: known, login };
    }
  }
  return null;
}

function isSpotifyImageHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "i.scdn.co" ||
    host.endsWith(".scdn.co") ||
    host.endsWith(".spotifycdn.com") ||
    host.endsWith(".fbcdn.net"); // Facebook-linked accounts keep their avatar there
}
