#include "ui/LauncherScreen.h"

#include <math.h>

#include "core/Ease.h"
#include "core/Text.h"
#include "ui/GameIcons.h"
#include "visual/Glyphs.h"

namespace tcos {

namespace {

// The arrows belong to the PANEL, not to the text: they sit hard against both
// edges so the card reads as a window you are turning, rather than as a label
// with decorations. That costs the card 3 px on each side.
const int kArrowW = 3;
const int kIconX = kArrowW + 2;             // x=5..16
const int kLabelX = kIconX + 12 + 2;        // x=19
const int kLabelW = kPanelWidth - kArrowW - 2 - kLabelX;  // 28 px, two CJK cells
const int kLabelY = 1;                      // 12 px cell over rows 1..12
const int kRailY = kPanelHeight - 1;        // the bottom row, rows 13..14 stay dark
const int kPressFlashMs = 160;

Color dim(const Color& c, float k) {
  if (k <= 0.0f) return Color(0, 0, 0);
  if (k > 1.0f) k = 1.0f;
  return Color(static_cast<unsigned char>(c.r * k),
               static_cast<unsigned char>(c.g * k),
               static_cast<unsigned char>(c.b * k));
}

// One accent per icon kind, so a glance at the colour already says which family
// the current card belongs to before the label is even read.
Color accentFor(LauncherScreen::Icon icon) {
  if (icon >= LauncherScreen::kIconGameBreakout) {
    return gameicons::headline(icon - LauncherScreen::kIconGameBreakout);
  }
  switch (icon) {
    case LauncherScreen::kIconMusic:    return Color(255, 96, 160);
    case LauncherScreen::kIconGame:     return Color(120, 170, 255);
    case LauncherScreen::kIconSettings: return Color(200, 200, 200);
    // Violet, and specifically NOT the amber the usage pages use for 80%: a
    // card wearing the warning colour would read as an alert on a device with
    // nothing to warn about yet. The MARK ignores this and runs its own sweep
    // (see kIconVibe in drawIcon); this is what the rest of the card is tinted
    // with, so the ring still has one colour per room.
    case LauncherScreen::kIconVibe:     return Color(190, 120, 255);
    case LauncherScreen::kIconChannel:
    default:                            return Color(0, 230, 100);
  }
}

/**
 * A wrapping ramp through three key colours.
 *
 * Every family badge runs one of these rather than a flat accent. Three keys
 * and not a full HSV rotation because a rotation spends a third of its travel
 * in whatever hue happens to belong to another card, and on a ring where colour
 * is how you know which room you are in, that reads as the wrong room for a
 * moment every cycle. Each ramp below stays inside its own family.
 */
Color rampHue(float t, const float keys[3][3]) {
  t = t - floorf(t);
  const float scaled = t * 3.0f;
  const int from = static_cast<int>(scaled) % 3;
  const int to = (from + 1) % 3;
  const float f = scaled - floorf(scaled);
  return Color(
      static_cast<int>(keys[from][0] + (keys[to][0] - keys[from][0]) * f),
      static_cast<int>(keys[from][1] + (keys[to][1] - keys[from][1]) * f),
      static_cast<int>(keys[from][2] + (keys[to][2] - keys[from][2]) * f));
}

// magenta -> violet -> cyan. The loud one, and deliberately the widest sweep.
const float kVibeKeys[3][3] = {{255, 70, 200}, {150, 110, 255}, {70, 225, 255}};
// hot pink -> coral -> amber. Warm the whole way; music is the warm room.
const float kMusicKeys[3][3] = {{255, 90, 170}, {255, 120, 120}, {255, 190, 90}};
// arcade blue -> cyan -> mint. Cool, and clear of the greens the ring uses.
const float kGameKeys[3][3] = {{110, 160, 255}, {90, 220, 255}, {130, 255, 210}};
// spring green -> teal -> lime. The ring's own family.
const float kRingKeys[3][3] = {{0, 230, 100}, {0, 210, 180}, {150, 245, 90}};
// steel -> silver -> pale blue. Settings stays quiet; it is the only badge that
// must not compete with the four it sits beside.
const float kSetKeys[3][3] = {{150, 160, 175}, {215, 220, 230}, {170, 195, 235}};

Color vibeHue(float t) { return rampHue(t, kVibeKeys); }

void plot(Surface& out, int x, int y, const Color& c) {
  if (x < 0 || y < 0 || x >= out.getWidth() || y >= out.getHeight()) return;
  out.setPixel(x, y, c);
}

// Icons are procedural: a 12x12 RGB bitmap would cost 432 bytes each, and the
// whole point of this firmware is that it fits where the official one does not.
//
// All five ANIMATE, and all five animate by MOVING something. On a 12x12 cell a
// brightness pulse is nearly invisible and a 4-step rotation reads as flicker,
// so every icon here changes a position by at least two pixels per cycle. Cost
// is a handful of sinf/cosf per frame over at most 144 pixels.
void drawIcon(Surface& out, LauncherScreen::Icon icon, int x, int y, int phaseMs) {
  const float kTwoPi = 6.2831853f;

  // No accent parameter, and that is the point: every badge below runs its own
  // ramp now (rampHue, above), so a card's accent no longer reaches its icon.
  // It still tints the rest of the card and the transition wash — accentFor()
  // has other callers — but passing it here would be plumbing to nowhere.
  //
  // Per-game sprites draw themselves, in their own engine's palette.
  if (icon >= LauncherScreen::kIconGameBreakout) {
    gameicons::draw(out, icon - LauncherScreen::kIconGameBreakout, x, y, phaseMs);
    return;
  }

  switch (icon) {
    case LauncherScreen::kIconChannel: {
      // 轮播 — cards sliding past a window, which is what the room does. The
      // three-bar equaliser this replaced was fine on its own but sat two
      // cards away from VIBE's waveform, and at 12 px "bars that bounce" and
      // "a wave that travels" are the same idea twice.
      const float period = 1800.0f;
      const float u = (phaseMs / period) - floorf(phaseMs / period);
      const int slide = static_cast<int>(u * 6.0f);   // one card width per cycle
      // The window frame, dim, so the cards are seen to pass THROUGH something.
      for (int i = 0; i < 12; ++i) {
        plot(out, x + i, y, dim(rampHue(0.0f, kRingKeys), 0.35f));
        plot(out, x + i, y + 11, dim(rampHue(0.0f, kRingKeys), 0.35f));
      }
      for (int card = -1; card < 3; ++card) {
        const int cx = x + card * 6 + 6 - slide;
        const Color hot = rampHue(card * 0.33f + phaseMs / 2600.0f, kRingKeys);
        for (int dy = 2; dy <= 9; ++dy)
          for (int dx = 0; dx < 4; ++dx) {
            const int px = cx + dx;
            if (px < x || px >= x + 12) continue;     // clipped by the window
            plot(out, px, y + dy, (dy == 2 || dy == 9) ? dim(hot, 0.55f) : hot);
          }
      }
      break;
    }
    case LauncherScreen::kIconMusic: {
      // A quaver riding a wave of its own. The two beamed notes this replaced
      // were a static bracket at 12 px: the beam is 9 px of unchanging pixels
      // and the heads moved 3, so nine tenths of the mark never moved and it
      // read as furniture. One note that travels the full cell reads as music
      // being played rather than music being printed.
      const float period = 1400.0f;
      const float u = (phaseMs / period) - floorf(phaseMs / period);
      const int nx = x + 1 + static_cast<int>(u * 7.0f + 0.5f);
      // Bob on a sine so the note rises and falls as it crosses, and the stem
      // stays vertical — a note that tilted would just look broken.
      const int ny = y + 6 + static_cast<int>(sinf(u * kTwoPi) * 2.5f);
      const Color hot = rampHue(u + phaseMs / 3000.0f, kMusicKeys);

      // A dim staff line, so the bob has something to be measured against.
      for (int i = 0; i < 12; i += 2) plot(out, x + i, y + 10, dim(hot, 0.3f));
      // 3x3 head, 4 px stem, 2 px flag: the smallest thing that still reads as
      // a quaver rather than a domino.
      for (int dy = 0; dy < 3; ++dy)
        for (int dx = 0; dx < 3; ++dx) plot(out, nx + dx, ny + dy, hot);
      for (int i = 1; i <= 4; ++i) plot(out, nx + 2, ny - i, hot);
      plot(out, nx + 3, ny - 4, hot);
      plot(out, nx + 3, ny - 3, dim(hot, 0.6f));
      break;
    }
    case LauncherScreen::kIconGame: {
      // An invader, stepping. The pong rally this replaced was three 1-2 px
      // sprites on a black cell — technically moving, visually a few loose
      // dots. A silhouette everyone already knows survives being small, and
      // stepping it two pixels sideways is the same displacement rule.
      static const unsigned short kInvader[2][8] = {
          {0x0C30, 0x07E0, 0x0FF0, 0x1DB8, 0x1FF8, 0x0A50, 0x1188, 0x0810},
          {0x0C30, 0x07E0, 0x0FF0, 0x1DB8, 0x1FF8, 0x0A50, 0x0DB0, 0x1008},
      };
      const float period = 1000.0f;
      const float u = (phaseMs / period) - floorf(phaseMs / period);
      const int step = (u < 0.5f) ? 0 : 1;          // two legs, two frames
      const int shift = (u < 0.25f || u >= 0.75f) ? 0 : 1;
      const Color hot = rampHue(u * 0.5f + phaseMs / 2400.0f, kGameKeys);
      for (int row = 0; row < 8; ++row) {
        const unsigned short bits = kInvader[step][row];
        for (int col = 0; col < 13; ++col) {
          if (bits & (1 << (12 - col))) plot(out, x + col - 1 + shift, y + 2 + row, hot);
        }
      }
      break;
    }
    case LauncherScreen::kIconVibe: {
      // A travelling waveform. VIBE is a vibration, so the badge is one — and
      // the three-bar meter this replaced was a mistake: kIconChannel is also
      // three bars, so at 12 px the two rooms wore the same face.
      //
      // This is the ONE family badge that ignores the card's accent and runs
      // its own magenta→cyan sweep. Deliberate: the accent exists so a card
      // says which room it is, and this room's whole character is that it is
      // the loud one. Games are already polychrome, so the precedent is there.
      //
      // Displacement, per the house rule: the crest walks the full 12 px cell
      // once per cycle, and the ribbon's colour walks with it.
      const float travel = (phaseMs / 1250.0f) * kTwoPi;
      int prevPy = -1;
      for (int col = 0; col < 12; ++col) {
        const float u = col / 11.0f;
        // 1.5 periods across the cell: one full crest plus the start of the
        // next, which reads as "a wave" where a single arc reads as a hill.
        const float wave = sinf(u * kTwoPi * 1.5f - travel);
        const int py = y + 5 + static_cast<int>(wave * 3.5f - 0.5f);
        const Color hot = vibeHue(u * 0.45f + phaseMs / 2600.0f);
        // Fill the gap to the previous column. Plotting one pixel per column
        // leaves a dotted trail wherever the wave is steep — which at 1.5
        // periods across 12 px is most of it — and a dotted trail reads as
        // noise, not as a wave.
        if (prevPy >= 0) {
          const int lo = py < prevPy ? py : prevPy;
          const int hi = py < prevPy ? prevPy : py;
          for (int fill = lo; fill <= hi; ++fill) plot(out, x + col, fill, hot);
        } else {
          plot(out, x + col, py, hot);
        }
        // A dim under-edge gives the ribbon weight without doubling its
        // apparent amplitude, which at this size would clip against the cell.
        plot(out, x + col, py + 1, dim(hot, 0.45f));
        prevPy = py;
      }
      break;
    }
    case LauncherScreen::kIconSettings: {
      // Three sliders, knobs travelling. A gear was the obvious choice and the
      // wrong one: rotation at 12 px is four indistinguishable frames, so the
      // badge sat still while every other card moved. Sliders are what the
      // room actually contains — volume, brightness, a night window — and a
      // knob crossing its track is displacement nobody can miss.
      const float periods[3] = {2100.0f, 1500.0f, 2700.0f};
      for (int row = 0; row < 3; ++row) {
        const int ty = y + 2 + row * 4;
        const float phase = (phaseMs / periods[row]) * kTwoPi + row * 2.1f;
        const float u = 0.5f + 0.5f * sinf(phase);
        const Color hot = rampHue(row * 0.3f + phaseMs / 3200.0f, kSetKeys);
        for (int i = 0; i < 12; ++i) plot(out, x + i, ty, dim(hot, 0.3f));
        const int kx = x + static_cast<int>(u * 9.0f + 0.5f);
        for (int dx = 0; dx < 3; ++dx) {
          plot(out, kx + dx, ty - 1, hot);
          plot(out, kx + dx, ty, hot);
        }
      }
      break;
    }
    default:
      break;
  }
}

}  // namespace

LauncherScreen::LauncherScreen()
    : mEnteredMs(0), mActivated(-1), mPressFlashMs(-1), mLastTurnMs(-10000), mLastTurnDir(0),
      mChromeLit(0, 220, 110), mChromeDim(0, 40, 20), mEntryRise(false) {}

void LauncherScreen::setChrome(const Color& lit, const Color& dim) {
  mChromeLit = lit;
  mChromeDim = dim;
}

void LauncherScreen::setEntries(const std::vector<Entry>& entries, int nowMs) {
  mEntries = entries;
  mRing.setCount(static_cast<int>(mEntries.size()));
  mRing.setIndex(mRing.index(), nowMs);
}

void LauncherScreen::onEnter(int nowMs) {
  mEnteredMs = nowMs;
  mActivated = -1;
  mPressFlashMs = -1;
}

int LauncherScreen::takeActivated() {
  const int v = mActivated;
  mActivated = -1;
  return v;
}

bool LauncherScreen::onInput(Input input, int nowMs) {
  if (mEntries.empty()) return false;
  switch (input) {
    case kInputTurnCw:
      mRing.turn(1, nowMs);
      mLastTurnMs = nowMs;
      mLastTurnDir = 1;
      return true;
    case kInputTurnCcw:
      mRing.turn(-1, nowMs);
      mLastTurnMs = nowMs;
      mLastTurnDir = -1;
      return true;
    case kInputPress:
      mActivated = mEntries[mRing.index()].id;
      mPressFlashMs = nowMs;
      return true;
    default:
      // A hold is not ours: the Shell turns it into "up one level", and at the
      // launcher there is nowhere up, so it harmlessly does nothing.
      return false;
  }
}

bool LauncherScreen::isAnimating(int nowMs) const {
  if (mRing.isAnimating(nowMs)) return true;
  if (mPressFlashMs >= 0 && (nowMs - mPressFlashMs) < kPressFlashMs) return true;
  // The icons breathe, so the launcher is never actually static.
  return true;
}

void LauncherScreen::renderRail(Surface& out) const {
  const int n = mRing.count();
  if (n <= 1) return;
  // One rail pixel per entry, centred. With more entries than pixels the rail
  // degrades to a proportional cursor rather than lying about the count.
  if (n <= kPanelWidth / 2) {
    const int span = n * 2 - 1;
    const int x0 = (kPanelWidth - span) / 2;
    for (int i = 0; i < n; ++i) {
      const bool on = (i == mRing.index());
      plot(out, x0 + i * 2, kRailY, on ? mChromeLit : mChromeDim);
    }
    return;
  }
  const int cursor = (mRing.index() * (kPanelWidth - 1)) / (n - 1);
  for (int x = 0; x < kPanelWidth; ++x) plot(out, x, kRailY, mChromeDim);
  plot(out, cursor, kRailY, mChromeLit);
}

// Chrome, not content: the arrows say the knob turns, and stay put while cards
// slide underneath them. Drawn after the cards for exactly that reason.
//
// Space is genuinely tight. The left chevron uses the 2 px gutter that already
// sits between the 12 px icon cell and the label (no existing icon draws past
// x=10); the right one takes x=50..51, which is why the label window narrowed
// from 38 to 36. Neither touches the rail on row 15.
void LauncherScreen::renderArrows(Surface& out, int nowMs) const {
  if (mRing.count() <= 1) return;  // nothing to turn to, so nothing to promise

  // Idle: a slow breath. Always dimmer than the rail's lit dot, so it reads as
  // chrome rather than as another thing to select.
  const float breath = 0.60f + 0.25f * sinf((nowMs / 2400.0f) * 6.2831853f);
  const Color idle(static_cast<unsigned char>(mChromeLit.r * breath * 0.86f),
                   static_cast<unsigned char>(mChromeLit.g * breath * 0.86f),
                   static_cast<unsigned char>(mChromeLit.b * breath * 0.86f));

  // Turn feedback, on the side the new card comes from, over exactly the window
  // RingModel uses for its slide so the two read as one motion.
  const float e = 1.0f - ease::outCubic(ease::progress(nowMs, mLastTurnMs, RingModel::kSlideMs));
  const Color hot(224, 255, 240);

  for (int side = 0; side < 2; ++side) {
    const bool right = (side == 1);
    const bool active = (mLastTurnDir != 0) && (right == (mLastTurnDir > 0)) && e > 0.0f;
    const Color c = active ? Color(
        static_cast<unsigned char>(ease::lerp(idle.r, hot.r, e)),
        static_cast<unsigned char>(ease::lerp(idle.g, hot.g, e)),
        static_cast<unsigned char>(ease::lerp(idle.b, hot.b, e))) : idle;

    // A 3x5 chevron: two strokes meeting at a point, with a dimmer trailing
    // stroke that gives it depth without a second colour. Drawn from the tip
    // outwards so the shape stays symmetric about row 7.
    const int tipX = right ? 51 : 0;
    const int step = right ? -1 : 1;
    for (int d = 0; d < 3; ++d) {
      const int x = tipX + step * d;
      const float k = (d == 0) ? 1.0f : (d == 1 ? 0.85f : 0.45f);
      const Color shade(static_cast<unsigned char>(c.r * k),
                        static_cast<unsigned char>(c.g * k),
                        static_cast<unsigned char>(c.b * k));
      if (d == 0) {
        plot(out, x, 7, shade);
      } else {
        plot(out, x, 7 - d, shade);
        plot(out, x, 7 + d, shade);
      }
    }
    // A turn fills the chevron solid, so the shape changes and not only the
    // brightness — the lesson the icons taught when three of them shipped
    // "animated" by brightness alone and read as frozen.
    if (active && e > 0.15f) {
      plot(out, tipX + step, 7, c);
      plot(out, tipX + step * 2, 6, c);
      plot(out, tipX + step * 2, 8, c);
    }
  }
}

void LauncherScreen::renderCard(Surface& out, const Entry& entry, int originX,
                                int nowMs, int riseY) const {
  // Cards slide horizontally; anything fully off-panel costs nothing to skip.
  if (originX <= -kPanelWidth || originX >= kPanelWidth) return;

  drawIcon(out, entry.icon, originX + kIconX, 2 + riseY, nowMs);

  const int labelWidth = text::measure(entry.label.c_str());
  const int viewX = originX + kLabelX;
  int labelX = viewX;
  if (labelWidth > kLabelW) {
    // Marquee only the settled card: scrolling a card that is itself sliding
    // reads as jitter.
    if (originX == 0) labelX += text::marqueeOffset(labelWidth, kLabelW, nowMs - mEnteredMs);
  } else {
    labelX += (kLabelW - labelWidth) / 2;
  }
  // The clip window travels with the card, so a neighbour's label can never
  // bleed into this one during a slide.
  int clipX = viewX;
  int clipW = kLabelW;
  if (clipX < 0) {
    clipW += clipX;
    clipX = 0;
  }
  if (clipX + clipW > kPanelWidth) clipW = kPanelWidth - clipX;
  if (clipW > 0) {
    text::draw(out, entry.label.c_str(), labelX, kLabelY + riseY, Color(255, 255, 255), clipX, clipW);
  }
}

void LauncherScreen::render(Surface& out, int nowMs) {
  out.clear();
  // Entering a deeper ring lifts the whole card up from the bottom edge. Hold
  // already means "up a level", so content arriving from below completes the
  // metaphor — and a full-card 16 px move is the one cue that cannot be missed
  // at this size.
  int rise = 0;
  if (mEntryRise) {
    const float p = ease::progress(nowMs, mEnteredMs, 180);
    if (p < 1.0f) rise = static_cast<int>((1.0f - ease::outCubic(p)) * kPanelHeight + 0.5f);
  }
  if (mEntries.empty()) {
    text::drawCentered(out, "\xE6\x97\xA0\xE9\xA2\x91\xE9\x81\x93", kLabelY,  // 无频道
                       Color(120, 120, 120), 0, kPanelWidth);
    return;
  }

  const float offset = mRing.visualOffset(nowMs);
  const int base = mRing.index();

  // During a slide two cards are on the panel; when settled only one is, and the
  // neighbours are skipped by the off-panel test in renderCard.
  for (int step = -1; step <= 1; ++step) {
    const int idx = mRing.wrap(base + step);
    const float slot = static_cast<float>(step) + offset;
    const int originX = static_cast<int>(slot * kPanelWidth + (slot < 0 ? -0.5f : 0.5f));
    renderCard(out, mEntries[idx], originX, nowMs, rise);
  }

  renderRail(out);
  renderArrows(out, nowMs);

  // Confirm flash: a brief full-panel wash on press, so the knob feels connected
  // even though this device has no haptics and (by default) no sound.
  if (mPressFlashMs >= 0) {
    const float p = ease::progress(nowMs, mPressFlashMs, kPressFlashMs);
    if (p < 1.0f) {
      const Color wash = dim(accentFor(mEntries[base].icon), 0.35f * (1.0f - p));
      for (int y = 0; y < kPanelHeight; ++y) {
        for (int x = 0; x < kPanelWidth; ++x) {
          const Color c = out.getPixel(x, y);
          if (c.r || c.g || c.b) continue;
          out.setPixel(x, y, wash);
        }
      }
    }
  }
}

bool LauncherScreen::selectById(int id, int nowMs) {
  for (size_t i = 0; i < mEntries.size(); ++i) {
    if (mEntries[i].id != id) continue;
    mRing.setIndex(static_cast<int>(i), nowMs);
    return true;
  }
  return false;
}

}  // namespace tcos
