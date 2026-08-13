import type { MusicPlaybackStore } from "@/lib/music-playback-store";
import type { MusicTrack } from "@/types";

/**
 * The two NetEase-only library actions: 每日推荐 and 随机播放.
 *
 * They live here rather than in the panel because neither is a render: both are
 * a fetch followed by a precise sequence of store calls, and the sequence is the
 * part that can be wrong. `随机播放` in particular has an ordering rule and a
 * guard that no screenshot would catch — see below.
 */

/** The list heading, so the user can see these are not search results. */
export const DAILY_QUEUE_LABEL = "每日推荐";
/** Says both where the song came from and why there is exactly one of it. */
export const RANDOM_LIKED_QUEUE_LABEL = "我喜欢的音乐 · 随机一首";

/** Only the store surface these two actions touch. */
export type DiscoveryPlaybackStore = Pick<
  MusicPlaybackStore,
  "setQueue" | "select" | "toggle" | "getSnapshot"
>;

export interface NeteaseDiscoveryPorts {
  requestJson: <T>(path: string) => Promise<T>;
  store: DiscoveryPlaybackStore;
}

/**
 * Fill the library list with the account's 每日推荐, for the user to pick from
 * the same way they pick from a search.
 *
 * A failure propagates: the caller shows it in the library's error banner. The
 * one thing that must never happen is an empty list rendered as a normal
 * result — that reads as "you have no recommendations today", which is a claim
 * about the account we have no basis to make.
 */
export async function loadDailyRecommendations(
  ports: NeteaseDiscoveryPorts,
): Promise<MusicTrack[]> {
  const result = await ports.requestJson<{ tracks: MusicTrack[] }>("/api/music/netease/daily");
  ports.store.setQueue(result.tracks, DAILY_QUEUE_LABEL);
  return result.tracks;
}

/**
 * Play one random liked song, right now.
 *
 * Two rules that are easy to get wrong and invisible once they are:
 *
 *  1. The queue is set BEFORE the selection. `select` resolves `queueIndex`
 *     against the queue it finds at that moment, so the other order leaves the
 *     transport at index -1 and the console showing no track position.
 *  2. `select` deliberately does not start playback — clicking a row in a
 *     playlist only loads it. This button means "play", so it follows with a
 *     `toggle`, but only if the selection actually landed and is not already
 *     playing. Toggling a failed selection would pause whatever was playing
 *     before; toggling an already-playing device would stop it.
 */
export async function playRandomLikedTrack(
  ports: NeteaseDiscoveryPorts,
): Promise<MusicTrack> {
  const result = await ports.requestJson<{ track: MusicTrack }>(
    "/api/music/netease/liked/random",
  );
  const track = result.track;
  ports.store.setQueue([track], RANDOM_LIKED_QUEUE_LABEL);
  await ports.store.select(track);
  const snapshot = ports.store.getSnapshot();
  if (snapshot.detail?.track.id !== track.id || snapshot.playing) return track;
  await ports.store.toggle();
  return track;
}
