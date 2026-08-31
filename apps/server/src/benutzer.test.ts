/**
 * Tests der Kontenverwaltung.
 *
 * Zwei Dinge stehen im Mittelpunkt: dass die Umstellung vom alten Ein-Konto-
 * Format niemanden aussperrt, und dass sich die Verwaltung nicht selbst
 * zusperren lässt — ein Haus ohne Administrator wäre nur noch über die Konsole
 * des Servers zu öffnen.
 *
 * Die Passwörter sind absichtlich kurz gehalten: scrypt kostet rund 100 ms pro
 * Prüfung, und jedes überflüssige Hashen verlängert den Testlauf spürbar.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword } from './auth.ts';
import { Kontenspeicher, leseAuth, nameGueltig } from './benutzer.ts';

const ordner: string[] = [];
function neueDatei(inhalt?: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'konten-'));
  ordner.push(d);
  const pfad = join(d, 'secrets.json');
  if (inhalt !== undefined) writeFileSync(pfad, JSON.stringify(inhalt, null, 2), 'utf8');
  return pfad;
}

afterEach(() => {
  while (ordner.length > 0) {
    const d = ordner.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const GEHEIM = 'a'.repeat(64);

describe('Benutzernamen', () => {
  it('lässt normale Namen zu', () => {
    for (const name of ['Andreas', 'Max Mustermann', 'anna.b', 'Jörg-Peter', 'kind_1']) {
      assert.equal(nameGueltig(name), true, name);
    }
  });

  it('weist ab, was in HTML Ärger machen würde', () => {
    for (const name of ['', 'a', '<img src=x>', 'a'.repeat(33), 'weg;rm', 'a"b']) {
      assert.equal(nameGueltig(name), false, name);
    }
  });
});

describe('Lesen aus secrets.json', () => {
  it('macht aus dem alten Ein-Konto-Format ein Admin-Konto', () => {
    // Wer bisher `npm run passwort` benutzt hat, darf durch das Update nicht
    // ausgesperrt werden - und muss Administrator sein, sonst käme niemand mehr
    // in die Verwaltung.
    const daten = leseAuth({
      username: 'andreas',
      passwordHash: hashPassword('altes-passwort'),
      sessionSecret: GEHEIM,
    });
    assert.ok(daten);
    assert.equal(daten.benutzer.length, 1);
    assert.equal(daten.benutzer[0]?.username, 'andreas');
    assert.equal(daten.benutzer[0]?.rolle, 'admin');
    assert.equal(daten.sessionSecret, GEHEIM);
  });

  it('gibt null, wenn gar kein Konto eingerichtet ist', () => {
    assert.equal(leseAuth(undefined), null);
    assert.equal(leseAuth({}), null);
    assert.equal(leseAuth({ benutzer: [] }), null);
    assert.equal(leseAuth({ username: 'ohne-hash' }), null);
  });

  it('befördert den ersten Eintrag, wenn kein Administrator übrig ist', () => {
    const daten = leseAuth({
      sessionSecret: GEHEIM,
      benutzer: [
        { id: 'a', username: 'Anna', passwordHash: hashPassword('x'), rolle: 'benutzer' },
        { id: 'b', username: 'Bert', passwordHash: hashPassword('y'), rolle: 'benutzer' },
      ],
    });
    assert.equal(daten?.benutzer[0]?.rolle, 'admin');
    assert.equal(daten?.benutzer[1]?.rolle, 'benutzer');
  });

  it('erzeugt ein neues Sitzungsgeheimnis, wenn keines taugt', () => {
    const daten = leseAuth({
      sessionSecret: 'zu-kurz',
      benutzer: [{ id: 'a', username: 'Anna', passwordHash: hashPassword('x'), rolle: 'admin' }],
    });
    assert.ok((daten?.sessionSecret.length ?? 0) >= 32);
    assert.notEqual(daten?.sessionSecret, 'zu-kurz');
  });
});

describe('Kontenspeicher', () => {
  it('legt an, findet wieder und meldet an', () => {
    const pfad = neueDatei();
    const speicher = Kontenspeicher.ladenOderNeu(pfad);
    const angelegt = speicher.anlegen({
      username: 'Andreas',
      passwort: 'ein-langes-passwort',
      rolle: 'admin',
      angelegtVon: null,
    });
    assert.equal(angelegt.ok, true);

    assert.equal(speicher.anmelden('Andreas', 'ein-langes-passwort')?.username, 'Andreas');
    assert.equal(speicher.anmelden('Andreas', 'falsch-aber-lang'), null);
    assert.equal(speicher.anmelden('gibtsnicht', 'ein-langes-passwort'), null);
  });

  it('erkennt den Namen unabhängig von Gross- und Kleinschreibung', () => {
    // Handytastaturen schreiben den ersten Buchstaben von selbst gross. Wer sich
    // deshalb nicht anmelden könnte, würde das nie herausfinden.
    const pfad = neueDatei();
    const speicher = Kontenspeicher.ladenOderNeu(pfad);
    speicher.anlegen({
      username: 'Andreas',
      passwort: 'ein-langes-passwort',
      rolle: 'admin',
      angelegtVon: null,
    });
    assert.ok(speicher.anmelden('andreas', 'ein-langes-passwort'));
    assert.ok(speicher.anmelden('ANDREAS', 'ein-langes-passwort'));
  });

  it('vergibt denselben Namen kein zweites Mal', () => {
    const pfad = neueDatei();
    const speicher = Kontenspeicher.ladenOderNeu(pfad);
    const wunsch = {
      passwort: 'ein-langes-passwort',
      rolle: 'benutzer',
      angelegtVon: null,
    } as const;
    assert.equal(speicher.anlegen({ ...wunsch, username: 'Anna' }).ok, true);
    const zweite = speicher.anlegen({ ...wunsch, username: 'anna' });
    assert.equal(zweite.ok, false);
    assert.equal(zweite.ok === false ? zweite.fehler : '', 'name-vergeben');
  });

  it('lehnt zu kurze Passwörter ab', () => {
    const pfad = neueDatei();
    const speicher = Kontenspeicher.ladenOderNeu(pfad);
    const ergebnis = speicher.anlegen({
      username: 'Kurz',
      passwort: 'kurz',
      rolle: 'benutzer',
      angelegtVon: null,
    });
    assert.equal(ergebnis.ok, false);
    assert.equal(ergebnis.ok === false ? ergebnis.fehler : '', 'passwort-kurz');
  });

  it('lässt den letzten Administrator weder löschen noch zurückstufen', () => {
    const pfad = neueDatei();
    const speicher = Kontenspeicher.ladenOderNeu(pfad);
    const admin = speicher.anlegen({
      username: 'Andreas',
      passwort: 'ein-langes-passwort',
      rolle: 'admin',
      angelegtVon: null,
    });
    assert.equal(admin.ok, true);
    const id = admin.ok ? admin.benutzer.id : '';

    assert.equal(speicher.loeschen(id).ok, false);
    assert.equal(speicher.rolleSetzen(id, 'benutzer').ok, false);

    // Mit einem zweiten Administrator geht beides.
    speicher.anlegen({
      username: 'Zweiter',
      passwort: 'ein-langes-passwort',
      rolle: 'admin',
      angelegtVon: 'Andreas',
    });
    assert.equal(speicher.rolleSetzen(id, 'benutzer').ok, true);
  });

  it('behält alles andere in secrets.json', () => {
    // In derselben Datei stehen die Tuya-Zugangsdaten der Wallbox. Ein neues
    // Konto darf die Wallbox nicht abklemmen.
    const pfad = neueDatei({ tuya: { accessId: 'abc', accessSecret: 'geheim' } });
    const speicher = Kontenspeicher.ladenOderNeu(pfad);
    speicher.anlegen({
      username: 'Andreas',
      passwort: 'ein-langes-passwort',
      rolle: 'admin',
      angelegtVon: null,
    });
    const datei = JSON.parse(readFileSync(pfad, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(datei['tuya'], { accessId: 'abc', accessSecret: 'geheim' });
  });

  it('speichert das Passwort nirgends im Klartext', () => {
    const pfad = neueDatei();
    const speicher = Kontenspeicher.ladenOderNeu(pfad);
    speicher.anlegen({
      username: 'Andreas',
      passwort: 'sehr-geheimes-wort',
      rolle: 'admin',
      angelegtVon: null,
    });
    assert.equal(readFileSync(pfad, 'utf8').includes('sehr-geheimes-wort'), false);
  });

  it('übersteht einen Neustart', () => {
    const pfad = neueDatei();
    const erst = Kontenspeicher.ladenOderNeu(pfad);
    erst.anlegen({
      username: 'Andreas',
      passwort: 'ein-langes-passwort',
      rolle: 'admin',
      angelegtVon: null,
    });

    const wieder = Kontenspeicher.laden(pfad);
    assert.ok(wieder);
    assert.equal(wieder.anzahl(), 1);
    assert.ok(wieder.anmelden('Andreas', 'ein-langes-passwort'));
    // Dasselbe Sitzungsgeheimnis - sonst wären nach jedem Neustart des Servers
    // alle Geräte abgemeldet.
    assert.equal(wieder.sessionSecret, erst.sessionSecret);
  });

  it('ist ohne Konto nicht "eingerichtet"', () => {
    assert.equal(Kontenspeicher.laden(neueDatei()), null);
  });

  it('holt ein altes Ein-Konto-secrets.json ab und schreibt es um', () => {
    // Der Weg, den jeder bestehende Server beim ersten Start nach dem Update
    // geht. Er muss sich mit demselben Passwort wie vorher anmelden koennen -
    // und danach Administrator sein.
    const pfad = neueDatei({
      tuya: { accessId: 'abc', accessSecret: 'geheim' },
      auth: {
        username: 'andreas',
        passwordHash: hashPassword('altes-passwort'),
        sessionSecret: GEHEIM,
      },
    });

    const speicher = Kontenspeicher.laden(pfad);
    assert.ok(speicher);
    const angemeldet = speicher.anmelden('andreas', 'altes-passwort');
    assert.equal(angemeldet?.rolle, 'admin');

    const datei = JSON.parse(readFileSync(pfad, 'utf8')) as {
      tuya: unknown;
      auth: { sessionSecret: string; benutzer: { username: string }[] };
    };
    assert.deepEqual(datei.tuya, { accessId: 'abc', accessSecret: 'geheim' });
    assert.equal(datei.auth.benutzer.length, 1);
    assert.equal(datei.auth.benutzer[0]?.username, 'andreas');
    // Dasselbe Sitzungsgeheimnis - sonst waeren die alten Kekse zweimal
    // ungueltig, was nichts schadet, aber auch nichts bringt.
    assert.equal(datei.auth.sessionSecret, GEHEIM);
    // Die alten Felder sind weg, sonst laege dieselbe Angabe doppelt in der
    // Datei und man wuesste bei einer Aenderung nicht, welche gilt.
    assert.equal('username' in (datei.auth as object), false);
  });
});
