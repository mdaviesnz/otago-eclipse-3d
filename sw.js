// Service Worker for Otago Eclipse 3D.
//
// Strategy:
//   1. Same-origin app shell & catalogue (index.html, map.html, astronomy.html, methods.html,
//      app.css, viewpoints.json): NETWORK-FIRST with offline fallback to cache. Online users
//      always receive the newest deployment immediately; offline users in the field seamlessly
//      get the cached shell and all 800+ precomputed viewing spots.
//   2. CDN libraries (astronomy-engine, Lucide, Leaflet, CesiumJS): CACHE-FIRST with background
//      refresh so the astronomy engine and UI icons work without cellular reception.
//   3. Map & 3D terrain tiles (Esri, Re:Earth): OPPORTUNISTIC CACHE with a bounded LRU cap so
//      areas viewed before heading out remain browsable offline without unbounded disk growth.

const SHELL_CACHE = "otago-eclipse-shell-v1";
const ASSET_CACHE = "otago-eclipse-assets-v1";
const TILE_CACHE = "otago-eclipse-tiles-v1";
const MAX_TILE_ENTRIES = 300;

const PRECACHE_SHELL = [
  "./",
  "./index.html",
  "./map.html",
  "./astronomy.html",
  "./methods.html",
  "./app.css",
  "./viewpoints.json",
  "./manifest.webmanifest",
  "./icon.svg",
];

const PRECACHE_CDN = [
  "https://cdn.jsdelivr.net/npm/astronomy-engine@2/astronomy.browser.min.js",
  "https://unpkg.com/lucide@latest",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await Promise.allSettled(PRECACHE_SHELL.map((url) => shell.add(url)));
      const assets = await caches.open(ASSET_CACHE);
      await Promise.allSettled(PRECACHE_CDN.map((url) => assets.add(url)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE, TILE_CACHE]);
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// Map clean Worker paths (/map, /astronomy, /methods) and query-string deep links
// (/index.html?lat=...&lon=...) to their canonical cached HTML key when offline.
function canonicalHtmlPath(pathname) {
  if (pathname === "/" || pathname === "/index" || pathname === "/index.html") return "./index.html";
  if (pathname === "/map" || pathname === "/map.html") return "./map.html";
  if (pathname === "/astronomy" || pathname === "/astronomy.html") return "./astronomy.html";
  if (pathname === "/methods" || pathname === "/methods.html") return "./methods.html";
  return null;
}

async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    const excess = keys.length - maxItems;
    for (let i = 0; i < excess; i++) {
      await cache.delete(keys[i]);
    }
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept Worker API endpoints, analytics, or live address autocomplete.
  if (
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("cloudflareinsights.com") ||
    url.hostname.includes("photon.komoot.io")
  ) {
    return;
  }

  // 1. Same-origin requests: Network-First so deploys are never stuck behind stale cache.
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            cache.put(request, response.clone());
            const canon = canonicalHtmlPath(url.pathname);
            if (canon) cache.put(canon, response.clone());
          }
          return response;
        } catch (err) {
          const direct = await cache.match(request, { ignoreSearch: true });
          if (direct) return direct;
          const canon = canonicalHtmlPath(url.pathname);
          if (canon) {
            const fallback = await cache.match(canon);
            if (fallback) return fallback;
          }
          throw err;
        }
      })()
    );
    return;
  }

  // 2. CDN libraries (Cesium, Astronomy Engine, Leaflet, Lucide): Cache-First + background update.
  if (
    url.hostname.includes("cdn.jsdelivr.net") ||
    url.hostname.includes("unpkg.com") ||
    url.hostname.includes("cesium.com")
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await networkPromise) || Response.error();
      })()
    );
    return;
  }

  // 3. Terrain & imagery tiles (Re:Earth, Esri): Cache-Fallback with bounded LRU cap.
  if (
    url.hostname.includes("terrain.reearth.land") ||
    url.hostname.includes("arcgisonline.com")
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILE_CACHE);
        try {
          const res = await fetch(request);
          if (res && res.ok) {
            cache.put(request, res.clone());
            trimCache(TILE_CACHE, MAX_TILE_ENTRIES);
          }
          return res;
        } catch (err) {
          const cached = await cache.match(request);
          if (cached) return cached;
          throw err;
        }
      })()
    );
  }
});
