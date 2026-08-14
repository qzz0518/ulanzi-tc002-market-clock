/**
 * The panel's hand-drawn provider marks, for the browser — the SAME grids the
 * firmware header is generated from, re-exported rather than mirrored.
 *
 * `src/vibe/vibe-icons.ts` is the one source those 10 px / 12 px marks have:
 * `scripts/gen-vibe-icons.ts` bit-packs it into
 * `device/tc002-os/app/src/visual/VibeIcons.h`, and `test/vibe-icons-parity.test.ts`
 * holds those two sides together bit for bit. A hand-copied third table would be
 * a fourth thing to keep in step and the only one nothing checks — so the
 * console's screen preview reads the same strings the firmware was generated
 * from, and "what the LED shows is what the preview shows" stays a fact rather
 * than a coincidence. Same reasoning, same direction as `lyric-cursor.ts`.
 *
 * The module is plain string data: it imports nothing and uses no Bun API, so it
 * bundles for the browser unchanged.
 */
export * from "../../../src/vibe/vibe-icons.ts";
