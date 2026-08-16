/**
 * The ZKSWE update container: its layout, and whether a given file is one that
 * may be written to this clock's `res` partition.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * `pack-image.ts` is a SCRIPT — importing it packs an 8 MB container and writes
 * to `.runtime/`. It is also the only place that knew this format. Once the
 * console could accept an uploaded image, a second reader had to answer the same
 * questions ("is this a ZKSWE container, and does it target res?"), and a second
 * copy of a spec derived from a vendor disassembly is a copy that drifts. So the
 * spec, the parser and the verdict live here, and both the packer and
 * `src/control-api.ts` import them. Same treatment `bundle-gate.ts` got, for the
 * same reason: a rule this consequential has to be testable without building a
 * firmware.
 *
 * WHY IT IS SAFE TO BELIEVE THE LAYOUT
 * ------------------------------------
 * Every field below was read out of the ARM disassembly of the on-device
 * /lib/libzkupgrade.so (54,744 bytes) AND is re-proved on every run of the
 * packer by `verifyStockRoundTrip()`: all 572 header bytes of the stock
 * /mnt/storage/update.img are re-derived from its payload alone and required to
 * come back byte-identical.
 *
 * THERE IS NO SIGNATURE. `objdump -T` on libzkupgrade.so shows the only crypto
 * imports are zk_sec_md5_{init,update,final}; there is no RSA/ECDSA/SHA import
 * and no embedded key material. Integrity is a CRC-32 over the header plus an
 * MD5 over the partition image, both recomputed here.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Container spec
// ---------------------------------------------------------------------------

/**
 * Checked with memcmp(hdr, "ZKSWEV1.0", 9) at libzkupgrade 0x5540 — only the
 * first nine bytes are compared, but the stock image carries the full 16-byte
 * string and we reproduce it verbatim rather than inventing a shorter one.
 */
export const MAGIC = Buffer.from("ZKSWEV1.0-180127", "ascii");

/** The nine bytes the device actually compares. */
export const MAGIC_BYTES = 9;

/** read(fd, hdr, 20) at 0x5518: magic[16] + hdrSize + itemCount + eiOffset + 1. */
export const HEADER_PREFIX_BYTES = 20;

/** `add r5,r5,#28` at 0x56d0 walks the item array; the struct is 28 bytes. */
export const ITEM_BYTES = 28;

/** read(fd, ei, 524) at 0x5568, and a short read is a hard reject (error 4). */
export const EI_BYTES = 524;

/** memcpy(buf+hdrSize, ei, 520) at 0x55f8 — the trailing u32 is the CRC itself. */
export const EI_CRC_COVERED_BYTES = 520;

/**
 * The updater relocates the image's first 16 bytes into the item descriptor and
 * uses the 16 bytes they vacate to carry the MD5. See `packContainer`.
 */
export const HEAD_BYTES = 16;

/**
 * Partition type, indexed into a 9-entry `const char*` table at vaddr 0x1c950
 * (`ldrb r7,[r5,#20]; cmp r7,#8; bhi` at 0x5670, `ldr r8,[r3,r7,lsl #2]` at
 * 0x5930). Index 3 is the string "res" — it is not a standalone literal in
 * .rodata, the linker merged it into the tail of "extres" (0xb4db + 3 = 0xb4de),
 * which is why a `strings` grep for it comes up empty. Cross-checked
 * independently: the stock payload's file set is byte-for-byte the live /res
 * (221 files, 0 path deltas).
 *
 * The names are kept because a refusal has to be able to say what the image
 * aimed at. "This container targets partition 1" is a number; "this container
 * targets `boot`" is the sentence that stops someone from insisting.
 */
export const PART_TYPE_LABELS: readonly string[] = [
  "uboot",
  "boot",
  "system",
  "res",
  "config",
  "recovery",
  "MISC",
  "extres",
  "extstatic",
];

export const PART_TYPE_RES = 3;

/** How the updater names a type byte, including the ones off the end of its table. */
export function partitionLabel(type: number): string {
  return PART_TYPE_LABELS[type] ?? `未知分区(${type})`;
}

/** /proc/mtd: mtd3 res is 0x800000. `cmp size,getSize(); bhi -> error` at 0x5b70. */
export const RES_PARTITION_BYTES = 0x800000;

/**
 * hdr[16] is a u8 and doubles as "bytes before ei", which caps a container at
 * eight items: 20 + 28*9 = 272 does not fit in a byte. So the largest header a
 * legal container can carry is 20 + 28*8 + 524.
 */
export const MAX_HEADER_BYTES = HEADER_PREFIX_BYTES + ITEM_BYTES * 8 + EI_BYTES;

/**
 * The floor below which a file cannot be a container at all: one header, one
 * item descriptor, the ei block, and a payload of at least one alignment unit.
 * Nothing this small is a real res filesystem — the point is to reject a
 * truncated download before the parser starts indexing into it.
 */
export const MIN_CONTAINER_BYTES = HEADER_PREFIX_BYTES + ITEM_BYTES + EI_BYTES + 4096;

/**
 * The ceiling on a whole container. `res` is 8 MiB and that is the number the
 * device enforces on the PAYLOAD; the extra 768 bytes are the container's own
 * header, which is read and discarded rather than written to flash.
 */
export const MAX_CONTAINER_BYTES = RES_PARTITION_BYTES + MAX_HEADER_BYTES;

/**
 * Three bytes the updater never loads — the only reads of the item struct are
 * [r5,#4] (offset), [r5,#8] (size), the 16-byte head copy from r5+12, and the
 * type byte at r5+0. They sit inside the CRC, so they cannot be dropped, but
 * their meaning is unknown; we replay the stock bytes rather than guess.
 */
export const ITEM_RESERVED = Buffer.from([0x10, 0x60, 0x6c]);

/**
 * hdr[19]. `grep 'sp, #67]'` over the whole library disassembly returns zero
 * hits: nothing in libzkupgrade ever reads this byte. Same reasoning as above —
 * CRC-covered, so replayed verbatim.
 */
export const HEADER_RESERVED_19 = 0x23;

/** ei[4]. Not read by the flasher, but part of the accepted image. */
export const EI_VERSION = 0x02;

/**
 * ei+5, u32 LE, *unaligned* (`ldr r3,[sp,#329]`). Compared against the model
 * record's +4 at 0x558c; a mismatch jumps straight to error 5. 0xAA550606 is
 * "Zkswe_SSD21X_SPINOR" in the model table at .data.rel.ro 0x1c9c0 — this is
 * what makes the image model-locked, and it is why a TC002 image must not be
 * pointed at another FlyThings board.
 */
export const EI_PLATFORM_ID = 0xaa550606;

/**
 * ei+9. Read as u8 and, when zero, substituted with 0xF1 before the comparison
 * (`cmp r3,#0; moveq r3,#241` at 0x55a4). The stock image stores 0, so we do too.
 */
export const EI_FLASH_TYPE = 0x00;

/**
 * ei[11..520) is 509 bytes of MSVC-`rand()` output from whatever packed the
 * stock image: state = state*214013 + 2531011, value = (state>>16)&0x7fff,
 * emitted value-then-advance as u32 LE with the 128th draw truncated to its low
 * byte. Seeded at 0x14e4a39e it reproduces all 127 whole words and the trailing
 * byte 0x8a exactly.
 *
 * That matters for two reasons. It proves the region is packer noise rather than
 * a slice table or per-chunk checksums — it cannot encode anything about the
 * payload, because it is a pure function of the seed. And it lets us *generate*
 * the bytes instead of copying them out of the stock file, which is what makes
 * the packer's round-trip check meaningful.
 */
export const EI_FILLER_SEED = 0x14e4a39e;
export const EI_FILLER_START = 11;

/** mksquashfs pads to 4 KiB; the stock image's 0x2A4BFE rounds to 0x2A5000. */
export const IMAGE_ALIGNMENT = 4096;

/** squashfs superblock magic, little-endian 'hsqs'. */
const SQUASHFS_MAGIC = 0x73717368;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** Standard zlib/ISO-HDLC CRC-32; the routine at libzkupgrade 0x8fd8. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function md5(bytes: Uint8Array): Buffer {
  return createHash("md5").update(bytes).digest();
}

/** See EI_FILLER_SEED. Writes ei[11..520) in place. */
export function writeEiFiller(ei: Buffer, seed: number): void {
  let state = seed >>> 0;
  for (let offset = EI_FILLER_START; offset < EI_CRC_COVERED_BYTES; offset += 4) {
    const value = (state >>> 16) & 0x7fff;
    state = (Math.imul(state, 214013) + 2531011) >>> 0;
    const width = Math.min(4, EI_CRC_COVERED_BYTES - offset);
    for (let b = 0; b < width; b += 1) ei[offset + b] = (value >>> (8 * b)) & 0xff;
  }
}

// ---------------------------------------------------------------------------
// Pack / parse
// ---------------------------------------------------------------------------

export interface PackedItem {
  type: number;
  reserved: Buffer;
  offset: number;
  size: number;
  head: Buffer;
}

/**
 * Build a single-slice container around one partition image.
 *
 * The one counter-intuitive part, and the one that bricks a device if you get it
 * wrong: **the image is not laid down contiguously at item.offset.** At 0x5bc0
 * the updater copies item[12..28] — 16 bytes stored inside the descriptor — to
 * the front of its write buffer, then `lseek(fd, item.offset + 16)` at 0x5bec
 * and streams the rest of the file after them. The 16 bytes physically sitting
 * at item.offset are never written to flash; they hold the MD5 that
 * zk_upgrade_check verifies. So the image's own first 16 bytes travel in the
 * header and the payload region begins at image[16:]. A builder that writes
 * image[0:] at item.offset produces a partition whose superblock head is 16
 * bytes of MD5 — mtd3 has no A/B pair and no recovery partition to fall back on.
 */
export function packContainer(image: Buffer, type: number): Buffer {
  if (image.length % IMAGE_ALIGNMENT !== 0) {
    throw new Error(`image must be ${IMAGE_ALIGNMENT}-byte aligned, got ${image.length}`);
  }
  if (image.length <= HEAD_BYTES) throw new Error("image is too small to carry a head");

  const itemCount = 1;
  // hdr[16] doubles as "bytes before ei" — it is both the length of the second
  // read (`__read_chk(fd, buf, hdr[16], 1024)` at 0x55e0) and the lseek target
  // that finds ei (`ldrb r1,[sp,#66]` at 0x554c). Both are u8, which caps a
  // container at 8 items: 20 + 28*9 = 272 does not fit.
  const headerSize = HEADER_PREFIX_BYTES + ITEM_BYTES * itemCount;
  const eiOffset = headerSize;
  const payloadOffset = eiOffset + EI_BYTES;

  const out = Buffer.alloc(payloadOffset + image.length);
  MAGIC.copy(out, 0);
  out[16] = headerSize;
  out[17] = itemCount;
  out[18] = eiOffset;
  out[19] = HEADER_RESERVED_19;

  const item = out.subarray(HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES + ITEM_BYTES);
  item[0] = type;
  ITEM_RESERVED.copy(item, 1);
  item.writeUInt32LE(payloadOffset, 4);
  item.writeUInt32LE(image.length, 8);
  image.copy(item, 12, 0, HEAD_BYTES);

  const ei = out.subarray(eiOffset, eiOffset + EI_BYTES);
  ei.writeUInt32LE(EI_BYTES, 0);
  ei[4] = EI_VERSION;
  ei.writeUInt32LE(EI_PLATFORM_ID, 5);
  ei[9] = EI_FLASH_TYPE;
  // ei[10] is a single zero byte between the flash type and the filler. It is
  // outside the rand() run (the LCG fit starts at ei+11) and unread by the
  // updater; alloc() already zeroed it, so this is a note rather than a write.
  writeEiFiller(ei, EI_FILLER_SEED);

  // The payload's first 16 bytes are the MD5 of the *reconstructed* image, i.e.
  // of exactly what lands in flash. zk_upgrade_check reads them, then hashes
  // item.head followed by the rest of the payload and memcmp's.
  md5(image).copy(out, payloadOffset);
  image.copy(out, payloadOffset + HEAD_BYTES, HEAD_BYTES);

  // crc32 over hdr[16] bytes read from file offset 0, concatenated with the
  // first 520 bytes of ei (0x55cc-0x5610). Because ei sits at exactly hdr[16],
  // that is one contiguous run: out[0 .. eiOffset+520).
  ei.writeUInt32LE(crc32(out.subarray(0, eiOffset + EI_CRC_COVERED_BYTES)), EI_CRC_COVERED_BYTES);
  return out;
}

/**
 * Independent reader used to check our own output, to validate the stock image
 * before we trust its payload, and to judge an uploaded one. Deliberately
 * re-derives rather than re-using packContainer's intermediates.
 */
export function parseContainer(bytes: Buffer): { items: PackedItem[]; images: Buffer[] } {
  if (bytes.length < HEADER_PREFIX_BYTES) throw new Error("file is shorter than the header");
  if (bytes.subarray(0, MAGIC_BYTES).compare(MAGIC.subarray(0, MAGIC_BYTES)) !== 0) {
    throw new Error("bad ZKSWE magic");
  }

  const headerSize = bytes[16]!;
  const itemCount = bytes[17]!;
  const eiOffset = bytes[18]!;
  if (headerSize !== HEADER_PREFIX_BYTES + ITEM_BYTES * itemCount) {
    throw new Error(`hdr[16]=${headerSize} disagrees with ${itemCount} items`);
  }
  if (eiOffset !== headerSize) throw new Error(`ei offset ${eiOffset} != header size ${headerSize}`);

  const ei = bytes.subarray(eiOffset, eiOffset + EI_BYTES);
  if (ei.length !== EI_BYTES) throw new Error("truncated ei block");
  if (ei.readUInt32LE(5) !== EI_PLATFORM_ID) {
    throw new Error(`platform ${ei.readUInt32LE(5).toString(16)} is not Zkswe_SSD21X_SPINOR`);
  }
  const storedCrc = ei.readUInt32LE(EI_CRC_COVERED_BYTES);
  const actualCrc = crc32(bytes.subarray(0, eiOffset + EI_CRC_COVERED_BYTES));
  if (storedCrc !== actualCrc) {
    throw new Error(`header crc32 ${actualCrc.toString(16)} != stored ${storedCrc.toString(16)}`);
  }

  const items: PackedItem[] = [];
  const images: Buffer[] = [];
  for (let i = 0; i < itemCount; i += 1) {
    const base = HEADER_PREFIX_BYTES + ITEM_BYTES * i;
    const item: PackedItem = {
      type: bytes[base]!,
      reserved: Buffer.from(bytes.subarray(base + 1, base + 4)),
      offset: bytes.readUInt32LE(base + 4),
      size: bytes.readUInt32LE(base + 8),
      head: Buffer.from(bytes.subarray(base + 12, base + ITEM_BYTES)),
    };
    if (item.size < HEAD_BYTES) throw new Error(`item ${i} is too small to carry a head`);
    if (item.offset + item.size > bytes.length) throw new Error(`item ${i} runs past EOF`);
    const payload = bytes.subarray(item.offset, item.offset + item.size);
    const image = Buffer.concat([item.head, payload.subarray(HEAD_BYTES)]);
    const digest = md5(image);
    if (digest.compare(payload.subarray(0, HEAD_BYTES)) !== 0) {
      throw new Error(`item ${i} md5 ${digest.toString("hex")} != stored`);
    }
    items.push(item);
    images.push(image);
  }
  return { items, images };
}

// ---------------------------------------------------------------------------
// Judging a file somebody handed us
// ---------------------------------------------------------------------------

export interface ZksweFacts {
  /** Size of the whole container, in bytes. */
  bytes: number;
  /** MD5 of the whole file — the digest a person can compare against their own. */
  md5: string;
  /** Bytes that actually land in flash. */
  payloadBytes: number;
  /**
   * The in-band MD5 the updater itself verifies before it erases anything. This
   * is what `/api/os/firmware` publishes as its ETag / X-Build-Id.
   */
  payloadMd5: string;
  itemCount: number;
  /** Always PART_TYPE_RES on the ok path; carried so the console can show it. */
  partitionType: number;
  partitionLabel: string;
  /**
   * squashfs mkfs time, epoch ms, or null when the payload is not a squashfs.
   *
   * The packer pins `-mkfs-time` to the mtime of the libzkgui.so it packed, so
   * this is the closest honest answer to "which build is inside" that survives
   * xz compression — see `zosBuildId` for why the real one does not.
   */
  filesystemBuiltAtMs: number | null;
  /** See recoverZosBuildId. Null means "not recoverable", never "old". */
  zosBuildId: string | null;
}

export type ZksweRejectReason =
  | "magic"
  | "too-short"
  | "too-long"
  | "malformed"
  | "digest"
  | "partition";

export type ZksweVerdict =
  | { ok: true; facts: ZksweFacts }
  | {
    ok: false;
    reason: ZksweRejectReason;
    /** English, for the packer's stderr and for tests. The route writes its own copy. */
    detail: string;
    /** Only for "partition": what the container actually aims at. */
    partitionType?: number;
    partitionLabel?: string;
  };

/**
 * ZOS_BUILD_ID out of the payload, or null.
 *
 * The firmware stamps `<git-rev>[-dirty]-<YYYYMMDDHHMM>` into libzkgui.so
 * (mise.toml `os-build` → ProvisionLog::buildId), and that is the string that
 * answers "which code is this". It is NOT recoverable from a packed image:
 * by the time it reaches this container it is inside an xz-compressed squashfs,
 * and a sweep over the real 1 MB update.img finds nothing. Verified, not
 * assumed.
 *
 * The scan runs anyway, because the honest rule is "recover it if it is there".
 * A payload that is ever stored uncompressed would yield it, and the cost is one
 * pass over bytes we have already read. What must never happen is the other
 * thing: inventing a version string, or letting size+mtime stand in for one. A
 * caller that gets null says 未知.
 */
export function recoverZosBuildId(payload: Uint8Array): string | null {
  const stamp = /^[0-9a-f]{7,40}(-dirty)?-\d{12}$/;
  // A byte walk rather than decoding 8 MB into a string: the shape is pure
  // ASCII, so anything outside the alphabet ends the candidate run.
  let start = -1;
  for (let i = 0; i <= payload.length; i += 1) {
    const byte = i < payload.length ? payload[i]! : 0;
    const inWord = (byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x61 && byte <= 0x7a)
      || byte === 0x2d;
    if (inWord) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const length = i - start;
      // 7 hex + "-" + 12 digits is the shortest legal stamp.
      if (length >= 20 && length <= 64) {
        const candidate = Buffer.from(payload.subarray(start, i)).toString("latin1");
        if (stamp.test(candidate)) return candidate;
      }
      start = -1;
    }
  }
  return null;
}

/** The squashfs superblock's mkfs time, or null when the payload is not one. */
function squashfsBuiltAtMs(image: Buffer): number | null {
  if (image.length < 12) return null;
  if (image.readUInt32LE(0) !== SQUASHFS_MAGIC) return null;
  const seconds = image.readUInt32LE(8);
  return seconds > 0 ? seconds * 1000 : null;
}

/**
 * Whether these bytes may become the image this clock installs.
 *
 * ORDER MATTERS, cheapest and most specific first, because the answer is shown
 * to a person: "这不是固件镜像" for a JPEG is more useful than a CRC complaint.
 *
 * THE CHECK THAT MATTERS IS THE LAST ONE. Everything above it distinguishes a
 * broken download from a good one, and a broken one merely fails to install:
 * the device verifies the header CRC and the payload MD5 itself, before it
 * erases anything. The partition type is different in kind. The updater is a
 * bitmask over partition type and it will do exactly what the container tells
 * it — so an image that is perfectly well-formed but aimed at `boot` or
 * `system` is not a failed install, it is a brick, on a device whose only way
 * back is adb over mtd2. That one is refused here because here is the last
 * place it can be.
 */
export function inspectZkswe(bytes: Buffer): ZksweVerdict {
  if (bytes.length < MAGIC_BYTES
    || bytes.subarray(0, MAGIC_BYTES).compare(MAGIC.subarray(0, MAGIC_BYTES)) !== 0) {
    return { ok: false, reason: "magic", detail: "file does not start with the ZKSWE magic" };
  }
  if (bytes.length < MIN_CONTAINER_BYTES) {
    return {
      ok: false,
      reason: "too-short",
      detail: `${bytes.length} bytes is below the ${MIN_CONTAINER_BYTES}-byte floor for a container`,
    };
  }
  if (bytes.length > MAX_CONTAINER_BYTES) {
    return {
      ok: false,
      reason: "too-long",
      detail: `${bytes.length} bytes exceeds ${MAX_CONTAINER_BYTES} (mtd3 res is ${RES_PARTITION_BYTES})`,
    };
  }

  let parsed: { items: PackedItem[]; images: Buffer[] };
  try {
    parsed = parseContainer(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // A digest failure is a different sentence from a structural one: it means
    // the file arrived damaged rather than that it was never a container.
    const reason: ZksweRejectReason = /\bmd5\b/.test(detail) ? "digest" : "malformed";
    return { ok: false, reason, detail };
  }

  if (parsed.items.length === 0) {
    return { ok: false, reason: "malformed", detail: "container declares no items" };
  }
  for (const item of parsed.items) {
    if (item.type !== PART_TYPE_RES) {
      return {
        ok: false,
        reason: "partition",
        detail: `container targets partition type ${item.type} (${partitionLabel(item.type)}), `
          + `not ${PART_TYPE_RES} (res)`,
        partitionType: item.type,
        partitionLabel: partitionLabel(item.type),
      };
    }
    if (item.size > RES_PARTITION_BYTES) {
      return {
        ok: false,
        reason: "too-long",
        detail: `payload is ${item.size} bytes but mtd3 res is ${RES_PARTITION_BYTES}`,
      };
    }
  }

  const image = parsed.images[0]!;
  const item = parsed.items[0]!;
  return {
    ok: true,
    facts: {
      bytes: bytes.length,
      md5: md5(bytes).toString("hex"),
      payloadBytes: item.size,
      payloadMd5: md5(image).toString("hex"),
      itemCount: parsed.items.length,
      partitionType: item.type,
      partitionLabel: partitionLabel(item.type),
      filesystemBuiltAtMs: squashfsBuiltAtMs(image),
      zosBuildId: recoverZosBuildId(image),
    },
  };
}
