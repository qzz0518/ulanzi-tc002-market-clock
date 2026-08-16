/**
 * The panel's 16x16 colour provider marks, for the browser — the SAME art the
 * firmware header is generated from, re-exported rather than mirrored.
 *
 * `src/vibe/vibe-pixel-logos.ts` is the one source this art has:
 * `scripts/gen-vibe-icons.ts` packs it two bits per pixel into
 * `device/tc002-os/app/src/visual/VibeIcons.h`, and
 * `test/vibe-icons-parity.test.ts` holds the header, that source and the frame
 * this preview draws together, pixel for pixel. A hand-copied third table would
 * be a fourth thing to keep in step and the only one nothing checks — which is
 * exactly how the console came to draw the old monochrome marks while the clock
 * drew these. Same reasoning, same direction as `vibe-icon-grids.ts`.
 *
 * The module is plain string/number data: it imports nothing and uses no Bun
 * API, so it bundles for the browser unchanged.
 */
export * from "../../../src/vibe/vibe-pixel-logos.ts";
