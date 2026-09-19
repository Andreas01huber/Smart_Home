/**
 * Tarife mit Gültigkeitszeitraum.
 *
 * Bisher gab es genau einen Tarif, und jede Ansicht rechnete mit ihm — auch
 * der März mit dem Preis vom September. Wer den Arbeitspreis anpasste, änderte
 * damit stillschweigend alle vergangenen Kosten. Jetzt hat jeder Tarif ein
 * "gültig ab", und jeder Tag wird mit dem Tarif gerechnet, der an ihm galt.
 *
 * Eine Tarifhistorie wird dabei nicht erfunden. Die alte Datei kannte nur den
 * aktuellen Preis; sie wird zu einem Eintrag ohne Anfangsdatum, der ab dem Tag
 * der Umstellung als bekannt gilt. Für frühere Tage steht der Tarif dann als
 * "angenommen" da — die Kosten sind eine Schätzung, und das wird gesagt.
 *
 * Dateiformat (tariff.json, Fassung 2):
 *
 *   { "version": 2, "tarife": [
 *       { "gueltigAb": null, "bekanntSeit": "2026-09-19", "importPricePerKWh": 0.28, … },
 *       { "gueltigAb": "2026-10-01", "bekanntSeit": "2026-09-20", … } ] }
 *
 * Fassung 1 war der nackte Tarif; sie wird beim Laden übernommen und beim
 * nächsten Speichern als Fassung 2 geschrieben.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { Tariff } from '@energy/core';

import { pruefeTarif } from '../public/tarif-regeln.js';
import { bewahreBeschaedigt, writeJsonAtomic } from './persist.ts';

export interface Tarifeintrag extends Tariff {
  /** Ab diesem Tag gilt der Tarif. `null` = seit unbekannt (übernommener Altbestand). */
  readonly gueltigAb: string | null;
  /** Seit wann dieser Eintrag im System bekannt ist. */
  readonly bekanntSeit: string;
}

export interface TarifFuerTag {
  readonly tarif: Tariff;
  readonly gueltigAb: string | null;
  /** `angenommen`: Für diesen Tag ist kein Tarif bekannt, es wurde einer eingesetzt. */
  readonly grundlage: 'bekannt' | 'angenommen';
}

function nurTarif(e: Tariff): Tariff {
  return {
    importPricePerKWh: e.importPricePerKWh,
    exportPricePerKWh: e.exportPricePerKWh,
    ...(typeof e.baseFeePerMonth === 'number' ? { baseFeePerMonth: e.baseFeePerMonth } : {}),
  };
}

export class Tarifverlauf {
  private eintraege: Tarifeintrag[] = [];

  constructor(
    private readonly pfad: string,
    private readonly vorgabe: Tariff,
    private readonly heute: () => string,
  ) {
    this.laden();
  }

  private laden(): void {
    if (!existsSync(this.pfad)) return;
    let roh: unknown;
    try {
      roh = JSON.parse(readFileSync(this.pfad, 'utf8'));
    } catch {
      bewahreBeschaedigt(this.pfad);
      return;
    }
    const obj = roh as Record<string, unknown>;
    if (obj !== null && typeof obj === 'object' && Array.isArray(obj['tarife'])) {
      for (const e of obj['tarife'] as unknown[]) {
        const eintrag = e as Record<string, unknown>;
        const { gueltigAb, bekanntSeit, ...rest } = eintrag;
        const geprueft = pruefeTarif({ ...rest, ...(gueltigAb ? { gueltigAb } : {}) });
        if (!geprueft.ok || typeof bekanntSeit !== 'string') {
          console.warn(`${this.pfad}: Tarifeintrag verworfen (${geprueft.ok ? 'bekanntSeit fehlt' : geprueft.fehler}).`);
          continue;
        }
        this.eintraege.push({
          ...nurTarif(geprueft.tarif),
          gueltigAb: geprueft.tarif.gueltigAb ?? null,
          bekanntSeit,
        });
      }
      return;
    }
    // Fassung 1: der nackte Tarif. Er gilt ab heute als bekannt, davor als
    // angenommen — eine frühere Gültigkeit wäre erfunden.
    const alt = pruefeTarif(roh);
    if (alt.ok) {
      this.eintraege.push({ ...nurTarif(alt.tarif), gueltigAb: null, bekanntSeit: this.heute() });
    } else {
      console.warn(`${this.pfad}: Tarif ungültig (${alt.fehler}), Vorgabe aus config.json gilt.`);
    }
  }

  /** Der Tarif, mit dem ein Tag gerechnet wird. */
  fuerTag(datum: string): TarifFuerTag {
    const datiert = this.eintraege
      .filter((e) => e.gueltigAb !== null)
      .sort((a, b) => (a.gueltigAb ?? '').localeCompare(b.gueltigAb ?? ''));
    const passend = [...datiert].reverse().find((e) => (e.gueltigAb ?? '') <= datum);
    if (passend) return { tarif: nurTarif(passend), gueltigAb: passend.gueltigAb, grundlage: 'bekannt' };

    const offen = this.eintraege.find((e) => e.gueltigAb === null);
    if (offen) {
      return {
        tarif: nurTarif(offen),
        gueltigAb: null,
        grundlage: datum >= offen.bekanntSeit ? 'bekannt' : 'angenommen',
      };
    }
    // Ein künftig gültiger erster Eintrag verändert die bisherige Annahme
    // für heute und ältere Tage nicht rückwirkend.
    return { tarif: this.vorgabe, gueltigAb: null, grundlage: 'angenommen' };
  }

  aktuell(): TarifFuerTag {
    return this.fuerTag(this.heute());
  }

  verlauf(): readonly Tarifeintrag[] {
    return [...this.eintraege];
  }

  /**
   * Einen Tarif festlegen.
   *
   * Wirft bei ungültiger Eingabe (`TypeError`) und wenn nicht dauerhaft
   * gespeichert werden konnte (`Error`). In beiden Fällen bleibt der bisher
   * bestätigte Stand unverändert — ein Erfolg wird erst nach dem Schreiben
   * gemeldet, nicht vorher.
   */
  setze(roh: unknown): TarifFuerTag {
    const geprueft = pruefeTarif(roh);
    if (!geprueft.ok) throw new TypeError(geprueft.fehler);
    const gueltigAb = geprueft.tarif.gueltigAb ?? this.heute();
    const neu: Tarifeintrag = { ...nurTarif(geprueft.tarif), gueltigAb, bekanntSeit: this.heute() };

    const vorher = this.eintraege;
    const danach = [...vorher.filter((e) => e.gueltigAb !== gueltigAb), neu];
    writeJsonAtomic(this.pfad, { version: 2, tarife: danach }, 2);
    this.eintraege = danach;
    return this.fuerTag(gueltigAb);
  }
}
