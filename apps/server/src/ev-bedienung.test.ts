import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bindeLadestromUebernahme, bindeLadestromBestaetigung, sendeLadebefehl } from '../public/ev-bedienung.js';

describe('Ladebedienung', () => {
  it('sendet die aktuelle Auswahl erst beim Bestätigen, nicht beim Bewegen oder Loslassen', () => {
    class Schieber extends EventTarget { value = '10'; min = '6'; max = '16'; }
    const schieber = new Schieber();
    const button = new EventTarget();
    const befehle: number[] = [];
    const listener = new AbortController();
    bindeLadestromBestaetigung(button, schieber, (a) => befehle.push(a), { signal: listener.signal });
    schieber.value = '16';
    schieber.dispatchEvent(new Event('input'));
    schieber.dispatchEvent(new Event('change'));
    assert.deepEqual(befehle, []);
    button.dispatchEvent(new Event('click'));
    assert.deepEqual(befehle, [16]);
    for (const value of ['NaN', '', '17', '5', '10.5']) {
      schieber.value = value;
      button.dispatchEvent(new Event('click'));
    }
    assert.deepEqual(befehle, [16]);
    listener.abort();
    schieber.value = '12';
    button.dispatchEvent(new Event('click'));
    assert.deepEqual(befehle, [16]);
  });

  it('sendet nach mehreren Live-Aktualisierungen nur einen Reglerbefehl', () => {
    class Schieber extends EventTarget { value = '12'; }
    const schieber = new Schieber();
    const befehle: number[] = [];
    let listener = new AbortController();
    for (let i = 0; i < 5; i++) {
      listener.abort();
      listener = new AbortController();
      bindeLadestromUebernahme(schieber, () => false, (a) => befehle.push(a), { signal: listener.signal });
    }
    schieber.dispatchEvent(new Event('change'));
    assert.deepEqual(befehle, [12]);
    listener.abort();
  });

  it('übernimmt einen Vorschauwert erst nach dem Wechsel in den bestätigten Handbetrieb', () => {
    class Schieber extends EventTarget { value = '12'; }
    const schieber = new Schieber();
    const befehle: number[] = [];
    let vorschau = true;
    bindeLadestromUebernahme(schieber, () => vorschau, (a) => befehle.push(a));
    schieber.dispatchEvent(new Event('change'));
    assert.deepEqual(befehle, []);
    vorschau = false;
    schieber.value = '10';
    schieber.dispatchEvent(new Event('change'));
    assert.deepEqual(befehle, [10]);
  });

  it('akzeptiert Fehlerantworten und Netzwerkfehler nicht als Regelzustand', async () => {
    for (const status of [400, 401, 500]) {
      await assert.rejects(sendeLadebefehl('/api/ev/stopp', { an: true },
        async () => new Response('{"error":"Fehler"}', { status })), /nicht übernommen/);
    }
    await assert.rejects(sendeLadebefehl('/api/ev/stopp', { an: true },
      async () => { throw new Error('offline'); }), /offline/);
    await assert.rejects(sendeLadebefehl('/api/ev/stopp', { an: true },
      async () => new Response('{}')), /Ungültige Antwort/);
  });

  it('überträgt den ausdrücklichen Stopp und liefert nur die bestätigte Antwort', async () => {
    const result = await sendeLadebefehl('/api/ev/stopp', { an: true }, async (url, options) => {
      assert.equal(url, '/api/ev/stopp');
      assert.equal(options?.method, 'POST');
      assert.equal(options?.body, '{"an":true}');
      return Response.json({ betriebsart: 'intelligent', gestoppt: true, gesetztA: 0 });
    });
    assert.equal(result['gestoppt'], true);
  });
});
