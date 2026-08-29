/**
 * Energy Accounting (Anforderungen 24, 26, 27, 30–34, 42).
 *
 * Reine Funktionen auf akkumulierten Energiemengen (Wh). Kein Zustand, keine
 * Zeit, keine I/O — damit vollständig testbar. Die Zahlen sind ein
 * Accounting-Modell (kein physikalischer Anspruch über einzelne Elektronen),
 * genau wie in der Spezifikation gefordert.
 */

/** Über einen Zeitraum (z. B. einen Tag) integrierte Energiemengen in Wh. */
export interface EnergyTotals {
  readonly productionWh: number;
  /** Erzeugung je Wechselrichter, Schlüssel = Connector-ID. */
  readonly perInverterWh: Readonly<Record<string, number>>;
  readonly houseConsumptionWh: number;
  readonly gridImportWh: number;
  readonly gridExportWh: number;
  /** Ladung je Speicher, Schlüssel = Geräte-ID. */
  readonly batteryChargeWh: Readonly<Record<string, number>>;
  readonly batteryDischargeWh: Readonly<Record<string, number>>;
  readonly evChargeWh: number;
}

export function emptyTotals(): EnergyTotals {
  return {
    productionWh: 0,
    perInverterWh: {},
    houseConsumptionWh: 0,
    gridImportWh: 0,
    gridExportWh: 0,
    batteryChargeWh: {},
    batteryDischargeWh: {},
    evChargeWh: 0,
  };
}

function sumValues(record: Readonly<Record<string, number>>): number {
  let sum = 0;
  for (const value of Object.values(record)) sum += value;
  return sum;
}

export function totalBatteryChargeWh(t: EnergyTotals): number {
  return sumValues(t.batteryChargeWh);
}

export function totalBatteryDischargeWh(t: EnergyTotals): number {
  return sumValues(t.batteryDischargeWh);
}

/**
 * Autarkiegrad: Anteil des Verbrauchs, der NICHT aus dem Netz kam.
 *
 *   Autarkie = 1 - Netzbezug / Gesamtverbrauch
 */
export function autarkyPercent(t: EnergyTotals): number | null {
  if (t.houseConsumptionWh <= 0) return null;
  const value = 1 - t.gridImportWh / t.houseConsumptionWh;
  return clampPercent(value * 100);
}

/**
 * Eigenverbrauchsquote: Anteil der Erzeugung, der selbst genutzt wurde
 * (direkt, Speicher, Auto) statt eingespeist zu werden.
 *
 *   Eigenverbrauch = 1 - Netzeinspeisung / Erzeugung
 */
export function selfConsumptionPercent(t: EnergyTotals): number | null {
  if (t.productionWh <= 0) return null;
  const value = 1 - t.gridExportWh / t.productionWh;
  return clampPercent(value * 100);
}

/** Woraus der Hausverbrauch gedeckt wurde (Accounting-Modell, 4L/24). */
export interface ConsumptionSources {
  readonly pvDirectWh: number;
  readonly batteryWh: number;
  readonly gridWh: number;
}

export function consumptionSources(t: EnergyTotals): ConsumptionSources {
  const gridWh = t.gridImportWh;
  const batteryWh = totalBatteryDischargeWh(t);
  const pvDirectWh = Math.max(0, t.houseConsumptionWh - gridWh - batteryWh);
  return { pvDirectWh, batteryWh, gridWh };
}

/** Wohin die Erzeugung floss (Accounting-Modell, 23). */
export interface ProductionSinks {
  readonly directWh: number;
  readonly batteryWh: number;
  readonly gridWh: number;
}

export function productionSinks(t: EnergyTotals): ProductionSinks {
  const gridWh = t.gridExportWh;
  const batteryWh = totalBatteryChargeWh(t);
  const directWh = Math.max(0, t.productionWh - gridWh - batteryWh);
  return { directWh, batteryWh, gridWh };
}

/** Konfigurierbare Stromtarife (29). */
export interface Tariff {
  /** Arbeitspreis Netzbezug in €/kWh. */
  readonly importPricePerKWh: number;
  /** Einspeisevergütung in €/kWh. */
  readonly exportPricePerKWh: number;
  /** Optionale Grundgebühr pro Monat in €. */
  readonly baseFeePerMonth?: number;
}

export interface CostResult {
  /** Kosten, die durch Eigenverbrauch NICHT anfielen. */
  readonly savedGridCostEUR: number;
  /** Erlös aus Einspeisung. */
  readonly feedInRevenueEUR: number;
  /** Ersparnis + Erlös. */
  readonly totalBenefitEUR: number;
  /** Tatsächliche Netzbezugskosten. */
  readonly gridCostActualEUR: number;
  /** Hypothetische Kosten ohne PV/Speicher (gesamter Verbrauch aus Netz). */
  readonly gridCostWithoutSystemEUR: number;
}

/**
 * Kosten und Ersparnis (30–34).
 *
 * Ersparnis = selbst genutzte Energie (Verbrauch minus Netzbezug) × Arbeitspreis.
 * Das ist genau die Energie, die sonst gekauft worden wäre.
 */
export function computeCosts(t: EnergyTotals, tariff: Tariff): CostResult {
  const selfUsedKWh = Math.max(0, t.houseConsumptionWh - t.gridImportWh) / 1000;
  const savedGridCostEUR = selfUsedKWh * tariff.importPricePerKWh;
  const feedInRevenueEUR = (t.gridExportWh / 1000) * tariff.exportPricePerKWh;
  const gridCostActualEUR = (t.gridImportWh / 1000) * tariff.importPricePerKWh;
  const gridCostWithoutSystemEUR =
    (t.houseConsumptionWh / 1000) * tariff.importPricePerKWh;

  return {
    savedGridCostEUR,
    feedInRevenueEUR,
    totalBenefitEUR: savedGridCostEUR + feedInRevenueEUR,
    gridCostActualEUR,
    gridCostWithoutSystemEUR,
  };
}

/**
 * Kapazitätsgewichteter Gesamt-SOC (15).
 *
 *   (Kap1 × SOC1 + Kap2 × SOC2) / (Kap1 + Kap2)
 *
 * Ein einfacher Mittelwert wäre falsch, wenn die Kapazitäten stark differieren.
 */
export interface BatteryCapacitySoc {
  readonly usableCapacityWh: number | null;
  readonly socPercent: number | null;
}

export interface AggregateStorage {
  readonly totalCapacityWh: number;
  readonly storedWh: number;
  readonly socPercent: number | null;
}

export function aggregateStorage(
  batteries: readonly BatteryCapacitySoc[],
): AggregateStorage {
  let totalCapacityWh = 0;
  let storedWh = 0;
  let usable = false;

  for (const battery of batteries) {
    if (battery.usableCapacityWh === null || battery.socPercent === null) continue;
    usable = true;
    totalCapacityWh += battery.usableCapacityWh;
    storedWh += (battery.socPercent / 100) * battery.usableCapacityWh;
  }

  return {
    totalCapacityWh,
    storedWh,
    socPercent: usable && totalCapacityWh > 0 ? (storedWh / totalCapacityWh) * 100 : null,
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
