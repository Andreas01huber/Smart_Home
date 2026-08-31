/**
 * Tests der angemeldeten Geräte.
 *
 * Der wichtigste Punkt steht ganz unten: Kekse aus der alten, gerechneten Form
 * dürfen nicht mehr gelten. Sonst bliebe nach dem Update jedes Gerät angemeldet,
 * das vorher angemeldet war — und genau das soll die Umstellung beenden.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_TTL_MS } from './auth.ts';
import { geraetName, Sitzungsspeicher } from './sitzungen.ts';

const ordner: string[] = [];
function neuerPfad(): string {
  const d = mkdtempSync(join(tmpdir(), 'sitzung-'));
  ordner.push(d);
  return join(d, 'sitzungen.json');
}

afterEach(() => {
  while (ordner.length > 0) {
    const d = ordner.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const GEHEIM = 'a'.repeat(64);

describe('Sitzungen', () => {
  it('erkennt einen frisch ausgestellten Keks wieder', () => {
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const keks = s.neu('u1', 'iPhone · Safari', '192.168.178.20');
    const sitzung = s.pruefe(keks);
    assert.equal(sitzung?.benutzerId, 'u1');
    assert.equal(sitzung?.geraet, 'iPhone · Safari');
    assert.equal(sitzung?.herkunft, '192.168.178.20');
  });

  it('lehnt Unsinn ab, statt zu stolpern', () => {
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    for (const murks of [undefined, '', '.', 'abc', 'abc.def', 'a.b.c']) {
      assert.equal(s.pruefe(murks), null, String(murks));
    }
  });

  it('lehnt einen Keks mit falscher Signatur ab', () => {
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const keks = s.neu('u1', 'Windows · Chrome', '10.0.0.5');
    const id = keks.split('.')[0] ?? '';
    assert.equal(s.pruefe(`${id}.gefaelscht`), null);
  });

  it('gilt nicht mit einem fremden Sitzungsgeheimnis', () => {
    const pfad = neuerPfad();
    const a = new Sitzungsspeicher(pfad, GEHEIM);
    const keks = a.neu('u1', 'Mac · Safari', '10.0.0.5');
    a.persist();

    const b = new Sitzungsspeicher(pfad, 'b'.repeat(64));
    assert.equal(b.pruefe(keks), null);
  });

  it('lehnt einen Keks aus der alten, gerechneten Form ab', () => {
    // Vor der Umstellung war der Keks `<ablauf>.<signatur>` und kam ganz ohne
    // Liste auf dem Server aus. Solche Kekse müssen ungültig sein - sonst bliebe
    // nach dem Update jedes Gerät angemeldet.
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const alt = `${Date.now() + SESSION_TTL_MS}.irgendeinesignatur`;
    assert.equal(s.pruefe(alt), null);
  });

  it('lässt einen abgelaufenen Keks nicht mehr durch', () => {
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const keks = s.neu('u1', 'Android · Chrome', '10.0.0.5');
    assert.equal(s.pruefe(keks, Date.now() + SESSION_TTL_MS + 1000), null);
  });

  it('verlängert die Sitzung bei jedem Zugriff', () => {
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const start = Date.now();
    const keks = s.neu('u1', 'Windows · Edge', '10.0.0.5', start);
    const spaeter = start + 100 * 24 * 60 * 60 * 1000;
    const sitzung = s.pruefe(keks, spaeter);
    assert.ok(sitzung);
    assert.equal(sitzung.ablauf, spaeter + SESSION_TTL_MS);
    assert.equal(sitzung.letzterZugriff, spaeter);
  });

  it('meldet ein einzelnes Gerät ab, ohne die anderen mitzunehmen', () => {
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const handy = s.neu('u1', 'iPhone · Safari', '10.0.0.5');
    const laptop = s.neu('u1', 'Windows · Chrome', '10.0.0.6');

    const id = handy.split('.')[0] ?? '';
    assert.equal(s.beende(id), true);
    assert.equal(s.pruefe(handy), null);
    assert.ok(s.pruefe(laptop));
  });

  it('meldet alle Geräte eines Kontos ab', () => {
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const meins1 = s.neu('u1', 'iPhone', '10.0.0.5');
    const meins2 = s.neu('u1', 'Windows', '10.0.0.6');
    const fremd = s.neu('u2', 'Android', '10.0.0.7');

    assert.equal(s.beendeVonBenutzer('u1'), 2);
    assert.equal(s.pruefe(meins1), null);
    assert.equal(s.pruefe(meins2), null);
    assert.ok(s.pruefe(fremd));
  });

  it('meldet auf Wunsch alle ab', () => {
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const a = s.neu('u1', 'iPhone', '10.0.0.5');
    const b = s.neu('u2', 'Android', '10.0.0.7');
    assert.equal(s.beendeAlle(), 2);
    assert.equal(s.pruefe(a), null);
    assert.equal(s.pruefe(b), null);
    assert.equal(s.alle().length, 0);
  });

  it('übersteht einen Neustart des Servers', () => {
    // Ohne das müsste sich nach jedem Deploy jeder neu anmelden.
    const pfad = neuerPfad();
    const erst = new Sitzungsspeicher(pfad, GEHEIM);
    const keks = erst.neu('u1', 'iPhone · Safari', '10.0.0.5');
    erst.persist();

    const wieder = new Sitzungsspeicher(pfad, GEHEIM);
    assert.equal(wieder.pruefe(keks)?.benutzerId, 'u1');
  });

  it('nimmt beim Laden nichts Abgelaufenes mit', () => {
    const pfad = neuerPfad();
    const erst = new Sitzungsspeicher(pfad, GEHEIM);
    erst.neu('u1', 'iPhone', '10.0.0.5', Date.now() - SESSION_TTL_MS - 60_000);
    erst.persist();

    assert.equal(new Sitzungsspeicher(pfad, GEHEIM).alle().length, 0);
  });

  it('sagt dem offenen Ereignisstrom, wann er zumachen muss', () => {
    // Der Strom bleibt stundenlang offen und fragt vor jedem Ereignis nach.
    // Ohne diese Antwort liefe er nach einem "Gerät abmelden" einfach weiter.
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const keks = s.neu('u1', 'iPhone', '10.0.0.5');
    const id = keks.split('.')[0] ?? '';

    assert.equal(s.gilt(id), true);
    s.beende(id);
    assert.equal(s.gilt(id), false);
    assert.equal(s.gilt('gibtsnicht'), false);
  });

  it('sortiert die zuletzt benutzten nach oben', () => {
    const s = new Sitzungsspeicher(neuerPfad(), GEHEIM);
    const jetzt = Date.now();
    s.neu('alt', 'iPhone', '10.0.0.5', jetzt - 60_000);
    s.neu('neu', 'Android', '10.0.0.6', jetzt);
    assert.equal(s.alle()[0]?.benutzerId, 'neu');
  });
});

describe('Gerätename', () => {
  it('erkennt die üblichen Verdächtigen', () => {
    const faelle: readonly (readonly [string, string])[] = [
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'iPhone · Safari',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Windows · Chrome',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
        'Windows · Edge',
      ],
      [
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
        'Android · Chrome',
      ],
    ];
    for (const [ua, erwartet] of faelle) assert.equal(geraetName(ua), erwartet, ua);
  });

  it('kommt ohne User-Agent zurecht', () => {
    assert.equal(geraetName(undefined), 'Unbekanntes Gerät');
    assert.equal(geraetName('   '), 'Unbekanntes Gerät');
  });
});
