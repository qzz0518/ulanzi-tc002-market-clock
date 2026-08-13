import { useCallback, useRef, useSyncExternalStore } from "react";
import { musicPlaybackStore } from "@/lib/music-playback-store";
import { miniPlayerKey, miniPlayerView, type MiniPlayerView } from "@/lib/mini-player";
import type { StudioView } from "@/types";

/**
 * Subscribe the header to the page's player.
 *
 * The store notifies on every playhead tick, and the header is the most
 * expensive subtree in the console to re-render — six tabs, two chips and the
 * settings dialog hang off it. So this hook caches the derived view by its
 * signature and hands React the *same object* whenever nothing the mini player
 * draws has changed, which is what `useSyncExternalStore` wants anyway: a
 * getSnapshot that returns a fresh object every call is an infinite loop.
 */
export function useMiniPlayerView(view: StudioView): MiniPlayerView | null {
  const store = musicPlaybackStore();
  const cache = useRef<{ key: string; value: MiniPlayerView | null }>({ key: "-", value: null });
  const getSnapshot = useCallback(() => {
    const next = miniPlayerView(store.getSnapshot(), view);
    const key = miniPlayerKey(next);
    if (key !== cache.current.key) cache.current = { key, value: next };
    return cache.current.value;
  }, [store, view]);
  // Static render (component tests, SSR): nothing has played yet, and the
  // honest answer is the same one — no widget.
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
