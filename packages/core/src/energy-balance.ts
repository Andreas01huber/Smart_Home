/**
 * Plausibilitätsprüfung der Energiebilanz.
 *
 * Ein Dashboard, das unbemerkt falsche Werte anzeigt, ist schlimmer als eines,
 * das eine Lücke zugibt. Diese Prüfung deckt genau die Fälle auf, in denen
 * Erzeuger oder Verbraucher von keiner Quelle erfasst werden.
 *
 * Physikalisch muss gelten:
 *   PV + Netzbezug + Batterieentladung
 *     = Hausverbrauch + Netzeinspeisung + Batterieladung
 */

import type { EnergySnapshot } from './model.ts';

export type BalanceVerdict =
  | 'ok'
  | 'incomplete'
  | 'unmeasured-generation'
  | 'unmeasured-consumption';

export interface EnergyBalance {
  readonly verdict: BalanceVerdict;
  /** Zufluss minus Abfluss in Watt. Positiv = mehr Erzeugung als Verbrauch erfasst. */
  readonly residualW: number | null;
  readonly inflowW: number | null;
  readonly outflowW: number | null;
  /** Erklärung im Klartext, direkt für die Oberfläche verwendbar. */
  readonly message: string | null;
}

/** Absolute Toleranz in Watt. Messungen verschiedener Geräte sind nie synchron. */
const ABSOLUTE_TOLERANCE_W = 250;
/** Zusätzliche relative Toleranz, bezogen auf den grösseren Bilanzzweig. */
const RELATIVE_TOLERANCE = 0.15;

export function checkEnergyBalance(snapshot: EnergySnapshot): EnergyBalance {
  const solar = snapshot.solarProductionW.valueW;
  const house = snapshot.houseConsumptionW.valueW;
  const gridImport = snapshot.gridImportW.valueW;
  const gridExport = snapshot.gridExportW.valueW;

  if (solar === null || house === null || gridImport === null || gridExport === null) {
    return {
      verdict: 'incomplete',
      residualW: null,
      inflowW: null,
      outflowW: null,
      message: null,
    };
  }

  let charge = 0;
  let discharge = 0;
  for (const battery of snapshot.batteries) {
    charge += battery.chargeW ?? 0;
    discharge += battery.dischargeW ?? 0;
  }

  const inflowW = solar + gridImport + discharge;
  const outflowW = house + gridExport + charge;
  const residualW = inflowW - outflowW;

  const tolerance = Math.max(
    ABSOLUTE_TOLERANCE_W,
    Math.max(inflowW, outflowW) * RELATIVE_TOLERANCE,
  );

  if (Math.abs(residualW) <= tolerance) {
    return { verdict: 'ok', residualW, inflowW, outflowW, message: null };
  }

  if (residualW < 0) {
    // Es fliesst mehr ab, als erfasst zufliesst: irgendwo erzeugt jemand Strom,
    // den keine Datenquelle meldet.
    return {
      verdict: 'unmeasured-generation',
      residualW,
      inflowW,
      outflowW,
      message: `Es werden rund ${Math.round(Math.abs(residualW))} W mehr abgegeben als erfasst erzeugt. Sehr wahrscheinlich speist ein Erzeuger ein, den keine eingerichtete Datenquelle sieht.`,
    };
  }

  return {
    verdict: 'unmeasured-consumption',
    residualW,
    inflowW,
    outflowW,
    message: `Es werden rund ${Math.round(residualW)} W mehr erzeugt als erfasst verbraucht. Sehr wahrscheinlich gibt es einen Verbraucher, den keine eingerichtete Datenquelle sieht.`,
  };
}
