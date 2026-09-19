/**
 * Healthcheck für Überwachung und Deploy: Lebt der Prozess, und arbeitet er?
 *
 * Bewusst getrennt vom Gerätezustand. Ein abgeschalteter Wechselrichter ist
 * kein Grund, den Dienst neu zu starten — ein Messzyklus, der seit Minuten
 * nicht mehr läuft, dagegen schon. Deshalb zählt hier nur, ob die Engine ihre
 * Runden dreht und ob die Datenspeicher schreiben können; ob die Geräte dabei
 * antworten, steht in /api/connectors (angemeldet).
 *
 * Die Antwort ist ohne Anmeldung erreichbar und enthält deshalb nichts
 * Privates: keine Messwerte, keine Gerätenamen, keine Adressen, keine Pfade.
 */

import type { Schreibstatus } from './persist.ts';

/** Ohne abgeschlossenen Zyklus in dieser Zeit gilt die Messung als stehengeblieben. */
export const ZYKLUS_STILLSTAND_MS = 120_000;

export interface Gesundheitslage {
  readonly startMs: number;
  /** Ende des letzten abgeschlossenen Messzyklus, `null` vor dem ersten. */
  readonly letzterZyklusMs: number | null;
  readonly jetztMs: number;
  readonly speicher: readonly Schreibstatus[];
}

export interface Gesundheit {
  readonly status: 200 | 503;
  readonly body: {
    readonly ok: boolean;
    readonly laufzeitS: number;
    readonly messung: 'laeuft' | 'startet' | 'steht';
    readonly letzterZyklusVorS: number | null;
    readonly speicher: 'ok' | 'fehler' | 'gesperrt';
  };
}

export function gesundheit(l: Gesundheitslage): Gesundheit {
  const laufzeitMs = Math.max(0, l.jetztMs - l.startMs);
  const alterMs = l.letzterZyklusMs === null ? null : Math.max(0, l.jetztMs - l.letzterZyklusMs);

  // Kurz nach dem Start hat es noch keinen Zyklus gegeben — das ist kein Fehler.
  const messung = alterMs === null
    ? (laufzeitMs < ZYKLUS_STILLSTAND_MS ? 'startet' : 'steht')
    : (alterMs < ZYKLUS_STILLSTAND_MS ? 'laeuft' : 'steht');

  const speicher = l.speicher.some((s) => s.gesperrt !== null)
    ? 'gesperrt'
    : l.speicher.some((s) => s.fehler !== null) ? 'fehler' : 'ok';

  // Ein Schreibfehler macht den Dienst nicht unbrauchbar (Anzeige und
  // Regelung laufen weiter), wird aber gemeldet. Nur eine stehende Messung
  // ist ein Grund für 503.
  const ok = messung !== 'steht';
  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      laufzeitS: Math.round(laufzeitMs / 1000),
      messung,
      letzterZyklusVorS: alterMs === null ? null : Math.round(alterMs / 1000),
      speicher,
    },
  };
}
