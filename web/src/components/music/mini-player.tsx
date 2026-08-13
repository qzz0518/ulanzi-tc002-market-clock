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
      beforeContent={mini.coverSrc && (
        // The cover itself, blown up and blurred, is the backdrop — not a flat
        // average of it. A single colour behind glass reads as a tinted box; the
        // blurred sleeve reads as glass sitting ON the artwork, which is the
        // thing being copied. The averaged tint is still computed, but its job
        // is now the scrim and the border, where a stable colour is what you
        // want and a moving image is not.
        <span className="mini-player__art" aria-hidden="true">
          <img src={mini.coverSrc} alt="" decoding="async" draggable={false} />
        </span>
      )}
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
        // No accent on the toggle: over a tinted panel the three transport
        // controls have to read as one set, and a green pause button next to two
        // neutral skips read as a status light rather than as the middle of a
        // row. Same reasoning as the 播放模式 button beside the full transport.
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
      <MiniSpectrum playing={mini.playing} />
    </Toolbar>
  );
}

/**
 * Eight bars at the right end, alive only while something is playing.
 *
 * Deliberately NOT an analyser on the audio graph. Binding a
 * createMediaElementSource to the element would route playback through the Web
 * Audio graph for the whole session, and this element outlives every view now —
 * one widget's decoration is not worth putting itself between the user and the
 * sound. It is CSS animation, and it says the one thing it can honestly say:
 * whether the track is running.
 *
 * Paused it holds still at its resting heights rather than disappearing, so the
 * panel does not change width when you pause it.
 */
function MiniSpectrum({ playing }: { playing: boolean }) {
  return (
    <span
      className={"mini-player__spectrum" + (playing ? " is-live" : "")}
      aria-hidden="true"
    >
      {[0, 1, 2, 3, 4, 5, 6, 7].map((bar) => <i key={bar} />)}
    </span>
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
