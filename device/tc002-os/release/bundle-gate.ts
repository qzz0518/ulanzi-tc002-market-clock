/**
 * Whether a staged bundle may be packed into a flashable image.
 *
 * Its own module because `pack-image.ts` is a SCRIPT — importing it runs it,
 * packs an 8 MB container and writes to `.runtime/`. A rule this important
 * needs tests, and tests must not have to build a firmware to ask a question
 * about two buffers.
 *
 * WHAT IT IS FOR. `os-image` packs `device/tc002-os/release/bundle/`, which a
 * separate step (`scripts/create-os-release.ts`) fills from the cross-build
 * output. Skip that step and every success line still prints while the
 * container holds the PREVIOUS build. That container is not broken: it installs
 * cleanly, reboots, and the device comes back running exactly what it was
 * running before. `/data/zos-build.id` does not move, and the only visible
 * symptom is an update that appears not to take — which reads as a broken
 * updater, and was investigated as one, down to the vendor's disassembly.
 */

export type BundleVerdict =
  | { ok: true; reason: "matches" | "waived" }
  | { ok: false; reason: "no-build" | "mismatch"; builtBytes: number | null; bundleBytes: number };

/**
 * FAIL CLOSED IN BOTH DIRECTIONS.
 *
 * The first version of this returned "fine" when the cross-build output was
 * missing, and skipped the check entirely when `--bundle` named a directory
 * explicitly. Both left the hole it was written to close, and the first one is
 * the worse: the case with no evidence is the case that most needs refusing.
 *
 * Compared byte for byte rather than by size or mtime — a rebuild that produces
 * an identical `.so` is fine to pack, and a bundle copied around loses its
 * timestamps.
 *
 * `waived` is `--allow-stale-bundle`, for packing the checked-in bundle on a
 * machine with no toolchain. Nothing else implies it: a flag about WHICH bundle
 * must never quietly become a flag about WHETHER to check it.
 */
export function judgeBundle(
  built: Uint8Array | null,
  staged: Uint8Array,
  waived: boolean,
): BundleVerdict {
  if (waived) return { ok: true, reason: "waived" };
  if (built === null) {
    return { ok: false, reason: "no-build", builtBytes: null, bundleBytes: staged.length };
  }
  if (built.length === staged.length && Buffer.from(built).equals(Buffer.from(staged))) {
    return { ok: true, reason: "matches" };
  }
  return { ok: false, reason: "mismatch", builtBytes: built.length, bundleBytes: staged.length };
}
