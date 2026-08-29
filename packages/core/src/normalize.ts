/**
 * Übersetzung vorzeichenbehafteter Herstellerwerte in das interne Modell
 * (Anforderung 4O).
 *
 * Diese Datei ist die einzige Stelle im Projekt, an der Vorzeichen eine
 * Bedeutung tragen dürfen. Alles, was hier herauskommt, ist gerichtet benannt
 * und nicht-negativ.
 */

import type { BatteryState } from './model.ts';

/**
 * Wie ein Hersteller das Vorzeichen einer Netzleistung interpretiert.
 *
 * Fronius, `GetPowerFlowRealtimeData` -> `Site.P_Grid`, laut offizieller Doku
 * (42,0410,2012): "+ from grid, - to grid" — also `positiveIsImport`.
 */
export type GridSignConvention = 'positiveIsImport' | 'positiveIsExport';

/**
 * Wie ein Hersteller das Vorzeichen einer Batterieleistung interpretiert.
 *
 * Achtung, die beiden Fronius-Quellen widersprechen einander:
 * - `GetPowerFlowRealtimeData` -> `Site.P_Akku`: "- charge, + discharge"
 *   => `positiveIsDischarge`
 * - `GetStorageRealtimeData` -> `Current_DC`: "battery output current
 *   (+ charging)" => `positiveIsCharge`
 * Genau deshalb wird die Konvention hier explizit übergeben und nie geraten.
 */
export type BatterySignConvention = 'positiveIsCharge' | 'positiveIsDischarge';

/** Ein in Bezug und Einspeisung zerlegter Netzwert. Beide Felder sind >= 0. */
export interface GridSplit {
  readonly importW: number | null;
  readonly exportW: number | null;
}

/** Ein in Laden und Entladen zerlegter Batteriewert. Beide Felder sind >= 0. */
export interface BatteryPowerSplit {
  readonly chargeW: number | null;
  readonly dischargeW: number | null;
  readonly state: BatteryState;
}

/**
 * Toleranz in Watt, unterhalb derer eine Batterie als ruhend gilt.
 * Ein voller Speicher zieht für Balancing/Standby einige Watt — das ist
 * kein Laden. Erst darüber wird "Lädt" bzw. "Entlädt" angezeigt.
 */
const IDLE_THRESHOLD_W = 25;

/**
 * Zerlegt eine vorzeichenbehaftete Netzleistung in Bezug und Einspeisung.
 *
 * `null` bleibt `null` — das bedeutet "kein Smart Meter aktiv" und ist etwas
 * anderes als 0 W.
 */
export function splitGridPower(
  signedW: number | null | undefined,
  convention: GridSignConvention,
): GridSplit {
  if (signedW === null || signedW === undefined || !Number.isFinite(signedW)) {
    return { importW: null, exportW: null };
  }

  const importOriented =
    convention === 'positiveIsImport' ? signedW : -signedW;

  if (importOriented > 0) {
    return { importW: importOriented, exportW: 0 };
  }
  return { importW: 0, exportW: -importOriented };
}

/**
 * Zerlegt eine vorzeichenbehaftete Batterieleistung in Lade- und
 * Entladeleistung und leitet daraus den Betriebszustand ab.
 */
export function splitBatteryPower(
  signedW: number | null | undefined,
  convention: BatterySignConvention,
): BatteryPowerSplit {
  if (signedW === null || signedW === undefined || !Number.isFinite(signedW)) {
    return { chargeW: null, dischargeW: null, state: 'unknown' };
  }

  const chargeOriented =
    convention === 'positiveIsCharge' ? signedW : -signedW;

  if (chargeOriented > IDLE_THRESHOLD_W) {
    return { chargeW: chargeOriented, dischargeW: 0, state: 'charging' };
  }
  if (chargeOriented < -IDLE_THRESHOLD_W) {
    return { chargeW: 0, dischargeW: -chargeOriented, state: 'discharging' };
  }
  return { chargeW: 0, dischargeW: 0, state: 'idle' };
}

/**
 * Normalisiert den Hausverbrauch.
 *
 * Fronius meldet in `Site.P_Load` laut Doku "+ generator, - consumer".
 * Verbrauch kommt dort also als NEGATIVER Wert an — die häufigste
 * Vorzeichenfalle im gesamten Projekt.
 *
 * @param signedW Rohwert des Herstellers.
 * @param convention `negativeIsConsumption` für Fronius `P_Load`.
 */
export function normalizeHouseConsumption(
  signedW: number | null | undefined,
  convention: 'positiveIsConsumption' | 'negativeIsConsumption',
): number | null {
  if (signedW === null || signedW === undefined || !Number.isFinite(signedW)) {
    return null;
  }

  const consumptionOriented =
    convention === 'positiveIsConsumption' ? signedW : -signedW;

  // Ein negativer Hausverbrauch ist physikalisch nicht sinnvoll. Wenn er
  // auftritt, ist die Konvention falsch konfiguriert oder die Quelle liefert
  // Unsinn — in beiden Fällen ist 0 die ehrlichere Antwort als ein negativer
  // Wert, der sich stillschweigend durch das Dashboard zieht.
  return consumptionOriented > 0 ? consumptionOriented : 0;
}

/**
 * Rechnet SOC und Kapazität in eine gespeicherte Energiemenge um.
 * Gibt `null` zurück, sobald einer der Eingangswerte fehlt.
 */
export function storedEnergyWh(
  socPercent: number | null,
  usableCapacityWh: number | null,
): number | null {
  if (socPercent === null || usableCapacityWh === null) return null;
  if (!Number.isFinite(socPercent) || !Number.isFinite(usableCapacityWh)) {
    return null;
  }
  const clamped = Math.min(100, Math.max(0, socPercent));
  return (clamped / 100) * usableCapacityWh;
}
