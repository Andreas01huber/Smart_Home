/**
 * Tests des Speichergedächtnisses.
 *
 * Die eine Frage dahinter: Darf die Regelung mit einer Zahl rechnen, die sie
 * nicht selbst gemessen hat? Antwort: nein. Diese Tests halten das fest.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bewaehrtW,
  gedaechtnisAusMesswerten,
  LEERES_GEDAECHTNIS,
  merkeEntladung,
  NACHWEIS_FENSTER_MS,
  nachweisZuruecknehmen,
} from './speichergedaechtnis.ts';
import type { SpeicherZustand } from './ueberschuss.ts';

function speicher(entladenW: number, id = 'gross'): SpeicherZustand[] {
  return [{ id, name: 'Speicher', socPercent: 90, ladenW: 0, entladenW }];
}

describe('Nachweis wächst mit dem, was wirklich fliesst', () => {
  it('merkt sich die höchste gesehene Entladeleistung', () => {
    let g = LEERES_GEDAECHTNIS;
    g = merkeEntladung(g, speicher(1200), 1000);
    g = merkeEntladung(g, speicher(4222), 2000);
    g = merkeEntladung(g, speicher(800), 3000);
    assert.equal(bewaehrtW(g, 'gross'), 4222);
  });

  it('kennt einen unbekannten Speicher mit null', () => {
    assert.equal(bewaehrtW(LEERES_GEDAECHTNIS, 'gibtsnicht'), 0);
  });

  it('gibt dasselbe Objekt zurück, wenn sich nichts ändert', () => {
    // Wichtig, weil das im Zwei-Sekunden-Takt läuft: Ein neues Objekt bei jedem
    // Messwert wäre Müll für den Sammler und macht Vergleiche wertlos.
    const g = merkeEntladung(LEERES_GEDAECHTNIS, speicher(3000), 1000);
    assert.equal(merkeEntladung(g, speicher(3000), 2000), g);
    assert.equal(merkeEntladung(g, speicher(500), 3000), g);
  });

  it('vergisst einen Nachweis, der zu alt geworden ist', () => {
    let g = merkeEntladung(LEERES_GEDAECHTNIS, speicher(4000), 0);
    // Am nächsten Tag liefert derselbe Speicher nur noch 900 W. Dass er gestern
    // 4000 W konnte, darf keine Ewigkeitsgarantie sein.
    g = merkeEntladung(g, speicher(900), NACHWEIS_FENSTER_MS + 1);
    assert.equal(bewaehrtW(g, 'gross'), 900);
  });

  it('hält den Nachweis innerhalb des Fensters', () => {
    let g = merkeEntladung(LEERES_GEDAECHTNIS, speicher(4000), 0);
    g = merkeEntladung(g, speicher(900), NACHWEIS_FENSTER_MS - 1000);
    assert.equal(bewaehrtW(g, 'gross'), 4000);
  });
});

describe('Nachweis schrumpft, wenn die Annahme zu gross war', () => {
  it('fällt auf das, was der Speicher gerade wirklich liefert', () => {
    let g = merkeEntladung(LEERES_GEDAECHTNIS, speicher(4000), 0);
    // Es kam Strom aus dem Netz, obwohl mit dem Speicher gerechnet wurde.
    g = nachweisZuruecknehmen(g, speicher(1200), 1000);
    assert.equal(bewaehrtW(g, 'gross'), 1200);
  });

  it('erhöht dabei niemals', () => {
    // Sonst wäre "zurücknehmen" ein Weg, sich einen Nachweis zu erschleichen.
    const g = merkeEntladung(LEERES_GEDAECHTNIS, speicher(1000), 0);
    const nachher = nachweisZuruecknehmen(g, speicher(3000), 1000);
    assert.equal(bewaehrtW(nachher, 'gross'), 1000);
    assert.equal(nachher, g, 'hätte unverändert bleiben müssen');
  });

  it('lässt sich danach wieder hochverdienen', () => {
    let g = merkeEntladung(LEERES_GEDAECHTNIS, speicher(4000), 0);
    g = nachweisZuruecknehmen(g, speicher(1200), 1000);
    // Am Abend zieht das Haus kräftig und der Speicher liefert doch 3800 W.
    g = merkeEntladung(g, speicher(3800), 2000);
    assert.equal(bewaehrtW(g, 'gross'), 3800);
  });
});

describe('Gedächtnis aus dem Tagesarchiv', () => {
  it('nimmt je Speicher das Maximum', () => {
    const g = gedaechtnisAusMesswerten(
      [
        { id: 'gross', entladenW: 3235, tMs: 1000 },
        { id: 'gross', entladenW: 4222, tMs: 2000 },
        { id: 'klein', entladenW: 4602, tMs: 2000 },
        { id: 'klein', entladenW: 0, tMs: 3000 },
      ],
      5000,
    );
    assert.equal(bewaehrtW(g, 'gross'), 4222);
    assert.equal(bewaehrtW(g, 'klein'), 4602);
  });

  it('übergeht Punkte, die älter sind als das Fenster', () => {
    const g = gedaechtnisAusMesswerten(
      [{ id: 'gross', entladenW: 4222, tMs: 0 }],
      NACHWEIS_FENSTER_MS + 1,
    );
    assert.equal(bewaehrtW(g, 'gross'), 0);
  });
});
