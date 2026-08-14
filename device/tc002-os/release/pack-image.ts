/**
 * Pack tc002-os into a stock-compatible ZKSWE update.img for the `res` partition.
 *
 * WHY THIS EXISTS
 * ---------------
 * Sideloading writes the app into /tmp, so a power cycle restores the official
 * firmware from /res — that is the rescue path the whole project leans on
 * (device/tc002-os/sideload/os). Making ZOS survive a power cycle means writing
 * mtd3 `res`, and the only writer on the device is the stock updater in
 * /lib/libzkupgrade.so. So this script produces exactly the container that
 * updater accepts, and nothing else.
 *
 * WHY IT IS SAFE TO BELIEVE THE LAYOUT
 * ------------------------------------
 * Every field below was read out of the ARM disassembly of the on-device
 * /lib/libzkupgrade.so (54,744 bytes — note the copy pulled via a text-mangling
 * path is 55,199 bytes and disassembles to garbage) AND is re-proved on every
 * run by `verifyStockRoundTrip()`: we re-derive all 572 header bytes of the
 * stock /mnt/storage/update.img from its payload alone and require a
 * byte-identical result. Nothing here is copied out of the file being
 * reproduced, so the round trip is a real test of the spec rather than a
 * tautology. If it ever fails, the header is not understood and we emit nothing.
 *
 * THERE IS NO SIGNATURE. `objdump -T` on libzkupgrade.so shows the only crypto
 * imports are zk_sec_md5_{init,update,final}; there is no RSA/ECDSA/SHA import
 * and no embedded key material. Integrity is a CRC-32 over the header plus an
 * MD5 over the partition image, both recomputed here.
 *
 * Usage:
 *   bun run device/tc002-os/release/pack-image.ts [--verify-only]
 *     [--stock <update.img>] [--bundle <dir>] [--out <update.img>]
 *
 *   --restore <resDir>   pack that directory verbatim instead of substituting
 *                        ZOS into the stock tree. Used to turn a pulled copy of
 *                        the device's LIVE /res into an exact restore image.
 *
 * Why --restore exists. Ulanzi publishes no downloadable TC002 firmware, so the
 * only stock images that exist anywhere are the ones taken off this unit — and
 * the one on /mnt/storage is older than what the device is actually running.
 * Flashing that to "restore" would silently downgrade /res. A restore point has
 * to be built from the running firmware, and this is how.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { judgeBundle } from "./bundle-gate.ts";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

// ---------------------------------------------------------------------------
// Container spec
// ---------------------------------------------------------------------------

/**
 * Checked with memcmp(hdr, "ZKSWEV1.0", 9) at libzkupgrade 0x5540 — only the
 * first nine bytes are compared, but the stock image carries the full 16-byte
 * string and we reproduce it verbatim rather than inventing a shorter one.
 */
const MAGIC = Buffer.from("ZKSWEV1.0-180127", "ascii");

/** read(fd, hdr, 20) at 0x5518: magic[16] + hdrSize + itemCount + eiOffset + 1. */
const HEADER_PREFIX_BYTES = 20;

/** `add r5,r5,#28` at 0x56d0 walks the item array; the struct is 28 bytes. */
const ITEM_BYTES = 28;

/** read(fd, ei, 524) at 0x5568, and a short read is a hard reject (error 4). */
const EI_BYTES = 524;

/** memcpy(buf+hdrSize, ei, 520) at 0x55f8 — the trailing u32 is the CRC itself. */
const EI_CRC_COVERED_BYTES = 520;

/**
 * The updater relocates the image's first 16 bytes into the item descriptor and
 * uses the 16 bytes they vacate to carry the MD5. See `packContainer`.
 */
const HEAD_BYTES = 16;

/**
 * Partition type, indexed into a 9-entry `const char*` table at vaddr 0x1c950
 * (`ldrb r7,[r5,#20]; cmp r7,#8; bhi` at 0x5670, `ldr r8,[r3,r7,lsl #2]` at
 * 0x5930). Resolved entries, in order:
 *   0 uboot:BOOT:BOOT0  1 boot:KERNEL  2 system:rootfs  3 res
 *   4 config  5 recovery  6 MISC:boot_logo:LOGO  7 extres  8 extstatic
 * Index 3 is the string "res" — it is not a standalone literal in .rodata, the
 * linker merged it into the tail of "extres" (0xb4db + 3 = 0xb4de), which is why
 * a `strings` grep for it comes up empty. Cross-checked independently: the stock
 * payload's file set is byte-for-byte the live /res (221 files, 0 path deltas).
 */
const PART_TYPE_RES = 3;

/** /proc/mtd: mtd3 res is 0x800000. `cmp size,getSize(); bhi -> error` at 0x5b70. */
const RES_PARTITION_BYTES = 0x800000;

/**
 * Three bytes the updater never loads — the only reads of the item struct are
 * [r5,#4] (offset), [r5,#8] (size), the 16-byte head copy from r5+12, and the
 * type byte at r5+0. They sit inside the CRC, so they cannot be dropped, but
 * their meaning is unknown; we replay the stock bytes rather than guess.
 */
const ITEM_RESERVED = Buffer.from([0x10, 0x60, 0x6c]);

/**
 * hdr[19]. `grep 'sp, #67]'` over the whole library disassembly returns zero
 * hits: nothing in libzkupgrade ever reads this byte. Same reasoning as above —
 * CRC-covered, so replayed verbatim.
 */
const HEADER_RESERVED_19 = 0x23;

/** ei[4]. Not read by the flasher, but part of the accepted image. */
const EI_VERSION = 0x02;

/**
 * ei+5, u32 LE, *unaligned* (`ldr r3,[sp,#329]`). Compared against the model
 * record's +4 at 0x558c; a mismatch jumps straight to error 5. 0xAA550606 is
 * "Zkswe_SSD21X_SPINOR" in the model table at .data.rel.ro 0x1c9c0 — this is
 * what makes the image model-locked, and it is why a TC002 image must not be
 * pointed at another FlyThings board.
 */
const EI_PLATFORM_ID = 0xaa550606;

/**
 * ei+9. Read as u8 and, when zero, substituted with 0xF1 before the comparison
 * (`cmp r3,#0; moveq r3,#241` at 0x55a4). The stock image stores 0, so we do too.
 */
const EI_FLASH_TYPE = 0x00;

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
 * the round-trip check below meaningful.
 *
 * We reuse the stock seed rather than picking a fresh one: the region only ever
 * enters the CRC, so any content would do, but an ei block byte-identical to one
 * the device has already accepted is the cheaper risk.
 */
const EI_FILLER_SEED = 0x14e4a39e;
const EI_FILLER_START = 11;

/** mksquashfs pads to 4 KiB; the stock image's 0x2A4BFE rounds to 0x2A5000. */
const IMAGE_ALIGNMENT = 4096;

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
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function md5(bytes: Uint8Array): Buffer {
  return createHash("md5").update(bytes).digest();
}

/** See EI_FILLER_SEED. Writes ei[11..520) in place. */
function writeEiFiller(ei: Buffer, seed: number): void {
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

interface PackedItem {
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
function packContainer(image: Buffer, type: number): Buffer {
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
 * Independent reader used to check our own output and to validate the stock
 * image before we trust its payload. Deliberately re-derives rather than
 * re-using packContainer's intermediates.
 */
function parseContainer(bytes: Buffer): { items: PackedItem[]; images: Buffer[] } {
  if (bytes.length < HEADER_PREFIX_BYTES) throw new Error("file is shorter than the header");
  if (bytes.subarray(0, 9).compare(MAGIC.subarray(0, 9)) !== 0) throw new Error("bad ZKSWE magic");

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
// The safety argument
// ---------------------------------------------------------------------------

/**
 * Rebuild the stock update.img from its own payload and require byte identity.
 *
 * This is the entire reason it is defensible to flash anything: it asserts that
 * every one of the 572 header bytes is *derived* — magic, the three header
 * fields, the item descriptor including the relocated head, the in-band MD5, the
 * whole 524-byte ei block including its 509 bytes of LCG filler, and the CRC.
 * Only `image` comes from the stock file. If a single byte is off, we do not
 * understand the container and must not emit one.
 */
function verifyStockRoundTrip(stock: Buffer): { image: Buffer; item: PackedItem } {
  const parsed = parseContainer(stock);
  if (parsed.items.length !== 1) {
    throw new Error(`expected a single-slice stock image, found ${parsed.items.length}`);
  }
  const item = parsed.items[0]!;
  const image = parsed.images[0]!;
  if (item.type !== PART_TYPE_RES) {
    throw new Error(`stock image targets partition type ${item.type}, expected ${PART_TYPE_RES} (res)`);
  }
  if (item.reserved.compare(ITEM_RESERVED) !== 0) {
    throw new Error(
      `stock item reserved bytes are ${item.reserved.toString("hex")}, `
        + `this packer replays ${ITEM_RESERVED.toString("hex")}`,
    );
  }

  const rebuilt = packContainer(image, item.type);
  if (rebuilt.compare(stock) !== 0) {
    const at = firstDifference(rebuilt, stock);
    throw new Error(
      "ROUND TRIP FAILED — the ZKSWE header is not fully understood, refusing to emit an image.\n"
        + `  stock:   ${stock.length} bytes\n`
        + `  rebuilt: ${rebuilt.length} bytes\n`
        + (at < 0
          ? "  lengths differ\n"
          : `  first difference at offset 0x${at.toString(16)}: `
            + `stock=0x${stock[at]!.toString(16).padStart(2, "0")} `
            + `rebuilt=0x${rebuilt[at]!.toString(16).padStart(2, "0")}\n`)
        + "  Do not flash anything produced by this script until this passes.",
    );
  }
  return { image, item };
}

function firstDifference(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// ---------------------------------------------------------------------------
// Building the res filesystem
// ---------------------------------------------------------------------------

interface SuperBlock {
  inodes: number;
  blockSize: number;
  compression: number;
  blockLog: number;
  flags: number;
  noIds: number;
  major: number;
  minor: number;
}

function readSuperBlock(image: Buffer): SuperBlock {
  if (image.readUInt32LE(0) !== 0x73717368) throw new Error("payload is not a squashfs (no 'hsqs')");
  return {
    inodes: image.readUInt32LE(4),
    blockSize: image.readUInt32LE(12),
    compression: image.readUInt16LE(20),
    blockLog: image.readUInt16LE(22),
    flags: image.readUInt16LE(24),
    noIds: image.readUInt16LE(26),
    major: image.readUInt16LE(28),
    minor: image.readUInt16LE(30),
  };
}

/**
 * Overwrite a file that already exists in the stock tree, keeping its mode.
 * unsquashfs restores 0750/0770 here; writing through would silently relax the
 * app library and the config to the umask default.
 */
async function replaceInTree(tree: string, relative: string, contents: Buffer): Promise<void> {
  const target = join(tree, relative);
  const mode = (await stat(target)).mode & 0o7777;
  await writeFile(target, contents);
  await chmod(target, mode);
}

function run(command: string, args: string[]): void {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} failed (exit ${result.exitCode})\n${result.stderr.toString()}`.trimEnd(),
    );
  }
}

function requireTool(name: string): void {
  if (Bun.spawnSync(["which", name], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) {
    throw new Error(`${name} not found — install squashfs-tools (brew install squashfs)`);
  }
}

/** `mode -> path` for every entry in a squashfs, via unsquashfs -ll. */
function listEntries(image: string): Map<string, string> {
  const result = Bun.spawnSync(["unsquashfs", "-ll", image], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`unsquashfs -ll failed on ${image}`);
  const entries = new Map<string, string>();
  for (const line of result.stdout.toString().split("\n")) {
    const match = /^([-dlbcps][-rwxsStT]{9})\s+\d+\/\d+\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (match) entries.set(match[2]!.split(" -> ")[0]!, match[1]!);
  }
  if (entries.size === 0) throw new Error(`could not read any entries from ${image}`);
  return entries;
}

/**
 * The rebuilt filesystem must be the stock one plus os.ftu, with identical
 * permissions everywhere. This is the check that says "we substituted three
 * files", as opposed to "we rebuilt something that happens to boot": an
 * extraction that dropped a mode, lost a file, or flattened a directory shows up
 * here instead of on a device whose only way back is adb over mtd2.
 */
function assertTreeParity(stockImage: string, builtImage: string): void {
  const stock = listEntries(stockImage);
  const built = listEntries(builtImage);
  const problems: string[] = [];
  for (const [path, mode] of stock) {
    const rebuilt = built.get(path);
    if (rebuilt === undefined) problems.push(`missing ${path}`);
    else if (rebuilt !== mode) problems.push(`${path}: stock ${mode}, rebuilt ${rebuilt}`);
  }
  const paths = [...built.keys()];
  for (const path of paths) {
    if (!stock.has(path) && !path.endsWith("/ui/os.ftu")) problems.push(`unexpected ${path}`);
  }
  if (!paths.some((path) => path.endsWith("/ui/os.ftu"))) {
    problems.push("ui/os.ftu was not added to the tree");
  }
  if (problems.length > 0) {
    throw new Error(
      `rebuilt res tree does not match the stock tree (${problems.length} problems):\n  `
        + problems.slice(0, 10).join("\n  ")
        + (problems.length > 10 ? `\n  ...and ${problems.length - 10} more` : ""),
    );
  }
}

/**
 * Produce the res partition image: the stock /res tree with ZOS substituted in.
 *
 * We start from the stock tree rather than assembling a minimal one on purpose.
 * /res carries more than the app — libAEC/libAPC for audio, ui/cacert.pem,
 * font_image/, the language dir EasyUI.cfg points at — and a flashed image that
 * is missing one of them fails on a device whose only remaining way back is adb
 * over the rootfs on mtd2. Substituting three paths into a known-good tree is a
 * much smaller claim than reconstructing one.
 *
 * The base tree comes out of the stock update.img rather than `adb pull /res` so
 * that this build needs no device and is reproducible from the same file the
 * round trip validates. That payload is the 2026-06-08 res build, slightly older
 * than what is on flash; irrelevant here because the app itself is replaced and
 * the rest of /res is static assets.
 */
async function buildResImage(
  stockImage: Buffer,
  bundleDir: string,
  workDir: string,
  restoreDir: string | null,
): Promise<Buffer> {
  requireTool("unsquashfs");
  requireTool("mksquashfs");

  const stockPayload = join(workDir, "stock-res.sqfs");
  await writeFile(stockPayload, stockImage);
  const tree = join(workDir, "resfs");

  // unsquashfs applies the process umask, so a default 022 silently drops the
  // group-write bit from all 233 entries (stock /res is 0770/0750) and every
  // mode in the rebuilt image would differ from stock. Harmless on a read-only
  // filesystem, but it would defeat the mode-parity assertion below — and that
  // assertion is what catches the extraction losing something that matters.
  const previousUmask = process.umask(0);
  try {
    run("unsquashfs", ["-no-progress", "-d", tree, stockPayload]);
  } finally {
    process.umask(previousUmask);
  }

  // Restore mode: the caller's tree IS the payload, verbatim. No substitution,
  // no config rewrite — the point is an image that puts back exactly what was
  // pulled, so anything this function did to it would defeat it. The stock tree
  // extracted above is still used, as the reference the parity assertion
  // compares against.
  if (restoreDir !== null) {
    const stamp = Math.floor((await stat(restoreDir)).mtimeMs / 1000);
    const restoreOut = join(workDir, "restore.sqfs");
    run("mksquashfs", [
      restoreDir, restoreOut,
      "-comp", "xz",
      "-b", String(1 << 17),
      "-force-uid", "1000",
      "-force-gid", "1000",
      "-mkfs-time", String(stamp),
      "-all-time", String(stamp),
      "-noappend",
      "-no-progress",
    ]);
    const restoreImage = await readFile(restoreOut);
    const stockSb = readSuperBlock(stockImage);
    const builtSb = readSuperBlock(restoreImage);
    for (const key of ["blockSize", "compression", "blockLog", "flags", "noIds", "major", "minor"] as const) {
      if (builtSb[key] !== stockSb[key]) {
        throw new Error(
          `restore squashfs ${key}=${builtSb[key]} but stock has ${stockSb[key]}`,
        );
      }
    }
    if (restoreImage.length % IMAGE_ALIGNMENT !== 0) {
      throw new Error(`restore image is ${restoreImage.length} bytes, not aligned`);
    }
    if (restoreImage.length > RES_PARTITION_BYTES) {
      throw new Error(`restore image is ${restoreImage.length} bytes but mtd3 is ${RES_PARTITION_BYTES}`);
    }
    return restoreImage;
  }

  // A flashed image has no /tmp bundle to load from: startupLibPath and resPath
  // must point back into /res or the framework starts nothing. The bundle's cfg
  // is the sideload flavour (/tmp/...), so rewrite exactly those two keys and
  // leave every other setting — baud, uart, touchDev, rotate — alone.
  const cfg = JSON.parse(await readFile(join(bundleDir, "EasyUI.cfg"), "utf8")) as Record<string, unknown>;
  cfg.startupLibPath = "/res/lib/libzkgui.so";
  cfg.resPath = "/res/ui/";
  await replaceInTree(tree, "etc/EasyUI.cfg", Buffer.from(`${JSON.stringify(cfg, null, "\t")}\n`));
  await replaceInTree(tree, "lib/libzkgui.so", await readFile(join(bundleDir, "libzkgui.so")));

  // os.ftu is the one path that does not exist in the stock tree, so there is no
  // mode to preserve — take test.ftu's. Stock ui/*.ftu are 0770, and a fresh
  // file would default to 0644; the framework reads these as root either way,
  // but an image whose modes differ from stock for no reason is a worse image.
  const ftuMode = (await stat(join(tree, "ui/test.ftu"))).mode & 0o7777;
  await writeFile(join(tree, "ui/os.ftu"), await readFile(join(bundleDir, "ui/os.ftu")));
  await chmod(join(tree, "ui/os.ftu"), ftuMode);

  // Match the stock superblock exactly: xz, 128 KiB blocks, one uid/gid pair
  // (the stock image reports no_ids 1, uid/gid 1000). -no-xattrs is deliberately
  // NOT passed: it would set the NO_XATTR flag and make flags 0x2c0 where stock
  // is 0xc0, and the assertion below wants an exact match rather than a
  // "probably also fine". Timestamps are pinned so two runs of the same inputs
  // produce the same bytes.
  const stamp = Math.floor((await stat(join(bundleDir, "libzkgui.so"))).mtimeMs / 1000);
  const out = join(workDir, "res.sqfs");
  run("mksquashfs", [
    tree, out,
    "-comp", "xz",
    "-b", String(1 << 17),
    "-force-uid", "1000",
    "-force-gid", "1000",
    "-mkfs-time", String(stamp),
    "-all-time", String(stamp),
    "-noappend",
    "-no-progress",
  ]);

  assertTreeParity(stockPayload, out);

  const image = await readFile(out);
  const stock = readSuperBlock(stockImage);
  const built = readSuperBlock(image);
  for (const key of ["blockSize", "compression", "blockLog", "flags", "noIds", "major", "minor"] as const) {
    if (built[key] !== stock[key]) {
      throw new Error(
        `rebuilt squashfs ${key}=${built[key]} but the stock res image has ${stock[key]}. `
          + "The device kernel accepts the stock parameters; refusing to ship a filesystem "
          + "built to different ones.",
      );
    }
  }
  if (image.length % IMAGE_ALIGNMENT !== 0) {
    throw new Error(`mksquashfs produced ${image.length} bytes, not ${IMAGE_ALIGNMENT}-aligned`);
  }
  if (image.length > RES_PARTITION_BYTES) {
    throw new Error(
      `res image is ${image.length} bytes but mtd3 is ${RES_PARTITION_BYTES}; `
        + "the updater rejects this at 0x5b70 before erasing anything",
    );
  }
  return image;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const stockPath = resolve(
  flag("stock", process.env.ZKSWE_STOCK_IMAGE ?? join(repoRoot, ".runtime/tc002-stock/update.img")),
);
const bundleDir = resolve(flag("bundle", join(repoRoot, "device/tc002-os/release/bundle")));
const outPath = resolve(flag("out", join(repoRoot, ".runtime/tc002-os/update.img")));
const verifyOnly = process.argv.includes("--verify-only");
const allowStaleBundle = process.argv.includes("--allow-stale-bundle");
const restoreArg = flag("restore", "");
const restoreDir = restoreArg === "" ? null : resolve(restoreArg);

/**
 * Refuses to pack a bundle that is older than the code sitting next to it.
 *
 * This packs `release/bundle/`, which a SEPARATE step (`create-os-release.ts`)
 * fills from the cross-build output. Skip that step and `os-build` → `os-image`
 * still prints every success line it always prints and emits a container of the
 * PREVIOUS build — which then installs perfectly, reboots, and comes back
 * running exactly what it was running before. An evening was spent reading a
 * vendor updater's disassembly over that, looking for the reason an install
 * "did not take", when the image simply had nothing new in it.
 *
 * Compared byte-for-byte rather than by mtime: a rebuild that produces an
 * identical .so is fine to pack, and a bundle copied around loses its
 * timestamps. Silent only when the two agree.
 */
async function assertBundleIsCurrent(dir: string): Promise<void> {
  const builtPath = join(repoRoot, "device/tc002-lyrics-player/flythings-build/libzkgui-os.so");
  let built: Buffer | null = null;
  try {
    built = await readFile(builtPath);
  } catch {
    built = null;
  }
  const staged = await readFile(join(dir, "libzkgui.so"));
  const verdict = judgeBundle(built, staged, allowStaleBundle);
  if (verdict.ok) return;

  const why = verdict.reason === "no-build"
    ? `There is no cross-build output to compare against:\n    ${builtPath}\n`
      + "  Nothing here can tell whether the bundle is current, and a bundle that is not\n"
      + "  current packs the PREVIOUS build.\n"
    : `Bundle is not the build sitting next to it:\n`
      + `    built:  ${builtPath} (${verdict.builtBytes} bytes)\n`
      + `    bundle: ${join(dir, "libzkgui.so")} (${verdict.bundleBytes} bytes)\n`;
  console.error(
    "Refusing to pack.\n  " + why
      + "  Build, then stage it into the bundle:\n"
      + "    mise run os-build\n"
      + "    bun run scripts/create-os-release.ts -- <staging-dir> <version> os\n"
      + "  Or pass --allow-stale-bundle if packing the checked-in bundle is what you mean.\n"
      + "  The failure this prevents is silent: the stale container installs cleanly,\n"
      + "  reboots, and comes back running what it was already running.",
  );
  process.exit(1);
}

if (!verifyOnly) await assertBundleIsCurrent(bundleDir);

let stock: Buffer;
try {
  stock = await readFile(stockPath);
} catch {
  console.error(
    `Stock reference image not found: ${stockPath}\n`
      + "  The round-trip check needs the image the device shipped with. Pull it with:\n"
      + `    adb pull /mnt/storage/update.img ${stockPath}\n`
      + "  or point --stock / ZKSWE_STOCK_IMAGE at a copy. This is a read-only use of the\n"
      + "  device; nothing is written to /mnt/storage.",
  );
  process.exit(1);
}

// Every failure below is a refusal to produce an image, so report it as one
// clear statement rather than a stack trace: the only correct response to any of
// them is "do not flash", and that has to survive being read in a hurry.
try {
  const { image: stockRes, item } = verifyStockRoundTrip(stock);
  console.log(
    `round trip OK — rebuilt ${stock.length} stock bytes exactly `
      + `(type ${item.type} res, ${item.size} byte payload)`,
  );

  if (!verifyOnly) {
    const workDir = await mkdtemp(join(tmpdir(), "tc002-os-image-"));
    try {
      const resImage = await buildResImage(stockRes, bundleDir, workDir, restoreDir);
      const packed = packContainer(resImage, PART_TYPE_RES);

      // Read our own output back with the independent parser before anyone sees
      // it: magic, header arithmetic, header CRC and the in-band MD5 all get
      // re-checked against the bytes on disk rather than against what we
      // intended to write.
      const check = parseContainer(packed);
      if (check.images[0]!.compare(resImage) !== 0) {
        throw new Error("packed image does not read back as the filesystem we built");
      }

      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, packed);
      console.log(
        `wrote ${outPath}\n`
          + `  res filesystem ${resImage.length} bytes `
          + `(${((resImage.length / RES_PARTITION_BYTES) * 100).toFixed(1)}% of mtd3)\n`
          + `  container      ${packed.length} bytes, md5 ${md5(packed).toString("hex")}\n`
          + (restoreDir === null
            ? "  This image REPLACES the stock app with ZOS.\n"
            : `  This image RESTORES ${restoreDir} verbatim — it is a way back, not a change.\n`)
          + "  Flashing is a human step and is NOT performed here. Nothing in this script\n"
          + "  touches the device.",
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(
    `\npack-image refused to emit an image:\n  ${
      error instanceof Error ? error.message.split("\n").join("\n  ") : String(error)
    }\n`,
  );
  process.exit(1);
}
