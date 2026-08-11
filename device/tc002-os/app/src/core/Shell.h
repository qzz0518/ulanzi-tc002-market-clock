#ifndef CORE_SHELL_H_
#define CORE_SHELL_H_

#include <vector>

#include "core/Surface.h"
#include "core/Transitions.h"
#include "ui/LevelOverlay.h"
#include "ui/Screen.h"

namespace tcos {

/**
 * Owns the screen stack and composes every frame.
 *
 * This deliberately replaces the arcade firmware's PageManager rather than
 * porting it. That class held its mutex across draw() *and* the SPI write —
 * including the panel's mandatory 15 ms pacing sleep — so any thread touching it
 * stalled for a whole frame; its unregisterPage decremented a (size_t)-1 "none"
 * sentinel into (size_t)-2; and navigateTo was a hard cut with nowhere to put a
 * transition. All three problems are solved by not having the class.
 *
 * Shell carries no FlyThings headers and no locks: it runs entirely on the UI
 * tick, and the whole thing compiles on the host, which is where its behaviour
 * is asserted.
 *
 * Navigation is two-dimensional, matching the single knob:
 *   horizontal — siblings on a ring, driven by the current screen
 *   vertical   — depth, push() to descend and pop() to ascend
 */
class Shell {
 public:
  /**
   * How a destination arrives when you descend into it.
   *
   * Every push used to play the same 220 ms horizontal slide, which reads as
   * scrolling to a sibling rather than as entering somewhere — the four root
   * destinations are four different kinds of place and were announcing
   * themselves identically. A destination now declares its own arrival, drawn
   * from the motifs the music and arcade firmwares already earned (see
   * core/Transitions.h for what each one is and where it came from).
   *
   * Registration is by pointer and happens once at startup, because screens on
   * this device are long-lived singletons rather than objects allocated per
   * visit; an unregistered screen gets kEntryDive.
   */
  enum Entry {
    kEntryDive = 0,   // generic descend — the default
    kEntryCrt,        // 轮播: a display switching channels
    kEntryEqualiser,  // 音乐: bars rising into the room
    kEntryCartridge,  // 游戏: a shine sweep seating a cartridge
    kEntryDrop,       // 设置: a drawer pulled down onto its stop
  };

  // The handoff/fade baseline. Direction-carrying entries set their own length
  // (transition::durationMs), so this is no longer "how long a transition is".
  static const int kTransitionMs = 220;

  // Screens are registered by pointer, so the table is a fixed array and costs
  // no allocation at all. Five destinations exist today; 8 leaves room without
  // pretending this is a general-purpose map.
  static const int kMaxEntryStyles = 8;

  Shell(int width, int height);

  // Shell does not own screens; the caller keeps them alive for the app's life.
  // That is deliberate on a device with ~1 MB free: screens are long-lived
  // singletons, not allocated per visit.
  void reset(Screen* root, int nowMs);
  void push(Screen* screen, int nowMs);
  void pop(int nowMs);

  /**
   * Declares how `screen` arrives. Survives reset(), because it describes the
   * screen and not the current stack.
   */
  void setEntryStyle(Screen* screen, Entry entry);

  /** How long that entry takes; the self-check and callers sample against it. */
  static int entryMs(Entry entry);

  Screen* top() const;
  int depth() const { return static_cast<int>(mStack.size()); }

  // Routes an input to the top screen; unconsumed kInputHold pops one level.
  void onInput(Input input, int nowMs);

  /** True when the top screen wants the side buttons raw (a game does). */
  bool topWantsRawButtons() const;
  void deliverRawButton(Input which, bool down, int nowMs);

  // Composes the current frame. The single producer of finished pixels in the
  // firmware, which is what gives the console mirror exactly one tee point.
  void render(Surface& out, int nowMs);

  bool isAnimating(int nowMs) const;

  /**
   * The volume/brightness HUD. It lives on the Shell rather than on a screen
   * because it must survive navigation and must never change what "back" means:
   * adjusting the volume is not somewhere you can be, so it cannot be a screen.
   */
  LevelOverlay& overlay() { return mOverlay; }

 private:
  Shell(const Shell&);
  Shell& operator=(const Shell&);

  // Which direction the running transition is being played in. Ascending is the
  // descent evaluated backwards rather than a second operator, so a style can
  // never look right going in and wrong coming out.
  enum Motion { kIdle, kDescend, kAscend };

  void beginTransition(transition::Style style, Motion motion, int nowMs);
  transition::Style styleFor(Screen* screen) const;

  std::vector<Screen*> mStack;
  // Parallel to mStack: the style each level was entered with, so leaving it
  // replays that same motion. Grows only on navigation, never per frame.
  std::vector<transition::Style> mStackStyles;
  Surface mOutgoing;   // snapshot of the frame we are leaving
  Surface mIncoming;   // scratch for the frame we are entering
  LevelOverlay mOverlay;
  Screen* mEntryScreens[kMaxEntryStyles];
  Entry mEntryKinds[kMaxEntryStyles];
  int mEntryCount;
  Motion mMotion;
  transition::Style mMotionStyle;
  int mMotionMs;
  int mTransitionStartMs;
  bool mHasOutgoing;
};

}  // namespace tcos

#endif  // CORE_SHELL_H_
