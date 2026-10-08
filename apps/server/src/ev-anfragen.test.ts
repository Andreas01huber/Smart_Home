/**
 * Strikte Prüfung der Lade-Schreibanfragen.
 *
 * Früher galt eine unbekannte Betriebsart als "intelligent" und jedes nicht
 * erkannte `an` als `false` — also "Laden fortsetzen". Ein Tippfehler konnte
 * so eine Pause aufheben.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pruefeBetriebsartAnfrage, pruefeStoppAnfrage } from './ev-anfragen.ts';

describe('Betriebsart-Anfrage', () => {
  it('nimmt gültige Anfragen an', () => {
    assert.deepEqual(pruefeBetriebsartAnfrage({ art: 'intelligent' }), { ok: true, wert: { art: 'intelligent' } });
    assert.deepEqual(pruefeBetriebsartAnfrage({ art: 'manuell', ampere: 10 }), {
      ok: true, wert: { art: 'manuell', ampere: 10 },
    });
    // Altname einer zwischengespeicherten Oberfläche.
    assert.deepEqual(pruefeBetriebsartAnfrage({ art: 'volladung' }), { ok: true, wert: { art: 'manuell' } });
  });

  it('lehnt Unbekanntes ab, statt es als "intelligent" zu deuten', () => {
    for (const roh of [
      { art: 'autark' }, { art: 'Manuell' }, {}, null, [], 'manuell',
      { art: 'manuell', ampere: 'zehn' }, { art: 'manuell', ampere: Number.NaN },
      { art: 'manuell', ampere: -3 }, { art: 'manuell', ampere: 500 },
      { art: 'manuell', hack: true },
    ]) {
      assert.equal(pruefeBetriebsartAnfrage(roh).ok, false, JSON.stringify(roh));
    }
  });
});

describe('Pause-Anfrage', () => {
  it('nimmt nur echte Wahrheitswerte an', () => {
    assert.deepEqual(pruefeStoppAnfrage({ an: true }), { ok: true, wert: { an: true } });
    assert.deepEqual(pruefeStoppAnfrage({ an: false }), { ok: true, wert: { an: false } });
  });

  it('deutet ein ungültiges "an" nicht als Fortsetzen', () => {
    for (const roh of [{}, { an: 'true' }, { an: 1 }, { an: null }, null, { an: true, x: 1 }]) {
      assert.equal(pruefeStoppAnfrage(roh).ok, false, JSON.stringify(roh));
    }
  });
});
