/**
 * Bewertung des Alters und der Qualität von Messwerten (Anforderung 4P).
 *
 * Grundsatz: Ein veralteter Wert wird nicht versteckt und nicht als aktuell
 * ausgegeben. Er wird angezeigt und als veraltet markiert.
 */

import type { DataQuality, Provenance, ConnectorId } from './model.ts';

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
 * Vorgaben je Datenquelle.
 *
 * Die Victron-VRM-Werte sind bewusst großzügig bemessen: Die VRM API ist laut
 * offizieller Doku auf im Mittel ~3 Requests/s begrenzt, und die Loggerdaten
 * einer Installation aktualisieren sich ohnehin deutlich langsamer als eine
 * lokale Messung. Ein 5-Sekunden-Limit wie bei Fronius würde die Quelle
 * dauerhaft fälschlich als gestört melden.
 */
export const DEFAULT_STALENESS_POLICIES: Record<string, StalenessPolicy> = {
  'fronius-local': {
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
};

const FALLBACK_POLICY: StalenessPolicy = {
  expectedIntervalMs: 10_000,
  staleAfterMs: 60_000,
  offlineAfterMs: 300_000,
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

/** Baut eine Provenance und leitet Alter sowie Qualität selbst ab. */
export function provenance(
  connectorId: ConnectorId,
  deviceId: string,
  measuredAt: Date,
  now: Date = new Date(),
): Provenance {
  const ageMs = Math.max(0, now.getTime() - measuredAt.getTime());
  return {
    connectorId,
    deviceId,
    measuredAt,
    ageMs,
    quality: classifyAge(ageMs, policyFor(connectorId)),
  };
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
