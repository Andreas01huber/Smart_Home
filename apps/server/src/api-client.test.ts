/**
 * Tests des Datenzugriffs der Oberfläche (public/api.js).
 *
 * Der wichtigste Fall aus dem Review: erst "Gestern" angefragt (langsam), dann
 * "Heute" (schnell). Die verspätete Gestern-Antwort darf nicht unter "Heute"
 * erscheinen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ApiFehler, holeJson, istUeberholt, letzteAnfrage } from '../public/api.js';

function antwort(status: number, body: unknown, typ = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': typ },
  });
}

describe('holeJson', () => {
  it('liefert ein geprüftes JSON-Objekt', async () => {
    const daten = await holeJson('/x', {}, async () => antwort(200, { a: 1 }));
    assert.deepEqual(daten, { a: 1 });
  });

  it('meldet den Fehlertext des Servers statt Daten', async () => {
    await assert.rejects(
      holeJson('/x', {}, async () => antwort(500, { error: 'Tarif konnte nicht gespeichert werden.' })),
      (e: unknown) => e instanceof ApiFehler && e.status === 500 && /Tarif konnte nicht/.test(e.message),
    );
  });

  it('nimmt eine HTML-Fehlerseite nicht als Daten', async () => {
    await assert.rejects(
      holeJson('/x', {}, async () => antwort(200, '<html>Proxy-Fehler</html>', 'text/html')),
      ApiFehler,
    );
  });

  it('übersetzt eine fehlende Verbindung in einen verständlichen Satz', async () => {
    await assert.rejects(
      holeJson('/x', {}, async () => { throw new TypeError('Failed to fetch'); }),
      (e: unknown) => e instanceof ApiFehler && e.status === 0 && /Keine Verbindung/.test(e.message),
    );
  });
});

describe('letzteAnfrage — verspätete Antworten überschreiben nichts', () => {
  it('verwirft auch den verspäteten Fehler einer überholten Anfrage', async () => {
    const tag = letzteAnfrage();
    let ablehnen!: (e: Error) => void;
    const alt = tag('/alt', {}, () => new Promise((_ok, nein) => { ablehnen = nein; }));
    const pruefung = assert.rejects(alt, (e: unknown) => istUeberholt(e));
    assert.deepEqual(await tag('/neu', {}, async () => antwort(200, { date: 'neu' })), { date: 'neu' });
    ablehnen(new Error('Alter Request scheitert erst jetzt'));
    await pruefung;
  });
  it('Gestern langsam, Heute schnell: nur Heute kommt an', async () => {
    const tag = letzteAnfrage();
    const langsam = (pfad: string, o?: RequestInit): Promise<Response> =>
      new Promise((fertig, fehler) => {
        const t = setTimeout(() => fertig(antwort(200, { date: pfad })), pfad.includes('gestern') ? 40 : 1);
        // Ein echter Abbruch wird hier bewusst ignoriert: Auch eine Antwort, die
        // trotz Abbruch noch ankommt, muss verworfen werden.
        void o;
        void t;
        void fehler;
      });

    const gestern = tag('/api/history/day?date=gestern', {}, langsam);
    const heute = tag('/api/history/day?date=heute', {}, langsam);

    assert.deepEqual(await heute, { date: '/api/history/day?date=heute' });
    await assert.rejects(gestern, (e: unknown) => istUeberholt(e));
  });

  it('bricht die vorige Anfrage ab', async () => {
    const tag = letzteAnfrage();
    let abgebrochen = false;
    const transport = (_p: string, o?: RequestInit): Promise<Response> =>
      new Promise((fertig, fehler) => {
        o?.signal?.addEventListener('abort', () => {
          abgebrochen = true;
          fehler(Object.assign(new Error('abgebrochen'), { name: 'AbortError' }));
        });
        setTimeout(() => fertig(antwort(200, {})), 30);
      });
    const erste = tag('/a', {}, transport);
    const zweite = tag('/b', {}, transport);
    await assert.rejects(erste, (e: unknown) => istUeberholt(e));
    await zweite;
    assert.equal(abgebrochen, true);
  });
});
