#ifndef VISUAL_PIXELFONT_H_
#define VISUAL_PIXELFONT_H_

#include <stdint.h>
#include "utils/Surface.h"

// Tiny 3x5 ASCII pixel font for on-device status/labels (uppercase, digits,
// a few symbols). CJK lyric frames come pre-rendered from the LAN service; this
// font is only for the splash and device-side UI text.
namespace lyricsvisual {

struct Glyph { char ch; uint8_t rows[5]; };  // each row: low 3 bits = columns

inline const Glyph* glyphFor(char c) {
	// Rows are 3-bit masks (bit2 leftmost). 0b111 = "###".
	static const Glyph kFont[] = {
		{' ', {0,0,0,0,0}},
		{'A', {0b010,0b101,0b111,0b101,0b101}},
		{'B', {0b110,0b101,0b110,0b101,0b110}},
		{'C', {0b011,0b100,0b100,0b100,0b011}},
		{'D', {0b110,0b101,0b101,0b101,0b110}},
		{'E', {0b111,0b100,0b110,0b100,0b111}},
		{'F', {0b111,0b100,0b110,0b100,0b100}},
		{'G', {0b011,0b100,0b101,0b101,0b011}},
		{'H', {0b101,0b101,0b111,0b101,0b101}},
		{'I', {0b111,0b010,0b010,0b010,0b111}},
		{'J', {0b001,0b001,0b001,0b101,0b010}},
		{'K', {0b101,0b110,0b100,0b110,0b101}},
		{'L', {0b100,0b100,0b100,0b100,0b111}},
		{'M', {0b101,0b111,0b111,0b101,0b101}},
		{'N', {0b101,0b111,0b111,0b111,0b101}},
		{'O', {0b010,0b101,0b101,0b101,0b010}},
		{'P', {0b110,0b101,0b110,0b100,0b100}},
		{'Q', {0b010,0b101,0b101,0b110,0b011}},
		{'R', {0b110,0b101,0b110,0b101,0b101}},
		{'S', {0b011,0b100,0b010,0b001,0b110}},
		{'T', {0b111,0b010,0b010,0b010,0b010}},
		{'U', {0b101,0b101,0b101,0b101,0b111}},
		{'V', {0b101,0b101,0b101,0b101,0b010}},
		{'W', {0b101,0b101,0b111,0b111,0b101}},
		{'X', {0b101,0b101,0b010,0b101,0b101}},
		{'Y', {0b101,0b101,0b010,0b010,0b010}},
		{'Z', {0b111,0b001,0b010,0b100,0b111}},
		{'0', {0b111,0b101,0b101,0b101,0b111}},
		{'1', {0b010,0b110,0b010,0b010,0b111}},
		{'2', {0b110,0b001,0b010,0b100,0b111}},
		{'3', {0b110,0b001,0b010,0b001,0b110}},
		{'4', {0b101,0b101,0b111,0b001,0b001}},
		{'5', {0b111,0b100,0b110,0b001,0b110}},
		{'6', {0b011,0b100,0b110,0b101,0b010}},
		{'7', {0b111,0b001,0b010,0b010,0b010}},
		{'8', {0b010,0b101,0b010,0b101,0b010}},
		{'9', {0b010,0b101,0b011,0b001,0b110}},
		{'.', {0b000,0b000,0b000,0b000,0b010}},
		{':', {0b000,0b010,0b000,0b010,0b000}},
		{'-', {0b000,0b000,0b111,0b000,0b000}},
		{'/', {0b001,0b001,0b010,0b100,0b100}},
	};
	if (c >= 'a' && c <= 'z') c = char(c - 'a' + 'A');
	for (const Glyph& g : kFont) if (g.ch == c) return &g;
	return &kFont[0];  // space
}

// Draw a string at (x,y) top-left; returns the x just past the text.
inline int drawText(Surface& s, int x, int y, const char* text, const Color& color) {
	for (const char* p = text; *p; ++p) {
		const Glyph* g = glyphFor(*p);
		for (int row = 0; row < 5; ++row)
			for (int col = 0; col < 3; ++col)
				if (g->rows[row] & (1 << (2 - col))) s.setPixel(x + col, y + row, color);
		x += 4;  // 3px glyph + 1px gap
	}
	return x;
}

inline int textWidth(const char* text) {
	int n = 0; for (const char* p = text; *p; ++p) ++n; return n * 4 - (n ? 1 : 0);
}

}  // namespace lyricsvisual

#endif  // VISUAL_PIXELFONT_H_
