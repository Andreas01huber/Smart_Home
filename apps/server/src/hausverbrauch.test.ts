/**
 * Tests der Aufteilung in Haus und Auto.
 *
 * Die Fälle stammen aus dem Betrieb am 8.9.2026 — an dem Tag stand in der App
 * minutenlang ein Hausverbrauch von 11,7 kW, obwohl im Haus 1,5 kW liefen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Hausverbrauch, HALTBARKEIT_MS } from './hausverbrauch.ts';

describe('Stimmige Messwerte', () => {
  it('zieht das Auto ab', () => {
    const h = new Hausverbrauch();
    const a = h.teile(11_246, 10_084, 1000);
    assert.equal(Math.round(a.wattW ?? -1), 1162);
    assert.equal(a.autoW, 10_084);
    assert.equal(a.frisch, true);
  });

  it('lässt den Wert stehen, wenn kein Auto lädt', () => {
    const h = new Hausverbrauch();
    const a = h.teile(1500, 0, 1000);
    assert.equal(a.wattW, 1500);
    assert.equal(a.autoW, 0);
  });

  it('kennt keinen Wert ohne Zähler', () => {
    const h = new Hausverbrauch();
    assert.equal(h.teile(null, 4000, 1000).wattW, null);
  });
});

describe('Wenn die Wallbox nachhinkt', () => {
  it('hält die zuletzt bekannte Grundlast', () => {
    const h = new Hausverbrauch();
    // Erst stimmig: Grundlast 1162 W wird gemerkt.
    h.teile(11_246, 10_084, 1000);
    // Dann der echte Widerspruch: Zähler 9338 W, Wallbox meldet weiter 10 084 W.
    const a = h.teile(9338, 10_084, 3000);
    assert.equal(Math.round(a.wattW ?? -1), 1162);
    // Der Rest gehört dem Auto — und ist damit näher an der Wahrheit als der
    // veraltete Wert aus der Cloud.
    assert.equal(Math.round(a.autoW), 8176);
    assert.equal(a.frisch, false);
  });

  it('lässt eine Änderung im Haus nicht unter den Tisch fallen', () => {
    // Geht während der Verzögerung das Backrohr an, steckt das im Zählerwert.
    // Hier passen die Werte wieder zusammen, also wird normal abgezogen — und
    // der Hausverbrauch steigt sofort mit.
    const h = new Hausverbrauch();
    h.teile(11_246, 10_084, 1000);
    const a = h.teile(11_246 + 3400, 10_084, 3000);
    assert.equal(Math.round(a.wattW ?? -1), 4562);
    assert.equal(a.frisch, true);
  });

  it('hält die Grundlast über mehrere Zyklen durch', () => {
    // Die Verzögerung dauert selten nur einen Zyklus. Solange sie anhält, darf
    // die Anzeige nicht zwischen zwei Werten springen.
    const h = new Hausverbrauch();
    h.teile(11_246, 10_084, 1000);
    for (const t of [3000, 5000, 7000, 9000]) {
      const a = h.teile(9338, 10_084, t);
      assert.equal(Math.round(a.wattW ?? -1), 1162, `bei ${t} ms gesprungen`);
    }
  });

  it('behauptet nichts mehr, wenn die Grundlast zu alt ist', () => {
    const h = new Hausverbrauch();
    h.teile(11_246, 10_084, 1000);
    const a = h.teile(9338, 10_084, 1000 + HALTBARKEIT_MS + 1);
    assert.equal(a.wattW, null);
    assert.equal(a.frisch, false);
  });

  it('behauptet nichts, solange noch nie etwas Stimmiges kam', () => {
    // Startet der Server mitten in einem Ladevorgang, gibt es noch keine
    // Grundlast. Dann lieber ein Strich als eine erfundene Zahl.
    const h = new Hausverbrauch();
    assert.equal(h.teile(9338, 10_084, 1000).wattW, null);
  });

  it('gibt nie mehr Haus aus, als der Zähler hergibt', () => {
    const h = new Hausverbrauch();
    h.teile(5000, 0, 1000); // Grundlast 5000 W gemerkt
    const a = h.teile(800, 4000, 2000);
    assert.equal(a.wattW, 800);
    assert.equal(a.autoW, 0);
  });
});
