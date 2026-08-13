#ifndef UI_PROVISIONSCREEN_H_
#define UI_PROVISIONSCREEN_H_

#include <string>
#include <vector>

#include "ui/Screen.h"

namespace tcos {

/**
 * The panel half of BLE provisioning.
 *
 * This screen exists because the console cannot answer the two questions a user
 * standing in front of the clock actually has: WHICH of these devices is mine,
 * and am I allowed to configure it. The phone's chooser shows a list of names;
 * the panel shows the same name. The console asks for six digits; the panel is
 * the only place they exist.
 *
 * ONE PAGE AT A TIME, because that is all there is. Both glyph tables are 12 px
 * tall on a 16 px panel, so there is exactly one text row — no label above a
 * value, no two-line layout, no smaller font. Pages therefore share the row in
 * time, and the bottom row carries a rail so a user can tell a live panel from a
 * frozen one while the text is mid-scroll.
 *
 * THE HONESTY RULE, and it is the whole reason this screen is a state machine
 * rather than three strings: the name and the code are shown ONLY when the
 * transport has confirmed the advertisement is enabled. Everything else here is
 * derived from something the device knows for certain; those two would be
 * trivial to print optimistically, and a device advertising a name and a code
 * that are not on the air is a user tapping a chooser that will never list them.
 * kRadioDown says so instead.
 */
class ProvisionScreen : public Screen {
 public:
  enum Stage {
    kRadioDown,    // the BT stack did not come up; nothing is on the air
    kAdvertising,  // on the air, nobody connected
    kLinkUp,       // a central is connected and has not proved the code yet
    kAuthorised,   // code accepted; a scan is running
    kJoining,      // credentials handed to the WiFi policy
    kOnline,       // an address on a real network
    kFailed,       // the last attempt failed; still advertising
    kGuardLocked,  // sideloaded with no /tmp/zos-allow-link — inert by design
  };

  enum Failure { kFailNone, kFailBadPsk, kFailNoAp, kFailDhcp, kFailOther };

  // Page tones. Not colours: the mapping lives in the .cpp so the host check can
  // assert what a page MEANS without pinning an RGB triple that a palette pass
  // is allowed to move.
  enum Tone { kToneLabel, kToneValue, kToneCode, kToneAlarm };

  struct State {
    State() : stage(kRadioDown), failure(kFailNone) {}
    Stage stage;
    Failure failure;
    std::string name;    // ZOS-A772; empty unless advertising is confirmed
    std::string code;    // six digits; same rule
    std::string ssid;    // the network being joined, or the one we are on
    std::string ip;
    std::string portal;  // the fallback setup page's address, or empty
  };

  struct Page {
    Page() : tone(kToneLabel) {}
    std::string text;
    Tone tone;
  };

  // The floor for the carousel. Anything shorter is a page a reader cannot
  // finish; anything that marquees needs its whole cycle on top of it.
  static const int kMinDwellMs = 2400;

  /**
   * Everything the rest of the firmware knows that this screen cares about.
   *
   * A struct rather than eight parameters because the ORDER of the rules below
   * is the interesting part and it has to be assertable: `bleAdvertising` beats
   * every stage that would print a name or a code, and `guardLocked` beats even
   * that.
   */
  struct Inputs {
    Inputs()
        : bleAdvertising(false),
          bleBlocked(false),
          guardLocked(false),
          centralConnected(false),
          authorised(false),
          scanning(false),
          joining(false),
          online(false),
          failed(false) {}
    bool bleAdvertising;    // the controller confirmed LE Set Advertise Enable
    bool bleBlocked;        // the guard closed before anything was attempted
    bool guardLocked;       // install::linkChangesAllowed() is false
    bool centralConnected;
    bool authorised;
    bool scanning;
    bool joining;
    bool online;
    bool failed;
  };

  /** The stage those facts imply. Pure; the host check pins the priority. */
  static Stage stageFor(const Inputs& inputs);

  /** The wire error code, as a panel word. Unknown codes are never guessed. */
  static Failure failureFor(const char* err);

  /** The pages this state shows, in order. Pure — the host check pins it. */
  static std::vector<Page> pagesFor(const State& state);

  /**
   * How long a page holds before the carousel advances.
   *
   * max(kMinDwellMs, one full marquee cycle). A flat period is the bug this
   * replaces: a page wide enough to scroll would be swapped out halfway through
   * its own scroll, forever, and the tail of the widest and most important
   * strings — an IP address, 蓝牙未启动 — would never be seen at all.
   */
  static int dwellMsFor(const std::string& text);

  /** Whether the carousel moves on its own in this stage. */
  static bool autoAdvances(Stage stage);

  ProvisionScreen();

  void setState(const State& state, int nowMs);
  const State& state() const { return mState; }

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

  int pageIndex() const { return mIndex; }

 private:
  ProvisionScreen(const ProvisionScreen&);
  ProvisionScreen& operator=(const ProvisionScreen&);

  void renderRail(Surface& out, int nowMs) const;
  void advanceIfDue(int nowMs);

  State mState;
  std::vector<Page> mPages;
  int mIndex;
  int mPageShownMs;
  int mEnteredMs;
};

}  // namespace tcos

#endif  // UI_PROVISIONSCREEN_H_
