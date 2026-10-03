/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

// Stashly Service Worker — caches app shell assets only.
// File content is NOT cached here to ensure files become inaccessible
// when the Android node stops sharing (zero-knowledge relay model).
// Encrypted full-file caching will be added later with explicit
// invalidation when sharing stops.

const SHELL_CACHE = "stashly-shell-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/pwa-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k.startsWith("stashly-"))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Only cache same-origin static assets (app shell)
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok && (request.mode === "navigate" || /\.(?:js|css|svg|webmanifest)$/.test(url.pathname))) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => request.mode === "navigate"
      ? caches.match(request).then((cached) => cached || caches.match("/index.html"))
      : Promise.reject(new Error("Network unavailable")))
  );
});
