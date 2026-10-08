/**
 * Tests der Aufteilung in Haus und Auto.
 *
 * Die Fälle stammen aus dem Betrieb am 8.9.2026 — an dem Tag stand in der App
 * minutenlang ein Hausverbrauch von 11,7 kW, obwohl im Haus 1,5 kW liefen —
 * und aus dem Projektreview vom 19.9.: Eine unbekannte Autoleistung wurde dort
 * noch zu gemessenen 0 W.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Hausverbrauch, HALTBARKEIT_MS, teileRein } from './hausverbrauch.ts';

describe('Gemessen, geschätzt, unbekannt', () => {
  it('lässt eine unbekannte Autoleistung unbekannt — der Fall aus dem Review', () => {
    // Vorher: autoW 0, frisch true. Die Bilanz zählte daraus gemessene 0 W.
    const a = new Hausverbrauch().fuerZyklus(0, 1200, null);
    assert.deepEqual(a.hausGesamt, { w: 1200, art: 'gemessen' });
    assert.deepEqual(a.hausOhneAuto, { w: null, art: 'unbekannt' });
    assert.deepEqual(a.auto, { w: null, art: 'unbekannt' });
    assert.equal(a.schaetzung, null);
  });

  it('hält gemessene 0 W von unbekannt getrennt', () => {
    const a = new Hausverbrauch().fuerZyklus(0, 1500, 0);
    assert.deepEqual(a.auto, { w: 0, art: 'gemessen' });
    assert.deepEqual(a.hausOhneAuto, { w: 1500, art: 'gemessen' });
  });

  it('zieht ein plausibel gemessenes Auto ab', () => {
    const a = new Hausverbrauch().fuerZyklus(1000, 11_246, 10_084);
    assert.equal(a.hausOhneAuto.art, 'gemessen');
    assert.equal(Math.round(a.hausOhneAuto.w ?? -1), 1162);
    assert.deepEqual(a.auto, { w: 10_084, art: 'gemessen' });
  });

  it('kennt ohne Hauszähler nur, was die Wallbox misst', () => {
    const a = new Hausverbrauch().fuerZyklus(1000, null, 4000);
    assert.deepEqual(a.hausGesamt, { w: null, art: 'unbekannt' });
    assert.deepEqual(a.hausOhneAuto, { w: null, art: 'unbekannt' });
    assert.deepEqual(a.auto, { w: 4000, art: 'gemessen' });
  });

  it('verwirft unplausible Werte statt sie zu verrechnen', () => {
    for (const kaputt of [Number.NaN, Number.POSITIVE_INFINITY, -800]) {
      const a = teileRein(kaputt, 2000, 0, null);
      assert.equal(a.hausGesamt.art, 'unbekannt', `Haus ${kaputt}`);
      const b = teileRein(1200, kaputt, 0, null);
      assert.equal(b.auto.art, 'unbekannt', `Auto ${kaputt}`);
    }
    // Rundungsrauschen knapp unter null ist 0 W, kein Fehler.
    assert.deepEqual(teileRein(-20, 0, 0, null).hausGesamt, { w: 0, art: 'gemessen' });
  });
});

describe('Wenn die Wallbox nachhinkt', () => {
  it('schätzt aus der Grundlast — gekennzeichnet und befristet', () => {
    const h = new Hausverbrauch();
    h.fuerZyklus(1000, 11_246, 10_084); // stimmig: Grundlast 1162 W
    const a = h.fuerZyklus(3000, 9338, 10_084); // Widerspruch
    assert.equal(a.hausOhneAuto.art, 'geschaetzt');
    assert.equal(Math.round(a.hausOhneAuto.w ?? -1), 1162);
    assert.equal(a.auto.art, 'geschaetzt');
    assert.equal(Math.round(a.auto.w ?? -1), 8176);
    assert.ok(a.schaetzung, 'Schätzung ohne Grundlage');
    assert.equal(a.schaetzung.grundlastAmMs, 1000);
    assert.equal(a.schaetzung.gueltigBisMs, 1000 + HALTBARKEIT_MS);
  });

  it('lässt eine Änderung im Haus nicht unter den Tisch fallen', () => {
    const h = new Hausverbrauch();
    h.fuerZyklus(1000, 11_246, 10_084);
    const a = h.fuerZyklus(3000, 11_246 + 3400, 10_084);
    assert.equal(a.hausOhneAuto.art, 'gemessen');
    assert.equal(Math.round(a.hausOhneAuto.w ?? -1), 4562);
  });

  it('schreibt die Grundlast aus einer Schätzung nicht fort', () => {
    // Sonst verlängerte sich eine Schätzung selbst immer weiter.
    const h = new Hausverbrauch();
    h.fuerZyklus(1000, 11_246, 10_084);
    h.fuerZyklus(3000, 9338, 10_084);
    const spaet = h.fuerZyklus(1000 + HALTBARKEIT_MS + 1, 9338, 10_084);
    assert.equal(spaet.hausOhneAuto.art, 'unbekannt');
  });

  it('behauptet nichts mehr, wenn die Grundlast zu alt ist', () => {
    const h = new Hausverbrauch();
    h.fuerZyklus(1000, 11_246, 10_084);
    const a = h.fuerZyklus(1000 + HALTBARKEIT_MS + 1, 9338, 10_084);
    assert.equal(a.hausOhneAuto.w, null);
    assert.equal(a.auto.w, null);
  });

  it('behauptet nichts, solange noch nie etwas Stimmiges kam', () => {
    const a = new Hausverbrauch().fuerZyklus(1000, 9338, 10_084);
    assert.equal(a.hausOhneAuto.art, 'unbekannt');
    assert.equal(a.hausGesamt.w, 9338);
  });

  it('gibt nie mehr Haus aus, als der Zähler hergibt', () => {
    const h = new Hausverbrauch();
    h.fuerZyklus(1000, 5000, 0); // Grundlast 5000 W
    const a = h.fuerZyklus(2000, 800, 4000);
    assert.equal(a.hausOhneAuto.w, 800);
    assert.equal(a.auto.w, 0);
  });
});

describe('Ein Messzyklus, eine Aufteilung', () => {
  it('liefert vielen Browsern dasselbe und verändert dabei nichts', () => {
    // Vorher rechnete jeder Ereignisstrom selbst und schrieb die Grundlast
    // fort: Mehr offene Handys, andere Ergebnisse.
    const h = new Hausverbrauch();
    h.fuerZyklus(1000, 11_246, 10_084);
    const erste = h.fuerZyklus(3000, 9338, 10_084);
    for (let i = 0; i < 20; i++) {
      // Jeder weitere Client fragt denselben Zyklus — auch mit anderen Werten
      // aus einer späteren Momentaufnahme darf sich nichts verschieben.
      assert.equal(h.fuerZyklus(3000, 9338, 10_084), erste);
      assert.equal(h.fuerZyklus(3000, 20_000, 0), erste);
    }
    const danach = h.fuerZyklus(5000, 9338, 10_084);
    assert.equal(Math.round(danach.hausOhneAuto.w ?? -1), 1162, 'Grundlast wurde verschoben');
  });

  it('dreht das Gedächtnis mit einem älteren Zeitpunkt nicht zurück', () => {
    const h = new Hausverbrauch();
    h.fuerZyklus(5000, 11_246, 10_084);
    h.fuerZyklus(1000, 3000, 0); // verspätet ausgelieferter alter Stand
    const a = h.fuerZyklus(6000, 9338, 10_084);
    assert.equal(Math.round(a.hausOhneAuto.w ?? -1), 1162);
  });
});
