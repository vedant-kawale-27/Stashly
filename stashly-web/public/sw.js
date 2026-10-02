const CACHE_NAME = "stashly-shell-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/pwa-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok && (request.mode === "navigate" || /\.(?:js|css|svg|webmanifest)$/.test(new URL(request.url).pathname))) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => request.mode === "navigate"
      ? caches.match(request).then((cached) => cached || caches.match("/index.html"))
      : Promise.reject(new Error("Network unavailable"))),
  );
});
