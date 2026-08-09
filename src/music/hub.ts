import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NeteaseMusicService } from "../netease-music.ts";
import {
  asRecord,
  isMusicProviderId,
  MusicServiceError,
  type MusicPlaybackMode,
  type MusicProfile,
  type MusicProvider,
  type MusicProviderId,
} from "./core.ts";
import type { SpotifyMusicService } from "./spotify.ts";

export interface MusicProviderSummary {
  id: MusicProviderId;
  label: string;
  playbackMode: MusicPlaybackMode;
  loggedIn: boolean;
  profile?: MusicProfile;
  // Spotify needs the user's own developer Client ID before login is even
  // possible; NetEase can always show its QR code.
  ready: boolean;
}

export interface MusicOverview {
  active: MusicProviderId;
  providers: MusicProviderSummary[];
}

// Which source the studio and the TC002 are pointed at. Persisted so restarting
// the service doesn't silently drop the device back to NetEase mid-song.
export class MusicProviderStore {
  constructor(private readonly path: string) {}

  async load(): Promise<MusicProviderId | null> {
    try {
      const record = asRecord(JSON.parse(await readFile(this.path, "utf8")) as unknown);
      return isMusicProviderId(record.active) ? record.active : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(active: MusicProviderId): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // tmp 名必须逐次唯一：同一进程里并发写会共用 `pid` 后缀，先落地的那次 rename
    // 会把文件抢走，后一次就撞上 ENOENT（Spotify 令牌刷新最容易触发）。
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, active }, null, 2)}\n`);
    await rename(temporaryPath, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

// Owns both music sources and the one that is currently live. Callers ask for
// "the active provider" and never branch on which service answered.
export class MusicHub {
  readonly netease: NeteaseMusicService;
  readonly spotify: SpotifyMusicService;
  readonly initializeFailures = new Map<MusicProviderId, string>();
  private active: MusicProviderId;

  constructor(
    private readonly options: {
      netease: NeteaseMusicService;
      spotify: SpotifyMusicService;
      store: MusicProviderStore;
      // Called after a switch so the device's selection can be cleared — a
      // NetEase track ID means nothing to Spotify, and vice versa.
      onSwitch?: (provider: MusicProvider) => void;
    },
  ) {
    this.netease = options.netease;
    this.spotify = options.spotify;
    this.active = "netease";
  }

  async initialize(): Promise<void> {
    const stored = await this.options.store.load().catch(() => null);
    if (stored) this.active = stored;
    await Promise.all([this.netease, this.spotify].map(async (provider) => {
      try {
        await provider.initialize();
      } catch (error) {
        // A single unreadable session file must not take the music module down;
        // that provider just starts signed out.
        this.initializeFailures.set(
          provider.id,
          error instanceof Error ? error.message : "unknown error",
        );
      }
    }));
  }

  activeId(): MusicProviderId {
    return this.active;
  }

  activeProvider(): MusicProvider {
    return this.provider(this.active);
  }

  provider(id: MusicProviderId): MusicProvider {
    if (id === "netease") return this.netease;
    if (id === "spotify") return this.spotify;
    throw new MusicServiceError(`音乐来源 ${id} 不可用`, 404);
  }

  async setActive(id: MusicProviderId): Promise<MusicOverview> {
    const provider = this.provider(id);
    if (this.active !== id) {
      this.active = id;
      await this.options.store.save(id);
      this.options.onSwitch?.(provider);
    }
    return this.overview();
  }

  overview(): MusicOverview {
    return {
      active: this.active,
      providers: [this.netease, this.spotify].map((provider) => {
        const status = provider.status();
        return {
          id: provider.id,
          label: provider.label,
          playbackMode: provider.playbackMode,
          loggedIn: status.loggedIn,
          ...(status.profile ? { profile: status.profile } : {}),
          ready: provider.id === "spotify" ? this.spotify.appStatus().configured : true,
        };
      }),
    };
  }
}
