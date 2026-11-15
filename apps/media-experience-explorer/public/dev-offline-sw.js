// DEV_ONLY app-shell cache for the project timeline page, so a reload while offline still opens the page and its
// encrypted offline drafts. It caches ONLY same-origin GET responses for the page and its modules, never /dev/v1 or
// /api/v1 (host responses, tokens and drafts are never cached here). Network first: online always wins.
const CACHE = "media-dev-offline-shell-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin
    || url.pathname.startsWith("/dev/v1") || url.pathname.startsWith("/api/") || url.pathname.startsWith("/specification")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
      if (hit) return hit;
      throw error;
    }
  })());
});
