#include "visual/EyeBox.h"

#include <math.h>

namespace tcos {
namespace {

float clampf(float value, float low, float high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

}  // namespace

EyeBox makeEyeBox(float halfW, float halfH, float radius, float tiltDeg) {
  EyeBox box;
  box.halfW = halfW;
  box.halfH = halfH;
  box.radius = radius;
  box.tiltDeg = tiltDeg;
  return box;
}

float eyeBoxCoverage(float px, float py, const EyeBox& box) {
  const float tilt = -box.tiltDeg * 3.14159265f / 180.0f;
  const float c = cosf(tilt);
  const float s = sinf(tilt);
  const float x = px * c - py * s;
  const float y = px * s + py * c;
  float radius = box.radius;
  if (radius > box.halfW) radius = box.halfW;
  if (radius > box.halfH) radius = box.halfH;
  if (radius < 0.0f) radius = 0.0f;
  const float qx = fabsf(x) - (box.halfW - radius);
  const float qy = fabsf(y) - (box.halfH - radius);
  const float ox = qx > 0.0f ? qx : 0.0f;
  const float oy = qy > 0.0f ? qy : 0.0f;
  const float outside = sqrtf(ox * ox + oy * oy);
  const float larger = qx > qy ? qx : qy;
  const float inside = larger < 0.0f ? larger : 0.0f;
  return clampf(0.5f - (outside + inside - radius), 0.0f, 1.0f);
}

void eyeBoxExtents(const EyeBox& box, float& outX, float& outY) {
  // A rotated rectangle's shadow on each axis is |w*cos| + |h*sin|. The rounded
  // box sits inside that rectangle, so this bounds it — exactly at the corners,
  // generously along the flats, and never short, which is the direction that
  // matters for both the raster loop and the edge check.
  const float tilt = box.tiltDeg * 3.14159265f / 180.0f;
  const float c = fabsf(cosf(tilt));
  const float s = fabsf(sinf(tilt));
  outX = box.halfW * c + box.halfH * s;
  outY = box.halfW * s + box.halfH * c;
}

namespace {

/** The pixel window a box can reach, clipped to the panel. */
bool boxWindow(const Surface& out, float centreX, float centreY, const EyeBox& box,
               int& minX, int& maxX, int& minY, int& maxY) {
  float reachX = 0.0f;
  float reachY = 0.0f;
  eyeBoxExtents(box, reachX, reachY);
  // +1 covers the one-pixel anti-aliasing ramp just outside the shape's extent.
  minX = static_cast<int>(floorf(centreX - reachX - 1.0f));
  maxX = static_cast<int>(ceilf(centreX + reachX + 1.0f));
  minY = static_cast<int>(floorf(centreY - reachY - 1.0f));
  maxY = static_cast<int>(ceilf(centreY + reachY + 1.0f));
  if (minX < 0) minX = 0;
  if (minY < 0) minY = 0;
  if (maxX > out.getWidth() - 1) maxX = out.getWidth() - 1;
  if (maxY > out.getHeight() - 1) maxY = out.getHeight() - 1;
  return minX <= maxX && minY <= maxY;
}

float sample(int x, int y, float centreX, float centreY, const EyeBox& box, bool hardEdge) {
  // +0.5 samples the pixel's centre rather than its corner; without it the whole
  // face sits half a pixel up and to the left.
  const float coverage = eyeBoxCoverage(static_cast<float>(x) + 0.5f - centreX,
                                        static_cast<float>(y) + 0.5f - centreY, box);
  if (!hardEdge) return coverage;
  return coverage >= 0.5f ? 1.0f : 0.0f;
}

}  // namespace

void drawEyeBox(Surface& out, float centreX, float centreY, const EyeBox& box,
                const Color& ink, float alpha, bool hardEdge) {
  if (alpha <= 0.0f) return;
  int minX = 0;
  int maxX = 0;
  int minY = 0;
  int maxY = 0;
  if (!boxWindow(out, centreX, centreY, box, minX, maxX, minY, maxY)) return;

  for (int y = minY; y <= maxY; ++y) {
    for (int x = minX; x <= maxX; ++x) {
      const float coverage = sample(x, y, centreX, centreY, box, hardEdge) * alpha;
      if (coverage <= 0.0f) continue;
      const Color previous = out.getPixel(x, y);
      const Color::byte r = static_cast<Color::byte>(ink.r * coverage);
      const Color::byte g = static_cast<Color::byte>(ink.g * coverage);
      const Color::byte b = static_cast<Color::byte>(ink.b * coverage);
      out.setPixel(x, y, Color(previous.r > r ? previous.r : r,
                               previous.g > g ? previous.g : g,
                               previous.b > b ? previous.b : b));
    }
  }
}

void punchEyeBox(Surface& out, float centreX, float centreY, const EyeBox& box, bool hardEdge) {
  int minX = 0;
  int maxX = 0;
  int minY = 0;
  int maxY = 0;
  if (!boxWindow(out, centreX, centreY, box, minX, maxX, minY, maxY)) return;

  for (int y = minY; y <= maxY; ++y) {
    for (int x = minX; x <= maxX; ++x) {
      const float coverage = sample(x, y, centreX, centreY, box, hardEdge);
      if (coverage <= 0.0f) continue;
      // Scaled down rather than set to black, so the pupil's own edge keeps the
      // one-pixel ramp its surroundings have. A hard-cut pupil inside a smooth
      // iris is the one place the anti-aliasing becomes visible AS anti-aliasing.
      const Color previous = out.getPixel(x, y);
      const float keep = 1.0f - coverage;
      out.setPixel(x, y, Color(static_cast<Color::byte>(previous.r * keep),
                               static_cast<Color::byte>(previous.g * keep),
                               static_cast<Color::byte>(previous.b * keep)));
    }
  }
}

void drawEyeStroke(Surface& out, float x0, float y0, float x1, float y1,
                   float thickness, const Color& ink, float alpha, bool hardEdge) {
  const float dx = x1 - x0;
  const float dy = y1 - y0;
  const float length = sqrtf(dx * dx + dy * dy);
  const float half = thickness * 0.5f;
  EyeBox box;
  // The ink ENDS at the endpoints. An SVG-style round cap would extend half a
  // thickness beyond each end, and the comment here used to claim that is what
  // happened while the arithmetic did the opposite — which is how the claw skin
  // came to reach 1.2 px past the tip it was told to stop at, and light row 0.
  // Callers place tips; the renderer must not move them.
  //
  // The max() keeps a zero-length stroke a round dot rather than collapsing it
  // to a hairline: the sweep skin draws its bright running head that way.
  const float axis = length * 0.5f;
  box.halfW = axis > half ? axis : half;
  box.halfH = half;
  box.radius = half;
  box.tiltDeg = length < 0.0001f ? 0.0f : atan2f(dy, dx) * 180.0f / 3.14159265f;
  drawEyeBox(out, (x0 + x1) * 0.5f, (y0 + y1) * 0.5f, box, ink, alpha, hardEdge);
}

void drawEyeCell(Surface& out, int x, int y, int w, int h, const Color& ink, float alpha) {
  if (alpha <= 0.0f) return;
  const Color::byte r = static_cast<Color::byte>(ink.r * alpha);
  const Color::byte g = static_cast<Color::byte>(ink.g * alpha);
  const Color::byte b = static_cast<Color::byte>(ink.b * alpha);
  for (int py = y; py < y + h; ++py) {
    for (int px = x; px < x + w; ++px) {
      if (px < 0 || py < 0 || px >= out.getWidth() || py >= out.getHeight()) continue;
      const Color previous = out.getPixel(px, py);
      out.setPixel(px, py, Color(previous.r > r ? previous.r : r,
                                 previous.g > g ? previous.g : g,
                                 previous.b > b ? previous.b : b));
    }
  }
}

}  // namespace tcos
