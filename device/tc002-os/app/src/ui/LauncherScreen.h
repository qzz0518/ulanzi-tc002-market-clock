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
  };

  struct Entry {
    std::string label;  // UTF-8, user-facing (channel names come from the host)
    Icon icon;
    int id;             // opaque to this screen; the caller routes on it
  };

  LauncherScreen();

  void setEntries(const std::vector<Entry>& entries, int nowMs);
  int count() const { return static_cast<int>(mEntries.size()); }

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

  // The entry the user pressed, or -1. Reading it clears it.
  int takeActivated();

  int selectedIndex() const { return mRing.index(); }

 private:
  void renderCard(Surface& out, const Entry& entry, int originX, int nowMs) const;
  void renderRail(Surface& out) const;

  std::vector<Entry> mEntries;
  RingModel mRing;
  int mEnteredMs;
  int mActivated;
  int mPressFlashMs;  // when the confirm flash started, or -1
};

}  // namespace tcos

#endif  // UI_LAUNCHERSCREEN_H_
