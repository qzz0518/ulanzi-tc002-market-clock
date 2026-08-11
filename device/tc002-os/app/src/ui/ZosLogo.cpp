#include "ui/ZosLogo.h"

namespace tcos {
namespace zoslogo {

namespace {

// Z: two full-width bars joined by a 2 px diagonal. The diagonal repeats its
// x at ly 6 and 7 so the crossing sits on the optical centre rather than
// drifting a pixel high.
const int kZDiagonalLeft[10] = {8, 7, 6, 5, 4, 4, 3, 2, 1, 0};

bool zInk(int lx, int ly) {
  if (ly <= 1 || ly >= 12) return true;             // top and bottom bars
  const int left = kZDiagonalLeft[ly - 2];
  return lx == left || lx == left + 1;
}

// O: a rounded rectangle — the first and last rows inset so the corners read
// round at a size where a real curve cannot.
bool oInk(int lx, int ly) {
  if (ly == 0 || ly == 13) return lx >= 2 && lx <= 7;
  if (ly == 1 || ly == 12) return lx >= 1 && lx <= 8;
  return lx <= 1 || lx >= 8;
}

// S: strictly 180-degree rotationally symmetric, which is what keeps it from
// looking top-heavy next to the O.
bool sInk(int lx, int ly) {
  switch (ly) {
    case 0: return lx >= 2 && lx <= 9;
    case 1: return lx >= 1 && lx <= 9;
    case 2: case 3: case 4: case 5: return lx <= 1;
    case 6: return lx >= 1 && lx <= 7;
    case 7: return lx >= 2 && lx <= 8;
    case 8: case 9: case 10: case 11: return lx >= 8;
    case 12: return lx <= 8;
    case 13: return lx <= 7;
    default: return false;
  }
}

}  // namespace

bool inkAt(int x, int y, int* letter, int* lx, int* ly) {
  const int cellY = y - kTopY;
  if (cellY < 0 || cellY >= kCellH) return false;
  for (int i = 0; i < 3; ++i) {
    const int cellX = x - kOriginX[i];
    if (cellX < 0 || cellX >= kCellW) continue;
    bool ink = false;
    if (i == kZ) ink = zInk(cellX, cellY);
    else if (i == kO) ink = oInk(cellX, cellY);
    else ink = sInk(cellX, cellY);
    if (!ink) return false;
    if (letter != 0) *letter = i;
    if (lx != 0) *lx = cellX;
    if (ly != 0) *ly = cellY;
    return true;
  }
  return false;
}

int arcOf(int letter, int lx, int ly) {
  switch (letter) {
    case kZ:
      // Top bar left to right, down the diagonal, then the bottom bar.
      if (ly <= 1) return lx;
      if (ly >= 12) return 20 + lx;
      return 10 + (ly - 2);
    case kO: {
      // Clockwise from the top-left of the cap, closing where it started.
      if (ly <= 1) {
        if (lx >= 2 && lx <= 7) return lx - 2;
        if (lx == 8) return 6;   // the cap's right shoulder
        if (lx == 1) return 35;  // ...and its left, reached last
      }
      if (ly >= 12) {
        if (lx >= 2 && lx <= 7) return 18 + (7 - lx);
        if (lx == 8) return 17;
        if (lx == 1) return 24;
      }
      if (lx >= 8) return 7 + (ly - 2);     // right upright, downwards
      return 25 + (11 - ly);                // left upright, upwards
    }
    case kS:
      // One stroke from the top right down to the bottom left.
      if (ly <= 1) return 9 - lx;
      if (ly >= 2 && ly <= 5) return 9 + (ly - 2);
      if (ly == 6) return 13 + (lx - 1);
      if (ly == 7) return 13 + (lx - 2);
      if (ly >= 8 && ly <= 11) return 20 + (ly - 8);
      return 24 + (8 - lx);
    default:
      return -1;
  }
}

bool haloAt(int x, int y) {
  if (inkAt(x, y, 0, 0, 0)) return false;
  return inkAt(x - 1, y, 0, 0, 0) || inkAt(x + 1, y, 0, 0, 0) ||
         inkAt(x, y - 1, 0, 0, 0) || inkAt(x, y + 1, 0, 0, 0);
}

int inkCount() {
  int n = 0;
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 52; ++x) {
      if (inkAt(x, y, 0, 0, 0)) ++n;
    }
  }
  return n;
}

}  // namespace zoslogo
}  // namespace tcos
