const CACHE = "handoff-v4";
const PRECACHE_ASSETS = [
  "/", "/index.html", "/styles.css", "/app.js",
  "/manifest.webmanifest",
  "/vendor/qrcodegen.js", "/vendor/qrdraw-wrapper.js",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n !== CACHE).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Keep POSTs (e.g., share-target), other non-GET requests, and cross-origin untouched
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Never cache API calls
  if (url.pathname.startsWith("/api/")) return;

  const isNavigate = req.mode === "navigate" ||
    (req.headers.get("Accept") || "").includes("text/html");

  // Network-first for navigations and core app shell
  const isCore =
    isNavigate ||
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/app.js" ||
    url.pathname === "/styles.css";

  // Cache-first for vendor and icons
  const isStaticFast =
    url.pathname.startsWith("/vendor/") ||
    url.pathname.startsWith("/icons/");

  if (!isCore && !isStaticFast && url.pathname !== "/manifest.webmanifest") {
    // Bypass for anything else (e.g., websocket, downloads, etc.)
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    if (isStaticFast || url.pathname === "/manifest.webmanifest") {
      const cached = await cache.match(req);
      if (cached) return cached;
      const net = await fetch(req);
      // Avoid caching error responses
      if (net.ok) cache.put(req, net.clone());
      return net;
    }

    // Network-first for navigations and core
    try {
      const net = await fetch(req);
      if (net && net.ok) {
        cache.put(req, net.clone());
      }
      return net;
    } catch {
      // Offline fallback to cached shell
      const fallback = await cache.match(url.pathname) ||
                       await cache.match("/index.html") ||
                       await cache.match("/");
      if (fallback) return fallback;
      // As a last resort, rethrow
      throw new Error("offline");
    }
  })());
});

