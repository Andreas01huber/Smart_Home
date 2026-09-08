import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Ladeanschluss, SourceMapping, Tariff } from '@energy/core';

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
  /**
   * Wie das Fahrzeug angeschlossen ist — für die Umrechnung von Ampere in
   * Kilowatt. Die Wallbox meldet nur die eingestellte Strombegrenzung; was das
   * an Leistung bedeutet, hängt am Anschluss und steht in keinem Datenpunkt.
   *
   * Standard ist dreiphasig an 400 V (16 A = 11 kW). Einphasig wären dieselben
   * 16 A nur 3,7 kW — wer das falsch einträgt, liest überall die falsche Zahl.
   */
  readonly phases?: 1 | 3;
  readonly voltageV?: number;
  /** Aus secrets.json ergänzt, niemals aus config.json gelesen. */
  readonly accessId?: string;
  readonly accessSecret?: string;
}

/**
 * Überschussladen — alle Stellschrauben an einer Stelle.
 *
 * Bewusst vollständig in config.json und nicht über den Code verteilt: Wer die
 * Regelung im Betrieb beruhigen oder schärfer stellen will, soll genau eine
 * Datei anfassen müssen.
 *
 * Mindest- und Höchstladestrom stehen hier NICHT. Die liest der Adapter vom
 * Gerät selbst (`charge_cur_set` meldet min/max/step) — ein zweiter Satz Zahlen
 * in der Konfiguration wäre eine Quelle für Widersprüche mit der Hardware.
 */
export interface UeberschussConfig {
  /**
   * `aus`         — Regelung schläft.
   * `beobachten`  — rechnet und zeigt alles, sendet aber keinen Befehl.
   * `regeln`      — stellt den Ladestrom tatsächlich.
   */
  readonly modus: 'aus' | 'beobachten' | 'regeln';
  readonly intervallSekunden: number;
  /** Sicherheitsabstand zum Netzbezug. */
  readonly reserveW: number;
  /** Totzone auf der Einspeiseseite, innerhalb derer nicht nachgeregelt wird. */
  readonly netzTotzoneW: number;
  /**
   * Totzone auf der Bezugsseite — bewusst viel kleiner.
   *
   * Einspeisen darf ruhig ein bisschen daneben liegen, beziehen nicht: Eine
   * symmetrische Totzone hielt im Tagesdurchlauf 150 W Netzbezug minutenlang
   * aus, weil die Wallbox nur ganze Ampere kennt und der Rest darunter blieb.
   */
  readonly netzImportTotzoneW: number;
  /** Ab diesem Netzbezug wird sofort gesenkt, ohne Fristen. */
  readonly notbremseAbW: number;
  readonly maxMessalterSekunden: number;
  readonly mindestabstandSekunden: number;
  readonly erhoehenNachSekunden: number;
  readonly senkenNachSekunden: number;
  /** Verkuerzte Frist fuers Senken, wenn Strom aus dem Netz kommt. */
  readonly senkenBeiBezugSekunden: number;
  readonly pausierenNachSekunden: number;
  readonly startenNachSekunden: number;
  readonly speicherEntladenErlaubt: boolean;
  readonly speicher: Readonly<Record<string, Speichergrenzwerte>>;
  readonly speicherStandard: Speichergrenzwerte;
}

/**
 * Was ein einzelner Speicher für das Auto tun darf.
 *
 * Identisch zu `SpeicherGrenzen` aus `@energy/core` — hier eigens benannt, weil
 * die Konfiguration ihre Form selbst beschreiben soll und nicht erst über einen
 * Import verständlich werden darf.
 */
export interface Speichergrenzwerte {
  readonly minSocPercent: number;
  readonly entladenMaxW: number;
  readonly autoVorrangAbSocPercent: number;
}

/**
 * Ab wann das Auto Vorrang bekommt, wenn nichts anderes konfiguriert ist.
 *
 * 80 % ist bewusst hoch. Darunter ist der Speicher für das Haus wertvoller als
 * für das Auto: Was abends fehlt, kommt aus dem Netz. Ab 80 % kehrt sich das
 * um, weil die restlichen Prozent bei Sonne ohnehin wieder zusammenkommen.
 */
const AUTO_VORRANG_STANDARD_SOC = 80;

const UEBERSCHUSS_STANDARD: UeberschussConfig = {
  // Vorsicht als Vorgabe: Wer die Wallbox zum ersten Mal stellen lässt, will
  // erst sehen, was die Regelung tun WÜRDE. Auf "regeln" stellt man selbst.
  modus: 'beobachten',
  // 30 s ist der Kompromiss: Die Wallbox wird ohnehin nur alle 10 s (ladend)
  // abgefragt, das Fahrzeug folgt einem neuen Sollwert erst nach einigen
  // Sekunden, und die Tuya-Cloud hat ein Tageskontingent. Schneller brächte
  // keine bessere Regelung, nur mehr Anfragen.
  intervallSekunden: 30,
  reserveW: 200,
  netzTotzoneW: 150,
  netzImportTotzoneW: 40,
  notbremseAbW: 300,
  maxMessalterSekunden: 30,
  mindestabstandSekunden: 60,
  erhoehenNachSekunden: 90,
  senkenNachSekunden: 20,
  senkenBeiBezugSekunden: 4,
  pausierenNachSekunden: 30,
  startenNachSekunden: 120,
  speicherEntladenErlaubt: true,
  speicher: {},
  speicherStandard: {
    minSocPercent: 50,
    entladenMaxW: 0,
    autoVorrangAbSocPercent: AUTO_VORRANG_STANDARD_SOC,
  },
};

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
   * Wo die Zugangsdaten liegen — immer neben config.json.
   *
   * Die Konten selbst werden hier nicht gelesen, sondern von `Kontenspeicher`:
   * Die Datei wird auch geschrieben, sobald jemand in der Verwaltung ein Konto
   * anlegt, und eine Kopie im Konfigurationsobjekt wäre danach veraltet.
   */
  readonly secretsPfad: string;
  /** Regelung des Ladestroms nach Überschuss. */
  readonly ueberschuss: UeberschussConfig;
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
  const secretsPfad = resolve(path, '..', 'secrets.json');
  const secrets = loadSecrets(secretsPfad);

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

  const ueberschuss = leseUeberschuss(record['ueberschussladen']);

  return {
    secretsPfad,
    ueberschuss,
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

/**
 * Der Ladeanschluss aus der Konfiguration, mit sinnvollem Standard.
 *
 * Wird erst hier geprüft und nicht beim Einlesen: `sources` kommt als Ganzes
 * aus der JSON-Datei, und ein einzelner Tippfehler soll nicht den Start des
 * Servers verhindern, sondern still auf den Normalfall zurückfallen —
 * dreiphasig an 400 V, wie jede 11-kW-Wallbox.
 */
export function ladeanschlussAus(config: AppConfig): Ladeanschluss {
  const ev = config.sources.evCharger;
  const phasen: 1 | 3 = ev?.phases === 1 ? 1 : 3;
  const vorgabe = phasen === 3 ? 400 : 230;
  const spannungV =
    typeof ev?.voltageV === 'number' && Number.isFinite(ev.voltageV) && ev.voltageV > 0
      ? ev.voltageV
      : vorgabe;
  return { phasen, spannungV };
}

/**
 * Liest den Abschnitt `ueberschussladen`, Feld für Feld gegen den Standard.
 *
 * Absichtlich nachsichtig: Ein Tippfehler in einer einzelnen Zahl darf nicht
 * den ganzen Server am Start hindern — er fällt auf den Vorgabewert zurück.
 * Der Modus ist die Ausnahme, die keine ist: Steht dort etwas Unbekanntes, wird
 * NICHT geregelt. Ein unklarer Wert darf nie dazu führen, dass die Anlage
 * plötzlich Befehle an die Wallbox schickt.
 */
function leseUeberschuss(roh: unknown): UeberschussConfig {
  if (typeof roh !== 'object' || roh === null) return UEBERSCHUSS_STANDARD;
  const r = roh as Record<string, unknown>;

  const zahl = (schluessel: string, vorgabe: number): number => {
    const wert = r[schluessel];
    return typeof wert === 'number' && Number.isFinite(wert) && wert >= 0 ? wert : vorgabe;
  };

  const modus =
    r['modus'] === 'regeln' ? 'regeln' : r['modus'] === 'aus' ? 'aus' : 'beobachten';

  const speicher: Record<string, Speichergrenzwerte> = {};
  const rohSpeicher = r['speicher'];
  if (typeof rohSpeicher === 'object' && rohSpeicher !== null) {
    for (const [id, wert] of Object.entries(rohSpeicher as Record<string, unknown>)) {
      if (typeof wert !== 'object' || wert === null) continue;
      const w = wert as Record<string, unknown>;
      speicher[id] = {
        minSocPercent:
          typeof w['minSocPercent'] === 'number' ? w['minSocPercent'] : 50,
        entladenMaxW: typeof w['entladenMaxW'] === 'number' ? w['entladenMaxW'] : 0,
        autoVorrangAbSocPercent:
          typeof w['autoVorrangAbSocPercent'] === 'number'
            ? w['autoVorrangAbSocPercent']
            : AUTO_VORRANG_STANDARD_SOC,
      };
    }
  }

  const rohStandard = r['speicherStandard'];
  const standard =
    typeof rohStandard === 'object' && rohStandard !== null
      ? {
          minSocPercent:
            typeof (rohStandard as Record<string, unknown>)['minSocPercent'] === 'number'
              ? ((rohStandard as Record<string, unknown>)['minSocPercent'] as number)
              : UEBERSCHUSS_STANDARD.speicherStandard.minSocPercent,
          entladenMaxW:
            typeof (rohStandard as Record<string, unknown>)['entladenMaxW'] === 'number'
              ? ((rohStandard as Record<string, unknown>)['entladenMaxW'] as number)
              : UEBERSCHUSS_STANDARD.speicherStandard.entladenMaxW,
          autoVorrangAbSocPercent:
            typeof (rohStandard as Record<string, unknown>)['autoVorrangAbSocPercent']
            === 'number'
              ? ((rohStandard as Record<string, unknown>)[
                  'autoVorrangAbSocPercent'
                ] as number)
              : UEBERSCHUSS_STANDARD.speicherStandard.autoVorrangAbSocPercent,
        }
      : UEBERSCHUSS_STANDARD.speicherStandard;

  return {
    modus,
    // Unter 10 s wird nicht geregelt: Das Fahrzeug folgt einem neuen Sollwert
    // ohnehin langsamer, und die Cloud dankt es nicht.
    intervallSekunden: Math.max(10, zahl('intervallSekunden', UEBERSCHUSS_STANDARD.intervallSekunden)),
    reserveW: zahl('reserveW', UEBERSCHUSS_STANDARD.reserveW),
    netzTotzoneW: zahl('netzTotzoneW', UEBERSCHUSS_STANDARD.netzTotzoneW),
    netzImportTotzoneW: zahl('netzImportTotzoneW', UEBERSCHUSS_STANDARD.netzImportTotzoneW),
    notbremseAbW: zahl('notbremseAbW', UEBERSCHUSS_STANDARD.notbremseAbW),
    maxMessalterSekunden: zahl('maxMessalterSekunden', UEBERSCHUSS_STANDARD.maxMessalterSekunden),
    mindestabstandSekunden: zahl('mindestabstandSekunden', UEBERSCHUSS_STANDARD.mindestabstandSekunden),
    erhoehenNachSekunden: zahl('erhoehenNachSekunden', UEBERSCHUSS_STANDARD.erhoehenNachSekunden),
    senkenNachSekunden: zahl('senkenNachSekunden', UEBERSCHUSS_STANDARD.senkenNachSekunden),
    senkenBeiBezugSekunden: zahl(
      'senkenBeiBezugSekunden',
      UEBERSCHUSS_STANDARD.senkenBeiBezugSekunden,
    ),
    pausierenNachSekunden: zahl('pausierenNachSekunden', UEBERSCHUSS_STANDARD.pausierenNachSekunden),
    startenNachSekunden: zahl('startenNachSekunden', UEBERSCHUSS_STANDARD.startenNachSekunden),
    speicherEntladenErlaubt: r['speicherEntladenErlaubt'] !== false,
    speicher,
    speicherStandard: standard,
  };
}
