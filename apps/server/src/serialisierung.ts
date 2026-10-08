/**
 * Zustand der Anlage für die Oberfläche — aus Engine-Zustand und Regelung.
 *
 * Eine Instanz je Server: Die Haus/Auto-Aufteilung hält Zustand über
 * Messzyklen hinweg (Grundlast, Schätzung) und darf nicht zwischen zwei
 * Servern im selben Prozess (Fixture, Tests) geteilt werden.
 */

import {
  checkEnergyBalance,
  formatAgeDe,
  speicherGesamt,
  ladeleistungAusStromW,
  ladestromAusLeistungA,
  laedtGerade,
  type Ladeanschluss,
  type EnergySnapshot,
} from '@energy/core';

import { ladeanschlussAus, quellenNamen, type AppConfig } from './config.ts';
import type { EngineState } from './engine.ts';
import { Hausverbrauch, type HausAnteil } from './hausverbrauch.ts';
import { localDate } from './history.ts';
import type { Steuerkurz } from './ladesteuerung.ts';

export class Serialisierer {
  /** Aufteilung des Zählerwerts in Haus und Auto; hält Zustand über Zyklen. */
  private readonly hausTeiler = new Hausverbrauch();
  private readonly namen: Readonly<Record<string, string>>;

  constructor(private readonly config: AppConfig) {
    this.namen = quellenNamen(config);
  }

  /** Die Aufteilung für genau diesen Messzyklus — für alle Aufrufer dieselbe. */
  hausUndAuto(state: EngineState): HausAnteil {
    const snapshot = state.resolution.snapshot;
    const charger = snapshot.evCharger;
    const autoW = charger === null || charger.state === 'offline' ? null : charger.chargePowerW;
    return this.hausTeiler.fuerZyklus(
      state.polledAt.getTime(),
      snapshot.houseConsumptionW.valueW,
      autoW,
    );
  }

  /**
   * Die eine Ladeleistung, auf die sich alles stützt. Bilanz und Protokoll
   * zählen nur Gemessenes; eine Schätzung aus der Grundlast ist für die Anzeige
   * gut, als Energiesumme wäre sie eine Behauptung. `null` = unbekannt.
   */
  static geprueftAutoW(anteil: HausAnteil): number | null {
    return anteil.auto.art === 'gemessen' ? anteil.auto.w : null;
  }

  zustand(state: EngineState, regelung: Steuerkurz | null = null): unknown {
    const { snapshot, unavailable, disagreements, derivedConsumptionNegative } = state.resolution;
    const config = this.config;
    const anteil = this.hausUndAuto(state);

    const metric = (value: (typeof snapshot)['solarProductionW']) => ({
      valueW: value.valueW,
      source: value.provenance.connectorId,
      quality: value.provenance.quality,
      ageMs: Number.isFinite(value.provenance.ageMs) ? value.provenance.ageMs : null,
      ageLabel: Number.isFinite(value.provenance.ageMs)
        ? formatAgeDe(value.provenance.ageMs)
        : 'keine Daten',
    });

    const platzhalter = announcedPlaceholders(
      config,
      snapshot.batteries.map((battery) => ({ source: battery.provenance.connectorId })),
    );
    const pvQuellen = Array.isArray(config.sourceMapping.solarProductionW)
      ? config.sourceMapping.solarProductionW
      : [config.sourceMapping.solarProductionW];

    return {
      polledAt: state.polledAt.toISOString(),
      // Kalendertag und Zeitzone der ANLAGE.
      anlage: {
        datum: localDate(state.polledAt),
        zeitzone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      pollDurationMs: state.pollDurationMs,
      solar: metric(snapshot.solarProductionW),
      house: metric(snapshot.houseConsumptionW),
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
        ...platzhalter,
      ],
      storageAggregate: (() => {
        const fehlend = unavailable.filter((u) => u.startsWith('battery:')).length;
        const gesamt = speicherGesamt(
          snapshot.batteries.map((b) => ({
            usableCapacityWh: b.usableCapacityWh,
            socPercent: b.socPercent,
            chargeW: b.chargeW,
            dischargeW: b.dischargeW,
            erreichbar: b.provenance.quality === 'live' || b.provenance.quality === 'stale',
          })),
          snapshot.batteries.length + fehlend + platzhalter.length,
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
      solarVollstaendigkeit: {
        erwartet: pvQuellen.length,
        verfuegbar: state.readings.filter(
          (r) => pvQuellen.includes(r.connectorId)
            && r.solarProductionW !== null
            && r.solarProductionW.valueW !== null,
        ).length,
      },
      inverters: state.readings
        .filter((reading) => pvQuellen.includes(reading.connectorId))
        .map((reading) => ({
          id: reading.connectorId,
          name: this.namen[reading.connectorId] ?? reading.connectorId,
          powerW: reading.solarProductionW?.valueW ?? null,
          quality: reading.solarProductionW?.provenance.quality ?? 'unknown',
          ageLabel: reading.solarProductionW
            ? formatAgeDe(reading.solarProductionW.provenance.ageMs)
            : 'keine Daten',
        })),
      zaehler: zaehlerstaende(snapshot),
      ev: {
        ...(serializeEv(snapshot.evCharger, ladeanschlussAus(config)) as object),
        ...evAusZaehler(snapshot, anteil),
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
        // Platzhalter nur, solange keine Wallbox angebunden ist.
        ...(state.readings.some((r) => r.evCharger !== undefined)
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
}

/** Aktuelle Zählerstände der Geräte, für die Detailansicht. */
function zaehlerstaende(snapshot: EnergySnapshot): unknown {
  const z = snapshot.counters;
  if (z === undefined) return null;
  const wert = (m: { valueWh: number | null } | null): number | null => m?.valueWh ?? null;
  return {
    pvWh: wert(z.solarWh),
    pvJeWechselrichterWh: z.solarByConnectorWh,
    netzbezugWh: wert(z.gridImportWh),
    netzeinspeisungWh: wert(z.gridExportWh),
    autoWh: snapshot.evCharger?.totalEnergyWh ?? null,
  };
}

function announcedPlaceholders(
  config: AppConfig,
  present: readonly { readonly source: string }[],
): unknown[] {
  return config.announcedBatteries
    .filter((announced) => !present.some((battery) => battery.source === announced.expectedSource))
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

function hausOhneAutoMetrik(snapshot: EnergySnapshot, anteil: HausAnteil): unknown {
  const haus = snapshot.houseConsumptionW;
  return {
    valueW: anteil.hausOhneAuto.w,
    art: anteil.hausOhneAuto.art,
    autoAbgezogenW: anteil.auto.w,
    autoArt: anteil.auto.art,
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
 * Die Wallbox meldet `power_total` über die Cloud, und dieser Wert friert ein
 * (gemessen am 8.9.: Hauptschalter aus, Hauszähler 1203 W, Wallbox meldete
 * weiter 2007 W und "lädt"). Der Hauszähler misst alle zwei Sekunden. Was das
 * Auto zieht, ist deshalb der Anteil, den die Aufteilung ihm zurechnet — und
 * "lädt" heisst, dass dieser Anteil über der EINEN Schwelle `LADEN_AB_W` liegt.
 */
function evAusZaehler(snapshot: EnergySnapshot, anteil: HausAnteil): Record<string, unknown> {
  const charger = snapshot.evCharger;
  if (charger === null) return {};
  const gemeldet = charger.chargePowerW;
  const auto = anteil.auto.w;
  const laedt = laedtGerade(auto);
  return {
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

function serializeEv(charger: EnergySnapshot['evCharger'], anschluss: Ladeanschluss): unknown {
  if (charger === null) {
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
    wallboxPowerW: charger.chargePowerW,
    measuredAt: charger.provenance.measuredAt.toISOString(),
    spannungV: charger.spannungV,
    stromA: charger.stromA,
    phasen: charger.phasen,
    sessionEnergyWh: charger.sessionEnergyWh,
    totalEnergyWh: charger.totalEnergyWh,
    maxCurrentA: charger.maxCurrentA,
    maxPowerW: ladeleistungAusStromW(charger.maxCurrentA, anschluss),
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
