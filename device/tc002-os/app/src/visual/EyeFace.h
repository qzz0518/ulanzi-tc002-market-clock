#ifndef VISUAL_EYEFACE_H_
#define VISUAL_EYEFACE_H_

#include "visual/EyeSkin.h"

namespace tcos {

/**
 * How a face behaves, with no opinion about how it looks.
 *
 * Moods, blink and saccade timing, the sub-pixel drift, and the rules turning
 * room loudness into attention all live here and are shared by every skin. What
 * comes out is an `EyeExpression` (visual/EyeSkin.h) — how open, how wide, how
 * hooded, where it is looking — and a skin turns that into pixels.
 *
 * WHY THE SPLIT. Five skins each carrying their own blink timer is five chances
 * for one of them to be subtly wrong on the one screen nobody looked at that
 * week. This way a timing bug is a bug in every skin at once, which is the kind
 * that gets noticed and fixed.
 *
 * WHAT MAKES IT LOOK ALIVE, at the 50 fps the firmware's 20 ms tick allows:
 *
 *   - Eyes do not drift, they JUMP. A gaze change is ballistic and then stops
 *     dead — a real saccade is 30-80 ms, and easing one smoothly across half a
 *     second is the single thing that makes an animated face look like a
 *     screensaver.
 *   - Blinks are asymmetric: shut in 60 ms, open over 130. Lids fall and are
 *     lifted, and matching the two halves reads as a dropped frame.
 *   - Nothing is ever perfectly still. A slow sub-pixel sway runs underneath
 *     every hold, well below the level anyone notices as motion but far enough
 *     above zero that the face never looks paused.
 *
 * THE MICROPHONE IS NOT A MICROPHONE. The TC002's mic hangs off the MCU, not
 * the SoC — there is no PCM capture anywhere on this device. What arrives is one
 * 16-bit loudness number, so this face can know HOW LOUD the room is and
 * nothing else: no pitch, no direction, no words. Every behaviour below is built
 * from that number and its rate of change, which turns out to be enough.
 */

/**
 * Turns the MCU's uncalibrated loudness number into a 0..1 level.
 *
 * NOTHING documents that number. Not the vendor SDK, not Ulanzi's own repo,
 * which says only "MCU reports volume data" — no range, no units, no update
 * rate, and no statement of whether it is an instantaneous sample or an
 * envelope. So this calibrates itself at runtime instead of trusting a constant
 * somebody guessed: it tracks a floor that falls quickly and rises slowly, and
 * a ceiling that does the opposite, and reports where the reading sits between.
 *
 * The asymmetry is the whole design. A floor that rises slowly means a quiet
 * room re-establishes silence over about a minute rather than instantly, so a
 * pause between two sentences is not mistaken for a new silence. A ceiling that
 * decays slowly means one shout does not permanently deafen the face.
 */
class LoudnessTracker {
 public:
  LoudnessTracker();

  void reset();

  /**
   * Feed one reading. `raw` is the MCU's value, or negative when it could not
   * be read — an unreadable mic decays toward silence rather than freezing the
   * face mid-expression.
   */
  void push(int raw, int dtMs);

  /** 0..1, smoothed. Where the room sits between its own floor and ceiling. */
  float level() const { return mLevel; }

  /**
   * 0..1, how sharply the level just rose. This is what a bang looks like: the
   * level alone cannot tell a hand-clap from a hoover, and only one of those
   * should make a face flinch.
   */
  float attack() const { return mAttack; }

  /** False until the floor and ceiling have separated enough to mean anything. */
  bool calibrated() const;

  int lastRaw() const { return mLastRaw; }
  int floorRaw() const { return static_cast<int>(mFloor); }
  int ceilRaw() const { return static_cast<int>(mCeil); }

 private:
  float mFloor;
  float mCeil;
  float mLevel;
  float mAttack;
  float mPrevLevel;
  int mLastRaw;
  bool mSeen;
};

/** What the face currently thinks is going on. */
enum EyeMood {
  kEyeCalm,      // quiet: idle blinks and wandering
  kEyeAlert,     // something is making noise; attention up
  kEyeStartled,  // a bang: squeeze shut, then wide
  kEyeGroove,    // sustained rhythmic sound; the face keeps time
  kEyeAnnoyed,   // loud for too long
};

const char* eyeMoodName(EyeMood mood);

class EyeFace {
 public:
  EyeFace();

  void reset(int nowMs);

  /** Advance by `dtMs` given the room's level and attack. Pure: no clock, no I/O. */
  void tick(int dtMs, float level, float attack);

  EyeMood mood() const { return mMood; }
  int moodMs() const { return mMoodMs; }

  /** What every skin draws from. */
  EyeExpression expression() const;

 private:
  void chooseMood(int dtMs, float level, float attack);
  void runTimers(int dtMs);
  void approach(int dtMs);
  float randomUnit();

  EyeMood mMood;
  int mMoodMs;
  int mLoudMs;
  int mQuietMs;
  int mBeatMs;
  int mBeats;
  int mBeatWindowMs;
  int mPhaseMs;

  float mLevel;
  float mBeat;

  // Targets and their smoothed values. Different parts of a face move at
  // different speeds, and one rate for all of them is what makes an animated
  // face read as a puppet.
  float mWide, mWideTarget;
  float mHood, mHoodTarget;
  float mBrow, mBrowTarget;
  float mGazeX, mGazeXTarget;
  float mGazeY, mGazeYTarget;

  // Blinks and the startle squeeze are applied AFTER smoothing, because both
  // must be crisp: run through the same easing as everything else, a blink
  // becomes a slow fade and reads as the panel dimming rather than a lid.
  int mBlinkMs;
  int mNextBlinkMs;
  int mSaccadeMs;

  unsigned int mRandom;
};

}  // namespace tcos

#endif  // VISUAL_EYEFACE_H_
