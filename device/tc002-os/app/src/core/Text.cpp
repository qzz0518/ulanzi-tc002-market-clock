#include "core/Text.h"

#include "core/Ease.h"
#include "visual/Glyphs.h"

namespace tcos {
namespace text {

namespace {

const uint32_t kReplacement = 0xFFFD;

int continuationBytes(unsigned char lead) {
  if ((lead & 0x80) == 0x00) return 0;
  if ((lead & 0xE0) == 0xC0) return 1;
  if ((lead & 0xF0) == 0xE0) return 2;
  if ((lead & 0xF8) == 0xF0) return 3;
  return -1;  // a stray continuation byte or an invalid lead
}

}  // namespace

uint32_t utf8Next(const char*& p) {
  const unsigned char lead = static_cast<unsigned char>(*p);
  if (lead == 0) return 0;

  const int extra = continuationBytes(lead);
  if (extra < 0) {
    // Malformed: consume exactly one byte. Consuming zero would hang the caller.
    ++p;
    return kReplacement;
  }

  uint32_t cp;
  if (extra == 0) {
    cp = lead;
  } else if (extra == 1) {
    cp = lead & 0x1F;
  } else if (extra == 2) {
    cp = lead & 0x0F;
  } else {
    cp = lead & 0x07;
  }

  for (int i = 1; i <= extra; ++i) {
    const unsigned char b = static_cast<unsigned char>(p[i]);
    if ((b & 0xC0) != 0x80) {
      // Truncated sequence: consume what we have seen and report a replacement.
      p += i;
      return kReplacement;
    }
    cp = (cp << 6) | (b & 0x3F);
  }
  p += extra + 1;
  return cp;
}

int countCells(const char* utf8) {
  if (utf8 == 0) return 0;
  int n = 0;
  const char* p = utf8;
  while (*p) {
    utf8Next(p);
    ++n;
  }
  return n;
}

int measure(const char* utf8) {
  if (utf8 == 0) return 0;
  int width = 0;
  const char* p = utf8;
  while (*p) {
    width += glyphs::cellWidth(utf8Next(p));
  }
  return width;
}

int prefixBytesThatFit(const char* utf8, int maxPx) {
  if (utf8 == 0 || maxPx <= 0) return 0;
  int width = 0;
  const char* p = utf8;
  const char* lastFit = utf8;
  while (*p) {
    const char* cellStart = p;
    const int w = glyphs::cellWidth(utf8Next(p));
    if (width + w > maxPx) return static_cast<int>(lastFit - utf8);
    width += w;
    lastFit = p;
    (void)cellStart;
  }
  return static_cast<int>(lastFit - utf8);
}

void draw(Surface& out, const char* utf8, int x, int y, const Color& color,
          int clipX, int clipW) {
  if (utf8 == 0 || clipW <= 0) return;

  const int clipRight = clipX + clipW;
  const int surfaceW = out.getWidth();
  const int surfaceH = out.getHeight();

  int penX = x;
  const char* p = utf8;
  while (*p) {
    const uint32_t cp = utf8Next(p);
    const glyphs::Bitmap bitmap = glyphs::lookup(cp);
    const int advance = bitmap.width;

    // Cheap reject: whole cell outside the window. Text is often scrolled far
    // off one side, so skipping the inner loops matters more than it looks.
    if (penX + advance <= clipX || penX >= clipRight) {
      penX += advance;
      continue;
    }
    if (bitmap.rows == 0) {
      penX += advance;  // unmapped codepoint: leave a gap, keep the rhythm
      continue;
    }

    for (int row = 0; row < glyphs::kCellHeight; ++row) {
      const int py = y + row;
      if (py < 0 || py >= surfaceH) continue;
      const uint16_t mask = bitmap.rows[row];
      if (mask == 0) continue;
      for (int col = 0; col < advance; ++col) {
        if ((mask & (1 << (advance - 1 - col))) == 0) continue;
        const int px = penX + col;
        if (px < clipX || px >= clipRight || px < 0 || px >= surfaceW) continue;
        out.setPixel(px, py, color);
      }
    }
    penX += advance;
  }
}

void drawCentered(Surface& out, const char* utf8, int y, const Color& color,
                  int clipX, int clipW) {
  const int width = measure(utf8);
  const int x = clipX + (clipW - width) / 2;
  draw(out, utf8, x, y, color, clipX, clipW);
}

int marqueeOffset(int widthPx, int viewW, int elapsedMs) {
  const int travel = widthPx - viewW;
  if (travel <= 0) return 0;
  if (elapsedMs < 0) elapsedMs = 0;

  const int legMs = (travel * 1000) / kMarqueePxPerSecond;
  if (legMs <= 0) return 0;
  const int cycleMs = kMarqueeDwellMs + legMs + kMarqueeDwellMs + legMs;
  const int t = elapsedMs % cycleMs;

  if (t < kMarqueeDwellMs) return 0;  // dwell, showing the head

  if (t < kMarqueeDwellMs + legMs) {
    const float p = ease::inOutQuad(ease::progress(t, kMarqueeDwellMs, legMs));
    return -static_cast<int>(p * travel + 0.5f);
  }

  if (t < kMarqueeDwellMs + legMs + kMarqueeDwellMs) return -travel;  // dwell, tail

  const float p = ease::inOutQuad(
      ease::progress(t, kMarqueeDwellMs + legMs + kMarqueeDwellMs, legMs));
  return -static_cast<int>((1.0f - p) * travel + 0.5f);
}

}  // namespace text
}  // namespace tcos
