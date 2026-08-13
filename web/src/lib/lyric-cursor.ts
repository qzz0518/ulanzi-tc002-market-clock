/**
 * Lyric timing for the browser — the SAME module the service and the firmware
 * golden vectors are built from, re-exported rather than re-implemented.
 *
 * Timing is protocol now: the cell index the panel lights IS the index that
 * crosses the wire in `lyricw`. A hand-copied second implementation is exactly
 * how the whitespace-counting and double-space divergences in
 * pixel-lyrics-preview.tsx happened in the first place — two files that agreed
 * when they were written and quietly stopped agreeing. `src/music/lyric-timing.ts`
 * imports nothing but types and uses no Bun API, so it bundles for the browser
 * unchanged.
 */
export * from "../../../src/music/lyric-timing.ts";
