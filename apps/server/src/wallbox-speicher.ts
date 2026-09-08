/**
 * Was die App über die Ladedose gelernt hat, über Neustarts hinweg.
 *
 * An welcher Dose das Auto hängt, lässt sich nur feststellen, während wirklich
 * Strom fliesst: Die Spannung von `phase_a` liegt an beiden Dosen bei rund
 * 230 V — erst das Verhältnis zur Gesamtleistung verrät die Zahl der Phasen.
 *
 * Ohne Gedächtnis stünde die App nach jedem Neustart wieder bei der Vorgabe aus
 * config.json, also dreiphasig. Und das ist nicht bloss unschön: An der
 * Haushaltssteckdose gilt eine niedrigere Dauerstromgrenze, und die griffe dann
 * erst, nachdem schon geladen wurde. Ein paar Sekunden 16 A auf einer
 * Schuko-Dose sind kein Drama, aber es ist vermeidbar — also wird es vermieden.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Dosengedaechtnis {
  readonly phasen: 1 | 3;
  readonly spannungV: number;
  /** Wann zuletzt erkannt, als ISO-Zeit. Nur zum Nachsehen. */
  readonly erkanntAm: string;
}

const DATEI = 'wallbox.json';

export function ladeDose(datenverzeichnis: string): Dosengedaechtnis | null {
  try {
    const roh: unknown = JSON.parse(readFileSync(join(datenverzeichnis, DATEI), 'utf8'));
    if (typeof roh !== 'object' || roh === null) return null;
    const o = roh as Record<string, unknown>;
    if (o['phasen'] !== 1 && o['phasen'] !== 3) return null;
    if (typeof o['spannungV'] !== 'number' || !Number.isFinite(o['spannungV'])) return null;
    return {
      phasen: o['phasen'],
      spannungV: o['spannungV'],
      erkanntAm: typeof o['erkanntAm'] === 'string' ? o['erkanntAm'] : '',
    };
  } catch {
    // Keine Datei, kaputte Datei — beides kein Fehler, dann gilt die Vorgabe.
    return null;
  }
}

export function merkeDose(datenverzeichnis: string, dose: Dosengedaechtnis): void {
  try {
    writeFileSync(join(datenverzeichnis, DATEI), JSON.stringify(dose, null, 2), 'utf8');
  } catch {
    // Nicht schreiben zu können darf die Regelung nicht anhalten.
  }
}
