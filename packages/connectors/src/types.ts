import type { ConnectorId, ConnectorReading } from '@energy/core';

/** Ergebnis der Diagnoseansicht (Anforderung 4Y). */
export interface ConnectorDiagnostics {
  readonly connectorId: ConnectorId;
  readonly displayName: string;
  readonly online: boolean;
  /** Antwortzeit der letzten Abfrage in Millisekunden. */
  readonly responseTimeMs: number | null;
  readonly lastSuccessAt: Date | null;
  readonly detectedDevices: number;
  readonly availableMetrics: number;
  readonly missingMetrics: readonly string[];
  readonly errorCount: number;
  readonly lastError: string | null;
  /** Woher die Daten kommen, z. B. "Lokale Solar API" oder "Modbus TCP". */
  readonly mode: string;
  readonly endpoint: string;
}

/** Einheitliche Schnittstelle aller Datenquellen. */
export interface EnergyConnector {
  readonly id: ConnectorId;
  readonly displayName: string;
  read(): Promise<ConnectorReading>;
  diagnostics(): ConnectorDiagnostics;
  /**
   * Optional: eigenen Zwischenspeicher verwerfen, damit die nächste Abfrage
   * das Gerät tatsächlich kontaktiert. Nur nötig für Quellen, die aus
   * Kontingentgründen zwischenspeichern (z. B. Cloud-APIs). Wird beim
   * manuellen Verbinden aufgerufen.
   */
  invalidateCache?(): void;
}
