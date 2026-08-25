#!/usr/bin/env python3
"""Fails when a firmware string uses a codepoint the font tables do not have.

A missing codepoint does not fall back to a box or a space. `glyphs::lookup`
returns `rows == 0` and the renderer draws nothing, so the character is simply
absent from the label — which on a 52 px row reads as a layout bug rather than a
font one, and is why the fullwidth comma was missing from the CJK table for the
whole life of this firmware without anyone noticing. The table was generated
from song lyrics, and lyrics do not use 「，」.

selfcheck.cpp has an in-binary coverage check, but it only walks the eight
夜间息屏 strings it was written for. This one is source-level and covers the
whole tree — including logic/osLogic.cc, which is `#include`d by activity/*.cpp
and therefore compiled by no host check at all.

Run from the repo root; `mise run os-hostcheck` does that.
"""
import pathlib
import re
import sys

TABLES = pathlib.Path("device/shared-visual")
TEXT_CPP = pathlib.Path("device/tc002-os/app/src/core/Text.cpp")
SOURCES = pathlib.Path("device/tc002-os/app/src")
SUFFIXES = (".h", ".cc", ".cpp")

# One C/C++ string literal, with escapes kept so the decoder below can see them.
LITERAL = re.compile(r'"((?:[^"\\\n]|\\.)*)"')
ENTRY = re.compile(r"\{0x([0-9A-Fa-f]+),\{")
FOLD = re.compile(r"\{\s*0x([0-9A-Fa-f]+)\s*,\s*'(\\?.)'\s*\}")


def covered_codepoints() -> set[int]:
    have: set[int] = set()
    for name in ("CjkFont.h", "LatinFont.h"):
        have |= {int(m, 16) for m in ENTRY.findall(TABLES.joinpath(name).read_text("utf-8"))}
    # The Latin table is indexed by ASCII offset rather than keyed by codepoint,
    # so its entries do not show up above as 0x20..0x7E.
    have |= set(range(0x20, 0x7F))
    return have


def punctuation_folds() -> dict[int, int]:
    """text::foldPunctuation, read out of the source it is defined in.

    Fullwidth punctuation is folded onto ASCII before any glyph lookup, so a
    codepoint that folds is covered even though the table has no entry for it.
    Reading the real table keeps this guard from disagreeing with the firmware.
    """
    source = TEXT_CPP.read_text("utf-8")
    block = re.search(r"const PunctuationFold kPunctuationFolds\[\] = \{([\s\S]*?)\};", source)
    if block is None:
        print("FAIL could not find kPunctuationFolds in %s" % TEXT_CPP, file=sys.stderr)
        sys.exit(1)
    folds: dict[int, int] = {}
    for entry in FOLD.finditer(block.group(1)):
        folds[int(entry.group(1), 16)] = ord(entry.group(2).lstrip("\\"))
    return folds


def literal_text(literal: str) -> str:
    """The bytes a C++ literal actually puts in the binary, decoded as UTF-8.

    Panel strings in this tree are written as \\x escapes rather than as raw
    characters, because the sources are compiled by a toolchain whose source
    charset is not worth arguing with. So the escapes are what has to be read.
    """
    raw = bytearray()
    i = 0
    while i < len(literal):
        if literal[i] != "\\":
            raw += literal[i].encode("utf-8")
            i += 1
        elif i + 1 < len(literal) and literal[i + 1] == "x":
            hex_digits = ""
            j = i + 2
            while j < len(literal) and len(hex_digits) < 2 and literal[j] in "0123456789abcdefABCDEF":
                hex_digits += literal[j]
                j += 1
            if hex_digits:
                raw += bytes([int(hex_digits, 16)])
            i = j
        else:
            # Any other escape (\n, \", \\ …) is ASCII and cannot introduce a
            # codepoint that needs a glyph.
            i += 2
    return raw.decode("utf-8", "ignore")


def main() -> int:
    have = covered_codepoints()
    folds = punctuation_folds()
    missing: dict[int, str] = {}
    for path in sorted(SOURCES.rglob("*")):
        if path.suffix not in SUFFIXES:
            continue
        # errors="replace": several files inherited from the FlyThings SDK
        # (managers/KeyManager.*, uart/*) carry truncated multi-byte sequences in
        # their Chinese COMMENTS — vendor files, mangled before we ever saw them.
        # Refusing to read them would take the whole guard down over bytes that
        # can never reach the panel, so they decode to U+FFFD and are skipped
        # below with the rest of the replacement characters.
        for literal in LITERAL.findall(path.read_text("utf-8", errors="replace")):
            for character in literal_text(literal):
                codepoint = folds.get(ord(character), ord(character))
                if codepoint == 0xFFFD:
                    continue
                if codepoint >= 0x80 and codepoint not in have:
                    missing.setdefault(codepoint, str(path))
    for codepoint, where in sorted(missing.items()):
        print(
            "FAIL U+%04X %r has no glyph, first seen in %s" % (codepoint, chr(codepoint), where),
            file=sys.stderr,
        )
    if missing:
        print(
            "FAIL %d codepoint(s) on the panel have no glyph. Fold it onto ASCII in "
            "text::foldPunctuation (and PUNCTUATION_FALLBACK next to it), which is "
            "narrower on a 52 px row, or add it to gen-fonts.py and regenerate."
            % len(missing),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
