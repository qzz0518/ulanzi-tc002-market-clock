import {
  Cast,
  Check,
  ChevronLeft,
  ChevronRight,
  HardDrive,
  ListMusic,
  LogOut,
  Music2,
  Pause,
  Play,
  Power,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Wifi,
  X,
} from "lucide-react";
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  List,
  ListButton,
  SearchField,
  Select,
  Slider,
  Spinner,
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
import {
  isMusicSkin,
  MusicThemePanel,
  PixelLyricsPreview,
  type MusicSkin,
} from "@/components/music/pixel-lyrics-preview";
import { api, jsonApi } from "@/lib/api";
import { createLatestTaskRunner, type LatestTaskRunner } from "@/lib/latest-task-runner";
import { clampPlaybackPositionMs } from "@/lib/music-playback";
import { renderMirrorFrames, type MirrorFrame } from "@/lib/music-mirror";
import { errorMessage } from "@/lib/utils";
import type {
  MusicDeviceAppStatus,
  MusicDeviceProbe,
  MusicPlaylist,
  MusicProfile,
  MusicSessionStatus,
  MusicTrack,
  MusicTrackDetail,
} from "@/types";

type QrState = "waiting" | "scanned" | "confirmed" | "expired";

interface QrLogin {
  id: string;
  qrUrl: string;
  expiresAt: string;
}

const SESSION_CONFIRMATION = "START_TC002_MUSIC_SESSION";
const TRACKS_PER_PAGE = 20;
const MUSIC_SKIN_STORAGE_KEY = "pixel-market.music-skin";
const MUSIC_MODE_STORAGE_KEY = "pixel-market.music-mode";
const MUSIC_ACCENT_STORAGE_KEY = "pixel-market.music-accent";

function formatTime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "0:00";
  const seconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function artistLabel(track: MusicTrack | undefined): string {
  return track?.artists.join(" / ") || "未知音乐人";
}

export function DeviceReconnectGuidance() {
  return (
    <p className="music-device-reconnect-guidance" role="status">
      <Power aria-hidden="true" />
      <span><strong>仍然无法检测？</strong>如果无法检测到设备，请关机并连接到电脑再开机。</span>
    </p>
  );
}

export function MusicAccountAvatar({ profile }: { profile: MusicProfile }) {
  const initial = Array.from(profile.nickname.trim() || "云")[0] ?? "云";
  return (
    <span className="music-account-strip__avatar" aria-hidden="true">
      <span className="music-account-strip__avatar-fallback">{initial}</span>
      {profile.avatarUrl && (
        <img
          key={profile.avatarUrl}
          className="music-account-strip__avatar-image"
          src="/api/music/avatar"
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

export function MusicPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekMsRef = useRef<number | null>(null);
  const [session, setSession] = useState<MusicSessionStatus | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [qrLogin, setQrLogin] = useState<QrLogin | null>(null);
  const [qrState, setQrState] = useState<QrState>("waiting");
  const [qrBusy, setQrBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | "">("");
  const [trackPage, setTrackPage] = useState(0);
  const [sourceLabel, setSourceLabel] = useState("搜索结果");
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MusicTrackDetail | null>(null);
  const [trackBusy, setTrackBusy] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [deviceApp, setDeviceApp] = useState<MusicDeviceAppStatus | null>(null);
  const [deviceProbe, setDeviceProbe] = useState<MusicDeviceProbe | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [devicePanelOpen, setDevicePanelOpen] = useState(false);
  const [mirrorOn, setMirrorOn] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const mirrorRunnerRef = useRef<LatestTaskRunner<{ frames: MirrorFrame[] }> | null>(null);
  const trackProgressRef = useRef(0);
  const [skin, setSkin] = useState<MusicSkin>("signal");
  const [mode, setMode] = useState<MusicMode>("ticker");
  const [accent, setAccent] = useState<string | null>(null);
  const lastLocalSeqRef = useRef(0);
  const lastSeenSeqRef = useRef(0);
  const [deviceOnline, setDeviceOnline] = useState(false);
  const deviceOnlineRef = useRef(false);
  const deviceClockRef = useRef<{
    playheadMs: number;
    fetchedAt: number;
    playing: boolean;
    trackId: number | null;
  }>({ playheadMs: 0, fetchedAt: 0, playing: false, trackId: null });
  const [deviceTrackId, setDeviceTrackId] = useState<number | null>(null);
  const loadingTrackRef = useRef(false);
  const [dragMs, setDragMs] = useState<number | null>(null);
  // Mirrors dragMs so the pointer-up commit never reads a stale value while a
  // continuous slider onChange is still flushing through React state.
  const dragMsRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  // A device seek that heartbeats haven't confirmed yet: hold the optimistic
  // preview anchor until DPLAY lands near the target (or the wait times out),
  // so a stale pre-seek heartbeat can't yank the scrubber back.
  const pendingSeekRef = useRef<{ targetMs: number; at: number } | null>(null);
  const lastSentSeekRef = useRef<number | null>(null);
  const durationRef = useRef(0);

  const loadSession = useCallback(async () => {
    try {
      const result = await jsonApi<{ session: MusicSessionStatus }>("/api/music/session");
      setSession(result.session);
      setSessionError(null);
    } catch (error) {
      setSessionError(errorMessage(error));
    }
  }, []);

  const loadDeviceApp = useCallback(async () => {
    try {
      const result = await jsonApi<{ deviceApp: MusicDeviceAppStatus }>("/api/music/device-app");
      setDeviceApp(result.deviceApp);
      setDeviceError(null);
    } catch (error) {
      setDeviceError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadSession();
    void loadDeviceApp();
  }, [loadDeviceApp, loadSession]);

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

  // Poll device state so the TC002's own key presses (play/pause, skin, mode)
  // reflect back into the web UI. Our own changes are skipped via the seq we
  // last sent, so this only applies device-originated changes.
  useEffect(() => {
    let cancelled = false;
    const parseState = (text: string): Record<string, string> => {
      const fields: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab > 0) fields[line.slice(0, tab)] = line.slice(tab + 1).trim();
      }
      return fields;
    };
    const poll = async () => {
      try {
        const response = await fetch("/api/music/device/state", { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const fields = parseState(await response.text());

        // Heartbeat — processed every poll (independent of seq). Detects that the
        // music firmware is live and anchors its playback clock for preview sync.
        const hbAge = Number(fields.HBAGE);
        // 10s window: the device pauses heartbeats while it blocks on a ~5-7s
        // track download, and we must not flip it to "offline" during that.
        const online = Number.isFinite(hbAge) && hbAge >= 0 && hbAge < 10000;
        setDeviceOnline(online);
        deviceOnlineRef.current = online;
        if (online) {
          const devicePlaying = fields.DPLAYING === "1";
          const dplayMs = Number(fields.DPLAY) || 0;
          const heartbeatTrackId = fields.DTRACK && fields.DTRACK !== "-" ? Number(fields.DTRACK) : null;
          // A just-sent seek: the device applies it on its own 2s poll, so a
          // heartbeat can still carry the pre-seek playhead. Keep the optimistic
          // anchor until DPLAY lands near the target, or give up after 8s.
          const pending = pendingSeekRef.current;
          const holdAnchor = pending !== null
            && performance.now() - pending.at < 8_000
            && Math.abs(dplayMs - pending.targetMs) > 3_000;
          if (pending && !holdAnchor) pendingSeekRef.current = null;
          if (holdAnchor) {
            deviceClockRef.current = {
              ...deviceClockRef.current,
              playing: devicePlaying,
              trackId: heartbeatTrackId,
            };
          } else {
            deviceClockRef.current = {
              // Anchor = device playhead when we received this response. Add the
              // heartbeat-age compensation ONLY while playing — when paused the
              // device playhead is frozen, so adding the (varying 0..2000ms)
              // heartbeat age would make the displayed time jitter back and forth.
              playheadMs: dplayMs + (devicePlaying ? Math.max(0, hbAge) : 0),
              fetchedAt: performance.now(),
              playing: devicePlaying,
              trackId: heartbeatTrackId,
            };
          }
          setPlaying(devicePlaying);
          setDeviceTrackId(heartbeatTrackId);
        }

        // Control echo — only when seq advances and it wasn't our own change.
        const seq = Number(fields.SEQ);
        if (!Number.isFinite(seq) || seq === lastSeenSeqRef.current) return;
        lastSeenSeqRef.current = seq;
        if (seq === lastLocalSeqRef.current) return;
        if (isMusicSkin(fields.SKIN ?? null)) setSkin(fields.SKIN as MusicSkin);
        if (isMusicMode(fields.MODE ?? null)) setMode(fields.MODE as MusicMode);
        setAccent(fields.ACCENT && fields.ACCENT !== "-" ? fields.ACCENT : null);
        // Playback echo only matters in native mode; music-firmware playback is
        // driven by the heartbeat above and local audio stays silent.
        if (!online) {
          const devicePlaying = fields.PLAY === "1";
          setPlaying(devicePlaying);
          const audio = audioRef.current;
          if (audio) {
            if (devicePlaying && audio.paused) void audio.play().catch(() => {});
            else if (!devicePlaying && !audio.paused) audio.pause();
          }
        }
      } catch {
        // Network hiccup; retry on the next tick.
      }
    };
    const timer = window.setInterval(() => void poll(), 2500);
    void poll();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  // Music-firmware mode: drive the preview clock off the device's reported
  // playhead — anchor from each heartbeat, interpolate locally between them — so
  // the on-screen animation tracks the device's real playback instead of racing
  // ahead of the push + download + play latency.
  useEffect(() => {
    if (!deviceOnline) return;
    let raf = 0;
    let lastSet = 0;
    const tick = (now: number) => {
      // While the device is still fetching a just-selected track, hold the clock
      // instead of surfacing the previous track's stale playhead.
      // Hold the clock while the track is still loading, or while the user is
      // dragging the scrubber (so their drag isn't yanked back). Clamp to the
      // track length so the estimate never runs past the end.
      if (!loadingTrackRef.current && !draggingRef.current) {
        const clk = deviceClockRef.current;
        let estimate = clk.playheadMs + (clk.playing ? Math.max(0, now - clk.fetchedAt) : 0);
        const dur = durationRef.current;
        if (dur > 0 && estimate > dur) estimate = dur;
        if (now - lastSet > 120) {
          setCurrentMs(estimate);
          lastSet = now;
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [deviceOnline]);

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

  useEffect(() => {
    if (!session?.loggedIn) {
      setPlaylists([]);
      return;
    }
    let cancelled = false;
    void jsonApi<{ playlists: MusicPlaylist[] }>("/api/music/playlists")
      .then((result) => { if (!cancelled) setPlaylists(result.playlists); })
      .catch((error) => { if (!cancelled) setLibraryError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [session?.loggedIn]);

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

  const activeLyricIndex = useMemo(() => {
    if (!selected?.lyrics.length) return -1;
    for (let index = selected.lyrics.length - 1; index >= 0; index -= 1) {
      if (currentMs >= selected.lyrics[index]!.startMs) return index;
    }
    return -1;
  }, [currentMs, selected]);

  const activeLyric = activeLyricIndex >= 0 ? selected?.lyrics[activeLyricIndex] : undefined;

  useEffect(() => {
    if (!mirrorOn || !selected || deviceOnline) return;
    const durationMs = activeLyric ? activeLyric.endMs - activeLyric.startMs : 4_000;
    const frames = renderMirrorFrames({
      text: activeLyric?.text ?? selected.track.title,
      hasLyric: Boolean(activeLyric && activeLyric.text.trim().length > 0),
      durationMs,
      mode,
      skin,
      trackProgress: trackProgressRef.current,
      playing,
    });
    if (frames.length > 0) void mirrorRunnerRef.current?.enqueue({ frames });
  }, [activeLyric, mirrorOn, mode, playing, selected, skin]);
  const effectiveDurationMs = durationMs > 0 ? durationMs : selected?.track.durationMs ?? 0;
  durationRef.current = effectiveDurationMs;
  const timelineDisplayMs = Math.min(dragMs ?? currentMs, effectiveDurationMs);
  const selectedTrackIndex = selected
    ? tracks.findIndex((track) => track.id === selected.track.id)
    : -1;
  const lyricProgress = activeLyric
    ? Math.min(1, Math.max(0, (currentMs - activeLyric.startMs) / Math.max(1, activeLyric.endMs - activeLyric.startMs)))
    : 0;
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

  const logout = async () => {
    setQrBusy(true);
    try {
      const result = await jsonApi<{ session: MusicSessionStatus }>("/api/music/logout", {
        method: "POST",
      });
      setSession(result.session);
      setTracks([]);
      setTrackPage(0);
      setSelectedPlaylistId("");
      setSelected(null);
      pendingSeekMsRef.current = null;
      audioRef.current?.pause();
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setQrBusy(false);
    }
  };

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
      setTracks(result.tracks);
      setTrackPage(0);
      setSelectedPlaylistId("");
      setSourceLabel(`“${normalized}”`);
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
      setTracks(result.tracks);
      setTrackPage(0);
      setSourceLabel(playlist.name);
    } catch (error) {
      setLibraryError(errorMessage(error));
    } finally {
      setLibraryBusy(false);
    }
  };

  const selectTrack = async (track: MusicTrack) => {
    setTrackBusy(true);
    setPlaybackError(null);
    pendingSeekMsRef.current = null;
    pendingSeekRef.current = null;
    lastSentSeekRef.current = null;
    audioRef.current?.pause();
    try {
      const result = await jsonApi<{ detail: MusicTrackDetail }>(`/api/music/tracks/${track.id}`);
      setSelected(result.detail);
      // Tell the device which track is current so it fetches the matching
      // audio + lyrics. Fire-and-forget: never block the web player on it.
      void fetch("/api/music/device/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId: track.id }),
      }).catch(() => {});
      setCurrentMs(0);
      setDurationMs(result.detail.track.durationMs);
      setPlaying(false);
    } catch (error) {
      setPlaybackError(errorMessage(error));
    } finally {
      setTrackBusy(false);
    }
  };

  const togglePlayback = async () => {
    if (!selected) return;
    setPlaybackError(null);
    if (deviceOnline) {
      // Music-firmware mode: the TC002 is the player. The web is a silent remote
      // — don't touch local audio, just flip state and push the command.
      const willPlay = !playing;
      setPlaying(willPlay);
      postControl({ playing: willPlay });
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    const willPlay = audio.paused;
    try {
      if (willPlay) await audio.play();
      else audio.pause();
      postControl({ playing: willPlay });
    } catch (error) {
      setPlaybackError(errorMessage(error));
    }
  };

  const seekToMs = useCallback((requestedMs: number) => {
    if (!selected) return;
    const audio = audioRef.current;
    const loadedDurationMs = audio && Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration * 1_000
      : effectiveDurationMs;
    const targetMs = clampPlaybackPositionMs(requestedMs, loadedDurationMs);
    setCurrentMs(targetMs);
    setPlaybackError(null);

    if (!audio || audio.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(audio.duration)) {
      pendingSeekMsRef.current = targetMs;
      return;
    }

    audio.currentTime = targetMs / 1_000;
    pendingSeekMsRef.current = null;
  }, [effectiveDurationMs, selected]);

  const handleLoadedMetadata = useCallback((audio: HTMLAudioElement) => {
    const loadedDurationMs = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration * 1_000
      : selected?.track.durationMs ?? 0;
    setDurationMs(loadedDurationMs);
    const pendingSeekMs = pendingSeekMsRef.current;
    if (pendingSeekMs === null) return;
    const targetMs = clampPlaybackPositionMs(pendingSeekMs, loadedDurationMs);
    audio.currentTime = targetMs / 1_000;
    setCurrentMs(targetMs);
    pendingSeekMsRef.current = null;
  }, [selected?.track.durationMs]);

  // Push a control patch to the device (fire-and-forget). The device polls
  // /state and applies it; we remember the resulting seq so our own /state poll
  // doesn't echo our own change back onto us.
  const postControl = useCallback((patch: Record<string, unknown>) => {
    void fetch("/api/music/device/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { seq?: number } | null) => {
        if (data && typeof data.seq === "number") {
          lastLocalSeqRef.current = data.seq;
          lastSeenSeqRef.current = data.seq;
        }
      })
      .catch(() => {});
  }, []);

  // Seek: native-firmware mode drives local audio; music-firmware mode sends the
  // device a seek command and optimistically re-anchors the preview clock so it
  // doesn't snap back before the next heartbeat confirms the new position.
  const handleSeek = useCallback((targetMs: number) => {
    const clamped = Math.max(0, Math.min(targetMs, durationRef.current || targetMs));
    if (deviceOnline) {
      let sendMs = Math.round(clamped);
      // The firmware dedups consecutive seeks by value, so seeking to the exact
      // same spot again (double-clicking a lyric line) would be silently
      // dropped — nudge repeats by 1ms to keep every command distinct.
      if (lastSentSeekRef.current === sendMs) sendMs = Math.max(0, sendMs - 1) || sendMs + 1;
      lastSentSeekRef.current = sendMs;
      postControl({ seekMs: sendMs });
      pendingSeekRef.current = { targetMs: clamped, at: performance.now() };
      deviceClockRef.current = {
        ...deviceClockRef.current,
        playheadMs: clamped,
        fetchedAt: performance.now(),
      };
      setCurrentMs(clamped);
    } else {
      seekToMs(clamped);
    }
  }, [deviceOnline, postControl, seekToMs]);

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

  const skipTrack = (direction: -1 | 1) => {
    if (!selected || tracks.length === 0) return;
    const index = tracks.findIndex((track) => track.id === selected.track.id);
    // Selected track not in the current list (e.g. a fresh search): restart
    // from the top instead of letting "prev" land on the last track.
    const nextIndex = index === -1 ? 0 : (index + direction + tracks.length) % tracks.length;
    const next = tracks[nextIndex];
    if (!next) return;
    // Keep the list in view sync: flip to the page holding the new track.
    setTrackPage(Math.floor(nextIndex / TRACKS_PER_PAGE));
    void selectTrack(next);
  };

  const probeDevice = async () => {
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      const result = await jsonApi<{ device: MusicDeviceProbe }>(
        "/api/music/device-app/probe",
        { method: "POST" },
      );
      setDeviceProbe(result.device);
    } catch (error) {
      setDeviceError(errorMessage(error));
    } finally {
      setDeviceBusy(false);
    }
  };

  const startDeviceSession = async () => {
    if (!deviceApp?.artifact.bundleId || !recoveryAcknowledged) return;
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      const result = await jsonApi<{ result: { message: string } }>(
        "/api/music/device-app/session/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmation: SESSION_CONFIRMATION,
            expectedBundleId: deviceApp.artifact.bundleId,
          }),
        },
      );
      setSessionMessage(result.result.message);
      await loadDeviceApp();
    } catch (error) {
      setDeviceError(errorMessage(error));
    } finally {
      setDeviceBusy(false);
    }
  };

  const stopDeviceSession = async () => {
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      const result = await jsonApi<{ result: { message: string } }>(
        "/api/music/device-app/session/stop",
        { method: "POST" },
      );
      setSessionMessage(result.result.message);
      await loadDeviceApp();
    } catch (error) {
      setDeviceError(errorMessage(error));
    } finally {
      setDeviceBusy(false);
    }
  };

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
  const sessionActive = deviceApp?.session?.active === true;
  // Music firmware is online but the track it reports playing isn't the one we
  // just selected yet — it's still downloading. Show a loading state, not the
  // old track's progress.
  const loadingTrack = deviceOnline && selected != null && deviceTrackId !== selected.track.id;
  loadingTrackRef.current = loadingTrack;
  // If the track changes (or starts loading) mid-drag the slider gets disabled
  // under the pointer and the release event may never commit — drop any
  // half-finished drag instead of letting draggingRef wedge the preview clock.
  const selectedTrackId = selected?.track.id ?? null;
  useEffect(() => {
    draggingRef.current = false;
    dragMsRef.current = null;
    setDragMs(null);
  }, [selectedTrackId, loadingTrack]);
  const canStartSession = deviceApp?.artifact.state === "ready"
    && deviceProbe?.connected === true
    && !sessionActive;
  const previewStatus = loadingTrack
    ? "设备载入中"
    : trackBusy
      ? "正在载入"
      : playing
        ? "正在播放"
        : selected
          ? "已载入"
          : "等待选歌";
  const deviceStatus = sessionActive
    ? "调试会话运行中"
    : deviceProbe?.connected
      ? "TC002 已连接"
      : deviceApp?.artifact.state === "ready"
        ? "旁载包已就绪"
        : "旁载调试";
  const visibleLyrics = selected?.lyrics.length
    ? selected.lyrics.slice(Math.max(0, activeLyricIndex - 1), activeLyricIndex + 4)
    : [];
  const selectedPlaylist = selectedPlaylistId === ""
    ? undefined
    : playlists.find((playlist) => playlist.id === selectedPlaylistId);
  const totalTrackPages = Math.max(1, Math.ceil(tracks.length / TRACKS_PER_PAGE));
  const currentTrackPage = Math.min(trackPage, totalTrackPages - 1);
  const pageStart = currentTrackPage * TRACKS_PER_PAGE;
  const pageTracks = tracks.slice(pageStart, pageStart + TRACKS_PER_PAGE);

  return (
    <div className="music-studio">
      <section className="music-library" aria-labelledby="music-library-title">
        <header className="music-library__header">
          <div className="music-section-heading">
            <span>SOURCE / NETEASE</span>
            <h2 id="music-library-title">从一首歌开始</h2>
            <p>搜索网易云音乐，或从你的歌单中选择。</p>
          </div>
          <Button
            type="button"
            className="music-device-trigger"
            contentClassName="music-device-trigger__content"
            size="sm"
            color="neutral"
            variant="transparent"
            outline
            aria-haspopup="dialog"
            aria-label={`设备与固件，${deviceStatus}`}
            onClick={() => setDevicePanelOpen(true)}
          >
            <HardDrive aria-hidden="true" />
            <span>设备与固件</span>
            <ChevronRight aria-hidden="true" />
          </Button>
        </header>

        <div className="music-account-strip">
          {session?.loggedIn ? (
            <>
              {session.profile && <MusicAccountAvatar profile={session.profile} />}
              <div><strong>{session.profile?.nickname}</strong><span>扫码会话已保存在本机</span></div>
              <Button type="button" size="sm" square variant="transparent" outline={false} aria-label="退出网易云音乐" disabled={qrBusy} onClick={() => void logout()}><LogOut /></Button>
            </>
          ) : (
            <>
              <span className="music-account-strip__avatar is-signed-out" aria-hidden="true"><Radio /></span>
              <div><strong>尚未登录</strong><span>使用网易云音乐 App 扫码</span></div>
              <Button type="button" size="sm" loading={qrBusy} disabled={qrBusy} onClick={() => void startQrLogin()}><Radio />生成二维码</Button>
            </>
          )}
        </div>

        {qrLogin && !session?.loggedIn && (
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
              placeholder="例如：夜航"
              maxLength={80}
              clearButton
              clearLabel="清空搜索"
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
              disabled={searchBusy || query.trim().length === 0}
            >
              <Search aria-hidden="true" />搜索
            </Button>
          </div>
        </form>

        {playlists.length > 0 && (
          <div className="music-playlist-select">
            <span id="music-playlist-label"><ListMusic aria-hidden="true" />我的歌单</span>
            <Select<MusicPlaylist, number>
              className="music-playlist-select__control"
              value={selectedPlaylistId === "" ? undefined : selectedPlaylistId}
              options={playlists}
              getOptionValue={(playlist) => playlist.id}
              renderOption={({ value }) => value.name}
              renderOptionInfo={({ value }) => `${value.trackCount} 首歌曲`}
              placeholder="选择一个歌单"
              title="我的网易云歌单"
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

        <div className="music-track-list">
          <div className="music-track-list__heading"><span>{sourceLabel}</span><small>{tracks.length} 首</small></div>
          {libraryError && <p className="music-inline-error" role="alert">{libraryError}</p>}
          <List className="music-track-list__viewport" aria-busy={libraryBusy}>
            {tracks.length === 0 && !libraryBusy ? (
              <div className="music-empty-state"><Search /><strong>先找一首歌</strong><span>无需登录也可以搜索；登录后还能打开你的歌单。</span></div>
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
                  icon={<span className="music-track-index">{String(pageStart + index + 1).padStart(2, "0")}</span>}
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

      <section className="music-stage" aria-labelledby="music-preview-title">
        <div className="music-stage__sticky">
          <header className="music-stage__header">
            <div className="music-stage__heading">
              <span className="music-stage__eyebrow">
                <Radio aria-hidden="true" />
                <span className="music-stage__eyebrow-label">LIVE PREVIEW</span>
                <em className={"music-stage__pulse" + (playing ? " is-live" : "")} aria-live="polite">
                  <i aria-hidden="true" />{previewStatus}
                </em>
              </span>
              <h2 id="music-preview-title">52 × 16 像素屏</h2>
            </div>
            <div className="music-stage__header-actions">
              {deviceOnline ? (
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
                  variant={mirrorOn ? "solid-fill" : "transparent"}
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
            </div>
          </header>

          <PixelLyricsPreview
            currentText={displayCurrent}
            hasLyric={Boolean(activeLyric && activeLyric.text.trim().length > 0)}
            lyricProgress={lyricProgress}
            lyricDurationMs={activeLyric ? activeLyric.endMs - activeLyric.startMs : 0}
            trackProgress={trackProgress}
            playing={playing && !loadingTrack}
            skin={skin}
            accent={accent}
            mode={mode}
          />

          {loadingTrack && (
            <div className="music-sync-hint" role="status" aria-live="polite">
              <span aria-hidden="true"><Spinner size="xs" color="brand" /></span>
              <span>正在同步到设备，请稍候…</span>
            </div>
          )}

          {mirrorError && <p className="music-inline-error" role="alert">同屏推送失败：{mirrorError}</p>}

          <MusicThemePanel
            mode={mode}
            skin={skin}
            accent={accent}
            onModeChange={chooseMode}
            onSkinChange={chooseSkin}
            onAccentChange={chooseAccent}
            syncsToDevice={deviceOnline}
          />

          <section
            className={"music-now-playing" + (selected ? "" : " is-empty")}
            aria-label={selected ? undefined : "网页试听播放器"}
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
                        : "WEB AUDIO"}
                    </strong>
                  </div>
                  <Chip
                    className="music-output-chip"
                    size="sm"
                    color={playing ? "brand" : "neutral"}
                    variant="transparent"
                    icon={Wifi}
                    iconProps={{ "aria-hidden": true }}
                    aria-live="polite"
                  >{playing ? "网页试听中" : "网页试听"}</Chip>
                </header>

                <div className="music-now-playing__main">
                  <div className="music-now-playing__identity">
                    <span>当前曲目</span>
                    <h3 id="music-current-track-title">{selected.track.title}</h3>
                    <p>{artistLabel(selected.track)} · {selected.track.album || "未知专辑"}</p>
                  </div>
                  <div className="music-transport" aria-label="网页试听控制">
                    <Button type="button" size="md" square variant="transparent" outline={false} tightFocusRing aria-label="上一首" disabled={tracks.length < 2} onClick={() => skipTrack(-1)}><ChevronLeft /></Button>
                    <Button
                      type="button"
                      className="music-play-button"
                      size="xl"
                      square
                      rounded
                      color="brand"
                      variant="solid-fill"
                      tightFocusRing
                      aria-label={playing ? "暂停网页试听" : "开始网页试听"}
                      loading={trackBusy}
                      disabled={trackBusy}
                      onClick={() => void togglePlayback()}
                    >
                      {playing ? <Pause /> : <Play />}
                    </Button>
                    <Button type="button" size="md" square variant="transparent" outline={false} tightFocusRing aria-label="下一首" disabled={tracks.length < 2} onClick={() => skipTrack(1)}><ChevronRight /></Button>
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
                <div><strong>还没有选择歌曲</strong><p>从左侧选择后，这里会出现播放控制与进度。</p></div>
              </div>
            )}

            {playbackError && <p className="music-inline-error" role="alert">{playbackError}</p>}
            {selected && (
              <audio
                ref={audioRef}
                src={"/api/music/tracks/" + selected.track.id + "/stream"}
                preload="metadata"
                onPlay={(event) => {
                  setCurrentMs(event.currentTarget.currentTime * 1_000);
                  setPlaying(true);
                }}
                onPause={(event) => {
                  setCurrentMs(event.currentTarget.currentTime * 1_000);
                  setPlaying(false);
                }}
                onEnded={() => setPlaying(false)}
                onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1_000)}
                onLoadedMetadata={(event) => handleLoadedMetadata(event.currentTarget)}
                onDurationChange={(event) => {
                  if (Number.isFinite(event.currentTarget.duration) && event.currentTarget.duration > 0) {
                    setDurationMs(event.currentTarget.duration * 1_000);
                  }
                }}
                onError={() => setPlaybackError("音频没有载入。歌曲可能受版权、会员或地区限制。")}
              />
            )}
          </section>

          <section className="music-lyrics-panel" aria-labelledby="music-lyrics-title">
            <header>
              <div><span>LYRICS</span><h3 id="music-lyrics-title">歌词轨</h3></div>
              <small>{selected ? "点击歌词可跳转" : "选择歌曲后显示"}</small>
            </header>
            {visibleLyrics.length > 0 ? (
              <List className="music-lyric-tape" aria-label="歌词时间轴">
                {visibleLyrics.map((line) => (
                  <ListButton
                    type="button"
                    key={line.startMs + "-" + line.text}
                    className={`music-lyric-row${activeLyric?.startMs === line.startMs ? " is-active" : ""}`}
                    contentClassName="music-lyric-row__content"
                    innerContentClassName="music-lyric-row__copy"
                    titleClassName="music-lyric-row__title"
                    footerClassName="music-lyric-row__translation"
                    icon={<time>{formatTime(line.startMs)}</time>}
                    footer={line.translation}
                    color={activeLyric?.startMs === line.startMs ? "brand" : "neutral"}
                    rounded={false}
                    tightFocusRing
                    aria-current={activeLyric?.startMs === line.startMs ? "true" : undefined}
                    aria-label={"跳转到 " + formatTime(line.startMs) + "，" + line.text}
                    onClick={() => handleSeek(line.startMs)}
                  >
                    {line.text}
                  </ListButton>
                ))}
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
      </section>

      <Dialog
        open={devicePanelOpen}
        onOpenChange={(open) => {
          if (!deviceBusy) setDevicePanelOpen(open);
        }}
        className="music-firmware-dialog"
        contentClassName="music-firmware-dialog__content"
        closeOnBackdropClick={!deviceBusy}
        closeOnEscape={!deviceBusy}
        title={(
          <div className="music-firmware-dialog__title">
            <div><span>DEVICE / FIRMWARE</span><strong>设备与固件</strong></div>
            <Button
              type="button"
              size="sm"
              square
              variant="transparent"
              outline={false}
              aria-label="关闭设备与固件"
              disabled={deviceBusy}
              onClick={() => setDevicePanelOpen(false)}
            >
              <X />
            </Button>
          </div>
        )}
      >
        <section className="music-deploy" aria-labelledby="music-deploy-title">
          <div className="music-section-heading">
            <span>SIDELOAD SESSION</span>
            <h2 id="music-deploy-title">旁载调试会话</h2>
            <p>播放器只推送到 TC002 的内存盘临时运行，不写入设备存储；官方固件保持原样，断电重启即自动恢复。</p>
          </div>

          <ol className="music-deploy-steps">
            <li className={deviceApp?.artifact.state === "ready" ? "is-done" : "is-current"}>
              <span>1</span><div><strong>校验旁载包</strong><small>{deviceApp?.artifact.message ?? "正在读取发布清单…"}</small></div>
            </li>
            <li className={deviceProbe?.connected ? "is-done" : deviceApp?.artifact.state === "ready" ? "is-current" : undefined}>
              <span>2</span><div><strong>检测 TC002</strong><small>{deviceProbe?.message ?? (deviceApp?.adb === "missing" ? "后台服务尚未识别 adb；请重新运行安装脚本" : "通过 HTTP 与 Wi-Fi ADB 双重确认")}</small></div>
            </li>
            <li className={sessionActive ? "is-done" : canStartSession ? "is-current" : undefined}>
              <span>3</span><div><strong>开始调试会话</strong><small>{sessionMessage ?? (sessionActive ? "会话运行中；结束会话或断电重启即可回到官方固件" : "旁载包校验通过后解锁；不会写入官方固件")}</small></div>
            </li>
          </ol>

          {deviceProbe?.connected && (
            <dl className="music-device-facts">
              <div><dt>设备</dt><dd>{deviceProbe.model || "TC002"}</dd></div>
              <div><dt>平台</dt><dd>{deviceProbe.platform || "Z21"}</dd></div>
              <div><dt>应用</dt><dd>{deviceProbe.appVersion || "—"}</dd></div>
              <div><dt>MCU</dt><dd>{deviceProbe.mcuVersion || "—"}</dd></div>
            </dl>
          )}

          <label className="music-recovery-acknowledgement">
            <Checkbox
              as="span"
              className="music-recovery-checkbox"
              input
              size="md"
              color="brand"
              checked={recoveryAcknowledged}
              onChange={setRecoveryAcknowledged}
            />
            <span><strong>我知道如何回到官方固件</strong>结束会话即恢复官方界面；断电重启同样自动恢复。仍异常时断电后按住 USB-C 旁的复位按钮再上电。</span>
          </label>

          <div className="music-deploy-actions">
            <Button type="button" variant="transparent" outline loading={deviceBusy} disabled={deviceBusy} onClick={() => void probeDevice()}><Wifi />检测 TC002</Button>
            {sessionActive ? (
              <Button type="button" color="brand" loading={deviceBusy} disabled={deviceBusy} onClick={() => void stopDeviceSession()}><Power />结束会话</Button>
            ) : (
              <Button type="button" color="brand" loading={deviceBusy} disabled={!canStartSession || !recoveryAcknowledged || deviceBusy} onClick={() => void startDeviceSession()}><Play />开始会话</Button>
            )}
          </div>
          {deviceError && <p className="music-inline-error" role="alert">{deviceError}</p>}
          {(deviceError || deviceProbe?.connected === false) && <DeviceReconnectGuidance />}

          <div className="music-recovery-guide">
            <span><ShieldCheck /> 非持久化设计</span>
            <h3>{deviceApp?.restore?.title ?? "回到 Ulanzi 官方固件"}</h3>
            <ol>
              {(deviceApp?.restore?.steps ?? [
                "点击「结束会话」，官方界面会立即恢复",
                "或直接断电重启 TC002，自动回到官方固件",
                "仍异常时断电后按住 USB-C 旁的复位按钮再上电",
              ]).map((step) => <li key={step}>{step}</li>)}
            </ol>
          </div>
        </section>
      </Dialog>
    </div>
  );
}
