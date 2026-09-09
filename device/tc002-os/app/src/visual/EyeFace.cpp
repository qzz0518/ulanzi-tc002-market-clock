#include "visual/EyeFace.h"

#include <math.h>

namespace tcos {
namespace {

float clampf(float value, float low, float high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

float lerpf(float a, float b, float t) { return a + (b - a) * t; }

/**
 * Exponential smoothing that does not change speed with the frame rate.
 *
 * `rate` is "fraction of the remaining distance per second". Doing this the
 * naive way — current += (target - current) * rate — silently ties the animation
 * to the tick interval, which is the bug that makes a face behave differently on
 * a loaded device than on an idle one.
 */
float approachf(float current, float target, float rate, int dtMs) {
  return lerpf(current, target, 1.0f - expf(-rate * (static_cast<float>(dtMs) / 1000.0f)));
}

}  // namespace

const char* eyeMoodName(EyeMood mood) {
  switch (mood) {
    case kEyeCalm: return "CALM";
    case kEyeAlert: return "HEAR";
    case kEyeStartled: return "BANG";
    case kEyeGroove: return "BEAT";
    case kEyeAnnoyed: return "GRR";
  }
  return "";
}

// --- LoudnessTracker --------------------------------------------------------

LoudnessTracker::LoudnessTracker() { reset(); }

void LoudnessTracker::reset() {
  mFloor = 0.0f;
  mCeil = 0.0f;
  mLevel = 0.0f;
  mAttack = 0.0f;
  mPrevLevel = 0.0f;
  mLastRaw = -1;
  mSeen = false;
}

bool LoudnessTracker::calibrated() const {
  // Below this the floor and ceiling have not separated enough for the ratio
  // between them to mean anything, and every reading would map to a wild 0 or 1.
  // Silence is a legitimate state, so this is not an error — the face stays calm
  // until the room gives it something to scale against.
  return mSeen && (mCeil - mFloor) >= 8.0f;
}

void LoudnessTracker::push(int raw, int dtMs) {
  const float dt = clampf(static_cast<float>(dtMs) / 1000.0f, 0.0f, 0.25f);

  if (raw < 0) {
    // Unreadable. Decay toward quiet rather than freezing: a face stuck
    // mid-flinch because the serial link hiccuped looks broken, and a face that
    // relaxes looks like nothing happened.
    mLevel = approachf(mLevel, 0.0f, 1.5f, dtMs);
    mAttack = approachf(mAttack, 0.0f, 6.0f, dtMs);
    return;
  }

  const float value = static_cast<float>(raw);
  mLastRaw = raw;

  if (!mSeen) {
    mSeen = true;
    mFloor = value;
    mCeil = value + 1.0f;
  }

  // The floor drops fast and rises slowly: a room going quiet should be believed
  // at once, while a pause between two sentences must NOT be taken for a new
  // silence — otherwise the face relaxes between every word.
  mFloor = value < mFloor ? lerpf(mFloor, value, clampf(dt * 6.0f, 0.0f, 1.0f))
                          : lerpf(mFloor, value, clampf(dt * 0.02f, 0.0f, 1.0f));

  // The ceiling does the opposite: it jumps to a new peak immediately, so the
  // first loud thing is scaled correctly rather than after a delay, and bleeds
  // back down over roughly half a minute so one shout does not deafen the face
  // for the rest of the session.
  mCeil = value > mCeil ? value
                        : lerpf(mCeil, mFloor + 1.0f, clampf(dt * 0.05f, 0.0f, 1.0f));
  if (mCeil < mFloor + 1.0f) mCeil = mFloor + 1.0f;

  float target = clampf((value - mFloor) / (mCeil - mFloor), 0.0f, 1.0f);
  if (!calibrated()) target = 0.0f;

  // Fast up, slow down — an envelope follower. Sound arrives instantly and
  // fades; matching the two rates would blur every transient into the room tone,
  // and the transient is the interesting half.
  mLevel = approachf(mLevel, target, target > mLevel ? 22.0f : 3.5f, dtMs);

  const float rise = mLevel - mPrevLevel;
  mPrevLevel = mLevel;
  // Attack is the RISE, not the level: a hoover is loud and a hand-clap is
  // sudden, and only one of them should make a face flinch.
  const float risen = rise > 0.0f ? clampf(rise * 6.0f, 0.0f, 1.0f) : 0.0f;
  mAttack = risen > mAttack ? risen : approachf(mAttack, 0.0f, 5.0f, dtMs);
}

// --- EyeFace ----------------------------------------------------------------

EyeFace::EyeFace() { reset(0); }

void EyeFace::reset(int nowMs) {
  mMood = kEyeCalm;
  mMoodMs = 0;
  mLoudMs = 0;
  mQuietMs = 0;
  mBeatMs = 0;
  mBeats = 0;
  mBeatWindowMs = 0;
  mPhaseMs = 0;
  mLevel = 0.0f;
  mBeat = 0.0f;
  mWide = mWideTarget = 0.0f;
  mHood = mHoodTarget = 0.0f;
  mBrow = mBrowTarget = 0.0f;
  mGazeX = mGazeXTarget = 0.0f;
  mGazeY = mGazeYTarget = 0.0f;
  mBlinkMs = -1;
  mNextBlinkMs = 2600;
  mSaccadeMs = 1500;
  mRandom = 0x9E3779B9u ^ static_cast<unsigned int>(nowMs);
}

float EyeFace::randomUnit() {
  // xorshift32. A face needs unpredictable timing, not statistical quality.
  mRandom ^= mRandom << 13;
  mRandom ^= mRandom >> 17;
  mRandom ^= mRandom << 5;
  return static_cast<float>(mRandom & 0xFFFFFF) / static_cast<float>(0x1000000);
}

void EyeFace::chooseMood(int dtMs, float level, float attack) {
  mMoodMs += dtMs;
  mBeatMs += dtMs;
  mBeatWindowMs += dtMs;

  mLoudMs = level > 0.68f ? mLoudMs + dtMs : 0;
  mQuietMs = level < 0.12f ? mQuietMs + dtMs : 0;

  // A beat is a transient loud enough to be deliberate. Counting them over a
  // window is what tells music apart from a running tap: both are sustained,
  // only one keeps hitting.
  if (attack > 0.45f && mBeatMs > 140) {
    mBeats += 1;
    mBeatMs = 0;
    mBeat = 1.0f;
  }
  if (mBeatWindowMs > 2600) {
    mBeatWindowMs = 0;
    mBeats = 0;
  }

  const EyeMood was = mMood;

  // A bang outranks everything, and is the one transition that must not be
  // debounced: the flinch has to land ON the noise, not 100 ms after it.
  if (attack > 0.55f && level > 0.42f && mMood != kEyeStartled) {
    mMood = kEyeStartled;
  } else if (mMood == kEyeStartled) {
    if (mMoodMs > 620) mMood = level > 0.2f ? kEyeAlert : kEyeCalm;
  } else if (mLoudMs > 2400) {
    mMood = kEyeAnnoyed;
  } else if (mMood == kEyeAnnoyed) {
    if (level < 0.45f && mMoodMs > 900) mMood = kEyeAlert;
  } else if (mBeats >= 3 && level > 0.22f) {
    mMood = kEyeGroove;
  } else if (mMood == kEyeGroove) {
    if (mBeatMs > 1900) mMood = level > 0.18f ? kEyeAlert : kEyeCalm;
  } else if (level > 0.2f) {
    mMood = kEyeAlert;
  } else if (mQuietMs > 850) {
    mMood = kEyeCalm;
  }

  if (mMood != was) mMoodMs = 0;

  // Targets per mood. Everything here is abstract on purpose — "how wide", not
  // "how many pixels" — so five very different skins can all read it.
  mWideTarget = 0.0f;
  mHoodTarget = 0.0f;
  mBrowTarget = 0.0f;
  mGazeYTarget = 0.0f;
  switch (mMood) {
    case kEyeCalm:
      break;
    case kEyeAlert:
      mWideTarget = clampf(level, 0.0f, 1.0f) * 0.6f;
      mGazeYTarget = -0.35f * clampf(level, 0.0f, 1.0f);
      break;
    case kEyeStartled:
      // Squeeze first, then wide. Going straight to wide reads as interest; the
      // flinch is what makes it a fright, and it is only 120 ms.
      mWideTarget = mMoodMs < 120 ? 0.0f : 1.0f;
      mGazeYTarget = mMoodMs < 120 ? 0.0f : -0.3f;
      break;
    case kEyeGroove:
      mWideTarget = clampf(level, 0.0f, 1.0f);
      break;
    case kEyeAnnoyed:
      // NOTE the drop is NOT set here. A hooded eye also sits lower, but if the
      // drop were its own smoothed target it would race the hood: they ease at
      // different rates, so mid-transition the eye is still tall AND already
      // low, and it runs off the bottom of the panel. Skins derive the drop
      // from `hood` instead, which makes them physically unable to disagree.
      mHoodTarget = 1.0f;
      mBrowTarget = 1.0f;
      break;
  }
}

void EyeFace::runTimers(int dtMs) {
  mPhaseMs += dtMs;

  // Blinks. Suppressed while startled — a face mid-flinch does not blink, and
  // one landing on the squeeze would cancel the only frame that sells it.
  if (mMood != kEyeStartled) {
    if (mBlinkMs >= 0) {
      mBlinkMs += dtMs;
      if (mBlinkMs > 190) {
        mBlinkMs = -1;
        // Calm blinks are lazy and far apart; an alert face blinks more often,
        // which is what being on edge looks like.
        mNextBlinkMs = static_cast<int>((mMood == kEyeCalm ? 2400.0f : 1400.0f) +
                                        randomUnit() * 2600.0f);
      }
    } else {
      mNextBlinkMs -= dtMs;
      if (mNextBlinkMs <= 0) mBlinkMs = 0;
    }
  }

  // Saccades, and only when calm: a face listening to something looks AT it, and
  // wandering off mid-noise reads as not caring.
  mSaccadeMs -= dtMs;
  if (mSaccadeMs <= 0) {
    if (mMood == kEyeCalm) {
      mGazeXTarget = (randomUnit() * 2.0f - 1.0f) * 5.0f;
      mSaccadeMs = static_cast<int>(1300.0f + randomUnit() * 2900.0f);
    } else {
      mGazeXTarget = 0.0f;
      mSaccadeMs = 500;
    }
  }

  mBeat = approachf(mBeat, 0.0f, 6.0f, dtMs);
}

void EyeFace::approach(int dtMs) {
  // The gaze is ballistic (a real saccade is 30-80 ms), the lids are muscle, the
  // brow is slower still because it is a mood rather than a reflex.
  mGazeX = approachf(mGazeX, mGazeXTarget, 26.0f, dtMs);
  mGazeY = approachf(mGazeY, mGazeYTarget, 12.0f, dtMs);
  const float rate = mMood == kEyeStartled ? 30.0f : 11.0f;
  mWide = approachf(mWide, mWideTarget, rate, dtMs);
  mHood = approachf(mHood, mHoodTarget, rate, dtMs);
  mBrow = approachf(mBrow, mBrowTarget, 8.0f, dtMs);
}

void EyeFace::tick(int dtMs, float level, float attack) {
  if (dtMs <= 0) return;
  if (dtMs > 250) dtMs = 250;  // same clamp the other engines use
  mLevel = clampf(level, 0.0f, 1.0f);
  chooseMood(dtMs, mLevel, attack);
  runTimers(dtMs);
  approach(dtMs);
}

EyeExpression EyeFace::expression() const {
  EyeExpression out;
  out.wide = mWide;
  out.hood = mHood;
  out.brow = mBrow;
  out.level = mLevel;
  out.beat = mBeat;
  out.startled = mMood == kEyeStartled;
  out.moodMs = mMoodMs;
  out.phaseMs = mPhaseMs;

  // The sway that runs under everything. Amplitude deliberately below a pixel:
  // it shows up only as the anti-aliased edges breathing, which is the level a
  // living thing idles at. Nothing here is ever perfectly still, and "perfectly
  // still" is the clearest tell that a face is a picture.
  const float turn = static_cast<float>(mPhaseMs) / 1000.0f;
  out.gazeX = mGazeX + sinf(turn * 0.65f) * 0.35f + sinf(turn * 1.5f) * 0.12f;
  out.gazeY = mGazeY + sinf(turn * 0.9f) * 0.2f;

  out.openness = 1.0f;
  if (mBlinkMs >= 0) {
    // Shut fast, open slower: lids fall and are lifted, and matching the two
    // halves makes a blink read as a dropped frame instead of a face.
    const float t = static_cast<float>(mBlinkMs);
    const float shut = t < 60.0f ? t / 60.0f
                                 : 1.0f - clampf((t - 60.0f) / 130.0f, 0.0f, 1.0f);
    out.openness = 1.0f - shut;
  }
  // The startle squeeze rides on the same field, so every skin closes the same
  // way whether it is blinking or flinching.
  if (out.startled && mMoodMs < 120) {
    const float squeeze = 1.0f - clampf(static_cast<float>(mMoodMs) / 70.0f, 0.0f, 1.0f);
    if (squeeze < out.openness) out.openness = squeeze;
  }
  return out;
}

}  // namespace tcos
