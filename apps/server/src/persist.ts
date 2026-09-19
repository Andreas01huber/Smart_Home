/**
 * Dateien so schreiben, dass ein Abbruch sie nicht zerstört.
 *
 * Der Server läuft rund um die Uhr und wird im Alltag durch Schliessen des
 * Fensters beendet — mitten im Betrieb, ohne Vorwarnung. Trifft das genau ein
 * laufendes `writeFileSync`, bliebe eine halb geschriebene Datei zurück. Beim
 * nächsten Start scheitert `JSON.parse`, und die Historie wäre stillschweigend
 * weg (`load()` fängt den Fehler ab und beginnt bei null).
 *
 * Deshalb wird immer erst vollständig in eine Nebendatei geschrieben und diese
 * anschliessend über das Ziel umbenannt. Das Umbenennen innerhalb desselben
 * Verzeichnisses ist unteilbar: Es existiert entweder die alte oder die neue
 * Fassung, nie eine halbe.
 *
 * Zusätzlich führt diese Datei Buch über jeden Bestand: wann zuletzt erfolgreich
 * geschrieben wurde, welcher Fehler gerade ansteht und ob ein Bestand gesperrt
 * ist. Ein Schreibfehler, der nur in der Konsole steht, bemerkt niemand.
 */

import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface Schreibstatus {
  readonly datei: string;
  readonly letzterErfolgAm: string | null;
  readonly fehler: string | null;
  readonly fehlerSeit: string | null;
  readonly fehlversuche: number;
  /** Gesetzt, wenn der Bestand wegen einer nicht sicherbaren Beschädigung nicht beschrieben wird. */
  readonly gesperrt: string | null;
}

const status = new Map<string, Schreibstatus>();

function eintrag(path: string): Schreibstatus {
  return status.get(path) ?? {
    datei: basename(path),
    letzterErfolgAm: null,
    fehler: null,
    fehlerSeit: null,
    fehlversuche: 0,
    gesperrt: null,
  };
}

/** Stand aller bisher geschriebenen oder gesperrten Bestände — für die Verwaltung. */
export function schreibstatus(): readonly Schreibstatus[] {
  return [...status.values()].sort((a, b) => a.datei.localeCompare(b.datei));
}

/** Nur für Tests: Buchführung zurücksetzen. */
export function schreibstatusZuruecksetzen(): void {
  status.clear();
}

export function writeJsonAtomic(path: string, value: unknown, space?: number): void {
  const bisher = eintrag(path);
  if (bisher.gesperrt !== null) {
    // Die beschädigte Datei liegt noch da und konnte nicht beiseitegelegt
    // werden. Jeder normale Speicherlauf würde sie jetzt überschreiben — und
    // damit genau den Inhalt vernichten, den `bewahreBeschaedigt` retten wollte.
    const fehler = new Error(`${basename(path)} ist gesperrt: ${bisher.gesperrt}`);
    status.set(path, { ...bisher, fehler: fehler.message, fehlversuche: bisher.fehlversuche + 1 });
    throw fehler;
  }
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, space), 'utf8');
    renameSync(temporary, path);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    status.set(path, {
      ...bisher,
      fehler: text,
      fehlerSeit: bisher.fehlerSeit ?? new Date().toISOString(),
      fehlversuche: bisher.fehlversuche + 1,
    });
    throw error;
  }
  status.set(path, {
    ...bisher,
    letzterErfolgAm: new Date().toISOString(),
    fehler: null,
    fehlerSeit: null,
    fehlversuche: 0,
  });
}

/**
 * Eine unlesbare Datei beiseitelegen, statt sie zu überschreiben.
 *
 * Eine kaputte Datei ist keine leere Datei. Sie wird umbenannt und bleibt
 * liegen, damit man später nachsehen (und notfalls von Hand herausholen) kann,
 * was darin stand.
 *
 * Geht das Umbenennen nicht, wird der Bestand gesperrt: Alle weiteren
 * Schreibversuche schlagen fehl und stehen im Schreibstatus, bis jemand die
 * Datei von Hand repariert oder entfernt und den Dienst neu startet. Das ist
 * der Wiederherstellungsweg — unbequem, aber er vernichtet nichts.
 *
 * Gibt den neuen Pfad zurück, oder `null`, wenn nichts beiseitegelegt wurde.
 */
export function bewahreBeschaedigt(
  pfad: string,
  umbenennen: (von: string, nach: string) => void = renameSync,
): string | null {
  if (!existsSync(pfad)) return null;
  const stempel = new Date().toISOString().replace(/[:.]/g, '-');
  const ziel = `${pfad}.beschaedigt-${stempel}`;
  try {
    umbenennen(pfad, ziel);
    console.warn(`${pfad} war unlesbar und liegt jetzt als ${ziel} — Inhalt bleibt erhalten.`);
    return ziel;
  } catch {
    const grund = 'Datei ist beschädigt und liess sich nicht beiseitelegen. '
      + 'Datei prüfen oder entfernen, dann Dienst neu starten.';
    status.set(pfad, { ...eintrag(pfad), gesperrt: grund });
    console.error(`${pfad}: ${grund}`);
    return null;
  }
}
