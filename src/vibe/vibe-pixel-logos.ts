/**
 * Reusable 16x16 provider marks.
 *
 * These are deliberately pixel art rather than small rasterisations. Every
 * character is one physical LED/pixel and every non-transparent cell is an
 * opaque colour; consumers must use nearest-neighbour scaling.
 *
 * `.` is transparent. The other characters are local to each mark's palette.
 */

export const VIBE_PIXEL_LOGO_IDS = ["claude", "codex", "opencode", "grok"] as const;

export type VibePixelLogoId = (typeof VIBE_PIXEL_LOGO_IDS)[number];
export type PixelLogoRgba = readonly [red: number, green: number, blue: number, alpha: number];

export interface VibePixelLogo {
  readonly displayName: string;
  readonly palette: Readonly<Record<string, PixelLogoRgba>>;
  readonly rows: readonly string[];
}

const NEUTRAL_PALETTE = {
  x: [247, 247, 245, 255],
  "+": [174, 177, 174, 255],
  "*": [88, 92, 90, 255],
} as const satisfies Readonly<Record<string, PixelLogoRgba>>;

export const VIBE_PIXEL_LOGOS = {
  // The user's supplied pixel-creature reference, redrawn on a centred 16x16
  // grid. Its two eyes and four feet survive where Claude's fine sunburst does
  // not, while #E7753D is sampled from that reference image.
  claude: {
    displayName: "Claude",
    palette: { x: [231, 117, 61, 255] },
    rows: [
      "................",
      "................",
      "................",
      "...xxxxxxxxxx...",
      "...xxxxxxxxxx...",
      "..xx.xxxxxx.xx..",
      "..xxxxxxxxxxxx..",
      "...xxxxxxxxxx...",
      "...xxxxxxxxxx...",
      "...xxxxxxxxxx...",
      "...xx.x..x.xx...",
      "...xx.x..x.xx...",
      "...xx.x..x.xx...",
      "................",
      "................",
      "................",
    ],
  },

  // The terminal-prompt mark: a rounded blue-violet blob with `>` and `_`
  // knocked out of it. Two blues on a diagonal split rather than one flat fill —
  // the source is a top-left-to-bottom-right gradient, and a single horizontal
  // band read as two stacked colours instead of one lit shape. The white is the
  // glyph, not a highlight, so it keeps the third palette slot.
  codex: {
    displayName: "Codex",
    palette: {
      a: [124, 131, 246, 255],
      b: [45, 86, 232, 255],
      w: [255, 255, 255, 255],
    },
    rows: [
      ".....aaaaaa.....",
      "...aaaaaaaaaa...",
      "..aaaaaaaaaaaa..",
      ".aaaaaaaaaaaaaa.",
      ".aawwaaaaaaaaaa.",
      "aaaaawwaaaaaaaab",
      "aaaaaaawwaaabbbb",
      "aaaaawwaabbbbbbb",
      "aaawwabbbbbbbbbb",
      "aaabbbbbbbbbbbbb",
      ".bbbbbbbwwwwwbb.",
      ".bbbbbbbbbbbbbb.",
      "..bbbbbbbbbbbb..",
      "...bbbbbbbbbb...",
      ".....bbbbbb.....",
      "................",
    ],
  },

  // OpenCode's mark is mostly proportion: a tall hollow frame. Keeping that
  // silhouette is more recognisable than introducing detail it never had.
  //
  // Pulled in a ring and thinned from a 3 px border to 2 px. At the full 12x14
  // it out-weighed the other three badly — a solid slab beside Claude's little
  // creature and Grok's open loop — and on a 52x16 panel the heaviest mark wins
  // attention it has not earned. The proportion it is recognised by survives.
  opencode: {
    displayName: "OpenCode",
    palette: { x: NEUTRAL_PALETTE.x },
    rows: [
      "................",
      "................",
      "...xxxxxxxxxx...",
      "...xxxxxxxxxx...",
      "...xx......xx...",
      "...xx......xx...",
      "...xx......xx...",
      "...xx......xx...",
      "...xx......xx...",
      "...xx......xx...",
      "...xx......xx...",
      "...xx......xx...",
      "...xxxxxxxxxx...",
      "...xxxxxxxxxx...",
      "................",
      "................",
    ],
  },

  // The long corner-to-corner stroke is the recognition anchor; the broken
  // loop remains secondary and uses the two softer levels at its curved edge.
  grok: {
    displayName: "Grok",
    palette: NEUTRAL_PALETTE,
    rows: [
      "................",
      "..............**",
      ".....*++++*..*+.",
      "....*xxxxxx**x..",
      "...*xx*....*xx..",
      "...xx.....*xxx..",
      "..*x*....*x*xx..",
      "..+x....*+..+x..",
      "..+x...*+...+x..",
      "..+x*..*....xx..",
      "..*x+......*x+..",
      "...x+.....*xx...",
      "..++.+x++xxx*...",
      ".**..*+xxx+.....",
      ".*..............",
      "................",
    ],
  },
} as const satisfies Record<VibePixelLogoId, VibePixelLogo>;

