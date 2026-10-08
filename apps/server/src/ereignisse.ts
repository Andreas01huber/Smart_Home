/**
 * Dauerhaftes Ereignisprotokoll.
 *
 * Das Regelprotokoll (240 Schritte im Arbeitsspeicher) sagt, was der Regler
 * alle 30 s dachte — und ist nach einem Neustart weg. Hier steht, was
 * PASSIERT ist: Befehle an die Wallbox, Stopps von Hand, Verbindungsabbrüche,
 * Fahrzeug an- und abgesteckt, Server gestartet und beendet. Ohne diese Spur
 * lässt sich ein Vorfall wie „am 8.9. um 20:50 lud das Auto aus dem Netz“
 * nach einem Neustart nicht mehr rekonstruieren.
 *
 * Format: eine JSON-Zeile je Ereignis (`data/ereignisse.jsonl`), nur angehängt.
 * Anhängen ist unteilbar genug — eine halbe letzte Zeile wird beim Lesen
 * übersprungen, alles davor bleibt gültig. Wird die Datei grösser als
 * `MAX_BYTES`, wandert sie nach `ereignisse.1.jsonl`; eine Generation genügt.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Ereignis {
  readonly zeit: string;
  /** Maschinenlesbare Art, z. B. `laden.befehl`, `wallbox.offline`, `server.start`. */
  readonly art: string;
  /** Klartext für Menschen. */
  readonly text: string;
  /** Optionale Details, flach gehalten. */
  readonly details?: Readonly<Record<string, unknown>>;
}

const MAX_BYTES = 5 * 1024 * 1024;

export class Ereignisprotokoll {
  private readonly pfad: string;
  private readonly altPfad: string;
  private fehler: string | null = null;
  /** Die letzten Ereignisse im Speicher, damit die Auskunft nicht jedes Mal liest. */
  private kuerzlich: Ereignis[] = [];
  private static readonly KUERZLICH_MAX = 500;

  constructor(datenverzeichnis: string, private readonly jetzt: () => Date = () => new Date()) {
    this.pfad = resolve(datenverzeichnis, 'ereignisse.jsonl');
    this.altPfad = resolve(datenverzeichnis, 'ereignisse.1.jsonl');
    this.kuerzlich = this.leseLetzte(Ereignisprotokoll.KUERZLICH_MAX);
  }

  notiere(art: string, text: string, details?: Readonly<Record<string, unknown>>): void {
    const e: Ereignis = {
      zeit: this.jetzt().toISOString(),
      art,
      text,
      ...(details !== undefined ? { details } : {}),
    };
    this.kuerzlich.push(e);
    if (this.kuerzlich.length > Ereignisprotokoll.KUERZLICH_MAX) this.kuerzlich.shift();
    try {
      this.rotiereFalls();
      appendFileSync(this.pfad, JSON.stringify(e) + '\n', 'utf8');
      this.fehler = null;
    } catch (error) {
      // Ein Protokoll, das den Dienst stoppt, wäre schlimmer als eines mit Lücke.
      this.fehler = error instanceof Error ? error.message : String(error);
      console.warn(`[Ereignisse] Konnte nicht schreiben: ${this.fehler}`);
    }
  }

  /** Neueste zuerst. */
  letzte(anzahl = 100): readonly Ereignis[] {
    return [...this.kuerzlich].reverse().slice(0, Math.max(1, anzahl));
  }

  schreibfehler(): string | null {
    return this.fehler;
  }

  private rotiereFalls(): void {
    if (!existsSync(this.pfad)) return;
    if (statSync(this.pfad).size < MAX_BYTES) return;
    renameSync(this.pfad, this.altPfad);
  }

  private leseLetzte(anzahl: number): Ereignis[] {
    const zeilen: string[] = [];
    for (const p of [this.altPfad, this.pfad]) {
      if (!existsSync(p)) continue;
      try {
        zeilen.push(...readFileSync(p, 'utf8').split('\n'));
      } catch {
        // unlesbar: dann eben ohne Vorgeschichte
      }
    }
    const ergebnis: Ereignis[] = [];
    for (const zeile of zeilen.slice(-anzahl * 2)) {
      if (zeile.trim() === '') continue;
      try {
        const roh: unknown = JSON.parse(zeile);
        if (
          typeof roh === 'object' && roh !== null
          && typeof (roh as Ereignis).zeit === 'string'
          && typeof (roh as Ereignis).art === 'string'
          && typeof (roh as Ereignis).text === 'string'
        ) {
          ergebnis.push(roh as Ereignis);
        }
      } catch {
        // halbe Zeile am Ende — überspringen
      }
    }
    return ergebnis.slice(-anzahl);
  }
}
