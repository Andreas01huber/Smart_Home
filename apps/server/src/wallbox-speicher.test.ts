/**
 * Tests des Dosengedächtnisses.
 *
 * Kleiner Zweck, wichtige Wirkung: An der Haushaltssteckdose gilt eine
 * niedrigere Dauerstromgrenze. Ginge die Erkennung bei jedem Neustart
 * verloren, griffe die Grenze erst, nachdem schon geladen wurde.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ladeDose, merkeDose } from './wallbox-speicher.ts';

function ordner(): string {
  return mkdtempSync(join(tmpdir(), 'wallbox-'));
}

describe('Dosengedächtnis', () => {
  it('schreibt und liest die erkannte Dose', () => {
    const dir = ordner();
    merkeDose(dir, { phasen: 1, spannungV: 231.4, erkanntAm: '2026-09-08T21:00:00.000Z' });
    const gelesen = ladeDose(dir);
    assert.equal(gelesen?.phasen, 1);
    assert.equal(gelesen?.spannungV, 231.4);
  });

  it('sagt nichts, wenn es noch nichts gibt', () => {
    assert.equal(ladeDose(ordner()), null);
  });

  it('glaubt keiner kaputten Datei', () => {
    // Lieber die Vorgabe aus config.json als eine erfundene Phasenzahl.
    const dir = ordner();
    writeFileSync(join(dir, 'wallbox.json'), '{ kaputt', 'utf8');
    assert.equal(ladeDose(dir), null);

    writeFileSync(join(dir, 'wallbox.json'), '{"phasen":2,"spannungV":230}', 'utf8');
    assert.equal(ladeDose(dir), null, 'zweiphasig gibt es nicht');

    writeFileSync(join(dir, 'wallbox.json'), '{"phasen":1}', 'utf8');
    assert.equal(ladeDose(dir), null, 'ohne Spannung ist es keine Auskunft');
  });

  it('stört sich nicht an einem unbeschreibbaren Ort', () => {
    // Nicht schreiben zu können darf die Regelung nicht anhalten.
    assert.doesNotThrow(() =>
      merkeDose(join(ordner(), 'gibt-es-nicht'), {
        phasen: 3,
        spannungV: 400,
        erkanntAm: '',
      }),
    );
  });
});
