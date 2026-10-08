/**
 * Ausführung eines Ladebefehls — Senden, Bestätigen, Wiederholen.
 *
 * Aus dem Regeldienst herausgelöst, damit dort nur noch steht, WAS gesetzt
 * werden soll. Hier steht, wie es zur Wallbox kommt:
 *
 *   - Pause heisst abschalten (`setzeLaden(false)`), nicht "auf 6 A".
 *   - Nach einer Pause erst der Strom, dann der Schalter — damit das Fahrzeug
 *     nicht kurz mit dem alten Wert anläuft.
 *   - Nach einem Fehler wird nicht sofort weitergehämmert: 30 s, 60 s, 120 s …
 *     bis 5 min; ein misslungener Stopp höchstens 60 s, weil jede Minute dann
 *     Netzbezug ist. Ein kleinerer Sollwert darf eine Sperre nach einem
 *     höheren Fehlversuch überholen.
 *   - Der Befehlsstatus (übermittelt / angenommen / bestätigt / fehlgeschlagen)
 *     ist vom Wunsch und vom gemessenen Stromfluss getrennt.
 */

import type { EvChargerSnapshot } from '@energy/core';
import type { SteuerbaresLadegeraet } from '@energy/connectors';

/**
 * Was mit dem letzten Steuerbefehl geschah — getrennt vom Wunsch und vom
 * gemessenen Stromfluss.
 *
 *   uebermittelt    an die Cloud geschickt, Antwort steht aus
 *   angenommen      die Cloud hat den Befehl angenommen (HTTP ok)
 *   bestaetigt      das Gerät meldet den gesendeten Zustand zurück
 *   fehlgeschlagen  die Cloud hat abgelehnt oder nicht geantwortet
 *
 * "angenommen" heisst ausdrücklich nicht "Auto lädt" — ob Strom fliesst,
 * sagt nur die Messung.
 */
export interface Befehlsstand {
  readonly schalter: boolean;
  readonly stromA: number | null;
  readonly gesendetAm: string;
  readonly status: 'uebermittelt' | 'angenommen' | 'bestaetigt' | 'fehlgeschlagen';
  readonly fehler: string | null;
}

/** Obergrenze für den Wiederholabstand nach Fehlern. */
const BACKOFF_MAX_MS = 5 * 60_000;
/** Kürzere Obergrenze, wenn ein STOPP nicht durchkam. */
const BACKOFF_STOPP_MAX_MS = 60_000;

export type Sendeergebnis =
  | { readonly ok: true; readonly gesetztA: number; readonly eingeschaltet: boolean }
  | { readonly ok: true; readonly abgebrochen: true }
  | { readonly ok: false; readonly fehler: string };

export class Befehlsausfuehrung {
  /** Zuletzt an die Wallbox gesendeter Schalterzustand; null = unbekannt. */
  ladenAn: boolean | null = null;
  /** Letzter Steuerbefehl samt Status. */
  befehl: Befehlsstand | null = null;
  letzterBefehlAt: number | null = null;
  letzterFehler: string | null = null;

  private fehlerzahl = 0;
  private gesperrtBis = 0;
  /** Ein kleinerer Sollwert darf eine Sperre nach einem höheren Fehlversuch überholen. */
  private fehlgeschlagenA: number | null = null;

  constructor(
    private readonly geraet: SteuerbaresLadegeraet,
    /** Wird bei jeder Statusänderung gerufen (Ereignisstrom). */
    private readonly melde: () => void,
    private readonly jetzt: () => number = () => Date.now(),
  ) {}

  /** Steht der Befehl noch in einer Fehlersperre? */
  gesperrt(stromA: number): boolean {
    const dringlicher = this.fehlgeschlagenA !== null && stromA < this.fehlgeschlagenA;
    return this.jetzt() < this.gesperrtBis && !dringlicher;
  }

  /**
   * Sendet den Sollwert.
   *
   * @param abbrechen Wird nach dem Stromsetzen gefragt: Ein Stopp, Moduswechsel
   *   oder Abstecken während der Cloud-Anfrage darf nicht anschliessend noch
   *   eine veraltete Einschaltfreigabe auslösen.
   */
  async sende(stromA: number, abbrechen: () => boolean = () => false): Promise<Sendeergebnis> {
    const dringlicher = this.fehlgeschlagenA !== null && stromA < this.fehlgeschlagenA;
    this.befehl = {
      schalter: stromA > 0,
      stromA: stromA > 0 ? stromA : null,
      gesendetAm: new Date(this.jetzt()).toISOString(),
      status: 'uebermittelt',
      fehler: null,
    };
    this.melde();

    try {
      let gesetzt: number;
      let eingeschaltet = false;
      if (stromA === 0) {
        await this.geraet.setzeLaden(false);
        this.ladenAn = false;
        gesetzt = 0;
      } else {
        gesetzt = await this.geraet.setzeLadestrom(stromA);
        if (abbrechen()) return { ok: true, abgebrochen: true };
        if (this.ladenAn !== true) {
          await this.geraet.setzeLaden(true);
          this.ladenAn = true;
          eingeschaltet = true;
        }
      }
      if (this.befehl !== null && this.befehl.status === 'uebermittelt') {
        this.befehl = { ...this.befehl, status: 'angenommen' };
      }
      this.letzterBefehlAt = this.jetzt();
      this.letzterFehler = null;
      this.fehlerzahl = 0;
      this.gesperrtBis = 0;
      this.fehlgeschlagenA = null;
      return { ok: true, gesetztA: gesetzt, eingeschaltet };
    } catch (error) {
      if (dringlicher) this.fehlerzahl = 0;
      this.fehlgeschlagenA = stromA;
      this.fehlerzahl += 1;
      this.letzterFehler = error instanceof Error ? error.message : String(error);
      if (this.befehl !== null) {
        this.befehl = { ...this.befehl, status: 'fehlgeschlagen', fehler: this.letzterFehler };
      }
      const obergrenze = stromA === 0 ? BACKOFF_STOPP_MAX_MS : BACKOFF_MAX_MS;
      const wartenMs = Math.min(obergrenze, 30_000 * 2 ** (this.fehlerzahl - 1));
      this.gesperrtBis = this.jetzt() + wartenMs;
      console.warn(
        `[Laderegelung] Befehl fehlgeschlagen (${this.fehlerzahl}. Mal): `
          + `${this.letzterFehler} — nächster Versuch in ${Math.round(wartenMs / 1000)} s.`,
      );
      return { ok: false, fehler: this.letzterFehler };
    }
  }

  /**
   * Einen ausstehenden Befehl bestätigen, sobald das Gerät den gesendeten
   * Zustand zurückmeldet. Gibt zurück, ob sich etwas geändert hat.
   */
  bestaetigeAus(ev: EvChargerSnapshot | null): boolean {
    const b = this.befehl;
    const erreichbar = ev !== null && ev.state !== 'offline';
    if (b === null || (b.status !== 'angenommen' && b.status !== 'uebermittelt') || !erreichbar) return false;
    const schalterPasst = ev.schalterAn === b.schalter;
    const stromPasst = !b.schalter || b.stromA === null || ev.maxCurrentA === b.stromA;
    if (schalterPasst && stromPasst) {
      this.befehl = { ...b, status: 'bestaetigt' };
      return true;
    }
    return false;
  }
}
