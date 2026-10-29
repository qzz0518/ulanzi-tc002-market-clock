#ifndef VISUAL_LYRICRINGS_H_
#define VISUAL_LYRICRINGS_H_

// The numeric core of what this firmware draws on top of the sideloaded
// player's four modes: the instrumental dots, 年轮's ripple, and the chorus
// ripple the other modes borrow from it. It lives here rather than next to
// LyricModes.h because that tree receives no changes (ADR 0014); the browser
// copy is the bottom half of web/src/components/music/pixel-lyric-modes.ts,
// and the two must stay number for number.

#include <math.h>
#include <stdint.h>

namespace tcos {
namespace lyricrings {

// folia's Hanabi break rule: a gap of 3 s or more before the next line is an
// instrumental rather than a breath, and the line is let go 0.6 s after its
// last word so a trailing syllable is never cut.
const int kInterludeMinGapMs = 3000;
const int kInterludeLeadMs = 600;

// interludeProgress: how far through the break, 0..1, or -1 when there is none.
inline float lyricInterludeProgress(int endMs, int untilMs, int playheadMs) {
  if (untilMs - endMs < kInterludeMinGapMs) return -1.f;
  const int from = endMs + kInterludeLeadMs;
  if (playheadMs < from || playheadMs >= untilMs) return -1.f;
  const float t = (float)(playheadMs - from) / (float)(untilMs - from);
  return t < 0.f ? 0.f : (t > 1.f ? 1.f : t);
}

// Three 2 x 2 dots, centred on the panel.
const int kInterludeDots = 3;
const int kInterludeDotX[kInterludeDots] = {19, 25, 31};
const int kInterludeDotY = 7;
const int kInterludeBreathMs = 420;

enum Tier { kTierPrimary = 0, kTierSecondary = 1, kTierContext = 2, kTierMuted = 3 };

// interludeDotTier: filled dots in the sung tier, the one filling now breathing
// between the focus and trailing tiers, the rest waiting.
inline Tier interludeDotTier(int dot, float progress, float timeMs) {
  const float p = progress < 0.f ? 0.f : (progress > 1.f ? 1.f : progress);
  const float lit = p * (float)kInterludeDots - (float)dot;
  if (lit >= 1.f) return kTierSecondary;
  if (lit <= 0.f) return kTierMuted;
  const float t = timeMs < 0.f ? 0.f : timeMs;
  return ((int)(t / (float)kInterludeBreathMs)) % 2 == 0 ? kTierPrimary : kTierContext;
}

// haloRadius: one ring per sung glyph, at Chebyshev distance 1 for its first
// half and 2 for its second. Only the two nearest rings have anywhere to land
// on a 16-row panel with 12-row glyphs.
inline int haloRadius(float cellFrac) { return cellFrac < 0.5f ? 1 : 2; }

// haloTier: the inner ring in the sung tier, the outer one a step down —
// bright enough to read on a full line, where the ring only has the rows above
// and below and the gaps beside the glyph.
inline Tier haloTier(int radius) { return radius <= 1 ? kTierSecondary : kTierContext; }

// ringsHopPx: 年轮 lifts the glyph being sung by a pixel for its first half.
inline int ringsHopPx(float cellFrac) { return cellFrac < 0.5f ? 1 : 0; }

// ---- 倾诉 ------------------------------------------------------------------

// tiltBreaks: a space or punctuation ends a 倾诉 phrase; an apostrophe or hyphen
// joins a word to the next instead. Explicit ranges, the browser's to the letter.
inline bool tiltBreaks(uint32_t cp) {
  if (cp == 0x27 || cp == 0x2019 || cp == 0x2D) return false;
  return cp == 0x20 || cp == 0xA0 || cp == 0x3000 || (cp >= 0x21 && cp <= 0x2F) ||
         (cp >= 0x3A && cp <= 0x40) || (cp >= 0x5B && cp <= 0x60) ||
         (cp >= 0x7B && cp <= 0x7E) || (cp >= 0x2000 && cp <= 0x206F) ||
         (cp >= 0x3001 && cp <= 0x303F) || (cp >= 0xFF01 && cp <= 0xFF0F) ||
         (cp >= 0xFF1A && cp <= 0xFF20) || (cp >= 0xFF3B && cp <= 0xFF40) ||
         (cp >= 0xFF5B && cp <= 0xFF65);
}

// tiltUnits: up to and including each break, a run of nothing but breaks folded
// into the phrase before it, and a phrase over six glyphs cut into pieces of
// about four. Writes [from, to) pairs; returns how many.
inline int tiltUnits(const uint32_t* cps, int n, int* from, int* to, int maxUnits) {
  int runFrom[192];
  int runTo[192];
  int runs = 0;
  int start = 0;
  for (int i = 0; i < n; ++i) {
    if (!tiltBreaks(cps[i]) && i + 1 < n) continue;
    bool allBreaks = true;
    for (int k = start; k <= i; ++k) {
      if (!tiltBreaks(cps[k])) allBreaks = false;
    }
    if (allBreaks && runs > 0) {
      runTo[runs - 1] = i + 1;
    } else if (runs < 192) {
      runFrom[runs] = start;
      runTo[runs] = i + 1;
      ++runs;
    }
    start = i + 1;
  }
  int units = 0;
  for (int r = 0; r < runs; ++r) {
    const int length = runTo[r] - runFrom[r];
    const int pieces = length > 6 ? (length + 3) / 4 : 1;
    for (int k = 0; k < pieces && units < maxUnits; ++k) {
      from[units] = runFrom[r] + (length * k) / pieces;
      to[units] = runFrom[r] + (length * (k + 1)) / pieces;
      ++units;
    }
  }
  return units;
}

// lyricHash: the browser's Math.imul hash, in uint32_t.
inline uint32_t lyricHash(uint32_t seed, uint32_t salt) {
  uint32_t h = (seed ^ ((salt + 1u) * 0x9E3779B1u)) * 0x85EBCA6Bu;
  h ^= h >> 13;
  h *= 0xC2B2AE35u;
  return h ^ (h >> 16);
}

inline int tiltLeanUnit(int lineStartMs, int unitCount) {
  if (unitCount < 2) return -1;
  return (int)(lyricHash((uint32_t)lineStartMs, 99u) % (uint32_t)unitCount);
}

const int kTiltStaggerMs = 50;
const int kTiltStepMs = 120;

// tiltStage: 0 hidden, 1 surfacing (faint, a pixel low), 2 settled.
inline int tiltStage(int index, long sinceLineMs) {
  const long appear = sinceLineMs - (long)index * kTiltStaggerMs;
  if (appear < 0) return 0;
  if (appear < kTiltStepMs * 2) return 1;
  return 2;
}

// tiltLeanOffset: up and down by turns, one pixel settled and two surfacing.
inline int tiltLeanOffset(int leanIndex, int stage) {
  const int sign = leanIndex % 2 == 0 ? -1 : 1;
  return stage == 2 ? sign : sign * 2;
}

// ---- 火花 ------------------------------------------------------------------

const int kSparkCount = 6;
const int kSparkCountLast = 10;

// sparkPixels: one spark's head and tail, in doubles throughout so the browser's
// Math.cos/Math.sin and this cos/sin round to the same pixel; floor(v + 0.5) on
// both sides, never lround, which disagrees with Math.round on negative halves.
inline void sparkPixels(double cx, double cy, double hw, double hh, uint32_t seed, int spark,
                        int count, bool last, double t, int* headX, int* headY, int* tailX,
                        int* tailY) {
  const double a = (double)(lyricHash(seed, (uint32_t)(spark * 2)) & 0xFFFFu) / 65536.0;
  const double b = (double)(lyricHash(seed, (uint32_t)(spark * 2 + 1)) & 0xFFFFu) / 65536.0;
  const double angle = (2.0 * 3.141592653589793 * ((double)spark + 0.7 * a)) / (double)count;
  const double dx = cos(angle);
  const double dy = sin(angle);
  const double edge = hw * 0.7 * fabs(dx) + hh * 0.7 * fabs(dy);
  const double reach = last ? 14.0 : 9.0;
  const double u = t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
  const double out = 1.0 - (1.0 - u) * (1.0 - u) * (1.0 - u);
  const double head = edge + reach * (0.55 + 0.45 * b) * out;
  const double tail = head - 2.0 > edge ? head - 2.0 : edge;
  *headX = (int)floor(cx + dx * head + 0.5);
  *headY = (int)floor(cy + dy * head + 0.5);
  *tailX = (int)floor(cx + dx * tail + 0.5);
  *tailY = (int)floor(cy + dy * tail + 0.5);
}

// sparkTier: a spark cools as it flies.
inline Tier sparkTier(double t) {
  return t < 0.34 ? kTierPrimary : (t < 0.67 ? kTierSecondary : kTierContext);
}
inline Tier dimmerTier(Tier tier) {
  return tier == kTierPrimary ? kTierSecondary
                              : (tier == kTierSecondary ? kTierContext : kTierMuted);
}

}  // namespace lyricrings
}  // namespace tcos

#endif  // VISUAL_LYRICRINGS_H_
