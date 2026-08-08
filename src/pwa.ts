import { PixelCanvas } from "./pixel-ui.ts";

export const PWA_CACHE_NAME = "pixel-market-v3.2";

export const PWA_MANIFEST = {
  id: "/",
  name: "Pixel Market · Ulanzi TC002",
  short_name: "Pixel Market",
  description: "在手机或电脑上设置 Ulanzi TC002 的频道、内容与像素画板。",
  lang: "zh-CN",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f5f5f2",
  theme_color: "#f5f5f2",
  icons: [
    { src: "/icons/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
} as const;

function renderIcon(size: number, maskable = false): Uint8Array {
  const background = maskable ? [226, 244, 225] as const : [245, 245, 242] as const;
  const canvas = new PixelCanvas(size, size, background);
  const markSize = Math.round(size * (maskable ? 0.48 : 0.58));
  const markStart = Math.floor((size - markSize) / 2);
  const gap = Math.max(2, Math.round(markSize * 0.11));
  const cell = Math.floor((markSize - gap) / 2);
  const green = [20, 148, 43] as const;
  canvas.fillRect(markStart, markStart, cell, cell, green);
  canvas.fillRect(markStart + cell + gap, markStart, cell, cell, green);
  canvas.fillRect(markStart, markStart + cell + gap, cell, cell, green);
  canvas.fillRect(markStart + cell + gap, markStart + cell + gap, cell, cell, green);
  return canvas.toPng();
}

export const PWA_ICONS = new Map<string, Uint8Array>([
  ["/icons/pwa-192.png", renderIcon(192)],
  ["/icons/pwa-512.png", renderIcon(512)],
  ["/icons/pwa-maskable-512.png", renderIcon(512, true)],
  ["/icons/apple-touch-icon.png", renderIcon(180)],
]);

export function pwaServiceWorker(): string {
  const shell = [
    "/",
    "/assets/studio.css",
    "/assets/studio.js",
    "/assets/tc002-frame.png",
    "/favicon.svg",
    "/manifest.webmanifest",
    "/icons/pwa-192.png",
    "/icons/pwa-512.png",
  ];
  return `const CACHE_NAME = ${JSON.stringify(PWA_CACHE_NAME)};
const SHELL = ${JSON.stringify(shell)};
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/health") return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
      return response;
    }).catch(() => caches.match(request).then((cached) => cached || caches.match("/"))));
    return;
  }
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match(request)));
});
`;
}
