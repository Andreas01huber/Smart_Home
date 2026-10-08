/**
 * Fixture-Server: die echte App mit simulierten Geräten.
 *
 * Für die Browserprüfung, ohne irgendeine echte Anlage anzufassen:
 *
 *   - Wechselrichter, Speicher, Netzzähler und Wallbox sind Attrappen. Die
 *     Wallbox schreibt Befehle nur in eine Liste; es gibt keinen Weg zu Tuya.
 *   - Alle Daten liegen in einem frischen temporären Verzeichnis. config.json,
 *     secrets.json und data/ der Anlage werden weder gelesen noch geschrieben.
 *   - Anmeldung ist über `allowUnauthenticatedAccess` abgeschaltet — nur hier,
 *     nur für diesen lokalen Prüfbetrieb.
 *
 * Aufruf:
 *   npx tsx tools/fixture-server.ts [--port 4180] [--szenario sonnig] [--leer]
 *
 * Steuerung während des Laufs (nur dieser Server kennt die Pfade):
 *   GET  /__fixture/szenario             aktuelles Szenario
 *   POST /__fixture/szenario  {name}     Szenario wechseln
 *   POST /__fixture/stoerung  {langsam, fehler}
 *        langsam: { "/api/history/day": 3000 }   Pfad -> Verzögerung in ms
 *        fehler:  ["/api/ev/stats"]              Pfade, die mit 500 antworten
 *        stumm:   true                          /api/events bleibt offen, sendet nichts
 *   GET  /__fixture/befehle              was die Wallbox-Attrappe empfangen hat
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BatterySnapshot, ConnectorReading, EvChargerSnapshot, PowerMetric } from '@energy/core';
import { ManagedConnector, type ConnectorDiagnostics, type EnergyConnector } from '@energy/connectors';

import type { AppConfig } from '../apps/server/src/config.ts';
import { starteServer } from '../apps/server/src/index.ts';
import { EnergyAccumulator } from '../apps/server/src/history.ts';
import { ChargeSessionLog } from '../apps/server/src/ev-log.ts';
import type { EngineState } from '../apps/server/src/engine.ts';
import { resolveSnapshot } from '@energy/core';

// ── Szenarien ────────────────────────────────────────────────────────────────

interface Speicherlage {
  soc: number;
  /** + laden, − entladen */
  w: number;
  offline?: boolean;
}

interface Szenario {
  beschreibung: string;
  pvSymo: number;
  pvGen24: number;
  /** Hausverbrauch OHNE Auto. */
  haus: number;
  angesteckt: boolean | null;
  /** Nimmt das Fahrzeug Strom an, wenn freigegeben? */
  fordert: boolean;
  klein: Speicherlage;
  gross: Speicherlage;
  /** Alle Werte als veraltet melden. */
  veraltet?: boolean;
  wallboxOffline?: boolean;
}

const SZENARIEN: Record<string, Szenario> = {
  sonnig: {
    beschreibung: 'Sonnig, Auto steckt und nimmt Strom',
    pvSymo: 5200, pvGen24: 3900, haus: 900, angesteckt: true, fordert: true,
    klein: { soc: 96, w: 600 }, gross: { soc: 92, w: 1200 },
  },
  nachts: {
    beschreibung: 'Nacht, Auto steckt, Speicher entladen ins Haus',
    pvSymo: 0, pvGen24: 0, haus: 450, angesteckt: true, fordert: true,
    klein: { soc: 41, w: -200 }, gross: { soc: 55, w: -250 },
  },
  wartet: {
    beschreibung: 'Wenig Sonne, wartet auf Überschuss',
    pvSymo: 900, pvGen24: 500, haus: 700, angesteckt: true, fordert: true,
    klein: { soc: 60, w: 300 }, gross: { soc: 58, w: 400 },
  },
  keinauto: {
    beschreibung: 'Sonnig, kein Auto angesteckt',
    pvSymo: 5200, pvGen24: 3900, haus: 900, angesteckt: false, fordert: false,
    klein: { soc: 96, w: 1500 }, gross: { soc: 92, w: 2500 },
  },
  voll: {
    beschreibung: 'Auto steckt, nimmt aber keinen Strom an',
    pvSymo: 5200, pvGen24: 3900, haus: 900, angesteckt: true, fordert: false,
    klein: { soc: 96, w: 1500 }, gross: { soc: 92, w: 2500 },
  },
  speicheroffline: {
    beschreibung: 'Grosser Speicher nicht erreichbar',
    pvSymo: 3000, pvGen24: 2000, haus: 1100, angesteckt: true, fordert: true,
    klein: { soc: 70, w: 900 }, gross: { soc: 0, w: 0, offline: true },
  },
  veraltet: {
    beschreibung: 'Alle Messwerte veraltet',
    pvSymo: 3000, pvGen24: 2000, haus: 1100, angesteckt: true, fordert: true,
    klein: { soc: 70, w: 900 }, gross: { soc: 60, w: 800 }, veraltet: true,
  },
  wallboxoffline: {
    beschreibung: 'Wallbox über die Cloud nicht erreichbar',
    pvSymo: 3000, pvGen24: 2000, haus: 1100, angesteckt: null, fordert: false,
    klein: { soc: 70, w: 900 }, gross: { soc: 60, w: 800 }, wallboxOffline: true,
  },
};

// ── Attrappen ────────────────────────────────────────────────────────────────

const lage = { szenario: SZENARIEN['sonnig'] as Szenario, name: 'sonnig' };

const wallbox = {
  schalterAn: false,
  ladestromA: 10,
  befehle: [] as { zeit: string; befehl: string }[],
};

/** Momentane Ladeleistung der Attrappe — einphasig an der Haushaltsdose. */
function autoW(): number {
  const s = lage.szenario;
  if (s.wallboxOffline || s.angesteckt !== true || !s.fordert || !wallbox.schalterAn) return 0;
  return wallbox.ladestromA * 229;
}

function prov(connectorId: string, deviceId = connectorId) {
  const alterMs = lage.szenario.veraltet ? 20 * 60_000 : 500;
  return {
    connectorId,
    deviceId,
    measuredAt: new Date(Date.now() - alterMs),
    ageMs: alterMs,
    quality: lage.szenario.veraltet ? ('offline' as const) : ('live' as const),
  };
}
const m = (id: string, w: number | null): PowerMetric => ({ valueW: w, provenance: prov(id) });

function speicher(id: string, device: string, name: string, cap: number, l: Speicherlage): BatterySnapshot {
  return {
    deviceId: device,
    displayName: name,
    socPercent: l.soc,
    chargeW: Math.max(0, l.w),
    dischargeW: Math.max(0, -l.w),
    storedEnergyWh: (l.soc / 100) * cap,
    usableCapacityWh: cap,
    ratedCapacityWh: cap,
    state: l.w > 0 ? 'charging' : l.w < 0 ? 'discharging' : 'idle',
    provenance: prov(id, device),
  };
}

function diagnose(id: string, name: string, online: boolean): ConnectorDiagnostics {
  return {
    connectorId: id, displayName: name, online, responseTimeMs: online ? 12 : null,
    lastSuccessAt: online ? new Date() : null, detectedDevices: 1, availableMetrics: 4,
    missingMetrics: [], errorCount: 0, lastError: online ? null : 'Attrappe: offline', mode: 'Fixture',
    endpoint: 'fixture',
  };
}

/** Eine Attrappe je echter Quelle, mit derselben ID wie in der Anlage. */
function quelle(id: string, name: string, lies: () => ConnectorReading | null): EnergyConnector {
  let online = true;
  return {
    id,
    displayName: name,
    async read() {
      const r = lies();
      online = r !== null;
      if (r === null) throw new Error(`${name} nicht erreichbar (Fixture)`);
      return r;
    },
    diagnostics: () => diagnose(id, name, online),
  };
}

const netz = (): { bezug: number; einspeisung: number } => {
  const s = lage.szenario;
  const pv = s.pvSymo + s.pvGen24;
  const speicherNetto = (s.klein.offline ? 0 : s.klein.w) + (s.gross.offline ? 0 : s.gross.w);
  const saldo = s.haus + autoW() + speicherNetto - pv;
  return { bezug: Math.max(0, saldo), einspeisung: Math.max(0, -saldo) };
};

const symo = quelle('fronius-local', 'Fronius Symo (Attrappe)', () => ({
  connectorId: 'fronius-local', timestamp: new Date(),
  solarProductionW: m('fronius-local', lage.szenario.pvSymo),
  houseConsumptionW: null, gridImportW: null, gridExportW: null, batteries: [],
}));
const gen24 = quelle('fronius-gen24', 'Fronius GEN24 (Attrappe)', () => ({
  connectorId: 'fronius-gen24', timestamp: new Date(),
  solarProductionW: m('fronius-gen24', lage.szenario.pvGen24),
  houseConsumptionW: null, gridImportW: null, gridExportW: null,
  batteries: lage.szenario.klein.offline
    ? []
    : [speicher('fronius-gen24', 'fronius-gen24:0', 'Kleiner Speicher', 11_000, lage.szenario.klein)],
}));
const victron = quelle('victron-modbus', 'Victron GX (Attrappe)', () => {
  const n = netz();
  return {
    connectorId: 'victron-modbus', timestamp: new Date(),
    solarProductionW: null, houseConsumptionW: null,
    gridImportW: m('victron-modbus', n.bezug), gridExportW: m('victron-modbus', n.einspeisung),
    batteries: lage.szenario.gross.offline
      ? []
      : [speicher('victron-modbus', 'victron-modbus:system', 'Grosser Speicher', 20_000, lage.szenario.gross)],
  };
});

function evSnapshot(): EvChargerSnapshot {
  const s = lage.szenario;
  const w = autoW();
  return {
    deviceId: 'ev-charger:fixture',
    displayName: 'Leapmotor C10 (Attrappe)',
    state: s.wallboxOffline ? 'offline'
      : s.angesteckt !== true ? 'idle'
      : w > 50 ? 'charging' : 'connected',
    vehicleConnected: s.wallboxOffline ? null : s.angesteckt,
    chargePowerW: s.wallboxOffline ? null : w,
    sessionEnergyWh: null,
    totalEnergyWh: null,
    maxCurrentA: wallbox.ladestromA,
    schalterAn: wallbox.schalterAn,
    spannungV: w > 0 ? 229 : null,
    stromA: w > 0 ? wallbox.ladestromA : null,
    phasen: w > 0 ? 1 : null,
    temperatureC: 31,
    vehicleSocPercent: null,
    faultText: null,
    provenance: prov('ev-charger'),
  };
}

const evQuelle = quelle('ev-charger', 'Wallbox (Attrappe)', () => ({
  connectorId: 'ev-charger', timestamp: new Date(),
  solarProductionW: null, houseConsumptionW: null, gridImportW: null, gridExportW: null,
  batteries: [], evCharger: evSnapshot(),
}));

/** Was die Ladesteuerung von der Wallbox braucht — ohne Weg nach draussen. */
const wallboxSteuerung = {
  async ladestromGrenzen() { return { minA: 6, maxA: 16, schrittA: 1 }; },
  async steuerfunktionen() { return [{ code: 'charge_cur_set', type: 'Integer', values: '{}' }]; },
  async setzeLaden(an: boolean) {
    if (lage.szenario.wallboxOffline) throw new Error('Wallbox nicht erreichbar (Fixture)');
    wallbox.schalterAn = an;
    wallbox.befehle.push({ zeit: new Date().toISOString(), befehl: `switch=${an}` });
  },
  async setzeLadestrom(ampere: number) {
    if (lage.szenario.wallboxOffline) throw new Error('Wallbox nicht erreichbar (Fixture)');
    wallbox.ladestromA = ampere;
    wallbox.befehle.push({ zeit: new Date().toISOString(), befehl: `charge_cur_set=${ampere}` });
    return ampere;
  },
};

// ── Konfiguration und Historie ───────────────────────────────────────────────

function konfiguration(port: number, dir: string): AppConfig {
  return {
    port,
    host: '127.0.0.1',
    pollIntervalMs: 2000,
    allowUnauthenticatedAccess: true,
    trustedProxies: [],
    secretsPfad: join(dir, 'secrets-gibt-es-hier-nicht.json'),
    kontenPfad: join(dir, 'secrets-gibt-es-hier-nicht.json'),
    quellen: [
      { typ: 'fronius-solar-api', id: 'fronius-local', host: 'fixture', displayName: 'Fronius Symo', speicher: null },
      { typ: 'fronius-solar-api', id: 'fronius-gen24', host: 'fixture', displayName: 'Fronius GEN24', speicher: { displayName: 'Kleiner Speicher', usableCapacityWh: 11_000 } },
      { typ: 'victron-modbus', id: 'victron-modbus', host: 'fixture', displayName: 'Victron GX', speicher: { displayName: 'Grosser Speicher', usableCapacityWh: 20_000 } },
      { typ: 'tuya-evse', id: 'ev-charger', deviceId: 'fixture', displayName: 'Leapmotor C10', region: 'eu', phases: 1, voltageV: 229, accessId: null, accessSecret: null },
    ],
    sourceMapping: {
      solarProductionW: ['fronius-local', 'fronius-gen24'],
      houseConsumptionW: 'derived',
      gridImportW: 'victron-modbus',
      gridExportW: 'victron-modbus',
    },
    announcedBatteries: [],
    tariff: { importPricePerKWh: 0.28, exportPricePerKWh: 0.08 },
    ueberschuss: {
      modus: 'regeln',
      intervallSekunden: 10,
      reserveW: 200,
      netzTotzoneW: 150,
      netzImportTotzoneW: 40,
      notbremseAbW: 300,
      maxMessalterSekunden: 30,
      mindestabstandSekunden: 10,
      erhoehenNachSekunden: 10,
      senkenNachSekunden: 5,
      senkenBeiBezugSekunden: 2,
      pausierenNachSekunden: 10,
      startenNachSekunden: 10,
      haushaltMaxA: 16,
      speicherEntladenErlaubt: true,
      speicher: {},
      speicherStandard: { minSocPercent: 50, entladenMaxW: 3000, autoVorrangAbSocPercent: 80 },
    },
  };
}

/**
 * Zwei vergangene Tage mit realistischem Verlauf, darunter eine Stunde
 * Serverausfall und ein Abendladevorgang — damit Verlauf, Abdeckung und
 * Ladeprotokoll etwas zu zeigen haben.
 */
function saeHistorie(dir: string, pvQuellen: string[]): void {
  let uhr = 0;
  const acc = new EnergyAccumulator({
    dataDir: dir, pvSources: pvQuellen, names: {}, tariff: { importPricePerKWh: 0.28, exportPricePerKWh: 0.08 },
    jetzt: () => uhr,
  });
  const log = new ChargeSessionLog(dir);
  const heute = new Date();
  heute.setHours(0, 0, 0, 0);
  const beginn = new Date(heute.getTime() - 2 * 86_400_000);
  const merk = { ...lage };
  for (let t = beginn.getTime(); t < heute.getTime() + 6 * 3_600_000 && t < Date.now() - 60_000; t += 10_000) {
    const d = new Date(t);
    const stunde = d.getHours() + d.getMinutes() / 60;
    // Ausfall gestern 14–15 Uhr.
    if (d.getDate() === new Date(heute.getTime() - 86_400_000).getDate() && stunde >= 14 && stunde < 15) continue;
    const sonne = Math.max(0, Math.sin(((stunde - 6) / 14) * Math.PI));
    const laedt = stunde >= 18 && stunde < 20.5 && t < heute.getTime();
    lage.szenario = {
      beschreibung: 'Historie', pvSymo: Math.round(5200 * sonne), pvGen24: Math.round(3900 * sonne),
      haus: 350 + (stunde > 17 && stunde < 22 ? 900 : 150), angesteckt: laedt, fordert: laedt,
      klein: { soc: 60, w: sonne > 0.3 ? 800 : -200 }, gross: { soc: 60, w: sonne > 0.3 ? 1200 : -150 },
    };
    wallbox.schalterAn = laedt;
    wallbox.ladestromA = 10;
    const lesen = (): ConnectorReading[] => {
      const n = netz();
      const s = lage.szenario;
      const pm = (id: string, w: number): PowerMetric => ({
        valueW: w, provenance: { connectorId: id, deviceId: id, measuredAt: d, ageMs: 0, quality: 'live' },
      });
      const sp = (id: string, dev: string, name: string, cap: number, l: Speicherlage): BatterySnapshot => ({
        ...speicher(id, dev, name, cap, l), provenance: { connectorId: id, deviceId: dev, measuredAt: d, ageMs: 0, quality: 'live' },
      });
      return [
        { connectorId: 'fronius-local', timestamp: d, solarProductionW: pm('fronius-local', s.pvSymo), houseConsumptionW: null, gridImportW: null, gridExportW: null, batteries: [] },
        { connectorId: 'fronius-gen24', timestamp: d, solarProductionW: pm('fronius-gen24', s.pvGen24), houseConsumptionW: null, gridImportW: null, gridExportW: null, batteries: [sp('fronius-gen24', 'fronius-gen24:0', 'Kleiner Speicher', 11_000, s.klein)] },
        { connectorId: 'victron-modbus', timestamp: d, solarProductionW: null, houseConsumptionW: null, gridImportW: pm('victron-modbus', n.bezug), gridExportW: pm('victron-modbus', n.einspeisung), batteries: [sp('victron-modbus', 'victron-modbus:system', 'Grosser Speicher', 20_000, s.gross)] },
        { connectorId: 'ev-charger', timestamp: d, solarProductionW: null, houseConsumptionW: null, gridImportW: null, gridExportW: null, batteries: [], evCharger: { ...evSnapshot(), provenance: { connectorId: 'ev-charger', deviceId: 'ev', measuredAt: d, ageMs: 0, quality: 'live' } } },
      ];
    };
    const r = lesen();
    const resolution = resolveSnapshot(r, konfiguration(0, dir).sourceMapping);
    const state: EngineState = { resolution, readings: r, diagnostics: [], polledAt: d, pollDurationMs: 1 };
    uhr = t;
    acc.integrate(state, autoW());
    log.integrate(state, autoW());
  }
  acc.persist();
  log.persist();
  lage.szenario = merk.szenario;
  lage.name = merk.name;
  wallbox.schalterAn = false;
}

// ── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wert = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(wert('--port') ?? '4180');
  const start = wert('--szenario') ?? 'sonnig';
  if (SZENARIEN[start]) { lage.szenario = SZENARIEN[start]; lage.name = start; }

  const dir = mkdtempSync(join(tmpdir(), 'smarthome-fixture-'));
  const config = konfiguration(port, dir);
  if (!args.includes('--leer')) saeHistorie(dir, ['fronius-local', 'fronius-gen24']);

  const stoerung: { langsam: Record<string, number>; fehler: string[]; stumm: boolean } = { langsam: {}, fehler: [], stumm: false };

  const laufend = await starteServer({
    config,
    datenverzeichnis: dir,
    quellen: {
      // Die Wallbox-Attrappe misst und stellt zugleich; das Health-Gate reicht die
      // Steuerung durch, genau wie beim echten Gerät.
      ...(() => {
        const connectors = [symo, gen24, victron, Object.assign(evQuelle, wallboxSteuerung)].map((c) => new ManagedConnector(c));
        return { connectors, wallbox: connectors.map((c) => c.ladegeraet()).find((l) => l !== null) ?? null };
      })(),
    },
    async vorbehandlung(request, response, url) {
      const json = (status: number, body: unknown): true => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(body));
        return true;
      };
      const lies = async (): Promise<Record<string, unknown>> => {
        let text = '';
        for await (const teil of request) text += String(teil);
        return text ? JSON.parse(text) as Record<string, unknown> : {};
      };
      if (url.pathname === '/__fixture/szenario') {
        if (request.method === 'POST') {
          const name = String((await lies())['name'] ?? '');
          const s = SZENARIEN[name];
          if (!s) return json(400, { error: 'unbekanntes Szenario', bekannt: Object.keys(SZENARIEN) });
          lage.szenario = s;
          lage.name = name;
        }
        return json(200, { name: lage.name, ...lage.szenario, bekannt: Object.keys(SZENARIEN) });
      }
      if (url.pathname === '/__fixture/stoerung' && request.method === 'POST') {
        const roh = await lies();
        stoerung.langsam = (roh['langsam'] as Record<string, number>) ?? {};
        stoerung.fehler = (roh['fehler'] as string[]) ?? [];
        stoerung.stumm = roh['stumm'] === true;
        return json(200, stoerung);
      }
      if (url.pathname === '/__fixture/befehle') return json(200, wallbox);

      if (stoerung.stumm && url.pathname === '/api/events') {
        // Offen, aber stumm: wie eine hängende Zwischenstation.
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        response.flushHeaders();
        return true;
      }
      if (stoerung.fehler.includes(url.pathname)) return json(500, { error: 'Fixture: absichtlicher Serverfehler' });
      const ms = stoerung.langsam[url.pathname];
      if (ms) {
        // Nur bestimmte Datumsabfragen verzögern, wenn `pfad?date=...` angegeben.
        await new Promise((f) => setTimeout(f, ms));
      }
      const msDatum = stoerung.langsam[`${url.pathname}?date=${url.searchParams.get('date') ?? ''}`];
      if (msDatum) await new Promise((f) => setTimeout(f, msDatum));
      return false;
    },
  });

  console.log(`  Fixture-Server: http://127.0.0.1:${port}  (Daten: ${dir})`);
  console.log(`  Szenario: ${lage.name} — ${lage.szenario.beschreibung}`);
  const ende = (): void => {
    void laufend.stoppe().finally(() => {
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    });
  };
  process.on('SIGINT', ende);
  process.on('SIGTERM', ende);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
