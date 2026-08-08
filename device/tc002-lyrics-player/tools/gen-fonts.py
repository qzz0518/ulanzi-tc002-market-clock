#!/usr/bin/env python3
"""Offline font rasteriser for the TC002 dot-matrix lyrics firmware.

Renders the Fusion Pixel 12px (monospaced SC) pixel font into two C++ headers
that the firmware reads directly, so no TTF/renderer ships on the device:

  * app/src/visual/CjkFont.h  -- full-width 12x12 glyphs. Character set =
      GB2312 level-1 hanzi (the original 3755, reproduced bit-for-bit)
      + Hiragana  U+3041..U+3096
      + Katakana  U+30A1..U+30FC (incl. nakaguro U+30FB, chouonpu U+30FC)
      + JIS X 0208 level-1 kanji (ku 16..47, via euc_jp)
      + common full-width punctuation (, . corner brackets, ! ? ~ ...)
    De-duplicated, strictly ascending by codepoint. Each of the 12 rows is a
    12-bit mask with bit11 = leftmost column (matches LyricsPage.cpp).

  * app/src/visual/LatinFont.h -- half-width 6x12 glyphs for ASCII/Latin
    0x20..0x7E, contiguous for O(1) indexing. Each row uses the low 6 bits
    with bit5 = leftmost column.

Rendering: fontTools decodes the woff2 to a temporary TTF (brotli required),
then Pillow's ImageFont.truetype renders at the font's native 12px design size.
The glyph mask is produced in Pillow's "L" mode and thresholded at >=128, which
is lossless for this grid-aligned pixel font (verified: the 3755 original hanzi
come back bit-identical).

Only gen-fonts.py, CjkFont.h and LatinFont.h are touched; no .cpp is modified.
Usage: python3 gen-fonts.py path/to/fusion-pixel-12px-monospaced-sc.woff2

IMPORTANT: pass the *full* Simplified Chinese build, downloaded from the
upstream release page. The @fontsource npm package publishes the latin subset
only -- feed it in and every hanzi is silently reported as missing from the
cmap, leaving CjkFont.h with nothing but ASCII.

After regenerating, re-run `bun run scripts/gen-web-glyphs.ts` at the repo root
so the web preview's mirror of these tables stays in step; test/pixel-glyphs.
test.ts fails if it drifts.
"""

import os
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR = Path(__file__).resolve().parent
APP_DIR = SCRIPT_DIR.parent            # device/tc002-lyrics-player
REPO_ROOT = APP_DIR.parent.parent      # repo root ("Ulanzi Clock")
VISUAL_DIR = APP_DIR / "app" / "src" / "visual"
CJK_HEADER = VISUAL_DIR / "CjkFont.h"
LATIN_HEADER = VISUAL_DIR / "LatinFont.h"

CELL_H = 12          # all glyphs are 12 rows tall
CJK_W = 12           # full-width cell
LATIN_W = 6          # half-width cell
FONT_PX = 12         # native design size of Fusion Pixel 12px
THRESHOLD = 128      # "L" mask >= THRESHOLD -> pixel on

SAMPLE_CJK = "永国语あアの中"
SAMPLE_LATIN = "Ag5?"


def find_woff2() -> Path:
    """The font path, which the caller must supply.

    No font ships in this repo or in the build: the glyph tables are the
    artifact, so there is nothing to auto-discover. Point this at a full SC
    build (see the note at the top of this file about the latin-only package)."""
    if len(sys.argv) <= 1:
        sys.exit("usage: gen-fonts.py path/to/fusion-pixel-12px-monospaced-sc.woff2\n"
                 "       (must be the full Simplified Chinese build, not a latin subset)")
    p = Path(sys.argv[1]).resolve()
    if not p.exists():
        sys.exit("woff2 not found: %s" % p)
    return p


def woff2_to_ttf(woff2: Path) -> str:
    """Decode the woff2 into a temporary TTF; caller removes it."""
    font = TTFont(str(woff2))          # brotli handles the woff2 payload
    font.flavor = None                 # strip woff2 wrapper -> plain sfnt/ttf
    fd, ttf_path = tempfile.mkstemp(suffix=".ttf", prefix="fusion-pixel-")
    os.close(fd)
    font.save(ttf_path)
    return ttf_path


def build_cjk_charset() -> list:
    """GB2312 L1 hanzi + kana + JIS X0208 L1 kanji, de-duped and sorted."""
    cps = set()

    # GB2312 level-1 hanzi (qu 16..55 -> euc-cn 0xB0A1..0xD7FE); this reproduces
    # the original 3755 set exactly, so no Chinese glyph is ever dropped.
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            if ord(ch) >= 0x4E00:
                cps.add(ord(ch))

    # Hiragana U+3041..U+3096, Katakana U+30A1..U+30FC (inclusive). The extended
    # katakana end pulls in U+30FB nakaguro and U+30FC chouonpu (long-vowel mark),
    # both extremely common in Japanese lyric text.
    cps.update(range(0x3041, 0x3096 + 1))
    cps.update(range(0x30A1, 0x30FC + 1))

    # Common full-width CJK/Japanese punctuation seen in lyric text.
    cps.update({
        0x3001,  # 、 ideographic comma
        0x3002,  # 。 ideographic full stop
        0x300C,  # 「 left corner bracket
        0x300D,  # 」 right corner bracket
        0xFF01,  # ！ fullwidth exclamation mark
        0xFF1F,  # ？ fullwidth question mark
        0xFF5E,  # ～ fullwidth tilde
        0x2026,  # … horizontal ellipsis
    })

    # JIS X 0208 level-1 kanji: ku 16..47 -> euc_jp (0xA0+ku, 0xA0+ten).
    for ku in range(16, 48):
        for ten in range(1, 95):
            try:
                ch = bytes([0xA0 + ku, 0xA0 + ten]).decode("euc_jp")
            except UnicodeDecodeError:
                continue
            cp = ord(ch)
            if 0x3400 <= cp <= 0x9FFF:   # keep CJK ideographs only
                cps.add(cp)

    return sorted(cps)


def render_rows(font, cp, width):
    """Render one glyph into a width x 12 cell; return list of 12 row masks.

    bit(width-1) = leftmost column (bit11 for CJK, bit5 for Latin)."""
    img = Image.new("L", (width, CELL_H), 0)
    draw = ImageDraw.Draw(img)
    draw.text((0, 0), chr(cp), fill=255, font=font)   # anchor 'la': x=left, y=ascender top
    px = img.load()
    rows = []
    for y in range(CELL_H):
        mask = 0
        for x in range(width):
            if px[x, y] >= THRESHOLD:
                mask |= 1 << (width - 1 - x)
        rows.append(mask)
    return rows


def ascii_art(rows, width):
    out = []
    for r in rows:
        out.append("".join("#" if (r >> (width - 1 - x)) & 1 else "." for x in range(width)))
    return out


# ---- Preserved verbatim from the original CjkFont.h (do NOT alter) ----------
CJK_TAIL = """};
static const int kCjkGlyphCount = %d;

inline const CjkGlyph* cjkGlyph(uint32_t cp) {
\tint lo = 0, hi = kCjkGlyphCount - 1;
\twhile (lo <= hi) {
\t\tint mid = (lo + hi) >> 1;
\t\tuint32_t v = kCjkGlyphs[mid].cp;
\t\tif (v == cp) return &kCjkGlyphs[mid];
\t\tif (v < cp) lo = mid + 1; else hi = mid - 1;
\t}
\treturn 0;
}
inline uint32_t utf8Next(const char*& p) {
\tconst unsigned char c = (unsigned char)*p;
\tif (c < 0x80) { ++p; return c; }
\tif ((c >> 5) == 0x6) { uint32_t cp=((c&0x1f)<<6)|(p[1]&0x3f); p+=2; return cp; }
\tif ((c >> 4) == 0xe) { uint32_t cp=((c&0x0f)<<12)|((p[1]&0x3f)<<6)|(p[2]&0x3f); p+=3; return cp; }
\tif ((c >> 3) == 0x1e){ uint32_t cp=((c&0x07)<<18)|((p[1]&0x3f)<<12)|((p[2]&0x3f)<<6)|(p[3]&0x3f); p+=4; return cp; }
\t++p; return c;
}
}  // namespace lyricsvisual
#endif
"""


def fmt_row_list(rows):
    return ",".join("0x%03x" % r for r in rows)


def emit_cjk(font, cps, cmap):
    lines = [
        "#ifndef VISUAL_CJKFONT_H_",
        "#define VISUAL_CJKFONT_H_",
        "#include <stdint.h>",
        "// Auto-generated 12x12 CJK glyphs (Fusion Pixel 12px): GB2312 level-1",
        "// hanzi + Hiragana + Katakana + JIS X 0208 level-1 kanji + common",
        "// full-width punctuation, sorted by codepoint. Each row is a 12-bit",
        "// mask, bit11 = leftmost column.",
        "// Generated by tools/gen-fonts.py -- do not edit by hand.",
        "namespace lyricsvisual {",
        "struct CjkGlyph { uint32_t cp; uint16_t rows[12]; };",
        "static const CjkGlyph kCjkGlyphs[] = {",
    ]
    # A subsetted font reports nearly every hanzi as absent. Rather than write a
    # header that is quietly missing its entire charset, refuse the run.
    missing = [cp for cp in cps if cp not in cmap]
    if len(missing) > len(cps) // 100:
        sys.exit("font covers only %d of %d requested codepoints -- this looks like a\n"
                 "subset build. Use the full Simplified Chinese font; %s was not written."
                 % (len(cps) - len(missing), len(cps), CJK_HEADER.name))

    emitted = 0
    skipped = []
    for cp in cps:
        if cp not in cmap:
            skipped.append(cp)
            continue
        rows = render_rows(font, cp, CJK_W)
        lines.append("  {0x%04X,{%s}}," % (cp, fmt_row_list(rows)))
        emitted += 1
    lines.append(CJK_TAIL % emitted)
    CJK_HEADER.write_text("\n".join(lines[:-1]) + "\n" + lines[-1], encoding="utf-8")
    return emitted, skipped


def emit_latin(font):
    lines = [
        "#ifndef VISUAL_LATINFONT_H_",
        "#define VISUAL_LATINFONT_H_",
        "#include <stdint.h>",
        "// Auto-generated 6x12 half-width Latin glyphs (Fusion Pixel 12px) for",
        "// ASCII 0x20..0x7E, contiguous. Each row uses the low 6 bits,",
        "// bit5 = leftmost column. Generated by tools/gen-fonts.py.",
        "namespace lyricsvisual {",
        "struct LatinGlyph { uint32_t cp; uint16_t rows[12]; };",
        "static const LatinGlyph kLatinGlyphs[] = {",
    ]
    lo, hi = 0x20, 0x7E
    for cp in range(lo, hi + 1):
        rows = render_rows(font, cp, LATIN_W)
        lines.append("  {0x%04X,{%s}}," % (cp, fmt_row_list(rows)))
    lines.append("};")
    lines.append("static const int kLatinGlyphCount = %d;" % (hi - lo + 1))
    lines.append("")
    lines.append("// ASCII 0x20..0x7E is contiguous, so index directly.")
    lines.append("inline const LatinGlyph* latinGlyph(uint32_t cp) {")
    lines.append("\tif (cp < 0x%02X || cp > 0x%02X) return 0;" % (lo, hi))
    lines.append("\treturn &kLatinGlyphs[cp - 0x%02X];" % lo)
    lines.append("}")
    lines.append("}  // namespace lyricsvisual")
    lines.append("#endif")
    LATIN_HEADER.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return hi - lo + 1


def main():
    woff2 = find_woff2()
    print("[*] font source : %s" % woff2)
    ttf_path = woff2_to_ttf(woff2)
    try:
        ttfont = TTFont(ttf_path)
        cmap = set(ttfont.getBestCmap().keys())
        font = ImageFont.truetype(ttf_path, FONT_PX)
        asc, desc = font.getmetrics()
        print("[*] native size : %dpx (ascent=%d descent=%d), cmap=%d glyphs"
              % (FONT_PX, asc, desc, len(cmap)))

        # ---- self-check: sample ASCII art before committing to full run -----
        print("\n=== self-check: CJK 12x12 ===")
        for ch in SAMPLE_CJK:
            print("--- '%s' U+%04X ---" % (ch, ord(ch)))
            for ln in ascii_art(render_rows(font, ord(ch), CJK_W), CJK_W):
                print("  " + ln)
        print("\n=== self-check: Latin 6x12 ===")
        for ch in SAMPLE_LATIN:
            print("--- '%s' U+%04X ---" % (ch, ord(ch)))
            for ln in ascii_art(render_rows(font, ord(ch), LATIN_W), LATIN_W):
                print("  " + ln)

        # ---- full generation ------------------------------------------------
        cps = build_cjk_charset()
        assert cps == sorted(set(cps)), "charset must be strictly ascending/unique"
        n_cjk, skipped = emit_cjk(font, cps, cmap)
        n_latin = emit_latin(font)

        print("\n=== output ===")
        print("[*] CjkFont.h   : %d glyphs, %d bytes"
              % (n_cjk, CJK_HEADER.stat().st_size))
        print("[*] LatinFont.h : %d glyphs, %d bytes"
              % (n_latin, LATIN_HEADER.stat().st_size))
        if skipped:
            print("[!] skipped %d cps missing from font cmap: %s"
                  % (len(skipped), [hex(c) for c in skipped[:20]]))
        else:
            print("[*] every requested codepoint was present in the font cmap")
    finally:
        os.remove(ttf_path)


if __name__ == "__main__":
    main()
