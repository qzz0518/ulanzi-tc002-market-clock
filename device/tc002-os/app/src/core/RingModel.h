#ifndef CORE_RINGMODEL_H_
#define CORE_RINGMODEL_H_

namespace tcos {

/**
 * The selection model behind every knob-driven list in this firmware.
 *
 * Items sit on a ring: turning past the last one wraps to the first. The panel
 * shows exactly one item, so a move is a full-width slide rather than a
 * highlight jumping down a column — which is why this class tracks an animated
 * offset in *items* (not pixels) and lets the renderer scale it.
 *
 * Fast knob turns are the hard case. A detent arriving mid-animation must not
 * restart the tween from a standstill (the list would feel stuck) nor let the
 * animation fall arbitrarily far behind the selection (a long spin would scroll
 * for seconds after the user stopped). Pending travel is therefore carried into
 * the new tween and clamped to kMaxCarry items.
 */
class RingModel {
 public:
  // Slide duration for a single detent, and the cap on how much unfinished
  // travel a new detent may inherit.
  static const int kSlideMs = 180;
  static const int kMaxCarry = 2;

  RingModel();

  void setCount(int count);
  int count() const { return mCount; }

  // The committed selection. Always in [0, count) — never negative, so callers
  // can index straight into their own arrays.
  int index() const { return mIndex; }
  void setIndex(int index, int nowMs);

  // One knob detent. `delta` is +1 clockwise, -1 anti-clockwise.
  void turn(int delta, int nowMs);

  /**
   * Where the ring is *visually*, in items, relative to the committed index.
   *
   * 0 when settled. During a slide it runs from -delta towards 0, so a renderer
   * draws item (index + round(offset)) shifted by (offset - round(offset)) of a
   * screen width. Returns a float precisely so the renderer never has to know
   * how many pixels an item is.
   */
  float visualOffset(int nowMs) const;

  bool isAnimating(int nowMs) const;

  // Normalises any integer onto the ring, including negatives.
  int wrap(int index) const;

 private:
  int mCount;
  int mIndex;
  int mAnimStartMs;
  float mFromOffset;  // offset at the start of the current slide, in items
};

}  // namespace tcos

#endif  // CORE_RINGMODEL_H_
