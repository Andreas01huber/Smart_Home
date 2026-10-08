/**
 * Sicherung des Datenverzeichnisses — und Wiederherstellung.
 *
 *   npm run sicherung                         data/ nach sicherungen/<Zeitstempel>/ kopieren
 *   npm run sicherung -- --ziel D:\Backup     an einen anderen Ort (z. B. zweite Platte, NAS)
 *   npm run sicherung -- --behalten 30        ältere Sicherungen am Ziel löschen, 30 bleiben
 *   npm run sicherung -- --wiederherstellen sicherungen/2026-10-08T06-00-00
 *
 * Was gesichert wird: history.json, today.json, days/, ev-sessions.json,
 * tariff.json, lademodus.json, wallbox.json, ereignisse*.jsonl — alles, was die
 * App über Monate gelernt hat. Sitzungen und Konten werden mitgenommen, soweit
 * sie im Datenverzeichnis liegen (Docker: konten.json); secrets.json liegt
 * daneben und wird bewusst NICHT kopiert.
 *
 * Wiederherstellen nur bei gestopptem Server: Der laufende Dienst schreibt
 * alle zwei Minuten und würde die zurückgespielten Dateien überschreiben.
 * Vor dem Zurückspielen wird der aktuelle Stand als `vor-wiederherstellung-…`
 * gesichert — es geht nichts verloren.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const wert = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const daten = resolve(process.cwd(), wert('--daten') ?? 'data');
const ziel = resolve(process.cwd(), wert('--ziel') ?? 'sicherungen');
const behalten = Number(wert('--behalten') ?? '14');
const wiederherstellen = wert('--wiederherstellen');

function stempel(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
}

function groesse(pfad: string): number {
  let summe = 0;
  for (const e of readdirSync(pfad, { withFileTypes: true })) {
    const p = resolve(pfad, e.name);
    summe += e.isDirectory() ? groesse(p) : statSync(p).size;
  }
  return summe;
}

function sichere(nach: string): void {
  if (!existsSync(daten)) throw new Error(`Datenverzeichnis fehlt: ${daten}`);
  mkdirSync(nach, { recursive: true });
  cpSync(daten, nach, {
    recursive: true,
    // Temporäre und beiseitegelegte Dateien gehören nicht in eine Sicherung.
    filter: (quelle) => !quelle.endsWith('.tmp'),
  });
  console.log(`Gesichert: ${daten} → ${nach} (${(groesse(nach) / 1024).toFixed(0)} KB)`);
}

function aufraeumen(): void {
  if (!Number.isFinite(behalten) || behalten < 1) return;
  const alle = readdirSync(ziel, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const alt of alle.slice(0, Math.max(0, alle.length - behalten))) {
    rmSync(resolve(ziel, alt), { recursive: true, force: true });
    console.log(`Alte Sicherung entfernt: ${alt}`);
  }
}

if (wiederherstellen !== undefined) {
  const quelle = resolve(process.cwd(), wiederherstellen);
  if (!existsSync(quelle)) throw new Error(`Sicherung nicht gefunden: ${quelle}`);
  if (!existsSync(resolve(quelle, 'history.json')) && !existsSync(resolve(quelle, 'today.json'))) {
    throw new Error(`${quelle} sieht nicht wie eine Sicherung aus (history.json/today.json fehlen).`);
  }
  console.log('Hinweis: Der Server muss dafür gestoppt sein.');
  if (existsSync(daten)) sichere(resolve(ziel, `vor-wiederherstellung-${stempel()}`));
  mkdirSync(daten, { recursive: true });
  cpSync(quelle, daten, { recursive: true, force: true });
  console.log(`Wiederhergestellt: ${quelle} → ${daten}`);
} else {
  sichere(resolve(ziel, stempel()));
  aufraeumen();
}
