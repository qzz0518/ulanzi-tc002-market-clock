import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  PixelCanvas,
  type Rgb,
} from "../pixel-ui.ts";
import { cjkTextWidth } from "../pixel-cjk.ts";
import {
  GLYPH_HEIGHT,
  glyphCellWidth,
  glyphRows,
} from "../../web/src/lib/pixel-glyphs.ts";
import type { VisualAnimation } from "../visual-effects.ts";

/**
 * 灯牌 — an acrylic-lightbox shop sign: the whole panel is one saturated
 * colour field, the message is BLACK type punched out of it.
 *
 * The panel is emissive, so this inverts the usual contrast logic: the type is
 * the UNLIT pixels and the field carries every lumen. Two consequences drive
 * the constants here. First, ink colour is not a knob — (0,0,0) means "LED
 * off", which is the deepest black this hardware can produce and the whole
 * point of the lightbox look; a lit "black" would just be a dimmer field.
 * Second, the field colours stay well below channel-255 white: with ~700 of
 * 832 LEDs lit, full-brightness neighbours bloom into the 1px dark strokes of
 * a 12px hanzi and fill in its counters. Saturated mid-value fields keep the
 * dark strokes crisp and the room-light output civilised.
 */

export const SIGN_PALETTE_IDS = [
  "green",
  "red",
  "amber",
  "blue",
  "purple",
  "warmwhite",
] as const;

export type SignPaletteId = (typeof SIGN_PALETTE_IDS)[number];

export interface SignPalette {
  /** Simplified-Chinese choice label for the marketplace option field. */
  label: string;
  field: Rgb;
}

export const SIGN_PALETTES: Readonly<Record<SignPaletteId, SignPalette>> = {
  // #24C13A — matched to the classic acrylic 营业中 lightbox green.
  green: { label: "营业绿", field: [36, 193, 58] },
  red: { label: "休息红", field: [224, 49, 49] },
  amber: { label: "勿扰琥珀", field: [240, 163, 29] },
  blue: { label: "摸鱼蓝", field: [28, 160, 232] },
  purple: { label: "会议紫", field: [156, 64, 224] },
  // Warm and capped below true white so the brightest preset still reads as a
  // lightbox rather than an 832-LED torch.
  warmwhite: { label: "暖白", field: [232, 220, 190] },
};

export const SIGN_DEFAULT_TEXT = "被迫/营业中";
export const SIGN_MAX_TEXT_LENGTH = 32;

/** Type is switched-off LEDs; see the module comment for why this is fixed. */
const SIGN_INK: Rgb = [0, 0, 0];

// Page separators: ASCII slash plus its full-width sibling, because a CJK
// input method produces ／ and the user should not have to notice.
const PAGE_SEPARATOR = /[/／]/;

// Zero-width joiners and variation selectors ride along with emoji input and
// would each render as a full-width tofu box; strip them before layout.
const INVISIBLES = /[\u200b-\u200d\u2060\ufe0e\ufe0f]/g;

function sanitizeSignText(raw: string): string {
  const cleaned = raw.replace(INVISIBLES, "").trim();
  return [...cleaned].slice(0, SIGN_MAX_TEXT_LENGTH).join("");
}

/**
 * Split one over-wide run at the character boundary that best balances the
 * two halves, preferring the SHORTER left half on a tie. Measured fact that
 * forces this: every CJK glyph in the font inks 11 of its 12 columns, so
 * tight kerning recovers only 1px per glyph — five hanzi are ≥55px however
 * packed, and 52px simply cannot hold them. Paging is what real LED shop
 * signs do instead of scrolling, and the shorter-first tie keeps Chinese
 * modifier-first phrasing intact: 被迫/营业中, 努力/搬砖中.
 */
function fitPage(page: string): string[] {
  const trimmed = page.trim();
  if (trimmed.length === 0) return [];
  if (cjkTextWidth(trimmed) <= DISPLAY_WIDTH) return [trimmed];
  const characters = [...trimmed];
  let best = 1;
  let bestDifference = Number.POSITIVE_INFINITY;
  for (let index = 1; index < characters.length; index += 1) {
    const left = cjkTextWidth(characters.slice(0, index).join(""));
    const right = cjkTextWidth(characters.slice(index).join(""));
    const difference = Math.abs(left - right);
    // Strict < keeps the earliest (smallest-left) index on equal difference.
    if (difference < bestDifference) {
      bestDifference = difference;
      best = index;
    }
  }
  return [
    ...fitPage(characters.slice(0, best).join("")),
    ...fitPage(characters.slice(best).join("")),
  ];
}

/**
 * The sign's pages: explicit `/` breaks first, then any page still wider than
 * the panel is balance-split until everything fits. Empty input falls back to
 * the canonical phrase rather than a blank lightbox.
 */
export function paginateSignText(text: string): string[] {
  const pages = sanitizeSignText(text)
    .split(PAGE_SEPARATOR)
    .flatMap((page) => fitPage(page));
  if (pages.length > 0) return pages;
  return paginateSignText(SIGN_DEFAULT_TEXT);
}

function drawSignPage(canvas: PixelCanvas, page: string, ink: Rgb): void {
  let x = Math.floor((DISPLAY_WIDTH - cjkTextWidth(page)) / 2);
  const y = Math.floor((DISPLAY_HEIGHT - GLYPH_HEIGHT) / 2);
  for (const character of page) {
    const codepoint = character.codePointAt(0)!;
    const cellWidth = glyphCellWidth(codepoint);
    const rows = glyphRows(codepoint);
    if (rows) {
      for (let row = 0; row < rows.length; row += 1) {
        const mask = rows[row]!;
        for (let column = 0; column < cellWidth; column += 1) {
          if ((mask >> (cellWidth - 1 - column)) & 1) {
            canvas.setPixel(x + column, y + row, ink);
          }
        }
      }
    } else {
      // Outside the 5195-glyph charset (e.g. traditional 營). The firmware
      // skips such characters, but a silent hole in the middle of someone's
      // sign hides the problem — draw typographic tofu so the gap explains
      // itself. Box edges sit inside the glyph ink area (columns 0-10) so
      // neighbours keep their usual 1px separation.
      const left = x + 1;
      const right = x + cellWidth - 3;
      const top = y + 1;
      const bottom = y + GLYPH_HEIGHT - 2;
      for (let column = left; column <= right; column += 1) {
        canvas.setPixel(column, top, ink);
        canvas.setPixel(column, bottom, ink);
      }
      for (let row = top; row <= bottom; row += 1) {
        canvas.setPixel(left, row, ink);
        canvas.setPixel(right, row, ink);
      }
    }
    x += cellWidth;
  }
}

function signPalette(paletteId: string | undefined): SignPalette {
  return paletteId && paletteId in SIGN_PALETTES
    ? SIGN_PALETTES[paletteId as SignPaletteId]
    : SIGN_PALETTES.green;
}

/**
 * A sign that fits is one static frame; a sign that pages holds each page for
 * an equal share of the duration — no scroll, no transition, because a sign
 * that moves stops being a sign. Delays sum to exactly `durationMs` so the
 * scheduler contract matches every other renderer.
 */
export function renderSign(
  durationMs: number,
  text?: string,
  paletteId?: string,
): VisualAnimation {
  const palette = signPalette(paletteId);
  const pages = paginateSignText(text ?? "");
  const base = Math.floor(durationMs / pages.length);
  const delays = pages.map((_, index) =>
    index === pages.length - 1 ? durationMs - base * (pages.length - 1) : base
  );
  const frames = pages.map((page) => {
    const canvas = new PixelCanvas(DISPLAY_WIDTH, DISPLAY_HEIGHT, palette.field);
    drawSignPage(canvas, page, SIGN_INK);
    return canvas;
  });
  return { frames, frameDelaysMs: delays, label: `灯牌 · ${pages.join("/")}` };
}
