import type { IncomingMessage, ServerResponse } from 'node:http';

/** Fängt sowohl Parserfehler als auch abgelehnte asynchrone Handler ab. */
export function mitHttpFehlergrenze(
  handler: (request: IncomingMessage, response: ServerResponse, url: URL) => void | Promise<void>,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Ungültige Anfrage' }));
      return;
    }
    try {
      await handler(request, response, url);
    } catch {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Anfrage konnte nicht verarbeitet werden' }));
    }
  };
}

/** Liest den Request-Body als Text, mit Obergrenze gegen Missbrauch. */
export function readBody(request: IncomingMessage, maxBytes = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Body zu groß'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Stammt eine zustandsändernde Anfrage von dieser App selbst?
 *
 * Ein angemeldeter Browser schickt seinen Keks bei jeder Anfrage mit — auch
 * wenn eine fremde Webseite sie auslöst. Ohne diese Prüfung könnte eine
 * präparierte Seite im Namen des Angemeldeten "Laden fortsetzen" drücken oder
 * den Tarif ändern. Browser setzen dafür `Origin` bzw. `Sec-Fetch-Site`; passt
 * die Herkunft nicht zum angefragten Host, wird abgelehnt.
 *
 * Lesende Methoden (GET, HEAD) sind nicht betroffen. Anfragen ganz ohne diese
 * Köpfe (Skripte, curl) gehen durch — sie tragen keinen fremden Keks.
 */
export function herkunftErlaubt(request: IncomingMessage): boolean {
  const methode = (request.method ?? 'GET').toUpperCase();
  if (methode === 'GET' || methode === 'HEAD' || methode === 'OPTIONS') return true;
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') return false;
  const origin = request.headers['origin'];
  if (typeof origin !== 'string' || origin === '') return true;
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === (request.headers['host'] ?? '');
  } catch {
    return false;
  }
}

/** Für Seiten, die nie zwischengespeichert werden dürfen (Anmeldung, Verwaltung). */
export const KEIN_CACHE = 'no-store, no-cache, must-revalidate';

/** Eine HTML-Seite senden, die in keinen fremden Rahmen gehört. */
export function sendeSeite(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': KEIN_CACHE,
    // Anmeldung und Verwaltung gehören in keinen fremden Rahmen: Ein
    // unsichtbares iframe wäre sonst ein Weg, Klicks abzugreifen.
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
  });
  response.end(html);
}

export function leiteWeiter(response: ServerResponse, ziel: string, cookie?: string): void {
  response.writeHead(302, {
    location: ziel,
    'cache-control': KEIN_CACHE,
    ...(cookie === undefined ? {} : { 'set-cookie': cookie }),
  });
  response.end();
}