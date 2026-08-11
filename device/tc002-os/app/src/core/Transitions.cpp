#include "core/Transitions.h"

#include <math.h>

#include "core/Ease.h"

namespace tcos {
namespace transition {

namespace {

// Blend weights are 0..256 integers, not floats. Every operator below is sampled
// byte-for-byte by the host self-check, and (v * k) / 256 is the same arithmetic
// on clang/x86 and gcc/ARM where a float multiply-then-truncate is not
// guaranteed to be. Positions still come from ease::*, which is polynomial only
// — there is no sinf/cosf/atan2f anywhere on a transition path, for the same
// reason ZosLogo had to grow an integer arcOf().
const int kFull = 256;

// Rounding is spelled out once so every boundary pixel agrees across platforms.
inline int roundToInt(float v) {
  return static_cast<int>(floorf(v + 0.5f));
}

inline int clampK(int k) {
  if (k < 0) return 0;
  if (k > kFull) return kFull;
  return k;
}

inline int weight(float t, float span) {
  return clampK(static_cast<int>(t * span + 0.5f));
}

inline unsigned char blend8(int a, int b, int k) {
  return static_cast<unsigned char>(a + (b - a) * k / kFull);
}

inline Color mix(const Color& a, const Color& b, int k) {
  return Color(blend8(a.r, b.r, k), blend8(a.g, b.g, k), blend8(a.b, b.b, k));
}

inline Color scale(const Color& c, int k) {
  return Color(static_cast<unsigned char>(c.r * k / kFull),
               static_cast<unsigned char>(c.g * k / kFull),
               static_cast<unsigned char>(c.b * k / kFull));
}

inline Color maxColor(const Color& a, const Color& b) {
  return Color(a.r > b.r ? a.r : b.r, a.g > b.g ? a.g : b.g, a.b > b.b ? a.b : b.b);
}

// The panel is white-hot rather than pure white: a hair of green keeps a highlight
// reading as part of this OS's accent instead of as a dead pixel cluster.
const Color kHot(220, 255, 235);
const Color kShine(235, 235, 235);
const Color kShineTrail(120, 120, 120);

// Copies `src` into `out` shifted vertically, hard-clipped. Opaque on purpose:
// two layers that tile must not show through each other, or a mid-transition
// frame reads as one smeared image instead of two ordered screens.
void blitV(Surface& out, const Surface& src, int dy, int k) {
  const int w = out.getWidth();
  const int h = out.getHeight();
  for (int y = 0; y < h; ++y) {
    const int sy = y - dy;
    if (sy < 0 || sy >= src.getHeight()) continue;
    for (int x = 0; x < w; ++x) {
      out.setPixel(x, y, k >= kFull ? src.getPixel(x, sy) : scale(src.getPixel(x, sy), k));
    }
  }
}

// ---------------------------------------------------------------------------
// kDive — the default descend.
//
// ZOS shipped this as a horizontal slide, which reads as scrolling to a sibling,
// not as entering. Hold already means "up a level", so depth belongs on the
// vertical axis: the destination rises from below and the caller sinks out of
// the top. The one-row hot edge on the incoming boundary is what separates it
// from a plain scroll — it says a shutter is opening, not that a page moved.
void composeDive(Surface& out, const Surface& from, const Surface& to, float t) {
  const int h = out.getHeight();
  const int travel = roundToInt(ease::inOutCubic(t) * h);
  blitV(out, from, -travel, kFull - weight(t, 154.0f));
  blitV(out, to, h - travel, kFull);

  const int edgeY = h - travel;
  if (edgeY >= 0 && edgeY < h) {
    const int k = weight(1.0f - t, 110.0f);
    for (int x = 0; x < out.getWidth(); ++x) {
      out.setPixel(x, edgeY, mix(out.getPixel(x, edgeY), kHot, k));
    }
  }
}

// ---------------------------------------------------------------------------
// kCrt — the music firmware's CRT power-on, played as a room change.
//
// Three phases, because a CRT is three phases: the picture you were watching
// collapses into the deflection line, the line snaps white, then it blooms back
// open onto the new picture. The carousel is the one destination that is
// literally "a display showing something else", so it gets the display gag.
const float kCrtSquashEnd = 0.30f;
const float kCrtLineEnd = 0.44f;

void composeCrt(Surface& out, const Surface& from, const Surface& to, float t) {
  const int w = out.getWidth();
  const int h = out.getHeight();
  const float cy = (h - 1) * 0.5f;

  if (t < kCrtSquashEnd) {
    // 0.92 rather than 1.0: at full collapse the extreme rows must still land on
    // 7 and 8 and not all pile onto a single row, or the "line" is 1 px and the
    // bloom has nothing symmetric to open from.
    const float p = ease::inQuad(t / kCrtSquashEnd);
    const float squash = 1.0f - 0.92f * p;
    const int heat = weight(p, 200.0f);
    for (int y = 0; y < h; ++y) {
      const int ty = roundToInt(cy + (y - cy) * squash);
      for (int x = 0; x < w; ++x) {
        // Several source rows land on one output row; taking the channel-wise
        // max makes the pile-up read as energy concentrating and keeps the
        // result independent of iteration order.
        const Color c = mix(from.getPixel(x, y), kHot, heat);
        out.setPixel(x, ty, maxColor(c, out.getPixel(x, ty)));
      }
    }
    return;
  }

  if (t < kCrtLineEnd) {
    // ~45 ms: one frame at the 25 fps the panel runs at, which is exactly the
    // duration of a CRT's snap. Longer reads as a stall, shorter as a dropped
    // frame.
    for (int x = 0; x < w; ++x) {
      out.setPixel(x, h / 2 - 1, kHot);
      out.setPixel(x, h / 2, kHot);
    }
    return;
  }

  const float p = ease::outCubic((t - kCrtLineEnd) / (1.0f - kCrtLineEnd));
  const int half = 1 + roundToInt(p * (h / 2 - 1));
  const int top = h / 2 - half;
  const int bottom = h / 2 - 1 + half;
  const int wash = weight(1.0f - p, 256.0f);
  for (int y = top; y <= bottom; ++y) {
    const bool edge = (y == top || y == bottom);
    for (int x = 0; x < w; ++x) {
      const Color c = to.getPixel(x, y);
      out.setPixel(x, y, edge ? mix(c, kHot, wash) : c);
    }
  }
}

// ---------------------------------------------------------------------------
// kEqualiser — the music firmware's spectrum rise, used as the reveal itself.
//
// The destination is uncovered bottom-up by 26 two-pixel bars (the same bar
// pitch that splash used on this panel), each with its own head start, and the
// topmost revealed pixel of every bar is lit as a bar cap. The front is
// therefore jagged and audibly musical rather than a flat wipe line.
//
// The head starts are a frozen spectrum snapshot, not an oscillator: a host
// assertion samples exact instants, so nothing on this path may consult a clock
// of its own.
const int kBarLead[26] = {3, 1, 4, 2, 0, 3, 5, 2, 1, 4, 2, 0, 3,
                          1, 5, 3, 0, 2, 4, 1, 3, 0, 2, 5, 1, 3};
const int kBarLeadMax = 5;

void composeEqualiser(Surface& out, const Surface& from, const Surface& to, float t) {
  const int w = out.getWidth();
  const int h = out.getHeight();
  // inOutQuad, not outQuad: an out-curve puts nearly every bar at full height by
  // the halfway point, which throws the jaggedness away in the first third.
  const int reach = roundToInt(ease::inOutQuad(t) * (h + kBarLeadMax));
  const int dimK = kFull - weight(t, 140.0f);
  const int capK = weight(1.0f - t, 190.0f);

  for (int x = 0; x < w; ++x) {
    int lit = reach - kBarLead[x / 2];
    if (lit < 0) lit = 0;
    if (lit > h) lit = h;
    const int frontY = h - lit;
    for (int y = 0; y < h; ++y) {
      if (y < frontY) {
        out.setPixel(x, y, scale(from.getPixel(x, y), dimK));
      } else {
        out.setPixel(x, y, to.getPixel(x, y));
      }
    }
    if (lit > 0 && frontY < h) {
      out.setPixel(x, frontY, mix(to.getPixel(x, frontY), kHot, capK));
    }
  }
}

// ---------------------------------------------------------------------------
// kCartridge — the arcade firmware's shine sweep, plus its menu corner brackets.
//
// drawWordSweep revealed its wordmark *behind* a travelling shine column rather
// than sliding it in, and that is the motif worth keeping: the bright bar is the
// thing that moves, and the new room is simply already there once it has passed.
// The 1-in-4 slope is copied exactly — a vertical bar reads as a wall, a slanted
// one reads as something scanning past.
void drawCornerBrackets(Surface& out, int k) {
  const int w = out.getWidth();
  const int h = out.getHeight();
  const Color c = scale(kShine, k);
  const int cornerX[4] = {0, w - 1, 0, w - 1};
  const int cornerY[4] = {0, 0, h - 1, h - 1};
  const int stepX[4] = {1, -1, 1, -1};
  const int stepY[4] = {1, 1, -1, -1};
  for (int i = 0; i < 4; ++i) {
    const int x = cornerX[i];
    const int y = cornerY[i];
    out.setPixel(x, y, maxColor(c, out.getPixel(x, y)));
    out.setPixel(x + stepX[i], y, maxColor(c, out.getPixel(x + stepX[i], y)));
    out.setPixel(x, y + stepY[i], maxColor(c, out.getPixel(x, y + stepY[i])));
  }
}

// The brackets ramp in fast and release slowly, and are gone well before the end:
// a bracket still framing a settled screen would read as chrome the user has to
// account for rather than as the slot closing around a cartridge.
int bracketLevel(float t) {
  if (t <= 0.0f || t >= 0.70f) return 0;
  const float p = (t < 0.18f) ? (t / 0.18f) : (1.0f - (t - 0.18f) / 0.52f);
  return weight(p, 256.0f);
}

void composeCartridge(Surface& out, const Surface& from, const Surface& to, float t) {
  const int w = out.getWidth();
  const int h = out.getHeight();
  // +10 and -5 so the shine is fully off-panel at both ends: the sweep must
  // start before the panel and finish past it, or it appears to spawn on top of
  // the outgoing screen.
  const int head = roundToInt(ease::inOutQuad(t) * (w + 10)) - 5;
  const int dimK = kFull - weight(t, 128.0f);

  for (int y = 0; y < h; ++y) {
    const int edge = head + (h - 1 - y) / 4;
    for (int x = 0; x < w; ++x) {
      if (x < edge) {
        out.setPixel(x, y, to.getPixel(x, y));
      } else if (x == edge) {
        out.setPixel(x, y, kShine);
      } else if (x == edge + 1) {
        out.setPixel(x, y, kShineTrail);
      } else {
        out.setPixel(x, y, scale(from.getPixel(x, y), dimK));
      }
    }
  }

  const int k = bracketLevel(t);
  if (k > 0) drawCornerBrackets(out, k);
}

// ---------------------------------------------------------------------------
// kDrop — the music firmware's console drop-and-bounce.
//
// The destination falls in from above as a rigid panel, overshoots its stop by
// two rows, and settles. Settings is the one place that is a drawer rather than
// a room — hold pulls it back up the way it came — and the overshoot is what
// gives the arrival a mechanical stop instead of a soft landing.
void composeDrop(Surface& out, const Surface& from, const Surface& to, float t) {
  const int h = out.getHeight();
  // outBack overshoots to ~1.10 and lands exactly on 1, so the panel travels
  // 0..17.6 px over a 16 px screen: the bounce is 2 px, the same overshoot the
  // splash used for its dropping letters.
  const int offset = roundToInt(ease::outBack(t) * h);
  blitV(out, from, offset, kFull - weight(t, 154.0f));
  blitV(out, to, offset - h, kFull);

  // The splash flashed its floor when the last letter landed. Here the overshoot
  // *is* the impact, so it is the only moment the bottom row lights up.
  const int over = offset - h;
  if (over > 0) {
    for (int x = 0; x < out.getWidth(); ++x) {
      out.setPixel(x, h - 1, mix(out.getPixel(x, h - 1), kHot, clampK(over * 90)));
    }
  }
}

// ---------------------------------------------------------------------------
// kFade — no direction implied; used for handoffs where "which way is deeper"
// is not a question the user asked.
void composeFade(Surface& out, const Surface& from, const Surface& to, float t) {
  const int k = weight(t, 256.0f);
  for (int y = 0; y < out.getHeight(); ++y) {
    for (int x = 0; x < out.getWidth(); ++x) {
      out.setPixel(x, y, maxColor(scale(from.getPixel(x, y), kFull - k),
                                  scale(to.getPixel(x, y), k)));
    }
  }
}

}  // namespace

int durationMs(Style style) {
  switch (style) {
    case kCrt: return 320;
    case kEqualiser: return 300;
    case kCartridge: return 280;
    case kDrop: return 260;
    case kFade: return 220;
    case kDive:
    default: return 240;
  }
}

void compose(Surface& out, const Surface& from, const Surface& to, Style style, float t) {
  out.clear();
  if (t <= 0.0f) {
    blitV(out, from, 0, kFull);
    return;
  }
  if (t >= 1.0f) {
    blitV(out, to, 0, kFull);
    return;
  }
  switch (style) {
    case kCrt: composeCrt(out, from, to, t); break;
    case kEqualiser: composeEqualiser(out, from, to, t); break;
    case kCartridge: composeCartridge(out, from, to, t); break;
    case kDrop: composeDrop(out, from, to, t); break;
    case kFade: composeFade(out, from, to, t); break;
    case kDive:
    default: composeDive(out, from, to, t); break;
  }
}

}  // namespace transition
}  // namespace tcos
