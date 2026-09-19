import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mitHttpFehlergrenze } from './http-util.ts';

function antwort() {
  return { status: 0, body: '', destroyed: false, writableEnded: false, headersSent: false,
    writeHead(status: number) { this.status = status; },
    end(body: string) { this.body = body; this.writableEnded = true; },
    destroy() { this.destroyed = true; },
  };
}
const request = (url: string, host = 'localhost') => ({ url, headers: { host } }) as IncomingMessage;

it('weist kaputte URLs vor dem Handler ab', async () => {
  let aufrufe = 0;
  const handler = mitHttpFehlergrenze(() => { aufrufe++; });
  for (const req of [request('/', '['), request('/api/ev/sessions/%'), request('/%FF')]) {
    const res = antwort();
    await handler(req, res as unknown as ServerResponse);
    assert.equal(res.status, 400);
  }
  assert.equal(aufrufe, 0);
});

it('übersteht synchrone und asynchrone Fehler und verarbeitet die nächste Anfrage', async () => {
  for (const fehler of [() => { throw new Error('intern'); }, async () => { throw new Error('intern'); }]) {
    const handler = mitHttpFehlergrenze((req, res) => {
      if (req.url === '/kaputt') return fehler();
      res.writeHead(200); res.end('ok');
    });
    const kaputt = antwort();
    await handler(request('/kaputt'), kaputt as unknown as ServerResponse);
    assert.equal(kaputt.status, 500);
    assert.doesNotMatch(kaputt.body, /intern/);
    const ok = antwort();
    await handler(request('/'), ok as unknown as ServerResponse);
    assert.equal(ok.status, 200);
  }
});
