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
  // A cloud, not a daisy: the real mark is a fat blob of unequal round lobes
  // with a white ">_" floating in it. Two things force this drawing.
  //
  // The panel paints every lit pixel in ONE brand colour, so ink is the only
  // thing that can carry the mark: the glyph has to *be* lit with an unlit gap
  // around it. Carving it out of a solid body — what this used to do — reads as
  // a scratch on a disc, not as a prompt.
  //
  // And a lobe needs area to read. A scallop 1 px wide is indistinguishable
  // from a dead pixel at arm's length, so the lobes live on a 2-row cap at the
  // top and bottom (where nothing else competes for space) and the flanks stay
  // a plain 1-px wall. Three or four fat lumps of deliberately unequal width,
  // with the top and bottom pattern offset by a column so the silhouette never
  // resolves into something symmetric. The ">" sits high and left, the "_" low
  // and right — that diagonal offset is the half of the glyph people recognise,
  // so it survives even at s10 where the chevron is down to three pixels.
  codex: {
    s10: [
      ".xxx..xx..",
      ".xxxxxxxx.",
      "x........x",
      "x.x......x",
      "x..x.....x",
      "x.x......x",
      "x....xxx.x",
      "x........x",
      ".xxxxxxxx.",
      "..xxx..xx.",
    ],
    s12: [
      ".xxxx..xxx..",
      ".xxxxxxxxxx.",
      "x..........x",
      "x..x.......x",
      "x...x......x",
      "x....x.....x",
      "x...x......x",
      "x..x.......x",
      "x.....xxx..x",
      "x..........x",
      ".xxxxxxxxxx.",
      "..xx..xxxx..",
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
