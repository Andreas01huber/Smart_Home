/**
 * Adapter für das Victron GX-Gerät über Modbus TCP.
 *
 * Alle Registeradressen stammen aus der offiziellen Registerliste
 * `CCGX-Modbus-TCP-register-list.xlsx` (victronenergy/dbus_modbustcp),
 * Dienst `com.victronenergy.system`, Unit-ID 100.
 * Siehe docs/01-datenquellen-verifikation.md. Nichts ist geraten.
 *
 * Zugriff ist ausschliesslich lesend.
 */

import {
  provenance,
  splitBatteryPower,
  splitGridPower,
  storedEnergyWh,
  type BatterySnapshot,
  type ConnectorReading,
  type PowerMetric,
} from '@energy/core';

import {
  readHoldingRegisters,
  VICTRON_SYSTEM_UNIT_ID,
} from './modbus-client.ts';
import type { ConnectorDiagnostics, EnergyConnector } from './types.ts';

/**
 * Ein zusammenhängender Block von Register 884 bis 913. Alle darin enthaltenen
 * Werte sind uint32 bzw. int32 über je zwei Register, jeweils L1/L2/L3.
 */
const FLOW_BLOCK_START = 884;
const FLOW_BLOCK_WORDS = 30;

/** Wort-Offsets innerhalb des Blocks, relativ zu Register 884. */
const FLOW_OFFSETS = {
  pvOnOutput: 0, // 884-889, uint32
  pvOnGrid: 6, // 890-895, uint32
  pvOnGenset: 12, // 896-901, uint32
  acConsumption: 18, // 902-907, uint32
  grid: 24, // 908-913, int32
} as const;

const BATTERY_BLOCK_START = 840; // 840-844
const BATTERY_BLOCK_WORDS = 5;
const PV_DC_REGISTER = 850;

/** Register 844: 0=idle;1=charging;2=discharging. */
const BATTERY_STATE_LABELS: Record<number, string> = {
  0: 'idle',
  1: 'charging',
  2: 'discharging',
};

const ALL_METRICS = [
  'solarProductionW',
  'houseConsumptionW',
  'gridImportW',
  'gridExportW',
] as const;

export interface VictronModbusOptions {
  readonly host: string;
  readonly connectorId?: string;
  readonly displayName?: string;
  readonly timeoutMs?: number;
  readonly batteryDisplayName?: string;
  /**
   * Nutzbare Kapazität des Speichers in Wh.
   *
   * Muss konfiguriert werden: Register 309 (/Capacity) meldet an dieser Anlage
   * 0, das Batteriesystem gibt seine Kapazität also nicht über Modbus preis
   * (Anforderung 4J).
   */
  readonly usableCapacityWh?: number | null;
}

export class VictronModbusConnector implements EnergyConnector {
  readonly id: string;
  readonly displayName: string;

  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly batteryDisplayName: string;
  private readonly usableCapacityWh: number | null;

  private lastSuccessAt: Date | null = null;
  private responseTimeMs: number | null = null;
  private errorCount = 0;
  private lastError: string | null = null;
  private missingMetrics: string[] = [];

  constructor(options: VictronModbusOptions) {
    this.host = options.host;
    this.id = options.connectorId ?? 'victron-modbus';
    this.displayName = options.displayName ?? 'Victron GX (Modbus TCP)';
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.batteryDisplayName = options.batteryDisplayName ?? 'Grosser Speicher';
    this.usableCapacityWh = options.usableCapacityWh ?? null;
  }

  async read(): Promise<ConnectorReading> {
    const startedAt = Date.now();
    try {
      const [flowBlock, batteryBlock, pvDcBlock] = await Promise.all([
        this.read16(FLOW_BLOCK_START, FLOW_BLOCK_WORDS),
        this.read16(BATTERY_BLOCK_START, BATTERY_BLOCK_WORDS),
        this.read16(PV_DC_REGISTER, 1),
      ]);

      this.responseTimeMs = Date.now() - startedAt;
      this.lastSuccessAt = new Date();
      this.lastError = null;

      const reading = this.toReading(flowBlock, batteryBlock, pvDcBlock);
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
      detectedDevices: 1,
      availableMetrics: ALL_METRICS.length - this.missingMetrics.length,
      missingMetrics: this.missingMetrics,
      errorCount: this.errorCount,
      lastError: this.lastError,
      mode: `Modbus TCP, Unit-ID ${VICTRON_SYSTEM_UNIT_ID}`,
      endpoint: `${this.host}:502`,
    };
  }

  // --- intern ------------------------------------------------------------

  private toReading(
    flow: Buffer,
    battery: Buffer,
    pvDc: Buffer,
  ): ConnectorReading {
    const measuredAt = new Date();

    const sumU32 = (offsetWords: number): number =>
      [0, 1, 2].reduce(
        (total, phase) => total + flow.readUInt32BE((offsetWords + phase * 2) * 2),
        0,
      );
    const sumI32 = (offsetWords: number): number =>
      [0, 1, 2].reduce(
        (total, phase) => total + flow.readInt32BE((offsetWords + phase * 2) * 2),
        0,
      );

    // PV gesamt: alle AC-Kopplungspunkte plus DC-gekoppelte Laderegler.
    // Dies schliesst bereits AC-gekoppelte Fremdwechselrichter (Fronius) ein —
    // deshalb darf die Fronius-Quelle nicht zusätzlich addiert werden (4L).
    const solarW =
      sumU32(FLOW_OFFSETS.pvOnOutput) +
      sumU32(FLOW_OFFSETS.pvOnGrid) +
      sumU32(FLOW_OFFSETS.pvOnGenset) +
      pvDc.readUInt16BE(0);

    const houseW = sumU32(FLOW_OFFSETS.acConsumption);

    // Victron-Konvention am Systemdienst: positiv = Bezug aus dem Netz.
    const grid = splitGridPower(sumI32(FLOW_OFFSETS.grid), 'positiveIsImport');

    const metric = (valueW: number | null): PowerMetric => ({
      valueW,
      provenance: provenance(this.id, 'system', measuredAt),
    });

    return {
      connectorId: this.id,
      timestamp: measuredAt,
      solarProductionW: metric(solarW),
      houseConsumptionW: metric(houseW),
      gridImportW: metric(grid.importW),
      gridExportW: metric(grid.exportW),
      batteries: [this.toBattery(battery, measuredAt)],
    };
  }

  private toBattery(block: Buffer, measuredAt: Date): BatterySnapshot {
    const socPercent = block.readUInt16BE(6);
    const rawStateCode = block.readUInt16BE(8);

    // Register 842: positiv = Laden, negativ = Entladen.
    // Damit genau umgekehrt zu Fronius P_Akku — siehe 4O.
    const power = splitBatteryPower(block.readInt16BE(4), 'positiveIsCharge');

    // Der vom Gerät gemeldete Zustand hat Vorrang vor der aus der Leistung
    // abgeleiteten Einschätzung, solange er bekannt ist.
    const reportedState = BATTERY_STATE_LABELS[rawStateCode];
    const state =
      reportedState === 'charging'
        ? 'charging'
        : reportedState === 'discharging'
          ? 'discharging'
          : reportedState === 'idle'
            ? 'idle'
            : power.state;

    return {
      deviceId: `${this.id}:system`,
      displayName: this.batteryDisplayName,
      socPercent,
      chargeW: power.chargeW,
      dischargeW: power.dischargeW,
      storedEnergyWh: storedEnergyWh(socPercent, this.usableCapacityWh),
      usableCapacityWh: this.usableCapacityWh,
      // Register 309 (/Capacity) meldet an dieser Anlage 0 — das Gerät gibt
      // seine Nennkapazität nicht preis.
      ratedCapacityWh: null,
      state,
      provenance: provenance(this.id, `${this.id}:system`, measuredAt),
    };
  }

  private emptyReading(): ConnectorReading {
    const offline: PowerMetric = {
      valueW: null,
      provenance: {
        connectorId: this.id,
        deviceId: 'system',
        measuredAt: this.lastSuccessAt ?? new Date(0),
        ageMs: Number.POSITIVE_INFINITY,
        quality: 'offline',
      },
    };
    return {
      connectorId: this.id,
      timestamp: new Date(),
      solarProductionW: offline,
      houseConsumptionW: offline,
      gridImportW: offline,
      gridExportW: offline,
      batteries: [],
    };
  }

  private read16(address: number, words: number): Promise<Buffer> {
    return readHoldingRegisters(
      this.host,
      VICTRON_SYSTEM_UNIT_ID,
      address,
      words,
      this.timeoutMs,
    );
  }
}
