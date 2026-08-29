/**
 * Legt Benutzername und Passwort für die Anmeldung an.
 *
 *     npm run passwort
 *
 * Geschrieben wird nach secrets.json — dieselbe Datei wie die Wallbox-Zugangs-
 * daten, und aus demselben Grund: Sie ist über .gitignore ausgeschlossen und
 * landet weder im Repository noch in einem Docker-Image. Was schon in der Datei
 * steht, bleibt unangetastet.
 *
 * Das Passwort selbst wird NICHT gespeichert, nur sein scrypt-Hash. Wer die
 * Datei liest, kann sich damit nicht anmelden.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { resolve } from 'node:path';

import { hashPassword } from '../apps/server/src/auth.ts';
import { writeJsonAtomic } from '../apps/server/src/persist.ts';

const PFAD = resolve(process.cwd(), 'secrets.json');
const MINDESTLAENGE = 10;

/**
 * Am Terminal getippt oder aus einer Pipe gefüttert?
 *
 * Beides muss gehen: von Hand auf dem Server ist der Normalfall, aus einer
 * Pipe braucht man für Tests und für die Ersteinrichtung per Skript.
 */
const interaktiv = process.stdin.isTTY === true;

/**
 * EINE readline-Instanz für alle Fragen.
 *
 * Pro Frage eine neue zu öffnen sieht harmloser aus, verschluckt aber die
 * restliche Eingabe: Die erste Instanz puffert, was nach ihrer Zeile kommt, und
 * beim Schliessen ist es weg. Die zweite Frage wartet dann ewig.
 */
const rl: Interface | null = interaktiv
  ? createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  : null;

/**
 * Schalter für die verdeckte Eingabe.
 *
 * readline schreibt jedes getippte Zeichen ins Terminal. Ein Passwort hat dort
 * nichts verloren — erst recht nicht im Rückscroll-Puffer eines Server-Fensters,
 * das tagelang offen steht.
 */
let maske = false;
if (rl) {
  const rlIntern = rl as unknown as { _writeToOutput?: (s: string) => void };
  const schreibenOriginal = rlIntern._writeToOutput?.bind(rl);
  if (schreibenOriginal) {
    rlIntern._writeToOutput = (s: string): void => {
      if (!maske) schreibenOriginal(s);
    };
  }
}

/**
 * Zeilen aus einer Pipe, vorab und vollständig gelesen.
 *
 * readline liefert bei einem Strom, der kein Terminal ist, alle Zeilen sofort
 * aus. Zwischen zwei Fragen liegt aber ein await — was in dieser Lücke
 * ankommt, hört niemand mehr, und die zweite Frage wartet bis in alle
 * Ewigkeit. Deshalb hier alles auf einmal einsammeln und der Reihe nach
 * ausgeben.
 */
async function leseAlleZeilen(): Promise<string[]> {
  const stuecke: Buffer[] = [];
  for await (const stueck of process.stdin) stuecke.push(Buffer.from(stueck as Buffer));
  return Buffer.concat(stuecke).toString('utf8').split(/\r?\n/);
}

let vorrat: string[] = [];
let gelesen = false;

async function frage(text: string, versteckt = false): Promise<string> {
  if (!interaktiv) {
    if (!gelesen) {
      vorrat = await leseAlleZeilen();
      gelesen = true;
    }
    const antwort = vorrat.shift() ?? '';
    process.stdout.write(`${text}${versteckt ? '' : antwort}\n`);
    return versteckt ? antwort : antwort.trim();
  }

  const stelleFrage = (aufforderung: string): Promise<string> =>
    new Promise((fertig) => rl?.question(aufforderung, fertig));

  if (!versteckt) return (await stelleFrage(text)).trim();

  // Die Eingabeaufforderung selbst schreiben, DANN erst maskieren - sonst wäre
  // auch sie unsichtbar und man säße vor einem leeren Bildschirm.
  process.stdout.write(text);
  maske = true;
  const antwort = await stelleFrage('');
  maske = false;
  process.stdout.write('\n');
  return antwort;
}

function vorhandeneGeheimnisse(): Record<string, unknown> {
  if (!existsSync(PFAD)) return {};
  try {
    const roh: unknown = JSON.parse(readFileSync(PFAD, 'utf8'));
    return typeof roh === 'object' && roh !== null ? (roh as Record<string, unknown>) : {};
  } catch {
    console.error('');
    console.error(`  ${PFAD} ist nicht lesbar (kein gültiges JSON).`);
    console.error('  Bitte von Hand prüfen - hier wird nichts überschrieben.');
    console.error('');
    process.exit(1);
  }
}

function abbruch(...zeilen: readonly string[]): never {
  console.error('');
  for (const zeile of zeilen) console.error(`  ${zeile}`);
  console.error('');
  rl?.close();
  process.exit(1);
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
    abbruch(
      `Zu kurz - mindestens ${MINDESTLAENGE} Zeichen.`,
      'Die Adresse ist über den Tunnel öffentlich erreichbar; ein kurzes',
      'Passwort ist dort in überschaubarer Zeit durchprobiert.',
    );
  }

  const wiederholung = await frage('  Passwort wiederholen: ', true);
  if (passwort !== wiederholung) {
    abbruch('Die beiden Eingaben stimmen nicht überein. Nichts geändert.');
  }

  // Vorhandenes Sitzungsgeheimnis behalten. Neu wäre nicht falsch, aber ohne Not
  // meldet man niemanden ab - und das Passwort geht ohnehin in die Signatur ein,
  // alte Sitzungen sind also so oder so hinfällig.
  const sessionSecret =
    typeof bisher['sessionSecret'] === 'string' && bisher['sessionSecret'].length >= 32
      ? bisher['sessionSecret']
      : randomBytes(32).toString('hex');

  // Alles Übrige aus der Datei bleibt stehen - insbesondere die Tuya-Zugangs-
  // daten der Wallbox. Ein Passwortwechsel darf die Wallbox nicht abklemmen.
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
  console.log('  Jetzt den Server neu starten - die Anmeldung wird beim Start gelesen.');
  console.log('  Bereits angemeldete Geräte müssen sich neu anmelden: Ein geändertes');
  console.log('  Passwort macht alle bestehenden Sitzungen ungültig.');
  console.log('');
  rl?.close();
}

void main();
