import { describe, expect, test } from "bun:test";
import { judgeBundle } from "../device/tc002-os/release/bundle-gate.ts";

// The failure this gate exists to prevent leaves no trace: `os-image` packs
// `release/bundle/`, which a separate step fills from the cross-build output,
// and skipping that step still prints every success line while the container
// holds the PREVIOUS build. It installs cleanly, reboots, and the device comes
// back running exactly what it was running before — a very convincing
// impression of an updater that does not work. An evening went into reading a
// vendor updater's disassembly over it.
describe("the packer's stale-bundle gate", () => {
  const build = (n: number, fill = 0x41) => Buffer.alloc(n, fill);

  test("packs when the bundle is the build sitting next to it", () => {
    expect(judgeBundle(build(64), build(64), false)).toEqual({ ok: true, reason: "matches" });
  });

  test("refuses a bundle that is not that build", () => {
    const verdict = judgeBundle(build(64, 0x41), build(64, 0x42), false);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: "mismatch", builtBytes: 64, bundleBytes: 64 });
  });

  test("a one-byte difference is a difference", () => {
    // Byte-for-byte, not by size or mtime: a rebuild that produces an identical
    // .so is fine to pack, and a bundle copied around loses its timestamps.
    const a = build(64);
    const b = build(64);
    b[63] = 0x00;
    expect(judgeBundle(a, b, false).ok).toBe(false);
  });

  test("REFUSES when there is no build to compare against", () => {
    // This was the hole. Returning "fine" here meant the default flow could
    // still emit a stale container, which is the entire failure being guarded
    // — the case with no evidence is the case that most needs refusing.
    const verdict = judgeBundle(null, build(64), false);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: "no-build", builtBytes: null, bundleBytes: 64 });
  });

  test("and the only way past it is one a person has to type", () => {
    // --allow-stale-bundle, for packing the checked-in bundle on a machine with
    // no toolchain. Deliberately not implied by anything else: the previous
    // version treated an explicit --bundle as consent, which is how a flag
    // about WHICH bundle silently became a flag about WHETHER to check it.
    expect(judgeBundle(null, build(64), true)).toEqual({ ok: true, reason: "waived" });
    expect(judgeBundle(build(64, 0x41), build(64, 0x42), true))
      .toEqual({ ok: true, reason: "waived" });
  });
});
