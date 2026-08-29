/**
 * Service Worker für die Energie-PWA.
 *
 * Statische App-Shell: cache-first, damit die App auch bei kurzem
 * Verbindungsverlust startet. Live- und API-Daten werden NIE gecacht —
 * veraltete Messwerte dürfen nicht als aktuell erscheinen (Anforderung 4P/53).
 */

const CACHE = 'energie-shell-v53';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/format.js', '/scene.js', '/favicon-64.png?v=20260827', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  // allSettled: eine einzelne nicht cachebare Datei darf die Installation nicht
  // scheitern lassen (verhinderte sonst die Registrierung).
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // API und Event-Stream immer aus dem Netz, niemals aus dem Cache.
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          if (resp.ok && url.origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return resp;
        })
        // Weder Cache noch Netz: eine echte Antwort zurückgeben. Mit
        // undefined endete respondWith in einem unklaren Netzwerkfehler.
        .catch(() => cached || new Response('Offline', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }));
      return cached || network;
    }),
  );
});
