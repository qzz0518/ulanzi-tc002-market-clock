import { useEffect, useSyncExternalStore } from "react";
import {
  musicPlaybackStore,
  type MusicPlaybackSnapshot,
} from "@/lib/music-playback-store";

/**
 * Read the page's player.
 *
 * The store outlives every view, so this is a subscription, not ownership: two
 * consumers (the music view and the header's mini player) render the same
 * playback without either one being able to end it. Actions come from
 * `musicPlaybackStore()`, whose identity never changes.
 *
 * `retain` keeps the device-state poll running while the caller is mounted —
 * pass it from the view that needs the poll even with nothing loaded; a
 * read-only widget should leave it off and take whatever the store knows.
 */
export function useMusicPlayback(retain = false): MusicPlaybackSnapshot {
  const store = musicPlaybackStore();
  useEffect(() => {
    if (!retain) return;
    return store.retain();
  }, [retain, store]);
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    // Server render (component tests render to static markup): the initial
    // snapshot is the honest answer — nothing has played yet.
    store.getSnapshot,
  );
}
