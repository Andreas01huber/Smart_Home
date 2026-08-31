/**
 * Service Worker für die Energie-PWA.
 *
 * Statische App-Shell: cache-first, damit die App auch bei kurzem
 * Verbindungsverlust startet. Live- und API-Daten werden NIE gecacht —
 * veraltete Messwerte dürfen nicht als aktuell erscheinen (Anforderung 4P/53).
 */

const CACHE = 'energie-shell-v55';
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

/**
 * Seiten, die nie in den Cache dürfen.
 *
 * Anmeldung und Verwaltung hängen davon ab, wer gerade angemeldet ist, und die
 * Verwaltung zeigt Namen, Geräte und IP-Adressen. Aus dem Cache beantwortet
 * hiesse: Wer nach dem Abmelden /admin öffnet, bekäme die Benutzerliste des
 * letzten Aufrufs zu sehen, ganz ohne Anmeldung.
 */
function nurAusDemNetz(pfad) {
  return (
    pfad.startsWith('/api/') ||
    pfad === '/admin' ||
    pfad.startsWith('/admin/') ||
    pfad === '/login' ||
    pfad === '/logout'
  );
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // API, Anmeldung und Verwaltung immer aus dem Netz, niemals aus dem Cache.
  if (nurAusDemNetz(url.pathname)) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          // `no-store` ernst nehmen. Der Server schickt das bei allem, was von
          // der Anmeldung abhängt - auch bei einer Umleitung dorthin, die hier
          // sonst unter dem ursprünglichen Pfad im Cache landen würde.
          const nichtSpeichern = (resp.headers.get('cache-control') ?? '').includes('no-store');
          if (resp.ok && !nichtSpeichern && url.origin === self.location.origin) {
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
