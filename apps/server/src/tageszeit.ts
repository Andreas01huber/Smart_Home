/**
 * Kalendertage der Anlage — in der Zeitzone des Servers, DST-fest.
 *
 * Eine Stelle für alle, die Tagesgrenzen brauchen (Tagesbilanz, Ladeprotokoll,
 * Serialisierung). Vorher stand `naechsterTagesbeginn` zweimal im Code.
 */

export function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`); // Mittag: DST-Wechsel verschiebt das Datum nicht
  d.setDate(d.getDate() + days);
  return localDate(d);
}

/** Lokaler Tagesbeginn und -ende eines Kalendertags, in ms. DST-fest. */
export function tagesgrenzen(date: string): { beginnMs: number; endeMs: number } {
  const [j, m, t] = date.split('-').map(Number) as [number, number, number];
  return {
    beginnMs: new Date(j, m - 1, t, 0, 0, 0, 0).getTime(),
    endeMs: new Date(j, m - 1, t + 1, 0, 0, 0, 0).getTime(),
  };
}

/** Der nächste lokale Tagesbeginn nach `ms`. */
export function naechsterTagesbeginn(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}
