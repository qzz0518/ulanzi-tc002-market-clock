#ifndef VISUAL_PALETTE_H_
#define VISUAL_PALETTE_H_

#include "utils/Surface.h"

// Lit-pixel tiers for the 52x16 LED matrix. Background is always black (LED
// off). Mirrors the web preview's skins so device and web read as one system.
namespace lyricsvisual {

struct Palette {
	Color primary;    // the bright, sung/accent pixels
	Color secondary;  // mid tier
	Color context;    // dim tier (already-sung / trailing)
	Color muted;      // faint anchors / idle spectrum floor
};

enum SkinId {
	SKIN_SIGNAL = 0,  // 信号绿
	SKIN_TAPE,        // 磁带橙
	SKIN_BLUEPRINT,   // 蓝晒
	SKIN_ARCADE,      // 街机红
	SKIN_COUNT
};

inline const Palette& paletteFor(int skin) {
	static const Palette kPalettes[SKIN_COUNT] = {
		// signal green
		{ Color(0xC1, 0xFF, 0x3D), Color(0x6C, 0xA3, 0x4E), Color(0x47, 0x73, 0x3D), Color(0x28, 0x4B, 0x2C) },
		// tape orange
		{ Color(0xFF, 0xB3, 0x41), Color(0xF0, 0x78, 0x2A), Color(0xA7, 0x55, 0x22), Color(0x73, 0x40, 0x1E) },
		// blueprint cyan
		{ Color(0xD6, 0xF4, 0xFF), Color(0x55, 0xB7, 0xE8), Color(0x34, 0x7B, 0xA8), Color(0x1E, 0x52, 0x7A) },
		// arcade red
		{ Color(0xFF, 0xF0, 0xCF), Color(0xFF, 0x4C, 0x58), Color(0xB3, 0x3A, 0x43), Color(0x7B, 0x29, 0x30) },
	};
	if (skin < 0 || skin >= SKIN_COUNT) skin = SKIN_SIGNAL;
	return kPalettes[skin];
}

// Scale a lit color toward black by a 0..255 intensity (for fades / dimming).
inline Color scaled(const Color& c, int intensity) {
	if (intensity < 0) intensity = 0;
	if (intensity > 255) intensity = 255;
	return Color((c.r * intensity) / 255, (c.g * intensity) / 255, (c.b * intensity) / 255);
}

}  // namespace lyricsvisual

#endif  // VISUAL_PALETTE_H_
