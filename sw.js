/* DAPRES Parent Portal — service worker
 * App-shell caching only. Firebase RTDB/Auth calls always go to the
 * network (never cached here) — attendance data must never be served
 * stale from cache. Bump CACHE_NAME on every deploy so old clients pick
 * up the new shell instead of being stuck on a cached index.html.
 */
const CACHE_NAME = "dapres-parent-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./js/firebase-init.js",
  "./js/app.js",
  "./js/icons.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./assets/athstudios-logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept Firebase (RTDB/Auth/FCM) or any cross-origin call —
  // those must always hit the network live.
  if (
    url.origin.includes("firebaseio.com") ||
    url.origin.includes("googleapis.com") ||
    url.origin.includes("firebaseapp.com") ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (event.request.method === "GET" && networkResponse.ok) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
