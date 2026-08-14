#ifndef UI_LAUNCHERSCREEN_H_
#define UI_LAUNCHERSCREEN_H_

#include <string>
#include <vector>

#include "core/RingModel.h"
#include "ui/Screen.h"

namespace tcos {

/**
 * The main menu: one item per page, the knob moves between them.
 *
 * On a 52x16 panel a list is a lie — four 12 px CJK cells fill the width with
 * 4 px to spare, so anything that tries to show a selected row plus its
 * neighbours ends up with three unreadable rows. This screen therefore shows
 * exactly ONE entry, full-bleed, and a knob detent slides the next one in.
 *
 * Layout of a card, left to right:
 *   x=0..11   a 12x12 icon drawn procedurally (no bitmap assets to store)
 *   x=14..51  the label, 12 px CJK or 6 px Latin, marqueed when it overflows
 * and a one-pixel position rail on the bottom row so the ring's size and the
 * current position stay legible without stealing a text row.
 */
class LauncherScreen : public Screen {
 public:
  // Icons are drawn, not stored: a 12x12 RGB bitmap would be 432 bytes each and
  // this device has no room for an asset pipeline.
  enum Icon {
    kIconChannel,
    kIconMusic,
    kIconGame,
    kIconSettings,
    kIconVibe,
    // Per-game sprites, one per engine. These are polychrome where the five
    // above are single-accent badges, and that palette difference is what makes
    // entering the games ring feel like a different room.
    //
    // Everything below this line is indexed as `icon - kIconGameBreakout` into
    // gameicons::, so a new family badge goes ABOVE it, never here.
    kIconGameBreakout,
    kIconGameFlappy,
    kIconGameSnake,
    kIconGamePong,
    kIconGameRacer,
    kIconGameShooter,
    kIconGameTetris,
  };

  struct Entry {
    std::string label;  // UTF-8, user-facing (channel names come from the host)
    Icon icon;
    int id;             // opaque to this screen; the caller routes on it
  };

  LauncherScreen();

  void setEntries(const std::vector<Entry>& entries, int nowMs);

  /**
   * Chrome hue for this ring. The root stays launcher green; the games ring
   * uses the arcade blue, so the rail and arrows say which ring you are in even
   * before a card is read.
   */
  void setChrome(const Color& lit, const Color& dim);

  /** Rises 16 px on entry. Used by the games ring: hold means "up", so content
   *  arriving from below completes the metaphor. */
  void setEntryRise(bool enabled) { mEntryRise = enabled; }
  int count() const { return static_cast<int>(mEntries.size()); }

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

  // The entry the user pressed, or -1. Reading it clears it.
  int takeActivated();

  int selectedIndex() const { return mRing.index(); }

  /**
   * Moves to the entry with this id, without animating a slide across the whole
   * ring. Used by the console to name a destination directly: a remote jump is
   * not a knob turn, and spinning through six cards to reach the seventh would
   * read as the device doing something the user did not ask for.
   *
   * Returns false when no entry carries that id, so the caller can tell a
   * missing destination from a successful one rather than silently landing
   * somewhere else.
   */
  bool selectById(int id, int nowMs);

 private:
  void renderCard(Surface& out, const Entry& entry, int originX, int nowMs, int riseY) const;
  void renderRail(Surface& out) const;
  void renderArrows(Surface& out, int nowMs) const;

  std::vector<Entry> mEntries;
  RingModel mRing;
  int mEnteredMs;
  int mActivated;
  int mPressFlashMs;  // when the confirm flash started, or -1
  int mLastTurnMs;    // when the knob last moved, for the arrow flash
  int mLastTurnDir;   // +1 clockwise, -1 anti-clockwise
  Color mChromeLit;
  Color mChromeDim;
  bool mEntryRise;
};

}  // namespace tcos

#endif  // UI_LAUNCHERSCREEN_H_
