// Hand-authored pixel art for the LED panel — NOT generated from the SVGs.
//
// Area-averaging a vector mark into a 10–12 px grid destroys it: every logo here
// is built from strokes 1–2 px wide at this scale, so the mean coverage of a
// stroke falls under any sane threshold and the shape dissolves (the OpenAI knot
// became a filled disc, the xAI slash a smear). These grids are drawn by hand
// against the real marks instead, trading fidelity for the one thing that matters
// at 52x16: staying recognisable. `src/assets/vibe-icons/*.svg` keeps the vector
// originals, which the console renders directly.
//
// Rows: "." = off, "*" = dim (55 % of the ink colour), "x" = full.
// s10 feeds the two-agent strip, s12 the single-agent detail page. `gauge` is
// not a vendor: it is the neutral mark the empty state falls back to.

export type VibeIconGrid = readonly string[];

export interface VibeIconSizes {
  readonly s10: VibeIconGrid;
  readonly s12: VibeIconGrid;
}

export const VIBE_ICONS: Record<string, VibeIconSizes> = {
  claude: {
    s10: [
      "..........",
      "..xxxxxx..",
      ".x.xxxx.x.",
      ".xxxxxxxx.",
      "..xxxxxx..",
      "..xxxxxx..",
      "..xxxxxx..",
      "..x.xx.x..",
      "..x.xx.x..",
      "..........",
    ],
    s12: [
      ".....xx.....",
      ".x...xx...x.",
      "..x..xx..x..",
      "...x.xx.x...",
      "....xxxx....",
      "xxxxxxxxxxxx",
      "xxxxxxxxxxxx",
      "....xxxx....",
      "...x.xx.x...",
      "..x..xx..x..",
      ".x...xx...x.",
      ".....xx.....",
    ],
  },
  codex: {
    s10: [
      "..xxxxxx..",
      ".xxxxxxxx.",
      "xxxxxxxxxx",
      "xx.xxxxxxx",
      "xxx.xxxxxx",
      "xxxx.xxxxx",
      "xxx.xxxxxx",
      "xx.xxxxxxx",
      ".xxx....xx",
      "..xxxxxx..",
    ],
    s12: [
      "....xxxx....",
      "..xx....xx..",
      ".x........x.",
      "x....xx....x",
      "x...x.x....x",
      "x..x..x....x",
      "x....x..x..x",
      "x....x...x.x",
      "x.....xxx..x",
      ".x........x.",
      "..xx....xx..",
      "....xxxx....",
    ],
  },
  grok: {
    s10: [
      ".........x",
      "..xxxx..x.",
      ".x....xx..",
      "x....xx..x",
      "x...xx...x",
      "x..xx....x",
      "x.xx.....x",
      ".xx......x",
      "xx....xxx.",
      "x..xxxx...",
    ],
    s12: [
      "....xxxx...x",
      "..xx....xxx.",
      ".x.......xx.",
      "x.......x..x",
      "x......x...x",
      "x.....x....x",
      "x....x.....x",
      "x...x......x",
      ".x.x......x.",
      "..xx....xx..",
      ".x..xxxx....",
      "x...........",
    ],
  },
  opencode: {
    s10: [
      "..........",
      "..xxxxxx..",
      "..xxxxxx..",
      "..xx..xx..",
      "..xx..xx..",
      "..xx..xx..",
      "..xx..xx..",
      "..xxxxxx..",
      "..xxxxxx..",
      "..........",
    ],
    s12: [
      "xxxxxxxxxxxx",
      "xxxxxxxxxxxx",
      "xx........xx",
      "xx........xx",
      "xx........xx",
      "xx........xx",
      "xx........xx",
      "xx........xx",
      "xx........xx",
      "xx........xx",
      "xxxxxxxxxxxx",
      "xxxxxxxxxxxx",
    ],
  },
  gauge: {
    s10: [
      "..xxxxxx..",
      ".x......x.",
      "x...x....x",
      "x..x.....x",
      "x.x......x",
      "x........x",
      ".x......x.",
      "..xxxxxx..",
      "..........",
      "..........",
    ],
    s12: [
      "...xxxxxx...",
      "..x......x..",
      ".x........x.",
      "x....x.....x",
      "x...x......x",
      "x..x.......x",
      "x.xx.......x",
      "x..........x",
      ".x........x.",
      "..x......x..",
      "...xxxxxx...",
      "............",
    ],
  },
};
