/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa injectManifest). Handles offline app
// caching plus Web Push wake notifications. It deliberately never caches /app
// (the backend connector) and push payloads are content-free.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const CACHE = "fastmessage-v1";
const ASSETS = (self.__WB_MANIFEST || []).map((e) => e.url);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(["/", ...ASSETS]).catch(() => undefined);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname.startsWith("/app")) return; // never cache the API/WS
  event.respondWith(
    (async () => {
      try {
        return await fetch(req);
      } catch {
        const cached = await caches.match(req);
        return cached ?? (await caches.match("/")) ?? Response.error();
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string } = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    /* content-free fallback below */
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "FastMessage", {
      body: data.body ?? "New encrypted message",
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "fastmessage",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const c of all) {
        if ("focus" in c) return (c as WindowClient).focus();
      }
      return self.clients.openWindow("/");
    })(),
  );
});

export {};
