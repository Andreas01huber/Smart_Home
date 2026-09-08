/**
 * Was die Speicher nachweislich können — gemessen, nicht konfiguriert.
 *
 * Die Überschussrechnung darf mit einem Speicher nur so weit rechnen, wie er
 * sich an dieser Anlage schon einmal bewährt hat. Das ist keine Vorsicht um der
 * Vorsicht willen, sondern die Lehre aus einem echten Fehler: Wer die
 * konfigurierte Freigabe als verfügbare Leistung einsetzt, baut eine feste Zahl
 * in eine Regelschleife ein, die der Speicher womöglich nicht einlöst. Die
 * Regelung pendelt sich dann nicht auf null Netzbezug ein, sondern auf genau
 * die Differenz — dauerhaft, unbemerkt, rund 2 kWh am Tag.
 *
 * Dieses Modul hält deshalb für jeden Speicher fest, welche Entladeleistung er
 * zuletzt wirklich geliefert hat, und zwar in beide Richtungen:
 *
 *   nach oben   Liefert ein Speicher mehr als bisher bekannt, gilt der neue
 *               Wert sofort. Er hat es ja gerade bewiesen.
 *   nach unten  Kommt Strom aus dem Netz, obwohl die Regelung mit dem Speicher
 *               gerechnet hat, dann war die Annahme zu gross. Der Nachweis
 *               sinkt auf das, was der Speicher in diesem Moment tatsächlich
 *               hergibt.
 *
 * Dadurch gibt es kein Ausprobieren im Kreis: Ein Speicher, der nur 2 kW
 * schafft, wird nach dem ersten Fehlversuch mit 2 kW eingeplant und nicht immer
 * wieder mit mehr. Zeigt er später von sich aus mehr, steigt der Nachweis
 * wieder — ohne dass dafür jemand Netzbezug in Kauf nehmen müsste.
 *
 * Reine Funktionen mit übergebener Zeit, wie alles Regelnde in diesem Paket.
 */

import type { SpeicherZustand } from './ueberschuss.ts';

/** Ein Nachweis: so viel, zuletzt gesehen dann. */
export interface Speichernachweis {
  readonly bewaehrtW: number;
  readonly gesehenAtMs: number;
}

/** Nachweise aller Speicher, nach Geräte-Id. */
export type Speichergedaechtnis = Readonly<Record<string, Speichernachweis>>;

/**
 * Wie lange ein Nachweis gilt.
 *
 * Ein Tag ist lang genug, um die abendliche Entladung des Vortags mitzunehmen —
 * die ist der natürliche Beweis dafür, was ein Speicher kann. Und kurz genug,
 * dass eine gealterte Batterie oder ein geändertes Wechselrichterlimit nicht
 * ewig als Versprechen weiterlebt.
 */
export const NACHWEIS_FENSTER_MS = 24 * 60 * 60 * 1000;

export const LEERES_GEDAECHTNIS: Speichergedaechtnis = {};

function entladungW(s: SpeicherZustand): number {
  const w = s.entladenW;
  return typeof w === 'number' && Number.isFinite(w) ? Math.max(0, w) : 0;
}

/**
 * Beobachten: Was liefern die Speicher gerade, und ist das mehr als bekannt?
 *
 * Wird bei jedem Messtakt aufgerufen. Ein abgelaufener Nachweis wird nicht
 * einfach gelöscht, sondern durch den aktuellen Messwert ersetzt — sonst
 * verlöre die Regelung morgens um vier alles Wissen und müsste bei Sonnenschein
 * von vorn anfangen.
 */
export function merkeEntladung(
  gedaechtnis: Speichergedaechtnis,
  speicher: readonly SpeicherZustand[],
  jetztMs: number,
  fensterMs: number = NACHWEIS_FENSTER_MS,
): Speichergedaechtnis {
  let geaendert = false;
  const neu: Record<string, Speichernachweis> = { ...gedaechtnis };

  for (const s of speicher) {
    const jetzt = entladungW(s);
    const alt = neu[s.id];
    const abgelaufen = alt !== undefined && jetztMs - alt.gesehenAtMs > fensterMs;

    if (alt === undefined || abgelaufen || jetzt >= alt.bewaehrtW) {
      // Nur festhalten, wenn sich etwas ändert: Sonst entstünde bei jedem
      // Messtakt ein neues Objekt, und Vergleiche weiter oben wären wertlos.
      if (alt !== undefined && !abgelaufen && jetzt === alt.bewaehrtW) continue;
      neu[s.id] = { bewaehrtW: jetzt, gesehenAtMs: jetztMs };
      geaendert = true;
    }
  }

  return geaendert ? neu : gedaechtnis;
}

/**
 * Zurücknehmen: Es kam Strom aus dem Netz, obwohl mit den Speichern gerechnet
 * wurde.
 *
 * Dann war die Annahme zu gross — unabhängig davon, ob der Speicher an seinem
 * Wechselrichterlimit hängt, seine eigene Regelung bremst oder gerade erst
 * anläuft. Der Nachweis fällt auf das, was in diesem Moment wirklich fliesst.
 * Läuft der Speicher nur langsam an, holt `merkeEntladung` das binnen Sekunden
 * von selbst wieder auf.
 */
export function nachweisZuruecknehmen(
  gedaechtnis: Speichergedaechtnis,
  speicher: readonly SpeicherZustand[],
  jetztMs: number,
): Speichergedaechtnis {
  let geaendert = false;
  const neu: Record<string, Speichernachweis> = { ...gedaechtnis };

  for (const s of speicher) {
    const jetzt = entladungW(s);
    const alt = neu[s.id];
    if (alt === undefined || alt.bewaehrtW <= jetzt) continue;
    neu[s.id] = { bewaehrtW: jetzt, gesehenAtMs: jetztMs };
    geaendert = true;
  }

  return geaendert ? neu : gedaechtnis;
}

/** Nachweis eines Speichers in Watt; 0, wenn nichts bekannt ist. */
export function bewaehrtW(gedaechtnis: Speichergedaechtnis, id: string): number {
  return gedaechtnis[id]?.bewaehrtW ?? 0;
}

/**
 * Gedächtnis aus aufgezeichneten Messreihen aufbauen.
 *
 * Gebraucht beim Start: Ohne diesen Schritt wüsste die Regelung nach jedem
 * Neustart wieder nichts über ihre Speicher und würde einen halben Sonnentag
 * lang zu wenig laden. Die Werte stammen aus dem Tagesarchiv, sind also
 * ebenfalls gemessen — nur eben früher.
 */
export function gedaechtnisAusMesswerten(
  punkte: readonly { readonly id: string; readonly entladenW: number; readonly tMs: number }[],
  jetztMs: number,
  fensterMs: number = NACHWEIS_FENSTER_MS,
): Speichergedaechtnis {
  const neu: Record<string, Speichernachweis> = {};
  for (const p of punkte) {
    if (jetztMs - p.tMs > fensterMs) continue;
    const w = Math.max(0, p.entladenW);
    const alt = neu[p.id];
    if (alt === undefined || w > alt.bewaehrtW) {
      neu[p.id] = { bewaehrtW: w, gesehenAtMs: p.tMs };
    }
  }
  return neu;
}
