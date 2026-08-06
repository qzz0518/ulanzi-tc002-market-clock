import { inflateRawSync } from "node:zlib";
import { SettingsValidationError } from "./settings.ts";
import type { PixelAssetImportInput, PixelAssetMimeType } from "./pixel-asset-store.ts";

export const ULANZI_PIXEL_ASSET_CATEGORY_ID = "1818114700000000001";
export const ULANZI_PIXEL_ASSET_CLASSIFICATIONS = [0, 6, 8, 11, 12, 13] as const;
export type UlanziPixelAssetClassification = typeof ULANZI_PIXEL_ASSET_CLASSIFICATIONS[number];
export type UlanziPixelAssetSort = "" | "hot" | "star" | "new";

const UGC_ORIGIN = "https://ugc.ulanzistudio.com";
const CDN_ORIGIN = "https://api.ulanzistudio.com";
const CDN_CN_ORIGIN = "https://api_cn.ulanzistudio.com";
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_JSON_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

export interface UlanziPixelAssetListQuery {
  page: number;
  limit: number;
  search: string;
  classificationId: UlanziPixelAssetClassification;
  sort: UlanziPixelAssetSort;
}

export interface UlanziPixelAssetSummary {
  id: string;
  title: string;
  author: string;
  description: string;
  classificationCode: number | null;
  previewPath: string;
  detailUrl: string;
  createdAt: string;
  animatedPreview: boolean;
}

export interface UlanziPixelAssetList {
  count: number;
  page: number;
  limit: number;
  items: UlanziPixelAssetSummary[];
}

export interface UlanziPreviewMedia {
  bytes: Uint8Array;
  contentType: string;
}

interface OfficialResource {
  id?: unknown;
  cateId?: unknown;
  titleCn?: unknown;
  titleEn?: unknown;
  author?: unknown;
  nickname?: unknown;
  overviewZh?: unknown;
  overview?: unknown;
  detailDesc?: unknown;
  classify?: unknown;
  banner?: unknown;
  files?: unknown;
  createTime?: unknown;
  status?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Ulanzi returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function firstPath(value: unknown): string {
  return typeof value === "string" ? value.split(",")[0]?.trim() ?? "" : "";
}

function validateOfficialPath(
  rawPath: string,
  extensions: readonly string[],
  description: string,
  allowedPrefixes: readonly string[] = ["/cdn/uploadPath/upload/"],
): URL {
  if (!allowedPrefixes.some((prefix) => rawPath.startsWith(prefix)) || rawPath.includes("\\")) {
    throw new Error(`Ulanzi returned an invalid ${description} path`);
  }
  let url: URL;
  try {
    url = new URL(rawPath, CDN_ORIGIN);
  } catch {
    throw new Error(`Ulanzi returned an invalid ${description} URL`);
  }
  const decodedSegments = url.pathname.split("/").map((segment) => decodeURIComponent(segment));
  if (
    url.origin !== CDN_ORIGIN
    || !allowedPrefixes.some((prefix) => url.pathname.startsWith(prefix))
    || decodedSegments.includes("..")
    || url.username
    || url.password
    || url.search
    || url.hash
    || !extensions.some((extension) => url.pathname.toLowerCase().endsWith(extension))
  ) {
    throw new Error(`Ulanzi returned an unsupported ${description} path`);
  }
  return url;
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("Ulanzi response is too large");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error("Ulanzi response is too large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("Ulanzi response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function fetchError(response: Response): Error {
  return new Error(`Ulanzi request failed with HTTP ${response.status}`);
}

export function parseUlanziPixelAssetSource(source: unknown): string {
  if (typeof source !== "string" || !source.trim()) {
    throw new SettingsValidationError("请输入 Ulanzi 像素素材链接或作品 ID");
  }
  const value = source.trim();
  if (/^\d{1,20}$/.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsValidationError("Ulanzi 素材链接格式不正确");
  }
  const match = url.pathname.match(/^\/contentView\/(\d{1,20})\/?$/);
  if (
    url.protocol !== "https:"
    || url.hostname !== "ugc.ulanzistudio.com"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || !match
  ) {
    throw new SettingsValidationError("只支持 ugc.ulanzistudio.com 的 contentView 素材链接");
  }
  return match[1]!;
}

function locateEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (
      bytes[offset] === 0x50
      && bytes[offset + 1] === 0x4b
      && bytes[offset + 2] === 0x05
      && bytes[offset + 3] === 0x06
    ) return offset;
  }
  throw new Error("Ulanzi pixel asset ZIP has no central directory");
}

export function extractPixelAssetDataJson(archive: Uint8Array): Uint8Array {
  if (
    archive.byteLength < 22
    || archive[0] !== 0x50
    || archive[1] !== 0x4b
    || archive[2] !== 0x03
    || archive[3] !== 0x04
  ) {
    throw new Error("Ulanzi pixel asset file is not a ZIP archive");
  }
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = locateEndOfCentralDirectory(archive);
  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const entriesOnDisk = view.getUint16(end + 8, true);
  const entryCount = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    disk !== 0
    || directoryDisk !== 0
    || entriesOnDisk !== 1
    || entryCount !== 1
    || directoryOffset + directorySize > end
    || directoryOffset + 46 > archive.byteLength
    || view.getUint32(directoryOffset, true) !== 0x02014b50
  ) {
    throw new Error("Ulanzi pixel asset ZIP layout is unsupported");
  }

  const flags = view.getUint16(directoryOffset + 8, true);
  const method = view.getUint16(directoryOffset + 10, true);
  const compressedSize = view.getUint32(directoryOffset + 20, true);
  const uncompressedSize = view.getUint32(directoryOffset + 24, true);
  const nameLength = view.getUint16(directoryOffset + 28, true);
  const extraLength = view.getUint16(directoryOffset + 30, true);
  const commentLength = view.getUint16(directoryOffset + 32, true);
  const localOffset = view.getUint32(directoryOffset + 42, true);
  const centralEnd = directoryOffset + 46 + nameLength + extraLength + commentLength;
  const name = new TextDecoder().decode(archive.subarray(directoryOffset + 46, directoryOffset + 46 + nameLength));
  if (
    centralEnd > archive.byteLength
    || name !== "data.json"
    || flags & 0x01
    || ![0, 8].includes(method)
    || compressedSize > MAX_ARCHIVE_BYTES
    || uncompressedSize > MAX_ARCHIVE_JSON_BYTES
    || localOffset + 30 > archive.byteLength
    || view.getUint32(localOffset, true) !== 0x04034b50
  ) {
    throw new Error("Ulanzi pixel asset ZIP entry is unsupported");
  }
  const localFlags = view.getUint16(localOffset + 6, true);
  const localMethod = view.getUint16(localOffset + 8, true);
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  if (localFlags & 0x01 || localMethod !== method || dataOffset + compressedSize > archive.byteLength) {
    throw new Error("Ulanzi pixel asset ZIP local entry is invalid");
  }
  const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
  const output = method === 0
    ? compressed.slice()
    : new Uint8Array(inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_JSON_BYTES }));
  if (output.byteLength !== uncompressedSize || output.byteLength > MAX_ARCHIVE_JSON_BYTES) {
    throw new Error("Ulanzi pixel asset ZIP size does not match its directory");
  }
  return output;
}

function decodeArchiveImage(dataJson: Uint8Array): { mimeType: PixelAssetMimeType; bytes: Uint8Array } {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(dataJson));
  } catch {
    throw new Error("Ulanzi pixel asset data.json is invalid");
  }
  const images = asRecord(body).images;
  if (!Array.isArray(images) || images.length < 1 || images.length > 16) {
    throw new Error("Ulanzi pixel asset data.json has no supported image");
  }
  const entries = images.map((value) => asRecord(value)).sort((left, right) =>
    integer(left.index) - integer(right.index)
  );
  const base64 = entries[0]?.base64;
  if (typeof base64 !== "string") throw new Error("Ulanzi pixel asset image data is missing");
  const match = base64.match(/^data:(image\/(?:png|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error("Ulanzi pixel asset image type is unsupported");
  const bytes = new Uint8Array(Buffer.from(match[2]!, "base64"));
  if (bytes.byteLength < 10 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Ulanzi pixel asset image size is unsupported");
  }
  return { mimeType: match[1] as PixelAssetMimeType, bytes };
}

export class UlanziPixelAssetClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs ?? 8_000));
  }

  async list(query: UlanziPixelAssetListQuery): Promise<UlanziPixelAssetList> {
    const url = new URL("/api/api/list", UGC_ORIGIN);
    url.search = new URLSearchParams({
      cateId: ULANZI_PIXEL_ASSET_CATEGORY_ID,
      excludeCateId: "",
      screen: "",
      sort: query.sort,
      isAsc: "asc",
      limit: String(query.limit),
      orderByColumn: "",
      page: String(query.page),
      searchText: query.search,
      classify: String(query.classificationId),
      lang: "zh_CN",
      source: "web",
    }).toString();
    const body = asRecord(await this.fetchJson(url));
    if (integer(body.code) !== 200 || !Array.isArray(body.data)) {
      throw new Error("Ulanzi pixel asset list response is invalid");
    }
    const items = body.data.flatMap((value): UlanziPixelAssetSummary[] => {
      const item = value as OfficialResource;
      const id = nonEmptyString(item.id);
      const previewPath = firstPath(item.banner);
      if (!/^\d{1,20}$/.test(id) || !previewPath) return [];
      try {
        validateOfficialPath(
          previewPath,
          [".png", ".gif", ".jpg", ".jpeg", ".webp"],
          "preview",
          ["/cdn/uploadPath/upload/", "/profile/upload/"],
        );
      } catch {
        return [];
      }
      return [{
        id,
        title: nonEmptyString(item.titleCn, item.titleEn, `素材 ${id}`),
        author: nonEmptyString(item.nickname, item.author, "未署名"),
        description: nonEmptyString(item.overviewZh, item.overview, item.detailDesc),
        classificationCode: Number.isInteger(Number(item.classify)) ? Number(item.classify) : null,
        previewPath,
        detailUrl: `${UGC_ORIGIN}/contentView/${id}`,
        createdAt: nonEmptyString(item.createTime),
        animatedPreview: previewPath.toLowerCase().endsWith(".gif"),
      }];
    });
    return {
      count: Math.max(0, integer(body.count)),
      page: query.page,
      limit: query.limit,
      items,
    };
  }

  async download(source: unknown): Promise<PixelAssetImportInput> {
    const id = parseUlanziPixelAssetSource(source);
    const detailUrl = new URL("/api/api/resources", UGC_ORIGIN);
    detailUrl.search = new URLSearchParams({ id, lang: "zh_CN", source: "web" }).toString();
    const body = asRecord(await this.fetchJson(detailUrl));
    const resource = body.tResources as OfficialResource | undefined;
    if (
      integer(body.code) !== 200
      || !resource
      || nonEmptyString(resource.id) !== id
      || nonEmptyString(resource.cateId) !== ULANZI_PIXEL_ASSET_CATEGORY_ID
      || integer(resource.status, 1) !== 1
    ) {
      throw new Error("Ulanzi pixel asset detail response is invalid");
    }
    const archivePath = firstPath(resource.files);
    const archiveUrl = validateOfficialPath(archivePath, [".zip"], "archive");
    const archive = await this.fetchBytes(archiveUrl, MAX_ARCHIVE_BYTES, ["application/zip", "application/octet-stream"]);
    const image = decodeArchiveImage(extractPixelAssetDataJson(archive.bytes));
    return {
      officialId: id,
      title: nonEmptyString(resource.titleCn, resource.titleEn, `素材 ${id}`),
      author: nonEmptyString(resource.nickname, resource.author, "未署名"),
      sourceUrl: `${UGC_ORIGIN}/contentView/${id}`,
      ...image,
    };
  }

  async preview(rawPath: string): Promise<UlanziPreviewMedia> {
    const url = validateOfficialPath(
      rawPath,
      [".png", ".gif", ".jpg", ".jpeg", ".webp"],
      "preview",
      ["/cdn/uploadPath/upload/", "/profile/upload/"],
    );
    const response = await this.fetchBytes(url, MAX_PREVIEW_BYTES, [
      "image/png", "image/gif", "image/jpeg", "image/webp", "application/octet-stream",
    ]);
    const extension = url.pathname.toLowerCase().split(".").at(-1);
    const fallback = extension === "gif"
      ? "image/gif"
      : extension === "webp"
        ? "image/webp"
        : extension === "jpg" || extension === "jpeg"
          ? "image/jpeg"
          : "image/png";
    return {
      bytes: response.bytes,
      contentType: response.contentType === "application/octet-stream" ? fallback : response.contentType,
    };
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const response = await this.request(url);
    if (!response.ok) throw fetchError(response);
    const bytes = await readBounded(response, MAX_JSON_BYTES);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Ulanzi returned invalid JSON");
    }
  }

  private async fetchBytes(
    url: URL,
    maximumBytes: number,
    acceptedTypes: readonly string[],
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await this.request(url);
    if (!response.ok) throw fetchError(response);
    const contentType = (response.headers.get("content-type") ?? "application/octet-stream")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (!acceptedTypes.includes(contentType)) throw new Error("Ulanzi returned an unsupported content type");
    return { bytes: await readBounded(response, maximumBytes), contentType };
  }

  private async request(url: URL): Promise<Response> {
    if (![UGC_ORIGIN, CDN_ORIGIN].includes(url.origin)) throw new Error("unsupported Ulanzi origin");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const requestOptions: RequestInit = {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/json, image/*, application/zip" },
      };
      let expectedUrl = url;
      let response = await this.fetchImpl(expectedUrl, requestOptions);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        const redirected = location ? new URL(location, expectedUrl) : null;
        if (
          expectedUrl.origin !== CDN_ORIGIN
          || redirected?.origin !== CDN_CN_ORIGIN
          || redirected.pathname !== expectedUrl.pathname
          || redirected.search !== expectedUrl.search
          || redirected.hash !== ""
          || redirected.username !== ""
          || redirected.password !== ""
        ) {
          throw new Error("Ulanzi redirect was rejected");
        }
        expectedUrl = redirected;
        response = await this.fetchImpl(expectedUrl, requestOptions);
        if (response.status >= 300 && response.status < 400) {
          throw new Error("Ulanzi redirect was rejected");
        }
      }
      if (response.url) {
        const finalUrl = new URL(response.url);
        if (
          finalUrl.origin !== expectedUrl.origin
          || finalUrl.pathname !== expectedUrl.pathname
          || finalUrl.search !== expectedUrl.search
        ) throw new Error("Ulanzi changed response URL");
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}
