import { useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { Toolbar, ToolbarButton, ToolbarSeparator, Tooltip } from "@cladd-ui/react";
import { musicPlaybackStore } from "@/lib/music-playback-store";
import { readCoverTint, type CoverTint } from "@/lib/cover-tint";
import { useMiniPlayerView } from "@/lib/use-mini-player";
import type { MiniPlayerView } from "@/lib/mini-player";
import type { StudioView } from "@/types";

/**
 * The header's mini player.
 *
 * Playback outlives the music tab now (lib/music-playback-store.ts), but on
 * every other tab it was outliving it *invisibly*: the audio kept going with
 * nothing on screen to prove it or stop it. This is the store's second
 * consumer, and it is a window, not an owner — every control routes to exactly
 * the action the music view's own transport calls, so "next" means one thing in
 * this console.
 *
 * Rendered inside `.header-actions`, to the left of the firmware and battery
 * chips. It collapses in stages as the header narrows (see `.mini-player` in
 * globals.css) — artist line, then title, then previous/next. The artwork never
 * goes: it is the one piece that is both identity and the way back, so at the
 * narrowest widths the widget is exactly that and nothing else.
 */
export function MiniPlayer({
  view,
  onOpen,
}: {
  view: StudioView;
  onOpen: () => void;
}) {
  const mini = useMiniPlayerView(view);
  const store = musicPlaybackStore();
  // Keyed by cover URL so a stale tint can never outlive the track it came from
  // — the widget is one element reused across songs, and the artwork loads
  // asynchronously behind it.
  const [tint, setTint] = useState<{ src: string; tint: CoverTint } | null>(null);
  // Nothing loaded, or the full player is already on screen: render nothing at
  // all. An empty widget parked on the heading row would cost the same room to
  // say less than the silence does.
  if (!mini) return null;
  const live = tint && tint.src === mini.coverSrc ? tint.tint : null;
  return (
    <Toolbar
      className={"mini-player" + (live?.dark ? " is-dark" : "")}
      contentClassName="mini-player__content"
      size="sm"
      // Squared off rather than the default pill: this sits under a heading, in
      // a row of rectangles, and a capsule read as a floating pop-up rather than
      // as part of the page.
      rounded={false}
      // 出错时整块的描边转红，具体原因在 tooltip 里 —— 让它继续装作一切正常，
      // 用户就只会看到一首停住的歌而不知道为什么。
      color={mini.error ? "red" : undefined}
      role="group"
      aria-label="正在播放"
      style={live ? ({ "--mini-tint": live.rgb } as React.CSSProperties) : undefined}
    >
      <Tooltip tooltip={mini.hint}>
        <ToolbarButton
          type="button"
          className="mini-player__track"
          contentClassName="mini-player__track-content"
          multiline
          aria-label={mini.trackLabel}
          onClick={onOpen}
        >
          <MiniCover
            mini={mini}
            onTint={(next) => setTint(mini.coverSrc ? { src: mini.coverSrc, tint: next } : null)}
          />
          <span className="mini-player__copy">
            <strong className="mini-player__title">{mini.title}</strong>
            <span className="mini-player__artist">{mini.artists}</span>
          </span>
        </ToolbarButton>
      </Tooltip>
      <ToolbarSeparator className="mini-player__rule" />
      <ToolbarButton
        type="button"
        className="mini-player__skip"
        square
        tightFocusRing
        aria-label="上一首"
        disabled={!mini.canSkip}
        onClick={() => store.skip(-1)}
      >
        <SkipBack />
      </ToolbarButton>
      <ToolbarButton
        type="button"
        className="mini-player__toggle"
        square
        color="brand"
        tightFocusRing
        aria-label={mini.toggleLabel}
        loading={mini.busy}
        disabled={mini.busy}
        onClick={() => void store.toggle()}
      >
        {mini.playing ? <Pause /> : <Play />}
      </ToolbarButton>
      <ToolbarButton
        type="button"
        className="mini-player__skip"
        square
        tightFocusRing
        aria-label="下一首"
        disabled={!mini.canSkip}
        onClick={() => store.skip(1)}
      >
        <SkipForward />
      </ToolbarButton>
    </Toolbar>
  );
}

/**
 * Artwork with the title's first glyph underneath it, so a cover that is
 * missing, blocked or slow degrades to a legible mark rather than a hole —
 * the same two-layer trick the music view's covers use.
 */
function MiniCover({
  mini,
  onTint,
}: {
  mini: MiniPlayerView;
  onTint: (tint: CoverTint) => void;
}) {
  return (
    <span className="mini-player__cover" aria-hidden="true">
      <span className="mini-player__cover-fallback">{mini.coverFallback}</span>
      {mini.coverSrc && (
        <img
          key={mini.coverSrc}
          className="mini-player__cover-image"
          src={mini.coverSrc}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={(event) => {
            const next = readCoverTint(event.currentTarget);
            if (next) onTint(next);
          }}
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      )}
    </span>
  );
}
