import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { SourceMapping, Tariff } from '@energy/core';

import type { AuthSettings } from './auth.ts';

export interface SourceConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly displayName?: string;
  readonly batteryDisplayName?: string;
  readonly usableCapacityWh?: number | null;
}

/**
 * Ein Gerät, von dem bekannt ist, dass es existiert, das aber (noch) von
 * keiner Datenquelle geliefert wird.
 *
 * Ohne diesen Eintrag würde ein vorhandener Speicher im Dashboard einfach
 * fehlen — der Benutzer könnte das nicht von "gibt es nicht" unterscheiden.
 */
export interface AnnouncedBattery {
  readonly displayName: string;
  readonly expectedCapacityWh: number | null;
  /** Connector-ID, die dieses Gerät künftig liefern soll. */
  readonly expectedSource: string;
  /** Klartext, warum es derzeit fehlt und was zu tun ist. */
  readonly reason: string;
}

/**
 * Wallbox / EV-Ladegerät (Tuya, nur lesend).
 *
 * `accessId`/`accessSecret` gehören NICHT in config.json, sondern in die
 * separate Datei `secrets.json` (siehe `loadConfig`) — so bleiben Zugangsdaten
 * von der übrigen Konfiguration getrennt.
 */
export interface EvChargerConfig {
  readonly enabled: boolean;
  readonly deviceId: string;
  readonly displayName?: string;
  readonly region?: string;
  readonly idleIntervalMs?: number;
  readonly activeIntervalMs?: number;
  /** Aus secrets.json ergänzt, niemals aus config.json gelesen. */
  readonly accessId?: string;
  readonly accessSecret?: string;
}

export interface AppConfig {
  readonly port: number;
  /**
   * Netzwerk-Interface, auf dem der Server lauscht.
   * "127.0.0.1" = nur dieser PC. "0.0.0.0" = auch im Heimnetz erreichbar
   * (nötig, damit das Handy die App öffnen kann).
   */
  readonly host: string;
  readonly pollIntervalMs: number;
  readonly sources: {
    readonly fronius?: SourceConfig;
    readonly froniusGen24?: SourceConfig;
    readonly victron?: SourceConfig;
    readonly evCharger?: EvChargerConfig;
  };
  readonly sourceMapping: SourceMapping;
  readonly announcedBatteries: readonly AnnouncedBattery[];
  readonly tariff: Tariff;
  /**
   * Anmeldedaten aus secrets.json. Fehlen sie, läuft der Server ohne
   * Anmeldung — richtig für den reinen Heimnetzbetrieb, gefährlich, sobald die
   * Adresse über einen Tunnel öffentlich erreichbar ist. Der Server weist beim
   * Start deutlich darauf hin.
   *
   * Angelegt wird das mit `npm run passwort`.
   */
  readonly auth?: AuthSettings;
}

const DEFAULTS = {
  port: 4173,
  host: '0.0.0.0',
  pollIntervalMs: 2000,
};

/** Liest secrets.json, falls vorhanden. Fehlt sie, ist das kein Fehler. */
function loadSecrets(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function loadConfig(path = resolve(process.cwd(), 'config.json')): AppConfig {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`config.json ist ungültig: ${path}`);
  }
  const record = raw as Record<string, unknown>;

  const sources = { ...((record['sources'] ?? {}) as AppConfig['sources']) };
  const mapping = (record['sourceMapping'] ?? {}) as Record<string, unknown>;

  // Zugangsdaten liegen bewusst in einer eigenen Datei neben config.json.
  const secrets = loadSecrets(resolve(path, '..', 'secrets.json'));

  // Fehlt sie, bleibt die Wallbox schlicht "nicht konfiguriert" — kein Fehler.
  if (sources.evCharger?.enabled === true) {
    const tuya = (secrets['tuya'] ?? {}) as Record<string, unknown>;
    sources.evCharger = {
      ...sources.evCharger,
      ...(typeof tuya['accessId'] === 'string' ? { accessId: tuya['accessId'] } : {}),
      ...(typeof tuya['accessSecret'] === 'string'
        ? { accessSecret: tuya['accessSecret'] }
        : {}),
    };
  }

  // solarProductionW darf ein einzelner Connector oder eine Liste sein.
  // Eine Liste bedeutet Summierung verschiedener Wechselrichter (4L).
  const rawSolar = mapping['solarProductionW'];
  const solar = Array.isArray(rawSolar)
    ? rawSolar.map(String)
    : String(rawSolar ?? 'victron-modbus');

  const rawHouse = mapping['houseConsumptionW'];
  const house =
    rawHouse === 'derived' ? 'derived' : String(rawHouse ?? 'victron-modbus');

  const rawTariff = (record['tariff'] ?? {}) as Record<string, unknown>;
  const tariff: Tariff = {
    importPricePerKWh:
      typeof rawTariff['importPricePerKWh'] === 'number' ? rawTariff['importPricePerKWh'] : 0.28,
    exportPricePerKWh:
      typeof rawTariff['exportPricePerKWh'] === 'number' ? rawTariff['exportPricePerKWh'] : 0.08,
    ...(typeof rawTariff['baseFeePerMonth'] === 'number'
      ? { baseFeePerMonth: rawTariff['baseFeePerMonth'] }
      : {}),
  };

  // Anmeldung. Nur vollständige Angaben zählen: Ein halber Eintrag - etwa ein
  // Benutzername ohne Passwort-Hash - darf nicht dazu führen, dass die App sich
  // für geschützt hält, obwohl niemand sich anmelden kann.
  const rohAuth = (secrets['auth'] ?? {}) as Record<string, unknown>;
  const auth: AuthSettings | null =
    typeof rohAuth['username'] === 'string' &&
    typeof rohAuth['passwordHash'] === 'string' &&
    typeof rohAuth['sessionSecret'] === 'string' &&
    rohAuth['username'].length > 0 &&
    rohAuth['passwordHash'].length > 0 &&
    rohAuth['sessionSecret'].length > 0
      ? {
          username: rohAuth['username'],
          passwordHash: rohAuth['passwordHash'],
          sessionSecret: rohAuth['sessionSecret'],
        }
      : null;

  return {
    ...(auth === null ? {} : { auth }),
    port: typeof record['port'] === 'number' ? record['port'] : DEFAULTS.port,
    host: typeof record['host'] === 'string' ? record['host'] : DEFAULTS.host,
    pollIntervalMs:
      typeof record['pollIntervalMs'] === 'number'
        ? record['pollIntervalMs']
        : DEFAULTS.pollIntervalMs,
    sources,
    announcedBatteries: Array.isArray(record['announcedBatteries'])
      ? (record['announcedBatteries'] as AnnouncedBattery[])
      : [],
    sourceMapping: {
      solarProductionW: solar,
      houseConsumptionW: house,
      gridImportW: String(mapping['gridImportW'] ?? 'victron-modbus'),
      gridExportW: String(mapping['gridExportW'] ?? 'victron-modbus'),
    },
    tariff,
  };
}
