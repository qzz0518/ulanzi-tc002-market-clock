#ifndef VISUAL_EYESKIN_H_
#define VISUAL_EYESKIN_H_

#include "core/Surface.h"

namespace tcos {

/**
 * The five faces, and the contract that lets one behaviour drive all of them.
 *
 * The split is the point. `EyeFace` owns the BEHAVIOUR — moods, blink and
 * saccade timers, the sub-pixel drift, how loudness becomes attention — and
 * emits an `EyeExpression`, which says only what the face is doing in abstract
 * terms: how open, how wide, how hooded, where it is looking. A skin turns that
 * into pixels and knows nothing about microphones or moods-over-time.
 *
 * Without that split each skin would carry its own copy of the blink timing and
 * the startle window, and five copies of a timing rule is five chances for one
 * of them to be subtly wrong on a screen nobody is looking at that week.
 */

/**
 * The faces, ordered as the knob turns through them, warmest first.
 *
 * TWO TRADITIONS, both named by the owner after two wrong guesses of mine.
 *
 * 恶魔之眼 / 眨眼车灯 — the aftermarket LED eye panels people stick on car rear
 * windows and headlights. Their construction is specific and consistent: a
 * pointed almond with a heavy LID cutting across the top at an angle, inner end
 * low. Nearly all of the aggression is in that one angle, and the same shape
 * becomes friendly the moment it inverts. (My second attempt read the keyword as
 * headlight SIGNATURES — Volvo hammers, Peugeot claws — and built lighting
 * graphics instead of eyes. They were not eyes.)
 *
 * NIO's NOMI — the dashboard robot whose whole personality is a pair of simple
 * warm eyes on a dark round screen, emoting through SHAPE rather than through a
 * drawn mouth: round when surprised, arched when pleased, flat when sleepy.
 *
 * HOW EACH IS BUILT, since neither has a primitive of its own:
 *
 *   The almond is a rounded box with a rotated box PUNCHED off its top. The lid
 *   is negative space, and the sharp inner point is where the punch's straight
 *   edge meets the body's curve — you cannot draw that point directly, but you
 *   get it for free by removing everything above the lid line.
 *
 *   The arch — the 「^ ^」 pleased eye — is two strokes meeting at an apex
 *   raised slightly above their join. Measured on this panel: with a thickness
 *   of 2.6 px or more it reads as a CURVE up to about 3.5 px of rise, and
 *   becomes a chevron beyond that. Every arch here stays under that.
 */
enum EyeSkin {
  kSkinNomi = 0,   // NOMI: warm, round, emotes by curvature
  kSkinBlink,      // the friendly blue 眨眼 decal: lid inverted, big pupil
  kSkinDevil,      // 恶魔之眼 proper: solid red glow, heavy angled lid
  kSkinFang,       // the mean amber variant: two lids, a narrow slit, a pupil
  kSkinCat,        // the one survivor of the first set: a dilating slit pupil
  kEyeSkinCount,
};

const char* eyeSkinName(EyeSkin skin);

/**
 * What the face is doing, with no opinion about how it looks.
 *
 * Every field is already smoothed and clamped by EyeFace, so a skin can use
 * them raw. Deliberately abstract: `openness` rather than `halfHeight`, because
 * a visor and a cat eye close in completely different geometry and both are
 * "shut".
 */
struct EyeExpression {
  /** 1 fully open, 0 shut. Blinks and the startle squeeze both land here. */
  float openness;
  /** 0 at rest, 1 at the widest a surprise opens it. */
  float wide;
  /** 0 at rest, 1 fully hooded — the annoyed lid. */
  float hood;
  /** 0 no brow, 1 brow fully down. */
  float brow;
  /** Where the pair is pointing, in panel pixels. */
  float gazeX;
  float gazeY;
  /** The room, 0..1, already through the gain. */
  float level;
  /** A short decaying pulse on each transient, for skins that keep time. */
  float beat;
  /** True while the face is mid-flinch, which several skins draw specially. */
  bool startled;
  /** Milliseconds since the face entered its current mood. */
  int moodMs;
  /** Free-running clock for anything that animates on its own (scanners). */
  int phaseMs;
};

/** Draws `skin` on a cleared surface. The only entry point a caller needs. */
void drawEyeSkin(Surface& out, EyeSkin skin, const EyeExpression& face);

}  // namespace tcos

#endif  // VISUAL_EYESKIN_H_
