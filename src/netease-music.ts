import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as neteaseApi from "netease-cloud-music-api-alger";

type UnknownRecord = Record<string, unknown>;

const MAX_PROFILE_AVATAR_BYTES = 5 * 1024 * 1024;
const PROFILE_AVATAR_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface MusicProfile {
  userId: number;
  nickname: string;
  avatarUrl?: string;
}

export interface MusicPlaylist {
  id: number;
  name: string;
  trackCount: number;
  coverUrl?: string;
}

export interface MusicTrack {
  id: number;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  coverUrl?: string;
}

export interface MusicLyricLine {
  startMs: number;
  endMs: number;
  text: string;
  translation?: string;
}

export interface MusicTrackDetail {
  track: MusicTrack;
  lyrics: MusicLyricLine[];
}

export type MusicQrState = "waiting" | "scanned" | "confirmed" | "expired";

export interface MusicSessionStatus {
  loggedIn: boolean;
  profile?: MusicProfile;
}

export interface MusicQrLogin {
  id: string;
  qrUrl: string;
  expiresAt: string;
}

export interface MusicQrCheck {
  state: MusicQrState;
  profile?: MusicProfile;
}

interface GatewayResponse {
  body: unknown;
  cookie?: string[];
}

export interface NeteaseGateway {
  loginQrKey(input: { cookie?: string }): Promise<GatewayResponse>;
  loginQrCreate(input: { key: string; cookie?: string }): Promise<GatewayResponse>;
  loginQrCheck(input: { key: string; cookie?: string }): Promise<GatewayResponse>;
  userAccount(input: { cookie: string }): Promise<GatewayResponse>;
  userPlaylists(input: { uid: number; limit: number; cookie: string }): Promise<GatewayResponse>;
  playlistTracks(input: { id: number; limit: number; cookie?: string }): Promise<GatewayResponse>;
  search(input: { keywords: string; limit: number; cookie?: string }): Promise<GatewayResponse>;
  songDetail(input: { ids: string; cookie?: string }): Promise<GatewayResponse>;
  lyric(input: { id: number; cookie?: string }): Promise<GatewayResponse>;
  songUrl(input: { id: number; level: "standard"; cookie?: string }): Promise<GatewayResponse>;
}

export const defaultNeteaseGateway: NeteaseGateway = {
  loginQrKey: (input) => neteaseApi.login_qr_key(input),
  loginQrCreate: (input) => neteaseApi.login_qr_create({ ...input, qrimg: false }),
  loginQrCheck: (input) => neteaseApi.login_qr_check(input),
  userAccount: (input) => neteaseApi.user_account(input),
  userPlaylists: (input) => neteaseApi.user_playlist(input),
  playlistTracks: (input) => neteaseApi.playlist_track_all(input),
  search: (input) => neteaseApi.cloudsearch({ ...input, type: 1 }),
  songDetail: (input) => neteaseApi.song_detail(input),
  lyric: (input) => neteaseApi.lyric_new(input),
  songUrl: (input) => neteaseApi.song_url_v1(
    input as Parameters<typeof neteaseApi.song_url_v1>[0],
  ),
};

interface StoredMusicSession {
  version: 1;
  cookie: string;
  profile: MusicProfile;
}

export class MusicSessionStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StoredMusicSession | null> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      const record = asRecord(raw);
      if (record.version !== 1 || typeof record.cookie !== "string") return null;
      const profile = parseProfile(record.profile);
      if (!profile || !validCookie(record.cookie)) return null;
      return { version: 1, cookie: record.cookie, profile };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(cookie: string, profile: MusicProfile): Promise<void> {
    if (!validCookie(cookie)) throw new MusicServiceError("网易云登录凭据格式无效", 502);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    const data: StoredMusicSession = { version: 1, cookie, profile };
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

interface ActiveQrLogin {
  key: string;
  expiresAtMs: number;
}

export class MusicServiceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "MusicServiceError";
  }
}

export class NeteaseMusicService {
  private cookie: string | undefined;
  private profile: MusicProfile | undefined;
  private readonly qrLogins = new Map<string, ActiveQrLogin>();

  constructor(
    private readonly options: {
      gateway?: NeteaseGateway;
      sessionStore: MusicSessionStore;
      now?: () => number;
      fetcher?: typeof fetch;
    },
  ) {}

  private get gateway(): NeteaseGateway {
    return this.options.gateway ?? defaultNeteaseGateway;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  async initialize(): Promise<void> {
    const stored = await this.options.sessionStore.load();
    this.cookie = stored?.cookie;
    this.profile = stored?.profile;
  }

  status(): MusicSessionStatus {
    return this.cookie && this.profile
      ? { loggedIn: true, profile: structuredClone(this.profile) }
      : { loggedIn: false };
  }

  async createQrLogin(): Promise<MusicQrLogin> {
    this.pruneQrLogins();
    const keyResponse = await this.gateway.loginQrKey(this.cookie ? { cookie: this.cookie } : {});
    const keyBody = asRecord(keyResponse.body);
    const key = stringAt(keyBody, ["data", "unikey"]);
    if (!key) throw new MusicServiceError("网易云没有返回二维码密钥，请稍后重试", 502);

    const qrResponse = await this.gateway.loginQrCreate({
      key,
      ...(this.cookie ? { cookie: this.cookie } : {}),
    });
    const qrUrl = stringAt(asRecord(qrResponse.body), ["data", "qrurl"]);
    if (!qrUrl || !isNeteaseLoginUrl(qrUrl)) {
      throw new MusicServiceError("网易云没有返回有效的登录二维码", 502);
    }

    const id = randomUUID();
    const expiresAtMs = this.now + 3 * 60_000;
    this.qrLogins.set(id, { key, expiresAtMs });
    return { id, qrUrl, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async checkQrLogin(id: string): Promise<MusicQrCheck> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new MusicServiceError("二维码会话无效");
    const login = this.qrLogins.get(id);
    if (!login || login.expiresAtMs <= this.now) {
      this.qrLogins.delete(id);
      return { state: "expired" };
    }

    const response = await this.gateway.loginQrCheck({
      key: login.key,
      ...(this.cookie ? { cookie: this.cookie } : {}),
    });
    const body = asRecord(response.body);
    const code = numberValue(body.code);
    if (code === 800) {
      this.qrLogins.delete(id);
      return { state: "expired" };
    }
    if (code === 801) return { state: "waiting" };
    if (code === 802) return { state: "scanned" };
    if (code !== 803) throw new MusicServiceError("网易云返回了无法识别的扫码状态", 502);

    const cookie = typeof body.cookie === "string"
      ? body.cookie
      : response.cookie?.filter(Boolean).join(";");
    if (!cookie || !validCookie(cookie)) {
      throw new MusicServiceError("扫码已确认，但网易云没有返回有效登录凭据", 502);
    }
    const profile = await this.fetchProfile(cookie);
    await this.options.sessionStore.save(cookie, profile);
    this.cookie = cookie;
    this.profile = profile;
    this.qrLogins.delete(id);
    return { state: "confirmed", profile: structuredClone(profile) };
  }

  async logout(): Promise<void> {
    this.cookie = undefined;
    this.profile = undefined;
    this.qrLogins.clear();
    await this.options.sessionStore.clear();
  }

  async playlists(): Promise<MusicPlaylist[]> {
    const profile = this.requireProfile();
    const response = await this.gateway.userPlaylists({
      uid: profile.userId,
      limit: 50,
      cookie: this.cookie!,
    });
    return arrayAt(asRecord(response.body), ["playlist"])
      .map(parsePlaylist)
      .filter((item): item is MusicPlaylist => item !== null);
  }

  async playlistTracks(id: number): Promise<MusicTrack[]> {
    assertPositiveId(id, "歌单");
    const response = await this.gateway.playlistTracks({
      id,
      limit: 200,
      ...(this.cookie ? { cookie: this.cookie } : {}),
    });
    return arrayAt(asRecord(response.body), ["songs"])
      .map(parseTrack)
      .filter((item): item is MusicTrack => item !== null);
  }

  async search(query: string): Promise<MusicTrack[]> {
    const normalized = query.trim();
    if (normalized.length < 1 || normalized.length > 80) {
      throw new MusicServiceError("搜索词需要包含 1–80 个字符");
    }
    const response = await this.gateway.search({
      keywords: normalized,
      limit: 30,
      ...(this.cookie ? { cookie: this.cookie } : {}),
    });
    return arrayAt(asRecord(response.body), ["result", "songs"])
      .map(parseTrack)
      .filter((item): item is MusicTrack => item !== null);
  }

  async trackDetail(id: number): Promise<MusicTrackDetail> {
    assertPositiveId(id, "歌曲");
    const auth = this.cookie ? { cookie: this.cookie } : {};
    const [detailResponse, lyricResponse] = await Promise.all([
      this.gateway.songDetail({ ids: String(id), ...auth }),
      this.gateway.lyric({ id, ...auth }),
    ]);
    const track = parseTrack(arrayAt(asRecord(detailResponse.body), ["songs"])[0]);
    if (!track) throw new MusicServiceError("没有找到这首歌曲", 404);
    return {
      track,
      lyrics: parseLyricResponse(asRecord(lyricResponse.body), track.durationMs),
    };
  }

  async avatar(): Promise<Response> {
    const profile = this.requireProfile();
    if (!profile.avatarUrl) {
      throw new MusicServiceError("当前网易云账号没有头像", 404);
    }

    const upstreamUrl = new URL(profile.avatarUrl);
    if (upstreamUrl.protocol !== "https:" || !isAllowedMusicHost(upstreamUrl)) {
      throw new MusicServiceError("网易云返回了不受信任的头像地址", 502);
    }

    const fetcher = this.options.fetcher ?? fetch;
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
      throw new MusicServiceError("无法读取网易云头像，请稍后重试", 502);
    }

    const finalUrl = upstream.url ? new URL(upstream.url) : upstreamUrl;
    if (finalUrl.protocol !== "https:" || !isAllowedMusicHost(finalUrl)) {
      upstream.body?.cancel().catch(() => undefined);
      throw new MusicServiceError("网易云头像跳转到了不受信任的地址", 502);
    }
    if (!upstream.ok) {
      upstream.body?.cancel().catch(() => undefined);
      throw new MusicServiceError(`网易云头像源返回 HTTP ${upstream.status}`, 502);
    }

    const reportedContentType = (upstream.headers.get("Content-Type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const contentType = reportedContentType === "image/jpg"
      ? "image/jpeg"
      : reportedContentType;
    if (!PROFILE_AVATAR_MIME_TYPES.has(contentType)) {
      upstream.body?.cancel().catch(() => undefined);
      throw new MusicServiceError("网易云头像源没有返回受支持的图片格式", 502);
    }

    const bytes = await readBoundedAvatar(upstream, MAX_PROFILE_AVATAR_BYTES);
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

  async stream(id: number, range?: string | null): Promise<Response> {
    assertPositiveId(id, "歌曲");
    if (range && (range.length > 80 || !/^bytes=\d*-\d*$/.test(range))) {
      throw new MusicServiceError("音频 Range 请求无效");
    }
    const response = await this.gateway.songUrl({
      id,
      level: "standard",
      ...(this.cookie ? { cookie: this.cookie } : {}),
    });
    const url = stringAt(asRecord(response.body), ["data", "0", "url"]);
    if (!url) throw new MusicServiceError("当前账号或地区无法取得这首歌的播放地址", 404);
    const upstreamUrl = new URL(url);
    if (!isAllowedMusicHost(upstreamUrl)) {
      throw new MusicServiceError("网易云返回了不受信任的音频地址", 502);
    }

    const headers = new Headers({ "User-Agent": "Pixel-Market-TC002/3" });
    if (range) headers.set("Range", range);
    const fetcher = this.options.fetcher ?? fetch;
    const upstream = await fetcher(upstreamUrl, { headers, redirect: "follow" });
    if (!upstream.ok && upstream.status !== 206) {
      upstream.body?.cancel().catch(() => undefined);
      throw new MusicServiceError(`网易云音频源返回 HTTP ${upstream.status}`, 502);
    }
    const outputHeaders = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Type": upstream.headers.get("Content-Type") ?? "audio/mpeg",
      "X-Content-Type-Options": "nosniff",
    });
    for (const name of ["Accept-Ranges", "Content-Length", "Content-Range"]) {
      const value = upstream.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: outputHeaders });
  }

  sessionFingerprint(): string | null {
    return this.cookie ? createHash("sha256").update(this.cookie).digest("hex").slice(0, 12) : null;
  }

  private async fetchProfile(cookie: string): Promise<MusicProfile> {
    const response = await this.gateway.userAccount({ cookie });
    const body = asRecord(response.body);
    const profile = parseProfile(body.profile) ?? parseProfile(recordAt(body, ["data", "profile"]));
    if (!profile) throw new MusicServiceError("登录成功，但没有取得网易云用户资料", 502);
    return profile;
  }

  private requireProfile(): MusicProfile {
    if (!this.cookie || !this.profile) throw new MusicServiceError("请先使用网易云音乐扫码登录", 401);
    return this.profile;
  }

  private pruneQrLogins(): void {
    for (const [id, login] of this.qrLogins) {
      if (login.expiresAtMs <= this.now) this.qrLogins.delete(id);
    }
  }
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function recordAt(value: UnknownRecord, path: string[]): UnknownRecord {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)[key];
  return asRecord(current);
}

function stringAt(value: UnknownRecord, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else current = asRecord(current)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function arrayAt(value: UnknownRecord, path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)[key];
  return Array.isArray(current) ? current : [];
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseProfile(value: unknown): MusicProfile | null {
  const record = asRecord(value);
  const userId = numberValue(record.userId);
  const nickname = typeof record.nickname === "string" ? record.nickname.trim() : "";
  if (!userId || userId <= 0 || !nickname) return null;
  const avatarUrl = typeof record.avatarUrl === "string" && record.avatarUrl.startsWith("https://")
    ? record.avatarUrl
    : undefined;
  return { userId, nickname, ...(avatarUrl ? { avatarUrl } : {}) };
}

function parsePlaylist(value: unknown): MusicPlaylist | null {
  const record = asRecord(value);
  const id = numberValue(record.id);
  const trackCount = numberValue(record.trackCount);
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || id <= 0 || !name) return null;
  const coverUrl = safeHttpsUrl(record.coverImgUrl);
  return {
    id,
    name,
    trackCount: Math.max(0, Math.floor(trackCount ?? 0)),
    ...(coverUrl ? { coverUrl } : {}),
  };
}

function parseTrack(value: unknown): MusicTrack | null {
  const record = asRecord(value);
  const id = numberValue(record.id);
  const title = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || id <= 0 || !title) return null;
  const artistSource = Array.isArray(record.ar)
    ? record.ar
    : Array.isArray(record.artists)
      ? record.artists
      : [];
  const artists = artistSource
    .map((artist) => asRecord(artist).name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
  const albumRecord = asRecord(record.al ?? record.album);
  const album = typeof albumRecord.name === "string" ? albumRecord.name.trim() : "";
  const durationMs = Math.max(0, Math.floor(numberValue(record.dt ?? record.duration) ?? 0));
  const coverUrl = safeHttpsUrl(albumRecord.picUrl ?? albumRecord.blurPicUrl);
  return {
    id,
    title,
    artists,
    album,
    durationMs,
    ...(coverUrl ? { coverUrl } : {}),
  };
}

function parseLyricResponse(body: UnknownRecord, trackDurationMs: number): MusicLyricLine[] {
  const original = parseLrc(stringAt(body, ["lrc", "lyric"]));
  const translated = new Map(parseLrc(stringAt(body, ["tlyric", "lyric"]))
    .map((line) => [line.startMs, line.text] as const));
  return original.map((line, index) => ({
    startMs: line.startMs,
    endMs: original[index + 1]?.startMs ?? Math.max(line.startMs + 2_000, trackDurationMs),
    text: line.text,
    ...(translated.get(line.startMs) ? { translation: translated.get(line.startMs) } : {}),
  }));
}

function parseLrc(raw: string | undefined): Array<{ startMs: number; text: string }> {
  if (!raw) return [];
  const parsed: Array<{ startMs: number; text: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (tags.length === 0) continue;
    const text = line.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;
    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      const fraction = tag[3] ?? "0";
      const milliseconds = fraction.length === 1
        ? Number(fraction) * 100
        : fraction.length === 2
          ? Number(fraction) * 10
          : Number(fraction.slice(0, 3));
      parsed.push({ startMs: (minutes * 60 + seconds) * 1_000 + milliseconds, text });
    }
  }
  return parsed.sort((a, b) => a.startMs - b.startMs);
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function validCookie(value: string): boolean {
  return value.length >= 8 && value.length <= 32_768 && !/[\r\n\0]/.test(value);
}

function isNeteaseLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "music.163.com" || url.hostname.endsWith(".music.163.com"));
  } catch {
    return false;
  }
}

function isAllowedMusicHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return ["http:", "https:"].includes(url.protocol) && (
    host === "music.163.com" ||
    host.endsWith(".music.163.com") ||
    host === "126.net" ||
    host.endsWith(".126.net") ||
    host === "netease.com" ||
    host.endsWith(".netease.com")
  );
}

async function readBoundedAvatar(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.body?.cancel().catch(() => undefined);
    throw new MusicServiceError("网易云头像超过 5 MB 限制", 502);
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
        throw new MusicServiceError("网易云头像超过 5 MB 限制", 502);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MusicServiceError) throw error;
    throw new MusicServiceError("读取网易云头像时连接中断", 502);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MusicServiceError(`${label} ID 无效`);
  }
}
