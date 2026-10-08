/**
 * Tagesgrenzen in der Zeitzone der Anlage.
 *
 * Läuft als eigene Datei, weil hier die Zeitzone fest auf Europe/Vienna
 * gestellt wird — node:test startet jede Testdatei in einem eigenen Prozess,
 * die übrigen Tests bleiben davon unberührt.
 *
 * Früher rechnete die Grafik "Tagesbeginn + 24 Stunden". Am Tag der
 * Zeitumstellung stimmt das nicht: Der 29.3.2026 hat 23 Stunden, der
 * 25.10.2026 hat 25.
 */

process.env['TZ'] = 'Europe/Vienna';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { tagesgrenzen, shiftDate, localDate } from './history.ts';

const STUNDE = 3_600_000;

describe('Tagesgrenzen der Anlage', () => {
  it('ein gewöhnlicher Tag hat 24 Stunden', () => {
    const g = tagesgrenzen('2026-08-19');
    assert.equal(g.endeMs - g.beginnMs, 24 * STUNDE);
  });

  it('Beginn der Sommerzeit: 23 Stunden', () => {
    const g = tagesgrenzen('2026-03-29');
    assert.equal(g.endeMs - g.beginnMs, 23 * STUNDE);
  });

  it('Ende der Sommerzeit: 25 Stunden', () => {
    const g = tagesgrenzen('2026-10-25');
    assert.equal(g.endeMs - g.beginnMs, 25 * STUNDE);
    assert.equal(localDate(new Date(g.endeMs)), '2026-10-26');
    assert.equal(shiftDate('2026-10-26', -1), '2026-10-25');
  });

  it('das Tagesende ist der nächste lokale Tagesbeginn', () => {
    assert.equal(tagesgrenzen('2026-03-29').endeMs, tagesgrenzen('2026-03-30').beginnMs);
    assert.equal(tagesgrenzen('2026-10-25').endeMs, tagesgrenzen('2026-10-26').beginnMs);
  });
});
