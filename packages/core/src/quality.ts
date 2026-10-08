/**
 * Bewertung des Alters und der Qualität von Messwerten (Anforderung 4P).
 *
 * Grundsatz: Ein veralteter Wert wird nicht versteckt und nicht als aktuell
 * ausgegeben. Er wird angezeigt und als veraltet markiert.
 */

import type { DataQuality, PowerMetric, Provenance, ConnectorId } from './model.ts';

/** Ab wann ein Wert nicht mehr als live gilt, je Connector. */
export interface StalenessPolicy {
  /** Erwartetes Aktualisierungsintervall in Millisekunden. */
  readonly expectedIntervalMs: number;
  /** Ab diesem Alter gilt der Wert als `stale`. */
  readonly staleAfterMs: number;
  /** Ab diesem Alter gilt die Quelle als `offline`. */
  readonly offlineAfterMs: number;
}

/**
 * Art der Datenquelle. Die Frischegrenzen hängen am Typ, nicht an der
 * Connector-ID: Zwei Fronius-Wechselrichter altern gleich, egal wie sie heissen.
 */
export type Quellenart =
  | 'fronius-solar-api'
  | 'victron-modbus'
  | 'victron-mqtt'
  | 'victron-vrm'
  | 'tuya-evse';

/**
 * Vorgaben je Quellenart.
 *
 * Lokale Quellen (Fronius Solar API, Victron Modbus) werden alle 2 s abgefragt
 * und liefern einen Zeitstempel je Antwort; nach 15 s ohne neuen Wert ist etwas
 * faul. Die Tuya-Cloud meldet Datenpunkte nur bei Änderung — eine untätige
 * Wallbox hat deshalb legitim alte Zeitstempel; die Grenzen sind bewusst weit.
 * Die VRM-Werte sind großzügig, weil die Cloud laut Doku auf ~3 Requests/s
 * begrenzt ist und Loggerdaten ohnehin langsamer kommen.
 */
export const STALENESS_BY_TYPE: Readonly<Record<Quellenart, StalenessPolicy>> = {
  'fronius-solar-api': {
    expectedIntervalMs: 2_000,
    staleAfterMs: 15_000,
    offlineAfterMs: 60_000,
  },
  'victron-modbus': {
    expectedIntervalMs: 2_000,
    staleAfterMs: 15_000,
    offlineAfterMs: 60_000,
  },
  'victron-mqtt': {
    expectedIntervalMs: 5_000,
    staleAfterMs: 30_000,
    offlineAfterMs: 120_000,
  },
  'victron-vrm': {
    expectedIntervalMs: 60_000,
    staleAfterMs: 300_000,
    offlineAfterMs: 900_000,
  },
  'tuya-evse': {
    expectedIntervalMs: 10_000,
    staleAfterMs: 60_000,
    offlineAfterMs: 300_000,
  },
};

/**
 * Für Quellen ohne bekannte Art (Tests, Fixtures). Bewusst dieselben Werte wie
 * früher für unbekannte IDs, damit sich bestehendes Verhalten nicht ändert.
 */
export const FALLBACK_POLICY: StalenessPolicy = {
  expectedIntervalMs: 10_000,
  staleAfterMs: 60_000,
  offlineAfterMs: 300_000,
};

/**
 * Bisherige Zuordnung über die Connector-ID — nur noch für Aufrufer, die ihre
 * Art nicht mitgeben. Neue Connectoren übergeben ihre Policy ausdrücklich.
 */
export const DEFAULT_STALENESS_POLICIES: Record<string, StalenessPolicy> = {
  'fronius-local': STALENESS_BY_TYPE['fronius-solar-api'],
  'fronius-gen24': STALENESS_BY_TYPE['fronius-solar-api'],
  'victron-modbus': STALENESS_BY_TYPE['victron-modbus'],
  'victron-mqtt': STALENESS_BY_TYPE['victron-mqtt'],
  'victron-vrm': STALENESS_BY_TYPE['victron-vrm'],
};

export function policyFor(connectorId: ConnectorId): StalenessPolicy {
  return DEFAULT_STALENESS_POLICIES[connectorId] ?? FALLBACK_POLICY;
}

export function classifyAge(
  ageMs: number,
  policy: StalenessPolicy,
): DataQuality {
  if (ageMs >= policy.offlineAfterMs) return 'offline';
  if (ageMs >= policy.staleAfterMs) return 'stale';
  return 'live';
}

/**
 * Baut eine Provenance und leitet Alter sowie Qualität selbst ab.
 *
 * @param policy Frischegrenzen der Quelle. Connectoren geben sie nach ihrer
 *   Art mit (`STALENESS_BY_TYPE`); ohne Angabe gilt die Zuordnung über die ID.
 */
export function provenance(
  connectorId: ConnectorId,
  deviceId: string,
  measuredAt: Date,
  now: Date = new Date(),
  policy: StalenessPolicy = policyFor(connectorId),
): Provenance {
  const ageMs = Math.max(0, now.getTime() - measuredAt.getTime());
  return {
    connectorId,
    deviceId,
    measuredAt,
    ageMs,
    quality: classifyAge(ageMs, policy),
  };
}

/**
 * Längstes Intervall, das als gemessen integriert wird.
 *
 * Gilt für Tagesbilanz und Ladeprotokoll gleichermassen. Ist mehr Zeit seit dem
 * letzten Messwert vergangen, war dazwischen nachweislich keine Messung — das
 * ganze Intervall ist dann Lücke, nicht nur der Teil über dieser Grenze.
 * Sonst gälten nach jedem Ausfall die ersten Sekunden als sicher gemessen.
 */
export const MAX_INTEGRATIONSSCHRITT_S = 15;

/** Ist dieser Messpunkt aktuell genug, um als Messung durchzugehen? */
export function istAktuell(provenance: Provenance): boolean {
  return provenance.quality === 'live';
}

/**
 * Der Wert eines Messpunkts, sofern er in eine Energiebilanz eingehen darf.
 *
 * Eine Bilanz integriert Leistung über Zeit, und ein eingefrorener Wert erzeugt
 * dabei Energie, die nie geflossen ist: Meldet eine Quelle ihre letzten 3000 W
 * noch eine Viertelstunde weiter, stehen danach 750 Wh in der Tagessumme, für
 * die es keine einzige Messung gibt. Im Zweifel ist eine ausgewiesene Lücke
 * richtiger als eine erfundene Kilowattstunde.
 *
 * `null` heisst deshalb "nicht verwertbar" — unbekannt, veraltet oder von einer
 * Quelle, die als offline gilt. Nicht "null Watt".
 */
export function bilanzwertW(metric: PowerMetric | null | undefined): number | null {
  if (!metric || !istAktuell(metric.provenance)) return null;
  const watt = metric.valueW;
  return watt !== null && Number.isFinite(watt) ? watt : null;
}

/** Menschenlesbares Alter für die Oberfläche, z. B. "vor 2 Sekunden". */
export function formatAgeDe(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 2) return 'gerade eben';
  if (seconds < 60) return `vor ${seconds} Sekunden`;

  const minutes = Math.round(seconds / 60);
  if (minutes === 1) return 'vor 1 Minute';
  if (minutes < 60) return `vor ${minutes} Minuten`;

  const hours = Math.round(minutes / 60);
  if (hours === 1) return 'vor 1 Stunde';
  return `vor ${hours} Stunden`;
}
