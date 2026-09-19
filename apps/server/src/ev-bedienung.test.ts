import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  befehlsfolge, bindeLadestromUebernahme, bindeLadestromBestaetigung, ladezustand, sendeLadebefehl,
} from '../public/ev-bedienung.js';

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
      // Der Fehlertext des Servers wird angezeigt, nicht verschluckt.
      await assert.rejects(sendeLadebefehl('/api/ev/stopp', { an: true },
        async () => new Response('{"error":"Lade-Einstellung konnte nicht gespeichert werden"}', { status })),
      /konnte nicht gespeichert/);
      await assert.rejects(sendeLadebefehl('/api/ev/stopp', { an: true },
        async () => new Response('Gateway Timeout', { status })), /nicht übernommen/);
    }
    await assert.rejects(sendeLadebefehl('/api/ev/stopp', { an: true },
      async () => { throw new Error('offline'); }), /Keine Verbindung/);
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

describe('Befehlsreihenfolge', () => {
  it('eine verspätete ältere Antwort überschreibt den neueren Stopp nicht', () => {
    const folge = befehlsfolge();
    const manuell = folge.beginne();
    const stopp = folge.beginne();
    assert.equal(folge.laeuft, true);
    assert.equal(folge.beende(stopp), true, 'der Stopp ist der neueste Befehl');
    assert.equal(folge.beende(manuell), false, 'die alte Antwort darf nichts mehr ersetzen');
    assert.equal(folge.laeuft, false);
  });
});

describe('Ladezustand in Worten — Wunsch, Befehl, Gerät, Messung getrennt', () => {
  const basis = {
    modus: 'regeln', zustand: 'laedt', betriebsart: 'intelligent', manuellA: 10, gestoppt: false,
    grund: 'Lädt mit 8 A.', befehl: null, geraet: null,
  };
  const ev = (powerW: number | null, extra: Record<string, unknown> = {}) =>
    ({ state: 'connected', vehicleConnected: true, powerW, ...extra });

  it('HTTP-Erfolg ist kein Laden: freigegeben ohne Stromaufnahme', () => {
    const z = ladezustand({ ...basis, befehl: { schalter: true, status: 'angenommen' } }, ev(0));
    assert.match(z.titel, /Freigegeben/);
  });

  it('erst die Messung macht daraus "lädt"', () => {
    assert.equal(ladezustand(basis, ev(3000)).titel, 'Lädt intelligent');
    const m = ladezustand({ ...basis, betriebsart: 'manuell' }, ev(2300));
    assert.equal(m.titel, 'Lädt manuell');
    assert.notEqual(m.ton, 'warn', 'manuell ist kein Warnzustand');
    assert.match(m.text, /Bei Bedarf Netzstrom/);
  });

  it('Start wird übermittelt, solange die Antwort aussteht', () => {
    const z = ladezustand({ ...basis, befehl: { schalter: true, status: 'uebermittelt' } }, ev(0));
    assert.equal(z.titel, 'Start wird übermittelt');
  });

  it('unterscheidet Pause angefordert und pausiert', () => {
    const angefordert = ladezustand({ ...basis, gestoppt: true, geraet: { schalterAn: true } }, ev(2300));
    const bestaetigt = ladezustand({ ...basis, gestoppt: true, geraet: { schalterAn: false } }, ev(0));
    assert.equal(angefordert.titel, 'Pause angefordert');
    assert.equal(bestaetigt.titel, 'Pausiert');
  });

  it('Offline ist nicht abgesteckt, unbekannter Anschluss ist nicht "kein Auto"', () => {
    assert.equal(ladezustand(basis, { state: 'offline', vehicleConnected: null, powerW: null }).titel,
      'Wallbox nicht erreichbar');
    assert.equal(ladezustand(basis, { state: 'idle', vehicleConnected: null, powerW: null }).titel,
      'Anschluss unbekannt');
  });

  it('ohne Auto zeigt es die Wahl für das nächste Anstecken', () => {
    const z = ladezustand({ ...basis, betriebsart: 'manuell', zustand: 'nicht-verbunden' },
      { state: 'idle', vehicleConnected: false, powerW: 0 });
    assert.equal(z.titel, 'Kein Auto angesteckt');
    assert.equal(z.text, 'Beim nächsten Anstecken: Manuell · 10 A');
  });

  it('ohne Wahl fordert es zur Wahl auf', () => {
    assert.equal(ladezustand({ ...basis, betriebsart: null, zustand: 'wahl-fehlt' }, ev(0)).titel, 'Lademodus wählen');
  });

  it('"Akku voll" wird nicht behauptet', () => {
    const z = ladezustand({ ...basis, zustand: 'fordert-nicht' }, ev(0));
    assert.equal(z.titel, 'Fahrzeug nimmt derzeit keinen Strom an');
  });

  it('wartet auf Überschuss statt Fehlerfarbe', () => {
    const z = ladezustand({ ...basis, zustand: 'pausiert-leistung' }, ev(0));
    assert.equal(z.titel, 'Wartet auf Überschuss');
    assert.equal(z.ton, 'neutral');
  });
});
