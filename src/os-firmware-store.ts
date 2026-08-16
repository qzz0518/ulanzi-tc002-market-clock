/**
 * Which firmware image this clock would install, and where an uploaded one goes.
 *
 * WHY THERE ARE TWO PATHS
 * -----------------------
 * `.runtime/tc002-os/update.img` is what `mise run os-image` writes and what the
 * device fetches. Accepting an upload into that same path would mean the next
 * local pack silently replaces the owner's image — the console would still say
 * "an image is ready", the install would still succeed, and the clock would come
 * back running something nobody chose. That failure is not hypothetical: an
 * evening was already spent on its sibling (a stale bundle packing the previous
 * build, installing cleanly, and changing nothing — see release/bundle-gate.ts).
 *
 * So the two writers get two paths and neither can reach the other's:
 *
 *   .runtime/tc002-os/update.img            ← `mise run os-image` only
 *   .runtime/tc002-os/uploaded/update.img   ← POST /api/os/firmware only
 *   .runtime/tc002-os/uploaded/upload.json  ← where that file came from
 *
 * An upload wins when both exist. Uploading is the more deliberate act — someone
 * chose a file and read back what arrived — while `os-image` runs on every build.
 * The packed image is then *reported as shadowed* rather than quietly ignored:
 * "there is a locally packed image and it is NOT the one that will be installed"
 * is precisely the sentence whose absence costs an evening. Removing the upload
 * (DELETE) puts the packed image back in charge, so the choice is reversible
 * from the console rather than only from a shell.
 *
 * Nothing here installs anything. Arming an image and installing it are two acts
 * on purpose: the second one ends in an erase of mtd3, which has no A/B pair and
 * no recovery slot behind it.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAGIC,
  MAGIC_BYTES,
  EI_BYTES,
  HEAD_BYTES,
  inspectZkswe,
  type ZksweFacts,
  type ZksweVerdict,
} from "../device/tc002-os/release/zkswe-image.ts";

export type { ZksweFacts, ZksweVerdict };

/** Where an armed image came from. The console shows this next to the install button. */
export interface OsFirmwareOrigin {
  kind: "upload" | "packed";
  /** The name the file had on the owner's machine. Null for packed images. */
  fileName: string | null;
  /** Upload received / image packed, epoch ms on the service's clock. */
  at: number;
}

/** The cheap read: enough to serve the file and to answer "is anything armed". */
export interface ArmedFirmware {
  path: string;
  bytes: number;
  mtimeMs: number;
  /**
   * The in-band MD5 the updater itself verifies, i.e. a digest of exactly what
   * lands in mtd3. Published as the ETag / X-Build-Id. A header that does not
   * parse falls back to size+mtime rather than refusing to serve: the gate on a
   * corrupt image is the device's own CRC and MD5 checks, not this.
   */
  buildId: string;
  origin: OsFirmwareOrigin;
}

/** The full read, for the console's summary. Costs one pass over the file. */
export interface FirmwareSummary {
  armed: ArmedFirmware | null;
  /** Facts derived from the bytes on disk; null when the container does not parse. */
  facts: ZksweFacts | null;
  /**
   * A locally packed image that exists but will NOT be installed, because an
   * upload is armed. Null when there is nothing being shadowed.
   */
  shadowed: { bytes: number; builtAt: number } | null;
}

const UPLOAD_DIR = "uploaded";
const UPLOAD_FILE = "update.img";
const UPLOAD_META = "upload.json";

interface UploadMeta {
  fileName: string;
  receivedAt: number;
}

/**
 * Facts cost a full read plus an MD5 of up to 8 MiB, and the status route is
 * read by every open settings dialog. Keyed by the file's own identity so a
 * repack or a new upload invalidates it — a path alone would serve yesterday's
 * numbers for today's file, which is the exact class of lie this module exists
 * to stop.
 */
const factsCache = new Map<string, { key: string; facts: ZksweFacts | null }>();

export class OsFirmwareStore {
  /** `mise run os-image` output. This class never writes here. */
  readonly packedPath: string;
  readonly uploadPath: string;
  private readonly uploadMetaPath: string;

  constructor(packedPath: string) {
    this.packedPath = packedPath;
    const dir = join(dirname(packedPath), UPLOAD_DIR);
    this.uploadPath = join(dir, UPLOAD_FILE);
    this.uploadMetaPath = join(dir, UPLOAD_META);
  }

  /**
   * The image the device would fetch, or null. Reads only the first kilobyte —
   * this is on the device-facing GET, which must not start hashing a megabyte
   * every time the clock checks in.
   */
  async armed(): Promise<ArmedFirmware | null> {
    return (await this.readAt(this.uploadPath, "upload"))
      ?? (await this.readAt(this.packedPath, "packed"));
  }

  /** Everything the console shows. One full read of the armed image. */
  async describe(): Promise<FirmwareSummary> {
    const armed = await this.armed();
    if (armed === null) return { armed: null, facts: null, shadowed: null };
    const facts = await this.factsFor(armed);
    let shadowed: FirmwareSummary["shadowed"] = null;
    if (armed.origin.kind === "upload") {
      const packed = Bun.file(this.packedPath);
      if (await packed.exists()) {
        shadowed = { bytes: packed.size, builtAt: packed.lastModified };
      }
    }
    return { armed, facts, shadowed };
  }

  /**
   * Validate, then arm. NOTHING is written unless the verdict is ok — a file
   * that fails here never becomes the armed image, not even briefly, because
   * "briefly" is long enough for a concurrent install to pick it up.
   *
   * The write itself goes through a temporary name and a rename so a truncated
   * upload cannot be served: on the same filesystem, rename is atomic.
   */
  async storeUpload(bytes: Buffer, fileName: string): Promise<ZksweVerdict> {
    const verdict = inspectZkswe(bytes);
    if (!verdict.ok) return verdict;
    await mkdir(dirname(this.uploadPath), { recursive: true });
    const staging = `${this.uploadPath}.part`;
    await writeFile(staging, bytes);
    await rename(staging, this.uploadPath);
    // Written after the image, so a crash between the two leaves an armed image
    // whose provenance is merely thinner (an upload with no remembered name),
    // never a name pointing at bytes that are not there.
    const meta: UploadMeta = { fileName, receivedAt: Date.now() };
    await writeFile(this.uploadMetaPath, `${JSON.stringify(meta, null, 2)}\n`);
    return verdict;
  }

  /** Drop the upload and hand the packed image back its turn. */
  async clearUpload(): Promise<boolean> {
    const existed = await Bun.file(this.uploadPath).exists();
    await rm(this.uploadPath, { force: true });
    await rm(this.uploadMetaPath, { force: true });
    return existed;
  }

  private async readAt(path: string, kind: OsFirmwareOrigin["kind"]): Promise<ArmedFirmware | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const bytes = file.size;
    const mtimeMs = file.lastModified;
    // eiOffset is a u8, so the in-band digest can never sit past byte 780.
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    const md5At = (head[18] ?? 0) + EI_BYTES;
    const parsed = head.length >= md5At + HEAD_BYTES
      && Buffer.from(head.subarray(0, MAGIC_BYTES)).equals(MAGIC.subarray(0, MAGIC_BYTES));
    const upload = kind === "upload" ? await this.readUploadMeta() : null;
    return {
      path,
      bytes,
      mtimeMs,
      buildId: parsed
        ? Buffer.from(head.subarray(md5At, md5At + HEAD_BYTES)).toString("hex")
        : `${bytes}-${mtimeMs}`,
      origin: {
        kind,
        fileName: upload?.fileName ?? null,
        // The upload's own stamp when we have it; the file's mtime otherwise,
        // which for the packer's output is when it was packed.
        at: upload?.receivedAt ?? mtimeMs,
      },
    };
  }

  private async readUploadMeta(): Promise<UploadMeta | null> {
    try {
      const raw = JSON.parse(await readFile(this.uploadMetaPath, "utf8")) as Partial<UploadMeta>;
      const fileName = typeof raw.fileName === "string" && raw.fileName.trim() !== ""
        ? raw.fileName.trim()
        : null;
      const receivedAt = typeof raw.receivedAt === "number" && Number.isFinite(raw.receivedAt)
        ? raw.receivedAt
        : null;
      if (fileName === null || receivedAt === null) return null;
      return { fileName, receivedAt };
    } catch {
      // A hand-edited or half-written sidecar costs the provenance line, not the
      // image: the bytes on disk are still the armed image and still describable.
      return null;
    }
  }

  private async factsFor(armed: ArmedFirmware): Promise<ZksweFacts | null> {
    // Size and mtime alone would collide for two same-sized files written in
    // the same millisecond — plausible for two small uploads in a row. The
    // in-band digest is already in hand from the cheap read, and two files with
    // the same size, mtime and payload MD5 are the same file.
    const key = `${armed.bytes}:${armed.mtimeMs}:${armed.buildId}`;
    const cached = factsCache.get(armed.path);
    if (cached?.key === key) return cached.facts;
    let facts: ZksweFacts | null = null;
    try {
      const verdict = inspectZkswe(Buffer.from(await Bun.file(armed.path).arrayBuffer()));
      facts = verdict.ok ? verdict.facts : null;
    } catch {
      facts = null;
    }
    factsCache.set(armed.path, { key, facts });
    return facts;
  }
}

/**
 * The original filename, reduced to something safe to store and show.
 *
 * It is only ever displayed and written into a JSON sidecar — never used to
 * build a path — but it still gets stripped of directory separators and control
 * characters, because "only ever displayed" is a property of today's code.
 */
export function sanitizeUploadName(raw: unknown): string {
  const name = typeof raw === "string" ? raw : "";
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .trim()
    .slice(0, 120);
  return cleaned === "" ? "update.img" : cleaned;
}
