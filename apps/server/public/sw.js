/**
 * Service Worker für die Energie-PWA.
 *
 * Die App-Shell (HTML, JS, CSS) kommt, solange der Server erreichbar ist,
 * immer aus dem Netz und nur ohne Verbindung aus dem Cache. Vorher galt
 * cache-first: Nach einem Deploy lief dann eine alte Oberfläche gegen eine neue
 * Schnittstelle, bis der Cache irgendwann nachzog. Grafiken und Schriften
 * bleiben cache-first, sie ändern sich nicht mit der Schnittstelle.
 *
 * Live- und API-Daten werden NIE gecacht — veraltete Messwerte dürfen nicht als
 * aktuell erscheinen (Anforderung 4P/53).
 *
 * Ein neuer Service Worker übernimmt nicht von selbst, sondern wartet, bis die
 * Seite ihn darum bittet (Hinweis „Neue Version“ in app.js). So wird nie
 * mitten in einer Bedienung neu geladen, und in einem offenen Fenster laufen
 * nie Module zweier Fassungen nebeneinander.
 */

const CACHE = 'energie-shell-v75';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/format.js', '/scene.js', '/ev-bedienung.js', '/api.js', '/tarif-regeln.js', '/favicon-64.png?v=20260827', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  // allSettled: eine einzelne nicht cachebare Datei darf die Installation nicht
  // scheitern lassen (verhinderte sonst die Registrierung).
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => sofortUebernehmen())
      .then((sofort) => { if (sofort) return self.skipWaiting(); }),
  );
});

/**
 * Beim allerersten Mal gibt es niemanden, auf den zu warten wäre. Und bis v74
 * kannte die Seite den Hinweis „Neue Version“ noch nicht — ein Worker, der auf
 * sie wartet, wartete dort, bis jedes Fenster der App geschlossen ist. Also
 * übernehmen, solange nur Caches älterer Fassungen da sind (wie bisher).
 */
const ERSTE_FASSUNG_MIT_HINWEIS = 75;
async function sofortUebernehmen() {
  if (!self.registration.active) return true;
  const fassungen = (await caches.keys())
    .filter((k) => k !== CACHE)
    .map((k) => Number(/^energie-shell-v(\d+)$/.exec(k)?.[1] ?? 0));
  return fassungen.every((v) => v < ERSTE_FASSUNG_MIT_HINWEIS);
}

self.addEventListener('message', (event) => {
  if (event.data === 'neue-version-uebernehmen') self.skipWaiting();
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

/**
 * Was überhaupt in den Cache darf: die App-Shell dieser Fassung und statische
 * Grafiken/Schriften. Alles andere — Schnittstellen, Diagnose, Healthcheck,
 * unbekannte Pfade — geht immer ins Netz.
 */
const SHELL_PFADE = new Set(SHELL.map((s) => s.split('?')[0]));
function darfGecacht(pfad) {
  return SHELL_PFADE.has(pfad) || pfad.startsWith('/assets/')
    || /\.(png|svg|ico|webp|jpg|jpeg|woff2?)$/.test(pfad);
}

/**
 * Nur echte, direkte Antworten speichern. `no-store` schickt der Server bei
 * allem, was von der Anmeldung abhängt; eine umgeleitete Antwort wäre die
 * Anmeldeseite unter dem Pfad der App-Shell.
 */
function speichere(request, resp) {
  const nichtSpeichern = (resp.headers.get('cache-control') ?? '').includes('no-store');
  if (resp.ok && !resp.redirected && resp.type === 'basic' && !nichtSpeichern) {
    const copy = resp.clone();
    caches.open(CACHE).then((c) => c.put(request, copy));
  }
}

const OFFLINE = () => new Response('Offline', {
  status: 503,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // API, Anmeldung und Verwaltung immer aus dem Netz, niemals aus dem Cache.
  if (nurAusDemNetz(url.pathname)) return;
  if (url.origin !== self.location.origin || !darfGecacht(url.pathname)) return;
  if (event.request.method !== 'GET') return;

  if (SHELL_PFADE.has(url.pathname)) {
    // Netz zuerst; der Cache nur, wenn der Server nicht erreichbar ist.
    event.respondWith(
      fetch(event.request)
        .then((resp) => { speichere(event.request, resp); return resp; })
        .catch(() => caches.match(event.request).then((cached) => cached || OFFLINE())),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => { speichere(event.request, resp); return resp; })
        // Weder Cache noch Netz: eine echte Antwort zurückgeben. Mit
        // undefined endete respondWith in einem unklaren Netzwerkfehler.
        .catch(() => cached || OFFLINE());
      return cached || network;
    }),
  );
});
