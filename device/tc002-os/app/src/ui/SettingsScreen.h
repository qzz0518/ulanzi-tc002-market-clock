#ifndef UI_SETTINGSSCREEN_H_
#define UI_SETTINGSSCREEN_H_

#include <string>
#include <vector>

#include "core/RingModel.h"
#include "ui/Screen.h"

namespace tcos {

/**
 * Device information and the entry point to WiFi provisioning.
 *
 * A settings screen normally shows "label: value" on one row. That is not
 * available here: both glyph tables are 12 px tall and the panel is 16, so the
 * panel holds exactly ONE text row — there is no second line to put the label
 * on, and no smaller font to demote it to.
 *
 * So the two share the row in time instead of in space. Landing on an item
 * shows its label; after a short dwell the label slides up and out and the
 * value slides in from below. Turning the knob rewinds to the label, so the
 * question is always re-asked before the answer is given, and a user who looks
 * away never sees a bare "192.168.8.240" with nothing saying what it is.
 */
class SettingsScreen : public Screen {
 public:
  struct Row {
    std::string label;  // UTF-8, CJK
    std::string value;
    int id;             // returned by takeActivated(); 0 means "not actionable"
  };

  // How long the label holds before the value takes the row.
  static const int kLabelDwellMs = 1100;
  static const int kSwapMs = 260;

  SettingsScreen();

  /** Replaces the contents. The selection is kept when the row count is stable,
   *  so a value refreshing under the user does not move them somewhere else. */
  void setRows(const std::vector<Row>& rows, int nowMs);

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

  int takeActivated();
  int selectedIndex() const { return mRing.index(); }

  /**
   * Skips the label dwell so the value is on the row now.
   *
   * For rows that CYCLE their own value. Without it a press changes something
   * invisible: the row is showing its label for 1100 ms, the value that just
   * moved is off-panel, and the user presses again — advancing the setting two
   * positions to see the first one. Called by the handler right after it
   * rebuilds the rows.
   */
  void revealValue(int nowMs) { mRowShownMs = nowMs - kLabelDwellMs; }

 private:
  void renderRail(Surface& out) const;

  std::vector<Row> mRows;
  RingModel mRing;
  int mEnteredMs;
  int mRowShownMs;   // when the current row was landed on
  int mActivated;
  int mPressFlashMs;
};

}  // namespace tcos

#endif  // UI_SETTINGSSCREEN_H_
