#ifndef UI_MUSICSCREEN_H_
#define UI_MUSICSCREEN_H_

#include <string>

#include "ui/Screen.h"

namespace tcos {

/**
 * Now playing, and the transport for it.
 *
 * The dedicated lyrics-player firmware renders lyrics from a track it streams
 * itself. This screen is the opposite arrangement and much cheaper: the service
 * already knows what the Connect player is doing, resolves the id to a title and
 * picks the lyric line, so the panel only has to draw text and a playhead.
 *
 * Controls are chosen around what is free. The knob has no list to scroll here,
 * so it becomes previous/next; the middle button toggles play; hold still means
 * back. The side buttons are deliberately NOT taken over — volume is the one
 * control a user reaches for while music is playing, and a music screen that
 * stole it to mean "next track" would be exactly backwards.
 */
class MusicScreen : public Screen {
 public:
  enum Action { kNone, kToggle, kNext, kPrevious };

  MusicScreen();

  /**
   * `positionMs` is true as of `stampMs`; the screen advances it locally rather
   * than waiting for the next document, which is what makes the playhead move
   * at 25 fps over a link that updates a few times a minute.
   */
  void setNowPlaying(bool present, const std::string& track, const std::string& artist,
                     const std::string& lyric, bool playing, int positionMs,
                     int durationMs, int stampMs);

  /**
   * What the console link is doing, so the empty state can say which emptiness
   * it is.
   *
   * Without this the screen renders the same "未播放" for three unrelated
   * situations: the service says nothing is playing, the device cannot reach the
   * service, and the device was never told where the service lives. The third is
   * the normal state of a freshly FLASHED unit — /tmp/zos-host is written by the
   * sideload script and a cold boot has no /tmp — and it is the one where
   * "未播放" is an outright lie that sends the user hunting the music feature
   * instead of the address. Every other screen either has no link (games) or
   * shows its own status (the channel ring); this was the one place a dead link
   * was indistinguishable from a quiet one.
   *
   * Defaults to configured+online, so a caller that never sets it behaves
   * exactly as before.
   */
  void setLink(bool configured, bool online);

  /** True when the link is up but nothing is playing, or no provider is set. */
  bool idle() const { return !mPresent; }

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

  /** The transport command the user asked for, or kNone. Reading clears it. */
  Action takeAction();

  // How long the title holds before the artist takes the row, when there is no
  // lyric to show instead.
  static const int kRotateMs = 3200;

 private:
  int playheadMs(int nowMs) const;

  bool mPresent;
  bool mLinkConfigured;
  bool mLinkOnline;
  bool mPlaying;
  std::string mTrack;
  std::string mArtist;
  std::string mLyric;
  int mPositionMs;
  int mDurationMs;
  int mStampMs;
  int mEnteredMs;
  int mLyricChangedMs;
  int mFlashMs;
  Action mAction;
  // Optimistic transport state: the panel flips the moment the button is
  // pressed rather than a round trip later, because a play button that takes
  // 300 ms to look pressed reads as a dropped input.
  int mOptimisticUntilMs;
  bool mOptimisticPlaying;
};

}  // namespace tcos

#endif  // UI_MUSICSCREEN_H_
