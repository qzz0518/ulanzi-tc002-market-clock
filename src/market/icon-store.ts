import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { PixelCanvas } from "../pixel-ui.ts";
import { renderInstrumentFallbackIcon } from "./fallback-icon.ts";
import {
  encodePixelLogoPng,
  isLogoVariantId,
  LOGO_PIPELINE_VERSION,
  pixelLogoToCanvas,
  type LogoVariantId,
  type PixelLogoBitmap,
} from "./pixel-logo.ts";
import {
  ICON_REF_PATTERN,
  INSTRUMENT_REF_PATTERN,
  type MarketInstrumentDraft,
} from "./instruments.ts";

interface MarketIconManifestBase {
  version: 1;
  ref: string;
  instrumentRef: string;
  width: 16;
  height: 16;
  pixelSha256: string;
  blobRef: string;
  derivationKey: string;
  createdAt: string;
}

export interface FallbackIconManifest extends MarketIconManifestBase {
  mode: "fallback";
  pipelineVersion: "fallback-v1";
  sourceType: "fallback";
  licensePolicy: "generated-local";
  reviewStatus: "auto";
}

export interface CatalogIconManifest extends MarketIconManifestBase {
  mode: "catalog";
  pipelineVersion: "catalog-png-v1" | typeof LOGO_PIPELINE_VERSION;
  sourceType: "bundled-open-catalog";
  licensePolicy: "open-catalog";
  reviewStatus: "identity-matched";
  sourceCatalog: string;
  sourceVersion: string;
  licenseSpdx: string;
  sourceAssetId: string;
  sourceAssetName: string;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  variantId: LogoVariantId;
}

export type MarketIconManifest = FallbackIconManifest | CatalogIconManifest;

export interface MarketIconStoreOptions {
  now?: () => number;
}

function validateManifest(value: unknown): MarketIconManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("icon manifest must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || input.width !== 16 || input.height !== 16) {
    throw new Error("icon manifest version is invalid");
  }
  if (input.mode === "fallback") {
    if (
      input.pipelineVersion !== "fallback-v1"
      || input.sourceType !== "fallback"
      || input.licensePolicy !== "generated-local"
      || input.reviewStatus !== "auto"
    ) throw new Error("fallback icon manifest is invalid");
  } else if (input.mode === "catalog") {
    if (
      !["catalog-png-v1", LOGO_PIPELINE_VERSION].includes(String(input.pipelineVersion))
      || input.sourceType !== "bundled-open-catalog"
      || input.licensePolicy !== "open-catalog"
      || input.reviewStatus !== "identity-matched"
      || typeof input.sourceCatalog !== "string"
      || !/^[a-z0-9][a-z0-9/._-]{1,79}$/.test(input.sourceCatalog)
      || typeof input.sourceVersion !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/.test(input.sourceVersion)
      || typeof input.licenseSpdx !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$/.test(input.licenseSpdx)
      || typeof input.sourceAssetId !== "string"
      || !/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(input.sourceAssetId)
      || typeof input.sourceAssetName !== "string"
      || input.sourceAssetName.trim().length < 1
      || input.sourceAssetName.length > 120
      || typeof input.sourceSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(input.sourceSha256)
      || !Number.isInteger(input.sourceWidth)
      || Number(input.sourceWidth) < 1
      || Number(input.sourceWidth) > 1_024
      || !Number.isInteger(input.sourceHeight)
      || Number(input.sourceHeight) < 1
      || Number(input.sourceHeight) > 1_024
      || !isLogoVariantId(input.variantId)
    ) throw new Error("catalog icon manifest is invalid");
  } else {
    throw new Error("icon manifest mode is invalid");
  }
  if (typeof input.ref !== "string" || !ICON_REF_PATTERN.test(input.ref)) throw new Error("icon ref is invalid");
  if (typeof input.instrumentRef !== "string" || !INSTRUMENT_REF_PATTERN.test(input.instrumentRef)) {
    throw new Error("icon instrumentRef is invalid");
  }
  for (const key of ["pixelSha256", "blobRef", "derivationKey"] as const) {
    if (typeof input[key] !== "string" || !/^[a-f0-9]{64}$/.test(input[key])) {
      throw new Error(`icon ${key} is invalid`);
    }
  }
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("icon createdAt is invalid");
  }
  return input as unknown as MarketIconManifest;
}

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class MarketIconStore {
  private readonly now: () => number;
  private readonly manifests = new Map<string, MarketIconManifest>();
  private issues: string[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly directory: string, options: MarketIconStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private get manifestsDirectory(): string {
    return join(this.directory, "manifests");
  }

  private get blobsDirectory(): string {
    return join(this.directory, "blobs");
  }

  async load(): Promise<void> {
    this.manifests.clear();
    this.issues = [];
    await mkdir(this.manifestsDirectory, { recursive: true });
    await mkdir(this.blobsDirectory, { recursive: true });
    const entries = (await readdir(this.manifestsDirectory)).filter((name) => name.endsWith(".json")).sort();
    for (const name of entries) {
      try {
        const manifest = validateManifest(JSON.parse(await readFile(join(this.manifestsDirectory, name), "utf8")));
        if (name !== `${manifest.ref}.json`) throw new Error("file name does not match icon ref");
        const bytes = new Uint8Array(await readFile(join(this.blobsDirectory, `${manifest.blobRef}.png`)));
        if (hash(bytes) !== manifest.blobRef) throw new Error("icon blob hash does not match its manifest");
        const decoded = PNG.sync.read(Buffer.from(bytes));
        if (decoded.width !== 16 || decoded.height !== 16) throw new Error("icon blob must be 16x16");
        if (hash(new Uint8Array(decoded.data)) !== manifest.pixelSha256) {
          throw new Error("icon pixel hash does not match its manifest");
        }
        this.manifests.set(manifest.ref, manifest);
      } catch (error) {
        this.issues.push(`${name}: ${error instanceof Error ? error.message : "invalid icon"}`);
      }
    }
  }

  get(ref: string): MarketIconManifest | undefined {
    const manifest = this.manifests.get(ref);
    return manifest ? structuredClone(manifest) : undefined;
  }

  has(ref: string): boolean {
    return this.manifests.has(ref);
  }

  getIssues(): string[] {
    return [...this.issues];
  }

  private async persist(
    manifest: MarketIconManifest,
    png: Uint8Array,
  ): Promise<MarketIconManifest> {
    const ref = manifest.ref;
    const operation = async () => {
      const known = this.manifests.get(ref);
      if (known) return;
      await mkdir(this.manifestsDirectory, { recursive: true });
      await mkdir(this.blobsDirectory, { recursive: true });
      const blobPath = join(this.blobsDirectory, `${manifest.blobRef}.png`);
      try {
        await readFile(blobPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const temporaryBlob = `${blobPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        await Bun.write(temporaryBlob, png);
        await rename(temporaryBlob, blobPath);
      }
      const manifestPath = join(this.manifestsDirectory, `${ref}.json`);
      const temporaryManifest = `${manifestPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await Bun.write(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
      await rename(temporaryManifest, manifestPath);
      this.manifests.set(ref, manifest);
    };
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.then(() => undefined, () => undefined);
    await queued;
    return structuredClone(this.manifests.get(ref)!);
  }

  async saveFallback(
    instrument: MarketInstrumentDraft & { ref: string },
  ): Promise<MarketIconManifest> {
    const canvas = renderInstrumentFallbackIcon(instrument);
    const png = canvas.toPng();
    const pixelSha256 = hash(canvas.pixels);
    const blobRef = hash(png);
    const derivationKey = hash(`${instrument.canonicalKey}:fallback-v1:16x16`);
    const ref = `ico_${hash(`${instrument.ref}:${pixelSha256}:${derivationKey}`).slice(0, 32)}`;
    const existing = this.manifests.get(ref);
    if (existing) return structuredClone(existing);
    const manifest = validateManifest({
      version: 1,
      ref,
      instrumentRef: instrument.ref,
      mode: "fallback",
      pipelineVersion: "fallback-v1",
      sourceType: "fallback",
      licensePolicy: "generated-local",
      reviewStatus: "auto",
      width: 16,
      height: 16,
      pixelSha256,
      blobRef,
      derivationKey,
      createdAt: new Date(this.now()).toISOString(),
    });
    return this.persist(manifest, png);
  }

  async saveCatalog(input: {
    instrumentRef: string;
    bitmap: PixelLogoBitmap;
    sourceCatalog: string;
    sourceVersion: string;
    licenseSpdx: string;
    sourceAssetId: string;
    sourceAssetName: string;
    sourceSha256: string;
    sourceWidth: number;
    sourceHeight: number;
    variantId: LogoVariantId;
  }): Promise<MarketIconManifest> {
    if (!INSTRUMENT_REF_PATTERN.test(input.instrumentRef)) throw new Error("icon instrumentRef is invalid");
    if (!/^[a-f0-9]{64}$/.test(input.sourceSha256)) throw new Error("icon source hash is invalid");
    if (!isLogoVariantId(input.variantId)) throw new Error("icon variant is invalid");
    const png = encodePixelLogoPng(input.bitmap);
    const pixelSha256 = hash(input.bitmap.pixels);
    const blobRef = hash(png);
    const derivationKey = hash([
      input.sourceSha256,
      input.sourceCatalog,
      input.sourceVersion,
      input.sourceAssetId,
      LOGO_PIPELINE_VERSION,
      input.variantId,
      "16x16",
      "alpha-box-palette12-black-contrast",
    ].join(":"));
    const ref = `ico_${hash(`${input.instrumentRef}:${pixelSha256}:${derivationKey}`).slice(0, 32)}`;
    const existing = this.manifests.get(ref);
    if (existing) return structuredClone(existing);
    const manifest = validateManifest({
      version: 1,
      ref,
      instrumentRef: input.instrumentRef,
      mode: "catalog",
      pipelineVersion: LOGO_PIPELINE_VERSION,
      sourceType: "bundled-open-catalog",
      licensePolicy: "open-catalog",
      reviewStatus: "identity-matched",
      sourceCatalog: input.sourceCatalog,
      sourceVersion: input.sourceVersion,
      licenseSpdx: input.licenseSpdx,
      sourceAssetId: input.sourceAssetId,
      sourceAssetName: input.sourceAssetName,
      sourceSha256: input.sourceSha256,
      sourceWidth: input.sourceWidth,
      sourceHeight: input.sourceHeight,
      variantId: input.variantId,
      width: 16,
      height: 16,
      pixelSha256,
      blobRef,
      derivationKey,
      createdAt: new Date(this.now()).toISOString(),
    });
    return this.persist(manifest, png);
  }

  async getPng(ref: string): Promise<Uint8Array> {
    const manifest = this.manifests.get(ref);
    if (!manifest) throw new Error(`market icon not found: ${ref}`);
    const bytes = new Uint8Array(await readFile(join(this.blobsDirectory, `${manifest.blobRef}.png`)));
    if (hash(bytes) !== manifest.blobRef) throw new Error(`market icon blob is corrupt: ${ref}`);
    return bytes;
  }

  async getCanvas(ref: string): Promise<PixelCanvas> {
    const bytes = await this.getPng(ref);
    const decoded = PNG.sync.read(Buffer.from(bytes));
    if (decoded.width !== 16 || decoded.height !== 16) throw new Error("market icon must be 16x16");
    if (hash(new Uint8Array(decoded.data)) !== this.manifests.get(ref)!.pixelSha256) {
      throw new Error(`market icon pixels are corrupt: ${ref}`);
    }
    return pixelLogoToCanvas({
      width: 16,
      height: 16,
      pixels: new Uint8Array(decoded.data),
    });
  }
}
