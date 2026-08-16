import { describe, expect, test } from "bun:test";
import {
  IMAGE_ALIGNMENT,
  MAX_CONTAINER_BYTES,
  MIN_CONTAINER_BYTES,
  PART_TYPE_RES,
  RES_PARTITION_BYTES,
  inspectZkswe,
  md5,
  packContainer,
  partitionLabel,
  recoverZosBuildId,
} from "../device/tc002-os/release/zkswe-image.ts";

// The gate between "a file somebody picked" and "the image this clock installs".
//
// Every rejection below is a refusal to arm an image, and all but one of them
// merely catch a broken download — the device verifies the header CRC and the
// payload MD5 itself before it erases anything. The partition check is the one
// with nothing behind it: the vendor updater is a bitmask over partition type
// and does exactly what the container says, so a well-formed image aimed at
// another partition installs perfectly and destroys the clock. mtd3 has no A/B
// pair and no recovery slot.

/** A payload the way mksquashfs would hand one over: 'hsqs', a build time, aligned. */
function payload(bytes = IMAGE_ALIGNMENT * 2, builtAtSeconds = 1_780_910_006): Buffer {
  const image = Buffer.alloc(bytes, 0x5a);
  image.writeUInt32LE(0x73717368, 0); // squashfs magic
  image.writeUInt32LE(1234, 4); // inode count
  image.writeUInt32LE(builtAtSeconds, 8); // mkfs time — the packer pins this to the build
  return image;
}

/** What `mise run os-image` emits, in miniature. */
function container(type = PART_TYPE_RES, image = payload()): Buffer {
  return packContainer(image, type);
}

function reject(bytes: Buffer): { reason: string; detail: string; partitionLabel?: string } {
  const verdict = inspectZkswe(bytes);
  if (verdict.ok) throw new Error("expected a refusal, got a verdict of ok");
  return { reason: verdict.reason, detail: verdict.detail, partitionLabel: verdict.partitionLabel };
}

describe("zkswe image inspection", () => {
  // The console states this ceiling in its own copy ("最大 8.0 MB") and cannot
  // import this module — it pulls in Buffer and node:crypto. So the number is
  // written twice, and this is the test that keeps the two the same one.
  test("the console's copy of the size ceiling is the ceiling", async () => {
    const { ZOS_FIRMWARE_MAX_BYTES } = await import("../web/src/lib/zos-link.ts");
    expect(ZOS_FIRMWARE_MAX_BYTES).toBe(MAX_CONTAINER_BYTES);
    expect(MAX_CONTAINER_BYTES).toBe(RES_PARTITION_BYTES + 768);
  });

  test("accepts the container the packer emits, and describes it from its own bytes", () => {
    const image = payload();
    const bytes = container(PART_TYPE_RES, image);
    const verdict = inspectZkswe(bytes);
    if (!verdict.ok) throw new Error(`expected ok, got ${verdict.reason}: ${verdict.detail}`);

    expect(verdict.facts.bytes).toBe(bytes.length);
    // The digest a person can compare against their own `md5 update.img`.
    expect(verdict.facts.md5).toBe(md5(bytes).toString("hex"));
    // ...which is NOT the in-band one the device verifies. Two different
    // questions ("did I upload the file I meant" vs "did the flash write land"),
    // so two different numbers, and the console must never conflate them.
    expect(verdict.facts.payloadMd5).toBe(md5(image).toString("hex"));
    expect(verdict.facts.md5).not.toBe(verdict.facts.payloadMd5);
    expect(verdict.facts.payloadBytes).toBe(image.length);
    expect(verdict.facts.partitionType).toBe(PART_TYPE_RES);
    expect(verdict.facts.partitionLabel).toBe("res");
    // mksquashfs's own stamp, pinned by the packer to the mtime of the .so it
    // packed. The closest honest answer to "which build is in here" that
    // survives xz — see the build-id case below for why it is needed.
    expect(verdict.facts.filesystemBuiltAtMs).toBe(1_780_910_006_000);
  });

  test("REFUSES a well-formed image whose flash target is not type 3 (res) — the brick case", () => {
    // Everything about this container is right: magic, header arithmetic, CRC,
    // in-band MD5, size. Only the type byte differs, and that byte is the whole
    // difference between an update and a device that does not boot.
    for (const [type, label] of [[0, "uboot"], [1, "boot"], [2, "system"], [5, "recovery"]] as const) {
      const verdict = reject(container(type));
      expect(verdict.reason).toBe("partition");
      expect(verdict.partitionLabel).toBe(label);
      expect(verdict.detail).toContain("res");
    }

    // A type off the end of the updater's 9-entry table is still not res, and
    // still gets named rather than reported as a bare number.
    expect(reject(container(200)).reason).toBe("partition");
    expect(partitionLabel(200)).toContain("200");

    // The control: the same bytes with type 3 pass. Without this the test above
    // would also pass on a validator that refuses everything.
    expect(inspectZkswe(container(PART_TYPE_RES)).ok).toBe(true);
  });

  test("refuses anything that does not start with the ZKSWE magic", () => {
    expect(reject(Buffer.alloc(MIN_CONTAINER_BYTES, 0x00)).reason).toBe("magic");
    // A JPEG, a zip, a squashfs handed over without its container: all the same
    // answer, and the answer names what is missing rather than "invalid file".
    expect(reject(payload()).reason).toBe("magic");
    // One byte off inside the nine the device compares is still not the magic.
    const nearly = container();
    nearly[8] = nearly[8]! ^ 0x01;
    expect(reject(nearly).reason).toBe("magic");
    expect(reject(Buffer.alloc(0)).reason).toBe("magic");
  });

  test("refuses a file too short to be a container", () => {
    const short = container().subarray(0, MIN_CONTAINER_BYTES - 1);
    const verdict = reject(short);
    expect(verdict.reason).toBe("too-short");
    expect(verdict.detail).toContain(String(MIN_CONTAINER_BYTES));
  });

  test("refuses a file larger than the res partition", () => {
    const huge = Buffer.alloc(MAX_CONTAINER_BYTES + 1);
    container().copy(huge, 0, 0, 64);
    const verdict = reject(huge);
    expect(verdict.reason).toBe("too-long");
    expect(verdict.detail).toContain(String(RES_PARTITION_BYTES));

    // Editing the descriptor to CLAIM a partition-sized write does not get as
    // far as the size rule: the item struct sits inside the header CRC, so a
    // hand-edited size is a broken header first. That is the ordering the
    // device uses too, and it is why the size check below it is defence rather
    // than the front line.
    const lying = container();
    lying.writeUInt32LE(RES_PARTITION_BYTES + IMAGE_ALIGNMENT, 20 + 8);
    const tampered = reject(lying);
    expect(tampered.reason).toBe("malformed");
    expect(tampered.detail).toContain("crc32");
  });

  test("refuses a truncated container", () => {
    const bytes = container();
    // Long enough to clear the floor, short enough that the item's declared
    // extent runs past EOF — the shape a half-finished download actually has.
    const cut = bytes.subarray(0, bytes.length - IMAGE_ALIGNMENT);
    const verdict = reject(cut);
    expect(verdict.reason).toBe("malformed");
    expect(verdict.detail).toContain("EOF");
  });

  test("refuses a container whose payload digest does not match its contents", () => {
    const bytes = container();
    // Flip a byte deep inside the payload, past the relocated head. The header
    // and its CRC still check out; only the MD5 the updater verifies moves.
    bytes[bytes.length - 32] = bytes[bytes.length - 32]! ^ 0xff;
    const verdict = reject(bytes);
    expect(verdict.reason).toBe("digest");
    expect(verdict.detail).toContain("md5");
  });

  test("refuses a header whose arithmetic does not add up", () => {
    const bytes = container();
    bytes[17] = 3; // three items, but hdr[16] still says one descriptor
    expect(reject(bytes).reason).toBe("malformed");
  });

  // The build id is the string that answers "which code is this". It is stamped
  // into libzkgui.so and, in a packed image, sits inside an xz-compressed
  // squashfs — a sweep over the real 1 MB update.img finds nothing. So the rule
  // is: recover it if it is there, and say 未知 if it is not. Never derive one.
  test("recovers a stamped build id when the payload carries one, and null when it does not", () => {
    expect(recoverZosBuildId(payload())).toBeNull();

    const stamped = payload();
    stamped.write("3f2a1c9-202608141930", 512, "latin1");
    expect(recoverZosBuildId(stamped)).toBe("3f2a1c9-202608141930");
    expect(inspectZkswe(packContainer(stamped, PART_TYPE_RES)).ok).toBe(true);
    const facts = inspectZkswe(packContainer(stamped, PART_TYPE_RES));
    expect(facts.ok && facts.facts.zosBuildId).toBe("3f2a1c9-202608141930");

    // The -dirty marker the build adds for an uncommitted tree travels with it.
    const dirty = payload();
    dirty.write("3f2a1c9-dirty-202608141930", 512, "latin1");
    expect(recoverZosBuildId(dirty)).toBe("3f2a1c9-dirty-202608141930");

    // Things that merely look like one are not one: a bare hash, a bare date,
    // a hex run that is too long. A wrong version is worse than 未知.
    const bogus = payload();
    bogus.write("deadbeef", 512, "latin1");
    bogus.write("202608141930", 600, "latin1");
    bogus.write(`${"a".repeat(41)}-202608141930`, 700, "latin1");
    expect(recoverZosBuildId(bogus)).toBeNull();
  });
});
