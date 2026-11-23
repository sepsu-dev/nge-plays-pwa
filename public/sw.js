/* eslint-disable no-restricted-globals */
/**
 * Nge-Plays service worker.
 *
 * Goals:
 *  - make the app installable (a fetch handler is required for the install prompt),
 *  - keep the shell usable offline,
 *  - never cache audio or API responses (they are personalised, ranged, and large).
 *
 * Bump VERSION to invalidate every cache on deploy.
 */
const VERSION = "v1";
const SHELL_CACHE = `ngeplay-shell-${VERSION}`;
const ASSET_CACHE = `ngeplay-asset-${VERSION}`;
const OFFLINE_URL = "/offline";
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];
const MAX_ASSET_ENTRIES = 120;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually so one failed request cannot abort the whole install.
      await Promise.all(
        PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {}))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("ngeplay-") && key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key))
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.disable();
      }
      await self.clients.claim();
    })()
  );
});

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type !== "opaque") {
        void cache.put(request, response.clone()).then(() => trimCache(ASSET_CACHE, MAX_ASSET_ENTRIES));
      }
      return response;
    })
    .catch(
      () =>
        cached ||
        new Response("", { status: 504, statusText: "Gateway Timeout" })
    );
  return cached || network;
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // Keep a copy of the shell so a cold offline launch still renders the app.
    if (response && response.ok && response.type === "basic") {
      void cache.put("/", response.clone());
    }
    return response;
  } catch {
    const shell = await cache.match("/");
    if (shell) return shell;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Audio streams are ranged, live, and large: always straight to the network.
  // Range requests must never be answered from a cache, or seeking breaks.
  if (sameOrigin && url.pathname.startsWith("/api/stream/")) return;
  if (request.headers.has("range")) return;

  // Rooms (SSE + POST) and every other API response are live data.
  if (sameOrigin && url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (sameOrigin && (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/"))) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.hostname === "i.ytimg.com" || url.hostname === "lh3.googleusercontent.com") {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// Let the page ask the next deployment to take over immediately.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") void self.skipWaiting();
});
