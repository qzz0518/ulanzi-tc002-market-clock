import { createHash } from "node:crypto";
import { ASSET_PRESETS, isAssetId, type AssetId } from "./assets.ts";
import type { DashboardController } from "./controller.ts";
import { renderAssetIconTile } from "./pixel-ui.ts";
import { SettingsValidationError } from "./settings.ts";
import { controlPageHtml } from "./web-ui.ts";

const CLOCK_FRAME_FILE = Bun.file(new URL("./assets/tc002-frame.png", import.meta.url));

export interface ControlApiOptions {
  onSettingsChanged?: () => void;
}

interface IconAsset {
  bytes: Uint8Array;
  version: string;
}

const ICON_ASSETS = new Map<AssetId, IconAsset>(
  ASSET_PRESETS.map((preset) => {
    const bytes = renderAssetIconTile(preset.id).toPng();
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
  if (contentLength > 64 * 1024) {
    throw new SettingsValidationError("request body is too large");
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new SettingsValidationError("Content-Type must be application/json");
  }
  try {
    return await request.json();
  } catch {
    throw new SettingsValidationError("request body must contain valid JSON");
  }
}

export function createControlHandler(
  controller: DashboardController,
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
              "style-src 'unsafe-inline'",
              "script-src 'unsafe-inline'",
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

      if (request.method === "POST" && url.pathname === "/api/push") {
        assertSameOrigin(request);
        const state = await controller.pushNow("manual");
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
