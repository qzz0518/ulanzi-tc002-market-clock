import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as neteaseApi from "netease-cloud-music-api-alger";
import {
  arrayAt,
  asRecord,
  MusicServiceError,
  numberValue,
  proxyProfileImage,
  recordAt,
  musicArtUrl,
  stringAt,
  type MusicPlaylist,
  type MusicProfile,
  type MusicProvider,
  type MusicSessionStatus,
  type MusicTrack,
  type MusicTrackDetail,
  type UnknownRecord,
} from "./music/core.ts";
import { buildLyricLines, parseLrc, type LyricsLookup } from "./music/lyrics.ts";
import { parseLrcEndMarkers, parseYrc } from "./music/lyric-timing.ts";
import type { MusicLyricLine } from "./music/core.ts";

export { MusicServiceError } from "./music/core.ts";
export type {
  MusicLyricLine,
  MusicPlaylist,
  MusicProfile,
  MusicSessionStatus,
  MusicTrack,
  MusicTrackDetail,
} from "./music/core.ts";

/**
 * How many liked songs 随机播放 draws before choosing one. They all resolve in a
 * single `song_detail`, so the only reason not to draw more is that the request
 * URL carries every ID.
 */
const RANDOM_LIKED_CANDIDATES = 8;

export type MusicQrState = "waiting" | "scanned" | "confirmed" | "expired";

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
  // 每日推荐歌曲。没有 uid 参数——推荐是按登录 Cookie 算的，所以它必须带凭据。
  recommendSongs(input: { cookie: string }): Promise<GatewayResponse>;
  // 喜欢的歌曲(无序)，只回 ID 列表，要拿到可播放的曲目还得再走一次 songDetail。
  likedSongIds(input: { uid: number; cookie: string }): Promise<GatewayResponse>;
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
  recommendSongs: (input) => neteaseApi.recommend_songs(input),
  likedSongIds: (input) => neteaseApi.likelist(input),
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
    // tmp 名必须逐次唯一：同一进程里并发写会共用 `pid` 后缀，先落地的那次 rename
    // 会把文件抢走，后一次就撞上 ENOENT（Spotify 令牌刷新最容易触发）。
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
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

export class NeteaseMusicService implements MusicProvider {
  readonly id = "netease" as const;
  readonly label = "网易云音乐";
  // The TC002 downloads the MP3 and plays it through MI_AO itself.
  readonly playbackMode = "device-audio" as const;

  private cookie: string | undefined;
  private profile: MusicProfile | undefined;
  private readonly qrLogins = new Map<string, ActiveQrLogin>();

  constructor(
    private readonly options: {
      gateway?: NeteaseGateway;
      sessionStore: MusicSessionStore;
      now?: () => number;
      fetcher?: typeof fetch;
      // Injected so "pick one of the liked songs" can be asserted instead of
      // being a coin flip the test has to tolerate.
      random?: () => number;
    },
  ) {}

  private get gateway(): NeteaseGateway {
    return this.options.gateway ?? defaultNeteaseGateway;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get random(): number {
    return (this.options.random ?? Math.random)();
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
      uid: neteaseId(profile.id, "用户"),
      limit: 50,
      cookie: this.cookie!,
    });
    return arrayAt(asRecord(response.body), ["playlist"])
      .map(parsePlaylist)
      .filter((item): item is MusicPlaylist => item !== null);
  }

  async playlistTracks(id: string): Promise<MusicTrack[]> {
    const response = await this.gateway.playlistTracks({
      id: neteaseId(id, "歌单"),
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

  /**
   * 每日推荐歌曲 — the account's own list, so it needs the login cookie and has
   * no signed-out form. An empty `dailySongs` with a 200 is treated as a failed
   * delivery rather than "you have no recommendations": NetEase always returns
   * ~30 for a real account, and claiming otherwise would be inventing an answer.
   */
  async dailyRecommendations(): Promise<MusicTrack[]> {
    this.requireProfile();
    const response = await this.gateway.recommendSongs({ cookie: this.cookie! });
    const body = assertNeteaseOk(asRecord(response.body), "每日推荐");
    const tracks = arrayAt(body, ["data", "dailySongs"])
      .map(parseTrack)
      .filter((item): item is MusicTrack => item !== null);
    if (tracks.length === 0) {
      throw new MusicServiceError("网易云没有返回今天的推荐歌曲，请稍后重试", 502);
    }
    return tracks;
  }

  /**
   * One random song out of 喜欢的歌曲.
   *
   * The source is `likelist`, not the 我喜欢的音乐 playlist, because the playlist
   * route is capped (`playlistTracks` asks for 200) while `likelist` returns the
   * complete ID set — measured at 1972 on the developer's account. Drawing from
   * the first 200 would make "random" mean "random among the most recently
   * liked". The price is one extra call: IDs alone are not playable, so the
   * draw still goes through `song_detail`.
   *
   * That second call is also why a handful is drawn instead of one. A like list
   * that old contains songs since taken down, and the button promises playback,
   * not a track: the first real click landed on 729638, whose stream 404s. One
   * `song_detail` resolves every candidate and says which of them this account
   * can still play, so the cost of not landing on silence is zero extra calls.
   */
  async randomLikedTrack(): Promise<MusicTrack> {
    const profile = this.requireProfile();
    const response = await this.gateway.likedSongIds({
      uid: neteaseId(profile.id, "用户"),
      cookie: this.cookie!,
    });
    const body = assertNeteaseOk(asRecord(response.body), "喜欢的歌曲");
    const ids = arrayAt(body, ["ids"])
      .map((value) => numberValue(value))
      .filter((id): id is number => id !== undefined && Number.isSafeInteger(id) && id > 0);
    if (ids.length === 0) {
      throw new MusicServiceError("这个网易云账号还没有喜欢的歌曲，先在网易云里红心几首吧", 404);
    }

    const candidates = this.drawIds(ids, RANDOM_LIKED_CANDIDATES);
    const detailBody = assertNeteaseOk(
      asRecord((await this.gateway.songDetail({
        ids: candidates.join(","),
        cookie: this.cookie!,
      })).body),
      "歌曲详情",
    );
    const songs = arrayAt(detailBody, ["songs"]);
    const playable = playableSongIds(detailBody);
    // Walk the draw in order so the pick stays the random one, not whichever
    // song NetEase happened to list first.
    for (const id of candidates) {
      if (playable && !playable.has(id)) continue;
      const track = parseTrack(songs.find((song) => numberValue(asRecord(song).id) === id));
      if (track) return track;
    }
    throw new MusicServiceError(
      "随机抽到的几首歌当前都无法播放（版权或会员限制），再点一次试试",
      502,
    );
  }

  /** `count` distinct IDs at random, or fewer when the list is short. */
  private drawIds(ids: readonly number[], count: number): number[] {
    const drawn: number[] = [];
    const seen = new Set<number>();
    // Math.random() is [0, 1), but a stub returning 1 must not index past the
    // end. The attempt cap keeps a constant stub (or a tiny list) from spinning.
    for (let attempt = 0; attempt < count * 4 && drawn.length < count; attempt += 1) {
      const id = ids[Math.min(ids.length - 1, Math.floor(this.random * ids.length))]!;
      if (seen.has(id)) continue;
      seen.add(id);
      drawn.push(id);
    }
    return drawn;
  }

  async trackDetail(id: string): Promise<MusicTrackDetail> {
    const numericId = neteaseId(id, "歌曲");
    const auth = this.cookie ? { cookie: this.cookie } : {};
    const [detailResponse, lyricResponse] = await Promise.all([
      this.gateway.songDetail({ ids: String(numericId), ...auth }),
      this.gateway.lyric({ id: numericId, ...auth }),
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
    return await proxyProfileImage({
      url: profile.avatarUrl,
      isAllowedHost: isAllowedMusicHost,
      ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
      sourceLabel: "网易云",
    });
  }

  async stream(id: string, range?: string | null): Promise<Response> {
    const numericId = neteaseId(id, "歌曲");
    if (range && (range.length > 80 || !/^bytes=\d*-\d*$/.test(range))) {
      throw new MusicServiceError("音频 Range 请求无效");
    }
    const response = await this.gateway.songUrl({
      id: numericId,
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

// NetEase carries line-synced lyrics for a lot of Mandarin and Cantopop that the
// open lyric databases miss, and searching it needs no login — so it doubles as
// the last resort for tracks played through Spotify.
export class NeteaseLyricsFallback implements LyricsLookup {
  constructor(private readonly service: NeteaseMusicService) {}

  async lyrics(track: MusicTrack): Promise<MusicLyricLine[]> {
    const query = [track.title, track.artists[0] ?? ""].filter(Boolean).join(" ");
    if (!query) return [];
    const candidates = await this.service.search(query);
    const match = candidates.find((candidate) =>
      normalizeTitle(candidate.title) === normalizeTitle(track.title) &&
      (track.durationMs === 0 || Math.abs(candidate.durationMs - track.durationMs) < 12_000)
    );
    if (!match) return [];
    const detail = await this.service.trackDetail(match.id);
    const durationMs = track.durationMs;
    if (durationMs <= 0) return detail.lyrics;
    // Fit the NetEase timeline to the Spotify recording, and NOTHING else.
    //
    // This used to re-derive every end as the next line's start, which quietly
    // undid the whole point of the sung end for the one path that can actually
    // reach word-level timing: a Spotify track whose lyrics came from NetEase
    // may well have `yrc`, and the highlight would still have crawled through
    // the instrumental. The recording lengths differ (a remaster, a radio edit),
    // so the only legitimate correction here is the two ways a foreign timeline
    // can overrun this one.
    return detail.lyrics
      .filter((line) => line.startMs < durationMs)
      .map((line) => (line.endMs > durationMs && durationMs > line.startMs
        // Truncated by the recording, not by the words — say so.
        ? { ...line, endMs: durationMs, endSource: "next" as const }
        : line));
  }
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[\s　]+/g, "").replace(/[（(].*?[)）]/g, "");
}

function parseProfile(value: unknown): MusicProfile | null {
  const record = asRecord(value);
  // Sessions saved before the multi-provider split store the numeric `userId`.
  const id = typeof record.id === "string" && record.id.trim()
    ? record.id.trim()
    : String(numberValue(record.userId) ?? "");
  const nickname = typeof record.nickname === "string" ? record.nickname.trim() : "";
  if (!/^\d{1,18}$/.test(id) || id === "0" || !nickname) return null;
  const avatarUrl = typeof record.avatarUrl === "string" && record.avatarUrl.startsWith("https://")
    ? record.avatarUrl
    : undefined;
  return { provider: "netease", id, nickname, ...(avatarUrl ? { avatarUrl } : {}) };
}

function parsePlaylist(value: unknown): MusicPlaylist | null {
  const record = asRecord(value);
  const id = numberValue(record.id);
  const trackCount = numberValue(record.trackCount);
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || id <= 0 || !name) return null;
  const coverUrl = musicArtUrl(record.coverImgUrl);
  return {
    id: String(id),
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
  const coverUrl = musicArtUrl(albumRecord.picUrl ?? albumRecord.blurPicUrl);
  return {
    id: String(id),
    title,
    artists,
    album,
    durationMs,
    ...(coverUrl ? { coverUrl } : {}),
  };
}

/**
 * Turns one `lyric_new` response into timed lines, preferring the word-level
 * track when the song has one.
 *
 * `lyric_new` describes itself as 新版歌词 - 包含逐字歌词 and asks for `yv/ytv/yrv`,
 * so every call already came back with a `yrc` field — NetEase's karaoke-grade
 * word timings — and this function read only `lrc`. About 19-25% of tracks
 * carry it; for those nothing about the line's end is estimated any more.
 *
 * The translation source has to move with it. `tlyric` is aligned to the `lrc`
 * timeline and `ytlrc` to the `yrc` one, and the two timelines are independent:
 * on 孤勇者 they have 69 and 57 lines with a single shared timestamp between
 * them. Keeping `tlyric` while switching to `yrc` would silently hang the wrong
 * translation on most lines (measured: 5% of `tlyric` starts land on a yrc
 * line, versus 100% of `ytlrc`).
 */
function parseLyricResponse(body: UnknownRecord, trackDurationMs: number): MusicLyricLine[] {
  const wordTimed = parseYrc(stringAt(body, ["yrc", "lyric"]));
  if (wordTimed.length > 0) {
    const translated = new Map(parseLrc(stringAt(body, ["ytlrc", "lyric"]))
      .map((line) => [line.startMs, line.text] as const));
    return buildLyricLines(wordTimed, trackDurationMs, translated);
  }
  const original = parseLrc(stringAt(body, ["lrc", "lyric"]));
  const translated = new Map(parseLrc(stringAt(body, ["tlyric", "lyric"]))
    .map((line) => [line.startMs, line.text] as const));
  return buildLyricLines(original, trackDurationMs, translated, {
    // NetEase's own line-level LRC carries end marks too, on the tracks that
    // were downgraded from word-level upstream.
    endMarkersMs: parseLrcEndMarkers(stringAt(body, ["lrc", "lyric"])),
  });
}

/**
 * The IDs NetEase says this account can actually play right now.
 *
 * `song_detail` answers with a `privileges` entry per song, whose `pl` is the
 * bitrate this account may stream at — 0 for a track that has since been taken
 * down. Returns null when the response carries no privileges at all: that means
 * "not stated", not "nothing is playable", and the caller must not read it as a
 * verdict.
 */
function playableSongIds(body: UnknownRecord): Set<number> | null {
  const privileges = arrayAt(body, ["privileges"]);
  if (privileges.length === 0) return null;
  const ids = new Set<number>();
  for (const entry of privileges) {
    const record = asRecord(entry);
    const id = numberValue(record.id);
    if (id !== undefined && (numberValue(record.pl) ?? 0) > 0) ids.add(id);
  }
  return ids;
}

/**
 * NetEase reports failure as HTTP 200 with a non-200 `code` in the body — a
 * transient `code: 400` on `user_playlist` was observed on a healthy session
 * while this was being written. Reading such a body for its list field yields
 * `[]`, which the console would render as "you have no recommendations". So
 * every call that answers a private question checks the code first and says
 * that the request failed.
 *
 * A body with no `code` at all is left alone: several endpoints simply omit it.
 */
function assertNeteaseOk(body: UnknownRecord, label: string): UnknownRecord {
  const code = numberValue(body.code);
  if (code === undefined || code === 200) return body;
  // 301 需要登录 / 302 需要验证——凭据过期，重新扫码是唯一出路。
  if (code === 301 || code === 302) {
    throw new MusicServiceError("网易云登录已失效，请重新扫码登录", 401);
  }
  const message = typeof body.message === "string"
    ? body.message
    : typeof body.msg === "string" ? body.msg : "";
  throw new MusicServiceError(
    `网易云${label}接口返回 ${code}${message ? `：${message}` : ""}`,
    502,
  );
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

// NetEase's own API is numeric end to end; the provider-neutral layer above is
// string-keyed because Spotify IDs are base62.
function neteaseId(value: string, label: string): number {
  if (!/^\d{1,18}$/.test(value)) throw new MusicServiceError(`${label} ID 无效`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new MusicServiceError(`${label} ID 无效`);
  return id;
}
