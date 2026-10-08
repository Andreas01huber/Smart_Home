import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { gesundheit, ZYKLUS_STILLSTAND_MS } from './gesundheit.ts';
import type { Schreibstatus } from './persist.ts';

const ok: Schreibstatus = { datei: 'a.json', letzterErfolgAm: null, fehler: null, fehlerSeit: null, fehlversuche: 0, gesperrt: null };

describe('Healthcheck', () => {
  it('meldet kurz nach dem Start "startet" und ist gesund', () => {
    const g = gesundheit({ startMs: 0, letzterZyklusMs: null, jetztMs: 5_000, speicher: [] });
    assert.equal(g.status, 200);
    assert.equal(g.body.messung, 'startet');
  });

  it('ohne Zyklus nach der Frist ist die Messung stehengeblieben', () => {
    const g = gesundheit({ startMs: 0, letzterZyklusMs: null, jetztMs: ZYKLUS_STILLSTAND_MS + 1, speicher: [] });
    assert.equal(g.status, 503);
    assert.equal(g.body.messung, 'steht');
  });

  it('ein alter letzter Zyklus ergibt 503, ein frischer 200', () => {
    assert.equal(gesundheit({ startMs: 0, letzterZyklusMs: 1_000, jetztMs: 1_000 + ZYKLUS_STILLSTAND_MS, speicher: [] }).status, 503);
    const g = gesundheit({ startMs: 0, letzterZyklusMs: 10_000, jetztMs: 12_000, speicher: [] });
    assert.equal(g.status, 200);
    assert.equal(g.body.letzterZyklusVorS, 2);
  });

  it('Speicherfehler werden gemeldet, ohne den Dienst für krank zu erklären', () => {
    const g = gesundheit({ startMs: 0, letzterZyklusMs: 0, jetztMs: 1_000,
      speicher: [ok, { ...ok, datei: 'b.json', fehler: 'EACCES' }] });
    assert.equal(g.status, 200);
    assert.equal(g.body.speicher, 'fehler');
    const gesperrt = gesundheit({ startMs: 0, letzterZyklusMs: 0, jetztMs: 1_000,
      speicher: [{ ...ok, gesperrt: 'beschädigt' }] });
    assert.equal(gesperrt.body.speicher, 'gesperrt');
  });

  it('enthält keine Dateinamen oder Fehlertexte', () => {
    const g = gesundheit({ startMs: 0, letzterZyklusMs: 0, jetztMs: 1_000,
      speicher: [{ ...ok, datei: 'C:\\geheim\\secrets.json', fehler: 'Pfad C:\\geheim' }] });
    assert.doesNotMatch(JSON.stringify(g.body), /geheim|secrets/);
  });
});
