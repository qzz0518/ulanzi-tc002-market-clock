#include "core/Shell.h"

#include "core/Ease.h"

namespace tcos {

namespace {

// Copies `src` into `dst` shifted by dx, dropping whatever falls off the edge.
// Used for both halves of a slide; `scale` dims the departing screen so the two
// layers stay distinguishable on a panel with no depth cues.
void blitShifted(Surface& dst, const Surface& src, int dx, float scale) {
  const int w = dst.getWidth();
  const int h = dst.getHeight();
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const int sx = x - dx;
      if (sx < 0 || sx >= src.getWidth()) continue;
      Color c = src.getPixel(sx, y);
      if (c.r == 0 && c.g == 0 && c.b == 0) continue;
      if (scale < 1.0f) {
        c.r = static_cast<unsigned char>(c.r * scale);
        c.g = static_cast<unsigned char>(c.g * scale);
        c.b = static_cast<unsigned char>(c.b * scale);
      }
      dst.setPixel(x, y, c);
    }
  }
}

void blitFaded(Surface& dst, const Surface& src, float scale) {
  blitShifted(dst, src, 0, scale);
}

}  // namespace

Shell::Shell(int width, int height)
    : mOutgoing(width, height),
      mIncoming(width, height),
      mTransition(kCut),
      mTransitionStartMs(0),
      mHasOutgoing(false) {}

void Shell::reset(Screen* root, int nowMs) {
  mStack.clear();
  if (root != 0) {
    mStack.push_back(root);
    root->onEnter(nowMs);
  }
  mHasOutgoing = false;
  mTransition = kCut;
}

Screen* Shell::top() const {
  if (mStack.empty()) return 0;
  return mStack[mStack.size() - 1];
}

void Shell::beginTransition(Transition kind, int nowMs) {
  // Snapshot what is on screen right now. Rendering the outgoing screen once
  // and reusing the pixels for the whole slide keeps a transition at the cost
  // of one extra blit per frame rather than two full screen renders.
  Screen* current = top();
  if (current != 0) {
    mOutgoing.clear();
    current->render(mOutgoing, nowMs);
    mHasOutgoing = true;
  } else {
    mHasOutgoing = false;
  }
  mTransition = kind;
  mTransitionStartMs = nowMs;
}

void Shell::push(Screen* screen, int nowMs) {
  if (screen == 0) return;
  beginTransition(kPushForward, nowMs);
  Screen* leaving = top();
  if (leaving != 0) leaving->onExit();
  mStack.push_back(screen);
  screen->onEnter(nowMs);
}

void Shell::pop(int nowMs) {
  // The root is never popped: there is nowhere above it, and an empty stack
  // would render a black panel with no way back.
  if (mStack.size() <= 1) return;
  beginTransition(kPopBack, nowMs);
  Screen* leaving = top();
  if (leaving != 0) leaving->onExit();
  mStack.pop_back();
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

bool Shell::isAnimating(int nowMs) const {
  if (mTransition != kCut && (nowMs - mTransitionStartMs) < kTransitionMs) return true;
  Screen* current = top();
  return current != 0 && current->isAnimating(nowMs);
}

void Shell::render(Surface& out, int nowMs) {
  Screen* current = top();
  out.clear();
  if (current == 0) return;

  const int elapsed = nowMs - mTransitionStartMs;
  if (mTransition == kCut || elapsed >= kTransitionMs || !mHasOutgoing) {
    current->render(out, nowMs);
    return;
  }

  const float t = ease::inOutCubic(ease::progress(nowMs, mTransitionStartMs, kTransitionMs));
  const int w = out.getWidth();

  mIncoming.clear();
  current->render(mIncoming, nowMs);

  if (mTransition == kFadeIn) {
    blitFaded(out, mOutgoing, 1.0f - t);
    blitFaded(out, mIncoming, t);
    return;
  }

  // Descending pushes the new screen in from the right; ascending brings the
  // previous one back from the left. The departing layer also dims, so the two
  // read as ordered rather than as one smeared image.
  const int direction = (mTransition == kPushForward) ? 1 : -1;
  const int travel = static_cast<int>(t * w + 0.5f);
  blitShifted(out, mOutgoing, -direction * travel, 1.0f - 0.6f * t);
  blitShifted(out, mIncoming, direction * (w - travel), 1.0f);
}

}  // namespace tcos
