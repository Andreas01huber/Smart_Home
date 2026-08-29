/**
 * Herstellerunabhängiges Energie-Datenmodell (Anforderung 4N).
 *
 * Leitregel: In diesem Modell ist die Bedeutung eines Wertes NIEMALS durch sein
 * Vorzeichen kodiert. Jede gerichtete Größe hat ein eigenes Feld und ist stets
 * >= 0. Vorzeichenbehaftete Herstellerwerte werden ausschließlich in den
 * Adaptern übersetzt (siehe `normalize.ts`, Anforderung 4O).
 */

/** Kennung eines Connectors, z. B. "fronius-local" oder "victron-vrm". */
export type ConnectorId = string;

/**
 * Datenqualität eines Messwerts (Anforderung 4P).
 *
 * - `live`    Wert ist innerhalb des erwarteten Aktualisierungsintervalls.
 * - `stale`   Wert ist älter als erlaubt. Er darf angezeigt werden, aber nur
 *             mit sichtbarem Hinweis — nicht so, als wäre er aktuell.
 * - `offline` Quelle ist nicht erreichbar.
 * - `unknown` Quelle liefert die Größe grundsätzlich nicht.
 */
export type DataQuality = 'live' | 'stale' | 'offline' | 'unknown';

/** Herkunft und Vertrauenswürdigkeit eines einzelnen Messwerts (4P). */
export interface Provenance {
  /** Welcher Connector den Wert geliefert hat. */
  readonly connectorId: ConnectorId;
  /** Stabile Geräte-ID innerhalb des Connectors. */
  readonly deviceId: string;
  /** Zeitpunkt der Messung laut Quelle — nicht der Empfangszeitpunkt. */
  readonly measuredAt: Date;
  /** Alter zum Auswertungszeitpunkt in Millisekunden. */
  readonly ageMs: number;
  readonly quality: DataQuality;
}

/**
 * Ein Leistungsmesswert in Watt, immer >= 0, plus Herkunft.
 *
 * `valueW === null` bedeutet ausdrücklich "die Quelle liefert diesen Wert
 * nicht" und ist etwas anderes als 0 W.
 */
export interface PowerMetric {
  readonly valueW: number | null;
  readonly provenance: Provenance;
}

/** Energiemenge in Wattstunden, immer >= 0, plus Herkunft. */
export interface EnergyMetric {
  readonly valueWh: number | null;
  readonly provenance: Provenance;
}

/** Betriebszustand eines Speichers. */
export type BatteryState =
  | 'charging'
  | 'discharging'
  | 'idle'
  | 'offline'
  | 'unknown';

/**
 * Zustand eines Batteriespeichers.
 *
 * Laden und Entladen sind bewusst zwei getrennte, nicht-negative Felder.
 * Zu jedem Zeitpunkt ist höchstens eines davon > 0.
 */
export interface BatterySnapshot {
  readonly deviceId: string;
  /** Anzeigename, z. B. "Kleiner Speicher" oder "Großer Speicher". */
  readonly displayName: string;
  readonly socPercent: number | null;
  readonly chargeW: number | null;
  readonly dischargeW: number | null;
  readonly storedEnergyWh: number | null;
  /**
   * Nutzbare Kapazität. Konfigurierbar (Anforderung 4J), weil der vom
   * Hersteller gemeldete Wert die Bruttokapazität sein kann.
   */
  readonly usableCapacityWh: number | null;
  /** Vom Gerät gemeldete Nennkapazität, falls verfügbar. */
  readonly ratedCapacityWh: number | null;
  readonly state: BatteryState;
  readonly provenance: Provenance;
}

/**
 * Betriebszustand einer Wallbox / eines Ladegeräts.
 *
 * Bewusst getrennt von `vehicleConnected`: Ein Fahrzeug kann angesteckt sein,
 * ohne zu laden (`connected`), und der Charger kann bereit sein, ohne dass ein
 * Fahrzeug hängt (`idle`).
 */
export type EvChargerState =
  | 'idle' // betriebsbereit, kein Fahrzeug
  | 'connected' // Fahrzeug angesteckt, lädt nicht
  | 'waiting' // Fahrzeug angesteckt, wartet (Timer/Freigabe)
  | 'charging'
  | 'paused'
  | 'finished'
  | 'fault'
  | 'offline'
  | 'unknown';

/**
 * Zustand eines EV-Ladegeräts.
 *
 * Wichtig zur Vermeidung von Doppelzählung (4L): `chargePowerW` ist KEINE
 * zusätzliche Last. Die Wallbox hängt hinter dem Hauszähler, ihre Leistung ist
 * im Hausverbrauch bereits enthalten und wird hier nur separat ausgewiesen.
 *
 * `vehicleSocPercent` ist bei AC-Ladegeräten nach IEC 61851 grundsätzlich
 * `null`: Über das Control-Pilot-Signal werden nur Zustände (kein Fahrzeug /
 * verbunden / lädt) übertragen, niemals der Ladestand. Ein SOC-Wert darf
 * ausschliesslich aus dem Fahrzeug selbst stammen — nie geschätzt werden.
 */
export interface EvChargerSnapshot {
  readonly deviceId: string;
  readonly displayName: string;
  readonly state: EvChargerState;
  /** null = Charger meldet den Anschlusszustand nicht. */
  readonly vehicleConnected: boolean | null;
  readonly chargePowerW: number | null;
  /** Energie des laufenden Ladevorgangs. */
  readonly sessionEnergyWh: number | null;
  /** Zählerstand über die gesamte Lebensdauer. */
  readonly totalEnergyWh: number | null;
  /** Eingestellte Strombegrenzung (nur Anzeige — wird nie geschrieben). */
  readonly maxCurrentA: number | null;
  readonly temperatureC: number | null;
  /** Nur befüllbar, wenn eine Fahrzeugquelle existiert. Sonst null. */
  readonly vehicleSocPercent: number | null;
  /** Klartext-Fehler, sonst null. */
  readonly faultText: string | null;
  readonly provenance: Provenance;
}

/**
 * Vollständige, quellenübergreifend aufgelöste Momentaufnahme des
 * Energiesystems. Genau das, was das Dashboard rendert.
 *
 * Alle Leistungen sind >= 0. `gridImportW` und `gridExportW` sind nie
 * gleichzeitig > 0; dasselbe gilt für Laden und Entladen je Batterie.
 */
export interface EnergySnapshot {
  readonly timestamp: Date;
  readonly solarProductionW: PowerMetric;
  readonly houseConsumptionW: PowerMetric;
  readonly gridImportW: PowerMetric;
  readonly gridExportW: PowerMetric;
  readonly batteries: readonly BatterySnapshot[];
  /** null = keine Wallbox konfiguriert. */
  readonly evCharger: EvChargerSnapshot | null;
}

/**
 * Rohe, noch nicht quellenübergreifend aufgelöste Messung eines einzelnen
 * Connectors. Mehrere davon gehen in die Source-of-Truth-Auflösung ein
 * (Anforderung 4L).
 */
export interface ConnectorReading {
  readonly connectorId: ConnectorId;
  readonly timestamp: Date;
  readonly solarProductionW: PowerMetric | null;
  readonly houseConsumptionW: PowerMetric | null;
  readonly gridImportW: PowerMetric | null;
  readonly gridExportW: PowerMetric | null;
  readonly batteries: readonly BatterySnapshot[];
  /**
   * Wallbox/Ladegerät, falls dieser Connector eines liefert. Fehlt bei allen
   * reinen Energiequellen (Fronius, Victron) — daher optional.
   */
  readonly evCharger?: EvChargerSnapshot | null;
}

/** Die Messgrößen, für die eine maßgebliche Quelle festgelegt werden muss. */
export const RESOLVED_METRIC_KEYS = [
  'solarProductionW',
  'houseConsumptionW',
  'gridImportW',
  'gridExportW',
] as const;

export type ResolvedMetricKey = (typeof RESOLVED_METRIC_KEYS)[number];
