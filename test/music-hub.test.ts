import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MusicProviderId } from "../src/music/core.ts";
import { MusicHub, MusicProviderStore } from "../src/music/hub.ts";
import {
  SpotifyAppStore,
  SpotifyMusicService,
  SpotifySessionStore,
} from "../src/music/spotify.ts";
import { MusicSessionStore, NeteaseMusicService } from "../src/netease-music.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function hub(options: { onSwitch?: (id: MusicProviderId) => void } = {}): Promise<{
  hub: MusicHub;
  spotifyAppStore: SpotifyAppStore;
  storePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "tc002-hub-"));
  directories.push(directory);
  const spotifyAppStore = new SpotifyAppStore(join(directory, "spotify-app.json"));
  const storePath = join(directory, "provider.json");
  return {
    hub: new MusicHub({
      netease: new NeteaseMusicService({
        sessionStore: new MusicSessionStore(join(directory, "netease.json")),
      }),
      spotify: new SpotifyMusicService({
        appStore: spotifyAppStore,
        sessionStore: new SpotifySessionStore(join(directory, "spotify.json")),
        redirectUri: "http://127.0.0.1:43820/api/music/spotify/callback",
        lyrics: { lyrics: async () => [] },
      }),
      store: new MusicProviderStore(storePath),
      ...(options.onSwitch ? { onSwitch: (provider) => options.onSwitch!(provider.id) } : {}),
    }),
    spotifyAppStore,
    storePath,
  };
}

describe("music provider hub", () => {
  test("starts on NetEase and remembers a switch across restarts", async () => {
    const switched: MusicProviderId[] = [];
    const { hub: first, storePath } = await hub({ onSwitch: (id) => switched.push(id) });
    await first.initialize();
    expect(first.activeId()).toBe("netease");
    expect(first.activeProvider().playbackMode).toBe("device-audio");

    await first.setActive("spotify");
    expect(first.activeId()).toBe("spotify");
    expect(first.activeProvider().playbackMode).toBe("remote");
    expect(switched).toEqual(["spotify"]);

    // Re-selecting the live source is a no-op, not a second reset.
    await first.setActive("spotify");
    expect(switched).toEqual(["spotify"]);

    const restored = await new MusicProviderStore(storePath).load();
    expect(restored).toBe("spotify");
  });

  test("reports per-source login state and Spotify's setup gate", async () => {
    const { hub: instance, spotifyAppStore } = await hub();
    await instance.initialize();

    const before = instance.overview();
    expect(before.active).toBe("netease");
    expect(before.providers.map((entry) => entry.id)).toEqual(["netease", "spotify"]);
    expect(before.providers.every((entry) => !entry.loggedIn)).toBe(true);
    // NetEase can always show a QR code; Spotify needs the user's own app first.
    expect(before.providers.find((entry) => entry.id === "netease")?.ready).toBe(true);
    expect(before.providers.find((entry) => entry.id === "spotify")?.ready).toBe(false);

    await spotifyAppStore.save("0123456789abcdef0123456789abcdef");
    const reloaded = await hubFrom(instance, spotifyAppStore);
    expect(reloaded.providers.find((entry) => entry.id === "spotify")?.ready).toBe(true);
  });

  test("only exposes an audio stream on the device-audio source", async () => {
    const { hub: instance } = await hub();
    await instance.initialize();
    expect(typeof instance.provider("netease").stream).toBe("function");
    expect(instance.provider("netease").remote).toBeUndefined();
    expect(instance.provider("spotify").stream).toBeUndefined();
    expect(typeof instance.provider("spotify").remote?.snapshot).toBe("function");
  });
});

// Re-reads the Spotify app config the way a service restart would.
async function hubFrom(instance: MusicHub, _store: SpotifyAppStore) {
  await instance.spotify.initialize();
  return instance.overview();
}
