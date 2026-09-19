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
