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
  anschlussName,
  gemessenerAnschluss,
  LADEANSCHLUSS_HAUSHALT,
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

describe('An welcher Dose hängt das Auto?', () => {
  it('erkennt die Starkstromdose und die genaue Spannung', () => {
    const a = gemessenerAnschluss(10_084, 15, LADEANSCHLUSS_STANDARD);
    assert.equal(a.phasen, 3);
    assert.ok(Math.abs(a.spannungV - 388) < 1, `${a.spannungV.toFixed(0)} V zurückgerechnet`);
  });

  it('erkennt die Haushaltssteckdose auch bei gedrückter Spannung', () => {
    // Der echte Messwert vom 8.9.: 10 A eingestellt, 2073 W geflossen. Das sind
    // 207 V — genau auf der Zehn-Prozent-Kante, und eine Messung später mit
    // 2007 W sogar darunter. Mit dem alten engen Band kippte die Erkennung bei
    // jedem Messwert hin und her.
    for (const w of [2073, 2007, 2200]) {
      const a = gemessenerAnschluss(w, 10, LADEANSCHLUSS_STANDARD);
      assert.equal(a.phasen, 1, `${w} W bei 10 A nicht als Haushaltsdose erkannt`);
      assert.equal(anschlussName(a), 'Haushaltssteckdose');
    }
  });

  it('verwechselt die beiden Dosen nicht', () => {
    assert.equal(gemessenerAnschluss(11_085, 16).phasen, 3);
    assert.equal(gemessenerAnschluss(3680, 16).phasen, 1);
  });

  it('lässt sich von einem zurücknehmenden Fahrzeug nicht täuschen', () => {
    // 16 A gesetzt, nur 3200 W gemessen: einphasig gerechnet wären das 200 V —
    // durchaus möglich. Aber an diesem Anschluss sind schon 11 kW geflossen,
    // und die gibt keine Haushaltsdose her. Also bleibt es dreiphasig.
    //
    // Der Irrtum wäre teuer: Die Regelung hielte 16 A für 3,7 kW statt für
    // 11 kW und würde das Dreifache einplanen.
    const a = gemessenerAnschluss(3200, 16, LADEANSCHLUSS_STANDARD, 11_085);
    assert.equal(a.phasen, 3);
    assert.deepEqual(a, LADEANSCHLUSS_STANDARD);
  });

  it('erlaubt die Haushaltsdose, solange nie mehr floss als sie hergibt', () => {
    // Dieselbe Momentaufnahme, aber an diesem Anschluss war nie mehr als
    // 2,3 kW — dann ist die Haushaltsdose die richtige Erklärung.
    const a = gemessenerAnschluss(2300, 10, LADEANSCHLUSS_STANDARD, 2300);
    assert.equal(a.phasen, 1);
  });

  it('bleibt beim Bekannten, wenn beides unmöglich wäre', () => {
    // 16 A gesetzt, 800 W gemessen: 46 V dreiphasig, 50 V einphasig.
    assert.deepEqual(gemessenerAnschluss(800, 16), LADEANSCHLUSS_STANDARD);
    assert.deepEqual(gemessenerAnschluss(800, 16, LADEANSCHLUSS_HAUSHALT), LADEANSCHLUSS_HAUSHALT);
  });

  it('bleibt beim Bekannten, solange nichts gemessen ist', () => {
    assert.deepEqual(gemessenerAnschluss(null, 16), LADEANSCHLUSS_STANDARD);
    assert.deepEqual(gemessenerAnschluss(10_000, null), LADEANSCHLUSS_STANDARD);
    assert.deepEqual(gemessenerAnschluss(0, 0), LADEANSCHLUSS_STANDARD);
  });

  it('rechnet an der Haushaltsdose ganz andere Kilowatt', () => {
    assert.equal(Math.round(ladeleistungAusStromW(16, LADEANSCHLUSS_STANDARD) ?? 0), 11_085);
    assert.equal(Math.round(ladeleistungAusStromW(16, LADEANSCHLUSS_HAUSHALT) ?? 0), 3680);
    assert.equal(Math.round(ladeleistungAusStromW(10, LADEANSCHLUSS_HAUSHALT) ?? 0), 2300);
  });
});
