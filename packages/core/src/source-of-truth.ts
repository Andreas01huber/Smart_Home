/**
 * Source-of-Truth-Auflösung (Anforderungen 4L und 4M) mit Energy Accounting (4AA).
 *
 * Fronius und Victron messen teilweise dieselben physikalischen Energieflüsse.
 * Diese Werte dürfen niemals addiert werden. Für jede Messgröße gibt es eine
 * definierte Behandlung:
 *
 * - Netz:        genau eine maßgebliche Quelle (die anderen nur zur Kontrolle).
 * - PV:          Summe über *verschiedene* Wechselrichter, jeder genau einmal.
 * - Hausverbrauch: entweder eine Quelle, oder — wenn kein Gerät den
 *                Gesamtverbrauch misst — aus der Bilanz berechnet ("derived").
 * - Batterien:   physisch getrennte Geräte, werden zusammengeführt (nicht aufgelöst).
 */

import type {
  ConnectorId,
  ConnectorReading,
  DataQuality,
  EnergySnapshot,
  PowerMetric,
} from './model.ts';

/**
 * Welche Quelle für welche Messgröße maßgeblich ist.
 * Wird über die Oberfläche "Einstellungen -> Energy Source Mapping" gepflegt.
 */
export interface SourceMapping {
  /**
   * PV-Erzeugung. Ein einzelner Connector, oder eine Liste, deren Werte
   * summiert werden. Eine Liste ist NUR zulässig, wenn die Connectoren
   * verschiedene physische Wechselrichter liefern (sonst Doppelzählung).
   */
  readonly solarProductionW: ConnectorId | readonly ConnectorId[];
  readonly gridImportW: ConnectorId;
  readonly gridExportW: ConnectorId;
  /**
   * Hausverbrauch. Ein Connector, oder `'derived'`: dann wird der Verbrauch
   * aus PV, Netz und Batterien berechnet — für den Fall, dass kein einzelnes
   * Gerät den Gesamtverbrauch misst.
   */
  readonly houseConsumptionW: ConnectorId | 'derived';
}

export interface ResolutionOptions {
  readonly disagreementThreshold?: number;
  readonly disagreementFloorW?: number;
}

/** Ein erkannter Widerspruch zwischen zwei Quellen (für die Diagnose, 4Y). */
export interface Disagreement {
  readonly metric: string;
  readonly authoritative: ConnectorId;
  readonly authoritativeValueW: number;
  readonly other: ConnectorId;
  readonly otherValueW: number;
  readonly relativeDeviation: number;
}

export interface ResolutionResult {
  readonly snapshot: EnergySnapshot;
  readonly unavailable: readonly string[];
  readonly disagreements: readonly Disagreement[];
  /**
   * Nur im Modus "derived": true, wenn der berechnete Verbrauch negativ wäre.
   * Das bedeutet, dass mehr eingespeist/geladen wird als erfasst erzeugt —
   * also speist ein Erzeuger ein, den keine Quelle sieht.
   */
  readonly derivedConsumptionNegative: boolean;
}

const MISSING_METRIC: PowerMetric = {
  valueW: null,
  provenance: {
    connectorId: 'none',
    deviceId: 'none',
    measuredAt: new Date(0),
    ageMs: Number.POSITIVE_INFINITY,
    quality: 'unknown',
  },
};

/** Reihenfolge von schlecht nach gut, für die Zusammenfassung von Qualitäten. */
const QUALITY_ORDER: DataQuality[] = ['unknown', 'offline', 'stale', 'live'];

function worseQuality(a: DataQuality, b: DataQuality): DataQuality {
  return QUALITY_ORDER.indexOf(a) <= QUALITY_ORDER.indexOf(b) ? a : b;
}

export function resolveSnapshot(
  readings: readonly ConnectorReading[],
  mapping: SourceMapping,
  options: ResolutionOptions = {},
): ResolutionResult {
  const threshold = options.disagreementThreshold ?? 0.15;
  const floorW = options.disagreementFloorW ?? 100;

  const byConnector = new Map<ConnectorId, ConnectorReading>();
  for (const reading of readings) byConnector.set(reading.connectorId, reading);

  const unavailable: string[] = [];
  const disagreements: Disagreement[] = [];

  // --- PV: Summe verschiedener Wechselrichter --------------------------
  const solarSources = Array.isArray(mapping.solarProductionW)
    ? mapping.solarProductionW
    : [mapping.solarProductionW];
  const solar = sumMetric(byConnector, solarSources, 'solarProductionW');
  if (solar.valueW === null) unavailable.push('solarProductionW');

  // --- Netz: je eine maßgebliche Quelle --------------------------------
  const gridImport = pickMetric(byConnector, mapping.gridImportW, 'gridImportW');
  const gridExport = pickMetric(byConnector, mapping.gridExportW, 'gridExportW');
  if (gridImport.valueW === null) unavailable.push('gridImportW');
  if (gridExport.valueW === null) unavailable.push('gridExportW');

  collectDisagreements('gridImportW', mapping.gridImportW, gridImport, readings, threshold, floorW, disagreements);
  collectDisagreements('gridExportW', mapping.gridExportW, gridExport, readings, threshold, floorW, disagreements);

  // --- Batterien: physisch getrennt, zusammenführen --------------------
  const batteries = readings.flatMap((reading) => reading.batteries);

  // --- Hausverbrauch: gemessen oder berechnet --------------------------
  let house: PowerMetric;
  let derivedConsumptionNegative = false;
  if (mapping.houseConsumptionW === 'derived') {
    const derived = deriveConsumption(solar, gridImport, gridExport, batteries);
    house = derived.metric;
    derivedConsumptionNegative = derived.wasNegative;
    if (house.valueW === null) unavailable.push('houseConsumptionW');
  } else {
    house = pickMetric(byConnector, mapping.houseConsumptionW, 'houseConsumptionW');
    if (house.valueW === null) unavailable.push('houseConsumptionW');
    collectDisagreements('houseConsumptionW', mapping.houseConsumptionW, house, readings, threshold, floorW, disagreements);
  }

  // Wallbox: wird NICHT in die Bilanz eingerechnet. Sie hängt hinter dem
  // Hauszähler, ihre Leistung steckt bereits im Hausverbrauch — sie hier zu
  // addieren wäre exakt die Doppelzählung, die 4L ausschliesst. Der Wert wird
  // nur durchgereicht, damit die Oberfläche ihn separat ausweisen kann.
  const evCharger = readings.find((r) => r.evCharger != null)?.evCharger ?? null;

  const snapshot: EnergySnapshot = {
    timestamp: new Date(),
    solarProductionW: solar,
    houseConsumptionW: house,
    gridImportW: gridImport,
    gridExportW: gridExport,
    batteries,
    evCharger,
  };

  return { snapshot, unavailable, disagreements, derivedConsumptionNegative };
}

// --- Auswahl und Summierung ------------------------------------------------

function pickMetric(
  byConnector: Map<ConnectorId, ConnectorReading>,
  connectorId: ConnectorId,
  key: 'solarProductionW' | 'houseConsumptionW' | 'gridImportW' | 'gridExportW',
): PowerMetric {
  const metric = byConnector.get(connectorId)?.[key] ?? null;
  return metric !== null && metric.valueW !== null ? metric : MISSING_METRIC;
}

/**
 * Summiert eine Größe über mehrere Connectoren. Jeder Connector darf einen
 * physisch eigenen Beitrag liefern (z. B. je ein Wechselrichter). Fehlende
 * Beiträge werden übersprungen; fehlen alle, ist das Ergebnis null.
 */
function sumMetric(
  byConnector: Map<ConnectorId, ConnectorReading>,
  connectorIds: readonly ConnectorId[],
  key: 'solarProductionW',
): PowerMetric {
  let sum = 0;
  let contributors = 0;
  let quality: DataQuality = 'live';
  let oldest = new Date();

  for (const connectorId of connectorIds) {
    const metric = byConnector.get(connectorId)?.[key] ?? null;
    if (metric === null || metric.valueW === null) continue;
    sum += metric.valueW;
    contributors++;
    quality = worseQuality(quality, metric.provenance.quality);
    if (metric.provenance.measuredAt < oldest) oldest = metric.provenance.measuredAt;
  }

  if (contributors === 0) return MISSING_METRIC;

  return {
    valueW: sum,
    provenance: {
      connectorId: connectorIds.length === 1 ? connectorIds[0]! : 'sum',
      deviceId: connectorIds.join('+'),
      measuredAt: oldest,
      ageMs: Math.max(0, Date.now() - oldest.getTime()),
      quality,
    },
  };
}

/**
 * Berechnet den Gesamt-Hausverbrauch, wenn kein einzelnes Gerät ihn misst.
 *
 *   Verbrauch = PV + Netzbezug - Netzeinspeisung + Entladung - Ladung
 *
 * Ein negatives Rohergebnis ist physikalisch unmöglich und deutet auf eine
 * nicht erfasste Erzeugung hin. Es wird auf 0 begrenzt, aber gemeldet.
 */
function deriveConsumption(
  solar: PowerMetric,
  gridImport: PowerMetric,
  gridExport: PowerMetric,
  batteries: readonly EnergySnapshot['batteries'][number][],
): { metric: PowerMetric; wasNegative: boolean } {
  if (
    solar.valueW === null ||
    gridImport.valueW === null ||
    gridExport.valueW === null
  ) {
    return { metric: MISSING_METRIC, wasNegative: false };
  }

  let charge = 0;
  let discharge = 0;
  let quality = worseQuality(
    worseQuality(solar.provenance.quality, gridImport.provenance.quality),
    gridExport.provenance.quality,
  );
  for (const battery of batteries) {
    charge += battery.chargeW ?? 0;
    discharge += battery.dischargeW ?? 0;
    quality = worseQuality(quality, battery.provenance.quality);
  }

  const raw =
    solar.valueW + gridImport.valueW - gridExport.valueW + discharge - charge;
  const wasNegative = raw < -1;

  return {
    metric: {
      valueW: Math.max(0, raw),
      provenance: {
        connectorId: 'derived',
        deviceId: 'energy-accounting',
        measuredAt: new Date(),
        ageMs: 0,
        quality,
      },
    },
    wasNegative,
  };
}

function collectDisagreements(
  metricKey: string,
  authoritativeId: ConnectorId,
  authoritative: PowerMetric,
  readings: readonly ConnectorReading[],
  threshold: number,
  floorW: number,
  sink: Disagreement[],
): void {
  if (authoritative.valueW === null) return;
  const key = metricKey as 'solarProductionW' | 'houseConsumptionW' | 'gridImportW' | 'gridExportW';

  for (const reading of readings) {
    if (reading.connectorId === authoritativeId) continue;
    const other = reading[key];
    if (other === null || other.valueW === null) continue;

    if (Math.abs(authoritative.valueW) < floorW && Math.abs(other.valueW) < floorW) {
      continue;
    }
    const reference = Math.max(Math.abs(authoritative.valueW), Math.abs(other.valueW));
    if (reference === 0) continue;

    const deviation = Math.abs(authoritative.valueW - other.valueW) / reference;
    if (deviation > threshold) {
      sink.push({
        metric: metricKey,
        authoritative: authoritativeId,
        authoritativeValueW: authoritative.valueW,
        other: reading.connectorId,
        otherValueW: other.valueW,
        relativeDeviation: deviation,
      });
    }
  }
}
