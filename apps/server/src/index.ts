/**
 * HTTP-Server der Energy App.
 *
 * Liefert das Dashboard als statische Seite und die Messwerte über
 * Server-Sent Events. Bewusst ohne Web-Framework: Es werden drei Routen
 * benötigt, eine Abhängigkeit wäre grösser als der Code.
 *
 * Bindung über config.host (Standard 0.0.0.0, damit das Handy im Heimnetz
 * zugreifen kann; auf 127.0.0.1 setzbar, um auf diesen PC zu beschränken).
 * Zugangsdaten oder Tokens verlassen den Server niemals (Anforderung 4U).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

import {
  checkEnergyBalance,
  formatAgeDe,
  aggregateStorage,
  ladeleistungAusStromW,
  ladestromAusLeistungA,
  type Ladeanschluss,
  type EnergySnapshot,
  type Tariff,
} from '@energy/core';
import {
  FroniusLocalConnector,
  VictronModbusConnector,
  TuyaEvseConnector,
  ManagedConnector,
  type EnergyConnector,
} from '@energy/connectors';

import { LoginThrottle } from './auth.ts';
import { authGate } from './auth-gate.ts';
import { adminRouten } from './admin-routes.ts';
import { Kontenspeicher, type Benutzer } from './benutzer.ts';
import { Sitzungsspeicher } from './sitzungen.ts';
import { loadConfig, ladeanschlussAus, type AppConfig } from './config.ts';
import { EnergyEngine, type EngineState } from './engine.ts';
import { Hausverbrauch, type HausAnteil } from './hausverbrauch.ts';
import { EnergyAccumulator, localDate } from './history.ts';
import { ChargeSessionLog } from './ev-log.ts';
import { Ladesteuerung } from './ladesteuerung.ts';
import { readBody } from './http-util.ts';

const PUBLIC_DIR = resolve(import.meta.dirname, '..', 'public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Baut die Connectoren und reicht die Wallbox gesondert heraus.
 *
 * Die Regelung braucht den Adapter selbst und nicht nur seine Messwerte: Sie
 * muss den Ladestrom stellen können, und das geht nur am Original vorbei am
 * Health-Gate, das ausschliesslich lesende Aufrufe kennt.
 */
function buildConnectors(config: AppConfig): {
  connectors: ManagedConnector[];
  wallbox: TuyaEvseConnector | null;
} {
  const inner: EnergyConnector[] = [];
  let wallbox: TuyaEvseConnector | null = null;

  const { fronius, froniusGen24, victron } = config.sources;

  if (fronius?.enabled === true) {
    inner.push(
      new FroniusLocalConnector({
        host: fronius.host,
        connectorId: 'fronius-local',
        displayName: fronius.displayName ?? 'Fronius (lokale Solar API)',
      }),
    );
  }

  if (froniusGen24?.enabled === true) {
    inner.push(
      new FroniusLocalConnector({
        host: froniusGen24.host,
        connectorId: 'fronius-gen24',
        displayName: froniusGen24.displayName ?? 'Fronius GEN24',
        batteryDisplayName: froniusGen24.batteryDisplayName ?? 'Kleiner Speicher',
        ...(typeof froniusGen24.usableCapacityWh === 'number'
          ? { usableCapacityWhByDevice: { '0': froniusGen24.usableCapacityWh } }
          : {}),
      }),
    );
  }

  if (victron?.enabled === true) {
    inner.push(
      new VictronModbusConnector({
        host: victron.host,
        connectorId: 'victron-modbus',
        displayName: victron.displayName ?? 'Victron GX (Modbus TCP)',
        batteryDisplayName: victron.batteryDisplayName ?? 'Grosser Speicher',
        usableCapacityWh: victron.usableCapacityWh ?? null,
      }),
    );
  }

  // Wallbox / EV-Ladegerät (Tuya, ausschliesslich lesend). Ohne Zugangsdaten
  // wird sie übersprungen und erscheint als "nicht eingerichtet".
  const ev = config.sources.evCharger;
  if (ev?.enabled === true && ev.accessId && ev.accessSecret && ev.deviceId) {
    wallbox = new TuyaEvseConnector({
      accessId: ev.accessId,
      accessSecret: ev.accessSecret,
      deviceId: ev.deviceId,
      connectorId: 'ev-charger',
      displayName: ev.displayName ?? 'Wallbox',
      ...(ev.region !== undefined ? { region: ev.region } : {}),
      ...(ev.idleIntervalMs !== undefined ? { idleIntervalMs: ev.idleIntervalMs } : {}),
      ...(ev.activeIntervalMs !== undefined
        ? { activeIntervalMs: ev.activeIntervalMs }
        : {}),
    });
    inner.push(wallbox);
  }

  // Jeder Connector bekommt ein Health-Gate: Statusmodell, Auto-Reconnect mit
  // Backoff, und Entkopplung, damit ein totes Gerät die anderen nicht bremst.
  return { connectors: inner.map((c) => new ManagedConnector(c)), wallbox };
}

/**
 * Speicher, die laut Konfiguration existieren, aber von keiner Quelle geliefert
 * werden. Sie erscheinen als eigene Karte mit Begründung, statt kommentarlos
 * zu fehlen. Sobald die zuständige Quelle liefert, entfällt der Platzhalter.
 */
function announcedPlaceholders(
  config: AppConfig,
  present: readonly { readonly source: string }[],
): unknown[] {
  return config.announcedBatteries
    .filter(
      (announced) =>
        !present.some((battery) => battery.source === announced.expectedSource),
    )
    .map((announced) => ({
      deviceId: `announced:${announced.expectedSource}`,
      displayName: announced.displayName,
      socPercent: null,
      chargeW: null,
      dischargeW: null,
      storedEnergyWh: null,
      usableCapacityWh: announced.expectedCapacityWh,
      state: 'offline',
      source: announced.expectedSource,
      quality: 'unknown',
      ageLabel: 'keine Daten',
      unavailableReason: announced.reason,
    }));
}

/**
 * Aufteilung des Zählerwerts in Haus und Auto.
 *
 * Der Zustand lebt hier und nicht in `serializeState`, weil er über Aufrufe
 * hinweg gebraucht wird — warum, steht in `hausverbrauch.ts`.
 */
const hausTeiler = new Hausverbrauch();

/** Aufbereitung für die Oberfläche — hier entstehen keine neuen Zahlen. */

function hausUndAuto(snapshot: EnergySnapshot): HausAnteil {
  return hausTeiler.teile(
    snapshot.houseConsumptionW.valueW,
    snapshot.evCharger?.chargePowerW ?? null,
    Date.now(),
  );
}

function hausOhneAutoMetrik(snapshot: EnergySnapshot, anteil: HausAnteil): unknown {
  const haus = snapshot.houseConsumptionW;
  return {
    valueW: anteil.wattW,
    autoAbgezogenW: anteil.autoW,
    /** false = aus der gemerkten Grundlast geschaetzt, weil die Werte sich widersprachen. */
    autoBeruecksichtigt: anteil.frisch,
    source: haus.provenance.connectorId,
    quality: haus.provenance.quality,
    ageMs: Number.isFinite(haus.provenance.ageMs) ? haus.provenance.ageMs : null,
  };
}

/**
 * Ladeleistung und Ladezustand aus dem Hauszähler statt aus der Wallbox.
 *
 * Die Wallbox meldet `power_total` über die Tuya-Cloud, und dieser Wert friert
 * ein. Gemessen am 8.9. um 20:50: Der Hauptschalter der Wallbox stand auf aus,
 * der Hauszähler zeigte 1203 W für das ganze Haus — und die Wallbox meldete
 * unverändert 2007 W Ladeleistung und "lädt". In der Hausansicht stand dann ein
 * Auto, das mehr zieht als das ganze Haus verbraucht. Das kann nicht sein, und
 * es sieht auch für jeden sofort falsch aus.
 *
 * Der Hauszähler misst alle zwei Sekunden und lügt nicht. Was das Auto zieht,
 * ist deshalb der Anteil, den die Aufteilung ihm zurechnet — und "lädt" heisst
 * nur noch, dass dieser Anteil auch wirklich fliesst.
 *
 * Übrig bleibt der Fall, dass beide Werte zusammenpassen: Dann ist der Anteil
 * identisch mit dem gemeldeten, und es ändert sich nichts.
 */
function evAusZaehler(snapshot: EnergySnapshot, anteil: HausAnteil): Record<string, unknown> {
  const charger = snapshot.evCharger;
  if (charger === null) return {};
  const gemeldet = charger.chargePowerW;
  // Ohne brauchbare Aufteilung bleibt es beim Wert der Wallbox — lieber der
  // unsichere Messwert als eine erfundene Null.
  if (anteil.wattW === null) return {};
  const laedt = anteil.autoW > 200;
  return {
    powerW: anteil.autoW,
    ...(gemeldet !== null && Math.abs(gemeldet - anteil.autoW) > 200
      ? { gemeldeteLeistungW: gemeldet }
      : {}),
    // "charging" wird zurückgenommen, wenn nichts fliesst. Umgekehrt wird
    // nichts behauptet: Ob ein Fahrzeug angesteckt ist, weiss nur die Wallbox.
    ...(charger.state === 'charging' && !laedt ? { state: 'connected' } : {}),
  };
}

function serializeState(
  state: EngineState,
  config: AppConfig,
  regelung: ReturnType<Ladesteuerung['kurz']> | null = null,
): unknown {
  const { snapshot, unavailable, disagreements, derivedConsumptionNegative } =
    state.resolution;

  const anteil = hausUndAuto(snapshot);

  const metric = (value: (typeof snapshot)['solarProductionW']) => ({
    valueW: value.valueW,
    source: value.provenance.connectorId,
    quality: value.provenance.quality,
    ageMs: Number.isFinite(value.provenance.ageMs) ? value.provenance.ageMs : null,
    ageLabel: Number.isFinite(value.provenance.ageMs)
      ? formatAgeDe(value.provenance.ageMs)
      : 'keine Daten',
  });

  return {
    polledAt: state.polledAt.toISOString(),
    pollDurationMs: state.pollDurationMs,
    solar: metric(snapshot.solarProductionW),
    house: metric(snapshot.houseConsumptionW),
    // Was das Haus ohne das Auto verbraucht — die Zahl, die man eigentlich
    // meint, wenn man "Hausverbrauch" sagt. Die Wallbox hängt hinter dem
    // Hauszähler, ihre Leistung steckt also im Wert darüber mit drin.
    hausOhneAuto: hausOhneAutoMetrik(snapshot, anteil),
    gridImport: metric(snapshot.gridImportW),
    gridExport: metric(snapshot.gridExportW),
    batteries: [
      ...snapshot.batteries.map((battery) => ({
        deviceId: battery.deviceId,
        displayName: battery.displayName,
        socPercent: battery.socPercent,
        chargeW: battery.chargeW,
        dischargeW: battery.dischargeW,
        storedEnergyWh: battery.storedEnergyWh,
        usableCapacityWh: battery.usableCapacityWh,
        state: battery.state,
        source: battery.provenance.connectorId,
        quality: battery.provenance.quality,
        ageLabel: Number.isFinite(battery.provenance.ageMs)
          ? formatAgeDe(battery.provenance.ageMs)
          : 'keine Daten',
        unavailableReason: null,
      })),
      ...announcedPlaceholders(
        config,
        snapshot.batteries.map((battery) => ({
          source: battery.provenance.connectorId,
        })),
      ),
    ],
    // Gesamtspeicher, kapazitätsgewichtet (Anforderung 15).
    storageAggregate: (() => {
      const agg = aggregateStorage(
        snapshot.batteries.map((b) => ({
          usableCapacityWh: b.usableCapacityWh,
          socPercent: b.socPercent,
        })),
      );
      const net = snapshot.batteries.reduce(
        (sum, b) => sum + (b.chargeW ?? 0) - (b.dischargeW ?? 0),
        0,
      );
      return {
        totalCapacityWh: agg.totalCapacityWh,
        storedWh: agg.storedWh,
        socPercent: agg.socPercent,
        netPowerW: net,
      };
    })(),
    // PV je Wechselrichter (live) für den JETZT-Bereich (Anforderung 11).
    inverters: perInverterLive(state, config),
    // Wallbox / E-Auto. Ohne konfiguriertes Ladegerät bleibt es beim
    // bisherigen Platzhalter-Zustand (Anforderung 38).
    ev: {
      ...(serializeEv(snapshot.evCharger, ladeanschlussAus(config)) as object),
      // Ladeleistung und Ladezustand kommen aus dem Hauszähler, nicht aus der
      // Wallbox — begründet in `evAusZaehler`.
      ...evAusZaehler(snapshot, anteil),
      // Was die Überschussregelung gerade denkt. Echte Werte aus dem Dienst -
      // die Oberfläche erfindet hier nichts.
      regelung,
    },
    unavailable,
    disagreements,
    derivedConsumptionNegative,
    balance: checkEnergyBalance(snapshot),
    diagnostics: [
      ...state.diagnostics.map((entry) => {
        const status = (entry as { status?: string }).status ?? (entry.online ? 'online' : 'offline');
        return {
          ...entry,
          lastSuccessAt: entry.lastSuccessAt?.toISOString() ?? null,
          status,
          reconnectable: true,
        };
      }),
      // Platzhalter nur, solange keine echte Wallbox angebunden ist. Sobald der
      // EV-Connector läuft, erscheint dieser mit echtem Status statt der Attrappe.
      ...(state.diagnostics.some((entry) => entry.connectorId === 'ev-charger')
        ? []
        : [
            {
              connectorId: 'wallbox',
              displayName: 'Wallbox',
              online: false,
              status: 'not_configured',
              mode: 'nicht eingerichtet',
              endpoint: '',
              responseTimeMs: null,
              lastSuccessAt: null,
              detectedDevices: 0,
              availableMetrics: 0,
              missingMetrics: [],
              errorCount: 0,
              lastError: null,
              reconnectable: false,
            },
          ]),
    ],
  };
}

/**
 * Wallbox für die Oberfläche. Fehlende Werte bleiben `null` — die Anzeige macht
 * daraus „Nicht verfügbar“, niemals 0. Der Fahrzeug-Ladestand ist bei
 * AC-Ladegeräten grundsätzlich nicht übertragbar und daher stets null.
 */
function serializeEv(
  charger: EnergySnapshot['evCharger'],
  anschluss: Ladeanschluss,
): unknown {
  if (charger === null) {
    // Keine Wallbox eingerichtet — bisheriger Platzhalter, kein Fehlerzustand.
    return {
      configured: false,
      state: 'not-connected',
      vehicleConnected: null,
      powerW: null,
      sessionEnergyWh: null,
      totalEnergyWh: null,
      maxCurrentA: null,
      maxPowerW: null,
      currentFromPowerA: null,
      phases: anschluss.phasen,
      voltageV: anschluss.spannungV,
      temperatureC: null,
      socPercent: null,
      faultText: null,
    };
  }
  return {
    configured: true,
    state: charger.state,
    vehicleConnected: charger.vehicleConnected,
    powerW: charger.chargePowerW,
    // Die genauen Messwerte des Geräts: Spannung an der Dose, tatsächlich
    // fliessender Strom, Zahl der liefernden Phasen. Alles aus `phase_a` und
    // damit gemessen — nicht aus der Einstellung gerechnet.
    spannungV: charger.spannungV,
    stromA: charger.stromA,
    phasen: charger.phasen,
    sessionEnergyWh: charger.sessionEnergyWh,
    totalEnergyWh: charger.totalEnergyWh,
    maxCurrentA: charger.maxCurrentA,
    // Was die eingestellte Strombegrenzung an Leistung bedeutet. Gerechnet,
    // nicht gemessen — die Oberfläche muss das kenntlich machen.
    maxPowerW: ladeleistungAusStromW(charger.maxCurrentA, anschluss),
    // Und umgekehrt: welcher Strom hinter der gemessenen Leistung steckt. Damit
    // ist ablesbar, ob das Auto die Begrenzung ausschöpft oder von sich aus
    // weniger nimmt.
    currentFromPowerA: ladestromAusLeistungA(charger.chargePowerW, anschluss),
    phases: anschluss.phasen,
    voltageV: anschluss.spannungV,
    temperatureC: charger.temperatureC,
    socPercent: charger.vehicleSocPercent,
    faultText: charger.faultText,
    displayName: charger.displayName,
    source: charger.provenance.connectorId,
    quality: charger.provenance.quality,
    ageLabel: Number.isFinite(charger.provenance.ageMs)
      ? formatAgeDe(charger.provenance.ageMs)
      : 'keine Daten',
  };
}

/** Live-PV je Wechselrichter, für die getrennte Anzeige (11/12). */
function perInverterLive(state: EngineState, config: AppConfig): unknown[] {
  const pvSources = Array.isArray(config.sourceMapping.solarProductionW)
    ? config.sourceMapping.solarProductionW
    : [config.sourceMapping.solarProductionW];
  const names: Record<string, string> = {
    'fronius-local': config.sources.fronius?.displayName ?? 'Fronius Symo',
    'fronius-gen24': config.sources.froniusGen24?.displayName ?? 'Fronius GEN24',
    'victron-modbus': config.sources.victron?.displayName ?? 'Victron',
  };
  return state.readings
    .filter((reading) => pvSources.includes(reading.connectorId))
    .map((reading) => ({
      id: reading.connectorId,
      name: names[reading.connectorId] ?? reading.connectorId,
      powerW: reading.solarProductionW?.valueW ?? null,
      quality: reading.solarProductionW?.provenance.quality ?? 'unknown',
      ageLabel: reading.solarProductionW
        ? formatAgeDe(reading.solarProductionW.provenance.ageMs)
        : 'keine Daten',
    }));
}

async function serveStatic(
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const requested = pathname === '/' ? '/index.html' : pathname;
  // Pfad-Traversal verhindern: normalisieren und auf PUBLIC_DIR einschränken.
  const candidate = join(PUBLIC_DIR, normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  if (!candidate.startsWith(PUBLIC_DIR) || !existsSync(candidate)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Nicht gefunden');
    return;
  }

  const body = await readFile(candidate);
  const ext = extname(candidate);
  // Bilder/Schriften lange cachen, damit sie nicht bei jeder DOM-Aktualisierung
  // neu geladen werden (verhinderte das Icon-Flackern). HTML/Code bleibt no-cache.
  const cacheable = ['.png', '.svg', '.ico', '.jpg', '.jpeg', '.webp', '.woff', '.woff2'];
  response.writeHead(200, {
    'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'cache-control': cacheable.includes(ext) ? 'public, max-age=86400' : 'no-cache',
  });
  response.end(body);
}

/**
 * @param nochAngemeldet Wird vor jedem Ereignis gefragt. Der Ereignisstrom bleibt
 *   stundenlang offen; ohne diese Frage liefe er nach einem "Gerät abmelden"
 *   einfach weiter, und "wirkt sofort" wäre eine Behauptung statt einer Tatsache.
 */
function handleEvents(
  request: IncomingMessage,
  response: ServerResponse,
  engine: EnergyEngine,
  config: AppConfig,
  nochAngemeldet: () => boolean = () => true,
  regelung: () => ReturnType<Ladesteuerung['kurz']> | null = () => null,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Für Zwischenstationen wie einen Cloudflare-Tunnel oder nginx: Ein Puffer
    // sammelt sonst mehrere Ereignisse, bevor er sie weiterreicht, und die
    // Live-Ansicht ruckelt in Schüben statt im Sekundentakt zu laufen. Der Kopf
    // ist unschädlich, wo ihn niemand liest.
    'x-accel-buffering': 'no',
  });

  let unsubscribe: (() => void) | null = null;
  // Ein Handy, das in den Schlaf geht, trennt die Verbindung ohne Abmeldung.
  // Der nächste Schreibversuch läuft dann ins Leere — das ist der Normalfall
  // und darf den Messzyklus nicht stören. Deshalb wird hier abgefangen und
  // der Empfänger abgemeldet, statt den Fehler nach oben zu reichen.
  const send = (state: EngineState): void => {
    if (response.writableEnded || response.destroyed) {
      unsubscribe?.();
      return;
    }
    if (!nochAngemeldet()) {
      unsubscribe?.();
      response.end();
      return;
    }
    try {
      response.write(
        `data: ${JSON.stringify(serializeState(state, config, regelung()))}\n\n`,
      );
    } catch {
      unsubscribe?.();
      response.end();
    }
  };

  const current = engine.current();
  if (current !== null) send(current);

  unsubscribe = engine.subscribe(send);
  request.on('close', () => {
    unsubscribe?.();
    response.end();
  });
}

/** Private IPv4-Adressen dieses PCs im Heimnetz (für die Handy-URL). */
function lanAddresses(): string[] {
  const result: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) result.push(addr.address);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { connectors, wallbox } = buildConnectors(config);

  if (connectors.length === 0) {
    console.error(
      'Keine Datenquelle aktiviert. Bitte in config.json mindestens eine Quelle auf "enabled": true setzen.',
    );
    process.exitCode = 1;
    return;
  }

  const byId = new Map<string, ManagedConnector>();
  for (const c of connectors) byId.set(c.id, c);

  const engine = new EnergyEngine(connectors, config);

  // Energie-Akkumulation: integriert jeden Live-Zustand zu Tages-Energie,
  // führt die Historie und die Tageskurve.
  const pvSources = Array.isArray(config.sourceMapping.solarProductionW)
    ? config.sourceMapping.solarProductionW
    : [config.sourceMapping.solarProductionW];
  const names: Record<string, string> = {
    'fronius-local': config.sources.fronius?.displayName ?? 'Fronius Symo',
    'fronius-gen24': config.sources.froniusGen24?.displayName ?? 'Fronius GEN24',
    'victron-modbus': config.sources.victron?.displayName ?? 'Victron',
  };
  const accumulator = new EnergyAccumulator({
    dataDir: resolve(process.cwd(), 'data'),
    pvSources,
    names,
    tariff: config.tariff,
  });
  engine.subscribe((state) => accumulator.integrate(state));

  // Ladeprotokoll: erkennt Sessions selbst und speichert sie dauerhaft.
  const evLog = new ChargeSessionLog(resolve(process.cwd(), 'data'));
  engine.subscribe((state) => evLog.integrate(state));

  // Überschussregelung. Stellt den Ladestrom so, dass das Auto nur Sonne und
  // freigegebene Speicherleistung nimmt. Im Modus "beobachten" (Vorgabe)
  // rechnet sie mit, sendet aber nichts.
  const ladesteuerung = new Ladesteuerung(
    engine,
    wallbox,
    config,
    resolve(process.cwd(), 'data'),
  );
  // Erst die Erfahrung des Tages übernehmen, dann anfangen zu regeln: Was die
  // Speicher können, steht im aufgezeichneten Verlauf und muss nach einem
  // Neustart nicht neu erarbeitet werden.
  ladesteuerung.lerneAus(
    accumulator.todaySeries().flatMap((p) =>
      Object.entries(p.bat).map(([id, b]) => ({
        id,
        // Negative Batterieleistung ist Entladung — dieselbe Vorzeichenregel
        // wie im Verlauf und in der Engine.
        entladenW: Math.max(0, -(b.p ?? 0)),
        tMs: p.t,
      })),
    ),
  );

  engine.start();
  ladesteuerung.start();

  const sendJson = (response: ServerResponse, status: number, payload: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  };

  // Eine Bremse für alle Anmeldeversuche, absichtlich ausserhalb des Handlers:
  // Sie muss sich Fehlversuche über Anfragen hinweg merken.
  const throttle = new LoginThrottle();

  // Konten und angemeldete Geräte. `null` heisst: In secrets.json steht kein
  // Konto, der Server läuft offen wie früher.
  const konten = Kontenspeicher.laden(config.secretsPfad);
  const sitzungen =
    konten === null
      ? null
      : new Sitzungsspeicher(
          resolve(process.cwd(), 'data', 'sitzungen.json'),
          konten.sessionSecret,
        );

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    // Vor allem anderen. Ohne Anmeldedaten in secrets.json bleibt der Server
    // offen wie bisher — für den reinen Heimnetzbetrieb gewollt, siehe Hinweis
    // beim Start.
    let ich: Benutzer | null = null;
    let sitzungId: string | null = null;
    if (konten !== null && sitzungen !== null) {
      const schranke = authGate(request, response, url, { konten, sitzungen, throttle });
      if (!schranke.weiter) return;
      ich = schranke.benutzer ?? null;
      sitzungId = schranke.sitzungId ?? null;

      if (ich !== null && adminRouten(request, response, url, ich, { konten, sitzungen })) {
        return;
      }
    } else if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      // Ohne Konten gibt es nichts zu verwalten. Statt 404 lieber sagen, wie
      // man dorthin kommt.
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;line-height:1.6">' +
          '<h1 style="font-size:1.2rem">Noch keine Anmeldung eingerichtet</h1>' +
          '<p>Auf dem Server-PC im Ordner der App ausf&uuml;hren: <code>npm run passwort</code>. ' +
          'Das erste Konto wird automatisch Administrator.</p>' +
          '<p><a href="/">Zur&uuml;ck zum Dashboard</a></p></body>',
      );
      return;
    }

    // Wer bin ich? Die Oberfläche entscheidet damit, ob sie den Abmelden-Knopf
    // und den Zugang zur Verwaltung zeigt.
    if (url.pathname === '/api/ich') {
      sendJson(
        response,
        200,
        ich === null
          ? { enabled: konten !== null }
          : {
              enabled: true,
              username: ich.username,
              rolle: ich.rolle,
              istAdmin: ich.rolle === 'admin',
            },
      );
      return;
    }

    if (url.pathname === '/api/events') {
      const kennung = sitzungId;
      const konto = ich;
      handleEvents(
        request,
        response,
        engine,
        config,
        sitzungen === null || kennung === null || konten === null
          ? undefined
          : () => sitzungen.gilt(kennung) && konten.nachId(konto?.id ?? '') !== null,
        () => ladesteuerung.kurz(),
      );
      return;
    }

    if (url.pathname === '/api/snapshot') {
      const state = engine.current();
      sendJson(
        response,
        state === null ? 503 : 200,
        state === null
          ? { error: 'Noch keine Messung' }
          : serializeState(state, config, ladesteuerung.kurz()),
      );
      return;
    }

    if (url.pathname === '/api/today') {
      sendJson(response, 200, accumulator.todayView());
      return;
    }

    if (url.pathname === '/api/today/series') {
      sendJson(response, 200, { points: accumulator.todaySeries() });
      return;
    }

    if (url.pathname === '/api/history') {
      const range = url.searchParams.get('range') ?? 'day';
      const allowed = ['day', 'month', 'year', 'total'] as const;
      const r = (allowed as readonly string[]).includes(range) ? range : 'day';
      sendJson(response, 200, accumulator.historyView(r as (typeof allowed)[number]));
      return;
    }

    // Vollständige Tagesansicht (Kurve + Zusammenfassung) für ein beliebiges Datum.
    // Mit ?summary=1 wird die (große) Kurve weggelassen — für die KPI-Leiste.
    if (url.pathname === '/api/history/day') {
      const raw = url.searchParams.get('date');
      const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : localDate(new Date());
      const view = accumulator.dayView(date) as Record<string, unknown>;
      if (url.searchParams.get('summary') !== null && view) {
        const { series, ...rest } = view;
        void series;
        sendJson(response, 200, rest);
      } else {
        sendJson(response, 200, view);
      }
      return;
    }

    // Datumsangaben mit vorhandener Historie (für die Datumsauswahl).
    if (url.pathname === '/api/history/dates') {
      sendJson(response, 200, { dates: accumulator.availableDates() });
      return;
    }

    // Ladeprotokoll: Liste der Ladevorgänge (neueste zuerst) + laufender.
    if (url.pathname === '/api/ev/sessions') {
      const raw = Number(url.searchParams.get('limit') ?? '50');
      const limit = Number.isFinite(raw) ? Math.min(500, Math.max(1, raw)) : 50;
      sendJson(response, 200, {
        current: evLog.current(),
        sessions: evLog.list(limit),
      });
      return;
    }

    // Einzelner Ladevorgang mit voller Energieaufteilung.
    const sessionMatch = url.pathname.match(/^\/api\/ev\/sessions\/(.+)$/);
    if (sessionMatch) {
      const session = evLog.find(decodeURIComponent(sessionMatch[1] ?? ''));
      sendJson(
        response,
        session === null ? 404 : 200,
        session ?? { error: 'Ladevorgang nicht gefunden' },
      );
      return;
    }

    // Aggregierte Statistik je Zeitraum.
    if (url.pathname === '/api/ev/stats') {
      const allowed = ['day', 'week', 'month', 'year', 'total'];
      const rangeRaw = url.searchParams.get('range') ?? 'month';
      const range = allowed.includes(rangeRaw) ? rangeRaw : 'month';
      const dateRaw = url.searchParams.get('date');
      const date =
        dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : localDate(new Date());
      sendJson(response, 200, evLog.stats(range, date));
      return;
    }

    // Laden anhalten oder fortsetzen — überstimmt jede Betriebsart.
    if (url.pathname === '/api/ev/stopp' && request.method === 'POST') {
      void readBody(request, 1_000)
        .then((body) => {
          ladesteuerung.setzeGestoppt((JSON.parse(body) as { an?: unknown }).an === true);
          sendJson(response, 200, ladesteuerung.kurz());
        })
        .catch(() => sendJson(response, 400, { error: 'Ungültige Anfrage' }));
      return;
    }

    // Betriebsart wählen: autark, Handbetrieb mit festem Ladestrom, Volladung.
    // Die beiden letzten kaufen bewusst Netzstrom — auf Wunsch des Menschen.
    if (url.pathname === '/api/ev/betriebsart' && request.method === 'POST') {
      void readBody(request, 1_000)
        .then((body) => {
          const roh = JSON.parse(body) as { art?: unknown; ampere?: unknown };
          // "volladung" gab es einmal als eigene Art. Eine noch
          // zwischengespeicherte Oberfläche darf davon nichts merken: Sie
          // landet im Handbetrieb, und der Ladestrom kommt vom Gerät.
          const art = roh.art === 'manuell' || roh.art === 'volladung' ? 'manuell' : 'intelligent';
          // Der Ladestrom wird hier NICHT gegen 6-16 A geprüft: Die echten
          // Grenzen kennt nur das Gerät, und die Steuerung begrenzt selbst.
          // Eine zweite Prüfung hier wäre eine zweite, womöglich falsche
          // Wahrheit über die Hardware.
          const ampere = typeof roh.ampere === 'number' && Number.isFinite(roh.ampere)
            ? roh.ampere
            : undefined;
          ladesteuerung.setzeBetriebsart(art, ampere);
          sendJson(response, 200, ladesteuerung.kurz());
        })
        .catch(() => sendJson(response, 400, { error: 'Ungültige Anfrage' }));
      return;
    }

    // Volladung erzwingen — bewusster Netzbezug auf Wunsch des Menschen.
    // Bleibt erhalten, damit eine noch zwischengespeicherte ältere Oberfläche
    // auf dem Handy nicht ins Leere greift.
    if (url.pathname === '/api/ev/volladung' && request.method === 'POST') {
      void readBody(request, 1_000)
        .then((body) => {
          const an = (JSON.parse(body) as { an?: unknown }).an === true;
          ladesteuerung.setzeVolladung(an);
          sendJson(response, 200, { volladung: an });
        })
        .catch(() => sendJson(response, 400, { error: 'Ungültige Anfrage' }));
      return;
    }

    // Zustand der Überschussregelung samt Protokoll der letzten Entscheidungen.
    if (url.pathname === '/api/ev/regelung') {
      sendJson(response, 200, ladesteuerung.zustand());
      return;
    }

    // Zustand des dauerhaft laufenden Datensammlers.
    if (url.pathname === '/api/collector') {
      sendJson(response, 200, accumulator.collectorHealth());
      return;
    }

    // Manueller Reconnect / Health-Check eines Geräts (STEP 24–29).
    const reconnectMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/reconnect$/);
    if (reconnectMatch && request.method === 'POST') {
      const deviceId = decodeURIComponent(reconnectMatch[1] ?? '');
      const connector = byId.get(deviceId);
      if (!connector) {
        sendJson(response, 404, { error: 'Unbekanntes Gerät', deviceId });
        return;
      }
      void connector
        .reconnect()
        .then((diag) =>
          sendJson(response, 200, {
            ...diag,
            lastSuccessAt: diag.lastSuccessAt?.toISOString() ?? null,
            reconnectable: true,
          }),
        )
        .catch((error: unknown) =>
          sendJson(response, 500, { error: error instanceof Error ? error.message : 'Reconnect fehlgeschlagen' }),
        );
      return;
    }

    if (url.pathname === '/api/tariff') {
      if (request.method === 'GET') {
        sendJson(response, 200, accumulator.getTariff());
        return;
      }
      if (request.method === 'PUT') {
        void readBody(request)
          .then((body) => {
            const parsed = JSON.parse(body) as Partial<Tariff>;
            const current = accumulator.getTariff();
            const next: Tariff = {
              importPricePerKWh:
                typeof parsed.importPricePerKWh === 'number'
                  ? parsed.importPricePerKWh
                  : current.importPricePerKWh,
              exportPricePerKWh:
                typeof parsed.exportPricePerKWh === 'number'
                  ? parsed.exportPricePerKWh
                  : current.exportPricePerKWh,
            };
            accumulator.setTariff(next);
            sendJson(response, 200, accumulator.getTariff());
          })
          .catch(() => sendJson(response, 400, { error: 'Ungültiger Tarif' }));
        return;
      }
    }

    void serveStatic(url.pathname, response);
  });

  server.listen(config.port, config.host, () => {
    console.log('');
    console.log('  SmartHome läuft.');
    console.log('');
    console.log(`  Auf diesem PC:   http://localhost:${config.port}`);
    if (config.host === '0.0.0.0') {
      const lanIps = lanAddresses();
      if (lanIps.length > 0) {
        console.log('');
        console.log('  Auf dem Handy (gleiches WLAN), Adresse im Browser eingeben:');
        for (const ip of lanIps) console.log(`     http://${ip}:${config.port}`);
      }
    }
    console.log('');
    console.log(`  Quellen:     ${connectors.map((c) => c.displayName).join(', ')}`);
    console.log('');
    if (konten !== null) {
      const namen = konten
        .alle()
        .map((b) => (b.rolle === 'admin' ? `${b.username} (Admin)` : b.username))
        .join(', ');
      console.log(`  Anmeldung:   aktiv - ${konten.anzahl()} Konto/Konten: ${namen}`);
      console.log(`  Verwaltung:  http://localhost:${config.port}/admin`);
    } else {
      // Deutlich, aber ohne Abbruch: Im Heimnetz hinter dem Router ist das in
      // Ordnung. Über einen Tunnel ins Internet ist es das nicht.
      console.log('  ACHTUNG: Keine Anmeldung eingerichtet - die App ist für jeden');
      console.log('           erreichbar, der die Adresse kennt. Einrichten mit:');
      console.log('              npm run passwort');
    }
    console.log('');
    console.log('  Beenden: dieses Fenster schließen.');
    console.log('');
  });

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    engine.stop();
    ladesteuerung.stop();
    accumulator.persist();
    evLog.persist();
    sitzungen?.persist();
    server.close(() => process.exit(0));
    // Ohne das Folgende endete der Vorgang nie, sobald irgendwo ein Dashboard
    // offen war: server.close() wartet auf jede bestehende Verbindung, und ein
    // Event-Stream bleibt absichtlich beliebig lange bestehen.
    server.closeAllConnections();
    // Letzte Sicherung, falls doch etwas hängen bleibt.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
