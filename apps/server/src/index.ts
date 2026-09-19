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
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  checkEnergyBalance,
  formatAgeDe,
  speicherGesamt,
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
import { readBody, mitHttpFehlergrenze, herkunftErlaubt } from './http-util.ts';
import { pruefeBetriebsartAnfrage, pruefeStoppAnfrage } from './ev-anfragen.ts';
import { gesundheit } from './gesundheit.ts';
import { schreibstatus } from './persist.ts';

const PUBLIC_DIR = resolve(import.meta.dirname, '..', 'public');

/** Abstand des SSE-Pulses; der Browser gilt nach dem Zweieinhalbfachen ohne Nachricht als getrennt. */
const SSE_PULS_MS = 10_000;

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

  // Wallbox / EV-Ladegerät (Tuya). Liest immer; stellt den Ladestrom, sobald die
  // Regelung aktiv ist (siehe Ladesteuerung). Ohne Zugangsdaten
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

/**
 * Die Aufteilung für genau diesen Messzyklus.
 *
 * Jeder Aufrufer — Bilanz, Ladeprotokoll, jeder offene Browser — bekommt für
 * denselben Messzeitpunkt dasselbe Ergebnis; siehe `Hausverbrauch.fuerZyklus`.
 * Eine nicht erreichbare Wallbox hat keine Leistung, auch wenn ihr letzter Wert
 * noch im Speicher steht.
 */
function hausUndAuto(state: EngineState): HausAnteil {
  const snapshot = state.resolution.snapshot;
  const charger = snapshot.evCharger;
  const autoW = charger === null || charger.state === 'offline' ? null : charger.chargePowerW;
  return hausTeiler.fuerZyklus(
    state.polledAt.getTime(),
    snapshot.houseConsumptionW.valueW,
    autoW,
  );
}

function hausOhneAutoMetrik(snapshot: EnergySnapshot, anteil: HausAnteil): unknown {
  const haus = snapshot.houseConsumptionW;
  return {
    valueW: anteil.hausOhneAuto.w,
    art: anteil.hausOhneAuto.art,
    autoAbgezogenW: anteil.auto.w,
    autoArt: anteil.auto.art,
    // Eine Schätzung trägt ihre Grundlage und ihr Ablaufdatum mit sich.
    schaetzung:
      anteil.schaetzung === null
        ? null
        : {
            grundlastW: anteil.schaetzung.grundlastW,
            grundlastAm: new Date(anteil.schaetzung.grundlastAmMs).toISOString(),
            gueltigBis: new Date(anteil.schaetzung.gueltigBisMs).toISOString(),
          },
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
/**
 * Die eine Ladeleistung, auf die sich alles stützt.
 *
 * Anzeige, Tagesbilanz und Ladeprotokoll müssen dieselbe Zahl benutzen. Taten
 * sie nicht: Die Anzeige nahm den am Hauszähler geprüften Anteil, Bilanz und
 * Protokoll den rohen Wert der Tuya-Cloud. Am 8.9. stand deshalb in der
 * Ansicht ein stehendes Auto, während das Protokoll weiter 2007 W integrierte.
 *
 * `null` heisst unbekannt — nicht null Watt.
 */
function geprueftAutoW(anteil: HausAnteil): number | null {
  // Bilanz und Protokoll zählen nur Gemessenes. Eine Schätzung aus der
  // Grundlast ist für die Anzeige gut, als Energiesumme wäre sie eine
  // Behauptung; sie wird deshalb zur ausgewiesenen Lücke.
  return anteil.auto.art === 'gemessen' ? anteil.auto.w : null;
}

function evAusZaehler(snapshot: EnergySnapshot, anteil: HausAnteil): Record<string, unknown> {
  const charger = snapshot.evCharger;
  if (charger === null) return {};
  const gemeldet = charger.chargePowerW;
  const auto = anteil.auto.w;
  const laedt = auto === null ? null : auto > 200;
  return {
    // `null` heisst unbekannt; die Anzeige macht daraus einen Strich.
    powerW: auto,
    leistungArt: anteil.auto.art,
    ...(gemeldet !== null && (auto === null || Math.abs(gemeldet - auto) > 200)
      ? { gemeldeteLeistungW: gemeldet }
      : {}),
    // "charging" wird zurückgenommen, wenn nachweislich nichts fliesst. Bei
    // unbekannter Leistung wird nichts behauptet — auch nicht das Gegenteil.
    ...(charger.state === 'charging' && laedt === false ? { state: 'connected' } : {}),
  };
}

function serializeState(
  state: EngineState,
  config: AppConfig,
  regelung: ReturnType<Ladesteuerung['kurz']> | null = null,
): unknown {
  const { snapshot, unavailable, disagreements, derivedConsumptionNegative } =
    state.resolution;

  const anteil = hausUndAuto(state);

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
    // Kalendertag und Zeitzone der ANLAGE. Ein Browser in einer anderen
    // Zeitzone soll "heute" nicht anders verstehen als die Tagesbilanz.
    anlage: {
      datum: localDate(state.polledAt),
      zeitzone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
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
    // Erwartet sind alle gelieferten, alle als fehlend gemeldeten und alle
    // angekündigten Speicher. Fehlt einer, gibt es keinen Gesamt-SOC und keine
    // Gesamtleistung — nur die Werte der erreichbaren, als Teilmenge benannt.
    storageAggregate: (() => {
      const fehlend = unavailable.filter((u) => u.startsWith('battery:')).length;
      const angekuendigt = announcedPlaceholders(
        config,
        snapshot.batteries.map((battery) => ({ source: battery.provenance.connectorId })),
      ).length;
      const gesamt = speicherGesamt(
        snapshot.batteries.map((b) => ({
          usableCapacityWh: b.usableCapacityWh,
          socPercent: b.socPercent,
          chargeW: b.chargeW,
          dischargeW: b.dischargeW,
          erreichbar: b.provenance.quality === 'live' || b.provenance.quality === 'stale',
        })),
        snapshot.batteries.length + fehlend + angekuendigt,
      );
      return {
        erwartet: gesamt.erwartet,
        verfuegbar: gesamt.verfuegbar,
        vollstaendig: gesamt.vollstaendig,
        kapazitaetBekanntWh: gesamt.kapazitaetBekanntWh,
        energieBekanntWh: gesamt.energieBekanntWh,
        socPercent: gesamt.socPercent,
        netPowerW: gesamt.nettoLeistungW,
      };
    })(),
    // Dieselbe Regel für PV: Die Summe ist nur bekannt, wenn alle
    // Wechselrichter liefern. Die Einzelwerte stehen trotzdem in `inverters`.
    solarVollstaendigkeit: (() => {
      const quellen = Array.isArray(config.sourceMapping.solarProductionW)
        ? config.sourceMapping.solarProductionW
        : [config.sourceMapping.solarProductionW];
      const liefernd = state.readings.filter(
        (r) => quellen.includes(r.connectorId)
          && r.solarProductionW !== null
          && r.solarProductionW.valueW !== null,
      ).length;
      return { erwartet: quellen.length, verfuegbar: liefernd };
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
    // Unveränderte Geräterückmeldung zusätzlich zur geprüften Bilanzleistung.
    wallboxPowerW: charger.chargePowerW,
    measuredAt: charger.provenance.measuredAt.toISOString(),
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
  if (!candidate.startsWith(PUBLIC_DIR + sep) || !existsSync(candidate) || !(await stat(candidate)).isFile()) {
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
  /**
   * Meldet Änderungen der Regelung (Wahl, Pause, Befehlsstatus), damit sie
   * sofort ankommen und nicht erst mit der nächsten Messung. Es wird dabei der
   * letzte Messstand mitgeschickt — neu gemessen wird dadurch nichts.
   */
  aufRegelung: ((beobachter: () => void) => () => void) | null = null,
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

  const vomMessen = engine.subscribe(send);
  const vonRegelung = aufRegelung?.(() => {
    const zustand = engine.current();
    if (zustand !== null) send(zustand);
  }) ?? null;
  // Puls ohne Messwerte: Ein Messzyklus darf bis zur Quellenfrist dauern, und
  // eine stumme, aber offene Verbindung sähe für den Browser sonst genauso aus
  // wie eine hängende. Mit dem Puls kann er beides unterscheiden.
  const puls = setInterval(() => {
    if (response.writableEnded || response.destroyed) return;
    try {
      response.write(`event: puls\ndata: ${JSON.stringify({ jetzt: new Date().toISOString() })}\n\n`);
    } catch {
      unsubscribe?.();
    }
  }, SSE_PULS_MS);
  unsubscribe = () => {
    clearInterval(puls);
    vomMessen();
    vonRegelung?.();
  };
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

/** Was ein Serverstart braucht. Alles Übrige leitet er daraus ab. */
export interface Startoptionen {
  readonly config: AppConfig;
  /** Wohin Historie, Sitzungen und Ladeprotokoll geschrieben werden. */
  readonly datenverzeichnis: string;
  /**
   * Datenquellen und Wallbox von aussen — für den Fixture-Server mit
   * simulierten Geräten. Ohne Angabe werden sie aus der Konfiguration gebaut.
   */
  readonly quellen?: { connectors: ManagedConnector[]; wallbox: TuyaEvseConnector | null };
  /**
   * Wird vor jeder Anfrage gefragt; `true` heisst "bereits beantwortet". Nur
   * für Test- und Fixture-Betrieb (Verzögerungen, Fehlerantworten).
   */
  readonly vorbehandlung?: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) => Promise<boolean>;
}

export interface LaufenderServer {
  readonly server: ReturnType<typeof createServer>;
  /** Geordnet beenden: Messung anhalten, alles speichern, Verbindungen schliessen. */
  stoppe(): Promise<void>;
}

export async function starteServer(o: Startoptionen): Promise<LaufenderServer> {
  const { config, datenverzeichnis } = o;
  // Vor Messung, Persistenz und Ladebefehlen prüfen: Auth-Fehler dürfen keinen
  // teilweise laufenden, ungeschützten Server hinterlassen.
  const konten = Kontenspeicher.ladenFuerServer(config.kontenPfad, config.allowUnauthenticatedAccess, config.secretsPfad);
  const sitzungen = konten === null ? null : new Sitzungsspeicher(
    resolve(datenverzeichnis, 'sitzungen.json'), konten.sessionSecret,
    // Zweiter Ort für den Notfall-Marker: neben der Kontendatei, die ohnehin
    // beschreibbar sein muss — fällt das Datenverzeichnis aus, soll der Marker
    // trotzdem ankommen. (Unter Docker liegen beide im selben Volume.)
    resolve(config.kontenPfad, '..', 'sitzungen-gesperrt.flag'),
  );
  const { connectors, wallbox } = o.quellen ?? buildConnectors(config);

  if (connectors.length === 0) {
    throw new Error(
      'Keine Datenquelle aktiviert. Bitte in config.json mindestens eine Quelle auf "enabled": true setzen.',
    );
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
    dataDir: datenverzeichnis,
    pvSources,
    names,
    tariff: config.tariff,
  });
  // Ladeprotokoll: erkennt Sessions selbst und speichert sie dauerhaft.
  const evLog = new ChargeSessionLog(datenverzeichnis);

  // Ein Abonnement für beide, damit sie garantiert mit derselben geprüften
  // Ladeleistung rechnen — zwei getrennte Aufrufe hatten je ihre eigene.
  // Für den Healthcheck: Wann lief der letzte Messzyklus durch?
  const startMs = Date.now();
  let letzterZyklusMs: number | null = null;
  engine.subscribe(() => { letzterZyklusMs = Date.now(); });

  engine.subscribe((state) => {
    const anteil = hausUndAuto(state);
    const autoW = geprueftAutoW(anteil);
    accumulator.integrate(state, autoW);
    evLog.integrate(state, autoW);
  });

  // Überschussregelung. Stellt den Ladestrom so, dass das Auto nur Sonne und
  // freigegebene Speicherleistung nimmt. Im Modus "beobachten" (Vorgabe)
  // rechnet sie mit, sendet aber nichts.
  const ladesteuerung = new Ladesteuerung(
    engine,
    wallbox,
    config,
    datenverzeichnis,
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

  const sendJson = (response: ServerResponse, status: number, payload: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  };

  // Eine Bremse für alle Anmeldeversuche, absichtlich ausserhalb des Handlers:
  // Sie muss sich Fehlversuche über Anfragen hinweg merken.
  const throttle = new LoginThrottle();

  const server = createServer(mitHttpFehlergrenze(async (request, response, url) => {
    if (o.vorbehandlung && (await o.vorbehandlung(request, response, url))) return;

    // Healthcheck ohne Anmeldung, ohne private Daten; siehe gesundheit.ts.
    if (url.pathname === '/health' && request.method === 'GET') {
      const g = gesundheit({ startMs, letzterZyklusMs, jetztMs: Date.now(), speicher: schreibstatus() });
      response.writeHead(g.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(g.body));
      return;
    }
    if (!herkunftErlaubt(request)) {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Anfrage von fremder Herkunft abgelehnt.' }));
      return;
    }

    // Offener Betrieb ist nur nach ausdrücklicher Konfiguration möglich.
    let ich: Benutzer | null = null;
    let sitzungId: string | null = null;
    if (konten !== null && sitzungen !== null) {
      const schranke = authGate(request, response, url, {
        konten, sitzungen, throttle, vertrauteProxies: config.trustedProxies,
      });
      if (!schranke.weiter) return;
      ich = schranke.benutzer ?? null;
      sitzungId = schranke.sitzungId ?? null;

      if (ich !== null && adminRouten(request, response, url, ich, {
        konten, sitzungen, vertrauteProxies: config.trustedProxies,
      })) {
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

    // Rechte, serverseitig: Familienkonten dürfen Dashboard und Ladebedienung
    // nutzen; Tarife und Konten verwaltet ein Administrator. Im ausdrücklich
    // konfigurierten offenen Betrieb gibt es keine Konten und damit keine
    // Unterscheidung.
    const darfVerwalten = konten === null ? true : ich?.rolle === 'admin';

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
        (b) => ladesteuerung.abonniere(b),
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

    // Lade-Schreibanfragen: streng geprüft (400 ohne Zustandsänderung) und erst
    // nach dauerhaftem Speichern bestätigt (sonst 500, Zustand unverändert).
    // Die Antwort ist der neue WUNSCH samt Befehlsstatus — ob Strom fliesst,
    // meldet erst die nächste Messung.
    const ladeAnfrage = async (
      pruefe: (roh: unknown) => { ok: true; wert: unknown } | { ok: false; fehler: string },
      ausfuehren: (wert: never) => unknown,
    ): Promise<void> => {
      let roh: unknown;
      try {
        roh = JSON.parse(await readBody(request, 1_000));
      } catch {
        sendJson(response, 400, { error: 'Ungültige Anfrage.' });
        return;
      }
      const geprueft = pruefe(roh);
      if (!geprueft.ok) {
        sendJson(response, 400, { error: geprueft.fehler });
        return;
      }
      try {
        const extra = ausfuehren(geprueft.wert as never);
        sendJson(response, 200, extra ?? ladesteuerung.kurz());
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : 'Einstellung konnte nicht übernommen werden.',
        });
      }
    };

    if (url.pathname === '/api/ev/stopp' && request.method === 'POST') {
      await ladeAnfrage(pruefeStoppAnfrage, (w: { an: boolean }) => {
        ladesteuerung.setzeGestoppt(w.an);
      });
      return;
    }

    if (url.pathname === '/api/ev/betriebsart' && request.method === 'POST') {
      await ladeAnfrage(pruefeBetriebsartAnfrage, (w: { art: 'intelligent' | 'manuell'; ampere?: number }) => {
        ladesteuerung.setzeBetriebsart(w.art, w.ampere);
      });
      return;
    }

    // Alte Schnittstelle für zwischengespeicherte Oberflächen: "Volladung" ist
    // Handbetrieb auf dem Höchstwert.
    if (url.pathname === '/api/ev/volladung' && request.method === 'POST') {
      await ladeAnfrage(pruefeStoppAnfrage, (w: { an: boolean }) => {
        ladesteuerung.setzeVolladung(w.an);
        return { volladung: w.an };
      });
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
        sendJson(response, 200, {
          ...accumulator.tarife.aktuell(),
          verlauf: accumulator.tarife.verlauf(),
          darfAendern: darfVerwalten,
        });
        return;
      }
      if (request.method === 'PUT') {
        // Tarife gelten serverweit und verändern Kostenrechnungen — das ist
        // Verwaltung, nicht Bedienung. Die Prüfung steht hier und nicht nur in
        // der Oberfläche, weil ein versteckter Knopf keine Berechtigung ist.
        if (!darfVerwalten) {
          sendJson(response, 403, { error: 'Tarife darf nur ein Administrator ändern.' });
          return;
        }
        let roh: unknown;
        try {
          roh = JSON.parse(await readBody(request));
        } catch {
          sendJson(response, 400, { error: 'Ungültige Anfrage' });
          return;
        }
        try {
          accumulator.tarife.setze(roh);
          // GET und PUT haben denselben Vertrag: aktuell gültiger Tarif,
          // nicht ein eventuell erst für nächsten Monat geplanter Eintrag.
          sendJson(response, 200, { ...accumulator.tarife.aktuell(), verlauf: accumulator.tarife.verlauf(), darfAendern: true });
        } catch (error) {
          if (error instanceof TypeError) {
            sendJson(response, 400, { error: error.message });
          } else {
            // Nicht dauerhaft gespeichert — also auch nicht übernommen.
            sendJson(response, 500, { error: 'Tarif konnte nicht gespeichert werden. Bisheriger Tarif gilt weiter.' });
          }
        }
        return;
      }
      response.writeHead(405, { allow: 'GET, PUT' });
      response.end();
      return;
    }

    await serveStatic(url.pathname, response);
  }));

  let stopping: Promise<void> | null = null;
  /**
   * Geordnet beenden.
   *
   * Erst die Messung anhalten, dann alles speichern, dann die Verbindungen
   * schliessen. Ein offener Ereignisstrom wird aktiv beendet — server.close()
   * allein wartete sonst beliebig lange auf ihn.
   */
  const stoppe = (): Promise<void> => {
    stopping ??= new Promise<void>((fertig) => {
      engine.stop();
      ladesteuerung.stop();
      accumulator.persist();
      evLog.persist();
      sitzungen?.persist();
      server.close(() => fertig());
      server.closeAllConnections();
    });
    return stopping;
  };

  await new Promise<void>((bereit, fehler) => {
    server.once('error', fehler);
    server.listen(config.port, config.host, () => {
      server.off('error', fehler);
      bereit();
    });
  });
  meldeStart(config, connectors, konten);
  // Ein belegter Port darf weder Messung noch Laderegelung im Hintergrund
  // zurücklassen. Erst nach erfolgreichem Listen starten.
  engine.start();
  ladesteuerung.start();
  return { server, stoppe };
}

function meldeStart(
  config: AppConfig,
  connectors: readonly ManagedConnector[],
  konten: Kontenspeicher | null,
): void {
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
    console.log('  ACHTUNG: Anmeldung ist per allowUnauthenticatedAccess abgeschaltet -');
    console.log('           die App ist für jeden erreichbar, der die Adresse kennt.');
  }
  console.log('');
  console.log('  Beenden: Strg+C (speichert vorher alles).');
  console.log('');
}

async function main(): Promise<void> {
  const laufend = await starteServer({
    config: loadConfig(),
    datenverzeichnis: resolve(process.cwd(), 'data'),
  });
  const beenden = (): void => {
    // Letzte Stufe, nur für diesen Prozess: Hängt das geordnete Beenden länger
    // als zehn Sekunden, wird hart beendet.
    setTimeout(() => process.exit(1), 10_000).unref();
    void laufend.stoppe().then(() => process.exit(0));
  };
  process.on('SIGINT', beenden);
  process.on('SIGTERM', beenden);
}

// Nur als Programm starten, nicht beim Import (Fixture-Server, Tests).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Serverstart fehlgeschlagen');
    process.exitCode = 1;
  });
}
