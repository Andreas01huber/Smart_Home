/**
 * Legt ein Administrator-Konto an oder setzt dessen Passwort neu.
 *
 *     npm run passwort
 *
 * Das ist der Weg für das allererste Konto — und der Rückweg, wenn niemand mehr
 * in die Verwaltung kommt. Alle weiteren Konten legt man bequemer unter /admin
 * im Browser an.
 *
 * Geschrieben wird nach secrets.json — dieselbe Datei wie die Wallbox-Zugangs-
 * daten, und aus demselben Grund: Sie ist über .gitignore ausgeschlossen und
 * landet weder im Repository noch in einem Docker-Image. Was schon in der Datei
 * steht, bleibt unangetastet.
 *
 * Das Passwort selbst wird NICHT gespeichert, nur sein scrypt-Hash. Wer die
 * Datei liest, kann sich damit nicht anmelden.
 */

import { createInterface, type Interface } from 'node:readline';
import { resolve } from 'node:path';

import { Kontenspeicher, MINDESTLAENGE_PASSWORT } from '../apps/server/src/benutzer.ts';
import { Sitzungsspeicher } from '../apps/server/src/sitzungen.ts';

const PFAD = resolve(process.cwd(), 'secrets.json');
const SITZUNGEN = resolve(process.cwd(), 'data', 'sitzungen.json');
const MINDESTLAENGE = MINDESTLAENGE_PASSWORT;

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

function abbruch(...zeilen: readonly string[]): never {
  console.error('');
  for (const zeile of zeilen) console.error(`  ${zeile}`);
  console.error('');
  rl?.close();
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('');
  console.log('  Administrator-Konto für SmartHome');
  console.log('  ---------------------------------');
  console.log('');

  const speicher = Kontenspeicher.ladenOderNeu(PFAD);
  const vorhanden = speicher.alle();

  if (vorhanden.length > 0) {
    console.log('  Vorhandene Konten:');
    for (const b of vorhanden) {
      console.log(`     ${b.username}${b.rolle === 'admin' ? '  (Administrator)' : ''}`);
    }
    console.log('');
    console.log('  Ein bekannter Name setzt dessen Passwort neu, ein neuer Name legt');
    console.log('  ein zusätzliches Administrator-Konto an.');
    console.log('');
  }

  // Vorgabe ist der erste Administrator - wer das Werkzeug aufruft, will fast
  // immer genau dessen Passwort setzen.
  const vorgabe = vorhanden.find((b) => b.rolle === 'admin')?.username ?? 'Andreas';
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

  const bekannt = speicher.nachName(username);
  let neu = false;

  if (bekannt) {
    const gesetzt = speicher.passwortSetzen(bekannt.id, passwort);
    if (!gesetzt.ok) abbruch(`Abgelehnt (${gesetzt.fehler}). Nichts geändert.`);

    // Zum Administrator machen, falls noch nicht. Dieses Werkzeug läuft an der
    // Konsole des Servers - wer dort steht, hat ohnehin vollen Zugriff. Und es
    // ist der Rückweg, wenn niemand mehr in die Verwaltung kommt.
    if (bekannt.rolle !== 'admin') {
      speicher.rolleSetzen(bekannt.id, 'admin');
      console.log('');
      console.log(`  "${bekannt.username}" ist jetzt Administrator.`);
    }
  } else {
    const angelegt = speicher.anlegen({
      username,
      passwort,
      rolle: 'admin',
      angelegtVon: null,
    });
    if (!angelegt.ok) {
      abbruch(
        angelegt.fehler === 'name-ungueltig'
          ? 'Benutzername nicht erlaubt: 2 bis 32 Zeichen, nur Buchstaben, Ziffern, Leerzeichen, Punkt, Strich, Unterstrich.'
          : `Abgelehnt (${angelegt.fehler}). Nichts geändert.`,
      );
    }
    neu = true;
  }

  // Alle Geräte dieses Kontos abmelden. Ein neues Passwort soll etwas ändern -
  // bliebe ein altes Handy angemeldet, hätte der Wechsel genau die Wirkung
  // nicht, wegen der man ihn vornimmt.
  const konto = speicher.nachName(username);
  if (konto) {
    const sitzungen = new Sitzungsspeicher(SITZUNGEN, speicher.sessionSecret);
    sitzungen.beendeVonBenutzer(konto.id);
    sitzungen.persist();
  }

  console.log('');
  console.log(`  Gespeichert in ${PFAD}`);
  console.log(`  ${neu ? 'Angelegt' : 'Passwort neu gesetzt'}: ${username} (Administrator)`);
  console.log('');
  console.log('  Jetzt den Server neu starten - die Konten werden beim Start gelesen.');
  console.log('  Weitere Konten für andere Personen legst du danach im Browser an:');
  console.log('     http://localhost:4173/admin');
  console.log('');
  rl?.close();
}

void main();
