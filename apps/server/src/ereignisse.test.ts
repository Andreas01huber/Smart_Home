import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ereignisprotokoll } from './ereignisse.ts';

function verzeichnis(): { dir: string; weg: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'smarthome-ereignisse-'));
  return { dir, weg: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('Ereignisprotokoll', () => {
  it('schreibt eine JSON-Zeile je Ereignis und liest sie nach einem Neustart zurück', () => {
    const v = verzeichnis();
    try {
      let t = 0;
      const p = new Ereignisprotokoll(v.dir, () => new Date(1_700_000_000_000 + (t += 1000)));
      p.notiere('laden.befehl', 'Ladestrom auf 10 A gesetzt.', { zielA: 10 });
      p.notiere('wallbox.offline', 'Wallbox nicht erreichbar.');
      const zeilen = readFileSync(join(v.dir, 'ereignisse.jsonl'), 'utf8').trim().split('\n');
      assert.equal(zeilen.length, 2);
      assert.equal(JSON.parse(zeilen[0]!).art, 'laden.befehl');

      const neu = new Ereignisprotokoll(v.dir);
      const letzte = neu.letzte(10);
      assert.equal(letzte.length, 2);
      assert.equal(letzte[0]?.art, 'wallbox.offline', 'neueste zuerst');
      assert.deepEqual(letzte[1]?.details, { zielA: 10 });
    } finally { v.weg(); }
  });

  it('überspringt eine halbe letzte Zeile, statt alles zu verwerfen', () => {
    const v = verzeichnis();
    try {
      const p = new Ereignisprotokoll(v.dir);
      p.notiere('a', 'eins');
      appendFileSync(join(v.dir, 'ereignisse.jsonl'), '{"zeit":"2026-', 'utf8');
      const neu = new Ereignisprotokoll(v.dir);
      assert.equal(neu.letzte().length, 1);
      assert.equal(neu.letzte()[0]?.text, 'eins');
    } finally { v.weg(); }
  });

  it('ein Schreibfehler hält den Dienst nicht an, wird aber gemeldet', () => {
    const p = new Ereignisprotokoll(join(tmpdir(), 'gibt-es-nicht', 'wirklich-nicht'));
    p.notiere('x', 'y');
    assert.ok(p.schreibfehler() !== null);
    assert.equal(p.letzte().length, 1, 'im Speicher bleibt es trotzdem');
  });
});
