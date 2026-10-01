// Self-destructing service worker.
//
// Until 2026-10-01 (DEV-26) the app itself lived at this domain's root, and
// vite-plugin-pwa registered a real service worker there (scope '/') to
// cache its own assets. That worker is now gone from the build — it only
// exists under /app/ — but a browser that visited the OLD root before this
// change still has the OLD worker active, independent of whatever this
// domain serves now. It keeps intercepting every request in its scope
// (including the new marketing page and /support) and serving its own
// stale cache, regardless of what the server actually returns — this is
// why curl/server logs can show the new pages live while a browser that
// visited before still sees the old app or a broken page.
//
// Browsers periodically re-fetch an active service worker's own script
// (this exact URL, since that's where it was originally registered) to
// check for updates. This file being byte-different from the old sw.js
// is what triggers that — once it installs, it immediately clears every
// cache this origin owns, unregisters itself, and reloads any open tabs,
// after which normal network requests take over again and nothing here
// is needed anymore.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    })()
  );
});
