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

  // The terminal-prompt mark: the app icon's cloud — a fat, near-circular mass
  // with six soft round lobes — carrying a white `>` and `_`.
  //
  // MEASURED, then exaggerated on purpose. Analysing the reference PNG showed
  // the lobes are exactly six, 60° apart, with a peak at the top slightly left
  // of centre (345° clockwise from top) and notches only 13.5% of the radius
  // deep. At a 7.5 px radius that is ~1 px, so the reference's own 16x16
  // downsample is a plain circle: the lobes average away. Every earlier version
  // failed on one side of that fact — deep notches read as a gear, faithful
  // ones read as a disc — so this one starts from that natural circle and cuts
  // exactly four 1 px seams at the measured notch angles (15°/195° single-pixel
  // nicks at row 1 and row 14; 75°/255° two-row bites on the flanks) and lets
  // the top and bottom lobes bulge out 1 px so the diagonals read as lobes
  // rather than chamfers. It is 180° rotationally symmetric, and every edge
  // steps 1/2/3 like a hand-drawn pixel circle — no 1-2-1 wobble anywhere.
  //
  // The glyph follows the reference's geometry: `>` is a 2 px stroke, five rows
  // tall, apex on the panel's centre row, sitting left of centre; `_` is a
  // single row aligned with the chevron's lower tip, one column of gap between
  // them; the pair is centred horizontally. Deep blue is a bottom band only —
  // the owner asked for shape, not gradient, and the firmware self-check just
  // needs all three inks somewhere on the tile.
  //
  // Chosen from a ten-candidate panel drawn by five independent designers and
  // ranked by three judges (silhouette / craft / gestalt) — first on all three.
  codex: {
    displayName: "Codex",
    palette: {
      // `a` stays first: the firmware's two-agent strip paints the 10x10 mono
      // mark with palette[0], so reordering these repaints a different view.
      a: [124, 131, 246, 255],
      b: [45, 86, 232, 255],
      w: [255, 255, 255, 255],
    },
    rows: [
      "....aaaa........",
      "...aaaaaa.aaa...",
      "...aaaaaaaaaaa..",
      "..aaaaaaaaaaaaa.",
      ".aaaaaaaaaaaaaa.",
      "aaaaaaaaaaaaaa..",
      "aaawwaaaaaaaaa..",
      "aaaawwaaaaaaaaa.",
      ".aaaawwaaaaaaaaa",
      "..aawwaaaaaaaaaa",
      "..awwaaawwwwwaaa",
      ".aaaaaaaaaaaaaa.",
      ".aaaaaaaaaaaaa..",
      "..bbbbbbbbbbb...",
      "...bbb.bbbbbb...",
      "........bbbb....",
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

