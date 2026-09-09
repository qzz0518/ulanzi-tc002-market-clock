#ifndef UI_GAMEICONS_H_
#define UI_GAMEICONS_H_

#include "core/Surface.h"

namespace tcos {
namespace gameicons {

/**
 * One 12x12 animated icon per entry on the games ring.
 *
 * All seven games shipped wearing the same generic Pong glyph, which made the
 * games ring useless: you could not tell what you were about to launch without
 * reading the label. Each icon now draws its own game, in that engine's own
 * sprite palette, so the colour alone identifies the card before the label is
 * read.
 *
 * Drawn from code, like everything else here — seven stored 12x12 RGB bitmaps
 * would be 3 KB, and these move anyway. Every one displaces pixels rather than
 * changing brightness, which is the rule the launcher icons had to learn twice:
 * at this size a brightness pulse is invisible and reads as frozen.
 *
 * `phaseMs` is the animation clock; each icon is a pure function of it.
 */
enum Icon {
  kBreakout = 0,
  kFlappy = 1,
  kSnake = 2,
  kPong = 3,
  kRacer = 4,
  kShooter = 5,
  kTetris = 6,
  kEye = 7,
  kIconCount = 8,
};

/** Draws icon `which` with its top-left at (x, y). Stays inside 12x12. */
void draw(Surface& out, int which, int x, int y, int phaseMs);

/** The card's headline colour, used for the confirm flash. */
Color headline(int which);

}  // namespace gameicons
}  // namespace tcos

#endif  // UI_GAMEICONS_H_
