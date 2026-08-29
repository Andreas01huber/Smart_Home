/**
 * Adapter für die lokale Fronius Solar API V1.
 *
 * Endpunkte und Vorzeichenkonventionen stammen aus der offiziellen Doku
 * 42,0410,2012 (Rev. 05/2025). Siehe docs/01-datenquellen-verifikation.md.
 *
 * Kein Herstellerwert verlässt diesen Adapter mit seiner Original-Semantik:
 * Alles wird über @energy/core normalisiert.
 */

import {
  normalizeHouseConsumption,
  provenance,
  splitBatteryPower,
  splitGridPower,
  storedEnergyWh,
  type BatterySnapshot,
  type ConnectorReading,
  type PowerMetric,
} from '@energy/core';

import type { ConnectorDiagnostics, EnergyConnector } from './types.ts';

export interface FroniusLocalOptions {
  readonly host: string;
  readonly connectorId?: string;
  readonly displayName?: string;
  readonly timeoutMs?: number;
  /**
   * Nutzbare Kapazität je Speicher-DeviceId in Wh. Überschreibt den vom Gerät
   * gemeldeten Wert (Anforderung 4J).
   */
  readonly usableCapacityWhByDevice?: Readonly<Record<string, number>>;
  /**
   * Anzeigename für den (ersten) Speicher, z. B. "Kleiner Speicher".
   * Ohne Angabe wird Hersteller + Modell verwendet.
   */
  readonly batteryDisplayName?: string;
}

const ALL_METRICS = [
  'solarProductionW',
  'houseConsumptionW',
  'gridImportW',
  'gridExportW',
] as const;

export class FroniusLocalConnector implements EnergyConnector {
  readonly id: string;
  readonly displayName: string;

  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly capacityOverrides: Readonly<Record<string, number>>;
  private readonly batteryDisplayName: string | null;

  private lastSuccessAt: Date | null = null;
  private responseTimeMs: number | null = null;
  private errorCount = 0;
  private lastError: string | null = null;
  private detectedDevices = 0;
  private missingMetrics: string[] = [];

  constructor(options: FroniusLocalOptions) {
    this.host = options.host;
    this.id = options.connectorId ?? 'fronius-local';
    this.displayName = options.displayName ?? 'Fronius (lokale Solar API)';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.capacityOverrides = options.usableCapacityWhByDevice ?? {};
    this.batteryDisplayName = options.batteryDisplayName ?? null;
  }

  async read(): Promise<ConnectorReading> {
    const startedAt = Date.now();
    try {
      const [powerFlow, storage] = await Promise.all([
        this.getJson('/solar_api/v1/GetPowerFlowRealtimeData.fcgi'),
        this.getJson('/solar_api/v1/GetStorageRealtimeData.cgi?Scope=System').catch(
          () => null,
        ),
      ]);

      this.responseTimeMs = Date.now() - startedAt;
      this.lastSuccessAt = new Date();
      this.lastError = null;

      const reading = this.toReading(powerFlow, storage);
      this.missingMetrics = ALL_METRICS.filter(
        (key) => reading[key] === null || reading[key]?.valueW === null,
      );
      return reading;
    } catch (error) {
      this.errorCount++;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.responseTimeMs = null;
      // Ohne diese Zeile behielt die Diagnose die Kennzahlen des letzten
      // erfolgreichen Abrufs: Ein ausgefallenes Gerät meldete weiterhin
      // "4 von 4 Messgrössen verfügbar", obwohl es gerade keine liefert.
      this.missingMetrics = [...ALL_METRICS];
      return this.emptyReading();
    }
  }

  diagnostics(): ConnectorDiagnostics {
    return {
      connectorId: this.id,
      displayName: this.displayName,
      online: this.lastError === null && this.lastSuccessAt !== null,
      responseTimeMs: this.responseTimeMs,
      lastSuccessAt: this.lastSuccessAt,
      detectedDevices: this.detectedDevices,
      availableMetrics: ALL_METRICS.length - this.missingMetrics.length,
      missingMetrics: this.missingMetrics,
      errorCount: this.errorCount,
      lastError: this.lastError,
      mode: 'Lokale Solar API V1',
      endpoint: `http://${this.host}`,
    };
  }

  // --- intern ------------------------------------------------------------

  private toReading(powerFlow: unknown, storage: unknown): ConnectorReading {
    const site = pick(dataOf(powerFlow), 'Site');
    const measuredAt = headTimestamp(powerFlow) ?? new Date();

    // Doku: P_Grid "+ from grid, - to grid"
    const grid = splitGridPower(numberOrNull(site?.['P_Grid']), 'positiveIsImport');
    // Doku: P_Load "+ generator, - consumer" — Verbrauch kommt negativ an.
    const consumption = normalizeHouseConsumption(
      numberOrNull(site?.['P_Load']),
      'negativeIsConsumption',
    );
    const solar = numberOrNull(site?.['P_PV']);

    const batteries = this.toBatteries(storage, site, measuredAt);
    this.detectedDevices = batteries.length + (site !== null ? 1 : 0);

    const meter = (deviceId: string, valueW: number | null): PowerMetric => ({
      valueW,
      provenance: provenance(this.id, deviceId, measuredAt),
    });

    return {
      connectorId: this.id,
      timestamp: measuredAt,
      solarProductionW: meter('site', solar),
      houseConsumptionW: meter('site', consumption),
      gridImportW: meter('site', grid.importW),
      gridExportW: meter('site', grid.exportW),
      batteries,
    };
  }

  private toBatteries(
    storage: unknown,
    site: Record<string, unknown> | null,
    measuredAt: Date,
  ): BatterySnapshot[] {
    const data = dataOf(storage);
    if (data === null) return [];

    const batteries: BatterySnapshot[] = [];
    for (const [deviceId, entry] of Object.entries(data)) {
      if (!isRecord(entry)) continue;
      const controller = isRecord(entry['Controller']) ? entry['Controller'] : null;
      if (controller === null) continue;

      const details = isRecord(controller['Details']) ? controller['Details'] : {};
      const soc = numberOrNull(controller['StateOfCharge_Relative']);
      const ratedWh = wattHoursFrom(controller);
      const usableWh = this.capacityOverrides[deviceId] ?? ratedWh;

      // Die Leistung der Fronius-Batterie steht im PowerFlow als P_Akku.
      // Doku: "- charge, + discharge".
      const power = splitBatteryPower(
        numberOrNull(site?.['P_Akku']),
        'positiveIsDischarge',
      );

      batteries.push({
        deviceId: `${this.id}:${deviceId}`,
        displayName:
          this.batteryDisplayName ?? describeBattery(details) ?? 'Fronius Speicher',
        socPercent: soc,
        chargeW: power.chargeW,
        dischargeW: power.dischargeW,
        storedEnergyWh: storedEnergyWh(soc, usableWh),
        usableCapacityWh: usableWh,
        ratedCapacityWh: ratedWh,
        state: power.state,
        provenance: provenance(this.id, `${this.id}:${deviceId}`, measuredAt),
      });
    }
    return batteries;
  }

  private emptyReading(): ConnectorReading {
    const now = new Date();
    const offline: PowerMetric = {
      valueW: null,
      provenance: {
        connectorId: this.id,
        deviceId: 'site',
        measuredAt: this.lastSuccessAt ?? new Date(0),
        ageMs: Number.POSITIVE_INFINITY,
        quality: 'offline',
      },
    };
    return {
      connectorId: this.id,
      timestamp: now,
      solarProductionW: offline,
      houseConsumptionW: offline,
      gridImportW: offline,
      gridExportW: offline,
      batteries: [],
    };
  }

  private async getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`http://${this.host}${path}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} bei ${path}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- Hilfsfunktionen ------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dataOf(response: unknown): Record<string, unknown> | null {
  if (!isRecord(response)) return null;
  const body = response['Body'];
  if (!isRecord(body)) return null;
  const data = body['Data'];
  return isRecord(data) ? data : null;
}

function pick(
  data: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (data === null) return null;
  const value = data[key];
  return isRecord(value) ? value : null;
}

function headTimestamp(response: unknown): Date | null {
  if (!isRecord(response)) return null;
  const head = response['Head'];
  if (!isRecord(head)) return null;
  const raw = head['Timestamp'];
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Fronius meldet die Kapazität je nach Batteriehersteller unterschiedlich.
 * `DesignedCapacity` kommt laut Doku in Wh, ist aber nicht bei allen Modellen
 * vorhanden — dann bleibt der Wert null und muss konfiguriert werden.
 */
function wattHoursFrom(controller: Record<string, unknown>): number | null {
  return (
    numberOrNull(controller['DesignedCapacity']) ??
    numberOrNull(controller['Capacity_Maximum'])
  );
}

function describeBattery(details: Record<string, unknown>): string | null {
  const manufacturer = typeof details['Manufacturer'] === 'string' ? details['Manufacturer'] : null;
  const model = typeof details['Model'] === 'string' ? details['Model'] : null;
  const label = [manufacturer, model].filter(Boolean).join(' ');
  return label === '' ? null : label;
}
