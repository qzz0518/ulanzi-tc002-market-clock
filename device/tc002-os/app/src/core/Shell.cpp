#include "core/Shell.h"

#include "core/Ease.h"

namespace tcos {

namespace {

transition::Style toStyle(Shell::Entry entry) {
  switch (entry) {
    case Shell::kEntryCrt: return transition::kCrt;
    case Shell::kEntryEqualiser: return transition::kEqualiser;
    case Shell::kEntryCartridge: return transition::kCartridge;
    case Shell::kEntryDrop: return transition::kDrop;
    case Shell::kEntryDive:
    default: return transition::kDive;
  }
}

}  // namespace

Shell::Shell(int width, int height)
    : mOutgoing(width, height),
      mIncoming(width, height),
      mEntryCount(0),
      mMotion(kIdle),
      mMotionStyle(transition::kDive),
      mMotionMs(transition::durationMs(transition::kDive)),
      mTransitionStartMs(0),
      mHasOutgoing(false) {
  for (int i = 0; i < kMaxEntryStyles; ++i) {
    mEntryScreens[i] = 0;
    mEntryKinds[i] = kEntryDive;
  }
}

int Shell::entryMs(Entry entry) {
  return transition::durationMs(toStyle(entry));
}

void Shell::setEntryStyle(Screen* screen, Entry entry) {
  if (screen == 0) return;
  for (int i = 0; i < mEntryCount; ++i) {
    if (mEntryScreens[i] == screen) {
      mEntryKinds[i] = entry;
      return;
    }
  }
  // Silently ignoring an overflow is the right failure here: a missing entry
  // style costs one destination its flavour, whereas asserting would take down
  // a firmware that has no console to report to.
  if (mEntryCount >= kMaxEntryStyles) return;
  mEntryScreens[mEntryCount] = screen;
  mEntryKinds[mEntryCount] = entry;
  ++mEntryCount;
}

transition::Style Shell::styleFor(Screen* screen) const {
  for (int i = 0; i < mEntryCount; ++i) {
    if (mEntryScreens[i] == screen) return toStyle(mEntryKinds[i]);
  }
  return transition::kDive;
}

void Shell::reset(Screen* root, int nowMs) {
  // Replacing something already on the panel cross-fades. A reset is neither a
  // descent nor an ascent, so either direction's motion would be a lie about
  // where the user is; the one caller is boot handing over to the launcher,
  // which osLogic has always described as a cross-fade and never got.
  const bool hadScreen = (top() != 0);
  if (hadScreen) {
    beginTransition(transition::kFade, kDescend, nowMs);
  } else {
    mHasOutgoing = false;
    mMotion = kIdle;
  }

  mStack.clear();
  mStackStyles.clear();
  if (root != 0) {
    mStack.push_back(root);
    mStackStyles.push_back(transition::kDive);
    root->onEnter(nowMs);
  }
  // The entry table deliberately survives: it describes the screens, not the
  // stack, so the handoff must not throw away what osLogic registered at start.
}

Screen* Shell::top() const {
  if (mStack.empty()) return 0;
  return mStack[mStack.size() - 1];
}

void Shell::beginTransition(transition::Style style, Motion motion, int nowMs) {
  // Snapshot what is on screen right now. Rendering the outgoing screen once
  // and reusing the pixels for the whole transition keeps it at the cost of one
  // extra composite per frame rather than two full screen renders.
  Screen* current = top();
  if (current != 0) {
    mOutgoing.clear();
    current->render(mOutgoing, nowMs);
    mHasOutgoing = true;
  } else {
    mHasOutgoing = false;
  }
  mMotion = motion;
  mMotionStyle = style;
  mMotionMs = transition::durationMs(style);
  mTransitionStartMs = nowMs;
}

void Shell::push(Screen* screen, int nowMs) {
  if (screen == 0) return;
  const transition::Style style = styleFor(screen);
  beginTransition(style, kDescend, nowMs);
  Screen* leaving = top();
  if (leaving != 0) leaving->onExit();
  mStack.push_back(screen);
  mStackStyles.push_back(style);
  screen->onEnter(nowMs);
}

void Shell::pop(int nowMs) {
  // The root is never popped: there is nowhere above it, and an empty stack
  // would render a black panel with no way back.
  if (mStack.size() <= 1) return;
  // Leaving replays the motion this level was entered with, so a destination has
  // one description of how it opens and closes rather than two.
  transition::Style style = transition::kDive;
  if (mStackStyles.size() == mStack.size()) style = mStackStyles[mStackStyles.size() - 1];
  beginTransition(style, kAscend, nowMs);
  Screen* leaving = top();
  if (leaving != 0) leaving->onExit();
  mStack.pop_back();
  if (!mStackStyles.empty()) mStackStyles.pop_back();
  Screen* revealed = top();
  if (revealed != 0) revealed->onEnter(nowMs);
}

void Shell::onInput(Input input, int nowMs) {
  Screen* current = top();
  if (current == 0) return;
  if (current->onInput(input, nowMs)) return;
  // A hold that nobody claimed means "go up a level" everywhere in the UI.
  if (input == kInputHold) pop(nowMs);
}

bool Shell::topWantsRawButtons() const {
  Screen* current = top();
  return current != 0 && current->wantsRawButtons();
}

void Shell::deliverRawButton(Input which, bool down, int nowMs) {
  Screen* current = top();
  if (current != 0) current->onRawButton(which, down, nowMs);
}

bool Shell::isAnimating(int nowMs) const {
  if (mOverlay.visible(nowMs)) return true;
  if (mMotion != kIdle && (nowMs - mTransitionStartMs) < mMotionMs) return true;
  Screen* current = top();
  return current != 0 && current->isAnimating(nowMs);
}

void Shell::render(Surface& out, int nowMs) {
  Screen* current = top();
  out.clear();
  if (current == 0) return;

  const int elapsed = nowMs - mTransitionStartMs;
  if (mMotion == kIdle || elapsed >= mMotionMs || !mHasOutgoing) {
    current->render(out, nowMs);
    mOverlay.render(out, nowMs);
    return;
  }

  mIncoming.clear();
  current->render(mIncoming, nowMs);

  const float t = ease::progress(nowMs, mTransitionStartMs, mMotionMs);
  if (mMotion == kAscend) {
    // Ascending is the descent run backwards: the two rasters keep the roles
    // they had on the way in (the screen being revealed is still `from`, the one
    // being left is still `to`) and time is inverted. One operator per style
    // then serves both directions, so push and pop cannot disagree.
    transition::compose(out, mIncoming, mOutgoing, mMotionStyle, 1.0f - t);
  } else {
    transition::compose(out, mOutgoing, mIncoming, mMotionStyle, t);
  }
  // Composited last, and over the transition too: a volume press mid-move must
  // still show its bar rather than being swallowed by the animation.
  mOverlay.render(out, nowMs);
}

}  // namespace tcos
