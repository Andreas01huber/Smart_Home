/**
 * Übersteuerungen der Ladeentscheidung — die Stufen NACH `berechneLadeziel`.
 *
 * Die Rechnung in `ueberschuss.ts` weiss, wie viel Überschuss da ist. Was der
 * Mensch will (Handbetrieb, Stopp, noch keine Wahl), was das Fahrzeug tut
 * (nimmt nichts an) und was die Dose verträgt, kommt danach — in genau dieser
 * Reihenfolge, weil jede Stufe die vorige überstimmen darf:
 *
 *   1. Fahrzeug fordert nicht   → 0 A (nach drei Freigaben ohne Ladung)
 *   2. Handbetrieb              → fester Strom, auch aus dem Netz
 *   3. Keine Wahl getroffen     → 0 A (ohne bewusste Wahl wird nicht geladen)
 *   4. Stopp-Knopf              → 0 A (überstimmt alles, auch den Handbetrieb)
 *   5. Dosengrenze              → kappt jeden positiven Wert
 *
 * Reine Funktion: Der Regeldienst führt nur noch den Zustand, die Reihenfolge
 * steht hier und ist als Tabelle prüfbar.
 */

import { ladeleistungAusStromW, type Ladeanschluss } from './ladeleistung.ts';
import type { Ladeentscheidung, Messwerte } from './ueberschuss.ts';

/** Die Entscheidungen des Menschen und die Lage des Fahrzeugs. */
export interface Reglerwahl {
  /** `null` = noch keine Wahl; dann wird nicht geladen. */
  readonly betriebsart: 'intelligent' | 'manuell' | null;
  /** Gewünschter Ladestrom im Handbetrieb. */
  readonly manuellA: number;
  /** Vom Menschen angehalten. */
  readonly gestoppt: boolean;
  /** Fahrzeug nimmt trotz Freigabe keinen Strom an. */
  readonly fordertNicht: boolean;
}

/** Was die Dose und das Gerät zulassen. */
export interface Dosengrenzen {
  readonly minA: number;
  readonly maxA: number;
  readonly anschluss: Ladeanschluss;
  /** Dauerstromgrenze an einer Haushaltssteckdose (gilt nur einphasig). */
  readonly haushaltMaxA: number;
}

export interface Uebersteuerung {
  readonly entscheidung: Ladeentscheidung;
  /**
   * Ohne Beobachtungszeit senden. Gilt für alles, was ein Mensch ausgelöst hat
   * oder was aus Sicherheitsgründen keinen Aufschub duldet.
   */
  readonly sofort: boolean;
  /**
   * Ob überhaupt ein Befehl in Frage kommt. "nicht verbunden" oder "gestört"
   * sind Auskünfte, keine Ereignisse — da geht nichts hinaus.
   */
  readonly regelbar: boolean;
}

/**
 * Den Ladestrom auf das begrenzen, was Gerät und Dose vertragen.
 *
 * An der Starkstromdose gelten nur die Gerätegrenzen. An der Haushaltssteckdose
 * kommt `haushaltMaxA` dazu — der Wert, den ein Mensch für SEINE Installation
 * eingetragen hat; die Software kann die Belastbarkeit nicht messen.
 */
export function begrenzeAufDose(ampere: number, g: Dosengrenzen): number {
  const geraet = Math.min(g.maxA, Math.max(g.minA, Math.round(ampere)));
  if (g.anschluss.phasen !== 1) return geraet;
  return Math.min(geraet, g.haushaltMaxA);
}

export function uebersteuere(
  berechnet: Ladeentscheidung,
  messwerte: Messwerte,
  wahl: Reglerwahl,
  g: Dosengrenzen,
): Uebersteuerung {
  let e = berechnet;
  let sofort = false;
  const angesteckt = messwerte.evAngesteckt === true;

  // 1. Nimmt das Fahrzeug überhaupt noch?
  if (wahl.fordertNicht && angesteckt) {
    e = {
      ...e,
      zustand: 'fordert-nicht',
      zielA: 0,
      zielLeistungW: 0,
      // "Akku voll" wäre eine Behauptung: Die Wallbox überträgt keinen
      // Ladestand. Belegt ist nur, dass nichts angenommen wurde.
      grund:
        'Das Fahrzeug nimmt derzeit keinen Strom an (möglich: Akku voll, '
        + 'Ladegrenze oder Ladeplan im Auto). Neuer Versuch später.',
    };
  }

  // 2. Übersteuerung durch den Menschen. Die Gerätegrenzen gelten weiterhin.
  const vonHand = wahl.betriebsart === 'manuell' && !wahl.gestoppt && angesteckt && messwerte.wallboxErreichbar;
  if (vonHand) {
    const zielA = begrenzeAufDose(wahl.manuellA, g);
    const gekappt = zielA < Math.round(wahl.manuellA);
    e = {
      ...e,
      zustand: 'laedt',
      zielA,
      zielLeistungW: ladeleistungAusStromW(zielA, g.anschluss) ?? 0,
      grund: gekappt
        ? `Handbetrieb — ${Math.round(wahl.manuellA)} A gewünscht, an der `
          + `Haushaltssteckdose sind ${zielA} A die Dauergrenze.`
        : `Handbetrieb — fest auf ${zielA} A eingestellt, auch aus dem Netz.`,
    };
    sofort = true;
  }

  // 3. Ohne bewusste Wahl wird nicht geladen — auch nicht intelligent.
  if (wahl.betriebsart === null && angesteckt) {
    e = {
      ...e,
      zustand: 'wahl-fehlt',
      zielA: 0,
      zielLeistungW: 0,
      grund: 'Noch kein Lademodus gewählt. Bitte "Intelligent" oder "Manuell" wählen.',
    };
    sofort = true;
  }

  // 4. Der Stopp-Knopf überstimmt alles, auch den Handbetrieb. Ein Stopp
  //    wartet nie auf eine Beobachtungszeit.
  if (wahl.gestoppt) sofort = true;
  if (wahl.gestoppt && angesteckt) {
    e = {
      ...e,
      zustand: 'gestoppt',
      zielA: 0,
      zielLeistungW: 0,
      grund: 'Ladestopp angefordert. Zum Weiterladen "Laden fortsetzen" drücken.',
    };
    sofort = true;
  }

  // 5. Die Dose setzt die letzte Grenze — auch im intelligenten Betrieb.
  if (e.zielA > 0) {
    const begrenzt = begrenzeAufDose(e.zielA, g);
    if (begrenzt !== e.zielA) {
      e = {
        ...e,
        zielA: begrenzt,
        zielLeistungW: ladeleistungAusStromW(begrenzt, g.anschluss) ?? 0,
        grund:
          `${e.grund} An der Haushaltssteckdose höchstens `
          + `${begrenzt} A — mehr hält die Leitung im Dauerbetrieb nicht aus.`,
      };
    }
  }

  // Fehlende Messwerte dulden keine Beobachtungszeit: sofort abschalten.
  if (e.zustand === 'pausiert-messwerte') sofort = true;

  const regelbar =
    e.zustand === 'laedt'
    || e.zustand === 'fordert-nicht'
    || e.zustand === 'gestoppt'
    || e.zustand === 'wahl-fehlt'
    || e.zustand.startsWith('pausiert');

  return { entscheidung: e, sofort, regelbar };
}
