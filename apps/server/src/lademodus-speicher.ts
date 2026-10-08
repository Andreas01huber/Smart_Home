/**
 * Die zuletzt bewusst gewählte Lade-Einstellung, dauerhaft.
 *
 * Früher fiel der Handbetrieb beim Abstecken und bei jedem Neustart auf
 * "intelligent" zurück — eine Entscheidung, die niemand getroffen hatte. Jetzt
 * gilt, was zuletzt ausdrücklich gewählt wurde, über Abstecken, Neustart und
 * Browser hinweg.
 *
 * Datei `data/lademodus.json`, Fassung 1:
 *
 *   { "version": 1, "betriebsart": "manuell", "manuellA": 10,
 *     "pausiert": false, "geaendertAm": "2026-09-19T18:00:00.000Z" }
 *
 * Fehlt die Datei, gibt es noch keine Wahl. Ist sie unlesbar oder ungültig,
 * gilt das ebenfalls als "keine Wahl" — eine beschädigte Einstellung darf nie
 * einen Ladestart auslösen. Die Datei selbst wird aufbewahrt.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bewahreBeschaedigt, writeJsonAtomic } from './persist.ts';

export interface Lademodus {
  readonly betriebsart: 'intelligent' | 'manuell';
  /** Gewünschter Ladestrom im Handbetrieb (vor Geräte- und Dosengrenze). */
  readonly manuellA: number;
  /** Vom Menschen pausiert. Gilt bis Fortsetzen oder eindeutigem Abstecken. */
  readonly pausiert: boolean;
  readonly geaendertAm: string;
}

const DATEI = 'lademodus.json';

export function pruefeLademodus(roh: unknown): Lademodus | null {
  if (typeof roh !== 'object' || roh === null) return null;
  const r = roh as Record<string, unknown>;
  if (r['version'] !== 1) return null;
  if (r['betriebsart'] !== 'intelligent' && r['betriebsart'] !== 'manuell') return null;
  const a = r['manuellA'];
  if (typeof a !== 'number' || !Number.isFinite(a) || a < 0 || a > 80) return null;
  if (typeof r['pausiert'] !== 'boolean') return null;
  if (typeof r['geaendertAm'] !== 'string' || Number.isNaN(Date.parse(r['geaendertAm']))) return null;
  return {
    betriebsart: r['betriebsart'],
    manuellA: a,
    pausiert: r['pausiert'],
    geaendertAm: r['geaendertAm'],
  };
}

/** `null` = keine gültige Wahl vorhanden (fehlt oder beschädigt). */
export function ladeLademodus(verzeichnis: string): Lademodus | null {
  const pfad = resolve(verzeichnis, DATEI);
  if (!existsSync(pfad)) return null;
  let roh: unknown;
  try {
    roh = JSON.parse(readFileSync(pfad, 'utf8'));
  } catch {
    bewahreBeschaedigt(pfad);
    return null;
  }
  const modus = pruefeLademodus(roh);
  if (modus === null) {
    console.warn(`${pfad}: ungültige Lade-Einstellung — es wird nicht geladen, bis neu gewählt ist.`);
    bewahreBeschaedigt(pfad);
  }
  return modus;
}

/** Wirft, wenn nicht dauerhaft geschrieben werden konnte. */
export function merkeLademodus(verzeichnis: string, modus: Lademodus): void {
  writeJsonAtomic(resolve(verzeichnis, DATEI), { version: 1, ...modus }, 2);
}
