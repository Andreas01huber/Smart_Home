/**
 * Tests der Umrechnung zwischen Ladestrom und Ladeleistung.
 *
 * Die Prüfwerte stammen nicht aus dem Code, sondern aus der Anlage: Bei 16 A
 * lädt das Auto mit rund 11 kW, bei 6 A mit rund 4 kW. Wenn die Formel diese
 * beiden Punkte nicht trifft, ist sie falsch — egal wie hübsch sie aussieht.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  gemessenerAnschluss,
  ladeleistungAusStromW,
  ladestromAusLeistungA,
  LADEANSCHLUSS_STANDARD,
  type Ladeanschluss,
} from './ladeleistung.ts';

const EINPHASIG: Ladeanschluss = { phasen: 1, spannungV: 230 };

describe('Ladestrom zu Ladeleistung', () => {
  it('trifft die beiden bekannten Punkte der Anlage', () => {
    const bei16 = ladeleistungAusStromW(16);
    const bei6 = ladeleistungAusStromW(6);
    assert.ok(bei16 !== null && bei6 !== null);
    // 11,09 kW und 4,16 kW - auf 0,1 kW genau gegen die Erfahrungswerte.
    assert.ok(Math.abs(bei16 - 11_085) < 100, `16 A ergab ${bei16} W`);
    assert.ok(Math.abs(bei6 - 4_157) < 100, `6 A ergab ${bei6} W`);
  });

  it('rechnet die ganze Tabelle von 6 bis 16 A', () => {
    // Erwartungswerte in kW, gerundet auf eine Nachkommastelle.
    const erwartet: Readonly<Record<number, number>> = {
      6: 4.2, 7: 4.8, 8: 5.5, 9: 6.2, 10: 6.9,
      11: 7.6, 12: 8.3, 13: 9.0, 14: 9.7, 15: 10.4, 16: 11.1,
    };
    for (const [ampere, kw] of Object.entries(erwartet)) {
      const watt = ladeleistungAusStromW(Number(ampere));
      assert.ok(watt !== null);
      assert.equal(Math.round(watt / 100) / 10, kw, `${ampere} A`);
    }
  });

  it('rechnet einphasig ohne Wurzel drei', () => {
    // 16 A einphasig sind 3,7 kW - die klassische Schuko-nahe Ladeleistung.
    const watt = ladeleistungAusStromW(16, EINPHASIG);
    assert.ok(watt !== null);
    assert.equal(Math.round(watt), 3_680);
  });

  it('gibt bei unbrauchbarer Eingabe nichts zurück statt einer Null', () => {
    // Eine 0 sähe aus wie eine Messung "es fliesst nichts". Das ist etwas
    // anderes als "wir wissen es nicht".
    for (const murks of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.equal(ladeleistungAusStromW(murks as number | null), null, String(murks));
    }
  });
});

describe('Ladeleistung zurück zu Ladestrom', () => {
  it('ist die Umkehrung der Hinrechnung', () => {
    for (let a = 6; a <= 16; a++) {
      const watt = ladeleistungAusStromW(a);
      assert.ok(watt !== null);
      const zurueck = ladestromAusLeistungA(watt);
      assert.ok(zurueck !== null);
      assert.ok(Math.abs(zurueck - a) < 1e-9, `${a} A`);
    }
  });

  it('ordnet die gemessenen 10,35 kW dem passenden Strom zu', () => {
    // Wert aus einem echten Ladevorgang dieser Anlage.
    const a = ladestromAusLeistungA(10_351);
    assert.ok(a !== null);
    assert.equal(Math.round(a), 15);
  });

  it('gibt bei unbrauchbarer Eingabe nichts zurück', () => {
    for (const murks of [null, Number.NaN, -5]) {
      assert.equal(ladestromAusLeistungA(murks as number | null), null, String(murks));
    }
  });
});

describe('Standardanschluss', () => {
  it('ist dreiphasig an 400 V', () => {
    assert.equal(LADEANSCHLUSS_STANDARD.phasen, 3);
    assert.equal(LADEANSCHLUSS_STANDARD.spannungV, 400);
  });
});

describe('Nacheichung an einer echten Messung', () => {
  it('übernimmt die zurückgerechnete Spannung', () => {
    // Der gemessene Fall vom 8.9.: 15 A eingestellt, 10 084 W gemessen.
    const a = gemessenerAnschluss(10_084, 15, LADEANSCHLUSS_STANDARD);
    assert.ok(Math.abs(a.spannungV - 388) < 1, `${a.spannungV.toFixed(0)} V zurückgerechnet`);
    // Und damit braucht die Höchststufe rund 700 W weniger Überschuss.
    const vorher = ladeleistungAusStromW(16, LADEANSCHLUSS_STANDARD) ?? 0;
    const nachher = ladeleistungAusStromW(16, a) ?? 0;
    assert.ok(vorher - nachher > 300, `nur ${Math.round(vorher - nachher)} W Unterschied`);
  });

  it('lehnt eine unmögliche Spannung ab', () => {
    // Das Fahrzeug nimmt gegen Ende von sich aus zurück: 16 A eingestellt,
    // nur 3 kW gemessen. Das wären 108 V — keine Netzspannung, also keine
    // brauchbare Eichung. Ungeprüft übernommen würde die Regelung glauben,
    // 16 A kosteten 1,7 kW.
    assert.deepEqual(gemessenerAnschluss(3000, 16), LADEANSCHLUSS_STANDARD);
    // Ebenso nach oben.
    assert.deepEqual(gemessenerAnschluss(30_000, 16), LADEANSCHLUSS_STANDARD);
  });

  it('bleibt beim Nennwert, solange nichts gemessen ist', () => {
    assert.deepEqual(gemessenerAnschluss(null, 16), LADEANSCHLUSS_STANDARD);
    assert.deepEqual(gemessenerAnschluss(10_000, null), LADEANSCHLUSS_STANDARD);
    assert.deepEqual(gemessenerAnschluss(0, 0), LADEANSCHLUSS_STANDARD);
  });
});
