import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Ladeanschluss, SourceMapping, Tariff } from '@energy/core';

/**
 * Ein Speicher, den eine Quelle liefern soll.
 *
 * Steht hier, damit die Engine weiss, dass ein Speicher ERWARTET wird — fehlt
 * er dann in der Messung, ist das eine Lücke und kein "gibt es nicht".
 */
export interface SpeicherAngabe {
  readonly displayName: string;
  /** Nutzbare Kapazität; `null`, wenn das Gerät sie selbst meldet. */
  readonly usableCapacityWh: number | null;
}

/**
 * Datenquellen als Liste typisierter Beschreibungen.
 *
 * Die Konfiguration beschreibt die Geräte, der Code kennt nur Typen. Ein
 * weiterer Wechselrichter oder ein zweiter Speicher ist damit ein Eintrag in
 * `config.json` und keine Änderung an Engine, Serialisierung oder
 * Qualitätsregeln.
 */
export type Quellentyp = 'fronius-solar-api' | 'victron-modbus' | 'tuya-evse';

interface QuelleBasis {
  /** Connector-ID, z. B. `fronius-gen24`. Eindeutig je Konfiguration. */
  readonly id: string;
  readonly displayName: string;
}

export interface FroniusQuelle extends QuelleBasis {
  readonly typ: 'fronius-solar-api';
  readonly host: string;
  readonly speicher: SpeicherAngabe | null;
}

export interface VictronQuelle extends QuelleBasis {
  readonly typ: 'victron-modbus';
  readonly host: string;
  readonly speicher: SpeicherAngabe | null;
}

/**
 * Wallbox über die Tuya-Cloud.
 *
 * `accessId`/`accessSecret` gehören NICHT in config.json, sondern in die
 * separate Datei `secrets.json` (siehe `loadConfig`).
 */
export interface TuyaEvseQuelle extends QuelleBasis {
  readonly typ: 'tuya-evse';
  readonly deviceId: string;
  readonly region: string;
  readonly idleIntervalMs?: number;
  readonly activeIntervalMs?: number;
  /**
   * Wie das Fahrzeug angeschlossen ist — Startwert für die Umrechnung von
   * Ampere in Kilowatt, bis die Messung die Dose selbst erkennt.
   */
  readonly phases: 1 | 3;
  readonly voltageV: number | null;
  /** Aus secrets.json ergänzt, niemals aus config.json gelesen. */
  readonly accessId: string | null;
  readonly accessSecret: string | null;
}

export type Quelle = FroniusQuelle | VictronQuelle | TuyaEvseQuelle;

/**
 * Ein Gerät, von dem bekannt ist, dass es existiert, das aber (noch) von
 * keiner Datenquelle geliefert wird.
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
 * Überschussladen — alle Stellschrauben an einer Stelle.
 *
 * Mindest- und Höchstladestrom stehen hier NICHT. Die liest der Adapter vom
 * Gerät selbst (`charge_cur_set` meldet min/max/step).
 */
export interface UeberschussConfig {
  /**
   * `aus`         — Regelung schläft.
   * `beobachten`  — rechnet und zeigt alles, sendet aber keinen Befehl.
   * `regeln`      — stellt den Ladestrom tatsächlich.
   */
  readonly modus: 'aus' | 'beobachten' | 'regeln';
  readonly intervallSekunden: number;
  readonly reserveW: number;
  readonly netzTotzoneW: number;
  readonly netzImportTotzoneW: number;
  readonly notbremseAbW: number;
  readonly maxMessalterSekunden: number;
  readonly mindestabstandSekunden: number;
  readonly erhoehenNachSekunden: number;
  readonly senkenNachSekunden: number;
  readonly senkenBeiBezugSekunden: number;
  readonly pausierenNachSekunden: number;
  readonly startenNachSekunden: number;
  readonly haushaltMaxA: number;
  readonly speicherEntladenErlaubt: boolean;
  readonly speicher: Readonly<Record<string, Speichergrenzwerte>>;
  readonly speicherStandard: Speichergrenzwerte;
}

/** Was ein einzelner Speicher für das Auto tun darf. */
export interface Speichergrenzwerte {
  readonly minSocPercent: number;
  readonly entladenMaxW: number;
  readonly autoVorrangAbSocPercent: number;
}

const AUTO_VORRANG_STANDARD_SOC = 80;

const UEBERSCHUSS_STANDARD: UeberschussConfig = {
  modus: 'beobachten',
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
  haushaltMaxA: 10,
  speicherEntladenErlaubt: true,
  speicher: {},
  speicherStandard: {
    minSocPercent: 50,
    entladenMaxW: 0,
    autoVorrangAbSocPercent: AUTO_VORRANG_STANDARD_SOC,
  },
};

export interface AppConfig {
  /** Bewusster Betrieb ohne Anmeldung; standardmäßig nicht erlaubt. */
  readonly allowUnauthenticatedAccess?: boolean;
  readonly trustedProxies: readonly string[];
  readonly port: number;
  readonly host: string;
  readonly pollIntervalMs: number;
  /** Alle aktivierten Datenquellen. */
  readonly quellen: readonly Quelle[];
  readonly sourceMapping: SourceMapping;
  readonly announcedBatteries: readonly AnnouncedBattery[];
  readonly tariff: Tariff;
  readonly secretsPfad: string;
  readonly kontenPfad: string;
  readonly ueberschuss: UeberschussConfig;
}

const DEFAULTS = {
  port: 4173,
  host: '0.0.0.0',
  pollIntervalMs: 2000,
};

// ── Ableitungen aus der Konfiguration ───────────────────────────────────────

/** Anzeigename je Connector-ID. */
export function quellenNamen(config: AppConfig): Readonly<Record<string, string>> {
  return Object.fromEntries(config.quellen.map((q) => [q.id, q.displayName]));
}

/** Connector-IDs, die laut Konfiguration einen Speicher liefern sollen. */
export function speicherquellen(config: AppConfig): readonly string[] {
  return config.quellen
    .filter((q): q is FroniusQuelle | VictronQuelle => q.typ !== 'tuya-evse' && q.speicher !== null)
    .map((q) => q.id);
}

/** Die konfigurierte Wallbox, falls vorhanden. */
export function wallboxQuelle(config: AppConfig): TuyaEvseQuelle | null {
  return config.quellen.find((q): q is TuyaEvseQuelle => q.typ === 'tuya-evse') ?? null;
}

/** Eine Quelle mit Netzwerkadresse (Fronius/Victron) nach ihrer ID — für Werkzeuge. */
export function geraetMitId(config: AppConfig, id: string): FroniusQuelle | VictronQuelle | null {
  return config.quellen.find((q): q is FroniusQuelle | VictronQuelle => q.id === id && q.typ !== 'tuya-evse') ?? null;
}

/** Der Ladeanschluss aus der Konfiguration, mit sinnvollem Standard. */
export function ladeanschlussAus(config: AppConfig): Ladeanschluss {
  const ev = wallboxQuelle(config);
  const phasen: 1 | 3 = ev?.phases === 1 ? 1 : 3;
  const vorgabe = phasen === 3 ? 400 : 230;
  const spannungV = ev?.voltageV !== null && ev?.voltageV !== undefined && ev.voltageV > 0 ? ev.voltageV : vorgabe;
  return { phasen, spannungV };
}

// ── Lesen und Prüfen ────────────────────────────────────────────────────────

/** Liest secrets.json, falls vorhanden. Fehlt sie, ist das kein Fehler. */
function loadSecrets(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return istObjekt(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class KonfigurationsFehler extends Error {
  constructor(readonly probleme: readonly string[], pfad: string) {
    super(
      `config.json (${pfad}) ist ungültig:\n` + probleme.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'KonfigurationsFehler';
  }
}

/**
 * Sammelt Fehler, statt beim ersten aufzuhören — wer die Datei korrigiert, soll
 * alle Stellen auf einmal sehen.
 */
class Pruefung {
  readonly probleme: string[] = [];
  readonly warnungen: string[] = [];

  fehler(pfad: string, text: string): void {
    this.probleme.push(`${pfad}: ${text}`);
  }

  warnung(pfad: string, text: string): void {
    this.warnungen.push(`${pfad}: ${text}`);
  }

  /** Meldet Schlüssel, die niemand kennt — Tippfehler fallen so sofort auf. */
  nurBekannte(pfad: string, obj: Record<string, unknown>, bekannt: readonly string[]): void {
    for (const k of Object.keys(obj)) {
      if (k.startsWith('_')) continue;
      if (!bekannt.includes(k)) this.fehler(`${pfad}.${k}`, 'unbekannter Schlüssel (Tippfehler?)');
    }
  }

  string(pfad: string, wert: unknown, pflicht: boolean): string | null {
    if (wert === undefined || wert === null) {
      if (pflicht) this.fehler(pfad, 'fehlt');
      return null;
    }
    if (typeof wert !== 'string' || wert.trim() === '') {
      this.fehler(pfad, 'muss eine nicht-leere Zeichenkette sein');
      return null;
    }
    return wert;
  }

  zahl(pfad: string, wert: unknown, opt: { min?: number; max?: number; ganz?: boolean } = {}): number | null {
    if (wert === undefined || wert === null) return null;
    if (typeof wert !== 'number' || !Number.isFinite(wert)) {
      this.fehler(pfad, 'muss eine Zahl sein');
      return null;
    }
    if (opt.ganz && !Number.isInteger(wert)) {
      this.fehler(pfad, 'muss eine ganze Zahl sein');
      return null;
    }
    if (opt.min !== undefined && wert < opt.min) {
      this.fehler(pfad, `muss mindestens ${opt.min} sein`);
      return null;
    }
    if (opt.max !== undefined && wert > opt.max) {
      this.fehler(pfad, `darf höchstens ${opt.max} sein`);
      return null;
    }
    return wert;
  }

  bool(pfad: string, wert: unknown): boolean | null {
    if (wert === undefined || wert === null) return null;
    if (typeof wert !== 'boolean') {
      this.fehler(pfad, 'muss true oder false sein');
      return null;
    }
    return wert;
  }
}

function istObjekt(wert: unknown): wert is Record<string, unknown> {
  return typeof wert === 'object' && wert !== null && !Array.isArray(wert);
}

export function loadConfig(path = resolve(process.cwd(), 'config.json')): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new KonfigurationsFehler(
      [`Datei nicht lesbar oder kein gültiges JSON (${error instanceof Error ? error.message : error})`],
      path,
    );
  }
  if (!istObjekt(raw)) throw new KonfigurationsFehler(['Wurzel muss ein Objekt sein'], path);
  const p = new Pruefung();
  const r = raw;

  p.nurBekannte('', r, [
    'port', 'host', 'pollIntervalMs', 'allowUnauthenticatedAccess', 'trustedProxies',
    'sources', 'sourceMapping', 'announcedBatteries', 'tariff', 'ueberschussladen',
  ]);

  const port = p.zahl('port', r['port'], { min: 0, max: 65535, ganz: true }) ?? DEFAULTS.port;
  const host = p.string('host', r['host'], false) ?? DEFAULTS.host;
  const pollIntervalMs = p.zahl('pollIntervalMs', r['pollIntervalMs'], { min: 500 }) ?? DEFAULTS.pollIntervalMs;

  const trustedProxies: string[] = [];
  if (r['trustedProxies'] !== undefined) {
    if (!Array.isArray(r['trustedProxies'])) p.fehler('trustedProxies', 'muss eine Liste von Adressen sein');
    else {
      r['trustedProxies'].forEach((x, i) => {
        const s = p.string(`trustedProxies[${i}]`, x, true);
        if (s !== null) trustedProxies.push(s);
      });
    }
  } else {
    trustedProxies.push('127.0.0.1', '::1');
  }

  // Zugangsdaten liegen bewusst in einer eigenen Datei neben config.json.
  const secretsPfad = resolve(path, '..', 'secrets.json');
  const secrets = loadSecrets(secretsPfad);
  const tuya = istObjekt(secrets['tuya']) ? secrets['tuya'] : {};
  const zugang = {
    accessId: typeof tuya['accessId'] === 'string' ? tuya['accessId'] : null,
    accessSecret: typeof tuya['accessSecret'] === 'string' ? tuya['accessSecret'] : null,
  };

  const quellen = leseQuellen(p, r['sources'], zugang);
  const ids = new Set(quellen.map((q) => q.id));

  // ── Quellenzuordnung ─────────────────────────────────────────────────────
  const mapping = istObjekt(r['sourceMapping']) ? r['sourceMapping'] : {};
  if (r['sourceMapping'] !== undefined && !istObjekt(r['sourceMapping'])) {
    p.fehler('sourceMapping', 'muss ein Objekt sein');
  }
  p.nurBekannte('sourceMapping', mapping, ['solarProductionW', 'gridImportW', 'gridExportW', 'houseConsumptionW']);
  const pruefeId = (pfad: string, id: string): void => {
    // Nur Warnung: Im Test- und Fixture-Betrieb werden Quellen von aussen
    // eingereicht und stehen nicht in der Datei.
    if (!ids.has(id)) p.warnung(pfad, `verweist auf unbekannte Quelle "${id}"`);
  };
  const rawSolar = mapping['solarProductionW'];
  let solar: string | string[];
  if (Array.isArray(rawSolar)) {
    solar = [];
    rawSolar.forEach((x, i) => {
      const s = p.string(`sourceMapping.solarProductionW[${i}]`, x, true);
      if (s !== null) { (solar as string[]).push(s); pruefeId(`sourceMapping.solarProductionW[${i}]`, s); }
    });
    if (solar.length === 0) p.fehler('sourceMapping.solarProductionW', 'Liste darf nicht leer sein');
  } else {
    solar = p.string('sourceMapping.solarProductionW', rawSolar, true) ?? '';
    if (solar !== '') pruefeId('sourceMapping.solarProductionW', solar);
  }
  const gridImportW = p.string('sourceMapping.gridImportW', mapping['gridImportW'], true) ?? '';
  const gridExportW = p.string('sourceMapping.gridExportW', mapping['gridExportW'], true) ?? '';
  if (gridImportW !== '') pruefeId('sourceMapping.gridImportW', gridImportW);
  if (gridExportW !== '') pruefeId('sourceMapping.gridExportW', gridExportW);
  const rawHouse = mapping['houseConsumptionW'];
  let house: string = 'derived';
  if (rawHouse !== undefined && rawHouse !== 'derived') {
    house = p.string('sourceMapping.houseConsumptionW', rawHouse, true) ?? 'derived';
    if (house !== 'derived') pruefeId('sourceMapping.houseConsumptionW', house);
  }

  // ── Tarif ────────────────────────────────────────────────────────────────
  const rawTariff = istObjekt(r['tariff']) ? r['tariff'] : {};
  if (r['tariff'] !== undefined && !istObjekt(r['tariff'])) p.fehler('tariff', 'muss ein Objekt sein');
  p.nurBekannte('tariff', rawTariff, ['importPricePerKWh', 'exportPricePerKWh', 'baseFeePerMonth']);
  const baseFee = p.zahl('tariff.baseFeePerMonth', rawTariff['baseFeePerMonth'], { min: 0 });
  const tariff: Tariff = {
    importPricePerKWh: p.zahl('tariff.importPricePerKWh', rawTariff['importPricePerKWh'], { min: 0, max: 5 }) ?? 0.28,
    exportPricePerKWh: p.zahl('tariff.exportPricePerKWh', rawTariff['exportPricePerKWh'], { min: 0, max: 5 }) ?? 0.08,
    ...(baseFee !== null ? { baseFeePerMonth: baseFee } : {}),
  };

  // ── Angekündigte Speicher ────────────────────────────────────────────────
  const announcedBatteries: AnnouncedBattery[] = [];
  if (r['announcedBatteries'] !== undefined) {
    if (!Array.isArray(r['announcedBatteries'])) p.fehler('announcedBatteries', 'muss eine Liste sein');
    else {
      r['announcedBatteries'].forEach((eintrag, i) => {
        const pfad = `announcedBatteries[${i}]`;
        if (!istObjekt(eintrag)) { p.fehler(pfad, 'muss ein Objekt sein'); return; }
        p.nurBekannte(pfad, eintrag, ['displayName', 'expectedCapacityWh', 'expectedSource', 'reason']);
        const displayName = p.string(`${pfad}.displayName`, eintrag['displayName'], true);
        const expectedSource = p.string(`${pfad}.expectedSource`, eintrag['expectedSource'], true);
        const reason = p.string(`${pfad}.reason`, eintrag['reason'], true);
        const cap = p.zahl(`${pfad}.expectedCapacityWh`, eintrag['expectedCapacityWh'], { min: 0 });
        if (displayName && expectedSource && reason) {
          announcedBatteries.push({ displayName, expectedSource, reason, expectedCapacityWh: cap });
        }
      });
    }
  }

  const ueberschuss = leseUeberschuss(p, r['ueberschussladen']);

  for (const w of p.warnungen) console.warn(`[Konfiguration] Hinweis ${w}`);
  if (p.probleme.length > 0) throw new KonfigurationsFehler(p.probleme, path);

  return {
    secretsPfad,
    kontenPfad: process.env['SMARTHOME_KONTEN'] ? resolve(process.env['SMARTHOME_KONTEN']) : secretsPfad,
    allowUnauthenticatedAccess: p.bool('allowUnauthenticatedAccess', r['allowUnauthenticatedAccess']) === true,
    trustedProxies,
    ueberschuss,
    port,
    host,
    pollIntervalMs,
    quellen,
    announcedBatteries,
    sourceMapping: {
      solarProductionW: solar,
      houseConsumptionW: house,
      gridImportW,
      gridExportW,
    },
    tariff,
  };
}

/**
 * Liest `sources` in beiden Schreibweisen:
 *
 *   Liste    `[{ "id": "...", "typ": "fronius-solar-api", "host": "..." }, …]`
 *   Objekt   `{ "fronius": {…}, "froniusGen24": {…}, "victron": {…}, "evCharger": {…} }`
 *            (bisherige Form; die Schlüssel ergeben feste IDs)
 *
 * Deaktivierte Einträge (`enabled: false`) fehlen im Ergebnis.
 */
function leseQuellen(
  p: Pruefung,
  roh: unknown,
  zugang: { accessId: string | null; accessSecret: string | null },
): Quelle[] {
  if (roh === undefined) return [];
  const eintraege: { pfad: string; id: string; typ: Quellentyp | null; wert: Record<string, unknown> }[] = [];

  if (Array.isArray(roh)) {
    roh.forEach((wert, i) => {
      const pfad = `sources[${i}]`;
      if (!istObjekt(wert)) { p.fehler(pfad, 'muss ein Objekt sein'); return; }
      const id = p.string(`${pfad}.id`, wert['id'], true) ?? `quelle-${i}`;
      const typ = p.string(`${pfad}.typ`, wert['typ'], true);
      if (typ !== null && !['fronius-solar-api', 'victron-modbus', 'tuya-evse'].includes(typ)) {
        p.fehler(`${pfad}.typ`, `unbekannt — erlaubt sind fronius-solar-api, victron-modbus, tuya-evse`);
      }
      eintraege.push({ pfad, id, typ: typ as Quellentyp | null, wert });
    });
  } else if (istObjekt(roh)) {
    const feste: Record<string, { id: string; typ: Quellentyp }> = {
      fronius: { id: 'fronius-local', typ: 'fronius-solar-api' },
      froniusGen24: { id: 'fronius-gen24', typ: 'fronius-solar-api' },
      victron: { id: 'victron-modbus', typ: 'victron-modbus' },
      evCharger: { id: 'ev-charger', typ: 'tuya-evse' },
    };
    p.nurBekannte('sources', roh, Object.keys(feste));
    for (const [schluessel, wert] of Object.entries(roh)) {
      if (schluessel.startsWith('_')) continue;
      const fest = feste[schluessel];
      if (fest === undefined) continue;
      const pfad = `sources.${schluessel}`;
      if (!istObjekt(wert)) { p.fehler(pfad, 'muss ein Objekt sein'); continue; }
      eintraege.push({ pfad, id: fest.id, typ: fest.typ, wert });
    }
  } else {
    p.fehler('sources', 'muss eine Liste oder ein Objekt sein');
    return [];
  }

  const quellen: Quelle[] = [];
  const gesehen = new Set<string>();
  for (const { pfad, id, typ, wert } of eintraege) {
    if (typ === null) continue;
    const enabled = p.bool(`${pfad}.enabled`, wert['enabled']);
    if (enabled === false) continue;
    if (gesehen.has(id)) { p.fehler(`${pfad}.id`, `"${id}" ist doppelt`); continue; }
    gesehen.add(id);

    if (typ === 'tuya-evse') {
      p.nurBekannte(pfad, wert, [
        'id', 'typ', 'enabled', 'deviceId', 'displayName', 'region',
        'idleIntervalMs', 'activeIntervalMs', 'phases', 'voltageV',
      ]);
      const deviceId = p.string(`${pfad}.deviceId`, wert['deviceId'], true);
      const phasesRoh = p.zahl(`${pfad}.phases`, wert['phases'], { ganz: true });
      if (phasesRoh !== null && phasesRoh !== 1 && phasesRoh !== 3) {
        p.fehler(`${pfad}.phases`, 'muss 1 oder 3 sein');
      }
      const idle = p.zahl(`${pfad}.idleIntervalMs`, wert['idleIntervalMs'], { min: 1000 });
      const aktiv = p.zahl(`${pfad}.activeIntervalMs`, wert['activeIntervalMs'], { min: 1000 });
      if (deviceId === null) continue;
      quellen.push({
        typ,
        id,
        displayName: p.string(`${pfad}.displayName`, wert['displayName'], false) ?? 'Wallbox',
        deviceId,
        region: p.string(`${pfad}.region`, wert['region'], false) ?? 'eu',
        ...(idle !== null ? { idleIntervalMs: idle } : {}),
        ...(aktiv !== null ? { activeIntervalMs: aktiv } : {}),
        phases: phasesRoh === 1 ? 1 : 3,
        voltageV: p.zahl(`${pfad}.voltageV`, wert['voltageV'], { min: 100, max: 500 }),
        accessId: zugang.accessId,
        accessSecret: zugang.accessSecret,
      });
      continue;
    }

    p.nurBekannte(pfad, wert, [
      'id', 'typ', 'enabled', 'host', 'displayName', 'batteryDisplayName', 'usableCapacityWh',
    ]);
    const hostWert = p.string(`${pfad}.host`, wert['host'], true);
    const batteryDisplayName = p.string(`${pfad}.batteryDisplayName`, wert['batteryDisplayName'], false);
    const cap = p.zahl(`${pfad}.usableCapacityWh`, wert['usableCapacityWh'], { min: 1 });
    if (hostWert === null) continue;
    const speicher: SpeicherAngabe | null =
      batteryDisplayName !== null || cap !== null
        ? { displayName: batteryDisplayName ?? 'Speicher', usableCapacityWh: cap }
        : null;
    const displayName = p.string(`${pfad}.displayName`, wert['displayName'], false)
      ?? (typ === 'fronius-solar-api' ? 'Fronius (lokale Solar API)' : 'Victron GX (Modbus TCP)');
    quellen.push({ typ, id, displayName, host: hostWert, speicher });
  }
  return quellen;
}

/**
 * Liest den Abschnitt `ueberschussladen`.
 *
 * Fehlende Werte fallen auf den Standard zurück; VORHANDENE, aber falsche Werte
 * sind ein Fehler — ein Tippfehler soll nicht still zu einer anderen Regelung
 * führen. Der Modus muss eindeutig sein: Steht dort etwas Unbekanntes, startet
 * der Server nicht. Ein unklarer Wert darf nie dazu führen, dass die Anlage
 * plötzlich Befehle an die Wallbox schickt.
 */
function leseUeberschuss(p: Pruefung, roh: unknown): UeberschussConfig {
  if (roh === undefined) return UEBERSCHUSS_STANDARD;
  if (!istObjekt(roh)) {
    p.fehler('ueberschussladen', 'muss ein Objekt sein');
    return UEBERSCHUSS_STANDARD;
  }
  const r = roh;
  const pfad = 'ueberschussladen';
  p.nurBekannte(pfad, r, [
    'modus', 'intervallSekunden', 'reserveW', 'netzTotzoneW', 'netzImportTotzoneW', 'notbremseAbW',
    'maxMessalterSekunden', 'mindestabstandSekunden', 'erhoehenNachSekunden', 'senkenNachSekunden',
    'senkenBeiBezugSekunden', 'pausierenNachSekunden', 'startenNachSekunden', 'haushaltMaxA',
    'speicherEntladenErlaubt', 'speicher', 'speicherStandard',
  ]);

  const zahl = (schluessel: keyof UeberschussConfig & string, min = 0): number =>
    p.zahl(`${pfad}.${schluessel}`, r[schluessel], { min })
      ?? (UEBERSCHUSS_STANDARD[schluessel] as number);

  let modus: UeberschussConfig['modus'] = UEBERSCHUSS_STANDARD.modus;
  if (r['modus'] !== undefined) {
    if (r['modus'] === 'regeln' || r['modus'] === 'aus' || r['modus'] === 'beobachten') modus = r['modus'];
    else p.fehler(`${pfad}.modus`, 'muss aus, beobachten oder regeln sein');
  }

  const grenzen = (pfadG: string, wert: unknown, vorgabe: Speichergrenzwerte): Speichergrenzwerte => {
    if (!istObjekt(wert)) {
      p.fehler(pfadG, 'muss ein Objekt sein');
      return vorgabe;
    }
    p.nurBekannte(pfadG, wert, ['minSocPercent', 'entladenMaxW', 'autoVorrangAbSocPercent']);
    return {
      minSocPercent: p.zahl(`${pfadG}.minSocPercent`, wert['minSocPercent'], { min: 0, max: 100 }) ?? vorgabe.minSocPercent,
      entladenMaxW: p.zahl(`${pfadG}.entladenMaxW`, wert['entladenMaxW'], { min: 0 }) ?? vorgabe.entladenMaxW,
      autoVorrangAbSocPercent:
        p.zahl(`${pfadG}.autoVorrangAbSocPercent`, wert['autoVorrangAbSocPercent'], { min: 0, max: 100 })
        ?? vorgabe.autoVorrangAbSocPercent,
    };
  };

  const speicher: Record<string, Speichergrenzwerte> = {};
  if (r['speicher'] !== undefined) {
    if (!istObjekt(r['speicher'])) p.fehler(`${pfad}.speicher`, 'muss ein Objekt (deviceId -> Grenzen) sein');
    else {
      for (const [id, wert] of Object.entries(r['speicher'])) {
        if (id.startsWith('_')) continue;
        speicher[id] = grenzen(`${pfad}.speicher.${id}`, wert, UEBERSCHUSS_STANDARD.speicherStandard);
      }
    }
  }
  const speicherStandard = r['speicherStandard'] === undefined
    ? UEBERSCHUSS_STANDARD.speicherStandard
    : grenzen(`${pfad}.speicherStandard`, r['speicherStandard'], UEBERSCHUSS_STANDARD.speicherStandard);

  const entladen = p.bool(`${pfad}.speicherEntladenErlaubt`, r['speicherEntladenErlaubt']);

  return {
    modus,
    // Unter 10 s wird nicht geregelt: Das Fahrzeug folgt einem neuen Sollwert
    // ohnehin langsamer, und die Cloud dankt es nicht.
    intervallSekunden: Math.max(10, zahl('intervallSekunden')),
    reserveW: zahl('reserveW'),
    netzTotzoneW: zahl('netzTotzoneW'),
    netzImportTotzoneW: zahl('netzImportTotzoneW'),
    notbremseAbW: zahl('notbremseAbW'),
    maxMessalterSekunden: zahl('maxMessalterSekunden'),
    mindestabstandSekunden: zahl('mindestabstandSekunden'),
    erhoehenNachSekunden: zahl('erhoehenNachSekunden'),
    senkenNachSekunden: zahl('senkenNachSekunden'),
    senkenBeiBezugSekunden: zahl('senkenBeiBezugSekunden'),
    pausierenNachSekunden: zahl('pausierenNachSekunden'),
    startenNachSekunden: zahl('startenNachSekunden'),
    haushaltMaxA: Math.max(6, zahl('haushaltMaxA', 6)),
    speicherEntladenErlaubt: entladen ?? true,
    speicher,
    speicherStandard,
  };
}
