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
 */

import { existsSync, renameSync, writeFileSync } from 'node:fs';

export function writeJsonAtomic(path: string, value: unknown, space?: number): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, space), 'utf8');
  renameSync(temporary, path);
}

/**
 * Eine unlesbare Datei beiseitelegen, statt sie zu überschreiben.
 *
 * Bisher endete jede beschädigte Datei gleich: Das Einlesen scheiterte, der
 * Fehler wurde abgefangen, und beim nächsten Speichern schrieb der Dienst
 * seelenruhig seinen leeren Anfangszustand darüber. Damit war der Inhalt
 * endgültig weg — auch der Teil, der noch zu retten gewesen wäre.
 *
 * Eine kaputte Datei ist keine leere Datei. Sie wird umbenannt und bleibt
 * liegen, damit man später nachsehen (und notfalls von Hand herausholen) kann,
 * was darin stand.
 *
 * Gibt den neuen Pfad zurück, oder `null`, wenn nichts beiseitegelegt wurde.
 */
export function bewahreBeschaedigt(pfad: string): string | null {
  try {
    if (!existsSync(pfad)) return null;
    const stempel = new Date().toISOString().replace(/[:.]/g, '-');
    const ziel = `${pfad}.beschaedigt-${stempel}`;
    renameSync(pfad, ziel);
    console.warn(`${pfad} war unlesbar und liegt jetzt als ${ziel} — Inhalt bleibt erhalten.`);
    return ziel;
  } catch {
    // Selbst das Umbenennen geht nicht (Rechte, Platte). Dann bleibt die Datei
    // eben liegen, wie sie ist — überschrieben wird sie deshalb nicht.
    console.warn(`${pfad} ist unlesbar und liess sich nicht beiseitelegen.`);
    return null;
  }
}
