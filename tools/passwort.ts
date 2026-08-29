/**
 * Legt Benutzername und Passwort für die Anmeldung an.
 *
 *     npm run passwort
 *
 * Geschrieben wird nach secrets.json — dieselbe Datei wie die Wallbox-Zugangs-
 * daten, und aus demselben Grund: Sie ist über .gitignore ausgeschlossen und
 * landet weder im Repository noch in einem Docker-Image.
 *
 * Das Passwort selbst wird NICHT gespeichert, nur sein scrypt-Hash. Wer die
 * Datei liest, kann sich damit nicht anmelden.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

import { hashPassword } from '../apps/server/src/auth.ts';
import { writeJsonAtomic } from '../apps/server/src/persist.ts';

const PFAD = resolve(process.cwd(), 'secrets.json');
const MINDESTLAENGE = 10;

function frage(text: string, versteckt = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  if (!versteckt) {
    return new Promise((fertig) => {
      rl.question(text, (antwort) => {
        rl.close();
        fertig(antwort.trim());
      });
    });
  }

  // Eingabe unsichtbar machen: readline schreibt sonst jedes Zeichen ins
  // Terminal, und ein Passwort hat auf dem Bildschirm nichts verloren - erst
  // recht nicht im Rückscroll-Puffer eines Server-Fensters.
  return new Promise((fertig) => {
    const schreiben = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    let erste = true;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (
      s: string,
    ): void {
      if (erste) {
        schreiben.call(this, text);
        erste = false;
      }
    };
    rl.question(text, (antwort) => {
      rl.close();
      process.stdout.write('\n');
      fertig(antwort);
    });
  });
}

function vorhandeneGeheimnisse(): Record<string, unknown> {
  if (!existsSync(PFAD)) return {};
  try {
    const roh: unknown = JSON.parse(readFileSync(PFAD, 'utf8'));
    return typeof roh === 'object' && roh !== null ? (roh as Record<string, unknown>) : {};
  } catch {
    console.error('  secrets.json ist nicht lesbar. Bitte von Hand prüfen.');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log('');
  console.log('  Anmeldung für SmartHome einrichten');
  console.log('  ----------------------------------');
  console.log('');

  const geheim = vorhandeneGeheimnisse();
  const bisher = (geheim['auth'] ?? {}) as Record<string, unknown>;
  const alterName = typeof bisher['username'] === 'string' ? bisher['username'] : '';

  const vorgabe = alterName || 'andreas';
  const eingabe = await frage(`  Benutzername [${vorgabe}]: `);
  const username = eingabe || vorgabe;

  const passwort = await frage('  Passwort: ', true);
  if (passwort.length < MINDESTLAENGE) {
    console.error(`\n  Zu kurz - mindestens ${MINDESTLAENGE} Zeichen.`);
    console.error('  Die Adresse ist über den Tunnel öffentlich erreichbar; ein kurzes');
    console.error('  Passwort ist dort in überschaubarer Zeit durchprobiert.\n');
    process.exit(1);
  }

  const wiederholung = await frage('  Passwort wiederholen: ', true);
  if (passwort !== wiederholung) {
    console.error('\n  Die beiden Eingaben stimmen nicht überein.\n');
    process.exit(1);
  }

  // Vorhandenes Sitzungsgeheimnis behalten. Neu wäre es nicht falsch, aber
  // ohne Not meldet man niemanden ab - und das Passwort geht ohnehin in die
  // Signatur ein, alte Sitzungen sind also so oder so hinfällig.
  const sessionSecret =
    typeof bisher['sessionSecret'] === 'string' && bisher['sessionSecret'].length >= 32
      ? bisher['sessionSecret']
      : randomBytes(32).toString('hex');

  writeJsonAtomic(
    PFAD,
    {
      ...geheim,
      auth: { username, passwordHash: hashPassword(passwort), sessionSecret },
    },
    2,
  );

  console.log('');
  console.log(`  Gespeichert in ${PFAD}`);
  console.log(`  Benutzer: ${username}`);
  console.log('');
  console.log('  Der Server übernimmt das beim nächsten Start. Bereits angemeldete');
  console.log('  Geräte müssen sich neu anmelden - ein geändertes Passwort macht');
  console.log('  alle bestehenden Sitzungen ungültig.');
  console.log('');
}

void main();
