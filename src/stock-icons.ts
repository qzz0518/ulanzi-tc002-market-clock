import type { AssetId } from "./assets.ts";

/**
 * Exact 16x16 stock marks and source PNG bytes from
 * cailurus/PixDeck@599f712d8ea086ce5b31041130f4353b3816fa0c.
 *
 * The masks are a lossless transcription of the opaque source pixels. Keeping
 * them as text makes the rendering path dependency-free while the base64
 * values preserve the original files for API delivery and provenance checks.
 * See THIRD_PARTY_NOTICES.md.
 */
export const STOCK_ICON_IDS = ["aapl", "msft", "nvda", "googl"] as const;
export type StockIconId = (typeof STOCK_ICON_IDS)[number];

interface StockIconSource {
  pngBase64: string;
  mask: readonly string[];
  colors: Readonly<Record<string, readonly [number, number, number]>>;
}

const STOCK_ICONS: Readonly<Record<StockIconId, StockIconSource>> = {
  aapl: {
    pngBase64: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfklEQVR4AcSQWw6AIAwExfvfWZnEJgv0YfQDksbS7k4t5/HzvAJcz/FmlQC8rR/PTK0EIMogLgCDRR/eDEKNXGMBzKLqPgBmsU7SXHUDQEVZbmuh+QTAaLEHEL6B7ma/6H1Vt6ygzcpMfwFQVEiUoyNcAA2MxJxz1wgBKsryGwAA//8OoNEqAAAABklEQVQDAB6iPCHjwqttAAAAAElFTkSuQmCC",
    colors: { W: [255, 255, 255] },
    mask: [
      "................", ".........WW.....", "........W.W.....", "........WW......",
      ".....WWW.WWW....", "....WWWWWWWWW...", "...WWWWWWWWWWW..", "...WWWWWWWWWW...",
      "...WWWWWWWWWW...", "...WWWWWWWWWW...", "...WWWWWWWWWWW..", "....WWWWWWWWW...",
      ".....WWWWWWW....", "......WW.WW.....", "................", "................",
    ],
  },
  msft: {
    pngBase64: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAySURBVDhPY2AYNOBTgNJ/bLh+FwNWjK5/1ABqGMCw5P1/bPj/TgasGF37qAFUMWCgAACZDGQgw0JnXwAAAABJRU5ErkJggg==",
    colors: { R: [242, 80, 34], G: [127, 186, 0], B: [0, 164, 239], Y: [255, 185, 0] },
    mask: [
      "................", "................", "..RRRRRRGGGGGG..", "..RRRRRRGGGGGG..",
      "..RRRRRRGGGGGG..", "..RRRRRRGGGGGG..", "..RRRRRRGGGGGG..", "..RRRRRRGGGGGG..",
      "..BBBBBBYYYYYY..", "..BBBBBBYYYYYY..", "..BBBBBBYYYYYY..", "..BBBBBBYYYYYY..",
      "..BBBBBBYYYYYY..", "..BBBBBBYYYYYY..", "................", "................",
    ],
  },
  nvda: {
    pngBase64: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAArElEQVR4AaTPgQ2DMBADQJrlulGH6EadrtUhOQpPUiGBZL3fbxto281nWfD6bN8rWBZc/bBTQd76fm6P4F/ZoUA4IRyEo+EVvYCZkSHcjgN9huYIozlcADfjwUe0GCLWXdCt6jQ4/UICjuEJ151nL4iBgDOaAX3U7G7mXoAAk5kjToOZ5t4LYmAeQQfm6HjQCwiMFQmZPBWHgvEoAKM248uC+iWrfVkwe9tM+wEAAP//IZAJwgAAAAZJREFUAwBd3pAhNTo+bwAAAABJRU5ErkJggg==",
    colors: { N: [118, 185, 0] },
    mask: [
      "................", "......NNNNNNNNNN", "......NNNNNNNNNN", "....NN...NNNNNNN",
      "...N..NN...NNNNN", "..N..N..NN.NNNNN", "NN.NN.N..NN.NNNN", ".N.N..N.NN..NNNN",
      ".NN.N.NNN..NN.NN", "..N..N....N....N", "..NN....NN...NNN", "...NNNNN...NNNNN",
      "........NNNNNNNN", "......NNNNNNNNNN", "................", "................",
    ],
  },
  googl: {
    pngBase64: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAB9SURBVDhPY2CgJXjlbPofGaPL4wToGrFhdD1wgK4QF0bXBwafApQwFOLD6PoZfu9h/Y9sCLo8XgNAmmEYQ5IYgGwACCPLObV++Y8L08YAkxXBOL2A0wAQgGmGYRRJQppBAFkzLozXABBA14AN49QMA+ga0DG6epyAbI2kAAAU/SMPZcjP9gAAAABJRU5ErkJggg==",
    colors: { R: [234, 67, 53], O: [242, 80, 34], Y: [251, 188, 5], B: [66, 133, 244], G: [52, 168, 83] },
    mask: [
      "................", ".......RRRR.....", ".....RRRRRRRRR..", "....RRRRRRRRRR..",
      "...ORRRRRRRRRRR.", "...YORR....RRRR.", "..YYYR..........", "..YYYY...BBBBBBB",
      "..YYYY...BBBBBBB", "..YYYG......BBBB", "...YGGG....BBBB.", "...GGGGGGGGGBBB.",
      "....GGGGGGGGGB..", ".....GGGGGGGG...", ".......GGGG.....", "................",
    ],
  },
};

export function isStockIconId(value: AssetId): value is StockIconId {
  return STOCK_ICON_IDS.includes(value as StockIconId);
}

export function getStockIconSource(id: StockIconId): StockIconSource {
  return STOCK_ICONS[id];
}

export function getStockIconPng(id: StockIconId): Uint8Array {
  return Uint8Array.from(Buffer.from(STOCK_ICONS[id].pngBase64, "base64"));
}
