#include "core/RingModel.h"

#include "core/Ease.h"

namespace tcos {

RingModel::RingModel()
    : mCount(0), mIndex(0), mAnimStartMs(0), mFromOffset(0.0f) {}

void RingModel::setCount(int count) {
  mCount = count < 0 ? 0 : count;
  if (mCount == 0) {
    mIndex = 0;
    mFromOffset = 0.0f;
    return;
  }
  if (mIndex >= mCount) mIndex = mCount - 1;
}

int RingModel::wrap(int index) const {
  if (mCount <= 0) return 0;
  // % on a negative left operand is implementation-defined before C++11 and
  // truncates towards zero after it, so normalise explicitly rather than
  // relying on the sign of the remainder.
  int r = index % mCount;
  if (r < 0) r += mCount;
  return r;
}

void RingModel::setIndex(int index, int nowMs) {
  mIndex = wrap(index);
  mAnimStartMs = nowMs;
  mFromOffset = 0.0f;  // a programmatic jump does not slide
}

void RingModel::turn(int delta, int nowMs) {
  if (mCount <= 1 || delta == 0) return;

  // Carry whatever the in-flight slide has not yet travelled into the new one,
  // so a fast spin stays continuous instead of stuttering from zero each detent.
  const float pending = visualOffset(nowMs);
  float from = pending - static_cast<float>(delta);
  if (from > static_cast<float>(kMaxCarry)) from = static_cast<float>(kMaxCarry);
  if (from < -static_cast<float>(kMaxCarry)) from = -static_cast<float>(kMaxCarry);

  mIndex = wrap(mIndex + delta);
  mFromOffset = from;
  mAnimStartMs = nowMs;
}

float RingModel::visualOffset(int nowMs) const {
  if (mFromOffset == 0.0f) return 0.0f;
  const float t = ease::outCubic(ease::progress(nowMs, mAnimStartMs, kSlideMs));
  return mFromOffset * (1.0f - t);
}

bool RingModel::isAnimating(int nowMs) const {
  if (mFromOffset == 0.0f) return false;
  return (nowMs - mAnimStartMs) < kSlideMs;
}

}  // namespace tcos
