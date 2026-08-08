#ifndef VISUAL_ICONS_H_
#define VISUAL_ICONS_H_

#include <stdint.h>
#include "utils/Surface.h"

namespace lyricsvisual {

// A 6x8 eighth-note: filled head bottom-left, stem and flag top-right.
inline void drawNote(Surface& s, int x, int y, const Color& color) {
	static const uint8_t kNote[8] = {
		0b000011, 0b000111, 0b000101, 0b000100,
		0b000100, 0b011100, 0b111100, 0b011000,
	};
	for (int row = 0; row < 8; ++row)
		for (int col = 0; col < 6; ++col)
			if (kNote[row] & (1 << (5 - col))) s.setPixel(x + col, y + row, color);
}

}  // namespace lyricsvisual

#endif  // VISUAL_ICONS_H_
