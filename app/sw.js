// Lock School PWA service worker — enables install + offline use on the truck.
//
// Strategy (no precache manifest to maintain):
//   • navigations      → network-first, fall back to the cached app shell offline
//   • static assets     → cache-first; Expo's filenames are content-hashed and
//                         immutable, so a new deploy = new URLs = automatic
//                         refresh. We just drop old caches on activate.
// Scope is the SW's own directory (the app subpath), so it only governs the app.
const VERSION = "v1";
const CACHE = `lock-school-${VERSION}`;
const SHELL = "index.html"; // resolved against the SW scope

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.add(new Request(SHELL, { cache: "reload" })))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return; // leave cross-origin alone

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(SHELL).then((r) => r || caches.match(req))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req)
        .then((res) => {
          if (res.ok && (res.type === "basic" || res.type === "default")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached),
    ),
  );
});
