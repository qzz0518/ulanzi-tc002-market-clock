import {
  Cast,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  HardDrive,
  KeyRound,
  ListMusic,
  LogOut,
  MonitorCog,
  Music2,
  Pause,
  PinOff,
  Play,
  Radio,
  RefreshCw,
  Search,
  Shuffle,
  Sparkles,
  Speaker,
  Wifi,
} from "lucide-react";
import {
  Button,
  Chip,
  Input,
  List,
  ListButton,
  SearchField,
  Segmented,
  SegmentedButton,
  Select,
  Slider,
  Spinner,
  Surface,
} from "@cladd-ui/react";
import { QRCodeSVG } from "qrcode.react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  isMusicMode,
  type MusicMode,
} from "@/components/music/pixel-lyric-modes";
import { PlayModeButton } from "@/components/music/play-mode-button";
import {
  isMusicSkin,
  MusicThemePanel,
  PixelLyricsPreview,
  type MusicSkin,
  type PixelLyricLine,
} from "@/components/music/pixel-lyrics-preview";
import { FirmwarePanel, useFirmwarePanel } from "@/components/firmware-panel";
import { api, jsonApi } from "@/lib/api";
import { createLatestTaskRunner, type LatestTaskRunner } from "@/lib/latest-task-runner";
import { activeLyricIndexAt, lyricWindowAt } from "@/lib/music-playback";
import {
  deviceIsLoadingTrack,
  effectiveDurationMs as playbackDurationMs,
  musicPlaybackStore,
} from "@/lib/music-playback-store";
import { useMusicPlayback } from "@/lib/use-music-playback";
import { renderMirrorFrames, type MirrorFrame } from "@/lib/music-mirror";
import {
  loadDailyRecommendations,
  playRandomLikedTrack,
} from "@/lib/netease-discovery";
import { spectrumForTrack, type SpectrumLookup } from "@/lib/spectrum-timeline";
import { useZosFocus } from "@/lib/use-zos-focus";
import { ZOS_MUSIC_FOCUS } from "@/lib/zos-link";
import { errorMessage } from "@/lib/utils";
import type { FirmwareMode } from "@/lib/firmware-mode";
import type {
  MusicOverview,
  MusicPlaylist,
  MusicProfile,
  MusicProviderId,
  MusicRemoteDevice,
  MusicSessionStatus,
  MusicTrack,
  SpotifyAppStatus,
} from "@/types";

type QrState = "waiting" | "scanned" | "confirmed" | "expired";

interface QrLogin {
  id: string;
  qrUrl: string;
  expiresAt: string;
}

const SESSION_CONFIRMATION = "START_TC002_MUSIC_SESSION";
const TRACKS_PER_PAGE = 20;
// 歌单加载失败后的退避重试节奏，最后一次之后就把错误留给用户处理。
const PLAYLIST_RETRY_DELAYS = [2_000, 5_000, 12_000] as const;
const SPOTIFY_DASHBOARD_URL = "https://developer.spotify.com/dashboard";
const PROVIDER_COPY: Record<MusicProviderId, {
  label: string;
  eyebrow: string;
  blurb: string;
  searchHint: string;
}> = {
  netease: {
    label: "网易云",
    eyebrow: "SOURCE / NETEASE",
    blurb: "搜索网易云音乐，或从你的歌单中选择。",
    searchHint: "例如：夜航",
  },
  spotify: {
    label: "Spotify",
    eyebrow: "SOURCE / SPOTIFY",
    blurb: "通过 Spotify Connect 控制你的播放设备，时钟同步显示歌词。",
    searchHint: "例如：Midnight City",
  },
};
const MUSIC_SKIN_STORAGE_KEY = "pixel-market.music-skin";
const MUSIC_MODE_STORAGE_KEY = "pixel-market.music-mode";
const MUSIC_ACCENT_STORAGE_KEY = "pixel-market.music-accent";

/**
 * Custom property `music-player.css` flips inside its `@container` query.
 *
 * The rail/stack split is decided by the stage's own inline size, not the
 * viewport's, so JS cannot answer it with a media query — and restating `49rem`
 * here would be a second threshold free to drift away from the first. Instead
 * the container query itself hands the answer over: `0` stacked, `1` in the
 * rail. One number, and it lives where the layout does.
 */
const LYRICS_RAIL_FLAG = "--music-lyrics-rail";

/**
 * How many rows the stacked tape shows, and where the playhead sits in them.
 * The active line lands second from the top: one line of where the song has
 * been, three of what is coming.
 */
const STACKED_LYRIC_LEAD = 1;
const STACKED_LYRIC_ROWS = 5;

/**
 * Which lyric rows the tape shows, given the layout it is in.
 *
 * In the rail the tape is a full-height column with its own scroller, so it
 * holds the whole song and follows the playhead by scrolling: five rows could
 * never reach the bottom of that column, and the void would just move inside
 * the card. Stacked, the tape is in document flow with nothing bounding it —
 * the whole song there ends the page in a few thousand pixels of lyrics and
 * buries the sections below it, and bounding it instead would put a scroll
 * trap under a thumb. So stacked it goes back to a window re-cut around the
 * playhead, which is what following the song looked like before the rail.
 *
 * The rail branch returns `rows` itself and the window is a slice of those
 * same elements, so neither branch re-creates a row: whatever memoisation the
 * caller did survives both.
 */
export function lyricTapeRows<Row>(
  rows: readonly Row[],
  activeIndex: number,
  railActive: boolean,
): readonly Row[] {
  if (railActive) return rows;
  // Clamped at both ends rather than offset from the playhead: the old slice
  // was `activeIndex - 1 … activeIndex + 4`, which showed three rows before the
  // first line landed and four on it, so the card grew by a row twice in the
  // opening bars. Anchoring the length instead keeps it one height throughout.
  const start = Math.max(0, Math.min(activeIndex - STACKED_LYRIC_LEAD, rows.length - STACKED_LYRIC_ROWS));
  return rows.slice(start, start + STACKED_LYRIC_ROWS);
}

function formatTime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "0:00";
  const seconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function artistLabel(track: MusicTrack | undefined): string {
  return track?.artists.join(" / ") || "未知音乐人";
}

// The guidance block moved into the shared firmware panel; the re-export
// keeps this module the historical import site.
export { DeviceReconnectGuidance } from "@/components/firmware-panel";

export function MusicAccountAvatar({ profile }: { profile: MusicProfile }) {
  const initial = Array.from(profile.nickname.trim() || "云")[0] ?? "云";
  // The URL names the account it belongs to. Both sources used to share one
  // bare /api/music/avatar, so switching between them left the browser serving
  // the previous account's picture for an identical URL.
  const source = `/api/music/avatar?provider=${profile.provider}&account=${encodeURIComponent(profile.id)}`;
  return (
    <span className="music-account-strip__avatar" aria-hidden="true">
      <span className="music-account-strip__avatar-fallback">{initial}</span>
      {profile.avatarUrl && (
        <img
          key={source}
          className="music-account-strip__avatar-image"
          src={source}
          alt=""
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      )}
    </span>
  );
}

// Album art through the same-origin proxy (`img-src 'self'` blocks provider
// CDNs). The typographic fallback stays layered underneath so a missing or
// failing cover degrades to the editorial mono glyph instead of a broken image.
function MusicCoverArt({ track, fallback, className }: {
  track: MusicTrack;
  fallback: string;
  className?: string;
}) {
  const src = track.coverUrl
    ? `/api/music/art?url=${encodeURIComponent(track.coverUrl)}`
    : null;
  return (
    <span className={"music-cover" + (className ? ` ${className}` : "")} aria-hidden="true">
      <span className="music-cover__fallback">{fallback}</span>
      {src && (
        <img
          key={src}
          className="music-cover__image"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      )}
    </span>
  );
}

interface MusicPlayerProps {
  onFirmwareOnlineChange?: (online: boolean) => void;
  // 时钟当前跑的固件。ZOS 下 /api/music/mirror 那条同屏链路不存在（它写的是
  // 官方 Custom App），但设备自带音乐页——由服务把 Connect 的播放信息喂过去。
  firmwareMode?: FirmwareMode;
}

// A named props object rather than an inline type with a `= {}` default: the
// default made the parameter optional, which collapsed the inferred props type
// to `{}` under createElement and blocked passing any prop from a test.
export function MusicPlayer({
  onFirmwareOnlineChange,
  firmwareMode = "official",
}: MusicPlayerProps) {
  const zos = firmwareMode === "zos";
  // ZOS 的固件已经能接住非频道 focus（真机实测见 zos-link.ts 的 ZOS_MUSIC_FOCUS），
  // 所以「时钟音乐页」是一个真的导航动作，而不是一句状态说明。
  const zosFocus = useZosFocus(zos);
  const zosMusicPinned = zosFocus.pinnedOn(ZOS_MUSIC_FOCUS);
  // Playback lives above the tabs (lib/music-playback-store.ts): this view is a
  // window onto it, not its owner. Switching to 内容 used to unmount the audio
  // element along with this component, which did not "forget" the session — it
  // demolished the player. `retain` keeps the device-state poll running while
  // this view is on screen even before a track is chosen.
  const playback = useMusicPlayback(true);
  const store = musicPlaybackStore();
  const selected = playback.detail;
  const tracks = playback.queue;
  const sourceLabel = playback.queueLabel;
  const currentMs = playback.positionMs;
  const playing = playback.playing;
  const trackBusy = playback.loading;
  const playbackError = playback.error;
  const deviceOnline = playback.deviceOnline;
  const [overview, setOverview] = useState<MusicOverview | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [spotifyApp, setSpotifyApp] = useState<SpotifyAppStatus | null>(null);
  const [clientIdDraft, setClientIdDraft] = useState("");
  const [redirectDraft, setRedirectDraft] = useState("");
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [spotifyWaiting, setSpotifyWaiting] = useState(false);
  const [spotifyDevices, setSpotifyDevices] = useState<MusicRemoteDevice[]>([]);
  // What the Spotify session looked like when consent was launched, so the
  // waiting poll can tell "nothing happened yet" from "the session changed".
  const loginGoalRef = useRef<{ loggedIn: boolean } | null>(null);
  const [session, setSession] = useState<MusicSessionStatus | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [qrLogin, setQrLogin] = useState<QrLogin | null>(null);
  const [qrState, setQrState] = useState<QrState>("waiting");
  const [qrBusy, setQrBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | "">("");
  const [trackPage, setTrackPage] = useState(0);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  // 哪一个发现按钮正在跑——两个按钮各转各的圈，而不是一起变灰。
  const [discoveryBusy, setDiscoveryBusy] = useState<"random" | "daily" | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [playlistReloadKey, setPlaylistReloadKey] = useState(0);
  const playlistRetryRef = useRef(0);
  // 固件侧载的状态、动作与抽屉都在共享面板里（音乐/游戏两页同一套流程）。
  const firmwarePanel = useFirmwarePanel({
    apiPrefix: "/api/music",
    confirmation: SESSION_CONFIRMATION,
    firmwareLabel: "音乐固件",
    firmwareMode,
  });
  const [mirrorOn, setMirrorOn] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const mirrorRunnerRef = useRef<LatestTaskRunner<{ frames: MirrorFrame[] }> | null>(null);
  const [spectrum, setSpectrum] = useState<{
    trackId: string;
    lookup: SpectrumLookup;
  } | null>(null);
  const trackProgressRef = useRef(0);
  // Defaults must match sDeviceState's in src/control-api.ts, which is also what
  // the two firmwares start on. This one used to be "ticker" — invisible while
  // only the sideloaded player read the theme, but under ZOS it means the
  // preview and the panel disagree from first paint, before anyone has clicked.
  const [skin, setSkin] = useState<MusicSkin>("signal");
  const [mode, setMode] = useState<MusicMode>("spotlight");
  const [accent, setAccent] = useState<string | null>(null);
  const [dragMs, setDragMs] = useState<number | null>(null);
  // Mirrors dragMs so the pointer-up commit never reads a stale value while a
  // continuous slider onChange is still flushing through React state.
  const dragMsRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  // The rail card, not the tape: `List` and `ListButton` are cladd components,
  // so the two elements the auto-follow needs are reached by query from the one
  // plain DOM node this file owns rather than by trusting them to forward refs.
  const lyricsPanelRef = useRef<HTMLElement | null>(null);
  // The grid the container query styles. Its inline size IS the query's, so one
  // node answers both halves of the question below: how wide, and what the CSS
  // decided at that width.
  const stageGridRef = useRef<HTMLDivElement | null>(null);
  // True while the lyrics are the full-height rail, false while the stage is
  // stacked. Starts true because that is the branch that is correct with no JS
  // at all — SSR, and the frame before the observer first reports. The window
  // is only right if something keeps re-cutting it; the whole song is right
  // even if nothing ever runs again.
  const [lyricsRailActive, setLyricsRailActive] = useState(true);

  useEffect(() => {
    const stage = stageGridRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    // Reading the flag rather than comparing widths keeps the threshold in the
    // stylesheet; the observer is only here to say *when* to re-read it. It
    // fires once on observe, so the first paint's guess is corrected before the
    // user can act on it. Re-reading is a style recalc, but only on resize.
    const read = () => {
      setLyricsRailActive(
        getComputedStyle(stage).getPropertyValue(LYRICS_RAIL_FLAG).trim() === "1",
      );
    };
    const observer = new ResizeObserver(read);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const activeProviderId: MusicProviderId = overview?.active ?? "netease";
  const activeProvider = overview?.providers.find((entry) => entry.id === activeProviderId);
  // Remote mode = the audio lives on a Spotify Connect player, so the studio and
  // the TC002 are both remotes with a mirrored playhead instead of players.
  const remoteMode = activeProvider?.playbackMode === "remote";
  const providerCopy = PROVIDER_COPY[activeProviderId];
  // The device-state subscription below owns no dependencies; it reads the live
  // source through this ref to notice when the server and the page have drifted.
  const activeProviderIdRef = useRef<MusicProviderId>("netease");
  activeProviderIdRef.current = activeProviderId;

  // Which source the transport belongs to. The store cannot ask — the provider
  // overview is this view's request — so the routing decision is pushed down
  // rather than duplicated.
  useEffect(() => {
    store.setSource(activeProviderId, remoteMode ? "remote" : "device-audio");
  }, [activeProviderId, remoteMode, store]);

  // 真 FFT 只在「这个浏览器就是播放器、且屏幕只归预览管」的时候才取。两个排除
  // 项是同一条规则的两半：`deviceOnline` 是侧载歌词固件的心跳，`zos` 是时钟上跑
  // 着 ZOS——两种固件画的都是 LyricModes.h 那套确定性伪频谱，谁也不做 FFT。预览
  // 里跳着真频谱、面板上跳着 hash 频谱，下面还挂一句「此音源为模拟律动」，就是
  // 三端各讲一个故事，而用户正是照着预览挑的主题。
  useEffect(() => {
    let cancelled = false;
    setSpectrum(null);
    const trackId = selected?.track.id;
    if (!trackId || activeProviderId !== "netease" || deviceOnline || zos) return;
    void spectrumForTrack(trackId).then((lookup) => {
      if (!cancelled && lookup) setSpectrum({ trackId, lookup });
    });
    return () => {
      cancelled = true;
    };
  }, [activeProviderId, deviceOnline, selected?.track.id, zos]);
  const activeSpectrum = activeProviderId === "netease"
    && !deviceOnline
    && !zos
    && spectrum !== null
    && spectrum.trackId === selected?.track.id
    ? spectrum.lookup
    : undefined;

  // One request answers "which source is live" and "is it signed in" for both
  // providers, so the studio never shows a stale login state after a switch.
  const loadSession = useCallback(async () => {
    try {
      const result = await jsonApi<{ music: MusicOverview }>("/api/music/providers");
      setOverview(result.music);
      const active = result.music.providers.find((entry) => entry.id === result.music.active);
      setSession(active
        ? { loggedIn: active.loggedIn, ...(active.profile ? { profile: active.profile } : {}) }
        : { loggedIn: false });
      setSessionError(null);
      return result.music;
    } catch (error) {
      setSessionError(errorMessage(error));
      return null;
    }
  }, []);

  const loadSpotifyApp = useCallback(async () => {
    try {
      const result = await jsonApi<{ app: SpotifyAppStatus }>("/api/music/spotify/app");
      setSpotifyApp(result.app);
      setClientIdDraft((current) => current || result.app.clientId || "");
    } catch {
      // The Spotify panel simply stays in its "not configured" state.
    }
  }, []);

  // 固件直连状态上报给工作台：在线时锁定其他视图（官方固件的推送通道此时不存在）。
  useEffect(() => {
    onFirmwareOnlineChange?.(deviceOnline);
  }, [deviceOnline, onFirmwareOnlineChange]);
  useEffect(() => () => onFirmwareOnlineChange?.(false), [onFirmwareOnlineChange]);

  useEffect(() => {
    // 固件包状态由 useFirmwarePanel 在挂载时自行加载。
    void loadSession();
    void loadSpotifyApp();
  }, [loadSession, loadSpotifyApp]);

  // First paint only. The service holds the theme across restarts, so this is
  // not a restore — it is the value to show for the fraction of a second before
  // /state answers, and the first poll overwrites it. Reading it back the other
  // way (pushing localStorage at the service) would make whichever browser
  // loaded last the authority, so opening the console on a phone that has not
  // seen the theme panel in a month would repaint the clock from memory.
  useEffect(() => {
    try {
      const storedSkin = window.localStorage.getItem(MUSIC_SKIN_STORAGE_KEY);
      if (isMusicSkin(storedSkin)) setSkin(storedSkin);
      const storedMode = window.localStorage.getItem(MUSIC_MODE_STORAGE_KEY);
      if (isMusicMode(storedMode)) setMode(storedMode);
      const storedAccent = window.localStorage.getItem(MUSIC_ACCENT_STORAGE_KEY);
      if (storedAccent && /^[0-9a-fA-F]{6}$/.test(storedAccent)) setAccent(storedAccent);
    } catch {
      // Private browsing or a locked-down WebView may disable local storage.
    }
  }, []);

  // The device-state document, as parsed by the store's poll.
  //
  // Everything about the transport (remote playhead, firmware heartbeat, the
  // play/pause echo) is applied there, because it has to keep being applied
  // when this view is not on screen. What is left here is what only a view can
  // answer: which source the page believes is live, and the theme the panel and
  // the preview paint with.
  useEffect(() => store.onDeviceState((fields, meta) => {
    // The service owns which source is live. If the page drifted from it —
    // another tab switched sources, or a re-authorization widened what Spotify
    // allows — pull the truth instead of sitting on a stale screen.
    if (fields.SRC && fields.SRC !== activeProviderIdRef.current) {
      void loadSession();
    }
    // The theme the SERVICE holds wins, and the first delivery is where it
    // lands. The echo is gated on the sequence advancing, and a freshly started
    // service usually serves seq 0 — the same value the store starts on — so
    // without the initial delivery the panel and the preview would sit on
    // whatever this browser happened to remember until the next click. The
    // service persists the theme (ADR 0007), so this adopts a store, not a
    // guess.
    if (!meta.initial && !meta.themeEcho) return;
    if (isMusicSkin(fields.SKIN ?? null)) setSkin(fields.SKIN as MusicSkin);
    if (isMusicMode(fields.MODE ?? null)) setMode(fields.MODE as MusicMode);
    setAccent(fields.ACCENT && fields.ACCENT !== "-" ? fields.ACCENT : null);
  }), [loadSession, store]);

  // Keep the library list on the page holding whatever is playing — the store
  // moves the queue index (mini player, device key press, Connect skip) and the
  // pager follows it.
  useEffect(() => {
    if (playback.queueIndex < 0) return;
    setTrackPage(Math.floor(playback.queueIndex / TRACKS_PER_PAGE));
  }, [playback.queueIndex]);

  useEffect(() => {
    const runner = createLatestTaskRunner<{ frames: MirrorFrame[] }, void>({
      execute: async (input) => {
        await jsonApi("/api/music/mirror", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
      },
      apply: () => setMirrorError(null),
      onError: (error) => setMirrorError(errorMessage(error)),
    });
    mirrorRunnerRef.current = runner;
    return () => {
      mirrorRunnerRef.current = null;
      runner.dispose();
    };
  }, []);

  // Keyed on the source as well as the login state: switching between two
  // signed-in sources leaves `loggedIn` true, so without the source in the
  // dependencies the list cleared by the switch would never be refilled until
  // the whole view remounted.
  useEffect(() => {
    if (!session?.loggedIn) {
      setPlaylists([]);
      return;
    }
    let cancelled = false;
    let retryTimer: number | undefined;
    void jsonApi<{ playlists: MusicPlaylist[] }>("/api/music/playlists")
      .then((result) => {
        if (cancelled) return;
        setPlaylists(result.playlists);
        setLibraryError(null);
        playlistRetryRef.current = 0;
      })
      .catch((error) => {
        if (cancelled) return;
        setLibraryError(`歌单加载失败：${errorMessage(error)}`);
        // 这条横幅没有别的出口：歌单只在切音源或登录态变化时才加载，所以一次瞬时
        // 故障（令牌刷新撞车之类）会把它永久挂在那儿，哪怕其它功能早就恢复了。
        // 自己退避重试，成功即撤下横幅。
        const attempt = playlistRetryRef.current;
        if (attempt >= PLAYLIST_RETRY_DELAYS.length) return;
        playlistRetryRef.current = attempt + 1;
        retryTimer = window.setTimeout(
          () => setPlaylistReloadKey((key) => key + 1),
          PLAYLIST_RETRY_DELAYS[attempt],
        );
      });
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [activeProviderId, session?.loggedIn, playlistReloadKey]);

  useEffect(() => {
    if (!qrLogin || !["waiting", "scanned"].includes(qrState)) return;
    let cancelled = false;
    const check = async () => {
      try {
        const result = await jsonApi<{ login: { state: QrState; profile?: MusicProfile } }>(
          "/api/music/qr/check",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: qrLogin.id }),
          },
        );
        if (cancelled) return;
        setSessionError(null);
        setQrState(result.login.state);
        if (result.login.state === "confirmed" && result.login.profile) {
          setSession({ loggedIn: true, profile: result.login.profile });
          setQrLogin(null);
        }
      } catch (error) {
        if (!cancelled) setSessionError(errorMessage(error));
      }
    };
    const timer = window.setInterval(() => void check(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [qrLogin, qrState]);

  // Memoised on the index rather than on the playhead: the window is stable
  // while a line holds, which is what keeps the mirror effect below from
  // re-rendering the same frames ten times a second. The derivation itself is
  // shared with the store's now-playing report (lib/music-playback.ts), so the
  // panel and the preview cannot drift apart.
  const activeLyricIndex = useMemo(
    () => activeLyricIndexAt(selected?.lyrics, currentMs),
    [currentMs, selected],
  );

  const activeLyric = activeLyricIndex >= 0 ? selected?.lyrics[activeLyricIndex] : undefined;

  const activeLine = useMemo<PixelLyricLine>(
    () => lyricWindowAt(selected, activeLyricIndex),
    [activeLyricIndex, selected],
  );

  /**
   * How the current line's end was decided, in the user's words.
   *
   * Only the two cases worth acting on get a chip: "逐字" when the source really
   * timed every word, "估算" when we bounded it ourselves by singing rate — the
   * one case where the highlight can finish before the singer does. A line
   * ended by the source's own end mark, or by the next line arriving, is simply
   * correct and says nothing.
   */
  const lyricTimingBadge = useMemo(() => {
    if (!activeLyric) return null;
    if (activeLyric.words?.length) {
      return { label: "逐字", exact: true, hint: "这句有逐字时间，高亮跟着每个字走" };
    }
    if (activeLyric.endSource === "estimate") {
      return { label: "估算", exact: false, hint: "没有逐字歌词，按演唱速率估算句尾；长拖腔可能提前收住" };
    }
    return null;
  }, [activeLyric]);

  // Telling the clock what is playing HERE is the store's job now, not this
  // view's (lib/music-playback-store.ts). It has to be: on ZOS the panel is a
  // lyric display fed by this console, and this component unmounting no longer
  // means the music stopped — it means the user went to look at 内容. Reporting
  // stops when the page closes or when the clock stops running ZOS, both of
  // which App answers for.

  useEffect(() => {
    // ZOS never gets mirror frames: the endpoint answers 503 (measured), and the
    // device draws its own music page from the now-playing the service publishes.
    if (!mirrorOn || !selected || deviceOnline || zos) return;
    // With no lyric the GIF is the title on a four-second loop, so the window
    // is synthesised around the current playhead.
    const line: PixelLyricLine = activeLyric
      ? activeLine
      : { startMs: currentMs, endMs: currentMs + 4_000, untilMs: currentMs + 4_000 };
    const frames = renderMirrorFrames({
      text: activeLyric?.text ?? selected.track.title,
      hasLyric: Boolean(activeLyric && activeLyric.text.trim().length > 0),
      line,
      mode,
      skin,
      trackProgress: trackProgressRef.current,
      playing,
      spectrum: activeSpectrum,
    });
    if (frames.length > 0) void mirrorRunnerRef.current?.enqueue({ frames });
  }, [activeLine, activeLyric, activeSpectrum, mirrorOn, mode, playing, selected, skin, zos]);
  const effectiveDurationMs = playbackDurationMs(playback);
  const timelineDisplayMs = Math.min(dragMs ?? currentMs, effectiveDurationMs);
  const selectedTrackIndex = playback.queueIndex;
  const trackProgress = effectiveDurationMs > 0 ? Math.min(1, currentMs / effectiveDurationMs) : 0;
  trackProgressRef.current = trackProgress;

  const startQrLogin = async () => {
    setQrBusy(true);
    setSessionError(null);
    try {
      const result = await jsonApi<{ login: QrLogin }>("/api/music/qr", { method: "POST" });
      setQrLogin(result.login);
      setQrState("waiting");
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setQrBusy(false);
    }
  };

  // Everything a source change has to forget: the previous provider's tracks,
  // selection, playlists and pending seeks all belong to IDs the new source
  // cannot resolve. The queue and the playhead belong to the store, so it does
  // its own half — including stopping the audio.
  const clearLibrary = useCallback(() => {
    setTrackPage(0);
    setSelectedPlaylistId("");
    setPlaylists([]);
    setLibraryError(null);
    playlistRetryRef.current = 0;
    store.clear();
  }, [store]);

  const logout = async () => {
    setQrBusy(true);
    try {
      const result = await jsonApi<{ session: MusicSessionStatus; music?: MusicOverview }>(
        "/api/music/logout",
        { method: "POST" },
      );
      setSession(result.session);
      if (result.music) setOverview(result.music);
      clearLibrary();
      setSpotifyDevices([]);
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setQrBusy(false);
    }
  };

  const switchProvider = async (provider: MusicProviderId) => {
    // No early return when the page already thinks this source is live: that
    // belief can be stale, and refusing the click is exactly how the UI gets
    // stuck. Re-posting the same source is idempotent server-side.
    if (providerBusy) return;
    setProviderBusy(true);
    setSessionError(null);
    try {
      const result = await jsonApi<{ music: MusicOverview }>("/api/music/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      setOverview(result.music);
      const next = result.music.providers.find((entry) => entry.id === result.music.active);
      setSession(next
        ? { loggedIn: next.loggedIn, ...(next.profile ? { profile: next.profile } : {}) }
        : { loggedIn: false });
      setQrLogin(null);
      clearLibrary();
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setProviderBusy(false);
    }
  };

  const saveSpotifyClientId = async () => {
    setSpotifyBusy(true);
    setSessionError(null);
    try {
      const result = await jsonApi<{ app: SpotifyAppStatus }>("/api/music/spotify/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientIdDraft.trim() }),
      });
      setSpotifyApp(result.app);
      await loadSession();
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setSpotifyBusy(false);
    }
  };

  const startSpotifyLogin = async () => {
    setSpotifyBusy(true);
    setSessionError(null);
    const before = overview?.providers.find((entry) => entry.id === "spotify");
    loginGoalRef.current = { loggedIn: before?.loggedIn ?? false };
    try {
      const result = await jsonApi<{ login: { authorizeUrl: string } }>(
        "/api/music/spotify/login",
        { method: "POST" },
      );
      // A popup keeps the studio mounted; the callback page closes itself and we
      // notice the new session through the poll below.
      window.open(result.login.authorizeUrl, "spotify-login", "width=520,height=760");
      setSpotifyWaiting(true);
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setSpotifyBusy(false);
    }
  };

  const completeSpotifyLogin = async () => {
    setSpotifyBusy(true);
    setSessionError(null);
    try {
      await jsonApi("/api/music/spotify/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirectUrl: redirectDraft.trim() }),
      });
      setRedirectDraft("");
      setSpotifyWaiting(false);
      await loadSession();
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setSpotifyBusy(false);
    }
  };

  const loadSpotifyDevices = useCallback(async () => {
    try {
      const result = await jsonApi<{ devices: MusicRemoteDevice[] }>("/api/music/spotify/devices");
      setSpotifyDevices(result.devices);
      return result.devices;
    } catch (error) {
      store.setError(errorMessage(error));
      return null;
    }
  }, [store]);

  // Only the Connect target picker still posts from here; every transport
  // command goes through the store so it keeps working from the mini player.
  const postRemote = useCallback(async (patch: Record<string, unknown>) => {
    store.setError(null);
    try {
      await jsonApi("/api/music/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (error) {
      store.setError(errorMessage(error));
    }
  }, [store]);

  const runSearch = async (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    const normalized = query.trim();
    if (!normalized || searchBusy) return;
    setLibraryBusy(true);
    setSearchBusy(true);
    setLibraryError(null);
    try {
      const result = await jsonApi<{ tracks: MusicTrack[] }>(
        `/api/music/search?query=${encodeURIComponent(normalized)}`,
      );
      store.setQueue(result.tracks, `“${normalized}”`);
      setTrackPage(0);
      setSelectedPlaylistId("");
    } catch (error) {
      setLibraryError(errorMessage(error));
    } finally {
      setLibraryBusy(false);
      setSearchBusy(false);
    }
  };

  const openPlaylist = async (playlist: MusicPlaylist) => {
    setLibraryBusy(true);
    setLibraryError(null);
    setSelectedPlaylistId(playlist.id);
    try {
      const result = await jsonApi<{ tracks: MusicTrack[] }>(
        `/api/music/playlists/${playlist.id}/tracks`,
      );
      store.setQueue(result.tracks, playlist.name);
      setTrackPage(0);
    } catch (error) {
      setLibraryError(errorMessage(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  // 每日推荐与随机播放：两个都要登录 Cookie，动作本身（取数 → 入队 → 起播）在
  // lib/netease-discovery.ts 里，这里只负责忙碌态和错误横幅。
  const runDiscovery = async (action: "random" | "daily") => {
    if (discoveryBusy) return;
    setDiscoveryBusy(action);
    setLibraryBusy(true);
    setLibraryError(null);
    setSelectedPlaylistId("");
    setTrackPage(0);
    try {
      const ports = { requestJson: jsonApi, store };
      if (action === "daily") await loadDailyRecommendations(ports);
      else await playRandomLikedTrack(ports);
    } catch (error) {
      setLibraryError(errorMessage(error));
    } finally {
      setLibraryBusy(false);
      setDiscoveryBusy(null);
    }
  };

  // The transport itself lives in the store: selecting, play/pause and seeking
  // all have to keep working from the header's mini player, which is not inside
  // this component's tree.
  const selectTrack = (track: MusicTrack) => store.select(track);
  const togglePlayback = () => store.toggle();
  const handleSeek = useCallback((targetMs: number) => store.seek(targetMs), [store]);
  const postControl = store.postControl;

  const chooseSkin = useCallback((nextSkin: MusicSkin) => {
    setSkin(nextSkin);
    try {
      window.localStorage.setItem(MUSIC_SKIN_STORAGE_KEY, nextSkin);
    } catch {
      // The visual selection still works for this session without persistence.
    }
    postControl({ skin: nextSkin });
  }, [postControl]);

  const chooseMode = useCallback((nextMode: MusicMode) => {
    setMode(nextMode);
    try {
      window.localStorage.setItem(MUSIC_MODE_STORAGE_KEY, nextMode);
    } catch {
      // The visual selection still works for this session without persistence.
    }
    postControl({ mode: nextMode });
  }, [postControl]);

  const chooseAccent = useCallback((hex: string | null) => {
    setAccent(hex);
    try {
      if (hex) window.localStorage.setItem(MUSIC_ACCENT_STORAGE_KEY, hex);
      else window.localStorage.removeItem(MUSIC_ACCENT_STORAGE_KEY);
    } catch {
      // Non-persistent is fine; the control still reaches the device.
    }
    postControl({ accent: hex });
  }, [postControl]);

  // The pager follows the store's queue index (see the effect above), so this
  // is the same skip the mini player performs.
  const skipTrack = (direction: -1 | 1) => store.skip(direction);

  const toggleMirror = async () => {
    const next = !mirrorOn;
    setMirrorOn(next);
    setMirrorError(null);
    if (!next) {
      try {
        await api("/api/music/mirror", { method: "DELETE" });
      } catch (error) {
        setMirrorError(errorMessage(error));
      }
    }
  };

  const displayCurrent = activeLyric?.text ?? selected?.track.title ?? "选择歌曲";
  // Music firmware is online but the track it reports playing isn't the one we
  // just selected yet — it's still downloading. Show a loading state, not the
  // old track's progress. (The store holds the same rule: it is what stops the
  // interpolated clock from surfacing the previous track's playhead.)
  const loadingTrack = deviceIsLoadingTrack(playback);
  // If the track changes (or starts loading) mid-drag the slider gets disabled
  // under the pointer and the release event may never commit — drop any
  // half-finished drag instead of letting draggingRef wedge the preview clock.
  const selectedTrackId = selected?.track.id ?? null;
  useEffect(() => {
    draggingRef.current = false;
    dragMsRef.current = null;
    setDragMs(null);
  }, [selectedTrackId, loadingTrack]);

  // While the Spotify consent window is open, watch for the result. The popup is
  // cross-origin on the way out, so polling is the only signal. The exit test is
  // "something changed", not "signed in" — a re-authorization to widen scopes
  // starts from an already-signed-in session and would otherwise stop on the
  // very first tick, leaving the page frozen on the old state.
  useEffect(() => {
    if (!spotifyWaiting) return;
    let cancelled = false;
    const goal = loginGoalRef.current;
    const deadline = Date.now() + 5 * 60_000;
    const timer = window.setInterval(() => {
      void (async () => {
        if (cancelled) return;
        const next = await loadSession();
        const entry = next?.providers.find((item) => item.id === "spotify");
        const changed = entry !== undefined && goal !== null && entry.loggedIn !== goal.loggedIn;
        if (changed || Date.now() > deadline) {
          setSpotifyWaiting(false);
          loginGoalRef.current = null;
        }
      })();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadSession, spotifyWaiting]);

  // Re-read server state whenever the tab comes back into focus: the consent
  // flow, another tab, or the Spotify app can all change things while away.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void loadSession();
      void loadSpotifyApp();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadSession, loadSpotifyApp]);

  // Connect targets, refreshed whenever Spotify becomes the live signed-in source.
  useEffect(() => {
    if (!remoteMode || !session?.loggedIn) {
      setSpotifyDevices([]);
      return;
    }
    void loadSpotifyDevices();
  }, [loadSpotifyDevices, remoteMode, session?.loggedIn]);

  const spotifyReady = spotifyApp?.configured === true;
  const spotifySignedIn = remoteMode && session?.loggedIn === true;
  const activeRemoteDevice = spotifyDevices.find((device) => device.active);
  // Spotify search needs a user token; NetEase answers without one.
  const searchLocked = remoteMode && !spotifySignedIn;
  const previewStatus = loadingTrack
    ? "设备载入中"
    : trackBusy
      ? "正在载入"
      : playing
        ? "正在播放"
        : selected
          ? "已载入"
          : deviceOnline
            ? "音乐固件就绪 · 选一首歌"
            : "等待选歌";
  // Every line of the song, whichever layout is up: `lyricTapeRows` narrows this
  // to a window when the stage is stacked, and a slice of these elements costs
  // nothing next to rebuilding them.
  // Memoised because `positionMs` re-renders this component several times a
  // second while only a line change can alter these rows; handing React the
  // same element references lets it skip the whole subtree in between, so a
  // 60-line song costs no more per tick than the 5-line window did.
  const lyricRows = useMemo(
    () => (selected?.lyrics ?? []).map((line, index) => (
      <ListButton
        type="button"
        key={line.startMs + "-" + line.text}
        // Index, not startMs: two lines can share a timestamp (a line and its
        // romaji), and the window used to hide that by never showing both.
        className={`music-lyric-row${index === activeLyricIndex ? " is-active" : ""}`}
        contentClassName="music-lyric-row__content"
        innerContentClassName="music-lyric-row__copy"
        titleClassName="music-lyric-row__title"
        footerClassName="music-lyric-row__translation"
        icon={<time>{formatTime(line.startMs)}</time>}
        footer={line.translation}
        color={index === activeLyricIndex ? "brand" : "neutral"}
        rounded={false}
        tightFocusRing
        aria-current={index === activeLyricIndex ? "true" : undefined}
        aria-label={"跳转到 " + formatTime(line.startMs) + "，" + line.text}
        onClick={() => handleSeek(line.startMs)}
      >
        {line.text}
      </ListButton>
    )),
    [activeLyricIndex, handleSeek, selected],
  );

  // What the tape actually shows: the whole song in the rail, a window around
  // the playhead when stacked. Slicing the memoised rows rather than mapping a
  // slice is what keeps the rail free of per-tick churn — both branches hand
  // React the same element objects until a line change rebuilds them.
  const visibleLyricRows = lyricTapeRows(lyricRows, activeLyricIndex, lyricsRailActive);

  // Bring the current line to the reader — the rail's tape holds the whole song,
  // so following the playhead there is a scroll. Stacked there is nothing to
  // scroll (the window above is the follow, and the tape is in document flow),
  // and scrolling it would hijack the page, so the rail check leaves this a
  // no-op. The overflow test then covers the short song whose rail never fills.
  useEffect(() => {
    if (!lyricsRailActive) return;
    const panel = lyricsPanelRef.current;
    if (!panel) return;
    const tape = panel.querySelector<HTMLElement>(".music-lyric-tape");
    const row = panel.querySelector<HTMLElement>(".music-lyric-row.is-active");
    if (!tape || !row) return;
    if (tape.scrollHeight <= tape.clientHeight + 1) return;
    // A third of the way down, which is where the old window put it: enough
    // lead-in above to see where the song has been, most of the column below
    // for what is coming. Measured against the tape rather than read off
    // offsetTop, which would be relative to whichever ancestor is positioned.
    const delta = row.getBoundingClientRect().top - tape.getBoundingClientRect().top;
    const target = tape.scrollTop + delta - tape.clientHeight * 0.32;
    tape.scrollTo({
      top: Math.max(0, target),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [activeLyricIndex, lyricsRailActive, selected?.track.id]);
  // 两个入口都读账号私有数据（每日推荐按 Cookie 计算、喜欢的歌曲按 uid 取），
  // 所以 Spotify 之下和未登录时都不该出现——按不动的按钮不如没有。
  const neteaseSignedIn = activeProviderId === "netease" && session?.loggedIn === true;
  const selectedPlaylist = selectedPlaylistId === ""
    ? undefined
    : playlists.find((playlist) => playlist.id === selectedPlaylistId);
  const totalTrackPages = Math.max(1, Math.ceil(tracks.length / TRACKS_PER_PAGE));
  const currentTrackPage = Math.min(trackPage, totalTrackPages - 1);
  const pageStart = currentTrackPage * TRACKS_PER_PAGE;
  const pageTracks = tracks.slice(pageStart, pageStart + TRACKS_PER_PAGE);

  return (
    // `has-track` drives the stacked-layout section order (music-player.css):
    // with a track loaded the stage — transport, 52×16 preview, theme panel —
    // outranks the search rail on a phone. Keyed on `selected`, not `playing`,
    // so tapping pause does not reshuffle the whole page.
    <div className={"music-studio" + (selected ? " has-track" : "")}>
      <section className="music-library" aria-labelledby="music-library-title">
        <header className="music-library__header">
          <div className="music-section-heading">
            <span>{providerCopy.eyebrow}</span>
            <h2 id="music-library-title">从一首歌开始</h2>
            <p>{providerCopy.blurb}</p>
          </div>
        </header>

        <div className="music-source-bar">
        <Segmented
          className="music-source-switch"
          aria-label="音乐来源"
          size="sm"
          disabled={providerBusy}
          activeColor="brand"
        >
          {(["netease", "spotify"] as const).map((provider) => (
            <SegmentedButton
              key={provider}
              type="button"
              active={activeProviderId === provider}
              aria-label={`切换到 ${PROVIDER_COPY[provider].label}`}
              onClick={() => void switchProvider(provider)}
            >
              {PROVIDER_COPY[provider].label}
            </SegmentedButton>
          ))}
        </Segmented>

        <div className="music-account-strip">
          {session?.loggedIn ? (
            <>
              {session.profile && <MusicAccountAvatar profile={session.profile} />}
              <div>
                <strong>{session.profile?.nickname}</strong>
                <span>
                  {remoteMode
                    ? `Spotify 授权保存在本机${session.profile?.plan === "premium" ? " · Premium" : ""}`
                    : "扫码会话已保存在本机"}
                </span>
              </div>
              <Button type="button" size="sm" square variant="transparent" outline={false} aria-label={`退出${providerCopy.label}`} disabled={qrBusy} onClick={() => void logout()}><LogOut /></Button>
            </>
          ) : remoteMode ? (
            <>
              <span className="music-account-strip__avatar is-signed-out" aria-hidden="true"><Radio /></span>
              <div><strong>尚未连接 Spotify</strong><span>{spotifyReady ? "授权后即可控制 Spotify Connect" : "先填写你的 Spotify 应用 Client ID"}</span></div>
              <Button
                type="button"
                size="sm"
                loading={spotifyBusy || spotifyWaiting}
                disabled={!spotifyReady || spotifyBusy || spotifyWaiting}
                onClick={() => void startSpotifyLogin()}
              >
                <Radio />{spotifyWaiting ? "等待授权" : "登录 Spotify"}
              </Button>
            </>
          ) : (
            <>
              <span className="music-account-strip__avatar is-signed-out" aria-hidden="true"><Radio /></span>
              <div><strong>尚未登录</strong><span>使用网易云音乐 App 扫码</span></div>
              <Button type="button" size="sm" loading={qrBusy} disabled={qrBusy} onClick={() => void startQrLogin()}><Radio />生成二维码</Button>
            </>
          )}
        </div>
        </div>

        {remoteMode && !session?.loggedIn && (
          <div className="music-spotify-setup">
            <div className="music-spotify-setup__head">
              <span><KeyRound aria-hidden="true" />SPOTIFY 应用</span>
              <p>
                Spotify 不发放公共密钥，需要你在开发者后台自建一个应用（免费），
                把它的 Client ID 填在这里。授权走 PKCE，无需 Client Secret。
              </p>
            </div>
            <ol className="music-spotify-steps">
              <li>
                打开
                {" "}
                <a href={SPOTIFY_DASHBOARD_URL} target="_blank" rel="noreferrer noopener">
                  Spotify 开发者后台<ExternalLink aria-hidden="true" />
                </a>
                ，新建一个 App
              </li>
              <li>
                在 Redirect URI 里精确填入：
                <code>{spotifyApp?.redirectUri ?? "http://127.0.0.1:43820/api/music/spotify/callback"}</code>
              </li>
              <li>勾选 Web API，保存后把 Client ID 复制过来</li>
            </ol>
            <label className="music-spotify-field">
              <span>Client ID</span>
              <Input
                inputId="music-spotify-client-id"
                value={clientIdDraft}
                placeholder="32 位十六进制字符"
                maxLength={64}
                size="md"
                spellCheck={false}
                onChange={setClientIdDraft}
              />
            </label>
            <div className="music-spotify-actions">
              <Button
                type="button"
                size="sm"
                color="brand"
                loading={spotifyBusy}
                disabled={spotifyBusy || clientIdDraft.trim().length === 0}
                onClick={() => void saveSpotifyClientId()}
              >
                <Check aria-hidden="true" />{spotifyReady ? "更新 Client ID" : "保存 Client ID"}
              </Button>
            </div>
            {spotifyWaiting && (
              <div className="music-spotify-paste">
                <p>
                  如果这台设备不是运行服务的电脑，回调会停在打不开的 127.0.0.1 页面——
                  把浏览器地址栏里的完整链接粘贴到这里即可完成登录。
                </p>
                <label className="music-spotify-field">
                  <span>回调链接</span>
                  <Input
                    inputId="music-spotify-redirect"
                    value={redirectDraft}
                    placeholder="http://127.0.0.1:43820/api/music/spotify/callback?code=…"
                    maxLength={2048}
                    size="md"
                    spellCheck={false}
                    onChange={setRedirectDraft}
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="transparent"
                  outline
                  loading={spotifyBusy}
                  disabled={spotifyBusy || redirectDraft.trim().length === 0}
                  onClick={() => void completeSpotifyLogin()}
                >
                  <Check aria-hidden="true" />用链接完成登录
                </Button>
              </div>
            )}
          </div>
        )}

        {qrLogin && !session?.loggedIn && !remoteMode && (
          <div className={"music-qr-panel is-" + qrState}>
            <div className="music-qr-code">
              <QRCodeSVG value={qrLogin.qrUrl} size={168} level="M" marginSize={2} />
              {qrState === "scanned" && <span><Check />已扫码</span>}
              {qrState === "expired" && <span><RefreshCw />已过期</span>}
            </div>
            <div>
              <strong>{qrState === "scanned" ? "请在手机上确认" : qrState === "expired" ? "二维码已经过期" : "打开网易云音乐扫码"}</strong>
              <p>登录凭据只写入运行 Pixel Market 的这台电脑，不会下发到 TC002。</p>
              {qrState === "expired" && <Button type="button" size="sm" onClick={() => void startQrLogin()}><RefreshCw />刷新二维码</Button>}
            </div>
          </div>
        )}
        {sessionError && <p className="music-inline-error" role="alert">{sessionError}</p>}

        <form className="music-search" onSubmit={(event) => void runSearch(event)}>
          <label htmlFor="music-search-input">搜索歌曲、歌手或专辑</label>
          <div className="music-search__controls">
            <SearchField
              inputId="music-search-input"
              className="music-search-field"
              value={query}
              icon={<Search aria-hidden="true" />}
              placeholder={searchLocked ? "登录 Spotify 后即可搜索" : providerCopy.searchHint}
              maxLength={80}
              clearButton
              clearLabel="清空搜索"
              disabled={searchLocked}
              onChange={setQuery}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void runSearch();
                }
              }}
            />
            <Button
              type="submit"
              className="music-search-submit"
              size="lg"
              color="brand"
              loading={searchBusy}
              disabled={searchBusy || searchLocked || query.trim().length === 0}
            >
              <Search aria-hidden="true" />搜索
            </Button>
          </div>
        </form>

        {playlists.length > 0 && (
          <div className="music-playlist-select">
            <span id="music-playlist-label"><ListMusic aria-hidden="true" />我的歌单</span>
            <Select<MusicPlaylist, string>
              className="music-playlist-select__control"
              value={selectedPlaylistId === "" ? undefined : selectedPlaylistId}
              options={playlists}
              getOptionValue={(playlist) => playlist.id}
              renderOption={({ value }) => value.name}
              renderOptionInfo={({ value }) => `${value.trackCount} 首歌曲`}
              placeholder="选择一个歌单"
              title={`我的${providerCopy.label}歌单`}
              aria-labelledby="music-playlist-label"
              disabled={libraryBusy}
              keyboardHints={false}
              popoverPosition="bottom-start"
              popoverOffset={[6, 0]}
              popoverClassName="music-playlist-popover"
              onChange={(playlistId) => {
                const playlist = playlists.find((candidate) => candidate.id === playlistId);
                if (playlist) void openPlaylist(playlist);
              }}
            >
              {selectedPlaylist ? `${selectedPlaylist.name}（${selectedPlaylist.trackCount} 首）` : undefined}
            </Select>
          </div>
        )}

        {neteaseSignedIn && (
          <div className="music-discovery">
            <Button
              type="button"
              size="md"
              variant="transparent"
              outline
              tightFocusRing
              aria-label="随机播放一首我喜欢的音乐"
              loading={discoveryBusy === "random"}
              disabled={discoveryBusy !== null || trackBusy}
              onClick={() => void runDiscovery("random")}
            >
              <Shuffle aria-hidden="true" />随机播放
            </Button>
            <Button
              type="button"
              size="md"
              variant="transparent"
              outline
              tightFocusRing
              aria-label="载入今天的每日推荐歌曲"
              loading={discoveryBusy === "daily"}
              disabled={discoveryBusy !== null}
              onClick={() => void runDiscovery("daily")}
            >
              <Sparkles aria-hidden="true" />每日推荐
            </Button>
          </div>
        )}

        <div className="music-track-list">
          <div className="music-track-list__heading"><span>{sourceLabel}</span><small>{tracks.length} 首</small></div>
          {libraryError && <p className="music-inline-error" role="alert">{libraryError}</p>}
          <List className="music-track-list__viewport" aria-busy={libraryBusy}>
            {tracks.length === 0 && !libraryBusy ? (
              <div className="music-empty-state">
                <Search />
                <strong>先找一首歌</strong>
                <span>
                  {remoteMode
                    ? "登录 Spotify 后可以搜索、打开歌单，并把播放投到任意 Connect 设备。"
                    : "无需登录也可以搜索；登录后还能打开你的歌单。"}
                </span>
              </div>
            ) : pageTracks.map((track, index) => {
              const active = selected?.track.id === track.id;
              return (
                <ListButton
                  type="button"
                  key={track.id}
                  className={`music-track-row${active ? " is-active" : ""}`}
                  contentClassName="music-track-row__content"
                  innerContentClassName="music-track-row__copy"
                  titleClassName="music-track-row__title"
                  footerClassName="music-track-row__meta"
                  icon={(
                    <MusicCoverArt
                      track={track}
                      fallback={String(pageStart + index + 1).padStart(2, "0")}
                      className="music-cover--row"
                    />
                  )}
                  footer={`${artistLabel(track)} · ${track.album || "未知专辑"}`}
                  after={<span className="music-track-row__after"><time>{formatTime(track.durationMs)}</time><Play aria-hidden="true" /></span>}
                  color={active ? "brand" : "neutral"}
                  rounded={false}
                  tightFocusRing
                  aria-current={active ? "true" : undefined}
                  disabled={trackBusy}
                  onClick={() => void selectTrack(track)}
                >
                  {track.title}
                </ListButton>
              );
            })}
          </List>
          {totalTrackPages > 1 && (
            <nav className="music-track-pager" aria-label="歌曲列表翻页">
              <Button
                type="button"
                size="sm"
                square
                variant="transparent"
                outline
                tightFocusRing
                aria-label="上一页"
                disabled={currentTrackPage === 0}
                onClick={() => setTrackPage(currentTrackPage - 1)}
              >
                <ChevronLeft />
              </Button>
              <span className="music-track-pager__status" aria-live="polite">
                第 {currentTrackPage + 1} / {totalTrackPages} 页
              </span>
              <Button
                type="button"
                size="sm"
                square
                variant="transparent"
                outline
                tightFocusRing
                aria-label="下一页"
                disabled={currentTrackPage >= totalTrackPages - 1}
                onClick={() => setTrackPage(currentTrackPage + 1)}
              >
                <ChevronRight />
              </Button>
            </nav>
          )}
        </div>
      </section>

      <div className="music-stage">
        <div className="music-stage__sticky" ref={stageGridRef}>
          {/* The console leads the column: what's playing and how to control it
              come before the preview and every configuration concern. */}
          <section
            className={"music-now-playing" + (selected ? "" : " is-empty")}
            aria-label={selected ? undefined : "播放控制台"}
            aria-labelledby={selected ? "music-current-track-title" : undefined}
          >
            {selected ? (
              <>
                <header className="music-now-playing__header">
                  <div className="music-now-playing__label">
                    <span>NOW PLAYING</span>
                    <strong>
                      {selectedTrackIndex >= 0
                        ? `TRACK ${String(selectedTrackIndex + 1).padStart(2, "0")} / ${String(tracks.length).padStart(2, "0")}`
                        : remoteMode
                          ? "SPOTIFY CONNECT"
                          : deviceOnline
                            ? "TC002 DIRECT"
                            : "WEB AUDIO"}
                    </strong>
                  </div>
                  <Chip
                    className="music-output-chip"
                    size="sm"
                    color={playing ? "brand" : "neutral"}
                    variant="transparent"
                    icon={remoteMode ? Speaker : Wifi}
                    iconProps={{ "aria-hidden": true }}
                    aria-live="polite"
                  >
                    {remoteMode
                      ? activeRemoteDevice?.name ?? "Spotify Connect"
                      : playing ? "网页试听中" : "网页试听"}
                  </Chip>
                </header>

                <div className="music-now-playing__main">
                  <MusicCoverArt
                    track={selected.track}
                    fallback={Array.from(selected.track.title.trim())[0] ?? "歌"}
                    className="music-cover--console"
                  />
                  <div className="music-now-playing__identity">
                    <span>当前曲目</span>
                    <h3 id="music-current-track-title">{selected.track.title}</h3>
                    <p>{artistLabel(selected.track)} · {selected.track.album || "未知专辑"}</p>
                  </div>
                  <div className="music-transport" aria-label={remoteMode ? "Spotify Connect 控制" : deviceOnline ? "设备播放控制" : "网页试听控制"}>
                    {/* Connect brings its own repeat/shuffle and its own queue —
                        a 播放模式 here would govern a list it does not play. */}
                    {!remoteMode && (
                      <PlayModeButton order={playback.playOrder} onCycle={() => store.cyclePlayOrder()} />
                    )}
                    <Button type="button" size="md" square variant="transparent" outline={false} tightFocusRing aria-label="上一首" disabled={!remoteMode && tracks.length < 2} onClick={() => skipTrack(-1)}><ChevronLeft /></Button>
                    <Button
                      type="button"
                      className="music-play-button"
                      size="xl"
                      square
                      rounded
                      color="brand"
                      variant="solid-fill"
                      tightFocusRing
                      aria-label={remoteMode
                        ? (playing ? "暂停 Spotify 播放" : "继续 Spotify 播放")
                        : (playing ? "暂停网页试听" : "开始网页试听")}
                      loading={trackBusy}
                      disabled={trackBusy}
                      onClick={() => void togglePlayback()}
                    >
                      {playing ? <Pause /> : <Play />}
                    </Button>
                    <Button type="button" size="md" square variant="transparent" outline={false} tightFocusRing aria-label="下一首" disabled={!remoteMode && tracks.length < 2} onClick={() => skipTrack(1)}><ChevronRight /></Button>
                  </div>
                </div>

                <div className="music-timeline">
                  <div className="music-timeline__meta">
                    <span>{loadingTrack ? "载入中" : "播放进度"}</span>
                    {loadingTrack
                      ? <span className="music-timeline__loading">设备下载中…</span>
                      : <span><time>{formatTime(timelineDisplayMs)}</time><i aria-hidden="true">/</i><time>{formatTime(effectiveDurationMs)}</time></span>}
                  </div>
                  <label
                    className="music-timeline__slider"
                    onPointerDownCapture={() => {
                      if (selected && !loadingTrack) draggingRef.current = true;
                    }}
                    onPointerUpCapture={() => {
                      if (!draggingRef.current) return;
                      draggingRef.current = false;
                      const target = dragMsRef.current;
                      dragMsRef.current = null;
                      if (target !== null) {
                        handleSeek(target);
                        setDragMs(null);
                      }
                    }}
                    onPointerCancelCapture={() => {
                      draggingRef.current = false;
                      dragMsRef.current = null;
                      setDragMs(null);
                    }}
                  >
                    <span className="music-visually-hidden">播放进度</span>
                    <Slider
                      className="music-timeline-slider"
                      value={Math.round(timelineDisplayMs)}
                      min={0}
                      max={Math.max(1_000, Math.round(effectiveDurationMs))}
                      step={1_000}
                      size="md"
                      variant="track"
                      rounded
                      rangeFill
                      color="brand"
                      tightFocusRing
                      disabled={loadingTrack}
                      onChange={(value) => {
                        // While the pointer is down only preview the position;
                        // the seek itself is committed once on release. Keyboard
                        // arrows (no pointer) commit immediately.
                        if (draggingRef.current) {
                          dragMsRef.current = value;
                          setDragMs(value);
                        } else {
                          handleSeek(value);
                        }
                      }}
                    />
                  </label>
                </div>
              </>
            ) : (
              <div className="music-player-empty">
                <span aria-hidden="true"><Music2 /></span>
                <div><strong>还没有选择歌曲</strong><p>从歌曲列表选一首，这里就是播放与进度的控制台。</p></div>
              </div>
            )}

            {/* Output routing is a player concern, so the Connect target picker
                lives with the transport instead of the library rail. */}
            {spotifySignedIn && (
              <div className="music-console-output">
                <span id="music-connect-label"><Speaker aria-hidden="true" />播放设备</span>
                <Select<MusicRemoteDevice, string>
                  className="music-console-output__control"
                  value={activeRemoteDevice?.id}
                  options={spotifyDevices}
                  getOptionValue={(device) => device.id}
                  renderOption={({ value }) => value.name}
                  renderOptionInfo={({ value }) => value.type}
                  placeholder={spotifyDevices.length > 0 ? "选择播放设备" : "没有可用设备"}
                  title="Spotify Connect 设备"
                  aria-labelledby="music-connect-label"
                  disabled={spotifyDevices.length === 0}
                  keyboardHints={false}
                  popoverPosition="bottom-start"
                  popoverOffset={[6, 0]}
                  popoverClassName="music-playlist-popover"
                  onChange={(deviceId) => {
                    if (deviceId) void postRemote({ action: "transfer", deviceId, play: playing });
                  }}
                >
                  {activeRemoteDevice ? activeRemoteDevice.name : undefined}
                </Select>
                <Button
                  type="button"
                  size="sm"
                  square
                  variant="transparent"
                  outline
                  tightFocusRing
                  aria-label="刷新 Spotify 播放设备"
                  onClick={() => void loadSpotifyDevices()}
                >
                  <RefreshCw />
                </Button>
                <p className="music-connect-hint">
                  {spotifyDevices.length > 0
                    ? "也可以直接在 Spotify 客户端里选歌——工作台和时钟会自动跟随。"
                    : "还没有可用设备：在 Spotify 客户端里随便播一首，它就会出现在这里。"}
                </p>
              </div>
            )}

            {playbackError && <p className="music-inline-error" role="alert">{playbackError}</p>}
            {/* No <audio> here on purpose. The element used to hang off this
                section, so leaving the 音乐 tab destroyed the player mid-song;
                it belongs to the page now (lib/music-playback-store.ts). Spotify
                audio never reaches this origin either way — in remote mode the
                Connect player is the output and no element exists at all. */}
          </section>

          {/* aria-label 而不是 aria-labelledby:标题本身删掉了——预览下方的
              「屏幕 52 × 16 · 字模 12 × 12」已经把同一件事说过一遍,而屏幕规格
              不是这块区域的名字。无障碍名字不能跟着一起消失,所以搬到这里。 */}
          <section className="music-screen" aria-label="52 × 16 像素屏预览">
            <header className="music-stage__header">
              <div className="music-stage__heading">
                <span className="music-stage__eyebrow">
                  <Radio aria-hidden="true" />
                  <span className="music-stage__eyebrow-label">LIVE PREVIEW</span>
                  <em className={"music-stage__pulse" + (playing ? " is-live" : "")} aria-live="polite">
                    <i aria-hidden="true" />{previewStatus}
                  </em>
                </span>
              </div>
              <div className="music-stage__header-actions">
                {zos ? (
                  // 官方固件的同屏通道在 ZOS 上是 503，但设备自己有一页音乐界面，
                  // 而固件现在认 focus:"music"。所以这里与 内容 页同一个 idiom：
                  // 接管旋钮把时钟切过去，再按一次交还。标签特意不叫「在时钟上显示」——
                  // 它就挨着这块 52×16 预览，那样写会被读成把预览镜像过去，而那正是
                  // ZOS 上做不到的事：设备那页由它自己渲染。
                  <Button
                    type="button"
                    className="music-mirror-toggle"
                    size="sm"
                    color={zosMusicPinned ? "brand" : "neutral"}
                    variant="transparent"
                    outline
                    tightFocusRing
                    aria-pressed={zosMusicPinned}
                    aria-busy={zosFocus.busy}
                    disabled={zosFocus.busy}
                    title={zosMusicPinned
                      ? "交还旋钮，时钟恢复自己切台"
                      : "把时钟切到它自己的音乐页并锁住旋钮；那一页由设备渲染，不是这块预览的镜像"}
                    onClick={() => zosFocus.toggle(ZOS_MUSIC_FOCUS)}
                  >
                    {zosMusicPinned
                      ? <PinOff aria-hidden="true" />
                      : <MonitorCog aria-hidden="true" />}
                    {zosMusicPinned ? "交还旋钮" : "切到时钟音乐页"}
                  </Button>
                ) : deviceOnline ? (
                  <Button
                    type="button"
                    className="music-mirror-toggle"
                    size="sm"
                    color="neutral"
                    variant="transparent"
                    outline
                    tightFocusRing
                    aria-disabled="true"
                    title="设备正在运行音乐固件，直接原生播放"
                  >
                    <HardDrive aria-hidden="true" />设备直连
                  </Button>
                ) : (
                  <Button
                    type="button"
                    className="music-mirror-toggle"
                    size="sm"
                    color={mirrorOn ? "brand" : "neutral"}
                    variant="transparent"
                    outline
                    tightFocusRing
                    aria-pressed={mirrorOn}
                    disabled={!selected}
                    title="把当前歌词帧推送到官方固件的自定义应用位，不需要刷机"
                    onClick={() => void toggleMirror()}
                  >
                    <Cast aria-hidden="true" />设备同屏
                  </Button>
                )}
                <Button
                  type="button"
                  className="music-device-trigger"
                  contentClassName="music-device-trigger__content"
                  size="sm"
                  color="neutral"
                  variant="transparent"
                  outline
                  tightFocusRing
                  aria-haspopup="dialog"
                  aria-label={`侧载音乐固件，${firmwarePanel.statusLabel}`}
                  onClick={firmwarePanel.openPanel}
                >
                  <HardDrive aria-hidden="true" />
                  <span>侧载音乐固件</span>
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </header>

            <PixelLyricsPreview
              currentText={displayCurrent}
              hasLyric={Boolean(activeLyric && activeLyric.text.trim().length > 0)}
              line={activeLine}
              trackProgress={trackProgress}
              timeMs={currentMs}
              playing={playing && !loadingTrack}
              skin={skin}
              accent={accent}
              mode={mode}
              spectrum={activeSpectrum}
            />

            {loadingTrack && (
              <div className="music-sync-hint" role="status" aria-live="polite">
                <span aria-hidden="true"><Spinner size="xs" color="brand" /></span>
                <span>正在同步到设备，请稍候…</span>
              </div>
            )}

            {/* The sync hint that used to sit here explained which side owns
                playback and warned that the NetEase path needed this page kept
                open. Playback now lives in a module-level store, so leaving the
                tab no longer stops it and the warning had become false. The
                true half — that the clock follows whatever is playing — is
                something the panel demonstrates by doing it. */}

            {zos && zosFocus.error && (
              <p className="music-inline-error" role="alert">切换时钟界面失败：{zosFocus.error}</p>
            )}

            {mirrorError && <p className="music-inline-error" role="alert">同屏推送失败：{mirrorError}</p>}

          </section>

          {/* Appearance is configuration: kept whole, but demoted below
              everything a player needs at hand. */}
          <MusicThemePanel
            mode={mode}
            skin={skin}
            accent={accent}
            onModeChange={chooseMode}
            onSkinChange={chooseSkin}
            onAccentChange={chooseAccent}
            // `deviceOnline` is the SIDELOADED music firmware's heartbeat, so on
            // a ZOS device it is false and this panel used to say「仅影响预览」—
            // which was true, and was the complaint. ZOS reads the same three
            // values out of its pull document now (ADR 0007).
            syncsToDevice={deviceOnline || zos}
            // ZOS paints the same deterministic pseudo-spectrum the sideloaded
            // player does; neither runs an FFT, so the preview must not either.
            simulatedSpectrum={remoteMode || deviceOnline || zos}
          />

          {/* The lyrics are the one section with unbounded content, so they own
              the second column outright and everything else stacks in the first
              (music-player.css). The rail div is the spanning cell; the card
              inside it is what sticks and scrolls, and it cannot be the same
              element — a stretched grid item has no room left to travel.

              Last in the DOM, which decides only the stacked order: side by
              side the rail is placed by the grid regardless. A phone gets the
              whole song's lyrics here, and burying the theme panel under a
              few thousand pixels of them would be the price of putting this
              third. Reading order then matches the stack on a phone, and on a
              desktop it is the ordinary "sidebar last" arrangement. */}
          <div className="music-lyrics-rail">
            <section
              className="music-lyrics-panel"
              aria-labelledby="music-lyrics-title"
              ref={lyricsPanelRef}
            >
              <header>
                <div><span>LYRICS</span><h3 id="music-lyrics-title">歌词轨</h3></div>
                {/*
                  Say out loud which kind of timing the current line has.
                  A word-timed line and a rate-estimated one look identical on the
                  panel until you watch one finish early, and the estimate really
                  can cut a long held note short — so the console names it rather
                  than presenting a guess as a measurement.
                */}
                {lyricTimingBadge && (
                  <Chip
                    size="sm"
                    color={lyricTimingBadge.exact ? "brand" : "neutral"}
                    variant="transparent"
                    aria-live="polite"
                    title={lyricTimingBadge.hint}
                  >
                    {lyricTimingBadge.label}
                  </Chip>
                )}
                <small>{selected ? "点击歌词可跳转" : "选择歌曲后显示"}</small>
              </header>
              {visibleLyricRows.length > 0 ? (
                <List className="music-lyric-tape" aria-label="歌词时间轴">
                  {visibleLyricRows}
                </List>
              ) : (
                <div className="music-lyrics-empty">
                  <Music2 aria-hidden="true" />
                  <div>
                    <strong>{selected ? "当前歌曲暂无可用歌词" : "歌词会在这里跟随播放"}</strong>
                    <span>{selected ? "仍可使用上方进度条试听歌曲。" : "选择歌曲后，可点击任意歌词跳转。"}</span>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      <FirmwarePanel
        controller={firmwarePanel}
        heading="侧载音乐固件"
        description={zos
          ? "把音乐固件推进时钟内存临时运行，绝不写入存储芯片；它与 ZOS 互斥，侧载期间 ZOS 会被顶下去。"
          : "把音乐固件推进时钟内存临时运行，绝不写入存储芯片；官方固件原封不动，断电重启即自动恢复。"}
        dialogClassName="music-firmware-dialog"
      >
        {zos && (
          // 与游戏页同一段事实；恢复承诺归面板正文的 restoresTo 说，这里只讲
          // 侧载期间会中断什么。
          <Surface
            color="orange"
            variant="solid"
            outline
            className="rounded-lg"
            contentClassName="flex flex-col gap-1 px-3 py-2 text-xs leading-relaxed text-cladd-fg-soft"
          >
            <strong className="text-cladd-fg">时钟当前运行 ZOS，两套固件不能同时跑。</strong>
            <span>
              侧载会把 ZOS 顶下去，控制台的频道拉取、画面镜像与固定旋钮在这期间都会中断；
              结束侧载或断电重启后回到的是 ZOS，不是 Ulanzi 官方固件。
            </span>
          </Surface>
        )}
      </FirmwarePanel>
    </div>
  );
}
