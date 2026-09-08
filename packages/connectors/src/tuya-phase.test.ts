/**
 * Tests der Rohbytes hinter `phase_a`.
 *
 * Die Prüfwerte stammen aus der Anlage: Am 8.9. um 21:39 meldete die Wallbox
 * `CNgAJFQACDk=`, und `power_total` im selben Moment 2105 W. Trifft die
 * Dekodierung diese Zahl nicht, ist sie falsch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { entschluessblePhase, phasenAusMessung } from './tuya-phase.ts';

describe('phase_a dekodieren', () => {
  it('trifft die gemessenen Werte der Anlage', () => {
    const p = entschluessblePhase('CNgAJFQACDk=');
    assert.ok(p);
    assert.equal(p.spannungV, 226.4);
    assert.equal(p.stromA, 9.3);
    assert.equal(p.leistungW, 2105);
    // Die Probe: Spannung mal Strom muss die Leistung ergeben.
    assert.ok(Math.abs(p.spannungV * p.stromA - p.leistungW) < 5);
  });

  it('liest auch den Ruhezustand richtig', () => {
    // Auto steht, Dose liegt trotzdem an: 231,0 V, 0 A, 0 W.
    const p = entschluessblePhase('CQYAAAAAAAA=');
    assert.ok(p);
    assert.equal(p.spannungV, 231);
    assert.equal(p.stromA, 0);
    assert.equal(p.leistungW, 0);
  });

  it('erfindet nichts bei unbrauchbaren Daten', () => {
    assert.equal(entschluessblePhase(null), null);
    assert.equal(entschluessblePhase(''), null);
    assert.equal(entschluessblePhase(42), null);
    // Zu kurz — lieber keine Angabe als eine halbe.
    assert.equal(entschluessblePhase('CNg='), null);
  });
});

describe('Phasenzahl aus der Messung', () => {
  it('erkennt einphasig, wenn die Gesamtleistung der einen Phase entspricht', () => {
    // Der echte Fall: 226,4 V × 9,3 A = 2105 W, und power_total meldet
    // ebenfalls 2105 W. Also fliesst alles über diese eine Phase.
    const p = entschluessblePhase('CNgAJFQACDk=');
    assert.equal(phasenAusMessung(p, 2105), 1);
  });

  it('erkennt dreiphasig, wenn die Gesamtleistung dreimal so hoch ist', () => {
    // 230 V × 15 A = 3450 W je Phase, dreiphasig also rund 10,4 kW.
    const p = { spannungV: 230, stromA: 15, leistungW: 3450 };
    assert.equal(phasenAusMessung(p, 10_350), 3);
  });

  it('sagt nichts, solange kaum etwas fliesst', () => {
    // Bei ein paar Watt Grundrauschen wäre das Verhältnis Zufall.
    assert.equal(phasenAusMessung({ spannungV: 231, stromA: 0, leistungW: 0 }, 0), null);
    assert.equal(phasenAusMessung({ spannungV: 231, stromA: 0.3, leistungW: 70 }, 70), null);
    assert.equal(phasenAusMessung(null, 5000), null);
    assert.equal(phasenAusMessung({ spannungV: 230, stromA: 10, leistungW: 2300 }, null), null);
  });

  it('sagt nichts bei einem Verhältnis dazwischen', () => {
    // Zweiphasig gibt es bei dieser Wallbox nicht — kommt so etwas heraus,
    // stimmt eine der beiden Messungen nicht, und dann wird geschwiegen.
    assert.equal(phasenAusMessung({ spannungV: 230, stromA: 10, leistungW: 2300 }, 4600), null);
  });
});
