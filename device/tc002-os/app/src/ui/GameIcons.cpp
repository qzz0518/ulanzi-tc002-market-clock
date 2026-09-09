#include "ui/GameIcons.h"

#include <math.h>

namespace tcos {
namespace gameicons {

namespace {

// Every palette below is lifted from the engine it depicts, so a card is drawn
// in the colours the game actually uses. That is what lets the games ring be
// read by colour alone, and it is why these icons are polychrome while the root
// launcher's stay single-accent — the palette difference IS the "different
// room" signal on entering.
const Color kWhite(255, 255, 255);

float fract(float v) { return v - floorf(v); }

// Triangle wave over [0,1]: out and back, which is how every rally in this set
// is animated without storing a direction.
float triangle(float u) { return u < 0.5f ? u * 2.0f : 2.0f - u * 2.0f; }

// Clipped to the 12x12 cell, not just to the surface: an icon that spilled a
// pixel would land in the gutter or the label and read as a defect.
void plot(Surface& out, int x0, int y0, int lx, int ly, const Color& c) {
  if (lx < 0 || ly < 0 || lx >= 12 || ly >= 12) return;
  const int x = x0 + lx;
  const int y = y0 + ly;
  if (x < 0 || y < 0 || x >= out.getWidth() || y >= out.getHeight()) return;
  out.setPixel(x, y, c);
}

void rect(Surface& out, int x0, int y0, int lx, int ly, int w, int h, const Color& c) {
  for (int dy = 0; dy < h; ++dy) {
    for (int dx = 0; dx < w; ++dx) plot(out, x0, y0, lx + dx, ly + dy, c);
  }
}

// --- breakout: a brick wall above, a paddle below, a ball rallying between ---
void drawBreakout(Surface& out, int x, int y, int t) {
  static const Color kRainbow[8] = {
      Color(255, 77, 90),  Color(255, 138, 42), Color(255, 212, 59), Color(88, 214, 141),
      Color(53, 199, 212), Color(91, 140, 255), Color(182, 108, 255), Color(255, 77, 90)};
  // Running bond, so the wall reads as masonry rather than a striped bar.
  static const int kTop[4] = {0, 3, 6, 9};
  static const int kBottom[4] = {1, 4, 7, 10};
  for (int i = 0; i < 4; ++i) {
    rect(out, x, y, kTop[i], 0, 2, 1, kRainbow[i]);
    rect(out, x, y, kBottom[i], 1, 2, 1, kRainbow[i + 4]);
  }

  const int bx = 1 + static_cast<int>(triangle(fract(t / 1100.0f)) * 9.0f + 0.5f);
  const int by = 3 + static_cast<int>(triangle(fract(t / 700.0f)) * 6.0f + 0.5f);
  plot(out, x, y, bx, by, kWhite);

  int px = bx - 1;
  if (px < 0) px = 0;
  if (px > 8) px = 8;
  rect(out, x, y, px, 11, 4, 1, Color(193, 255, 61));
}

// --- flappy: a pipe gap, and a bird that falls slowly and flaps fast --------
void drawFlappy(Surface& out, int x, int y, int t) {
  const Color body(40, 192, 90);
  const Color rim(125, 255, 168);
  rect(out, x, y, 8, 0, 3, 3, body);
  rect(out, x, y, 8, 3, 3, 1, rim);
  rect(out, x, y, 8, 8, 3, 1, rim);
  rect(out, x, y, 8, 9, 3, 3, body);

  // 70% falling, 30% rising. That asymmetry is what makes it read as flappy
  // rather than as a ball bouncing.
  const float u = fract(t / 800.0f);
  const int top = (u < 0.7f) ? 2 + static_cast<int>(4.0f * u / 0.7f + 0.5f)
                             : 2 + static_cast<int>(4.0f * (1.0f - u) / 0.3f + 0.5f);
  rect(out, x, y, 2, top, 2, 2, Color(255, 212, 59));
  plot(out, x, y, 2, top + 1, Color(255, 138, 42));
}

// --- snake: a gradient body crawling a closed loop around blinking food -----
void drawSnake(Surface& out, int x, int y, int t) {
  // A hand-built circuit that never revisits a cell, so the body can never look
  // like it crosses itself.
  static const signed char kPath[56][2] = {
      {1,1},{2,1},{3,1},{4,1},{5,1},{6,1},{7,1},{8,1},{9,1},{10,1},
      {10,2},{10,3},
      {10,4},{9,4},{8,4},{7,4},{6,4},{5,4},{4,4},{3,4},{2,4},{1,4},
      {1,5},{1,6},
      {1,7},{2,7},{3,7},{4,7},{5,7},{6,7},{7,7},{8,7},{9,7},{10,7},
      {10,8},{10,9},
      {10,10},{9,10},{8,10},{7,10},{6,10},{5,10},{4,10},{3,10},{2,10},{1,10},
      {0,10},{0,9},{0,8},{0,7},{0,6},{0,5},{0,4},{0,3},{0,2},{0,1}};

  const bool blink = ((t / 280) % 2) == 0;
  plot(out, x, y, 6, 5, blink ? Color(255, 77, 90) : Color(122, 31, 39));

  const int head = (t / 80) % 56;
  for (int k = 0; k < 8; ++k) {
    const int idx = ((head - k) % 56 + 56) % 56;
    const float mix = k / 7.0f;
    const Color c(static_cast<unsigned char>(214 + (14 - 214) * mix),
                  static_cast<unsigned char>(255 + (156 - 255) * mix),
                  static_cast<unsigned char>(92 + (106 - 92) * mix));
    plot(out, x, y, kPath[idx][0], kPath[idx][1], c);
  }
}

// --- pong: the original glyph, wearing the match's real two-tone kit --------
void drawPong(Surface& out, int x, int y, int t) {
  const int bx = 3 + static_cast<int>(triangle(fract(t / 1500.0f)) * 6.0f + 0.5f);
  const int by = 2 + static_cast<int>(triangle(fract(t / 620.0f)) * 8.0f + 0.5f);

  int leftY = by - 1;
  if (leftY < 1) leftY = 1;
  if (leftY > 9) leftY = 9;
  int rightY = 11 - by - 1;
  if (rightY < 1) rightY = 1;
  if (rightY > 9) rightY = 9;

  rect(out, x, y, 1, leftY, 1, 3, Color(91, 140, 255));
  rect(out, x, y, 10, rightY, 1, 3, Color(255, 138, 42));
  rect(out, x, y, bx, by, 2, 2, kWhite);
}

// --- racer: oncoming traffic, a scrolling divider, a car hopping lanes ------
void drawRacer(Surface& out, int x, int y, int t) {
  // The divider scrolls at the same 1px/100ms as the traffic, so the road reads
  // as moving rather than as the cars sliding over a static surface.
  for (int c = 0; c < 12; ++c) {
    if ((c + (t / 100)) % 4 < 2) plot(out, x, y, c, 6, Color(46, 58, 70));
  }

  const int cycle = t / 1600;
  const float u = fract(t / 1600.0f);
  const int tx = 11 - static_cast<int>(16.0f * u);
  const int trafficTop = (cycle % 2 == 0) ? 2 : 9;
  for (int dx = 0; dx < 3; ++dx) {
    const int cx = tx + dx;
    if (cx < 0 || cx > 11) continue;  // the cell clips, not just the surface
    rect(out, x, y, cx, trafficTop, 1, 2, Color(255, 77, 90));
  }

  // The player is always in the lane the traffic is not, and hops at the
  // instant the next car appears — so the move reads as a dodge, not a drift.
  const int playerTop = (cycle % 2 == 0) ? 9 : 2;
  rect(out, x, y, 1, playerTop, 3, 2, Color(193, 255, 61));
  plot(out, x, y, 2, playerTop, kWhite);
}

// --- shooter: a ship strafing bullets into an enemy at the right edge -------
void drawShooter(Surface& out, int x, int y, int t) {
  const Color hull(214, 244, 255);
  rect(out, x, y, 1, 4, 2, 1, hull);
  rect(out, x, y, 1, 5, 4, 1, hull);
  rect(out, x, y, 1, 6, 2, 1, hull);
  plot(out, x, y, 0, 5, ((t / 70) % 2) ? Color(255, 138, 42) : Color(255, 212, 59));

  plot(out, x, y, 7, 1, Color(46, 58, 70));
  plot(out, x, y, 3, 9, Color(46, 58, 70));

  rect(out, x, y, 10, 4, 2, 2, Color(255, 77, 90));
  plot(out, x, y, 10, 4, Color(123, 41, 48));

  // Drawn last, so the final step paints over the enemy's corner as an impact
  // spark and the wrap reads as the next round leaving the barrel.
  const int bx = 5 + (t / 90) % 5;
  rect(out, x, y, bx, 5, 2, 1, kWhite);
}

// --- tetris: a piece gliding sideways into a mosaic stack -------------------
void drawTetris(Surface& out, int x, int y, int t) {
  static const Color kPieces[7] = {
      Color(53, 199, 212), Color(91, 140, 255), Color(255, 138, 42), Color(255, 212, 59),
      Color(88, 214, 141), Color(182, 108, 255), Color(255, 77, 90)};
  static const int kDepth[10] = {1, 2, 1, 2, 2, 3, 2, 3, 2, 1};
  for (int row = 1; row <= 10; ++row) {
    const int depth = kDepth[row - 1];
    for (int c = 0; c < depth; ++c) {
      plot(out, x, y, c, row, kPieces[(2 * c + 3 * row) % 7]);
    }
  }

  // Glides in from the right edge, lands flush against the shelf, holds the
  // locked pose, then the wrap reads as the next piece spawning.
  const int step = static_cast<int>(10.0f * fract(t / 1500.0f));
  int px = 10 - step;
  if (px < 2) px = 2;
  rect(out, x, y, px, 4, 2, 2, Color(255, 212, 59));
}

}  // namespace

// --- eye: an almond that looks around and blinks ---------------------------
//
// Deliberately NOT a miniature of the screen it launches. The face itself is
// two solid capsules with no pupil, which at 12x12 would be a pair of 3x7 bars
// — unreadable as an eye, and indistinguishable from Tetris's blocks on the
// ring. An almond with a pupil is the shape everyone already reads as an eye,
// and the ring's job is to say what you are about to open.
//
// It blinks rather than pulsing, because the whole icon set displaces pixels
// instead of changing brightness: at this size a brightness change is invisible
// and the card reads as frozen.
void drawEye(Surface& out, int x, int y, int t) {
  // Half-widths per row, describing the almond from row 3 to row 9.
  static const int kRows[7][2] = {
      {4, 7}, {2, 9}, {1, 10}, {1, 10}, {1, 10}, {2, 9}, {4, 7}};
  const Color kIris(228, 233, 255);
  const Color kPupil(28, 34, 58);

  // One blink every 2.1 s, 160 ms long. The lid is drawn as the eye collapsing
  // to its middle two rows rather than as a separate eyelid: fewer pixels, and
  // it matches what the real face does on the panel.
  const int cycle = t % 2100;
  const bool shut = cycle > 1940;

  if (shut) {
    rect(out, x, y, 1, 5, 10, 2, kIris);
    return;
  }

  for (int r = 0; r < 7; ++r) {
    const int row = 3 + r;
    rect(out, x, y, kRows[r][0], row, kRows[r][1] - kRows[r][0] + 1, 1, kIris);
  }

  // The pupil wanders across the middle of the almond. 2..7 keeps it inside the
  // white at every position, so the eye never looks burst.
  const int px = 2 + static_cast<int>(triangle(fract(t / 1700.0f)) * 5.0f + 0.5f);
  rect(out, x, y, px, 5, 3, 3, kPupil);
}

void draw(Surface& out, int which, int x, int y, int phaseMs) {
  switch (which) {
    case kBreakout: drawBreakout(out, x, y, phaseMs); break;
    case kFlappy:   drawFlappy(out, x, y, phaseMs); break;
    case kSnake:    drawSnake(out, x, y, phaseMs); break;
    case kPong:     drawPong(out, x, y, phaseMs); break;
    case kRacer:    drawRacer(out, x, y, phaseMs); break;
    case kShooter:  drawShooter(out, x, y, phaseMs); break;
    case kTetris:   drawTetris(out, x, y, phaseMs); break;
    case kEye:      drawEye(out, x, y, phaseMs); break;
    default: break;
  }
}

Color headline(int which) {
  switch (which) {
    case kBreakout: return Color(193, 255, 61);
    case kFlappy:   return Color(255, 212, 59);
    case kSnake:    return Color(214, 255, 92);
    case kPong:     return Color(91, 140, 255);
    case kRacer:    return Color(193, 255, 61);
    case kShooter:  return Color(214, 244, 255);
    case kTetris:   return Color(182, 108, 255);
    case kEye:      return Color(228, 233, 255);
    default:        return Color(120, 170, 255);
  }
}

}  // namespace gameicons
}  // namespace tcos
