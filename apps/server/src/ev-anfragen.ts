/**
 * Prüfung der Lade-Schreibanfragen.
 *
 * Vorher wurde großzügig gedeutet: Eine unbekannte Betriebsart galt als
 * "intelligent", ein fehlendes oder falsches `an` als `false` — und damit als
 * "Laden fortsetzen". Ein Tippfehler in einer Anfrage konnte so eine Pause
 * aufheben. Jetzt wird jede fehlerhafte Anfrage mit 400 abgelehnt, ohne dass
 * sich am Zustand etwas ändert.
 */

export type Pruefung<T> = { ok: true; wert: T } | { ok: false; fehler: string };

/** Höchster Ladestrom, der überhaupt als Wunsch angenommen wird. */
const AMPERE_OBERGRENZE = 32;

function objekt(roh: unknown): Record<string, unknown> | null {
  return typeof roh === 'object' && roh !== null && !Array.isArray(roh)
    ? (roh as Record<string, unknown>)
    : null;
}

export function pruefeBetriebsartAnfrage(
  roh: unknown,
): Pruefung<{ art: 'intelligent' | 'manuell'; ampere?: number }> {
  const r = objekt(roh);
  if (r === null) return { ok: false, fehler: 'Ungültige Anfrage.' };
  for (const feld of Object.keys(r)) {
    if (feld !== 'art' && feld !== 'ampere') return { ok: false, fehler: `Unbekanntes Feld „${feld}“.` };
  }
  // "volladung" bleibt als Altname für Handbetrieb angenommen, damit eine noch
  // zwischengespeicherte ältere Oberfläche nicht ins Leere greift.
  const art = r['art'] === 'volladung' ? 'manuell' : r['art'];
  if (art !== 'intelligent' && art !== 'manuell') {
    return { ok: false, fehler: 'Betriebsart muss "intelligent" oder "manuell" sein.' };
  }
  const ampere = r['ampere'];
  if (ampere === undefined || ampere === null) return { ok: true, wert: { art } };
  // Die echten Grenzen kennt nur das Gerät, die Regelung begrenzt selbst. Hier
  // wird nur Unsinn abgewiesen, nicht die Hardware nachgebildet.
  if (typeof ampere !== 'number' || !Number.isFinite(ampere) || ampere <= 0 || ampere > AMPERE_OBERGRENZE) {
    return { ok: false, fehler: `Ladestrom muss eine Zahl zwischen 1 und ${AMPERE_OBERGRENZE} A sein.` };
  }
  return { ok: true, wert: { art, ampere } };
}

export function pruefeStoppAnfrage(roh: unknown): Pruefung<{ an: boolean }> {
  const r = objekt(roh);
  if (r === null) return { ok: false, fehler: 'Ungültige Anfrage.' };
  for (const feld of Object.keys(r)) {
    if (feld !== 'an') return { ok: false, fehler: `Unbekanntes Feld „${feld}“.` };
  }
  if (typeof r['an'] !== 'boolean') {
    return { ok: false, fehler: '"an" muss true (pausieren) oder false (fortsetzen) sein.' };
  }
  return { ok: true, wert: { an: r['an'] } };
}
