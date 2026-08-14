#ifndef UI_VIBESCREEN_H_
#define UI_VIBESCREEN_H_

#include <string>
#include <vector>

#include "core/RingModel.h"
#include "net/StateDoc.h"
#include "ui/Screen.h"

namespace tcos {

/**
 * 「VIBE」: how much of each AI coding agent's quota is gone.
 *
 * A destination on the root ring rather than a channel, because a channel is a
 * cached GIF the service re-renders on a timer and this has to be able to react
 * the moment a session crosses 90% — the long poll delivers that in a LAN round
 * trip, and only a screen that draws the numbers itself can use it (see
 * docs/design/vibe-firmware-app.md §1).
 *
 * Pages sit on a ring, exactly like every other knob-driven list here:
 *
 *   page 0     the overview — the first two agents side by side
 *   page 1..N  one agent each, its starred metrics with meters
 *
 * The knob turns between them and wraps; a press toggles the numbers between
 * 已用 and 剩余; a hold is not consumed, so the Shell's "up one level" still
 * works from anywhere in here. The side buttons are deliberately left alone —
 * volume and brightness are what a user reaches for at any moment, and a page
 * of numbers has no claim on them.
 *
 * The layout is the one the LED channel version shipped with (see
 * docs/design/vibe-usage.md §3) because that one was read on the real panel:
 * 10 px marks and a value column on the overview, a 12 px mark plus a 14 px
 * meter and a right-aligned value on a detail page, white → amber at 80% → red
 * at 90%, and one amber pixel in the corner when the numbers are being held up
 * from a failed refresh.
 *
 * Pure (state, nowMs) → pixels like every Screen: no clock of its own, which is
 * why the countdown alternation and the ring slide can be asserted frame by
 * frame in hostcheck/selfcheck.cpp.
 */
class VibeScreen : public Screen {
 public:
  VibeScreen();

  /**
   * The agents from the last document, in the service's catalog order.
   *
   * Keeps the current page when the page COUNT is unchanged — the document is
   * republished every five minutes and on every starred-metric edit, and a
   * refresh that walked the user back to the overview would make the ring
   * unusable on exactly the screen that refreshes most.
   */
  void setAgents(const std::vector<StateDoc::VibeAgent>& agents, int nowMs);

  /**
   * What the console link is doing, so an empty page can say WHICH emptiness.
   *
   * Same three states the music screen separates, and for the same reason: "no
   * agent is signed in" is a lie on a device that was never told where the
   * console lives (a freshly flashed unit has no /tmp/zos-host) or cannot reach
   * the one it has. Only the third is about VIBE at all.
   */
  void setLink(bool configured, bool online);

  /**
   * Whether the numbers read 剩余 rather than 已用.
   *
   * Restored from prefs at boot and staged back by osLogic when it changes, the
   * way the lyric theme is: it is a preference the user set once, and coming
   * back to a page that forgot it is the only thing worse than not having the
   * toggle. The METER never inverts — it always fills with what has been spent,
   * so the graphic means one thing and only the number changes under it.
   */
  void setShowLeft(bool showLeft);
  bool showLeft() const { return mShowLeft; }
  /** True once since the user last pressed. Reading it clears it. */
  bool takeShowLeftChanged();

  /** Pages on the ring: 1 + one per agent, or 1 for the empty state. */
  int pageCount() const;
  int page() const { return mRing.index(); }

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

  /**
   * How long the value column shows the percentage before the reset countdown
   * takes it, and how long the countdown holds.
   *
   * The two share the cell because there is nowhere else for the countdown to
   * go: the meter takes x=19..32 and a three-digit value takes x=37..51, which
   * is the row. Sharing a row in TIME is what the settings screen already does
   * with its labels, and the phase is anchored to the page change so walking
   * onto a page always shows the number first.
   */
  static const int kValueDwellMs = 3200;
  static const int kResetDwellMs = 1600;

 private:
  void renderPage(Surface& out, int index, int originX, int nowMs) const;
  void renderOverview(Surface& out, int originX, int nowMs) const;
  void renderAgent(Surface& out, const StateDoc::VibeAgent& agent, int originX,
                   int nowMs) const;
  void renderRail(Surface& out) const;

  std::vector<StateDoc::VibeAgent> mAgents;
  RingModel mRing;
  bool mLinkConfigured;
  bool mLinkOnline;
  bool mShowLeft;
  bool mShowLeftChanged;
  // When the visible page last changed, so the value/countdown alternation
  // starts on the value rather than wherever the wall clock happens to be.
  int mPageMs;
  int mPressFlashMs;  // when the confirm flash started, or -1
};

}  // namespace tcos

#endif  // UI_VIBESCREEN_H_
