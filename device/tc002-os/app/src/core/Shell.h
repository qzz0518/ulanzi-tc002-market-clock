#ifndef CORE_SHELL_H_
#define CORE_SHELL_H_

#include <vector>

#include "core/Surface.h"
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
  enum Transition {
    kCut,          // no animation
    kPushForward,  // descending: new screen slides in from the right
    kPopBack,      // ascending: previous screen slides back in from the left
    kFadeIn,       // boot handoff
  };

  static const int kTransitionMs = 220;

  Shell(int width, int height);

  // Shell does not own screens; the caller keeps them alive for the app's life.
  // That is deliberate on a device with ~1 MB free: screens are long-lived
  // singletons, not allocated per visit.
  void reset(Screen* root, int nowMs);
  void push(Screen* screen, int nowMs);
  void pop(int nowMs);

  Screen* top() const;
  int depth() const { return static_cast<int>(mStack.size()); }

  // Routes an input to the top screen; unconsumed kInputHold pops one level.
  void onInput(Input input, int nowMs);

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

  void beginTransition(Transition kind, int nowMs);

  std::vector<Screen*> mStack;
  Surface mOutgoing;   // snapshot of the frame we are leaving
  Surface mIncoming;   // scratch for the frame we are entering
  LevelOverlay mOverlay;
  Transition mTransition;
  int mTransitionStartMs;
  bool mHasOutgoing;
};

}  // namespace tcos

#endif  // CORE_SHELL_H_
