#include "visual/EyeSkin.h"

#include <math.h>

#include "visual/EyeBox.h"

namespace tcos {
namespace {

// THE EDGE BUDGET, and every skin obeys it. Rows 0 and 15 stay dark. A shape
// pushed past the panel does not fade off — it gets its end sliced flat, and one
// flat end destroys the read. Drawable band is rows 1..14.
const float kCentreY = 8.0f;
const float kMidX = 26.0f;
// The almond skins sit wider apart and are narrower than the offset alone
// suggests: at half-width 7.0 on a 9.0 offset their inner edges met in the
// middle and the pair merged into one shape.
const float kAlmondOffsetX = 10.6f;
const float kAlmondHalfW = 6.2f;
const float kAlmondHalfH = 5.9f;


float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
float lerpf(float a, float b, float t) { return a + (b - a) * t; }

/**
 * Where an almond's centre may sit, given how tall it is.
 *
 * The lid cuts the TOP, so the BOTTOM of the body is the edge that can be
 * sliced — and it is fixed-size, which means any downward offset (a hood, a
 * downward glance) walks it straight off the panel. Clamping the centre against
 * the body's own half-height makes that impossible rather than merely unlikely;
 * the first version added 0.8 for the resting drop and another 0.8 for the hood
 * and put row 15 on.
 */
float almondCentre(float base, float gazeY, float hood, float halfH) {
  const float wanted = base + gazeY + hood * 0.7f;
  const float lowest = 14.3f - halfH;
  const float highest = 1.2f + halfH;
  return clampf(wanted, highest < lowest ? highest : lowest, lowest);
}

/**
 * The one angle the 恶魔之眼 skins pose with, in degrees, for the LEFT eye.
 *
 * The whole aggression of a devil-eye decal lives in the lid's tilt, and the
 * same almond becomes friendly the moment that tilt inverts. Inner end DOWN
 * toward the nose is the scowl; inner end UP is pleading; level is attentive.
 * One number, and it reads in silhouette at any size.
 */
float lidAngle(const EyeExpression& face) {
  // Never exactly level at rest: two parallel horizontal lids read as a pause
  // icon rather than a face.
  const float rest = -7.0f;
  const float alert = lerpf(rest, -13.0f, clampf(face.level * 1.4f, 0.0f, 1.0f));
  return lerpf(alert, 24.0f, face.hood);
}

/**
 * An almond with a lid, which is the entire 恶魔之眼 construction.
 *
 * The lid is NEGATIVE SPACE. Draw the eye body, then punch a big rotated box
 * off its top; the sharp inner point everybody recognises is where the punch's
 * straight edge crosses the body's curve. That point cannot be drawn directly
 * with any primitive here — it is what is LEFT after the removal, which is also
 * how the real decals are cut.
 */
void almond(Surface& out, float cx, float cy, float halfW, float halfH,
            float lidTilt, float lidDrop, const Color& ink) {
  drawEyeBox(out, cx, cy, makeEyeBox(halfW, halfH, halfH * 0.78f), ink);
  // The punch box is deliberately far taller than it needs to be: only its
  // BOTTOM EDGE matters, and everything above that edge is simply gone.
  punchEyeBox(out, cx, cy - halfH - 5.0f + lidDrop, makeEyeBox(halfW + 4.0f, 5.0f, 0.4f, lidTilt));
}

// --- 1. nomi ----------------------------------------------------------------
//
// NIO's NOMI, the dashboard robot the owner named as the closest thing to what
// this should be.
//
// THE THING TO COPY IS THAT NOMI IS DRAWN IN LINE, NOT IN FILL. Its eyes are
// thin white strokes on black: an arch 「⌒」 for nearly every happy state, a
// HOLLOW rounded upright 「0」 for awake and surprised, and a short flat dash
// 「-」 for sleepy. Three shapes carry the whole published expression sheet, and
// every one of them is an outline. Filling them in — which is what every skin
// before this one did — is what made those look like blobs and this look like a
// character.
//
// The hollow upright is drawn the same way the lid above is: a filled capsule
// with a smaller one punched out of it. The arch is two strokes meeting at an
// apex lifted slightly above their join; measured on this panel it reads as a
// CURVE up to about 3.5 px of rise at 2 px thick, and becomes a chevron past
// that, so the arch here stays under it.
void drawNomi(Surface& out, const EyeExpression& face) {
  const Color ink(238, 246, 255);
  const float ox = kMidX + face.gazeX;
  const float oy = kCentreY + face.gazeY;
  const float open = clampf(face.openness, 0.0f, 1.0f);
  // Measured off NOMI: the eyes sit about 0.40 of the head's diameter apart.
  // On a 52-wide panel that is 21 px centre to centre. Alert pulls them IN —
  // convergence is how a face shows it is focusing on something, and it costs
  // one number.
  const float offset = lerpf(10.5f, 9.5f, clampf(face.level, 0.0f, 1.0f));

  // Which of the three shapes is on. Arch when content, upright when attentive,
  // dash when hooded or shut — the same three NOMI cycles through.
  const float upright = clampf(face.level * 1.5f + face.wide, 0.0f, 1.0f) * (1.0f - face.hood);
  const float flat = clampf(face.hood + (1.0f - open) * 1.4f, 0.0f, 1.0f);

  for (int side = -1; side <= 1; side += 2) {
    const float s = static_cast<float>(side);
    const float cx = ox + s * offset;

    if (flat > 0.75f) {
      // Sleepy or shut: one short dash. NOMI's own sleeping face.
      drawEyeStroke(out, cx - 3.2f, oy + face.hood * 1.6f, cx + 3.2f, oy + face.hood * 1.6f, 2.2f, ink);
      continue;
    }

    if (upright > 0.45f) {
      // Awake: a HOLLOW upright. Filled would be a pill; the ring is the look.
      //
      // THE WALL IS 2 PX ALL ROUND, and that is not a stylistic choice. Below
      // 2 px this panel smears a stroke into dashed grey, and the thinnest part
      // of a ring is its corners — so the first version, with a 1.1 px wall at
      // the sides, would have broken into four dots on hardware while looking
      // perfectly fine in a scaled-up preview.
      //
      // The corner radius is deliberately SHORT of a true stadium for the same
      // reason: at radius == halfW the ring's corner runs through a 45 degree
      // arc that is thinner than its own wall. Pulling the radius in keeps every
      // part of the ring at full thickness.
      const float halfH = lerpf(5.0f, 6.0f, face.wide) * lerpf(0.4f, 1.0f, open);
      const float halfW = 3.2f;
      const float wall = 2.0f;
      drawEyeBox(out, cx, oy, makeEyeBox(halfW, halfH, halfW * 0.78f), ink);
      if (halfH > wall + 1.0f) {
        const float innerW = halfW - wall;
        const float innerH = halfH - wall;
        punchEyeBox(out, cx, oy, makeEyeBox(innerW, innerH, innerW * 0.6f));
      }
      continue;
    }

    // Content: the arch. Rise stays under the chevron threshold, and the apex
    // is lifted a fraction above the join so the two strokes read as one curve
    // rather than as a corner.
    const float rise = lerpf(3.2f, 1.4f, 1.0f - open);
    const float halfW = 5.4f;
    // Centred on the eye line rather than hanging below it: the apex sits above
    // oy and the tips below, so the arch reads as an eye rather than as an
    // eyebrow floating over nothing.
    const float apexY = oy - rise * 0.7f;
    const float tipY = oy + rise * 0.35f;
    drawEyeStroke(out, cx - halfW, tipY, cx, apexY, 2.2f, ink);
    drawEyeStroke(out, cx, apexY, cx + halfW, tipY, 2.2f, ink);
    // A wink: on the beat, the right eye alone flips to a dash. NOMI winks
    // constantly and it is the cheapest charm available.
    if (face.beat > 0.6f && s > 0.0f) {
      punchEyeBox(out, cx, oy - 1.0f, makeEyeBox(halfW + 1.0f, 2.4f, 0.4f));
      drawEyeStroke(out, cx - 2.6f, oy, cx + 2.6f, oy, 2.0f, ink);
    }
  }
}

// --- 2. devil ---------------------------------------------------------------
//
// 恶魔之眼 proper, the version sold by the thousand for rear windows: a solid
// glowing red almond with a heavy lid and NO pupil. The absence of a pupil is
// deliberate on the real product — it is what makes it read as a lit object
// rather than as a drawn eye, and it is why they look like they are staring
// through you rather than at you.
void drawDevil(Surface& out, const EyeExpression& face) {
  const Color ink(255, 58, 34);
  const float ox = kMidX + face.gazeX;
  const float oy = almondCentre(kCentreY, face.gazeY, face.hood, kAlmondHalfH);
  const float open = clampf(face.openness, 0.0f, 1.0f);
  const float tilt = lidAngle(face);
  // How far the lid cuts DOWN, so a shut eye needs a BIG drop: at open = 0 the
  // lid travels all the way through the almond and only a sliver survives. The
  // lerp used to run the other way, which made a blink the WIDEST the eye ever
  // got — the one pose it must never be.
  const float drop = lerpf(9.6f, 3.1f + face.wide * 0.9f, open);

  for (int side = -1; side <= 1; side += 2) {
    const float s = static_cast<float>(side);
    almond(out, ox + s * kAlmondOffsetX, oy, kAlmondHalfW, kAlmondHalfH, -s * tilt, drop, ink);
  }
}

// --- 3. fang ----------------------------------------------------------------
//
// The mean variant: amber, narrower, and cut by a SECOND lid from below so the
// eye becomes a slit rather than a crescent. The decals that do this are the
// ones that read as a predator rather than as a cartoon — two converging edges
// make a point at both ends, and a shape with two points is a fang.
void drawFang(Surface& out, const EyeExpression& face) {
  const Color ink(255, 176, 30);
  const Color pupil(90, 30, 0);
  const float ox = kMidX + face.gazeX;
  const float oy = almondCentre(kCentreY, face.gazeY, face.hood, kAlmondHalfH);
  const float open = clampf(face.openness, 0.0f, 1.0f);
  const float tilt = lidAngle(face) * 1.15f;
  const float drop = lerpf(9.6f, 3.4f + face.wide * 0.8f, open);

  for (int side = -1; side <= 1; side += 2) {
    const float s = static_cast<float>(side);
    const float cx = ox + s * kAlmondOffsetX;
    almond(out, cx, oy, kAlmondHalfW, kAlmondHalfH, -s * tilt, drop, ink);
    // The lower lid, tilted the other way, closing the slit from underneath.
    // It retreats when the eye goes wide, which is what stops a startled fang
    // from vanishing into a line.
    const float lower = lerpf(3.0f, 1.4f, face.wide) * open;
    punchEyeBox(out, cx, oy + kAlmondHalfH + 5.0f - lower,
                makeEyeBox(11.0f, 5.0f, 0.4f, s * tilt * 0.55f));
    // A slot pupil, only while there is enough eye left to hold one.
    if (open > 0.55f && face.hood < 0.5f) {
      punchEyeBox(out, cx + clampf(face.gazeX * 0.3f, -1.2f, 1.2f), oy + 0.4f,
                  makeEyeBox(1.5f, 1.9f, 1.4f));
      (void)pupil;
    }
  }
}

// --- 4. blink ---------------------------------------------------------------
//
// The friendly half of the same product family — the ice-blue decals with a big
// round pupil and a white catchlight. Identical construction to the devil above
// with the lid angle INVERTED, which is the whole point: the same shape is mean
// or sweet depending on one sign, and having both on the knob makes that legible
// rather than theoretical.
void drawBlink(Surface& out, const EyeExpression& face) {
  const Color ink(90, 190, 255);
  const Color spark(235, 250, 255);
  const float ox = kMidX + face.gazeX;
  const float oy = almondCentre(kCentreY, face.gazeY, face.hood, kAlmondHalfH);
  const float open = clampf(face.openness, 0.0f, 1.0f);
  // Inverted: the resting lid lifts at the inner end, and a scowl only takes it
  // back to level. This face cannot be made angry, and that is correct for it.
  const float tilt = lerpf(12.0f, -4.0f, face.hood) * -1.0f;
  const float drop = lerpf(9.8f, 3.6f + face.wide * 0.8f, open);

  for (int side = -1; side <= 1; side += 2) {
    const float s = static_cast<float>(side);
    const float cx = ox + s * kAlmondOffsetX;
    almond(out, cx, oy, kAlmondHalfW, kAlmondHalfH, -s * tilt, drop, ink);
    if (open > 0.5f) {
      // A big round pupil that dilates with the room, and a catchlight above
      // and outboard of it — the two details that make the blue ones read as
      // cute where the red ones read as a threat.
      const float look = clampf(face.gazeX * 0.4f, -1.6f, 1.6f);
      const float r = lerpf(2.0f, 2.7f, clampf(face.level + face.wide, 0.0f, 1.0f));
      punchEyeBox(out, cx + look, oy + 1.0f, makeEyeBox(r, r, r));
      drawEyeBox(out, cx + look + s * 0.9f, oy - 0.2f, makeEyeBox(0.9f, 0.9f, 0.9f), spark);
    }
  }
}

// --- 5. cat -----------------------------------------------------------------
//
// The one survivor of the first set of designs. The pupil does the emoting: a
// cat's slit dilates when it is startled and narrows in calm, which everybody
// recognises without being told, and it is the best use a single loudness number
// can be put to — dilation is exactly what a sudden noise does to an animal.
void drawCat(Surface& out, const EyeExpression& face) {
  const Color iris(206, 232, 110);
  const float ox = kMidX + face.gazeX;
  const float oy = kCentreY + face.gazeY + face.hood * 2.2f;

  const float halfW = 4.6f + face.wide * 0.6f;
  const float halfH = lerpf(0.9f, lerpf(5.1f, 2.0f, face.hood), clampf(face.openness, 0.0f, 1.0f));

  // THE IRIS HAS TO WIN. A real slit runs nearly the full height of the eye, and
  // drawn faithfully at this size it leaves about a pixel and a half of iris on
  // each side — which stops reading as an eye and starts reading as a printed
  // zero. Two thirds of the height, never more than 40% of the width.
  const float blow = clampf(face.level * 0.7f + face.wide * 0.6f + face.beat * 0.5f, 0.0f, 1.0f);
  const float pupilW = lerpf(0.7f, 1.9f, blow);
  const float pupilH = halfH * lerpf(0.58f, 0.44f, blow);

  for (int side = -1; side <= 1; side += 2) {
    const float cx = ox + static_cast<float>(side) * 8.6f;
    drawEyeBox(out, cx, oy, makeEyeBox(halfW, halfH, halfW < halfH ? halfW : halfH), iris);
    if (halfH > 2.4f) {
      const float look = clampf(face.gazeX * 0.35f, -1.4f, 1.4f);
      punchEyeBox(out, cx + look, oy, makeEyeBox(pupilW, pupilH, pupilW));
    }
  }
}

}  // namespace

const char* eyeSkinName(EyeSkin skin) {
  switch (skin) {
    case kSkinNomi: return "NOMI";
    case kSkinBlink: return "BLUE";
    case kSkinDevil: return "DEVIL";
    case kSkinFang: return "FANG";
    case kSkinCat: return "CAT";
    case kEyeSkinCount: break;
  }
  return "";
}

void drawEyeSkin(Surface& out, EyeSkin skin, const EyeExpression& face) {
  switch (skin) {
    case kSkinNomi: drawNomi(out, face); break;
    case kSkinBlink: drawBlink(out, face); break;
    case kSkinDevil: drawDevil(out, face); break;
    case kSkinFang: drawFang(out, face); break;
    case kSkinCat: drawCat(out, face); break;
    case kEyeSkinCount: break;
  }
}

}  // namespace tcos
