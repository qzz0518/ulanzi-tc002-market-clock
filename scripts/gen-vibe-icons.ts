/**
 * Rasterises the OpenUsage provider marks into the two generated modules the
 * VIBE feature consumes:
 *
 *   - `src/vibe/vibe-icons.ts`     — 10px / 12px pixel coverage grids for the
 *                                    52×16 LED renderer
 *   - `web/src/lib/vibe-icon-svg.ts` — raw SVG strings for the console's
 *                                    provider list
 *
 * Sources are the monochrome single-path SVGs in `src/assets/vibe-icons/`
 * (copied from OpenUsage `Sources/OpenUsage/Resources/ProviderIcons/`; they
 * are third-party brand marks used nominatively, same as OpenUsage does).
 *
 * Pipeline per icon and size: draw the SVG on a canvas at 8× supersampling,
 * box-average the alpha channel into an N×N coverage grid, then binarise with
 * a per-icon threshold. Thresholds were picked by eye from proof sheets:
 * thin-stroke marks (codex knot, copilot goggles, devin flower, grok slash)
 * need a lower cut than solid marks or their strokes vanish, while the default
 * 0.42 keeps solid shapes from bloating. `claude` skips rasterisation
 * entirely — area-averaging washes the thin starburst rays into a blob at
 * ≤12px, so its grids are hand-authored below.
 *
 * Machine-dependent on purpose (run once, commit the output): it drives the
 * globally installed puppeteer-core against the ms-playwright Chromium cache,
 * the same setup used for README screenshots. Re-run with:
 *
 *   bun run scripts/gen-vibe-icons.ts
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PUPPETEER =
  "/Users/qiuzezheng/.bun/install/global/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
const CHROMIUM_GLOB = join(
  process.env.HOME ?? "~",
  "Library/Caches/ms-playwright",
);

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ICON_DIR = join(REPO, "src/assets/vibe-icons");
const SIZES = [10, 12] as const;
const SUPERSAMPLE = 8;

// Per-icon binarisation threshold (fraction of full coverage). Anything not
// listed uses the default. Values chosen from visual proof sheets; see header.
const DEFAULT_THRESHOLD = 0.42;
const THRESHOLD_10: Record<string, number> = {
  codex: 0.34,
  copilot: 0.28,
  devin: 0.28,
  grok: 0.34,
};
const THRESHOLD_12: Record<string, number> = {
  copilot: 0.28,
  devin: 0.28,
};

// Hand-authored Claude starburst: full-height cardinal rays plus pixel
// diagonals, dim shoulders ("*") where the rays meet so the centre reads as a
// hub instead of a solid block.
const HAND_CLAUDE_10 = [
  "....xx....",
  ".x..xx..x.",
  "..x.xx.x..",
  "...*xx*...",
  "xxxxxxxxxx",
  "xxxxxxxxxx",
  "...*xx*...",
  "..x.xx.x..",
  ".x..xx..x.",
  "....xx....",
];
const HAND_CLAUDE_12 = [
  ".....xx.....",
  ".x...xx...x.",
  "..x..xx..x..",
  "...x.xx.x...",
  "....*xx*....",
  "xxxxxxxxxxxx",
  "xxxxxxxxxxxx",
  "....*xx*....",
  "...x.xx.x...",
  "..x..xx..x..",
  ".x...xx...x.",
  ".....xx.....",
];

function latestChromium(): string {
  const dirs = readdirSync(CHROMIUM_GLOB)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
  const latest = dirs.at(-1);
  if (!latest) throw new Error(`no chromium under ${CHROMIUM_GLOB}`);
  return join(
    CHROMIUM_GLOB,
    latest,
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );
}

type Grid = number[][];

async function rasterise(svgs: Record<string, string>): Promise<Record<string, Record<number, Grid>>> {
  const { default: puppeteer } = await import(PUPPETEER);
  const browser = await puppeteer.launch({
    executablePath: latestChromium(),
    headless: "new",
    args: ["--force-color-profile=srgb", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent("<html><body></body></html>");
    return await page.evaluate(
      async (input: { svgs: Record<string, string>; sizes: readonly number[]; ss: number }) => {
        const loadImage = (svg: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
          });
        const out: Record<string, Record<number, number[][]>> = {};
        for (const [name, svg] of Object.entries(input.svgs)) {
          const img = await loadImage(svg);
          out[name] = {};
          for (const size of input.sizes) {
            const big = size * input.ss;
            const canvas = document.createElement("canvas");
            canvas.width = big;
            canvas.height = big;
            const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
            ctx.drawImage(img, 0, 0, big, big);
            const data = ctx.getImageData(0, 0, big, big).data;
            const grid: number[][] = [];
            for (let gy = 0; gy < size; gy++) {
              const row: number[] = [];
              for (let gx = 0; gx < size; gx++) {
                let sum = 0;
                for (let y = gy * input.ss; y < (gy + 1) * input.ss; y++) {
                  for (let x = gx * input.ss; x < (gx + 1) * input.ss; x++) {
                    sum += data[(y * big + x) * 4 + 3];
                  }
                }
                row.push(Math.round(sum / (input.ss * input.ss)));
              }
              grid.push(row);
            }
            out[name][size] = grid;
          }
        }
        return out;
      },
      { svgs, sizes: SIZES, ss: SUPERSAMPLE },
    );
  } finally {
    await browser.close();
  }
}

function binarise(grid: Grid, threshold: number): string[] {
  return grid.map((row) => row.map((v) => (v >= threshold * 255 ? "x" : ".")).join(""));
}

function emitServerModule(final: Record<string, { s10: string[]; s12: string[] }>): void {
  const names = Object.keys(final).sort();
  const rows = (g: string[]) => g.map((r) => JSON.stringify(r)).join(",\n      ");
  let ts = `// GENERATED by scripts/gen-vibe-icons.ts — do not edit by hand.
// Pixel coverage grids rasterized from src/assets/vibe-icons/*.svg (OpenUsage provider marks).
// Rows: "." = off, "*" = dim (55%), "x" = full. Two sizes: 10px (duo strip), 12px (detail page).
// claude is hand-authored: area-averaging washed the thin starburst rays into a blob at these sizes.

export type VibeIconGrid = readonly string[];

export interface VibeIconSizes {
  readonly s10: VibeIconGrid;
  readonly s12: VibeIconGrid;
}

export const VIBE_ICONS: Record<string, VibeIconSizes> = {
`;
  for (const name of names) {
    ts += `  ${name}: {\n    s10: [\n      ${rows(final[name].s10)},\n    ],\n    s12: [\n      ${rows(final[name].s12)},\n    ],\n  },\n`;
  }
  ts += `};\n`;
  writeFileSync(join(REPO, "src/vibe/vibe-icons.ts"), ts);
}

function emitWebModule(svgFiles: string[]): void {
  let ts = `// GENERATED by scripts/gen-vibe-icons.ts — do not edit by hand.
// Raw provider mark SVGs (from src/assets/vibe-icons/) for the VIBE tab's provider list.
// Third-party brand marks used nominatively to identify each service.

export const VIBE_ICON_SVG: Record<string, string> = {
`;
  for (const file of svgFiles) {
    const svg = readFileSync(join(ICON_DIR, file), "utf8").replace(/\r?\n\s*/g, " ").trim();
    ts += `  ${file.replace(/\.svg$/, "")}: ${JSON.stringify(svg)},\n`;
  }
  ts += `};\n`;
  writeFileSync(join(REPO, "web/src/lib/vibe-icon-svg.ts"), ts);
}

const svgFiles = readdirSync(ICON_DIR).filter((f) => f.endsWith(".svg")).sort();
const svgs = Object.fromEntries(
  svgFiles.map((f) => [f.replace(/\.svg$/, ""), readFileSync(join(ICON_DIR, f), "utf8")]),
);

const raster = await rasterise(svgs);
const final: Record<string, { s10: string[]; s12: string[] }> = {};
for (const name of Object.keys(raster).sort()) {
  final[name] =
    name === "claude"
      ? { s10: HAND_CLAUDE_10, s12: HAND_CLAUDE_12 }
      : {
          s10: binarise(raster[name][10], THRESHOLD_10[name] ?? DEFAULT_THRESHOLD),
          s12: binarise(raster[name][12], THRESHOLD_12[name] ?? DEFAULT_THRESHOLD),
        };
}
emitServerModule(final);
emitWebModule(svgFiles);
console.log(`gen-vibe-icons: ${Object.keys(final).length} icons → src/vibe/vibe-icons.ts, web/src/lib/vibe-icon-svg.ts`);
