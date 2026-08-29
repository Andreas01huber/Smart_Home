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

import { renameSync, writeFileSync } from 'node:fs';

export function writeJsonAtomic(path: string, value: unknown, space?: number): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, space), 'utf8');
  renameSync(temporary, path);
}
