#ifndef VISUAL_EYEBOX_H_
#define VISUAL_EYEBOX_H_

#include "core/Surface.h"

namespace tcos {

/**
 * The one primitive every eye skin is built from: an anti-aliased rounded box.
 *
 * This repo is hard-edged pixel art nearly everywhere and that is usually
 * right, but a 7x13 capsule quantised to whole pixels is a staircase with four
 * steps a side, and at LED scale a staircase reads as a hexagon rather than a
 * curve. So each pixel is lit by how much of the shape covers it, computed from
 * a signed distance field. The partial pixels along the corners are what make
 * the eye read as round, and they cost nothing: the panel is RGB and has the
 * levels to spend.
 *
 * One skin (kSkinPixel) deliberately does NOT use the ramp — it snaps coverage
 * to on/off so it reads as chunky pixel art beside the smooth ones. That is why
 * the coverage and the drawing are separate calls.
 */

struct EyeBox {
  float halfW;
  float halfH;
  /** Clamped to the half-extents when drawn, so halfW == radius is a capsule. */
  float radius;
  /** Degrees clockwise on screen, so a positive tilt drops the right-hand end. */
  float tiltDeg;
};

EyeBox makeEyeBox(float halfW, float halfH, float radius, float tiltDeg = 0.0f);

/**
 * How much of the pixel at (px, py) — measured from the box's centre — the box
 * covers, 0..1. A sample exactly on the edge is half lit and the ramp is one
 * pixel wide.
 */
float eyeBoxCoverage(float px, float py, const EyeBox& box);

/** Axis-aligned half-extents, tilt included. Used for the raster bounds and by
 *  the checks that assert nothing is ever sliced by a panel edge. */
void eyeBoxExtents(const EyeBox& box, float& outX, float& outY);

/**
 * Paints the box centred at (centreX, centreY).
 *
 * BRIGHTEST WINS rather than painting over: a brow can overlap its eye
 * mid-transition and a pupil sits inside its iris, and a later shape darkening
 * an earlier one would punch a hole through it. Two lit things on an LED panel
 * add; they never subtract. `alpha` scales the whole shape, which is how a brow
 * fades in.
 *
 * `hardEdge` snaps coverage at the halfway mark instead of ramping, for the
 * skin that wants visible pixels.
 */
void drawEyeBox(Surface& out, float centreX, float centreY, const EyeBox& box,
                const Color& ink, float alpha = 1.0f, bool hardEdge = false);

/** Same, but carves the shape OUT — used for pupils and for the visor's gap. */
void punchEyeBox(Surface& out, float centreX, float centreY, const EyeBox& box,
                 bool hardEdge = false);

/**
 * A stroke from (x0, y0) to (x1, y1), `thickness` pixels wide, round-capped.
 *
 * The same rounded box underneath, described the way angled signatures actually
 * want to be described. A claw, a hammer, a chevron is two or three straight
 * segments at deliberate angles, and the angle IS the identity — computing the
 * centre, length and rotation by hand at every call site is where those numbers
 * go wrong. Given endpoints, the geometry cannot disagree with the intent.
 */
void drawEyeStroke(Surface& out, float x0, float y0, float x1, float y1,
                   float thickness, const Color& ink, float alpha = 1.0f,
                   bool hardEdge = false);

/**
 * One hard, whole-pixel cell — the unit a pixel-matrix headlight is built from.
 *
 * Snapped to the integer grid and never anti-aliased, because the entire point
 * of that family is that the pixels are visible. Softening them would be
 * apologising for the resolution the design is celebrating.
 */
void drawEyeCell(Surface& out, int x, int y, int w, int h, const Color& ink,
                 float alpha = 1.0f);

}  // namespace tcos

#endif  // VISUAL_EYEBOX_H_
