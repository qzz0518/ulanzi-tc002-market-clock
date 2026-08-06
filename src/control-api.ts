import { createHash } from "node:crypto";
import { ASSET_PRESETS, isAssetId, type AssetId } from "./assets.ts";
import { getContentCatalog } from "./content-registry.ts";
import type { DashboardController } from "./controller.ts";
import { renderAssetIconTile } from "./pixel-ui.ts";
import { SettingsValidationError } from "./settings.ts";
import { getStockIconPng, isStockIconId } from "./stock-icons.ts";
import { controlPageHtml } from "./web-ui.ts";
import { WORKSPACE_LIMITS, type ChannelConfig } from "./workspace.ts";
import type { WorkspaceController } from "./workspace-controller.ts";
import type { PixelAssetStore } from "./pixel-asset-store.ts";
import {
  ULANZI_PIXEL_ASSET_CLASSIFICATIONS,
  type UlanziPixelAssetClassification,
  type UlanziPixelAssetSort,
  type UlanziPixelAssetClient,
} from "./ulanzi-pixel-assets.ts";

const CLOCK_FRAME_FILE = Bun.file(new URL("./assets/tc002-frame.png", import.meta.url));
const WEB_ASSETS = new Map([
  ["/assets/studio.css", {
    url: new URL("../dist/assets/studio.css", import.meta.url),
    type: "text/css; charset=utf-8",
  }],
  ["/assets/studio.js", {
    url: new URL("../dist/assets/studio.js", import.meta.url),
    type: "text/javascript; charset=utf-8",
  }],
]);

export interface ControlApiOptions {
  onSettingsChanged?: () => void;
  pixelAssetLibrary?: {
    client: UlanziPixelAssetClient;
    store: PixelAssetStore;
  };
}

interface IconAsset {
  bytes: Uint8Array;
  version: string;
}

const ICON_ASSETS = new Map<AssetId, IconAsset>(
  ASSET_PRESETS.map((preset) => {
    const bytes = isStockIconId(preset.id)
      ? getStockIconPng(preset.id)
      : renderAssetIconTile(preset.id).toPng();
    return [
      preset.id,
      {
        bytes,
        version: createHash("sha256").update(bytes).digest("hex").slice(0, 12),
      },
    ];
  }),
);

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function arrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  const requestUrl = new URL(request.url);
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new SettingsValidationError("request origin is invalid");
  }
  if (originUrl.protocol !== requestUrl.protocol || originUrl.host !== requestUrl.host) {
    throw new SettingsValidationError("cross-origin changes are not allowed");
  }
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > WORKSPACE_LIMITS.maxRequestBytes) {
    throw new SettingsValidationError("request body is too large");
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new SettingsValidationError("Content-Type must be application/json");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > WORKSPACE_LIMITS.maxRequestBytes) {
    throw new SettingsValidationError("request body is too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SettingsValidationError("request body must contain valid JSON");
  }
}

type ControlController = DashboardController | WorkspaceController;

function supportsWorkspace(controller: ControlController): controller is WorkspaceController {
  return "getWorkspace" in controller && "previewChannel" in controller;
}

function boundedQueryInteger(
  url: URL,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SettingsValidationError(`${key} is invalid`);
  }
  return value;
}

function previewResponse(preview: {
  image: Uint8Array;
  mimeType: string;
  animationDurationMs: number;
  frames: readonly unknown[];
}): Response {
  return new Response(arrayBufferCopy(preview.image), {
    headers: {
      "Content-Type": preview.mimeType,
      "Cache-Control": "no-store",
      "X-Animation-Duration-Ms": String(preview.animationDurationMs),
      "X-Frame-Count": String(preview.frames.length),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function createControlHandler(
  controller: ControlController,
  options: ControlApiOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(controlPageHtml(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Content-Security-Policy": [
              "default-src 'self'",
              "img-src 'self' blob:",
              "style-src 'self' 'unsafe-inline'",
              "script-src 'self'",
              "connect-src 'self'",
              "base-uri 'none'",
              "frame-ancestors 'none'",
              "form-action 'self'",
            ].join("; "),
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
          },
        });
      }

      if (request.method === "GET" && WEB_ASSETS.has(url.pathname)) {
        const asset = WEB_ASSETS.get(url.pathname)!;
        const file = Bun.file(asset.url);
        if (!await file.exists()) {
          return jsonResponse({ error: "web asset is not built" }, 404);
        }
        return new Response(file, {
          headers: {
            "Content-Type": asset.type,
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/favicon.svg") {
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#f4f4f4"/><circle cx="16" cy="16" r="11" fill="#c5f6cc"/><path fill="#159b2d" d="M10 10h5v5h-5zm7 0h5v5h-5zm-7 7h5v5h-5zm7 0h5v5h-5z"/></svg>',
          { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } },
        );
      }

      if (request.method === "GET" && url.pathname === "/assets/tc002-frame.png") {
        return new Response(CLOCK_FRAME_FILE, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const iconMatch = url.pathname.match(/^\/api\/icons\/([a-z]+)\.png$/);
      if (request.method === "GET" && iconMatch) {
        const assetId = iconMatch[1];
        if (!isAssetId(assetId)) return jsonResponse({ error: "unknown asset icon" }, 404);
        const icon = ICON_ASSETS.get(assetId)!;
        return new Response(arrayBufferCopy(icon.bytes), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/presets") {
        return jsonResponse({
          presets: ASSET_PRESETS.map((preset) => ({
            ...preset,
            iconUrl: `/api/icons/${preset.id}.png?v=${ICON_ASSETS.get(preset.id)!.version}`,
          })),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/catalog") {
        return jsonResponse({
          categories: [
            { id: "market", label: "市场" },
            { id: "tools", label: "工具" },
            { id: "visual", label: "视觉" },
            { id: "creative", label: "创作" },
          ],
          contents: getContentCatalog(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/library/ulanzi/pixel-assets") {
        if (!options.pixelAssetLibrary) {
          return jsonResponse({ error: "pixel asset library is unavailable" }, 404);
        }
        const classificationId = boundedQueryInteger(url, "classificationId", 0, 0, 99);
        if (!ULANZI_PIXEL_ASSET_CLASSIFICATIONS.includes(
          classificationId as UlanziPixelAssetClassification,
        )) {
          throw new SettingsValidationError("classificationId is invalid");
        }
        const sort = url.searchParams.get("sort") ?? "";
        if (!["", "hot", "star", "new"].includes(sort)) {
          throw new SettingsValidationError("sort is invalid");
        }
        const search = (url.searchParams.get("search") ?? "").trim();
        if (search.length > 80) throw new SettingsValidationError("search is too long");
        const result = await options.pixelAssetLibrary.client.list({
          page: boundedQueryInteger(url, "page", 1, 1, 1_000),
          limit: boundedQueryInteger(url, "limit", 12, 1, 24),
          search,
          classificationId: classificationId as UlanziPixelAssetClassification,
          sort: sort as UlanziPixelAssetSort,
        });
        return jsonResponse({
          ...result,
          items: result.items.map(({ previewPath, ...item }) => ({
            ...item,
            previewUrl: `/api/library/ulanzi/media?path=${encodeURIComponent(previewPath)}`,
          })),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/library/ulanzi/media") {
        if (!options.pixelAssetLibrary) {
          return jsonResponse({ error: "pixel asset library is unavailable" }, 404);
        }
        const path = url.searchParams.get("path") ?? "";
        if (path.length < 1 || path.length > 1_024) {
          throw new SettingsValidationError("preview path is invalid");
        }
        const media = await options.pixelAssetLibrary.client.preview(path);
        return new Response(arrayBufferCopy(media.bytes), {
          headers: {
            "Content-Type": media.contentType,
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const importedPixelAssetMatch = url.pathname.match(
        /^\/api\/library\/ulanzi\/imported\/([a-f0-9]{64})$/,
      );
      if (request.method === "GET" && importedPixelAssetMatch) {
        if (!options.pixelAssetLibrary) {
          return jsonResponse({ error: "pixel asset library is unavailable" }, 404);
        }
        const media = await options.pixelAssetLibrary.store.getMedia(importedPixelAssetMatch[1]!);
        return new Response(arrayBufferCopy(media.bytes), {
          headers: {
            "Content-Type": media.metadata.mimeType,
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/library/ulanzi/import") {
        if (!options.pixelAssetLibrary) {
          return jsonResponse({ error: "pixel asset library is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request) as { source?: unknown };
        const downloaded = await options.pixelAssetLibrary.client.download(input.source);
        const metadata = await options.pixelAssetLibrary.store.save(downloaded);
        return jsonResponse({
          asset: {
            ...metadata,
            previewUrl: `/api/library/ulanzi/imported/${metadata.ref}`,
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/workspace") {
        if (!supportsWorkspace(controller)) {
          return jsonResponse({ error: "workspace API is unavailable" }, 404);
        }
        return jsonResponse({ workspace: controller.getWorkspace() });
      }

      if (request.method === "PUT" && url.pathname === "/api/workspace") {
        if (!supportsWorkspace(controller)) {
          return jsonResponse({ error: "workspace API is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const workspace = await controller.saveWorkspace(await readJson(request));
        options.onSettingsChanged?.();
        return jsonResponse({ workspace, state: controller.getState() });
      }

      if (request.method === "GET" && url.pathname === "/api/settings") {
        return jsonResponse({ settings: controller.getSettings() });
      }

      if (request.method === "PUT" && url.pathname === "/api/settings") {
        assertSameOrigin(request);
        const settings = await controller.saveSettings(await readJson(request));
        options.onSettingsChanged?.();
        return jsonResponse({ settings });
      }

      if (request.method === "GET" && ["/api/state", "/health"].includes(url.pathname)) {
        return jsonResponse(controller.getState());
      }

      if (request.method === "POST" && url.pathname === "/api/preview") {
        assertSameOrigin(request);
        const contentLength = Number(request.headers.get("Content-Length") ?? 0);
        const settings = contentLength > 0 ? await readJson(request) : undefined;
        const preview = await controller.preview(settings);
        return previewResponse(preview);
      }

      if (request.method === "POST" && url.pathname === "/api/channels/preview") {
        if (!supportsWorkspace(controller)) {
          return jsonResponse({ error: "workspace API is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request) as {
          channelId?: unknown;
          channel?: unknown;
          forceRefresh?: unknown;
        };
        const target = typeof input.channelId === "string"
          ? input.channelId
          : input.channel as ChannelConfig;
        if (!target) throw new SettingsValidationError("channelId or channel is required");
        return previewResponse(await controller.previewChannel(target, input.forceRefresh === true));
      }

      if (request.method === "POST" && url.pathname === "/api/channels/push") {
        if (!supportsWorkspace(controller)) {
          return jsonResponse({ error: "workspace API is unavailable" }, 404);
        }
        assertSameOrigin(request);
        const input = await readJson(request) as { channelId?: unknown };
        if (typeof input.channelId !== "string") {
          throw new SettingsValidationError("channelId is required");
        }
        return jsonResponse({ state: await controller.pushChannel(input.channelId) });
      }

      if (request.method === "POST" && url.pathname === "/api/push") {
        assertSameOrigin(request);
        const state = supportsWorkspace(controller)
          ? await controller.pushAll("manual")
          : await controller.pushNow("manual");
        return jsonResponse({ state });
      }

      return jsonResponse({ error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown control error";
      return jsonResponse(
        { error: message },
        error instanceof SettingsValidationError ? 400 : 503,
      );
    }
  };
}
