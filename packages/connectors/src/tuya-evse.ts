/**
 * Adapter für Tuya-basierte EV-Ladegeräte (Kategorie `qccdz`),
 * konkret geprüft mit dem "Aimiler EV Charger".
 *
 * STRIKT LESEND. Dieser Adapter kennt keinen einzigen Schreibpfad: Er nutzt nur
 * `TuyaCloudClient`, der ausschliesslich GET beherrscht. Die vom Gerät
 * angebotenen Steuerfunktionen (`switch`, `charge_cur_set`, `work_mode`) werden
 * bewusst NICHT verwendet — `charge_cur_set` wird nur *angezeigt*.
 *
 * Die Datenpunkte stammen nicht aus Vermutungen, sondern aus der am 26.08.2026
 * vom Gerät selbst gelieferten Spezifikation:
 *
 *   forward_energy_total  Integer  kW·h  scale 2   -> Wh   = raw * 10
 *   power_total           Integer  kW    scale 3   -> W    = raw
 *   charge_energy_once    Integer  kW·h  scale 2   -> Wh   = raw * 10
 *   temp_current          Integer  °C    scale 0   -> °C   = raw
 *   charge_cur_set        Integer  A     scale 0   -> A    = raw   (6..16)
 *   work_state            Enum     charger_free | charger_insert | charger_wait |
 *                                  charger_charging | charger_pause | charger_end |
 *                                  charger_fault | charger_free_fault
 *   connection_state      Enum     controlpi_12v|9v|6v (+_pwm) | controlpi_error
 *
 * `connection_state` ist die Control-Pilot-Spannung nach IEC 61851:
 *   12 V = kein Fahrzeug, 9 V = Fahrzeug verbunden, 6 V = Fahrzeug lädt.
 * Ein Ladestand (SOC) wird über diesen Kanal grundsätzlich NICHT übertragen —
 * `vehicleSocPercent` bleibt daher immer null und wird niemals geschätzt.
 */

import {
  provenance,
  type ConnectorReading,
  type EvChargerSnapshot,
  type EvChargerState,
} from '@energy/core';

import { TuyaCloudClient, type TuyaStatusEntry } from './tuya-cloud.ts';
import type { ConnectorDiagnostics, EnergyConnector } from './types.ts';

export interface TuyaEvseOptions {
  readonly accessId: string;
  readonly accessSecret: string;
  readonly deviceId: string;
  readonly region?: string;
  readonly connectorId?: string;
  readonly displayName?: string;
  /** Abfrageintervall im Ruhezustand. Schont das Cloud-Kontingent. */
  readonly idleIntervalMs?: number;
  /** Abfrageintervall während eines Ladevorgangs. */
  readonly activeIntervalMs?: number;
}

/** work_state -> vendorneutraler Zustand. */
const WORK_STATE: Record<string, EvChargerState> = {
  charger_free: 'idle',
  charger_insert: 'connected',
  charger_wait: 'waiting',
  charger_charging: 'charging',
  charger_pause: 'paused',
  charger_end: 'finished',
  charger_fault: 'fault',
  charger_free_fault: 'fault',
};

/** Klartext für die Oberfläche, wenn ein Fehlerzustand gemeldet wird. */
const FAULT_TEXT: Record<string, string> = {
  charger_fault: 'Das Ladegerät meldet eine Störung.',
  charger_free_fault: 'Das Ladegerät meldet eine Störung (kein Fahrzeug angeschlossen).',
  controlpi_error: 'Fehler in der Fahrzeug-Kommunikation (Control Pilot).',
};

/**
 * Control-Pilot-Zustand -> Fahrzeug angesteckt?
 * null = Zustand unbekannt/Fehler, bewusst nicht als "nicht verbunden" geraten.
 */
function vehicleConnectedFrom(connectionState: string | null): boolean | null {
  if (connectionState === null) return null;
  if (connectionState.startsWith('controlpi_12v')) return false;
  if (connectionState.startsWith('controlpi_9v')) return true;
  if (connectionState.startsWith('controlpi_6v')) return true;
  return null; // controlpi_error oder unbekannt
}

const ALL_METRICS = ['work_state', 'connection_state', 'power_total'] as const;

/**
 * Übersetzt eine Tuya-Statusliste in den vendorneutralen Zustand.
 *
 * Bewusst als reine Funktion (ohne Netzwerk), damit die Zuordnung der
 * Datenpunkte testbar ist — sie ist der fehleranfälligste Teil der Integration.
 */
export function evSnapshotFromTuyaStatus(
  status: readonly TuyaStatusEntry[],
  meta: { connectorId: string; deviceId: string; displayName: string; measuredAt?: Date },
): EvChargerSnapshot {
  const map = new Map(status.map((entry) => [entry.code, entry.value]));
  const measuredAt = meta.measuredAt ?? new Date();

  const num = (code: string): number | null => {
    const value = map.get(code);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const str = (code: string): string | null => {
    const value = map.get(code);
    return typeof value === 'string' ? value : null;
  };
  const scaled = (code: string, factor: number): number | null => {
    const raw = num(code);
    return raw === null ? null : raw * factor;
  };

  const workState = str('work_state');
  const connectionState = str('connection_state');
  const state: EvChargerState =
    workState !== null ? (WORK_STATE[workState] ?? 'unknown') : 'unknown';

  const fault =
    (workState !== null ? FAULT_TEXT[workState] : undefined) ??
    (connectionState !== null ? FAULT_TEXT[connectionState] : undefined) ??
    null;

  // Die Energie des laufenden Vorgangs ist nur sinnvoll, solange ein Fahrzeug
  // angesteckt ist. Ohne Fahrzeug meldet das Gerät einen Restwert vom letzten
  // Mal — der würde sonst als "aktuelle Sitzung" fehlgedeutet.
  const vehicleConnected = vehicleConnectedFrom(connectionState);
  const sessionActive = vehicleConnected === true;

  return {
    deviceId: `${meta.connectorId}:${meta.deviceId}`,
    displayName: meta.displayName,
    state,
    vehicleConnected,
    chargePowerW: scaled('power_total', 1), // scale 3 (kW) -> W ist der Rohwert
    sessionEnergyWh: sessionActive ? scaled('charge_energy_once', 10) : null,
    totalEnergyWh: scaled('forward_energy_total', 10),
    maxCurrentA: num('charge_cur_set'),
    temperatureC: num('temp_current'),
    // AC-Laden überträgt keinen Ladestand (IEC 61851). Niemals schätzen.
    vehicleSocPercent: null,
    faultText: fault,
    provenance: provenance(
      meta.connectorId,
      `${meta.connectorId}:${meta.deviceId}`,
      measuredAt,
    ),
  };
}

export class TuyaEvseConnector implements EnergyConnector {
  readonly id: string;
  readonly displayName: string;

  private readonly client: TuyaCloudClient;
  private readonly deviceId: string;
  private readonly idleIntervalMs: number;
  private readonly activeIntervalMs: number;

  private lastSuccessAt: Date | null = null;
  private responseTimeMs: number | null = null;
  private errorCount = 0;
  private lastError: string | null = null;
  private missingMetrics: string[] = [];

  /** Zwischenspeicher, damit der 2-s-Poll der Engine die Cloud nicht überrennt. */
  private cached: EvChargerSnapshot | null = null;
  private cachedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(options: TuyaEvseOptions) {
    this.client = new TuyaCloudClient({
      accessId: options.accessId,
      accessSecret: options.accessSecret,
      ...(options.region !== undefined ? { region: options.region } : {}),
    });
    this.deviceId = options.deviceId;
    this.id = options.connectorId ?? 'tuya-evse';
    this.displayName = options.displayName ?? 'Wallbox';
    this.idleIntervalMs = options.idleIntervalMs ?? 30_000;
    this.activeIntervalMs = options.activeIntervalMs ?? 10_000;
  }

  async read(): Promise<ConnectorReading> {
    const interval =
      this.cached?.state === 'charging' ? this.activeIntervalMs : this.idleIntervalMs;

    // Nur abfragen, wenn das Intervall abgelaufen ist. Die erste Abfrage wird
    // abgewartet, spätere laufen im Hintergrund — so bremst die Wallbox nie den
    // 2-Sekunden-Takt der anderen Quellen.
    if (Date.now() - this.cachedAt >= interval && this.inFlight === null) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
      if (this.cached === null) await this.inFlight;
    }

    return {
      connectorId: this.id,
      timestamp: new Date(),
      // Eine Wallbox misst weder PV noch Netz noch Hausverbrauch.
      solarProductionW: null,
      houseConsumptionW: null,
      gridImportW: null,
      gridExportW: null,
      batteries: [],
      evCharger: this.cached ?? this.offlineSnapshot(),
    };
  }

  diagnostics(): ConnectorDiagnostics {
    return {
      connectorId: this.id,
      displayName: this.displayName,
      online: this.lastError === null && this.lastSuccessAt !== null,
      responseTimeMs: this.responseTimeMs,
      lastSuccessAt: this.lastSuccessAt,
      detectedDevices: this.cached === null ? 0 : 1,
      availableMetrics: ALL_METRICS.length - this.missingMetrics.length,
      missingMetrics: this.missingMetrics,
      errorCount: this.errorCount,
      lastError: this.lastError,
      mode: 'Tuya Cloud API (nur lesend)',
      endpoint: `Tuya · ${this.deviceId.slice(0, 6)}…`,
    };
  }

  // --- intern --------------------------------------------------------------

  /**
   * Zwischenspeicher verwerfen, damit die nächste Abfrage wirklich das Gerät
   * erreicht. Wird vom manuellen "Verbinden" genutzt — sonst würde der Knopf
   * nur den zwischengespeicherten Zustand wiederholen.
   */
  invalidateCache(): void {
    this.cachedAt = 0;
  }

  private async refresh(): Promise<void> {
    const startedAt = Date.now();
    try {
      const { online, status } = await this.client.deviceSnapshot(this.deviceId);
      this.responseTimeMs = Date.now() - startedAt;

      // Die Cloud ist erreichbar, das GERÄT aber nicht: dann sind die
      // gelieferten Werte Altbestand und dürfen nicht als aktuell gelten.
      if (online === false) {
        this.lastError = 'Ladegerät ist nicht erreichbar (ausgesteckt?)';
        this.lastSuccessAt = null;
        this.cached = null;
        this.cachedAt = Date.now();
        return;
      }

      this.lastSuccessAt = new Date();
      this.lastError = null;
      this.cached = this.toSnapshot(status);
      this.cachedAt = Date.now();
      this.missingMetrics = ALL_METRICS.filter(
        (key) => !status.some((entry) => entry.code === key),
      );
    } catch (error) {
      this.errorCount++;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.responseTimeMs = null;
      this.cached = null;
      this.cachedAt = Date.now();
    }
  }

  private toSnapshot(status: readonly TuyaStatusEntry[]): EvChargerSnapshot {
    return evSnapshotFromTuyaStatus(status, {
      connectorId: this.id,
      deviceId: this.deviceId,
      displayName: this.displayName,
    });
  }

  /** Zustand, wenn die Quelle (noch) nicht erreichbar ist — keine Nullwerte. */
  private offlineSnapshot(): EvChargerSnapshot {
    return {
      deviceId: `${this.id}:${this.deviceId}`,
      displayName: this.displayName,
      state: 'offline',
      vehicleConnected: null,
      chargePowerW: null,
      sessionEnergyWh: null,
      totalEnergyWh: null,
      maxCurrentA: null,
      temperatureC: null,
      vehicleSocPercent: null,
      faultText: null,
      provenance: {
        connectorId: this.id,
        deviceId: `${this.id}:${this.deviceId}`,
        measuredAt: this.lastSuccessAt ?? new Date(0),
        ageMs: Number.POSITIVE_INFINITY,
        quality: 'offline',
      },
    };
  }
}
