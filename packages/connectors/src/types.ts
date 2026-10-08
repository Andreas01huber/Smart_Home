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

/** Vom Gerät gemeldete Grenzen des Ladestroms. */
export interface Ladestromgrenzen {
  readonly minA: number;
  readonly maxA: number;
  readonly schrittA: number;
}

/**
 * Ein Ladegerät, dessen Ladestrom und Hauptschalter gestellt werden können.
 *
 * Die Regelung kennt nur diese Schnittstelle — nicht den Hersteller. Damit ist
 * eine lokal angebundene Wallbox (Modbus, OCPP) später ein weiterer Adapter und
 * kein Umbau des Reglers; und im Test steht hier eine Attrappe.
 *
 * Verträge:
 *  - `setzeLadestrom` begrenzt den Wert selbst auf die Gerätegrenzen und gibt
 *    zurück, was tatsächlich gesendet wurde.
 *  - `setzeLaden(false)` ist die Pause. Pausieren heisst abschalten, nicht
 *    "auf den Mindeststrom" — der sind gut 4 kW, die ohne Sonne aus dem Netz kämen.
 *  - Beide werfen bei Fehlern; der Aufrufer entscheidet über Wiederholung.
 */
export interface SteuerbaresLadegeraet {
  ladestromGrenzen(): Promise<Ladestromgrenzen | null>;
  /** Alle vom Gerät angebotenen Steuerfunktionen — für die Diagnose. */
  steuerfunktionen(): Promise<readonly { code: string; type: string; values: string }[]>;
  setzeLadestrom(ampere: number): Promise<number>;
  setzeLaden(an: boolean): Promise<void>;
}

/** Erkennt zur Laufzeit, ob ein Connector auch stellen kann. */
export function istSteuerbar(c: unknown): c is SteuerbaresLadegeraet {
  if (typeof c !== 'object' || c === null) return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o['setzeLadestrom'] === 'function'
    && typeof o['setzeLaden'] === 'function'
    && typeof o['ladestromGrenzen'] === 'function'
    && typeof o['steuerfunktionen'] === 'function'
  );
}
