#ifndef VISUAL_LYRICVISUALS_H_
#define VISUAL_LYRICVISUALS_H_

// The lyric renderer's numeric model, INCLUDED FROM THE LYRICS PLAYER RATHER
// THAN COPIED INTO THIS TREE.
//
// ui/MusicScreen renders the four 显示形式 and four 像素配色 the console's
// 主题设置 panel offers, and the requirement is not "similar to the sideloaded
// lyrics player" but pixel-identical to it: the user picks a theme by looking at
// the web preview, then looks at the panel, and the same three implementations
// (web preview, lyrics-player firmware, this firmware) have to tell one story.
// A second copy of these constants would be equal on the day it was made and
// silently unequal after the first tweak to any one of them — which is exactly
// how the screen this replaces ended up with its own hash-driven equaliser.
//
// Both headers are header-only inline code plus a 48-byte palette table, so
// including them costs nothing on a device with ~1 MB free; this is not the
// situation visual/Glyphs.cpp guards against (~145 KB of .rodata per includer).
//
// The path resolves because device/ is on the include path of all three
// firmwares: `-I device` in mise.toml's os-hostcheck, `-I$(SHARED)` (SHARED =
// device/) in flythings-build/Makefile. It is the same door shared-visual/
// CjkFont.h comes through.
//
// Palette.h's own `#include "utils/Surface.h"` lands on this firmware's bridge
// header (utils/Surface.h -> core/Surface.h), the one already there for the
// arcade game engines, so no adapter is needed: both trees' Color is
// {byte r, g, b} with the same 3-argument constructor.
#include "tc002-lyrics-player/app/src/visual/LyricModes.h"
#include "tc002-lyrics-player/app/src/visual/Palette.h"

#endif  // VISUAL_LYRICVISUALS_H_
